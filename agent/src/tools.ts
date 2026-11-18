import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { defineExtension, defineTool, hook, section, ToolTask } from "@earendil-works/pi-durable";
import { arr, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { config } from "./config.ts";
import { Incidents, type IncidentStatus } from "./incidents.ts";

const text = (t: string) => [{ type: "text" as const, text: t }];

function run(cmd: string, args: string[], cwd: string, timeoutMs = 20_000): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		execFile(cmd, args, { cwd, timeout: timeoutMs }, (err, stdout, stderr) => {
			const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
			resolve({ code, out: `${stdout}${stderr}`.trim() });
		});
	});
}

const httpCheck = defineTool({
	name: "http_check",
	description:
		"Probe an HTTP endpoint (GET) and report status code, latency and the first 1 KB of the body. Use it to confirm an outage and to verify a fix.",
	parameters: obj({ url: str({ description: "Full URL, e.g. http://127.0.0.1:9001/health" }) }),
	replay: "safe",
	execute: async (args, api, context) => {
		const started = Date.now();
		try {
			const res = await fetch(args.url, { signal: AbortSignal.timeout(5_000) });
			const body = (await res.text()).slice(0, 1024);
			const ms = Date.now() - started;
			await api.details({ ok: res.ok, status: res.status, ms, url: args.url }, context);
			return { output: text(`HTTP ${res.status} in ${ms} ms\n${body}`) };
		} catch (e) {
			const ms = Date.now() - started;
			const reason = (e as Error).cause ? String((e as { cause: { code?: string } }).cause.code ?? (e as Error).cause) : (e as Error).message;
			return { output: text(`Request failed after ${ms} ms: ${reason}`), isError: true };
		}
	},
});

const service = defineTool({
	name: "service_control",
	description:
		"Manage the catalog-api process through its process manager script (./run.sh in the working directory). Actions: status, start, stop, restart.",
	parameters: obj({ action: oneOf(["status", "start", "stop", "restart"]) }),
	execute: async (args, api) => {
		const { code, out } = await run("bash", ["./run.sh", args.action], config.workdir);
		api.output(out + "\n");
		return { output: text(`$ ./run.sh ${args.action}  (exit ${code})\n${out}`), isError: code !== 0 && args.action !== "status" };
	},
});

const tailLogs = defineTool({
	name: "tail_logs",
	description: "Show the last lines of the catalog-api log (logs/app.log), optionally filtered by a substring.",
	parameters: obj({
		lines: opt(num({ description: "How many lines (default 40, max 400)" })),
		grep: opt(str({ description: "Only lines containing this text" })),
	}),
	replay: "safe",
	execute: async (args) => {
		const file = path.join(config.workdir, "logs/app.log");
		let content: string;
		try {
			content = await readFile(file, "utf8");
		} catch {
			return { output: text(`No log file at ${file}`), isError: true };
		}
		let lines = content.trimEnd().split("\n");
		if (args.grep) lines = lines.filter((l) => l.includes(args.grep!));
		const n = Math.min(Math.max(1, args.lines ?? 40), 400);
		return { output: text(lines.slice(-n).join("\n") || "(no matching lines)") };
	},
});

const updateIncident = defineTool({
	name: "update_incident",
	description:
		"Set the incident's status on the shared board: 'investigating' while diagnosing, 'mitigated' once impact is stopped but follow-up remains, 'escalated' when a human must act (give the reason).",
	parameters: obj({
		status: oneOf(["investigating", "mitigated", "escalated"]),
		note: str({ description: "One line shown to operators" }),
	}),
	execute: async (args, api, context) => {
		await api.commit(async (tx) => {
			const doc = await tx.doc(Incidents);
			const incident = doc.items.find((i) => i.conversationId === api.conversationId);
			if (incident === undefined) return;
			incident.status = args.status as IncidentStatus;
			if (args.status === "escalated") incident.escalation = args.note;
			incident.updatedAt = Date.now();
		}, context);
		return { output: text(`Incident status set to ${args.status}: ${args.note}`) };
	},
});

