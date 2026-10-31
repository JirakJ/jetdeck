import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MetricHistory, parseMetricsLine, primaryLoad, type SystemMetrics } from "../src/domain/system-metrics.ts";
import { capacity, renderMetricKey, sparkline } from "../src/presentation/metric-renderer.ts";

// A real line captured from jetdeck-metrics on an M4 Max.
const LINE =
	'{"at":1793477771036,"cpu":{"usage":0.1578,"p":0.1272,"e":0.2344,"pCores":10,"eCores":4},' +
	'"gpu":{"usage":0.3300,"watts":0.908,"memoryBytes":2275639296},"ane":{"active":0.5314},' +
	'"ram":{"usedBytes":27785887744,"totalBytes":38654705664,"swapBytes":955711488,"pressure":1},' +
	'"disk":{"totalBytes":994662584320,"availableBytes":155268284405}}';

describe("parseMetricsLine", () => {
	it("parses a full sample", () => {
		const m = parseMetricsLine(LINE);
		assert.ok(m !== null);
		assert.equal(m.at, 1793477771036);
		assert.deepEqual(m.cpu, { usage: 0.1578, p: 0.1272, e: 0.2344, pCores: 10, eCores: 4 });
		assert.deepEqual(m.gpu, { usage: 0.33, watts: 0.908, memoryBytes: 2275639296 });
		assert.deepEqual(m.ane, { active: 0.5314 });
		assert.equal(m.ram?.pressure, 1);
		assert.equal(m.disk?.availableBytes, 155268284405);
	});

	it("keeps unavailable metrics as null and rejects garbage", () => {
		const m = parseMetricsLine('{"at":1,"cpu":null,"gpu":{"usage":null,"watts":1.5,"memoryBytes":null},"ane":null,"ram":null,"disk":null}');
		assert.deepEqual(m, { at: 1, cpu: null, gpu: { usage: null, watts: 1.5, memoryBytes: null }, ane: null, ram: null, disk: null });
		assert.equal(parseMetricsLine("not json"), null);
		assert.equal(parseMetricsLine('{"cpu":{}}'), null);
		assert.equal(parseMetricsLine("[]"), null);
	});

	it("clamps ratios and caps available disk at the total", () => {
		const m = parseMetricsLine('{"at":1,"ane":{"active":1.7},"disk":{"totalBytes":100,"availableBytes":250}}');
		assert.equal(m?.ane?.active, 1);
		assert.equal(m?.disk?.availableBytes, 100);
	});
});

describe("primaryLoad and MetricHistory", () => {
	const m = parseMetricsLine(LINE) as SystemMetrics;

	it("derives the headline load per metric", () => {
		assert.equal(primaryLoad(m, "cpu"), 0.1578);
		assert.equal(primaryLoad(m, "gpu"), 0.33);
		assert.equal(primaryLoad(m, "ane"), 0.5314);
		assert.ok(Math.abs((primaryLoad(m, "ram") ?? 0) - 27785887744 / 38654705664) < 1e-12);
		assert.ok(Math.abs((primaryLoad(m, "disk") ?? 0) - (1 - 155268284405 / 994662584320)) < 1e-12);
		assert.equal(primaryLoad({ ...m, ane: null }, "ane"), null);
	});

	it("keeps a bounded series per metric", () => {
		const history = new MetricHistory(3);
		for (let i = 0; i < 5; i++) history.push({ ...m, cpu: { ...m.cpu!, usage: i / 10 } });
		assert.deepEqual(history.series("cpu"), [0.2, 0.3, 0.4]);
		assert.equal(history.series("ane").length, 3);
		history.push({ ...m, ane: null });
		assert.equal(history.series("ane").length, 3);
	});
});

describe("metric renderer", () => {
	const m = parseMetricsLine(LINE) as SystemMetrics;

	it("renders headline and detail per metric", () => {
		assert.match(renderMetricKey("cpu", m, [0.1, 0.2]), /16%.*P 13 · E 23/su);
		assert.match(renderMetricKey("cpu", m, []), /10P\+4E/u);
		assert.match(renderMetricKey("gpu", m, []), /33%.*0\.9 W · 2\.1 GB/su);
		assert.match(renderMetricKey("ane", m, []), /53%.*active/su);
		assert.match(renderMetricKey("ane", { ...m, ane: { active: 0 } }, []), /idle/u);
		assert.match(renderMetricKey("ram", m, []), /72%.*25\.9\/36 GB \+0\.9s/su);
		assert.match(renderMetricKey("disk", m, []), /84%.*155 GB free/su);
	});

	it("colours by load, and RAM by memory pressure", () => {
		const hot = { ...m, cpu: { ...m.cpu!, usage: 0.95 } };
		assert.match(renderMetricKey("cpu", hot, []), /#ff7b72/u);
		assert.match(renderMetricKey("ram", m, []), /#3fb950/u);
		assert.match(renderMetricKey("ram", { ...m, ram: { ...m.ram!, pressure: 4 } }, []), /#ff7b72/u);
	});

	it("shows placeholders before the first sample and for missing metrics", () => {
		assert.match(renderMetricKey("gpu", null, []), /…/u);
		assert.match(renderMetricKey("ane", { ...m, ane: null }, []), /n\/a/u);
	});

	it("draws sparklines on a fixed 0..1 scale", () => {
		assert.ok(!sparkline([0.5], "#fff").includes("polyline"));
		const line = sparkline([0, 1], "#fff");
		assert.match(line, /points="10\.0,136\.0 134\.0,98\.0"/u);
	});

	it("formats capacities in decimal units like Finder", () => {
		assert.equal(capacity(155_268_284_405), "155 GB");
		assert.equal(capacity(2_500_000_000_000), "2.5 TB");
		assert.equal(capacity(512_000_000), "512 MB");
	});
});
