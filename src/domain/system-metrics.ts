export const METRIC_KINDS = ["cpu", "gpu", "ane", "ram", "disk"] as const;

export type MetricKind = (typeof METRIC_KINDS)[number];

export function isMetricKind(value: unknown): value is MetricKind {
	return typeof value === "string" && (METRIC_KINDS as readonly string[]).includes(value);
}

export interface CpuMetrics {
	/** Mean active residency over all cores, 0..1. */
	readonly usage: number;
	readonly p: number;
	readonly e: number;
	readonly pCores: number;
	readonly eCores: number;
}

export interface GpuMetrics {
	readonly usage: number | null;
	readonly watts: number | null;
	readonly memoryBytes: number | null;
}

export interface AneMetrics {
	/** Share of time the Neural Engine drives fabric traffic, 0..1. */
	readonly active: number;
}

export interface RamMetrics {
	readonly usedBytes: number;
	readonly totalBytes: number;
	readonly swapBytes: number;
	/** Kernel memory pressure: 1 normal, 2 warning, 4 critical (0 = unknown). */
	readonly pressure: number;
}

export interface DiskMetrics {
	readonly totalBytes: number;
	readonly availableBytes: number;
}

export interface SystemMetrics {
	readonly at: number;
	readonly cpu: CpuMetrics | null;
	readonly gpu: GpuMetrics | null;
	readonly ane: AneMetrics | null;
	readonly ram: RamMetrics | null;
	readonly disk: DiskMetrics | null;
}

type Json = Readonly<Record<string, unknown>>;

/** Parses one line of `jetdeck-metrics` output; returns null for anything malformed. */
export function parseMetricsLine(line: string): SystemMetrics | null {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isObject(raw)) return null;
	const at = num(raw["at"]);
	if (at === null) return null;
	return {
		at,
		cpu: parseCpu(raw["cpu"]),
		gpu: parseGpu(raw["gpu"]),
		ane: parseAne(raw["ane"]),
		ram: parseRam(raw["ram"]),
		disk: parseDisk(raw["disk"]),
	};
}

function parseCpu(value: unknown): CpuMetrics | null {
	if (!isObject(value)) return null;
	const usage = ratio(value["usage"]);
	const p = ratio(value["p"]);
	const e = ratio(value["e"]);
	const pCores = num(value["pCores"]);
	const eCores = num(value["eCores"]);
	if (usage === null || p === null || e === null || pCores === null || eCores === null) return null;
	return { usage, p, e, pCores, eCores };
}

function parseGpu(value: unknown): GpuMetrics | null {
	if (!isObject(value)) return null;
	const usage = ratio(value["usage"]);
	const watts = num(value["watts"]);
	if (usage === null && watts === null) return null;
	return { usage, watts: watts !== null && watts >= 0 ? watts : null, memoryBytes: num(value["memoryBytes"]) };
}

function parseAne(value: unknown): AneMetrics | null {
	if (!isObject(value)) return null;
	const active = ratio(value["active"]);
	return active === null ? null : { active };
}

function parseRam(value: unknown): RamMetrics | null {
	if (!isObject(value)) return null;
	const usedBytes = num(value["usedBytes"]);
	const totalBytes = num(value["totalBytes"]);
	if (usedBytes === null || totalBytes === null || totalBytes <= 0) return null;
	return { usedBytes, totalBytes, swapBytes: num(value["swapBytes"]) ?? 0, pressure: num(value["pressure"]) ?? 0 };
}

function parseDisk(value: unknown): DiskMetrics | null {
	if (!isObject(value)) return null;
	const totalBytes = num(value["totalBytes"]);
	const availableBytes = num(value["availableBytes"]);
	if (totalBytes === null || availableBytes === null || totalBytes <= 0) return null;
	return { totalBytes, availableBytes: Math.min(availableBytes, totalBytes) };
}

/** Headline value of a metric as a 0..1 load, or null when the machine does not expose it. */
export function primaryLoad(metrics: SystemMetrics, kind: MetricKind): number | null {
	switch (kind) {
		case "cpu":
			return metrics.cpu?.usage ?? null;
		case "gpu":
			return metrics.gpu?.usage ?? null;
		case "ane":
			return metrics.ane?.active ?? null;
		case "ram":
			return metrics.ram === null ? null : Math.min(1, metrics.ram.usedBytes / metrics.ram.totalBytes);
		case "disk":
			return metrics.disk === null ? null : 1 - metrics.disk.availableBytes / metrics.disk.totalBytes;
	}
}

/** Fixed-size history of the primary load per metric, for sparklines. */
export class MetricHistory {
	readonly #capacity: number;
	readonly #series = new Map<MetricKind, number[]>();

	constructor(capacity = 48) {
		this.#capacity = capacity;
	}

	push(metrics: SystemMetrics): void {
		for (const kind of METRIC_KINDS) {
			const value = primaryLoad(metrics, kind);
			if (value === null) continue;
			const series = this.#series.get(kind) ?? [];
			series.push(value);
			if (series.length > this.#capacity) series.splice(0, series.length - this.#capacity);
			this.#series.set(kind, series);
		}
	}

	series(kind: MetricKind): readonly number[] {
		return this.#series.get(kind) ?? [];
	}
}

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ratio(value: unknown): number | null {
	const n = num(value);
	return n === null ? null : Math.min(1, Math.max(0, n));
}
