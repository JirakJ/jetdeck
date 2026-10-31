import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentOf, findAgent, parseEtime, parsePs, terminalFromEnv } from "../src/infrastructure/process-table.ts";

const NOW = 1_000_000_000;

const PS = `
    1     0 ??        10-02:03:04 /sbin/launchd
  500     1 ??          01:00:00 /Applications/Ghostty.app/Contents/MacOS/ghostty
  510   500 ttys001     59:00 /usr/bin/login -flp jirakj /bin/zsh -fc exec -l /bin/zsh
  511   510 ttys001     58:59 -zsh
  520   511 ttys001     10:00 /opt/homebrew/bin/node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js
  521   520 ttys001     09:59 /opt/homebrew/lib/node_modules/@openai/codex/vendor/codex/codex --model gpt
  530   521 ttys001        00 /bin/sh -c "/Users/j/.jetdeck/bin/jetdeck-hook" codex Stop
  600     1 ??          02:00:00 /Users/j/Applications/IntelliJ IDEA.app/Contents/MacOS/idea
  610   600 ttys004     30:00 /bin/zsh -i
  620   610 ttys004     29:00 claude --resume
  621   620 ttys004        01 /bin/sh -c /Users/j/.jetdeck/bin/jetdeck-hook claude PreToolUse
  700     1 ??          05:00 /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex
  800   511 ttys001     00:10 grep claude
`;

describe("parsePs", () => {
	const table = parsePs(PS, NOW);

	it("parses pid, ppid, tty, start time and args with spaces", () => {
		assert.equal(table.size, 13);
		assert.deepEqual(table.get(600), {
			pid: 600,
			ppid: 1,
			tty: null,
			startedAt: NOW - 7_200_000,
			args: "/Users/j/Applications/IntelliJ IDEA.app/Contents/MacOS/idea",
		});
		assert.equal(table.get(620)?.tty, "/dev/ttys004");
	});

	it("resolves the outermost agent process and its terminal from a hook's parent", () => {
		assert.deepEqual(findAgent(table, 530, "codex", "unknown"), {
			agent: "codex",
			pid: 520,
			startedAt: NOW - 600_000,
			terminal: { kind: "ghostty", tty: "/dev/ttys001", appBundle: "/Applications/Ghostty.app" },
		});
		assert.deepEqual(findAgent(table, 621, "claude", "unknown")?.terminal, {
			kind: "jetbrains",
			tty: "/dev/ttys004",
			appBundle: "/Users/j/Applications/IntelliJ IDEA.app",
		});
	});

	it("ignores agents without a terminal and processes that only mention an agent", () => {
		assert.equal(findAgent(table, 700, "codex", "unknown"), null);
		assert.equal(findAgent(table, 800, "claude", "unknown"), null);
		assert.equal(findAgent(table, 999_999, "claude", "unknown"), null);
	});
});

describe("process helpers", () => {
	it("detects agents by executable, not by arguments", () => {
		assert.equal(agentOf("claude"), "claude");
		assert.equal(agentOf("/Users/j/.local/bin/claude --continue"), "claude");
		assert.equal(agentOf("node /usr/lib/node_modules/@github/copilot/index.js"), "copilot");
		assert.equal(agentOf("/opt/homebrew/bin/copilot"), "copilot");
		assert.equal(agentOf("grep claude"), null);
		assert.equal(agentOf("npm exec @claude-flow/cli@latest"), null);
		assert.equal(agentOf("/Users/j/.claude/hooks/x.mjs"), null);
		assert.equal(agentOf("script -qec /tmp/x/claude /dev/null"), null);
		assert.equal(agentOf("/bin/sh /tmp/x/claude"), "claude");
		assert.equal(agentOf("/bin/sh -c claude"), null);
		assert.equal(agentOf("node --enable-source-maps /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js"), "codex");
	});

	it("parses ps elapsed times", () => {
		assert.equal(parseEtime("05"), 5);
		assert.equal(parseEtime("-"), null);
		assert.equal(parseEtime("00:05"), 5);
		assert.equal(parseEtime("12:34"), 754);
		assert.equal(parseEtime("01:00:00"), 3_600);
		assert.equal(parseEtime("2-03:04:05"), 183_845);
	});

	it("maps terminal environment hints", () => {
		assert.equal(terminalFromEnv("ghostty", ""), "ghostty");
		assert.equal(terminalFromEnv("Apple_Terminal", ""), "apple-terminal");
		assert.equal(terminalFromEnv("", "JetBrains-JediTerm"), "jetbrains");
		assert.equal(terminalFromEnv("tmux", ""), "unknown");
	});
});
