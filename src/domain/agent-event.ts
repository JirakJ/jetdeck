import type { AgentKind, TerminalRef } from "./agent.ts";

/** Agent-agnostic meaning of a single hook invocation. */
export type AgentSignal =
	| { readonly type: "session-start" }
	| { readonly type: "prompt" }
	| { readonly type: "tool-start"; readonly tool: string | null }
	| { readonly type: "tool-end"; readonly tool: string | null; readonly failed: boolean }
	| { readonly type: "permission"; readonly detail: string | null }
	| { readonly type: "needs-input"; readonly detail: string | null }
	| { readonly type: "resumed" }
	| { readonly type: "turn-end" }
	| { readonly type: "interrupt" }
	| { readonly type: "error"; readonly message: string | null }
	| { readonly type: "session-end" }
	| { readonly type: "note"; readonly message: string | null };

/** A hook event after normalisation and process resolution. */
export interface AgentEvent {
	readonly agent: AgentKind;
	readonly pid: number;
	readonly startedAt: number;
	readonly terminal: TerminalRef;
	readonly sessionId: string | null;
	readonly cwd: string | null;
	readonly signal: AgentSignal;
	readonly at: number;
}

/** An interactive agent process found by scanning the process table. */
export interface DiscoveredProcess {
	readonly agent: AgentKind;
	readonly pid: number;
	readonly startedAt: number;
	readonly terminal: TerminalRef;
	readonly cwd: string | null;
}
