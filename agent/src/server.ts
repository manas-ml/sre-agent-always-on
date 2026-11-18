import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { config } from "./config.ts";
import { SreRuntime } from "./runtime.ts";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

const runtime = await SreRuntime.open();
console.log(`[sentinel] durable session at ${config.dataDir}; model ${runtime.modelLabel}; workdir ${config.workdir}`);

// ---------- auth ----------
function authorized(req: IncomingMessage, url: URL) {
	if (!config.accessToken) return true;
	const header = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? (req.headers["x-sre-token"] as string | undefined);
	return (header ?? url.searchParams.get("token")) === config.accessToken;
}

// ---------- health monitor (the "always-on" part) ----------
type Probe = { at: number; ok: boolean; ms: number; status: number | string };
const probes: Probe[] = [];
let consecutiveFailures = 0;

async function probe() {
	if (!config.healthUrl) return;
	const started = Date.now();
	let p: Probe;
	try {
		const res = await fetch(config.healthUrl, { signal: AbortSignal.timeout(4_000) });
		await res.arrayBuffer();
		p = { at: started, ok: res.ok, ms: Date.now() - started, status: res.status };
	} catch (e) {
		p = { at: started, ok: false, ms: Date.now() - started, status: String(((e as Error).cause as { code?: string })?.code ?? "ERR") };
	}
	probes.push(p);
	if (probes.length > 90) probes.shift();
	broadcast({ type: "health", probes, url: config.healthUrl, monitor: config.monitorEnabled });
	consecutiveFailures = p.ok ? 0 : consecutiveFailures + 1;
	if (config.monitorEnabled && consecutiveFailures === config.monitorThreshold) {
		const r = await runtime.raiseAlert({
			id: `monitor-${Date.now()}`,
			source: "sentinel-monitor",
			service: "catalog-api",
			severity: "critical",
			title: "catalog-api health check failing",
			description: `${config.monitorThreshold} consecutive failed probes of ${config.healthUrl}; last result: ${p.status} after ${p.ms} ms`,
			fingerprint: "monitor:catalog-api:health",
			labels: { probe: config.healthUrl },
			receivedAt: Date.now(),
		});
		console.log(`[monitor] raised ${r.incident.id}${r.deduplicated ? " (dedup)" : ""}`);
	}
}
setInterval(() => void probe().catch((e) => console.error("[monitor]", e)), config.monitorIntervalMs);
void probe();

// ---------- websocket fan-out ----------
type Client = { ws: WebSocket; name: string; color: string; incidentId?: string; unsubscribe?: () => void };
const clients = new Set<Client>();

