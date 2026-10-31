import type { AgentFilter, Session } from "./agent.ts";
import type { SessionStore } from "./session-store.ts";

export type PromptTarget = AgentFilter | "attention";

export function isPromptTarget(value: unknown): value is PromptTarget {
	return value === "attention" || value === "any" || value === "claude" || value === "codex" || value === "copilot";
}

const READY_RANK: Readonly<Record<Session["state"], number>> = {
	awaiting: 0,
	done: 1,
	idle: 2,
	error: 3,
	working: 4,
};

/**
 * Picks the session a prompt should go to: for `attention` the longest-waiting blocked session,
 * otherwise the matching session that is most ready for input, most recently active first.
 */
export function selectPromptTarget(store: SessionStore, target: PromptTarget): Session | null {
	if (target === "attention") return store.awaiting()[0] ?? null;
	const candidates = store.list(target);
	candidates.sort((a, b) => READY_RANK[a.state] - READY_RANK[b.state] || b.lastEventAt - a.lastEventAt);
	return candidates[0] ?? null;
}

/** Session the "Needs You" key jumps to: the longest-waiting blocked one, else the most recently finished one. */
export function selectAttentionTarget(store: SessionStore): Session | null {
	const blocked = store.awaiting()[0];
	if (blocked !== undefined) return blocked;
	const finished = store
		.list("any")
		.filter((s) => s.state === "done" || s.state === "error")
		.sort((a, b) => b.stateSince - a.stateSince);
	return finished[0] ?? null;
}
