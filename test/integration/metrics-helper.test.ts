/**
 * Runs the real native helper (macOS only) through the real MetricsSampler and checks the samples are sane.
 * Build first: `npm run build` compiles com.jakubjirak.jetdeck.sdPlugin/bin/jetdeck-metrics.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import type { SystemMetrics } from "../../src/domain/system-metrics.ts";
import { MetricsSampler } from "../../src/infrastructure/metrics-sampler.ts";

const HELPER = resolve(import.meta.dirname, "../../com.jakubjirak.jetdeck.sdPlugin/bin/jetdeck-metrics");
const quiet = { info: () => undefined, warn: (m: string) => console.warn(m) };

describe("jetdeck-metrics helper", { skip: process.platform !== "darwin" || !existsSync(HELPER) }, () => {
	it("streams sane samples only while acquired", async () => {
		const sampler = new MetricsSampler(HELPER, quiet, 250);
		const samples: SystemMetrics[] = [];
		sampler.subscribe((m) => samples.push(m));
		sampler.acquire();
		const deadline = Date.now() + 5_000;
		while (samples.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
		sampler.release();
		assert.ok(samples.length >= 3, `expected 3 samples, got ${samples.length}`);

		const m = samples.at(-1)!;
		assert.ok(Math.abs(m.at - Date.now()) < 5_000);
		assert.ok(m.ram !== null && m.ram.usedBytes > 0 && m.ram.usedBytes <= m.ram.totalBytes);
		assert.ok(m.disk !== null && m.disk.availableBytes > 0 && m.disk.availableBytes < m.disk.totalBytes);
		if (process.arch === "arm64") {
			assert.ok(m.cpu !== null && m.cpu.pCores > 0 && m.cpu.eCores > 0);
			assert.ok(m.gpu !== null && m.gpu.usage !== null);
			assert.ok(m.ane !== null);
		}

		const count = samples.length;
		await new Promise((r) => setTimeout(r, 700));
		assert.equal(samples.length, count, "helper stops after the last release");
	});

	it("reports nothing and does not throw when the helper is missing", async () => {
		const sampler = new MetricsSampler("/nonexistent/jetdeck-metrics", quiet);
		sampler.acquire();
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(sampler.latest, null);
		sampler.dispose();
	});
});
