import type { SessionStore } from "../domain/session-store.ts";
import type { ProcessTable } from "../infrastructure/process-table.ts";
import type { IngestorLogger } from "./event-ingestor.ts";

/**
 * Periodically reconciles the session store with the process table: discovers agents started before the plugin
 * and removes sessions whose process exited without a SessionEnd hook (crash, closed terminal, kill -9).
 */
export class ProcessMonitor {
	readonly #store: SessionStore;
	readonly #processes: ProcessTable;
	readonly #log: IngestorLogger;
	readonly #intervalMs: number;
	readonly #beforeReconcile: () => Promise<void>;
	#timer: NodeJS.Timeout | null = null;
	#running = false;

	constructor(
		store: SessionStore,
		processes: ProcessTable,
		log: IngestorLogger,
		beforeReconcile: () => Promise<void>,
		intervalMs = 4_000,
	) {
		this.#store = store;
		this.#processes = processes;
		this.#log = log;
		this.#beforeReconcile = beforeReconcile;
		this.#intervalMs = intervalMs;
	}

	start(): void {
		if (this.#timer !== null) return;
		void this.scan();
		this.#timer = setInterval(() => void this.scan(), this.#intervalMs);
		this.#timer.unref();
	}

	stop(): void {
		if (this.#timer !== null) clearInterval(this.#timer);
		this.#timer = null;
	}

	async scan(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		try {
			const { processes, observedAt } = await this.#processes.discover();
			// Let queued hook events land first so a SessionStart is not shadowed by a discovered `idle`.
			await this.#beforeReconcile();
			this.#store.reconcile(processes, observedAt, Date.now());
		} catch (error) {
			this.#log.warn(`process scan failed: ${String(error)}`);
		} finally {
			this.#running = false;
		}
	}
}
