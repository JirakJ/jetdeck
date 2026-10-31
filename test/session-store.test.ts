import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TerminalRef } from "../src/domain/agent.ts";
import type { AgentEvent, AgentSignal } from "../src/domain/agent-event.ts";
import { SessionStore } from "../src/domain/session-store.ts";
import { SlotAllocator } from "../src/domain/slot-allocator.ts";
import { selectAttentionTarget, selectPromptTarget } from "../src/domain/target-selector.ts";

const TERM: TerminalRef = { kind: "ghostty", tty: "/dev/ttys001", appBundle: "/Applications/Ghostty.app" };

function event(signal: AgentSignal, at: number, overrides: Partial<AgentEvent> = {}): AgentEvent {
	return {
		agent: "claude",
		pid: 100,
		startedAt: 0,
		terminal: TERM,
		sessionId: "s1",
		cwd: "/work/jetdeck",
		signal,
		at,
		...overrides,
	};
}

describe("SessionStore", () => {
	it("walks a full Claude turn with a permission prompt", () => {
		const store = new SessionStore();
		store.apply(event({ type: "session-start" }, 1));
		assert.equal(store.get("claude:100")?.state, "idle");

		store.apply(event({ type: "prompt" }, 10));
		store.apply(event({ type: "tool-start", tool: "Bash" }, 12));
		let s = store.get("claude:100");
		assert.equal(s?.state, "working");
		assert.equal(s?.turnStartedAt, 10);
		assert.equal(s?.activity, "Bash");

		store.apply(event({ type: "permission", detail: "Bash: rm -rf dist" }, 13));
		s = store.get("claude:100");
		assert.equal(s?.state, "awaiting");
		assert.equal(s?.stateSince, 13);
		assert.deepEqual(store.awaiting().map((x) => x.key), ["claude:100"]);

		store.apply(event({ type: "tool-end", tool: "Bash", failed: false }, 20));
		s = store.get("claude:100");
		assert.equal(s?.state, "working");
		assert.equal(s?.turnStartedAt, 10, "turn timer survives the permission prompt");

		store.apply(event({ type: "turn-end" }, 30));
		assert.equal(store.get("claude:100")?.state, "done");
		// The idle reminder arrives later and must not reset the finish time.
		store.apply(event({ type: "turn-end" }, 90));
		assert.equal(store.get("claude:100")?.stateSince, 30);

		store.apply(event({ type: "session-end" }, 100));
		assert.equal(store.get("claude:100"), undefined);
	});

	it("records errors and interrupts", () => {
		const store = new SessionStore();
		store.apply(event({ type: "prompt" }, 1));
		store.apply(event({ type: "error", message: "rate_limit" }, 2));
		assert.equal(store.get("claude:100")?.state, "error");
		assert.equal(store.get("claude:100")?.activity, "rate_limit");
		store.apply(event({ type: "prompt" }, 3));
		store.apply(event({ type: "interrupt" }, 4));
		assert.equal(store.get("claude:100")?.state, "idle");
		assert.equal(store.get("claude:100")?.activity, "interrupted");
	});

	it("notifies subscribers on change", () => {
		const store = new SessionStore();
		let calls = 0;
		const unsubscribe = store.subscribe(() => calls++);
		store.apply(event({ type: "prompt" }, 1));
		store.apply(event({ type: "session-end" }, 2));
		store.apply(event({ type: "session-end" }, 3));
		unsubscribe();
		store.apply(event({ type: "prompt" }, 4));
		assert.equal(calls, 2);
	});

	it("reconciles with the process table without dropping sessions that raced the scan", () => {
		const store = new SessionStore();
		store.apply(event({ type: "prompt" }, 1_000, { pid: 1, startedAt: 500 }));
		store.apply(event({ type: "prompt" }, 5_000, { pid: 2, startedAt: 4_000 }));

		store.reconcile(
			[{ agent: "codex", pid: 3, startedAt: 100, terminal: TERM, cwd: "/work/other" }],
			3_000,
			6_000,
		);

		assert.equal(store.get("claude:1"), undefined, "process 1 existed at scan time and is gone");
		assert.equal(store.get("claude:2")?.state, "working", "process 2 started after the scan read the table");
		assert.equal(store.get("codex:3")?.state, "idle");
		assert.equal(store.get("codex:3")?.cwd, "/work/other");
	});

	it("keeps sessions ordered and filtered", () => {
		const store = new SessionStore();
		store.apply(event({ type: "prompt" }, 1, { pid: 7, startedAt: 30 }));
		store.apply(event({ type: "prompt" }, 1, { pid: 8, startedAt: 10, agent: "codex" }));
		store.apply(event({ type: "prompt" }, 1, { pid: 9, startedAt: 20 }));
		assert.deepEqual(store.list().map((s) => s.pid), [8, 9, 7]);
		assert.deepEqual(store.list("claude").map((s) => s.pid), [9, 7]);
	});
});

describe("SlotAllocator", () => {
	it("keeps sessions on their slot and refills the lowest gap", () => {
		const store = new SessionStore();
		const slots = new SlotAllocator();
		for (const pid of [1, 2, 3]) store.apply(event({ type: "prompt" }, pid, { pid, startedAt: pid }));
		slots.sync("claude", store.list("claude"));
		assert.deepEqual([1, 2, 3].map((n) => slots.keyAt("claude", n)), ["claude:1", "claude:2", "claude:3"]);

		store.apply(event({ type: "session-end" }, 10, { pid: 2 }));
		slots.sync("claude", store.list("claude"));
		assert.deepEqual([1, 2, 3].map((n) => slots.keyAt("claude", n)), ["claude:1", null, "claude:3"]);

		store.apply(event({ type: "prompt" }, 11, { pid: 4, startedAt: 11 }));
		slots.sync("claude", store.list("claude"));
		assert.equal(slots.keyAt("claude", 2), "claude:4");
		assert.equal(slots.keyAt("claude", 3), "claude:3");
		assert.equal(slots.keyAt("codex", 1), null);
	});
});

describe("target selection", () => {
	it("prefers sessions ready for input, most recent first", () => {
		const store = new SessionStore();
		store.apply(event({ type: "prompt" }, 50, { pid: 1 }));
		store.apply(event({ type: "turn-end" }, 10, { pid: 2 }));
		store.apply(event({ type: "turn-end" }, 20, { pid: 3 }));
		assert.equal(selectPromptTarget(store, "claude")?.pid, 3);
		store.apply(event({ type: "permission", detail: null }, 60, { pid: 1 }));
		assert.equal(selectPromptTarget(store, "any")?.pid, 1);
		assert.equal(selectPromptTarget(store, "codex"), null);
	});

	it("jumps to the longest-waiting session, else the latest finished one", () => {
		const store = new SessionStore();
		store.apply(event({ type: "turn-end" }, 5, { pid: 1 }));
		store.apply(event({ type: "turn-end" }, 9, { pid: 2 }));
		assert.equal(selectAttentionTarget(store)?.pid, 2);
		store.apply(event({ type: "permission", detail: null }, 20, { pid: 3 }));
		store.apply(event({ type: "permission", detail: null }, 15, { pid: 4 }));
		assert.equal(selectAttentionTarget(store)?.pid, 4);
		assert.equal(selectPromptTarget(store, "attention")?.pid, 4);
	});
});
