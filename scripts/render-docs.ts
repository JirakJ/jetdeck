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
const SESSIONS: ReadonlyArray<readonly [AgentKind, number, Session | null]> = [
	["claude", 1, session("claude", 1, "api-gateway", "working", 15, "Bash", 187)],
	["claude", 2, waiting],
	["claude", 3, session("claude", 3, "infra", "done", 312, null)],
	["claude", 4, session("claude", 4, "docs", "idle", 0, null)],
	["claude", 5, null],
	["claude", 6, null],
	["claude", 7, null],
	["codex", 1, session("codex", 5, "billing", "working", 4, "apply_patch", 72)],
	["codex", 2, session("codex", 6, "mobile", "error", 95, "rate_limit")],
	["codex", 3, null],
	["codex", 4, null],
	["copilot", 1, session("copilot", 7, "cli-tools", "done", 48, null)],
	["copilot", 2, null],
	["copilot", 3, null],
	["copilot", 4, null],
];

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
	keys.push(renderAttentionKey([waiting], 2, false, NOW));
	for (const [agent, slot, s] of SESSIONS) {
		keys.push(s === null ? renderEmptySlot(agent, slot) : renderSessionKey(s, slot, NOW, false));
	}
	for (const label of PROMPTS) keys.push(renderPromptKey(label, "any", null));
	for (const kind of ["cpu", "gpu", "ane", "ram", "disk", "power"] as const) {
		keys.push(renderMetricKey(kind, METRICS, HISTORY[kind]));
	}
	keys.push(renderEmptySlot("any", 8), renderEmptySlot("any", 9));
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
			renderSessionKey(session("claude", 1, "api-gateway", "working", 15, "Bash", 187), 1, NOW, false),
			renderSessionKey(waiting, 2, NOW, false),
			renderSessionKey(session("claude", 3, "infra", "done", 312, null), 3, NOW, false),
			renderSessionKey(session("codex", 6, "mobile", "error", 95, "rate_limit"), 2, NOW, false),
			renderSessionKey(session("claude", 4, "docs", "idle", 0, null), 4, NOW, false),
			renderAttentionKey([waiting], 2, false, NOW),
		],
		6,
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
