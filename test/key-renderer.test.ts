import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Session } from "../src/domain/agent.ts";
import {
	duration,
	renderAttentionKey,
	renderEmptySlot,
	renderPromptKey,
	renderSessionKey,
	toDataUrl,
	wrap,
} from "../src/presentation/key-renderer.ts";

const SESSION: Session = {
	key: "claude:1",
	agent: "claude",
	pid: 1,
	startedAt: 0,
	sessionId: "s",
	cwd: "/work/<evil>&\"project\"",
	terminal: { kind: "ghostty", tty: "/dev/ttys001", appBundle: null },
	state: "working",
	stateSince: 0,
	turnStartedAt: 0,
	activity: "Bash",
	lastEventAt: 0,
};

describe("key renderer", () => {
	it("formats compact durations", () => {
		assert.equal(duration(-5), "0s");
		assert.equal(duration(42_400), "42s");
		assert.equal(duration(187_000), "3:07");
		assert.equal(duration(4_320_000), "1h12");
		assert.equal(duration(3 * 86_400_000), "3d");
	});

	it("wraps labels into at most N lines", () => {
		assert.deepEqual(wrap("Review the staged diff", 11, 3), ["Review the", "staged diff"]);
		assert.deepEqual(wrap("one two three four five six seven", 7, 2), ["one two", "three…"]);
		assert.deepEqual(wrap("Supercalifragilistic", 11, 3), ["Supercalif…"]);
	});

	it("renders well-formed, escaped SVG for every state", () => {
		for (const state of ["idle", "working", "awaiting", "done", "error"] as const) {
			const svg = renderSessionKey({ ...SESSION, state }, 2, 65_000, true);
			assert.match(svg, /^<svg [^>]+>.*<\/svg>$/su);
			assert.ok(!svg.includes("<evil>"));
			assert.ok(svg.includes("&lt;evil&gt;"));
		}
		assert.match(renderSessionKey(SESSION, 1, 65_000, false), /WORKING 1:05/u);
		assert.match(renderSessionKey({ ...SESSION, state: "awaiting", stateSince: 60_000 }, 1, 65_000, false), /WAITING 5s/u);
	});

	it("pulses waiting sessions and the attention key", () => {
		const waiting = { ...SESSION, state: "awaiting" as const };
		assert.notEqual(renderSessionKey(waiting, 1, 0, true), renderSessionKey(waiting, 1, 0, false));
		assert.equal(renderSessionKey(SESSION, 1, 0, true), renderSessionKey(SESSION, 1, 0, false));
		assert.match(renderAttentionKey([waiting, waiting], 0, false, 0), />2</u);
		assert.match(renderAttentionKey([], 3, false, 0), /working/u);
		assert.match(renderAttentionKey([], 0, false, 0), /all clear/u);
	});

	it("marks the last key with the number of sessions that have no key", () => {
		const svg = renderSessionKey(SESSION, 17, 0, false, 3);
		assert.match(svg, />\+3</u);
		assert.ok(!svg.includes(">17<"));
		assert.match(renderSessionKey(SESSION, 17, 0, false), />17</u);
	});

	it("renders empty slots, prompt keys and data URLs", () => {
		assert.match(renderEmptySlot("codex", 4), /CODEX/u);
		assert.match(renderPromptKey("Review", "attention", "ok"), /→ WAITING/u);
		assert.ok(toDataUrl("<svg/>").startsWith("data:image/svg+xml;charset=utf8,%3Csvg%2F%3E"));
	});
});
