import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { configure, createRegistry, Harness, type Conversation, type ConversationId, type LiveState } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { config } from "./config.ts";
import { createDemoBrain } from "./demo-brain.ts";
import { Incidents, SEVERITIES, type Alert, type Incident, type Severity } from "./incidents.ts";
import { Guardrails, SreTools } from "./tools.ts";
import { toUiItem, toUiLive, type UiItem } from "./view.ts";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const cid = (n: number) => n as unknown as ConversationId;

export type IncidentFeed = {
	items: UiItem[];
	live: ReturnType<typeof toUiLive>;
	usage?: Json;
};

type Listener = (event: { type: "entries"; items: UiItem[] } | { type: "live"; live: IncidentFeed["live"]; usage?: Json }) => void;

/** One open watch per incident conversation, fanned out to every connected client. */
class IncidentWatch {
	items: UiItem[] = [];
	live: IncidentFeed["live"] = { running: false };
	usage: Json;
	listeners = new Set<Listener>();
	lastId = 0;
	liveKey = "";
	constructor(readonly conversation: Conversation) {}

	async start(onLive: () => void) {
		// Full history once, then every commit through the watch.
		let cursor: Json;
		do {
			const page = await this.conversation.entries({ order: "ascending" }, 500, cursor, ctx);
			for (const e of page.items) this.push(e);
			cursor = page.next;
		} while (cursor !== undefined);
		const watch = await this.conversation.watch(ctx, { min: 50, max: 200 });
		this.apply(watch.value, onLive);
		watch.start(async (call) => {
			if (call.kind === "value") this.apply(call.value, onLive);
		});
	}

	private push(entry: Json): UiItem | undefined {
		if (entry.id <= this.lastId) return undefined;
		this.lastId = entry.id;
		const item = toUiItem(entry);
		if (item) this.items.push(item);
		return item;
	}

	private apply(value: Json, onLive: () => void) {
		const fresh: UiItem[] = [];
		for (const e of value.entries) {
			const item = this.push(e);
			if (item) fresh.push(item);
		}
		if (fresh.length) for (const l of this.listeners) l({ type: "entries", items: fresh });
		const live = toUiLive(value.docs["pi.live"] as LiveState | undefined);
		const usage = value.docs["pi.usage"];
		const key = JSON.stringify(live) + JSON.stringify(usage ?? null);
		if (key !== this.liveKey) {
			const wasRunning = this.live.running;
			this.liveKey = key;
			this.live = live;
			this.usage = usage;
			for (const l of this.listeners) l({ type: "live", live, usage });
			if (wasRunning !== live.running) onLive();
		}
	}
}

export class SreRuntime {
	private watches = new Map<string, IncidentWatch>();
	private incidentListeners = new Set<(items: Incident[]) => void>();
	incidents: Incident[] = [];
	readonly modelLabel: string;

	private constructor(
		readonly harness: Harness,
		private readonly modelRef: { provider: string; modelId: string },
	) {
		this.modelLabel = modelRef.provider === "demo" ? "Offline playbook (demo)" : `${modelRef.provider}/${modelRef.modelId}`;
	}

