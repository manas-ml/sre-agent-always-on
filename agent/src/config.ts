import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "../..");

const env = process.env;

export const config = {
	port: Number(env.PORT ?? 8000),
	host: env.HOST ?? "0.0.0.0",
	/** Where the durable session (SQLite) lives. */
	dataDir: path.resolve(env.SRE_DATA_DIR ?? path.join(ROOT, ".data")),
	/** The directory the agent's tools operate in: the sample app by default. */
	workdir: path.resolve(env.SRE_WORKDIR ?? path.join(ROOT, "sample-app")),
	/** Health endpoint the always-on monitor polls. Empty disables the monitor. */
	healthUrl: env.SRE_HEALTH_URL ?? "http://127.0.0.1:9001/health",
	monitorIntervalMs: Number(env.SRE_MONITOR_INTERVAL_MS ?? 10_000),
	/** Consecutive failed probes before the monitor raises an alert. */
	monitorThreshold: Number(env.SRE_MONITOR_THRESHOLD ?? 2),
	monitorEnabled: (env.SRE_MONITOR ?? "1") !== "0",
	/** Shared secret for the UI, websocket and alert webhook. Empty: open (local dev only). */
	accessToken: env.SRE_ACCESS_TOKEN ?? "",
	/** "anthropic" when ANTHROPIC_API_KEY is set, otherwise the offline demo playbook. */
	provider: env.SRE_PROVIDER ?? (env.ANTHROPIC_API_KEY ? "anthropic" : "demo"),
	model: env.SRE_MODEL ?? "claude-sonnet-5-5",
	maxTurns: Number(env.SRE_MAX_TURNS ?? 40),
	/** Alerts for a service with an incident opened within this window join it instead of opening another. */
	correlationWindowMs: Number(env.SRE_CORRELATION_WINDOW_MS ?? 30 * 60_000),
};
