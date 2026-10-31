import { spawn, type ChildProcess } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { createInterface } from "node:readline";
import { parseMetricsLine, type SystemMetrics } from "../domain/system-metrics.ts";

export type MetricsListener = (metrics: SystemMetrics) => void;

export interface SamplerLogger {
	info(message: string): void;
	warn(message: string): void;
}

const MAX_BACKOFF_MS = 30_000;

/**
 * Runs the native `jetdeck-metrics` helper only while somebody is interested (reference-counted),
 * restarting it with exponential backoff if it dies.
 */
export class MetricsSampler {
	readonly #binary: string;
	readonly #intervalMs: number;
	readonly #log: SamplerLogger;
	readonly #listeners = new Set<MetricsListener>();
	#child: ChildProcess | null = null;
	#users = 0;
	#backoffMs = 1_000;
	#restartTimer: NodeJS.Timeout | null = null;
	#latest: SystemMetrics | null = null;

	constructor(binary: string, log: SamplerLogger, intervalMs = 1_000) {
		this.#binary = binary;
		this.#log = log;
		this.#intervalMs = intervalMs;
	}

	get latest(): SystemMetrics | null {
		return this.#latest;
	}

	subscribe(listener: MetricsListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Declares one more consumer; the helper starts with the first. */
	acquire(): void {
		this.#users++;
		if (this.#users === 1) void this.#start();
	}

	/** Releases one consumer; the helper stops with the last. */
	release(): void {
		this.#users = Math.max(0, this.#users - 1);
		if (this.#users === 0) this.#stop();
	}

	dispose(): void {
		this.#users = 0;
		this.#stop();
	}

	async #start(): Promise<void> {
		if (this.#child !== null || this.#users === 0) return;
		try {
			await access(this.#binary, constants.X_OK);
		} catch {
			this.#log.warn(`metrics helper missing or not executable: ${this.#binary}`);
			return;
		}
		if (this.#child !== null || this.#users === 0) return;

		const child = spawn(this.#binary, [String(this.#intervalMs)], { stdio: ["ignore", "pipe", "pipe"] });
		this.#child = child;
		const startedAt = Date.now();

		createInterface({ input: child.stdout! }).on("line", (line) => {
			const metrics = parseMetricsLine(line);
			if (metrics === null) return;
			this.#latest = metrics;
			this.#backoffMs = 1_000;
			for (const listener of this.#listeners) listener(metrics);
		});
		child.stderr!.on("data", (chunk: Buffer) => this.#log.warn(`metrics helper: ${chunk.toString().trim()}`));
		child.on("error", (error) => this.#log.warn(`metrics helper failed to start: ${error.message}`));
		child.on("exit", (code, signal) => {
			if (this.#child === child) this.#child = null;
			if (this.#users === 0) return;
			const delay = Date.now() - startedAt > MAX_BACKOFF_MS ? 1_000 : this.#backoffMs;
			this.#backoffMs = Math.min(MAX_BACKOFF_MS, this.#backoffMs * 2);
			this.#log.warn(`metrics helper exited (${signal ?? code}); restarting in ${delay} ms`);
			this.#restartTimer = setTimeout(() => {
				this.#restartTimer = null;
				void this.#start();
			}, delay);
		});
		this.#log.info(`metrics helper started (pid ${child.pid ?? "?"})`);
	}

	#stop(): void {
		if (this.#restartTimer !== null) clearTimeout(this.#restartTimer);
		this.#restartTimer = null;
		const child = this.#child;
		this.#child = null;
		if (child !== null && child.exitCode === null) child.kill("SIGTERM");
	}
}