	static async open(): Promise<SreRuntime> {
		mkdirSync(config.dataDir, { recursive: true });
		const models = createModels();
		let modelRef: { provider: string; modelId: string };
		if (config.provider === "anthropic") {
			models.setProvider(anthropicProvider());
			modelRef = { provider: "anthropic", modelId: config.model };
		} else {
			models.setProvider(createDemoBrain().provider);
			modelRef = { provider: "demo", modelId: "sentinel-playbook" };
		}

		const registry = createRegistry();
		registry.install(CodingTools);
		registry.install(SreTools);
		registry.install(Guardrails);

		const storage = await openNodeSqliteStorage(path.join(config.dataDir, "sentinel.sqlite"));
		const harness = await Harness.open(
			storage,
			{
				models,
				registry,
				identity: { attribution: { name: "sentinel-sre-agent", url: "https://github.com/manas-ml/sre-agent-always-on" } },
				env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? config.workdir }),
				settings: {
					retry: { maxRetries: 4 },
					afterFailedRun: "continue",
					progress: { partialIntervalMs: 80, outputIntervalMs: 80, persistWithinMs: 1_000 },
				},
				onReport: (r) => console.warn(`[pi-durable] ${r.kind}`, (r as Json).reason ?? "", (r as Json).error?.message ?? ""),
			},
			ctx,
		);
		const runtime = new SreRuntime(harness, modelRef);
		await harness.commit(async (tx) => void (await tx.doc(Incidents)), ctx); // make sure the registry exists
		const watch = (await harness.watchDoc(Incidents, ctx))!;
		runtime.setIncidents(watch.value.items as Incident[]);
		watch.start(async (call) => {
			if (call.kind === "value") runtime.setIncidents(call.value.items as Incident[]);
		});
		for (const incident of runtime.incidents) {
			const w = await runtime.ensureWatch(incident);
			if (w.live.running) {
				// Make the durability visible: this run was cut off by the last process and continues now.
				await w.conversation.submit(
					{ type: "write", entry: { kind: "sre.event", data: { level: "info", text: "Agent process restarted — resuming from the last durable checkpoint", at: Date.now() } } },
					ctx,
				);
			}
		}
		// Durable execution: continue any run the previous process left unfinished.
		harness.resume();
		return runtime;
	}

	private setIncidents(items: Incident[]) {
		this.incidents = structuredClone(items);
		this.emitIncidents();
	}

	private emitIncidents() {
		for (const l of this.incidentListeners) l(this.board());
	}

	/** Incidents with live agent state, newest first. */
	board() {
		return [...this.incidents]
			.sort((a, b) => b.openedAt - a.openedAt)
			.map((i) => ({ ...i, agentRunning: this.watches.get(i.id)?.live.running ?? false }));
	}

	onIncidents(listener: (items: Incident[]) => void) {
		this.incidentListeners.add(listener);
		return () => this.incidentListeners.delete(listener);
	}

	private async ensureWatch(incident: Incident): Promise<IncidentWatch> {
		let w = this.watches.get(incident.id);
		if (w) return w;
		const conversation = (await this.harness.conversation(cid(incident.conversationId), ctx))!;
		w = new IncidentWatch(conversation);
		this.watches.set(incident.id, w);
		await w.start(() => this.emitIncidents());
		return w;
	}

	async subscribe(incidentId: string, listener: Listener): Promise<{ feed: IncidentFeed; unsubscribe: () => void } | undefined> {
		const incident = this.incidents.find((i) => i.id === incidentId);
		if (!incident) return undefined;
		const w = await this.ensureWatch(incident);
		w.listeners.add(listener);
		return { feed: { items: w.items, live: w.live, usage: w.usage }, unsubscribe: () => w.listeners.delete(listener) };
	}

	/** Accepts our own alert shape or an Alertmanager webhook; returns one result per alert. */
	async ingest(payload: Json, source = "webhook") {
		const raw: Json[] = Array.isArray(payload?.alerts) ? payload.alerts : [payload];
		const out = [];
		for (const a of raw) out.push(await this.raiseAlert(normalizeAlert(a, source)));
		return out;
	}

	async raiseAlert(alert: Alert): Promise<{ incident: Incident; deduplicated: boolean }> {
		const fingerprint = alert.fingerprint ?? `${alert.service}:${alert.title}`.toLowerCase();
		// Same fingerprint, or the same service with a recent open incident: one agent per problem, not per alert.
		const active = this.incidents.filter((i) => i.status !== "resolved").sort((a, b) => b.openedAt - a.openedAt);
		const open =
			active.find((i) => i.fingerprint === fingerprint) ??
			active.find((i) => i.service === alert.service && Date.now() - i.openedAt < config.correlationWindowMs);
		const content = renderAlert(alert);
		if (open) {
			await this.harness.commit(async (tx) => {
				const doc = await tx.doc(Incidents);
				const i = doc.items.find((x) => x.id === open.id)!;
				i.alerts += 1;
				i.updatedAt = Date.now();
				if (SEVERITIES.indexOf(alert.severity) < SEVERITIES.indexOf(i.severity)) i.severity = alert.severity;
			}, ctx);
			const conversation = (await this.harness.conversation(cid(open.conversationId), ctx))!;
			await conversation.submit(
				{ type: "input", content: `${content}\n(Correlated into this open incident; it may share the same root cause.)`, requestId: `alert:${alert.id}`, whenBusy: "steer", entry: { kind: "sre.alert", data: { ...alert, refire: true } } },
				ctx,
			);
			return { incident: this.incidents.find((i) => i.id === open.id) ?? open, deduplicated: true };
		}

		const incident = await this.harness.commit(async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			await configure(tx, conversation.id, {
				model: this.modelRef,
				maxTurns: config.maxTurns,
				cwd: config.workdir,
				...(this.modelRef.provider === "demo" ? {} : { thinkingLevel: "medium" as const }),
			});
			const doc = await tx.doc(Incidents);
			const number = doc.next++;
			const now = Date.now();
			const created: Incident = {
				id: `INC-${String(number).padStart(4, "0")}`,
				number,
				conversationId: conversation.id as number,
				title: alert.title,
				service: alert.service,
				severity: alert.severity,
				status: "open",
				fingerprint,
				openedAt: now,
				updatedAt: now,
				alerts: 1,
				participants: [],
			};
			doc.items.push(created);
			return created;
		}, ctx);
		this.setIncidentsFromLocal(incident);
		await this.ensureWatch(incident);
		const conversation = (await this.harness.conversation(cid(incident.conversationId), ctx))!;
		await conversation.submit({ type: "input", content, requestId: `alert:${alert.id}`, entry: { kind: "sre.alert", data: alert } }, ctx);
		return { incident, deduplicated: false };
	}

	private setIncidentsFromLocal(incident: Incident) {
		if (!this.incidents.some((i) => i.id === incident.id)) this.incidents.push(incident);
	}

	private async conversationOf(incidentId: string) {
		const incident = this.incidents.find((i) => i.id === incidentId);
		if (!incident) throw new Error(`Unknown incident ${incidentId}`);
		return { incident, conversation: (await this.harness.conversation(cid(incident.conversationId), ctx))! };
	}

	private async addParticipant(incidentId: string, author: string) {
		await this.harness.commit(async (tx) => {
			const i = (await tx.doc(Incidents)).items.find((x) => x.id === incidentId);
			if (i && !i.participants.includes(author)) i.participants.push(author);
		}, ctx);
	}

	/**
	 * A human message. "steer" reaches the agent: it joins the running work after the current tool round,
	 * or starts a new run when the agent is idle. "note" is only recorded in the shared transcript.
	 */
	async operatorMessage(incidentId: string, author: string, text: string, mode: "steer" | "note") {
		const { conversation } = await this.conversationOf(incidentId);
		await this.addParticipant(incidentId, author);
		if (mode === "note") {
			await conversation.submit({ type: "write", entry: { kind: "sre.note", data: { author, text, at: Date.now() } } }, ctx);
			return;
		}
		await conversation.submit(
			{
				type: "input",
				content: `[operator ${author}] ${text}`,
				requestId: `op:${randomUUID()}`,
				whenBusy: "steer",
				entry: { kind: "sre.operator", data: { author, text, mode } },
			},
			ctx,
		);
	}

	async stop(incidentId: string, author: string) {
		const { conversation } = await this.conversationOf(incidentId);
		await conversation.abort(ctx);
		await conversation.submit({ type: "write", entry: { kind: "sre.event", data: { level: "warn", text: `${author} stopped the agent`, at: Date.now() } } }, ctx);
	}

	async setStatus(incidentId: string, author: string, status: "resolved" | "open") {
		const { conversation } = await this.conversationOf(incidentId);
		await this.harness.commit(async (tx) => {
			const i = (await tx.doc(Incidents)).items.find((x) => x.id === incidentId)!;
			i.status = status;
			i.updatedAt = Date.now();
			if (status === "resolved" && !i.resolution)
				i.resolution = { summary: `Manually resolved by ${author}.`, rootCause: "Recorded by operator.", actions: [], at: Date.now() };
			if (status === "open") delete i.resolution;
		}, ctx);
		await conversation.submit(
			{ type: "write", entry: { kind: "sre.event", data: { level: status === "resolved" ? "ok" : "info", text: `${author} ${status === "resolved" ? "resolved" : "reopened"} the incident`, at: Date.now() } } },
			ctx,
		);
	}

	async close() {
		await this.harness.close(ctx);
	}
}

