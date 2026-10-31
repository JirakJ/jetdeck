import { matchesFilter, sessionKey, type AgentFilter, type Session, type SessionState } from "./agent.ts";
import type { AgentEvent, AgentSignal, DiscoveredProcess } from "./agent-event.ts";

export type StoreListener = () => void;

/**
 * In-memory registry of live agent sessions. Hook events drive the state machine,
 * process scans add sessions started before the plugin and drop sessions whose process died.
 */
export class SessionStore {
	readonly #sessions = new Map<string, Session>();
	readonly #listeners = new Set<StoreListener>();

	subscribe(listener: StoreListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	get(key: string): Session | undefined {
		return this.#sessions.get(key);
	}

	/** Sessions matching the filter, oldest process first. */
	list(filter: AgentFilter = "any"): Session[] {
		return [...this.#sessions.values()]
			.filter((s) => matchesFilter(s.agent, filter))
			.sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid);
	}

	/** Sessions blocked on the user, longest-waiting first. */
	awaiting(): Session[] {
		return [...this.#sessions.values()]
			.filter((s) => s.state === "awaiting")
			.sort((a, b) => a.stateSince - b.stateSince);
	}

	apply(event: AgentEvent): void {
		const key = sessionKey(event.agent, event.pid);
		const current = this.#sessions.get(key);

		if (event.signal.type === "session-end") {
			if (current !== undefined) {
				this.#sessions.delete(key);
				this.#emit();
			}
			return;
		}

		const base: Session = current ?? {
			key,
			agent: event.agent,
			pid: event.pid,
			startedAt: event.startedAt,
			sessionId: null,
			cwd: null,
			terminal: event.terminal,
			state: "idle",
			stateSince: event.at,
			turnStartedAt: null,
			activity: null,
			lastEventAt: event.at,
		};

		const withContext: Session = {
			...base,
			sessionId: event.sessionId ?? base.sessionId,
			cwd: event.cwd ?? base.cwd,
			terminal: event.terminal.tty !== null || base.terminal.tty === null ? event.terminal : base.terminal,
			lastEventAt: event.at,
		};

		this.#sessions.set(key, transition(withContext, event.signal, event.at));
		this.#emit();
	}

	/**
	 * Reconciles the registry with the current process table: sessions whose process is gone are removed,
	 * agent processes without any hook event yet are registered as `idle`.
	 * Only sessions whose process already existed when the table was read (`observedAt`) can be removed,
	 * so a session created by a hook that raced the scan survives.
	 */
	reconcile(processes: readonly DiscoveredProcess[], observedAt: number, now: number): void {
		let changed = false;
		const alive = new Set<string>();

		for (const process of processes) {
			const key = sessionKey(process.agent, process.pid);
			alive.add(key);
			const current = this.#sessions.get(key);
			if (current === undefined) {
				this.#sessions.set(key, {
					key,
					agent: process.agent,
					pid: process.pid,
					startedAt: process.startedAt,
					sessionId: null,
					cwd: process.cwd,
					terminal: process.terminal,
					state: "idle",
					stateSince: now,
					turnStartedAt: null,
					activity: null,
					lastEventAt: now,
				});
				changed = true;
			} else if (current.cwd === null && process.cwd !== null) {
				this.#sessions.set(key, { ...current, cwd: process.cwd });
				changed = true;
			}
		}

		for (const [key, session] of [...this.#sessions]) {
			if (!alive.has(key) && session.startedAt < observedAt) {
				this.#sessions.delete(key);
				changed = true;
			}
		}

		if (changed) this.#emit();
	}

	#emit(): void {
		for (const listener of this.#listeners) listener();
	}
}

function transition(session: Session, signal: AgentSignal, at: number): Session {
	switch (signal.type) {
		case "session-start":
			return enter(session, "idle", at, { turnStartedAt: null, activity: null });
		case "prompt":
			return enter(session, "working", at, { turnStartedAt: at, activity: null });
		case "tool-start":
			return enter(session, "working", at, {
				turnStartedAt: session.turnStartedAt ?? at,
				activity: signal.tool,
			});
		case "tool-end":
			return enter(session, "working", at, {
				turnStartedAt: session.turnStartedAt ?? at,
				activity: signal.failed && signal.tool !== null ? `${signal.tool} failed` : session.activity,
			});
		case "permission":
			return enter(session, "awaiting", at, { activity: signal.detail ?? "permission" });
		case "needs-input":
			return enter(session, "awaiting", at, { activity: signal.detail ?? "input" });
		case "resumed":
			return session.state === "awaiting" ? enter(session, "working", at, { activity: null }) : session;
		case "turn-end":
			// Claude's idle reminder arrives long after Stop; never let it reset the timestamp of a finished turn.
			return session.state === "done" ? session : enter(session, "done", at, { activity: null });
		case "interrupt":
			return enter(session, "idle", at, { turnStartedAt: null, activity: "interrupted" });
		case "error":
			return enter(session, "error", at, { activity: signal.message ?? "error" });
		case "note":
			return signal.message !== null && session.state !== "awaiting"
				? { ...session, activity: signal.message }
				: session;
		case "session-end":
			return session;
	}
}

function enter(
	session: Session,
	state: SessionState,
	at: number,
	patch: Partial<Pick<Session, "turnStartedAt" | "activity">>,
): Session {
	const changedState = session.state !== state;
	return {
		...session,
		...patch,
		state,
		stateSince: changedState ? at : session.stateSince,
	};
}
