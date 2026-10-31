import { normalizeHook } from "../domain/event-normalizer.ts";
import type { SessionStore } from "../domain/session-store.ts";
import type { HookDelivery } from "../infrastructure/ingest-server.ts";
import { terminalFromEnv, type ProcessTable } from "../infrastructure/process-table.ts";

export interface IngestorLogger {
	debug(message: string): void;
	warn(message: string): void;
}

/**
 * Turns raw hook deliveries into store updates. Deliveries are processed strictly in arrival order,
 * because process resolution is asynchronous and the session state machine depends on ordering.
 */
export class EventIngestor {
	readonly #store: SessionStore;
	readonly #processes: ProcessTable;
	readonly #log: IngestorLogger;
	#tail: Promise<void> = Promise.resolve();

	constructor(store: SessionStore, processes: ProcessTable, log: IngestorLogger) {
		this.#store = store;
		this.#processes = processes;
		this.#log = log;
	}

	readonly accept = (delivery: HookDelivery): void => {
		this.#tail = this.#tail.then(
			() => this.#process(delivery),
			() => this.#process(delivery),
		);
	};

	/** Resolves once every delivery accepted so far has been applied. */
	drain(): Promise<void> {
		return this.#tail.catch(() => undefined);
	}

	async #process(delivery: HookDelivery): Promise<void> {
		try {
			const hint = terminalFromEnv(delivery.termProgram, delivery.terminalEmulator);
			const agent = await this.#processes.resolveAgent(delivery.ppid, delivery.agent, hint);
			if (agent === null) {
				this.#log.debug(`${delivery.agent} ${delivery.event}: no interactive agent process above pid ${delivery.ppid}`);
				return;
			}
			const { fields, signal } = normalizeHook(delivery.agent, delivery.event, delivery.payload);
			this.#store.apply({
				agent: agent.agent,
				pid: agent.pid,
				startedAt: agent.startedAt,
				terminal: agent.terminal,
				sessionId: fields.sessionId,
				cwd: fields.cwd,
				signal,
				at: delivery.receivedAt,
			});
		} catch (error) {
			this.#log.warn(`failed to process ${delivery.agent} ${delivery.event}: ${String(error)}`);
		}
	}
}