const resolveIncident = defineTool({
	name: "resolve_incident",
	description:
		"Close the incident once the service is verified healthy. Records a short summary, the root cause, and the actions you took. Only call after a successful verification check.",
	parameters: obj({
		summary: str(),
		root_cause: str(),
		actions: arr(str(), { description: "Each concrete action taken, in order" }),
	}),
	execute: async (args, api, context) => {
		const resolution = { summary: args.summary, rootCause: args.root_cause, actions: args.actions, at: Date.now() };
		await api.commit(async (tx) => {
			const doc = await tx.doc(Incidents);
			const incident = doc.items.find((i) => i.conversationId === api.conversationId);
			if (incident === undefined) return;
			incident.status = "resolved";
			incident.resolution = resolution;
			incident.updatedAt = Date.now();
		}, context);
		await api.details(resolution, context);
		return { output: text("Incident resolved and recorded.") };
	},
});

/** Commands the agent may never run, whatever it or an operator says. */
const DENY: [RegExp, string][] = [
	[/\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME|\*)(\s|$)/i, "recursive delete of a root, home or wildcard path"],
	[/\b(mkfs|fdisk|parted|dd\s+if=)/i, "disk-level operation"],
	[/\b(shutdown|reboot|poweroff|halt|init\s+0)\b/i, "host power operation"],
	[/:\(\)\s*\{\s*:\|:&\s*\};:/, "fork bomb"],
	[/\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/i, "piping a download into a shell"],
	[/\bchmod\s+-R\s+777\s+\//i, "recursive permission change on /"],
	[/\b(iptables|ufw)\b.*\b(-F|flush|disable)\b/i, "firewall flush"],
];

const Guardrails = defineExtension({
	name: "sre-guardrails",
	hooks: [
		hook(ToolTask, {
			beforeTool: (call) => {
				const args = (call.arguments ?? {}) as Record<string, unknown>;
				if (call.name === "bash" && typeof args.command === "string") {
					for (const [re, why] of DENY) if (re.test(args.command)) return { block: `Blocked by SRE guardrails: ${why}. Choose a narrower, reversible action.` };
				}
				if ((call.name === "write" || call.name === "edit") && typeof args.path === "string") {
					const target = path.resolve(config.workdir, args.path);
					if (!target.startsWith(config.workdir + path.sep))
						return { block: `Blocked by SRE guardrails: file changes are limited to ${config.workdir}.` };
				}
				return undefined;
			},
		}),
	],
});

const PROMPT = `You are Sentinel, an always-on Site Reliability agent. Alerts arrive automatically from monitoring and webhooks; each incident has its own transcript that several human operators watch live.

## Environment
- Host: a single Linux server. Your working directory is ${config.workdir}.
- Service under your care: **catalog-api** (Python, app.py), port from config.env, health at http://127.0.0.1:9001/health.
- Process manager: ./run.sh start|stop|restart|status (logs append to logs/app.log). Config: config.env. Data: data/catalog.json (a known-good backup is data/catalog.json.bak).

## How to work an incident
1. Confirm impact first (http_check, service_control status). Call update_incident(status="investigating") early.
2. Gather evidence: tail_logs, read the relevant script/config/data files. State a hypothesis before you change anything.
3. Apply the smallest reversible fix (edit a typo, restore a value, restore from backup, restart). Never delete data. Prefer edit over write.
4. Verify with http_check. If healthy, call resolve_incident with summary, root cause and actions. If you cannot fix it safely, call update_incident(status="escalated") with the reason and stop.
5. Finish with a short report for humans: Impact, Root cause, Fix, Follow-ups.

## Operators
Messages from humans arrive as "[operator <name>] ...". They may steer you mid-run; their instructions override your plan unless unsafe. Acknowledge them by name in your next message.
Keep narration short: one or two sentences before each tool round explaining what you are checking and why.`;

export const SreTools = defineExtension({
	name: "sre",
	tools: [httpCheck, service, tailLogs, updateIncident, resolveIncident],
	sections: [section("sre", () => PROMPT, { tag: false })],
});

export { Guardrails };
