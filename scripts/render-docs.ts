// Renders the README images with the plugin's own key renderers (no screenshots of fake UIs).
//   node scripts/render-docs.ts          -> docs/images/*.png   (needs Playwright's Chromium)
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentKind, Session, SessionState } from "../src/domain/agent.ts";
import { parseMetricsLine, type MetricKind } from "../src/domain/system-metrics.ts";
import {
	renderAttentionKey,
	renderEmptySlot,
	renderPromptKey,
	renderSessionKey,
} from "../src/presentation/key-renderer.ts";
import { renderMetricKey } from "../src/presentation/metric-renderer.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, "docs", "images");
const NOW = Date.UTC(2026, 9, 31, 20, 0, 0);

function session(
	agent: AgentKind,
	pid: number,
	project: string,
	state: SessionState,
	sinceSeconds: number,
	activity: string | null,
	turnSeconds = sinceSeconds,
): Session {
	return {
		key: `${agent}:${pid}`,
		agent,
		pid,
		startedAt: NOW - 3_600_000,
		sessionId: null,
		cwd: `/Users/dev/work/${project}`,
		terminal: { kind: "ghostty", tty: "/dev/ttys001", appBundle: null },
		state,
		stateSince: NOW - sinceSeconds * 1_000,
		turnStartedAt: state === "working" ? NOW - turnSeconds * 1_000 : null,
		activity,
		lastEventAt: NOW,
	};
}

const waiting = session("claude", 2, "web-app", "awaiting", 42, "Bash: npm publish");

/** Twelve terminals across three agents, in start order — exactly how the shared session keys fill up. */
const RUNNING: readonly Session[] = [
	session("claude", 1, "api-gateway", "working", 15, "Bash", 187),
	waiting,
	session("codex", 3, "billing", "working", 4, "apply_patch", 72),
	session("claude", 4, "infra", "done", 312, null),
	session("copilot", 5, "cli-tools", "done", 48, null),
	session("claude", 6, "search", "working", 2, "Grep", 41),
	session("codex", 7, "mobile", "error", 95, "rate_limit"),
	session("claude", 8, "auth", "idle", 0, null),
	session("claude", 9, "payments", "working", 9, "Edit", 433),
	session("copilot", 10, "docs-site", "working", 6, "shell", 25),
	session("claude", 11, "ml-pipeline", "awaiting", 7, "WebFetch"),
	session("codex", 12, "design-sys", "done", 640, null),
];

function sessionKey(slot: number): string {
	const s = RUNNING[slot - 1];
	return s === undefined ? renderEmptySlot("any", slot) : renderSessionKey(s, slot, NOW, false);
}

const METRICS = parseMetricsLine(
	JSON.stringify({
		at: NOW,
		cpu: { usage: 0.38, p: 0.46, e: 0.19, pCores: 10, eCores: 4 },
		gpu: { usage: 0.57, watts: 6.8, memoryBytes: 4.2 * 1024 ** 3 },
		ane: { active: 0.64 },
		ram: { usedBytes: 25.9 * 1024 ** 3, totalBytes: 36 * 1024 ** 3, swapBytes: 0, pressure: 1 },
		disk: { totalBytes: 994_662_584_320, availableBytes: 412_000_000_000 },
		power: { cpuW: 9.4, gpuW: 6.8, aneW: 1.9, packageW: 19.6, thermal: "Nominal" },
	}),
)!;

function wave(base: number, amplitude: number, phase: number, n = 48): number[] {
	return Array.from({ length: n }, (_, i) =>
		Math.max(0, base + amplitude * Math.sin(i / 4 + phase) + (amplitude / 2) * Math.sin(i / 1.7 + phase * 2)),
	);
}

const HISTORY: Readonly<Record<MetricKind, number[]>> = {
	cpu: wave(0.32, 0.12, 0.3),
	gpu: wave(0.5, 0.15, 1.1),
	ane: wave(0.45, 0.25, 2.0).map((v, i) => (i < 18 ? 0 : v)),
	ram: wave(0.71, 0.01, 0.2),
	disk: [],
	power: wave(17, 4, 0.7),
};