function send(ws: WebSocket, msg: Json) {
	if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(msg: Json) {
	const data = JSON.stringify(msg);
	for (const c of clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
}
function presence() {
	broadcast({ type: "presence", users: [...clients].map((c) => ({ name: c.name, color: c.color, incidentId: c.incidentId })) });
}
runtime.onIncidents((items) => broadcast({ type: "incidents", items }));

const PALETTE = ["#f97316", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#14b8a6", "#eab308", "#ef4444"];
const colorFor = (name: string) => PALETTE[[...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
const cleanName = (n: unknown) => String(n ?? "").replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 24) || "anonymous";

async function handleWs(client: Client, msg: Json) {
	switch (msg.type) {
		case "hello":
			client.name = cleanName(msg.name);
			client.color = colorFor(client.name);
			presence();
			return;
		case "subscribe": {
			client.unsubscribe?.();
			client.incidentId = msg.incidentId;
			const sub = await runtime.subscribe(msg.incidentId, (event) => send(client.ws, { ...event, incidentId: msg.incidentId }));
			if (!sub) return send(client.ws, { type: "error", message: "Unknown incident" });
			client.unsubscribe = sub.unsubscribe;
			send(client.ws, { type: "snapshot", incidentId: msg.incidentId, ...sub.feed });
			presence();
			return;
		}
		case "message":
			if (typeof msg.text !== "string" || !msg.text.trim()) return;
			await runtime.operatorMessage(msg.incidentId, client.name, msg.text.trim().slice(0, 4000), msg.mode === "note" ? "note" : "steer");
			return;
		case "stop":
			return runtime.stop(msg.incidentId, client.name);
		case "status":
			return runtime.setStatus(msg.incidentId, client.name, msg.status === "open" ? "open" : "resolved");
		case "typing":
			for (const c of clients) if (c !== client && c.incidentId === msg.incidentId) send(c.ws, { type: "typing", name: client.name, color: client.color });
			return;
	}
}

// ---------- http ----------
async function body(req: IncomingMessage): Promise<Json> {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	const raw = Buffer.concat(chunks).toString("utf8");
	return raw ? JSON.parse(raw) : {};
}
function json(res: ServerResponse, code: number, value: Json) {
	res.writeHead(code, { "content-type": "application/json" });
	res.end(JSON.stringify(value));
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", "http://local");
	try {
		if (url.pathname === "/healthz") return json(res, 200, { ok: true });
		if (url.pathname.startsWith("/api/")) {
			if (!authorized(req, url)) return json(res, 401, { error: "unauthorized" });
			if (req.method === "GET" && url.pathname === "/api/state")
				return json(res, 200, { model: runtime.modelLabel, incidents: runtime.board(), probes, workdir: config.workdir, auth: !!config.accessToken });
			if (req.method === "POST" && url.pathname === "/api/alerts") {
				const results = await runtime.ingest(await body(req));
				return json(res, 202, { accepted: results.map((r) => ({ incident: r.incident.id, deduplicated: r.deduplicated })) });
			}
			const m = /^\/api\/incidents\/([\w-]+)\/(messages|stop|status)$/.exec(url.pathname);
			if (req.method === "POST" && m) {
				const b = await body(req);
				const author = cleanName(b.author ?? "api");
				if (m[2] === "messages") await runtime.operatorMessage(m[1], author, String(b.text), b.mode === "note" ? "note" : "steer");
				if (m[2] === "stop") await runtime.stop(m[1], author);
				if (m[2] === "status") await runtime.setStatus(m[1], author, b.status === "open" ? "open" : "resolved");
				return json(res, 200, { ok: true });
			}
			if (req.method === "POST" && url.pathname === "/api/demo/fault") {
				const scenario = String((await body(req)).scenario);
				if (!["script", "config", "data", "crash", "reset"].includes(scenario)) return json(res, 400, { error: "unknown scenario" });
				const out = await new Promise<string>((resolve) =>
					execFile("bash", ["./break.sh", scenario], { cwd: config.workdir, timeout: 15_000 }, (_e, so, se) => resolve(`${so}${se}`)),
				);
				setTimeout(() => void probe(), 300);
				return json(res, 200, { ok: true, output: out });
			}
			return json(res, 404, { error: "not found" });
		}
		const file = path.join(PUBLIC, url.pathname === "/" ? "index.html" : path.normalize(url.pathname));
		if (!file.startsWith(PUBLIC)) return json(res, 403, { error: "forbidden" });
		const data = await readFile(file).catch(() => undefined);
		if (!data) return json(res, 404, { error: "not found" });
		res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
		res.end(data);
	} catch (e) {
		console.error("[http]", e);
		json(res, 500, { error: (e as Error).message });
	}
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
	const url = new URL(req.url ?? "/", "http://local");
	if (url.pathname !== "/ws" || !authorized(req, url)) {
		socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
		return socket.destroy();
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		const client: Client = { ws, name: "anonymous", color: colorFor("anonymous") };
		clients.add(client);
		send(ws, { type: "hello", model: runtime.modelLabel, incidents: runtime.board(), probes, monitor: config.monitorEnabled, url: config.healthUrl });
		ws.on("message", (data) => {
			let msg: Json;
			try {
				msg = JSON.parse(String(data));
			} catch {
				return;
			}
			handleWs(client, msg).catch((e) => send(ws, { type: "error", message: (e as Error).message }));
		});
		ws.on("close", () => {
			client.unsubscribe?.();
			clients.delete(client);
			presence();
		});
	});
});

server.listen(config.port, config.host, () => console.log(`[sentinel] listening on http://${config.host}:${config.port}`));

let closing = false;
for (const sig of ["SIGINT", "SIGTERM"] as const)
	process.on(sig, async () => {
		if (closing) process.exit(1);
		closing = true;
		console.log(`[sentinel] ${sig}: closing durable session (pending work resumes on next start)`);
		server.close();
		await runtime.close().catch(() => {});
		process.exit(0);
	});
