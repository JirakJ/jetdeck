import { primaryLoad, type MetricKind, type SystemMetrics } from "../domain/system-metrics.ts";
import { clip, SIZE, svg, text } from "./svg.ts";

const LABEL: Readonly<Record<MetricKind, string>> = {
	cpu: "CPU",
	gpu: "GPU",
	ane: "ANE",
	ram: "RAM",
	disk: "DISK",
	power: "POWER",
};

type Level = "ok" | "warn" | "high" | "none";

const LEVEL_COLOR: Readonly<Record<Level, string>> = {
	ok: "#3fb950",
	warn: "#f2cc60",
	high: "#ff7b72",
	none: "#6e7681",
};

const BG = "#0d1117";
const FG = "#e6edf3";
const MUTED = "#8b949e";

/** Load thresholds (warn, high) per metric. */
const THRESHOLDS: Readonly<Record<MetricKind, readonly [number, number]>> = {
	cpu: [0.6, 0.85],
	gpu: [0.6, 0.85],
	ane: [0.6, 0.85],
	ram: [0.8, 0.92],
	disk: [0.8, 0.9],
	/** Package watts. */
	power: [40, 70],
};

/** Power sparklines scale to the larger of this floor and the recent peak, so idle noise stays flat. */
const POWER_SCALE_FLOOR_W = 20;

const SPARK_TOP = 98;
const SPARK_BOTTOM = 136;

/** Renders one system-metric key: label, headline value, detail line and a sparkline (bar for disk). */
export function renderMetricKey(kind: MetricKind, metrics: SystemMetrics | null, history: readonly number[]): string {
	const load = metrics === null ? null : primaryLoad(metrics, kind);
	if (metrics === null || load === null) {
		return svg(
			BG,
			[
				text(14, 27, LABEL[kind], 15, MUTED, 800, 1, "start"),
				text(SIZE / 2, 80, metrics === null ? "…" : "n/a", 30, "#30363d", 800),
				metrics !== null && kind === "power" ? text(SIZE / 2, 108, "npm run power:enable", 11, MUTED, 600) : "",
			].join(""),
		);
	}

	const level = levelOf(kind, metrics, load);
	const color = LEVEL_COLOR[level];
	const [headline, detail] = describe(kind, metrics, load);
	const headlineSize = headline.length <= 4 ? 44 : headline.length <= 6 ? 36 : 28;

	return svg(
		BG,
		[
			text(14, 27, LABEL[kind], 15, color, 800, 1, "start"),
			corner(kind, metrics),
			text(SIZE / 2, 70, headline, headlineSize, FG, 800),
			text(SIZE / 2, 91, clip(detail, 16), 14, MUTED, 600),
			kind === "disk"
				? bar(load, color)
				: sparkline(history, color, kind === "power" ? Math.max(POWER_SCALE_FLOOR_W, ...history) : 1),
		].join(""),
	);
}

/** Small top-right annotation: CPU power or core layout, thermal pressure on the power key. */
function corner(kind: MetricKind, metrics: SystemMetrics): string {
	if (kind === "cpu") {
		const watts = metrics.power?.cpuW ?? null;
		if (watts !== null) return text(SIZE - 14, 27, formatWatts(watts), 12, MUTED, 700, 1, "end");
		if (metrics.cpu !== null) return text(SIZE - 14, 27, `${metrics.cpu.pCores}P+${metrics.cpu.eCores}E`, 12, MUTED, 700, 1, "end");
	}
	if (kind === "power" && metrics.power?.thermal) {
		const thermal = metrics.power.thermal;
		const color = thermal === "Nominal" ? MUTED : thermal === "Moderate" ? LEVEL_COLOR.warn : LEVEL_COLOR.high;
		return text(SIZE - 14, 27, thermal.toLowerCase(), 11, color, 700, 1, "end");
	}
	return "";
}

