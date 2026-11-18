// Sentinel web UI: live, shared view of the always-on SRE agent. No build step.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
	get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
	set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

const PALETTE = ["#f97316", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#14b8a6", "#eab308", "#ef4444"];
const colorFor = (name) => PALETTE[[...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
const AGENT_SVG = '<svg viewBox="0 0 32 32"><path d="M3 17h6l3-8 5 15 4-11 2 4h6"/></svg>';

const state = {
	name: store.get("sentinel.name") || "",
	token: store.get("sentinel.token") || "",
	ws: null,
	connected: false,
	model: "",
	incidents: [],
	selected: new URLSearchParams(location.hash.slice(1)).get("i") || null,
	filter: "active",
	query: "",
	feed: null, // { incidentId, items, live, usage }
	users: [],
	probes: [],
	healthUrl: "",
	mode: "steer",
	typing: new Map(),
	toggles: new Map(), // tool cards the user opened/closed by hand
	stick: true, // keep the transcript pinned to the bottom
};

// ---------------------------------------------------------------- utils
function ago(ts) {
	if (!ts) return "";
	const s = Math.max(0, (Date.now() - ts) / 1000);
	if (s < 45) return "just now";
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
}
function dur(ms) {
	if (ms == null) return "";
	if (ms < 1000) return `${Math.round(ms)} ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}
const clock = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
const avatar = (name, cls = "") => `<span class="avatar ${cls}" style="background:${colorFor(name)}" title="${esc(name)}">${esc(name.slice(0, 1))}</span>`;

function md(src) {
	// Small, safe markdown: code fences, inline code, bold, italics, headings, lists, links.
	const blocks = String(src ?? "").split(/```/);
	return blocks
		.map((chunk, i) => {
			if (i % 2) return `<pre><code>${esc(chunk.replace(/^\w*\n/, ""))}</code></pre>`;
			const inline = (t) =>
				esc(t)
					.replace(/`([^`]+)`/g, "<code>$1</code>")
					.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
					.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
					.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
			const out = [];
			let list = null;
			for (const line of chunk.split("\n")) {
				const li = /^\s*(?:[-*]|(\d+)\.)\s+(.*)$/.exec(line);
				if (li) {
					const tag = li[1] ? "ol" : "ul";
					if (list !== tag) { if (list) out.push(`</${list}>`); out.push(`<${tag}>`); list = tag; }
					out.push(`<li>${inline(li[2])}</li>`);
					continue;
				}
				if (list) { out.push(`</${list}>`); list = null; }
				const h = /^(#{1,4})\s+(.*)$/.exec(line);
				if (h) out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`);
				else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
			}
			if (list) out.push(`</${list}>`);
			return out.join("");
		})
		.join("");
}

function toast(text, kind = "") {
	const el = document.createElement("div");
	el.className = `toast ${kind}`;
	el.textContent = text;
	$("#toasts").append(el);
	setTimeout(() => el.remove(), 4200);
}