const PROMPTS = ["Review", "Run tests", "Commit", "Fix error", "Simplify", "Plan first", "Status", "Continue"];

function deckKeys(): string[] {
	const keys: string[] = [];
	const awaiting = RUNNING.filter((s) => s.state === "awaiting").sort((a, b) => a.stateSince - b.stateSince);
	keys.push(renderAttentionKey(awaiting, 4, false, NOW));
	for (let slot = 1; slot <= 15; slot++) keys.push(sessionKey(slot));
	for (const label of PROMPTS) keys.push(renderPromptKey(label, "any", null));
	for (const kind of ["cpu", "gpu", "ane", "ram", "disk", "power"] as const) {
		keys.push(renderMetricKey(kind, METRICS, HISTORY[kind]));
	}
	keys.push(sessionKey(16), sessionKey(17));
	return keys;
}

function page(keys: readonly string[], columns: number, bezel: boolean): string {
	const cells = keys.map((svg) => `<div class="key">${svg}</div>`).join("");
	return `<!doctype html><html><head><meta charset="utf-8"><style>
		html,body{margin:0;background:transparent}
		text{font-family:Inter,"Inter Display",sans-serif !important}
		.wrap{display:inline-block;padding:${bezel ? 34 : 0}px;${bezel ? "background:linear-gradient(160deg,#2b2f36,#16181c);border-radius:36px;box-shadow:inset 0 1px 0 #3a3f47,0 18px 40px rgba(0,0,0,.35)" : ""}}
		.grid{display:grid;grid-template-columns:repeat(${columns},120px);gap:${bezel ? 22 : 16}px}
		.key{width:120px;height:120px;border-radius:18px;overflow:hidden;box-shadow:0 0 0 2px #050608,0 3px 0 2px #050608}
		.key svg{width:120px;height:120px;display:block}
	</style></head><body><div class="wrap"><div class="grid">${cells}</div></div></body></html>`;
}

// Playwright is a dev tool, not a dependency: resolved from the environment (global install or NODE_PATH).
type Chromium = { launch(): Promise<{ newContext(o: object): Promise<{ newPage(): Promise<Tab> }>; close(): Promise<void> }> };
type Tab = {
	setContent(html: string): Promise<void>;
	locator(selector: string): { screenshot(o: { path: string; omitBackground: boolean }): Promise<unknown> };
};
const { chromium } = createRequire(import.meta.url)("playwright") as { chromium: Chromium };
const browser = await chromium.launch();
const context = await browser.newContext({ deviceScaleFactor: 2 });
const tab = await context.newPage();

async function shoot(name: string, html: string): Promise<void> {
	await tab.setContent(html);
	await tab.locator(".wrap").screenshot({ path: join(OUT, name), omitBackground: true });
	console.log(`docs/images/${name}`);
}

await mkdir(OUT, { recursive: true });
await shoot("deck.png", page(deckKeys(), 8, true));
await shoot(
	"agent-states.png",
	page(
		[
			renderSessionKey(RUNNING[0]!, 1, NOW, false),
			renderSessionKey(waiting, 2, NOW, false),
			renderSessionKey(RUNNING[3]!, 4, NOW, false),
			renderSessionKey(RUNNING[6]!, 7, NOW, false),
			renderSessionKey(RUNNING[7]!, 8, NOW, false),
			renderSessionKey(RUNNING[8]!, 17, NOW, false, 3),
			renderAttentionKey([waiting], 2, false, NOW),
		],
		7,
		false,
	),
);
await shoot(
	"metrics.png",
	page(
		(["cpu", "gpu", "ane", "ram", "disk", "power"] as const).map((k) => renderMetricKey(k, METRICS, HISTORY[k])),
		6,
		false,
	),
);
await browser.close();