function describe(kind: MetricKind, metrics: SystemMetrics, load: number): readonly [string, string] {
	switch (kind) {
		case "cpu": {
			const cpu = metrics.cpu!;
			return [percent(load), `P ${pct(cpu.p)} · E ${pct(cpu.e)}`];
		}
		case "gpu": {
			const gpu = metrics.gpu!;
			const gpuWatts = gpu.watts ?? metrics.power?.gpuW ?? null;
			const watts = gpuWatts === null ? null : formatWatts(gpuWatts);
			const memory = gpu.memoryBytes === null ? null : `${gigabytes(gpu.memoryBytes)} GB`;
			return [percent(load), [watts, memory].filter((x) => x !== null).join(" · ")];
		}
		case "ane": {
			const watts = metrics.power?.aneW ?? null;
			return [percent(load), watts !== null ? formatWatts(watts) : load >= 0.01 ? "active" : "idle"];
		}
		case "ram": {
			const ram = metrics.ram!;
			const swap = ram.swapBytes >= 512 * 1024 ** 2 ? ` +${gigabytes(ram.swapBytes)}s` : "";
			return [percent(load), `${gigabytes(ram.usedBytes)}/${gigabytes(ram.totalBytes, 0)} GB${swap}`];
		}
		case "disk": {
			const disk = metrics.disk!;
			return [percent(load), `${capacity(disk.availableBytes)} free`];
		}
		case "power": {
			const power = metrics.power!;
			const parts = [
				power.cpuW === null ? null : `C${compactWatts(power.cpuW)}`,
				power.gpuW === null ? null : `G${compactWatts(power.gpuW)}`,
				power.aneW === null ? null : `A${compactWatts(power.aneW)}`,
			];
			return [formatWatts(load), parts.filter((x) => x !== null).join(" ")];
		}
	}
}

function levelOf(kind: MetricKind, metrics: SystemMetrics, load: number): Level {
	if (kind === "power" && metrics.power?.thermal && metrics.power.thermal !== "Nominal") {
		return metrics.power.thermal === "Moderate" ? "warn" : "high";
	}
	// macOS keeps RAM full on purpose; kernel memory pressure is the meaningful signal.
	if (kind === "ram" && metrics.ram !== null && metrics.ram.pressure > 0) {
		return metrics.ram.pressure >= 4 ? "high" : metrics.ram.pressure >= 2 ? "warn" : "ok";
	}
	const [warn, high] = THRESHOLDS[kind];
	return load >= high ? "high" : load >= warn ? "warn" : "ok";
}

/** Filled area sparkline, newest sample on the right, scaled to 0..`scale`. */
export function sparkline(values: readonly number[], color: string, scale = 1): string {
	const left = 10;
	const right = SIZE - 10;
	const height = SPARK_BOTTOM - SPARK_TOP;
	const baseline = `<line x1="${left}" y1="${SPARK_BOTTOM}" x2="${right}" y2="${SPARK_BOTTOM}" stroke="#30363d" stroke-width="2"/>`;
	if (values.length < 2) return baseline;

	const step = (right - left) / (values.length - 1);
	const points = values.map((v, i) => {
		const x = left + i * step;
		const y = SPARK_BOTTOM - Math.min(1, Math.max(0, v / scale)) * height;
		return `${x.toFixed(1)},${y.toFixed(1)}`;
	});
	const area = `${left},${SPARK_BOTTOM} ${points.join(" ")} ${right},${SPARK_BOTTOM}`;
	return (
		baseline +
		`<polygon points="${area}" fill="${color}" fill-opacity="0.22"/>` +
		`<polyline points="${points.join(" ")}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`
	);
}

function bar(load: number, color: string): string {
	const left = 12;
	const width = SIZE - 24;
	const y = 110;
	const fill = Math.max(4, Math.min(1, load) * width);
	return (
		`<rect x="${left}" y="${y}" width="${width}" height="16" rx="8" fill="#21262d"/>` +
		`<rect x="${left}" y="${y}" width="${fill.toFixed(1)}" height="16" rx="8" fill="${color}"/>`
	);
}

export function formatWatts(watts: number): string {
	return `${watts.toFixed(watts < 10 ? 1 : 0)} W`;
}

function compactWatts(watts: number): string {
	return watts.toFixed(watts < 10 ? 1 : 0);
}

function percent(load: number): string {
	return `${Math.round(load * 100)}%`;
}

function pct(load: number): string {
	return `${Math.round(load * 100)}`;
}

function gigabytes(bytes: number, digits = 1): string {
	const gb = bytes / 1024 ** 3;
	return gb >= 100 ? gb.toFixed(0) : gb.toFixed(digits);
}

/** Decimal units, matching Finder. */
export function capacity(bytes: number): string {
	if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(bytes >= 1e13 ? 0 : 1)} TB`;
	if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(0)} GB`;
	return `${(bytes / 1e6).toFixed(0)} MB`;
}
