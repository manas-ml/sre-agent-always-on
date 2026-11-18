/**
 * Offline "demo brain": a deterministic SRE playbook exposed as a pi-ai model (via the faux provider).
 * It reads the real transcript (alerts, tool results, operator messages) and decides real tool calls,
 * so the whole durable pipeline, tools, guardrails and live UI work without an API key.
 * Set ANTHROPIC_API_KEY to use Claude instead.
 */
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxContentBlock } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ToolCallBlock = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

function textOf(m: Message): string {
	const c = (m as { content: unknown }).content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) return c.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: string }).text) : "")).join("");
	return "";
}

const isOperator = (m: Message) => m.role === "user" && textOf(m).startsWith("[operator ");
const operatorName = (m: Message) => /^\[operator ([^\]]+)\]/.exec(textOf(m))?.[1] ?? "operator";
const operatorText = (m: Message) => textOf(m).replace(/^\[operator [^\]]+\]\s*/, "");

export function createDemoBrain() {
	const faux = fauxProvider({
		provider: "demo",
		models: [{ id: "sentinel-playbook", name: "Sentinel playbook (offline demo)", contextWindow: 200_000, maxTokens: 8_000 }],
		tokensPerSecond: 90,
	});

	const step = async (context: { messages: Message[] }) => {
		faux.appendResponses([step]); // keep one response queued, forever
		await sleep(500 + Math.random() * 500);
		return decide(context.messages);
	};
	faux.setResponses([step]);
	return faux;
}

