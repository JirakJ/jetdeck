import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import { promisify } from "node:util";
import type { AgentKind, TerminalKind, TerminalRef } from "../domain/agent.ts";
import type { DiscoveredProcess } from "../domain/agent-event.ts";

const run = promisify(execFile);

export interface ProcessInfo {
	readonly pid: number;
	readonly ppid: number;
	/** `/dev/ttys004`, or null for processes without a controlling terminal. */
	readonly tty: string | null;
	readonly startedAt: number;
	readonly args: string;
}

export type ProcessSnapshot = ReadonlyMap<number, ProcessInfo>;

/** The interactive agent process a hook invocation belongs to. */
export interface AgentProcess {
	readonly agent: AgentKind;
	readonly pid: number;
	readonly startedAt: number;
	readonly terminal: TerminalRef;
}

const AGENT_EXECUTABLES: ReadonlyMap<string, AgentKind> = new Map([
	["claude", "claude"],
	["codex", "codex"],
	["copilot", "copilot"],
]);

const AGENT_PACKAGES: ReadonlyArray<readonly [AgentKind, RegExp]> = [
	["claude", /\/@anthropic-ai\/claude-code\//u],
	["codex", /\/@openai\/codex\//u],
	["copilot", /\/@github\/copilot\//u],
];

/** Launchers whose first non-flag argument is the actual program. */
const INTERPRETERS = new Set(["node", "bun", "deno", "sh", "bash", "zsh", "dash"]);

const TERMINAL_PATTERNS: ReadonlyArray<readonly [TerminalKind, RegExp]> = [
	["ghostty", /\/Ghostty\.app\/|(?:^|\/)ghostty(?:\s|$)/u],
	["apple-terminal", /\/Terminal\.app\//u],
	["vscode", /\/(?:Visual Studio Code|Visual Studio Code - Insiders|Cursor|Windsurf)\.app\//u],
	["jetbrains", /\/(?:IntelliJ IDEA[^/]*|WebStorm|PyCharm[^/]*|CLion|GoLand|Rider|RustRover|PhpStorm|DataGrip|Android Studio)\.app\//u],
];

const MAX_DEPTH = 64;

/** Cached view of the OS process table, shared by hook resolution and the periodic scan. */
export class ProcessTable {
	readonly #maxAgeMs: number;
	#snapshot: ProcessSnapshot = new Map();
	#takenAt = 0;
	#pending: Promise<ProcessSnapshot> | null = null;

	constructor(maxAgeMs = 1_000) {
		this.#maxAgeMs = maxAgeMs;
	}

	/** Returns a snapshot no older than `maxAgeMs`; concurrent callers share one `ps` run. */
	async snapshot(force = false): Promise<ProcessSnapshot> {
		if (!force && Date.now() - this.#takenAt <= this.#maxAgeMs) return this.#snapshot;
		this.#pending ??= readProcessTable().then(
			(snapshot) => {
				this.#snapshot = snapshot;
				this.#takenAt = Date.now();
				this.#pending = null;
				return snapshot;
			},
			(error: unknown) => {
				this.#pending = null;
				throw error;
			},
		);
		return this.#pending;
	}

	/** Resolves the agent process owning `pid` (the hook's parent), refreshing the table once if it is unknown. */
	async resolveAgent(pid: number, hintAgent: AgentKind, termHint: TerminalKind): Promise<AgentProcess | null> {
		let snapshot = await this.snapshot();
		if (!snapshot.has(pid)) snapshot = await this.snapshot(true);
		return findAgent(snapshot, pid, hintAgent, termHint);
	}

	/** All interactive (TTY-attached) agent processes, outermost process per agent instance. */
	async discover(): Promise<{ readonly processes: DiscoveredProcess[]; readonly observedAt: number }> {
		const observedAt = Date.now();
		const snapshot = await this.snapshot(true);
		const roots = new Map<number, AgentProcess>();
		for (const info of snapshot.values()) {
			const agent = agentOf(info.args);
			if (agent === null || info.tty === null) continue;
			const root = findAgent(snapshot, info.pid, agent, "unknown");
			if (root !== null) roots.set(root.pid, root);
		}
		const cwds = await readCwds([...roots.keys()]);
		return {
			processes: [...roots.values()].map((p) => ({ ...p, cwd: cwds.get(p.pid) ?? null })),
			observedAt,
		};
	}
}

/**
 * Identifies an agent by the program being run (argv[0], or the script an interpreter runs),
 * never by arbitrary arguments, so `grep claude` or `script … /x/claude` are not agents.
 */
export function agentOf(args: string): AgentKind | null {
	const tokens = args.slice(0, 1_024).split(" ").filter((t) => t.length > 0);
	const program = tokens[0];
	if (program === undefined) return null;
	const direct = programAgent(program);
	if (direct !== null) return direct;
	if (!INTERPRETERS.has(basename(program))) return null;
	const scriptIndex = tokens.findIndex((t, i) => i > 0 && !t.startsWith("-"));
	if (scriptIndex < 0) return null;
	// `sh -c '…'` / `node -e '…'` run inline code, not a script file.
	if (tokens.slice(1, scriptIndex).some((flag) => /^-[a-z]*[ce]$/u.test(flag))) return null;
	return programAgent(tokens[scriptIndex] ?? "");
}

function programAgent(path: string): AgentKind | null {
	const byName = AGENT_EXECUTABLES.get(basename(path));
	if (byName !== undefined) return byName;
	for (const [agent, pattern] of AGENT_PACKAGES) if (pattern.test(path)) return agent;
	return null;
}

function basename(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash >= 0 ? path.slice(slash + 1) : path;
}

/**
 * Walks up from `pid` to the first process of `agent`, then keeps climbing while the parent is the same agent
 * (launcher shims), so hooks and scans always agree on one pid per agent instance.
 */
export function findAgent(
	snapshot: ProcessSnapshot,
	pid: number,
	agent: AgentKind,
	termHint: TerminalKind,
): AgentProcess | null {
	let current = snapshot.get(pid);
	let found: ProcessInfo | null = null;
	for (let depth = 0; current !== undefined && depth < MAX_DEPTH; depth++) {
		if (agentOf(current.args) === agent) found = current;
		else if (found !== null) break;
		current = current.ppid > 0 && current.ppid !== current.pid ? snapshot.get(current.ppid) : undefined;
	}
	if (found === null || found.tty === null) return null;
	return {
		agent,
		pid: found.pid,
		startedAt: found.startedAt,
		terminal: detectTerminal(snapshot, found, termHint),
	};
}

function detectTerminal(snapshot: ProcessSnapshot, from: ProcessInfo, termHint: TerminalKind): TerminalRef {
	let current: ProcessInfo | undefined = from;
	for (let depth = 0; current !== undefined && depth < MAX_DEPTH; depth++) {
		for (const [kind, pattern] of TERMINAL_PATTERNS) {
			if (pattern.test(current.args)) {
				return { kind, tty: from.tty, appBundle: bundleOf(current.args) };
			}
		}
		current = current.ppid > 1 ? snapshot.get(current.ppid) : undefined;
	}
	return { kind: termHint, tty: from.tty, appBundle: null };
}

function bundleOf(args: string): string | null {
	const match = /^(.*?\.app)\//u.exec(args);
	return match?.[1] ?? null;
}

export function terminalFromEnv(termProgram: string, emulator: string): TerminalKind {
	if (/^ghostty$/iu.test(termProgram)) return "ghostty";
	if (termProgram === "Apple_Terminal") return "apple-terminal";
	if (termProgram === "vscode") return "vscode";
	if (/JetBrains/iu.test(emulator)) return "jetbrains";
	return "unknown";
}

export async function readProcessTable(): Promise<ProcessSnapshot> {
	const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,tty=,etime=,args="], {
		maxBuffer: 32 * 1024 * 1024,
		env: { ...process.env, LC_ALL: "C" },
	});
	return parsePs(stdout, Date.now());
}

export function parsePs(output: string, now: number): Map<number, ProcessInfo> {
	const table = new Map<number, ProcessInfo>();
	for (const line of output.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/u.exec(line);
		if (match === null) continue;
		const [, pid, ppid, tty, etime, args] = match as unknown as [string, string, string, string, string, string];
		const elapsed = parseEtime(etime);
		table.set(Number(pid), {
			pid: Number(pid),
			ppid: Number(ppid),
			tty: ttyPath(tty),
			startedAt: elapsed === null ? now : now - elapsed * 1_000,
			args,
		});
	}
	return table;
}

function ttyPath(tty: string): string | null {
	if (tty === "??" || tty === "?" || tty === "-") return null;
	return tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
}

/** Parses `ps` etime: `[[dd-]hh:]mm:ss` (procps may print bare seconds) into seconds. */
export function parseEtime(etime: string): number | null {
	const match = /^(?:(?:(\d+)-)?(?:(\d+):)?(\d+):)?(\d+)$/u.exec(etime);
	if (match === null) return null;
	const [, days, hours, minutes, seconds] = match;
	return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes ?? 0) * 60 + Number(seconds);
}

async function readCwds(pids: readonly number[]): Promise<Map<number, string>> {
	const result = new Map<number, string>();
	if (pids.length === 0) return result;
	if (process.platform === "linux") {
		await Promise.all(
			pids.map(async (pid) => {
				try {
					result.set(pid, await readlink(`/proc/${pid}/cwd`));
				} catch {
					// Process exited or is not ours.
				}
			}),
		);
		return result;
	}
	let stdout: string;
	try {
		({ stdout } = await run("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], {
			maxBuffer: 4 * 1024 * 1024,
		}));
	} catch (error) {
		// lsof exits 1 when some pids vanished; whatever it printed is still valid.
		stdout = (error as { stdout?: string }).stdout ?? "";
	}
	let pid: number | null = null;
	for (const line of stdout.split("\n")) {
		if (line.startsWith("p")) pid = Number(line.slice(1));
		else if (line.startsWith("n") && pid !== null) result.set(pid, line.slice(1));
	}
	return result;
}