async function api(path, body) {
	const res = await fetch(path, {
		method: body ? "POST" : "GET",
		headers: { "content-type": "application/json", ...(state.token ? { authorization: `Bearer ${state.token}` } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	if (res.status === 401) { openModal(true); throw new Error("unauthorized"); }
	return res.json();
}

// ---------------------------------------------------------------- connection
function connect() {
	const proto = location.protocol === "https:" ? "wss" : "ws";
	const ws = new WebSocket(`${proto}://${location.host}/ws${state.token ? `?token=${encodeURIComponent(state.token)}` : ""}`);
	state.ws = ws;
	ws.onopen = () => {
		state.connected = true;
		send({ type: "hello", name: state.name });
		if (state.selected) send({ type: "subscribe", incidentId: state.selected });
		renderPill();
	};
	ws.onclose = (e) => {
		state.connected = false;
		renderPill();
		if (e.code === 1006 && !state.everConnected) checkAuth();
		setTimeout(connect, 1500);
	};
	ws.onmessage = (e) => onMessage(JSON.parse(e.data));
}
const send = (msg) => state.ws?.readyState === 1 && state.ws.send(JSON.stringify(msg));

async function checkAuth() {
	const res = await fetch("/api/state", { headers: state.token ? { authorization: `Bearer ${state.token}` } : {} }).catch(() => null);
	if (res?.status === 401) openModal(true);
}

function onMessage(m) {
	switch (m.type) {
		case "hello":
			state.everConnected = true;
			state.model = m.model;
			state.incidents = m.incidents;
			state.probes = m.probes;
			state.healthUrl = m.url;
			$("#modelChip").textContent = m.model;
			$("#emptyUrl").textContent = m.url || "catalog-api";
			if (!state.selected && m.incidents.length) {
				const firstActive = m.incidents.find((i) => i.status !== "resolved");
				if (firstActive) select(firstActive.id);
			}
			renderAll();
			break;
		case "incidents": {
			const before = new Set(state.incidents.map((i) => i.id));
			state.incidents = m.items;
			const fresh = m.items.filter((i) => !before.has(i.id));
			for (const i of fresh) {
				toast(`🚨 ${i.id} opened: ${i.title}`, "err");
				if (!state.selected || state.incidents.find((x) => x.id === state.selected)?.status === "resolved") select(i.id);
			}
			renderList();
			renderHeader();
			renderPill();
			renderRail();
			break;
		}
		case "snapshot":
			if (m.incidentId !== state.selected) return;
			state.feed = { incidentId: m.incidentId, items: m.items, live: m.live, usage: m.usage };
			renderTranscript(true);
			renderLive();
			renderHeader();
			renderRail();
			break;
		case "entries":
			if (!state.feed || m.incidentId !== state.feed.incidentId) return;
			state.feed.items.push(...m.items);
			renderTranscript(false);
			renderLive();
			break;
		case "live":
			if (!state.feed || m.incidentId !== state.feed.incidentId) return;
			state.feed.live = m.live;
			state.feed.usage = m.usage;
			renderLive();
			renderHeader();
			renderRail();
			break;
		case "presence":
			state.users = m.users;
			renderPresence();
			break;
		case "health":
			state.probes = m.probes;
			renderHealth();
			break;
		case "typing":
			state.typing.set(m.name, Date.now());
			renderTyping();
			setTimeout(renderTyping, 3200);
			break;
		case "error":
			toast(m.message, "err");
			break;
	}
}

// ---------------------------------------------------------------- selection
function select(id) {
	if (state.selected === id && state.feed?.incidentId === id) return;
	state.selected = id;
	state.feed = null;
	history.replaceState(null, "", id ? `#i=${id}` : "#");
	$("#transcript").innerHTML = "";
	$("#liveArea").innerHTML = "";
	send({ type: "subscribe", incidentId: id });
	$("#sidebar").classList.remove("open");
	renderAll();
}

// ---------------------------------------------------------------- rendering
function renderAll() {
	renderList();
	renderHeader();
	renderPill();
	renderHealth();
	renderPresence();
	renderRail();
	renderMe();
}

function renderMe() {
	$("#meAvatar").outerHTML = `<span class="avatar sm" id="meAvatar" style="background:${colorFor(state.name || "?")}">${esc((state.name || "?").slice(0, 1))}</span>`;
	$("#meName").textContent = state.name;
}

function renderPill() {
	const pill = $("#agentPill");
	const busy = state.incidents.filter((i) => i.agentRunning);
	const open = state.incidents.filter((i) => i.status !== "resolved");
	pill.className = "agent-pill " + (!state.connected ? "offline" : busy.length ? "busy" : "online");
	$("#agentPillText").textContent = !state.connected
		? "Reconnecting…"
		: busy.length
			? `Working on ${busy.map((i) => i.id).join(", ")}`
			: open.length
				? `On watch · ${open.length} open`
				: "On watch · all clear";
}

function renderHealth() {
	const probes = state.probes.slice(-90);
	const bars = (n) =>
		probes
			.slice(-n)
			.map((p) => `<i class="${p.ok ? "" : "bad"}" style="height:${p.ok ? Math.max(22, Math.min(70, 22 + p.ms * 2)) : 100}%" title="${clock(p.at)} · ${esc(p.status)} · ${p.ms} ms"></i>`)
			.join("");
	$("#spark").innerHTML = bars(24);
	$("#sparkBig").innerHTML = bars(90);
	const last = probes.at(-1);
	const v = $("#healthValue");
	v.textContent = last ? (last.ok ? `${last.ms} ms` : String(last.status)) : "—";
	v.className = "health-value " + (last ? (last.ok ? "ok" : "bad") : "");
	const up = probes.length ? Math.round((probes.filter((p) => p.ok).length / probes.length) * 1000) / 10 : null;
	$("#uptime").textContent = up == null ? "" : `${up}% up`;
	$("#lastProbe").textContent = last ? `${last.ok ? "healthy" : "failing"} · ${clock(last.at)}` : "";
}

function renderPresence() {
	const users = dedupeUsers(state.users);
	$("#viewers").innerHTML = users.slice(0, 5).map((u) => avatar(u.name, "sm")).join("") + (users.length > 5 ? `<span class="more">+${users.length - 5}</span>` : "");
	$("#people").innerHTML = users.length
		? users
				.map((u) => `<div class="person">${avatar(u.name, "sm")}<span>${esc(u.name)}${u.name === state.name ? ' <span class="muted">(you)</span>' : ""}</span><span class="where">${u.incidentId ? esc(u.incidentId) : "board"}</span><span class="live-dot"></span></div>`)
				.join("")
		: '<span class="muted">Nobody else here</span>';
}
function dedupeUsers(users) {
	const m = new Map();
	for (const u of users) if (!m.has(u.name) || u.incidentId === state.selected) m.set(u.name, u);
	return [...m.values()];
}

function renderList() {
	const q = state.query.toLowerCase();
	const items = state.incidents.filter((i) => {
		if (state.filter === "active" && i.status === "resolved") return false;
		if (state.filter === "resolved" && i.status !== "resolved") return false;
		return !q || `${i.id} ${i.title} ${i.service}`.toLowerCase().includes(q);
	});
	$("#countActive").textContent = state.incidents.filter((i) => i.status !== "resolved").length;
	$("#countResolved").textContent = state.incidents.filter((i) => i.status === "resolved").length;
	$("#incidentList").innerHTML = items.length
		? items
				.map(
					(i) => `
		<button class="inc-card sev-${i.severity} ${i.id === state.selected ? "selected" : ""}" data-id="${esc(i.id)}">
			<div class="row1"><span class="id">${esc(i.id)}</span><span>·</span><span>${esc(i.service)}</span><span class="time">${ago(i.openedAt)}</span></div>
			<div class="title">${esc(i.title)}</div>
			<div class="row3">
				<span class="status-badge st-${i.status}">${esc(i.status)}</span>
				${i.agentRunning ? '<span class="working"><span class="dots"><i></i><i></i><i></i></span>agent working</span>' : ""}
				${i.alerts > 1 ? `<span class="count" title="alerts received">×${i.alerts}</span>` : ""}
			</div>
		</button>`,
				)
				.join("")
		: `<div class="list-empty">${state.filter === "active" ? "No active incidents.<br/>Sentinel is watching." : "Nothing here yet."}</div>`;
}

function currentIncident() {
	return state.incidents.find((i) => i.id === state.selected);
}

function renderHeader() {
	const inc = currentIncident();
	$("#emptyState").hidden = !!inc;
	$("#incidentView").hidden = !inc;
	if (!inc) return;
	$("#incSev").className = `sev-badge sev-${inc.severity}`;
	$("#incSev").textContent = inc.severity;
	$("#incId").textContent = inc.id;
	$("#incTitle").textContent = inc.title;
	$("#incStatus").className = `status-badge st-${inc.status}`;
	$("#incStatus").textContent = inc.status;
	const end = inc.status === "resolved" ? inc.resolution?.at ?? inc.updatedAt : Date.now();
	$("#incMeta").textContent = `${inc.service} · opened ${clock(inc.openedAt)} · ${inc.status === "resolved" ? "resolved in" : "open for"} ${dur(end - inc.openedAt)}`;
	const live = state.feed?.live;
	$("#stopBtn").hidden = !live?.running;
	const rb = $("#resolveBtn");
	rb.innerHTML = inc.status === "resolved" ? '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>Reopen' : '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>Resolve';

	const strip = $("#runStrip");
	if (live?.running) {
		const g = live.generation;
		const runningTool = live.tools?.find((t) => t.status === "running");
		const what = g?.retry
			? `Model retry scheduled (${esc(g.retry.error).slice(0, 80)})`
			: runningTool
				? `Running <b>${esc(runningTool.name)}</b>`
				: g
					? g.text ? "Writing…" : "Thinking…"
					: live.afterRun ? "Wrapping up…" : "Working…";
		strip.innerHTML = `<span class="spinner"></span><span>${what}</span><span class="muted">· turn ${live.turns + 1}</span><div class="bar active"></div>`;
	} else if (live?.runFailure && live.runFailure.reason !== "aborted") {
		strip.innerHTML = `<span class="err-text">●</span><span>Last run ended: <b>${esc(live.runFailure.reason.replace(/_/g, " "))}</b> ${esc(live.runFailure.detail ?? "").slice(0, 120)}</span><div class="bar"></div>`;
	} else {
		strip.innerHTML = `<span class="${inc.status === "resolved" ? "ok-text" : "muted"}">●</span><span>${inc.status === "resolved" ? "Resolved — agent idle" : "Agent idle — send a message to steer it"}</span><div class="bar"></div>`;
	}
	renderHint();
}

function renderHint() {
	const live = state.feed?.live;
	const hint = $("#hint");
	if (state.mode === "note") hint.innerHTML = "Visible to everyone in this room; the agent won't act on it.";
	else if (live?.running) hint.innerHTML = "<b>Agent is working</b> — your message steers it after the current tool round.";
	else hint.innerHTML = "Agent is idle — your message starts a new run.";
}

// --- tool helpers
const TOOL_ICONS = {
	bash: '<path d="m4 17 6-6-6-6M12 19h8"/>',
	http_check: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
	read: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
	edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
	write: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
	service_control: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
	tail_logs: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
	update_incident: '<path d="M4 22V4a1 1 0 0 1 1-1h12l-2 5 2 5H5"/>',
	resolve_incident: '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="M22 4 12 14l-3-3"/>',
};
const toolIcon = (name) => `<svg viewBox="0 0 24 24">${TOOL_ICONS[name] ?? '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'}</svg>`;
function toolArg(name, a = {}) {
	switch (name) {
		case "bash": return a.command;
		case "http_check": return `GET ${a.url}`;
		case "read": return a.path;
		case "edit": return `${a.path} · ${a.edits?.length ?? 0} change${a.edits?.length === 1 ? "" : "s"}`;
		case "write": return a.path;
		case "service_control": return `./run.sh ${a.action}`;
		case "tail_logs": return `logs/app.log${a.lines ? ` · ${a.lines} lines` : ""}${a.grep ? ` · grep "${a.grep}"` : ""}`;
		case "update_incident": return `${a.status} — ${a.note ?? ""}`;
		case "resolve_incident": return a.summary;
		default: return JSON.stringify(a);
	}
}
const TOOL_LABEL = { bash: "Shell", http_check: "HTTP probe", read: "Read file", edit: "Edit file", write: "Write file", service_control: "Service", tail_logs: "Logs", update_incident: "Incident status", resolve_incident: "Resolve" };

function diffHtml(args) {
	const lines = [`<div class="file">${esc(args.path)}</div>`];
	for (const e of args.edits ?? []) {
		for (const l of String(e.oldText).split("\n")) lines.push(`<div class="del">- ${esc(l)}</div>`);
		for (const l of String(e.newText).split("\n")) lines.push(`<div class="add">+ ${esc(l)}</div>`);
	}
	return `<div class="diff">${lines.join("")}</div>`;
}

function toolCard(call, result, live) {
	const blocked = result?.diagnostics?.some?.((d) => /block/i.test(d.code ?? "")) || /^Blocked by/.test(result?.text ?? "");
	const status = result ? (blocked ? "blocked" : result.isError ? "error" : "ok") : live?.status === "running" ? "running" : "pending";
	const httpStatus = call.name === "http_check" && result ? /HTTP (\d+)/.exec(result.text)?.[1] : null;
	const stateHtml =
		status === "running" || status === "pending"
			? `<span class="mini-spin"></span>${status}`
			: status === "ok"
				? `${httpStatus ? `<span class="http-badge" style="background:var(--ok-soft);color:var(--ok)">${httpStatus}</span>` : '<span class="ok-text">✓</span>'} ${dur(result.durationMs)}`
				: status === "blocked"
					? '<span class="err-text">⛔ blocked</span>'
					: `${httpStatus ? `<span class="http-badge" style="background:var(--err-soft);color:var(--err)">${httpStatus}</span>` : '<span class="err-text">✕ failed</span>'} ${dur(result.durationMs)}`;
	const output = result?.text ?? live?.output ?? "";
	const auto = status === "running" || status === "error" || status === "blocked" || call.name === "edit";
	const open = state.toggles.has(call.id) ? state.toggles.get(call.id) : auto;
	const argsBlock = call.name === "edit" ? diffHtml(call.args) : TOOL_LABEL[call.name] ? "" : `<pre class="args">${esc(JSON.stringify(call.args, null, 2))}</pre>`;
	const body = call.name === "edit" ? `${argsBlock}${output ? `<pre>${esc(output)}</pre>` : ""}` : `${argsBlock}${call.name === "bash" ? `<pre class="args">$ ${esc(call.args?.command)}</pre>` : ""}<pre>${esc(output) || '<span style="opacity:.5">waiting for output…</span>'}</pre>`;
	return `<details class="tool ${status}" data-call="${esc(call.id)}" ${open ? "open" : ""}>
		<summary><span class="ticon">${toolIcon(call.name)}</span><span class="tname">${esc(TOOL_LABEL[call.name] ?? call.name)}</span><span class="targ">${esc(toolArg(call.name, call.args))}</span><span class="tstate">${stateHtml}</span><svg class="chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg></summary>
		<div class="tbody">${body}</div>
	</details>`;
}

function itemHtml(it, results, liveTools) {
	const when = `<span class="when">${clock(it.at)}</span>`;
	switch (it.type) {
		case "alert": {
			const a = it.alert;
			const labels = Object.entries(a.labels ?? {}).map(([k, v]) => `<span>${esc(k)}=${esc(v)}</span>`).join("");
			return `<div class="item sev-${esc(a.severity)}"><div class="alert-icon"><svg viewBox="0 0 24 24"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/></svg></div>
				<div class="alert-card"><div class="bar">${a.refire ? "Correlated alert" : "Alert fired"} · <span style="text-transform:uppercase">${esc(a.severity)}</span><span class="src">${esc(a.source)} · ${clock(a.receivedAt)}</span></div>
				<div class="body"><h4>${esc(a.title)}</h4>${a.description ? `<p>${esc(a.description)}</p>` : ""}<div class="labels"><span>service=${esc(a.service)}</span>${labels}</div></div></div></div>`;
		}
		case "assistant": {
			const tools = (it.toolCalls ?? []).map((c) => toolCard(c, results.get(c.id), liveTools.get(c.id))).join("");
			const err = it.error ? `<div class="event err"><span>Model error: ${esc(it.error).slice(0, 200)}</span></div>` : "";
			return `<div class="item${it.stopReason === "aborted" ? " aborted" : ""}"><span class="avatar agent">${AGENT_SVG}</span><div>
				<div class="item-head"><span class="who">Sentinel</span>${when}${it.durationMs ? `<span class="when">· ${dur(it.durationMs)}</span>` : ""}${it.stopReason === "aborted" ? '<span class="tag" style="background:var(--warn-soft);color:var(--warn)" title="The process stopped while this was being written; the durable session retried it">interrupted · retried</span>' : ""}</div>
				${it.thinking ? `<details class="thinking"><summary>Reasoning</summary><div>${esc(it.thinking)}</div></details>` : ""}
				${it.text ? `<div class="md">${md(it.text)}</div>` : ""}${err}
				${tools ? `<div class="tools">${tools}</div>` : ""}
			</div></div>`;
		}
		case "operator":
			return `<div class="item">${avatar(it.author)}<div><div class="item-head"><span class="who">${esc(it.author)}</span><span class="tag">steered the agent</span>${when}</div><div class="bubble steer md">${md(it.text)}</div></div></div>`;
		case "user":
			return `<div class="item">${avatar("user")}<div><div class="item-head"><span class="who">Input</span>${when}</div><div class="bubble md">${md(it.text)}</div></div></div>`;
		case "note":
			return `<div class="item">${avatar(it.author)}<div><div class="item-head"><span class="who">${esc(it.author)}</span><span class="tag" style="background:var(--note);color:var(--text-2)">note</span>${when}</div><div class="note-card md">${md(it.text)}</div></div></div>`;
		case "event":
			return `<div class="event ${esc(it.level ?? "")}"><span>${esc(it.text)} · ${clock(it.at)}</span></div>`;
		default:
			return "";
	}
}

function nearBottom() {
	const s = $("#scroller");
	return s.scrollHeight - s.scrollTop - s.clientHeight < 140;
}
function toBottom(force) {
	const s = $("#scroller");
	if (force) state.stick = true;
	if (state.stick) { s.scrollTop = s.scrollHeight; $("#jumpBtn").hidden = true; }
	else $("#jumpBtn").hidden = false;
}

function renderTranscript(initial) {
	if (!state.feed) return;
	const results = new Map(state.feed.items.filter((i) => i.type === "tool-result").map((r) => [r.callId, r]));
	const liveTools = new Map((state.feed.live?.tools ?? []).map((t) => [t.callId, t]));
	const html = state.feed.items.map((it) => itemHtml(it, results, liveTools)).join("") + resolutionHtml();
	$("#transcript").innerHTML = html;
	requestAnimationFrame(() => toBottom(initial));
}

function resolutionHtml() {
	const inc = currentIncident();
	if (!inc) return "";
	if (inc.status === "resolved" && inc.resolution) {
		const r = inc.resolution;
		return `<div class="resolution"><h4><span class="ok-text">✓</span> Incident resolved · ${dur(r.at - inc.openedAt)} to recover</h4>
			<dl class="grid"><dt>Summary</dt><dd>${esc(r.summary)}</dd><dt>Root cause</dt><dd>${esc(r.rootCause)}</dd>
			${r.actions?.length ? `<dt>Actions</dt><dd><ol>${r.actions.map((a) => `<li>${esc(a)}</li>`).join("")}</ol></dd>` : ""}</dl></div>`;
	}
	if (inc.status === "escalated") {
		return `<div class="resolution escalated"><h4>⚠ Escalated to humans</h4><dl class="grid"><dt>Reason</dt><dd>${esc(inc.escalation ?? "")}</dd></dl></div>`;
	}
	return "";
}

function renderLive() {
	if (!state.feed) return;
	const live = state.feed.live ?? {};
	// Update running tool cards in place (streaming output).
	for (const t of live.tools ?? []) {
		const card = $(`#transcript details.tool[data-call="${CSS.escape(t.callId)}"]`);
		if (card && !card.classList.contains("ok") && !card.classList.contains("error") && !card.classList.contains("blocked")) {
			const call = findCall(t.callId);
			if (call) {
				card.outerHTML = toolCard(call, undefined, t);
				const fresh = $(`#transcript details.tool[data-call="${CSS.escape(t.callId)}"]`);
				const pre = fresh?.querySelector("pre:last-child");
				if (pre) pre.scrollTop = pre.scrollHeight;
			}
		}
	}
	// Streaming assistant message.
	const g = live.generation;
	let html = "";
	if (live.running && g && (g.text || g.thinking || g.toolCalls?.length)) {
		html = `<div class="item"><span class="avatar agent">${AGENT_SVG}</span><div>
			<div class="item-head"><span class="who">Sentinel</span><span class="when">live</span></div>
			${g.thinking ? `<details class="thinking" open><summary>Reasoning</summary><div>${esc(g.thinking.slice(-1500))}</div></details>` : ""}
			<div class="md caret">${md(g.text)}</div>
			${g.toolCalls?.length ? `<div class="tools">${g.toolCalls.map((c) => toolCard(c, undefined, { status: "pending" })).join("")}</div>` : ""}
		</div></div>`;
	} else if (live.running && !live.tools?.some((t) => t.status !== "done")) {
		html = `<div class="item"><span class="avatar agent">${AGENT_SVG}</span><div><div class="item-head"><span class="who">Sentinel</span><span class="when">${g?.retry ? "waiting to retry" : "thinking"}</span></div><span class="dots" style="color:var(--accent)"><i></i><i></i><i></i></span></div></div>`;
	}
	$("#liveArea").innerHTML = html;
	if (html || live.tools?.length) requestAnimationFrame(() => toBottom(false));
}
function findCall(callId) {
	for (let i = state.feed.items.length - 1; i >= 0; i--) {
		const c = state.feed.items[i].toolCalls?.find((x) => x.id === callId);
		if (c) return c;
	}
}

function renderRail() {
	const inc = currentIncident();
	$("#railIncident").hidden = !inc;
	if (inc) {
		const live = state.feed?.live;
		const steps = state.feed?.items.filter((i) => i.type === "tool-result").length ?? 0;
		const facts = [
			["Status", `<span class="status-badge st-${inc.status}">${esc(inc.status)}</span>`],
			["Severity", `<span class="sev-badge sev-${inc.severity}">${esc(inc.severity)}</span>`],
			["Service", esc(inc.service)],
			["Opened", esc(new Date(inc.openedAt).toLocaleString())],
			["Alerts", inc.alerts],
			["Agent", live?.running ? '<span style="color:var(--accent)">working</span>' : "idle"],
			["Tool calls", steps],
			["Operators", inc.participants?.length ? inc.participants.map((p) => avatar(p, "sm")).join("") : '<span class="muted">—</span>'],
			["Session", `<span class="mono">conv #${inc.conversationId}</span>`],
		];
		$("#facts").innerHTML = facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
	}
	const usage = state.feed?.usage;
	const models = usage?.models ? Object.entries(usage.models) : [];
	$("#railUsage").hidden = !models.length;
	if (models.length) {
		const tot = models.reduce((a, [, u]) => ({ input: a.input + (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0), output: a.output + (u.output ?? 0), cost: a.cost + (u.cost?.total ?? 0) }), { input: 0, output: 0, cost: 0 });
		$("#usage").innerHTML = [
			["Model", `<span class="mono">${esc(models.map(([m]) => m).join(", "))}</span>`],
			["Input tokens", tot.input.toLocaleString()],
			["Output tokens", tot.output.toLocaleString()],
			["Cost", `$${tot.cost.toFixed(4)}`],
		]
			.map(([k, v]) => `<dt>${k}</dt><dd class="mono">${v}</dd>`)
			.join("");
	}
}

function renderTyping() {
	const now = Date.now();
	const names = [...state.typing].filter(([, t]) => now - t < 3000).map(([n]) => n);
	$("#typing").textContent = names.length ? `${names.join(", ")} ${names.length > 1 ? "are" : "is"} typing…` : "";
}

// ---------------------------------------------------------------- actions
function sendMessage() {
	const input = $("#input");
	const text = input.value.trim();
	if (!text || !state.selected) return;
	if (!state.connected) return toast("Not connected", "err");
	send({ type: "message", incidentId: state.selected, text, mode: state.mode });
	input.value = "";
	autosize();
	toBottom(true);
}
function autosize() {
	const t = $("#input");
	t.style.height = "auto";
	t.style.height = Math.min(t.scrollHeight, 180) + "px";
}

async function fault(scenario) {
	$("#simMenu").hidden = true;
	try {
		const r = await api("/api/demo/fault", { scenario });
		toast(scenario === "reset" ? "Sample app reset to a healthy state" : `Fault injected: ${scenario}. The monitor will notice within ~${scenario === "data" ? 20 : 20}s.`, scenario === "reset" ? "ok" : "");
		if (r.error) toast(r.error, "err");
	} catch (e) {
		if (e.message !== "unauthorized") toast(e.message, "err");
	}
}
async function testAlert() {
	$("#simMenu").hidden = true;
	try {
		const r = await api("/api/alerts", {
			id: `ui-${Date.now()}`,
			source: "web-ui",
			service: "catalog-api",
			severity: "high",
			title: "catalog-api p99 latency SLO burn",
			description: `Triggered manually by ${state.name} from the Sentinel UI.`,
			labels: { env: "demo", team: "platform" },
		});
		const a = r.accepted?.[0];
		if (a) { toast(`${a.incident} ${a.deduplicated ? "updated (deduplicated)" : "opened"}`, "ok"); select(a.incident); }
	} catch (e) {
		if (e.message !== "unauthorized") toast(e.message, "err");
	}
}

// ---------------------------------------------------------------- modal
function openModal(needToken) {
	$("#modal").hidden = false;
	$("#nameInput").value = state.name;
	$("#tokenRow").hidden = !needToken && !state.needToken;
	if (needToken) { state.needToken = true; $("#modalErr").textContent = state.token ? "That token was rejected." : ""; }
	setTimeout(() => (state.name ? $("#tokenInput") : $("#nameInput")).focus(), 30);
}
$("#modalForm").addEventListener("submit", (e) => {
	e.preventDefault();
	const name = $("#nameInput").value.trim().replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 24);
	if (!name) return;
	state.name = name;
	store.set("sentinel.name", name);
	if (!$("#tokenRow").hidden) { state.token = $("#tokenInput").value.trim(); store.set("sentinel.token", state.token); }
	$("#modal").hidden = true;
	renderMe();
	if (state.ws?.readyState === 1) send({ type: "hello", name });
	if (!$("#tokenRow").hidden) state.ws?.close();
});

// ---------------------------------------------------------------- wiring
$("#incidentList").addEventListener("click", (e) => {
	const card = e.target.closest(".inc-card");
	if (card) select(card.dataset.id);
});
$("#filterTabs").addEventListener("click", (e) => {
	const b = e.target.closest("button");
	if (!b) return;
	state.filter = b.dataset.filter;
	$$("#filterTabs button").forEach((x) => x.classList.toggle("active", x === b));
	renderList();
});
$("#search").addEventListener("input", (e) => { state.query = e.target.value; renderList(); });
$("#modeSeg").addEventListener("click", (e) => {
	const b = e.target.closest("button");
	if (!b) return;
	state.mode = b.dataset.mode;
	$$("#modeSeg button").forEach((x) => x.classList.toggle("active", x === b));
	renderHint();
});
$("#sendBtn").addEventListener("click", sendMessage);
let lastTyping = 0;
$("#input").addEventListener("keydown", (e) => {
	if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); sendMessage(); }
});
$("#input").addEventListener("input", () => {
	autosize();
	if (Date.now() - lastTyping > 1500 && state.selected) { lastTyping = Date.now(); send({ type: "typing", incidentId: state.selected }); }
});
$("#stopBtn").addEventListener("click", () => { send({ type: "stop", incidentId: state.selected }); toast("Stopping the agent…"); });
$("#resolveBtn").addEventListener("click", () => {
	const inc = currentIncident();
	if (inc) send({ type: "status", incidentId: inc.id, status: inc.status === "resolved" ? "open" : "resolved" });
});
$("#simBtn").addEventListener("click", (e) => { e.stopPropagation(); $("#simMenu").hidden = !$("#simMenu").hidden; });
document.addEventListener("click", (e) => {
	if (!e.target.closest(".menu-wrap")) $("#simMenu").hidden = true;
	const f = e.target.closest("[data-fault]");
	if (f) fault(f.dataset.fault);
	if (e.target.closest("[data-action=alert]")) testAlert();
	if (!e.target.closest("#rail, #railBtn")) $("#rail").classList.remove("open");
	if (!e.target.closest("#sidebar, #menuBtn")) $("#sidebar").classList.remove("open");
});
$("#themeBtn").addEventListener("click", () => {
	const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
	document.documentElement.dataset.theme = dark ? "light" : "dark";
	store.set("sentinel.theme", document.documentElement.dataset.theme);
});
$("#meChip").addEventListener("click", () => openModal(false));
$("#menuBtn").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
$("#railBtn").addEventListener("click", () => $("#rail").classList.toggle("open"));
$("#scroller").addEventListener("scroll", () => { state.stick = nearBottom(); if (state.stick) $("#jumpBtn").hidden = true; });
$("#main").addEventListener("click", (e) => {
	const sum = e.target.closest("details.tool > summary");
	if (sum) state.toggles.set(sum.parentElement.dataset.call, !sum.parentElement.open);
});
$("#jumpBtn").addEventListener("click", () => toBottom(true));
setInterval(() => { renderHeader(); renderList(); }, 15_000);

renderMe();
if (!state.name) openModal(false);
connect();
