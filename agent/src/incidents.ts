import { defineDoc } from "@earendil-works/pi-durable";

export type Severity = "critical" | "high" | "medium" | "low";
export type IncidentStatus = "open" | "investigating" | "mitigated" | "resolved" | "escalated";

export type Alert = {
	id: string;
	source: string;
	service: string;
	severity: Severity;
	title: string;
	description?: string;
	fingerprint?: string;
	labels?: Record<string, string>;
	receivedAt: number;
};

export type Resolution = {
	summary: string;
	rootCause: string;
	actions: string[];
	at: number;
};

export type Incident = {
	id: string;
	number: number;
	conversationId: number;
	title: string;
	service: string;
	severity: Severity;
	status: IncidentStatus;
	fingerprint: string;
	openedAt: number;
	updatedAt: number;
	alerts: number;
	resolution?: Resolution;
	escalation?: string;
	participants: string[];
};

type IncidentsState = { next: number; items: Incident[] };

/**
 * The incident registry, a Session-scoped pi-durable document: it is committed atomically with the
 * transcripts in the same SQLite file, so it survives restarts together with the agent's work.
 */
export const Incidents = defineDoc<IncidentsState>({
	kind: "sre.incidents",
	version: 1,
	scope: "session",
	initial: () => ({ next: 1, items: [] }),
	checkpointWhen: () => true,
});

export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
