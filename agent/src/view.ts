/** Maps pi-durable transcript entries and the pi.live document to a compact shape for the web UI. */
import type { LiveState } from "@earendil-works/pi-durable";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const MAX_TEXT = 12_000;
const clip = (s: string, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more chars)` : s);
const textOf = (content: Json): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.filter((b) => b?.type === "text").map((b) => b.text).join("")
			: "";

export type UiItem = { id: number; at?: number; type: string; [k: string]: Json };

export function toUiItem(entry: Json): UiItem | undefined {
	const id = entry.id as number;
	const msg = entry.model?.[0];
	const at = msg?.timestamp ?? entry.data?.at ?? entry.data?.receivedAt;
	switch (entry.kind) {
		case "sre.alert":
			return { id, at, type: "alert", alert: entry.data };
		case "sre.operator":
			return { id, at, type: "operator", author: entry.data.author, text: entry.data.text, mode: entry.data.mode };
		case "sre.note":
			return { id, at, type: "note", author: entry.data.author, text: entry.data.text };
		case "sre.event":
			return { id, at, type: "event", ...entry.data };
		case "pi.user":
			return { id, at, type: "user", text: clip(textOf(msg?.content)) };
		case "pi.assistant": {
			const content = (msg?.content ?? []) as Json[];
			return {
				id,
				at,
				type: "assistant",
				text: content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n"),
				thinking: content.filter((b) => b.type === "thinking").map((b) => b.thinking).join("\n"),
				toolCalls: content.filter((b) => b.type === "toolCall").map((b) => ({ id: b.id, name: b.name, args: b.arguments })),
				model: msg?.model,
				stopReason: msg?.stopReason,
				error: msg?.errorMessage,
				durationMs: msg?.durationMs,
				usage: msg?.usage ? { input: msg.usage.input, output: msg.usage.output, cost: msg.usage.cost?.total } : undefined,
			};
		}
		case "pi.tool-result":
			return {
				id,
				at,
				type: "tool-result",
				callId: msg?.toolCallId,
				name: msg?.toolName,
				isError: !!msg?.isError,
				text: clip(textOf(msg?.content)),
				details: entry.data?.details ?? msg?.details,
				diagnostics: entry.data?.diagnostics,
				durationMs: msg?.durationMs,
			};
		case "pi.compaction":
			return { id, at, type: "event", level: "info", text: "Context compacted to stay within the model window" };
		case "pi.reset":
			return { id, at, type: "event", level: "info", text: "Context reset" };
		default:
			return undefined; // pi.system and others are not shown
	}
}

export function toUiLive(live: LiveState | undefined) {
	if (!live) return { running: false };
	const gen = live.generation as Json;
	const message = gen?.message;
	const content = (message?.content ?? []) as Json[];
	return {
		running: live.run !== undefined,
		turns: live.run?.turns ?? 0,
		afterRun: !!live.run?.afterRun,
		generation: gen
			? {
					attempt: gen.attempt,
					text: content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n"),
					thinking: content.filter((b) => b.type === "thinking").map((b) => b.thinking).join(""),
					toolCalls: content.filter((b) => b.type === "toolCall").map((b) => ({ id: b.id, name: b.name, args: b.arguments })),
					retry: gen.retry,
				}
			: undefined,
		tools: (live.tools ?? []).map((t) => ({
			callId: t.callId,
			name: t.name,
			status: t.status,
			output: t.output ? clip(t.output.slice(-6000), 6000) : undefined,
		})),
		runFailure: live.runFailure ? { reason: live.runFailure.reason, detail: live.runFailure.detail } : undefined,
	};
}
