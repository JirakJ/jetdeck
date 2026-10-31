export const AGENT_KINDS = ["claude", "codex", "copilot"] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

export const AGENT_LABEL: Readonly<Record<AgentKind, string>> = {
	claude: "CLAUDE",
	codex: "CODEX",
	copilot: "COPILOT",
};

export function isAgentKind(value: unknown): value is AgentKind {
	return typeof value === "string" && (AGENT_KINDS as readonly string[]).includes(value);
}

/** Selects which agents a key or prompt targets. */
export type AgentFilter = AgentKind | "any";

export function isAgentFilter(value: unknown): value is AgentFilter {
	return value === "any" || isAgentKind(value);
}

export function matchesFilter(agent: AgentKind, filter: AgentFilter): boolean {
	return filter === "any" || filter === agent;
}

/**
 * Lifecycle of one interactive agent process.
 * - `idle`     process is running, no turn has started yet (or the last one was interrupted)
 * - `working`  a turn is in progress
 * - `awaiting` the agent is blocked on the user (permission prompt, question)
 * - `done`     the last turn finished, the agent waits for the next prompt
 * - `error`    the last turn ended with an error
 */
export type SessionState = "idle" | "working" | "awaiting" | "done" | "error";

/** Terminal hosting the agent process, detected from the process ancestry. */
export type TerminalKind = "ghostty" | "apple-terminal" | "vscode" | "jetbrains" | "unknown";

export interface TerminalRef {
	readonly kind: TerminalKind;
	/** Controlling TTY device path, e.g. `/dev/ttys004`. */
	readonly tty: string | null;
	/** Absolute path of the hosting `.app` bundle, used when only app-level focus is possible. */
	readonly appBundle: string | null;
}

export interface Session {
	/** Stable identity: one interactive agent process = one session. */
	readonly key: string;
	readonly agent: AgentKind;
	readonly pid: number;
	readonly startedAt: number;
	readonly sessionId: string | null;
	readonly cwd: string | null;
	readonly terminal: TerminalRef;
	readonly state: SessionState;
	readonly stateSince: number;
	readonly turnStartedAt: number | null;
	/** Short human-readable detail: running tool, pending permission, last error. */
	readonly activity: string | null;
	readonly lastEventAt: number;
}

export function sessionKey(agent: AgentKind, pid: number): string {
	return `${agent}:${pid}`;
}

export function projectName(cwd: string | null): string {
	if (cwd === null || cwd.length === 0) return "—";
	const trimmed = cwd.replace(/\/+$/u, "");
	const slash = trimmed.lastIndexOf("/");
	const name = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
	return name.length > 0 ? name : "/";
}