function renderAlert(a: Alert) {
	return [
		`ALERT [${a.severity.toUpperCase()}] ${a.title}`,
		`service: ${a.service}`,
		`source: ${a.source}`,
		a.description ? `description: ${a.description}` : "",
		a.labels && Object.keys(a.labels).length ? `labels: ${JSON.stringify(a.labels)}` : "",
		`received: ${new Date(a.receivedAt).toISOString()}`,
		"",
		"Investigate, remediate if safe, verify, and resolve or escalate.",
	]
		.filter(Boolean)
		.join("\n");
}

function normalizeAlert(a: Json, source: string): Alert {
	const labels: Record<string, string> = { ...(a?.labels ?? {}) };
	const sev = String(a?.severity ?? labels.severity ?? "high").toLowerCase();
	return {
		id: String(a?.id ?? a?.fingerprint ?? randomUUID()) + (a?.id ? "" : ""),
		source: String(a?.source ?? (a?.labels ? "alertmanager" : source)),
		service: String(a?.service ?? labels.service ?? labels.job ?? "catalog-api"),
		severity: (SEVERITIES.includes(sev as Severity) ? sev : "high") as Severity,
		title: String(a?.title ?? a?.annotations?.summary ?? labels.alertname ?? "Unnamed alert").slice(0, 200),
		description: a?.description ?? a?.annotations?.description,
		fingerprint: a?.fingerprint ? String(a.fingerprint) : undefined,
		labels,
		receivedAt: Date.now(),
	};
}