function decide(messages: Message[]) {
	// An episode starts at the user message that opened the current run: an alert, or an operator message sent
	// while the agent was idle. Operator messages sent mid-run are steers inside the episode.
	let start = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role !== "user") continue;
		const prev = messages.slice(0, i).findLast((m) => m.role === "assistant") as { stopReason?: string } | undefined;
		if (prev === undefined || prev.stopReason === "stop" || prev.stopReason === "aborted" || prev.stopReason === "error") {
			start = i;
			break;
		}
	}
	const lastAssistant = messages.findLastIndex((m) => m.role === "assistant");
	const freshOperators = messages.slice(lastAssistant + 1).filter(isOperator);
	const ack = freshOperators.length
		? freshOperators.map((m) => `Thanks @${operatorName(m)} — noted: “${operatorText(m).slice(0, 120)}”.`).join(" ") + " "
		: "";

	// An operator asked us to hold: escalate and stop touching the system.
	const hold = freshOperators.find((m) => /\b(hold|pause|stop|don'?t|do not|wait)\b/i.test(operatorText(m)));
	if (hold) {
		return say(`${ack}Pausing all remediation as requested and handing over to @${operatorName(hold)}.`, [
			call("update_incident", { status: "escalated", note: `Paused by ${operatorName(hold)}: ${operatorText(hold).slice(0, 100)}` }),
		]);
	}

	const episode = messages.slice(start + 1);
	const operatorEpisode = start >= 0 && isOperator(messages[start]);
	if (start === -1) return chat(messages, freshOperators, ack);

	const calls: ToolCallBlock[] = episode
		.filter((m) => m.role === "assistant")
		.flatMap((m) => (m as unknown as { content: ToolCallBlock[] }).content.filter((b) => b.type === "toolCall"));
	const results = episode.filter((m) => m.role === "toolResult") as (Message & { toolName: string })[];
	const called = (name: string) => calls.filter((c) => c.name === name);
	const resultOf = (name: string) => results.filter((r) => r.toolName === name).map(textOf);
	const last = (name: string) => resultOf(name).at(-1) ?? "";
	const alert = start >= 0 ? textOf(messages[start]) : "";

	if (called("resolve_incident").length || called("update_incident").some((c) => c.arguments.status === "escalated")) {
		return report(results, ack);
	}
	if (operatorEpisode && called("http_check").length === 0) {
		return say(`${ack}On it. Checking the current state of catalog-api first.`, [
			call("http_check", { url: "http://127.0.0.1:9001/health" }),
			call("service_control", { action: "status" }),
		]);
	}
	if (operatorEpisode && called("http_check").length === 1 && last("http_check").startsWith("HTTP 200") && called("tail_logs").length === 0) {
		return say(`${ack}catalog-api is **healthy** right now (${last("http_check").split("\n")[0]}); ${last("service_control").split("\n")[1] ?? ""}. Nothing to remediate — tell me if you want me to dig into something specific.`, [], "stop");
	}

	// 1. Confirm impact.
	if (called("http_check").length === 0) {
		const svc = /service:\s*([\w-]+)/i.exec(alert)?.[1] ?? "catalog-api";
		return say(`${ack}Alert received for **${svc}**. Confirming impact before touching anything: probing the health endpoint and the process state.`, [
			call("update_incident", { status: "investigating", note: "Confirming impact" }),
			call("http_check", { url: "http://127.0.0.1:9001/health" }),
			call("service_control", { action: "status" }),
		]);
	}

	// 2. Gather evidence.
	if (called("tail_logs").length === 0) {
		const healthy = last("http_check").startsWith("HTTP 200");
		if (healthy) {
			return say(`${ack}The health check is **passing** right now, so this may have self-recovered. Checking the logs for what happened before closing.`, [
				call("tail_logs", { lines: 30 }),
			]);
		}
		const down = /Request failed|refused/i.test(last("http_check"));
		return say(
			`${ack}Impact confirmed: ${down ? "the service is **not accepting connections**" : "the service is up but **unhealthy**"} (${last("http_check").split("\n")[0]}). Pulling recent logs and the launch script/config to find out why.`,
			[call("tail_logs", { lines: 40 }), call("read", { path: "run.sh" }), call("read", { path: "config.env" })],
		);
	}

	const runSh = resultOf("read").find((t) => t.includes("PIDFILE")) ?? "";
	const configEnv = resultOf("read").find((t) => t.includes("APP_PORT")) ?? "";
	const fixed = results.some((r) => (r.toolName === "edit" || r.toolName === "bash") && !(r as { isError?: boolean }).isError);
	const restarted = called("service_control").some((c) => c.arguments.action === "restart");
	const verifies = called("http_check").length;

	// Self-recovered case: nothing to fix.
	if (resultOf("http_check")[0]?.startsWith("HTTP 200") && !fixed && !restarted) {
		return say(`${ack}Logs show no ongoing errors and the service is healthy. Closing as transient.`, [
			call("resolve_incident", {
				summary: "catalog-api was healthy on first check; alert treated as transient.",
				root_cause: "No active fault found; likely a brief blip between probes.",
				actions: ["Probed /health (200)", "Reviewed recent logs"],
			}),
		]);
	}

	// 3. Diagnose and apply the smallest fix.
	const firstProbe = resultOf("http_check")[0] ?? "";
	const failedFixes = results.filter((r) => (r.toolName === "edit" || r.toolName === "bash") && (r as { isError?: boolean }).isError).length;
	if (!fixed && !restarted && failedFixes > 0) {
		return say(`${ack}My fix did not apply cleanly, so I'm not going to retry blindly on a live system. Escalating with the evidence above.`, [
			call("update_incident", { status: "escalated", note: "Automated fix failed to apply; needs human review" }),
		]);
	}
	// Diagnose from the *current* files and the live probe; the log is append-only and holds old incidents too.
	if (!fixed && !restarted) {
		if (/pyhton3/.test(runSh)) {
			return say(
				`${ack}**Root cause found.** The log says \`nohup: failed to run command 'pyhton3'\` and run.sh launches \`pyhton3 app.py\` — a typo in the launch command. Fixing the script (one-word edit), then restarting.`,
				[call("edit", { path: "run.sh", edits: [{ oldText: "nohup pyhton3 app.py", newText: "nohup python3 app.py" }] })],
			);
		}
		const port = /^APP_PORT=(.*)$/m.exec(configEnv)?.[1]?.trim();
		if (port && !/^\d+$/.test(port)) {
			return say(
				`${ack}**Root cause found.** app.py crashes at boot with \`ValueError: invalid literal for int()\`: config.env has \`APP_PORT=${port}\` (letter O instead of zero). Restoring the documented port 9001.`,
				[call("edit", { path: "config.env", edits: [{ oldText: `APP_PORT=${port}`, newText: "APP_PORT=9001" }] })],
			);
		}
		if (/JSONDecodeError/.test(firstProbe)) {
			return say(
				`${ack}**Root cause found.** /health returns 503 with a \`JSONDecodeError\`: data/catalog.json is truncated. Keeping the broken file for forensics and restoring the known-good backup.`,
				[call("bash", { command: "cp data/catalog.json data/catalog.json.corrupt-$(date +%s) && cp data/catalog.json.bak data/catalog.json && python3 -m json.tool data/catalog.json >/dev/null && echo 'catalog restored and valid'" })],
			);
		}
		return say(`${ack}No configuration or script fault in the evidence; the process simply isn't running (likely killed). Restarting it.`, [
			call("service_control", { action: "restart" }),
		]);
	}
	if (!restarted) {
		return say(`${ack}Fix applied. Restarting catalog-api to pick it up.`, [call("service_control", { action: "restart" })]);
	}

	// 4. Verify.
	if (verifies < 2) {
		return say(`${ack}Restarted. Verifying from the outside.`, [call("http_check", { url: "http://127.0.0.1:9001/health" })]);
	}
	if (!last("http_check").startsWith("HTTP 200")) {
		return say(`${ack}Verification still fails (${last("http_check").split("\n")[0]}). I won't keep guessing on a live system — escalating to a human.`, [
			call("update_incident", { status: "escalated", note: "Fix did not restore health; needs human review" }),
		]);
	}

	// 5. Resolve.
	const edit = called("edit")[0];
	const what = edit
		? `Corrected ${String(edit.arguments.path)}`
		: called("bash").length
			? "Restored data/catalog.json from backup (corrupt copy kept)"
			: "Restarted the stopped process";
	const cause = edit?.arguments.path === "run.sh"
		? "Typo in run.sh launch command (`pyhton3`), so the process could not start."
		: edit?.arguments.path === "config.env"
			? "Invalid APP_PORT value in config.env (`90O1`) crashed app.py at boot."
			: called("bash").length
				? "data/catalog.json was truncated/corrupted, failing every health check."
				: "The catalog-api process had exited (killed); nothing restarted it.";
	return say(`${ack}Health is back to **200**. Recording the resolution.`, [
		call("resolve_incident", {
			summary: `catalog-api restored. ${what}, restarted, verified /health = 200.`,
			root_cause: cause,
			actions: [`Confirmed impact via /health and run.sh status`, `Read logs and config`, what, "Restarted service", "Verified /health returns 200"],
		}),
	]);
}

function chat(messages: Message[], fresh: Message[], ack: string) {
	const lastUser = [...messages].reverse().find((m) => m.role === "user");
	const asked = lastUser ? operatorText(lastUser) : "";
	const results = messages.slice(messages.findLastIndex((m) => m.role === "user") + 1).filter((m) => m.role === "toolResult");
	if (results.length === 0 && /status|health|check|up\?|down/i.test(asked)) {
		return say(`${ack}Checking current state.`, [call("http_check", { url: "http://127.0.0.1:9001/health" }), call("service_control", { action: "status" })]);
	}
	if (results.length) {
		return say(`Current state:\n\n${results.map((r) => "- " + textOf(r).split("\n")[0]).join("\n")}`, [], "stop");
	}
	return say(`${ack || "Acknowledged. "}I'm watching this incident. Ask me to check status, or give me an instruction and I'll act on it.`, [], "stop");
}

function report(results: Message[], ack: string) {
	const escalated = results.some((r) => /status set to escalated/.test(textOf(r)));
	if (escalated) {
		return say(`${ack}**Escalated.** I've stopped making changes. The transcript above has the evidence gathered so far; reply here to give me new instructions.`, [], "stop");
	}
	return say(
		`${ack}### Incident report\n**Impact:** catalog-api health checks failed until remediation.\n**Fix:** applied the minimal change shown above, restarted, verified \`/health\` → 200.\n**Follow-ups:** add a pre-deploy lint for run.sh/config.env and a supervisor (systemd) with auto-restart.`,
		[],
		"stop",
	);
}

let seq = 0;
function call(name: string, args: Record<string, unknown>) {
	return fauxToolCall(name, args as never, { id: `demo_${Date.now().toString(36)}_${seq++}` });
}

function say(text: string, calls: FauxContentBlock[], stop: "stop" | "toolUse" = calls.length ? "toolUse" : "stop") {
	return fauxAssistantMessage([fauxText(text), ...calls], { stopReason: stop });
}
