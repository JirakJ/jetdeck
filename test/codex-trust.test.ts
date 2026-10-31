import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { codexTrustEntries, codexTrustHash, rewriteCodexTrust, snakeCase } from "../scripts/codex-trust.mjs";

// Reference values computed with the algorithm verified against trust entries written by Codex 0.166 `/hooks`.
const STOP_HASH = "sha256:aa9f894ef17c75f9d1ab945d7915f13e8522c53ba3325a315a4566f669efe7c5";
const LINT_HASH = "sha256:47401be2a41a7a58b1763945203c645c6d028d9d80dee511bd9c1af5e462eef0";
const HOOK = '"/Users/dev/.jetdeck/bin/jetdeck-hook" codex Stop';
const PATH = "/Users/dev/.codex/hooks.json";
const MARKER = "/.jetdeck/bin/jetdeck-hook";

describe("Codex hook trust", () => {
	it("converts event names like Codex", () => {
		assert.equal(snakeCase("UserPromptSubmit"), "user_prompt_submit");
		assert.equal(snakeCase("Stop"), "stop");
	});

	it("hashes handlers exactly like Codex /hooks", () => {
		assert.equal(codexTrustHash("Stop", {}, { type: "command", command: HOOK, timeout: 5 }), STOP_HASH);
		assert.equal(
			codexTrustHash("PostToolUse", { matcher: "Write|Edit" }, { command: "node 'lint.mjs'", statusMessage: "Linting…" }),
			LINT_HASH,
		);
		assert.notEqual(codexTrustHash("Stop", {}, { command: HOOK, timeout: 6 }), STOP_HASH);
	});

	it("keys only JetDeck handlers by their position", () => {
		const entries = codexTrustEntries(
			{ Stop: [{ hooks: [{ command: "node gate.mjs" }] }, { hooks: [{ type: "command", command: HOOK, timeout: 5 }] }] },
			PATH,
			MARKER,
		);
		assert.deepEqual([...entries], [[`${PATH}:stop:1:0`, STOP_HASH]]);
	});

	it("rewrites config.toml idempotently, keeping foreign entries and never duplicating a table", () => {
		const original = [
			'model = "gpt"',
			"",
			"[hooks.state]",
			"",
			`[hooks.state."${PATH}:stop:0:0"]`,
			'trusted_hash = "sha256:foreign"',
			"",
			`[hooks.state."${PATH}:stop:1:0"]`,
			'trusted_hash = "sha256:old-user-entry-at-reused-index"',
			"",
			'[projects."/work"]',
			'trust_level = "trusted"',
			"",
		].join("\n");
		const wanted = new Map([[`${PATH}:stop:1:0`, STOP_HASH]]);

		const once = rewriteCodexTrust(original, wanted, new Set(), PATH);
		assert.equal(once.match(/stop:1:0/gu)?.length, 1, "reused key is defined once");
		assert.match(once, /sha256:foreign/u);
		assert.match(once, /\[projects\."\/work"\]\ntrust_level = "trusted"/u);
		assert.match(once, new RegExp(`\\[hooks\\.state\\."${PATH.replaceAll("/", "\\/").replaceAll(".", "\\.")}:stop:1:0"\\]\\ntrusted_hash = "${STOP_HASH}"`, "u"));

		const twice = rewriteCodexTrust(once, wanted, new Set([STOP_HASH]), PATH);
		assert.equal(twice, once, "re-running produces the same file");

		const removed = rewriteCodexTrust(once, new Map(), new Set([STOP_HASH]), PATH);
		assert.ok(!removed.includes(STOP_HASH) && !removed.includes("JetDeck"));
		assert.match(removed, /sha256:foreign/u);
	});

	it("starts a config.toml from scratch", () => {
		const text = rewriteCodexTrust("", new Map([[`${PATH}:stop:0:0`, STOP_HASH]]), new Set(), PATH);
		assert.ok(text.startsWith("# JetDeck hooks"));
		assert.ok(text.endsWith(`trusted_hash = "${STOP_HASH}"\n`));
	});
});
