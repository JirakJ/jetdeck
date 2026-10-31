import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeHook } from "../src/domain/event-normalizer.ts";

describe("normalizeHook", () => {
	it("maps Claude Code tool and permission events", () => {
		assert.deepEqual(normalizeHook("claude", "PreToolUse", { tool_name: "Bash", session_id: "s", cwd: "/w/p" }), {
			fields: { sessionId: "s", cwd: "/w/p" },
			signal: { type: "tool-start", tool: "Bash" },
		});
		assert.deepEqual(
			normalizeHook("claude", "PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm -rf build" } })
				.signal,
			{ type: "permission", detail: "Bash: rm -rf build" },
		);
		assert.deepEqual(normalizeHook("claude", "PostToolUseFailure", { tool_name: "Edit" }).signal, {
			type: "tool-end",
			tool: "Edit",
			failed: true,
		});
	});

	it("classifies typed Claude notifications", () => {
		const signal = (type: string) => normalizeHook("claude", "Notification", { notification_type: type, message: "m" }).signal;
		assert.equal(signal("permission_prompt").type, "permission");
		assert.equal(signal("idle_prompt").type, "turn-end");
		assert.equal(signal("agent_needs_input").type, "needs-input");
		assert.equal(signal("elicitation_complete").type, "resumed");
		assert.deepEqual(signal("auth_success"), { type: "note", message: "m" });
	});

	it("classifies untyped notifications by wording", () => {
		assert.equal(
			normalizeHook("claude", "Notification", { message: "Claude needs your permission to use Bash" }).signal.type,
			"permission",
		);
		assert.equal(
			normalizeHook("claude", "Notification", { message: "Claude is waiting for your input" }).signal.type,
			"turn-end",
		);
		assert.equal(
			normalizeHook("copilot", "notification", { message: "Waiting for your input" }).signal.type,
			"needs-input",
		);
	});

	it("reads Copilot camelCase payloads using the event name from the command line", () => {
		const hook = normalizeHook("copilot", "preToolUse", { sessionId: "c1", cwd: "/r", toolName: "shell" });
		assert.deepEqual(hook, { fields: { sessionId: "c1", cwd: "/r" }, signal: { type: "tool-start", tool: "shell" } });
		assert.equal(normalizeHook("copilot", "userPromptSubmitted", {}).signal.type, "prompt");
		assert.equal(normalizeHook("copilot", "agentStop", {}).signal.type, "turn-end");
		assert.deepEqual(normalizeHook("copilot", "errorOccurred", { error: { message: "rate limited" } }).signal, {
			type: "error",
			message: "rate limited",
		});
	});

	it("maps Codex lifecycle events", () => {
		assert.equal(normalizeHook("codex", "UserPromptSubmit", { prompt: "x" }).signal.type, "prompt");
		assert.equal(normalizeHook("codex", "Interrupt", {}).signal.type, "interrupt");
		assert.deepEqual(
			normalizeHook("codex", "PermissionRequest", { tool_name: "Bash", tool_input: { description: "network" } }).signal,
			{ type: "permission", detail: "Bash: network" },
		);
		assert.equal(normalizeHook("codex", "SessionEnd", {}).signal.type, "session-end");
	});

	it("tolerates garbage payloads and unknown events", () => {
		assert.deepEqual(normalizeHook("claude", "PreCompact", "nope"), {
			fields: { sessionId: null, cwd: null },
			signal: { type: "note", message: null },
		});
		assert.deepEqual(normalizeHook("claude", "PreToolUse", null).signal, { type: "tool-start", tool: null });
	});

	it("truncates long details to one line", () => {
		const long = `line one\n${"x".repeat(200)}`;
		const signal = normalizeHook("claude", "Notification", { notification_type: "permission_prompt", message: long }).signal;
		assert.equal(signal.type, "permission");
		if (signal.type === "permission") {
			assert.ok(signal.detail !== null && signal.detail.length === 80 && !signal.detail.includes("\n"));
			assert.ok(signal.detail.endsWith("…"));
		}
	});
});
