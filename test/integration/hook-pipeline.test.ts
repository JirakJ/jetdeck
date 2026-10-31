/**
 * End-to-end: a real TTY-attached "agent" process runs the real `jetdeck-hook` script, which posts over the real
 * Unix socket to the real ingest server; the event is resolved against the real process table into the store.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { EventIngestor } from "../../src/application/event-ingestor.ts";
import { ProcessMonitor } from "../../src/application/process-monitor.ts";
import { SessionStore } from "../../src/domain/session-store.ts";
import { IngestServer } from "../../src/infrastructure/ingest-server.ts";
import { ProcessTable } from "../../src/infrastructure/process-table.ts";

const HOOK = resolve(import.meta.dirname, "../../hook/jetdeck-hook");
const silent = { debug: () => undefined, warn: (m: string) => console.warn(m) };

/** Runs `command` attached to a fresh pseudo-terminal, as an interactive agent would be. */
function spawnInPty(command: string): ChildProcess {
	const args = process.platform === "darwin" ? ["-q", "/dev/null", command] : ["-qec", command, "/dev/null"];
	return spawn("script", args, { stdio: ["pipe", "ignore", "inherit"], detached: true });
}

function killGroup(child: ChildProcess): void {
	if (child.pid === undefined) return;
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for condition");
		await new Promise((r) => setTimeout(r, 25));
	}
}

function getStatus(socketPath: string): Promise<{ sessions: Array<{ agent: string; state: string }> }> {
	return new Promise((resolveStatus, reject) => {
		const req = request({ socketPath, path: "/v1/status" }, (res) => {
			let body = "";
			res.on("data", (c: Buffer) => (body += c.toString()));
			res.on("end", () => resolveStatus(JSON.parse(body)));
		});
		req.on("error", reject);
		req.end();
	});
}

describe("hook → socket → store pipeline", () => {
	let dir: string;
	let socketPath: string;
	let store: SessionStore;
	let server: IngestServer;
	let ingestor: EventIngestor;
	const children: ChildProcess[] = [];

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "jetdeck-it-"));
		socketPath = join(dir, "run", "ingest.sock");
		store = new SessionStore();
		ingestor = new EventIngestor(store, new ProcessTable(0), silent);
		server = new IngestServer(socketPath, ingestor.accept, () => ({ sessions: store.list() }));
		await server.start();
	});

	after(async () => {
		for (const child of children) killGroup(child);
		await server.stop();
		await rm(dir, { recursive: true, force: true });
	});

	/** Writes an executable fake agent named after the real CLI, which fires hooks like the real one. */
	async function fakeAgent(name: string, script: string): Promise<string> {
		const path = join(dir, name);
		await writeFile(path, `#!/bin/sh\nexport JETDECK_SOCKET='${socketPath}'\n${script}\nsleep 30\n`);
		await chmod(path, 0o755);
		return path;
	}

	it("tracks a Claude Code session through tool use, permission and turn end", async () => {
		const agent = await fakeAgent(
			"claude",
			[
				`printf '%s' '{"session_id":"s-1","cwd":"/work/jetdeck","hook_event_name":"UserPromptSubmit"}' | '${HOOK}' claude UserPromptSubmit`,
				`printf '%s' '{"session_id":"s-1","cwd":"/work/jetdeck","tool_name":"Bash"}' | '${HOOK}' claude PreToolUse`,
				`printf '%s' '{"session_id":"s-1","cwd":"/work/jetdeck","tool_name":"Bash","tool_input":{"command":"rm -rf dist"}}' | '${HOOK}' claude PermissionRequest`,
			].join("\n"),
		);
		children.push(spawnInPty(agent));

		await waitFor(() => store.list("claude")[0]?.state === "awaiting");
		const session = store.list("claude")[0];
		assert.ok(session !== undefined);
		assert.equal(session.cwd, "/work/jetdeck");
		assert.equal(session.sessionId, "s-1");
		assert.equal(session.activity, "Bash: rm -rf dist");
		assert.match(session.terminal.tty ?? "", /^\/dev\//u);
		assert.equal(session.key, `claude:${session.pid}`);

		const status = await getStatus(socketPath);
		assert.deepEqual(status.sessions.map((s) => [s.agent, s.state]), [["claude", "awaiting"]]);
	});

	it("handles Copilot camelCase payloads and session end", async () => {
		const agent = await fakeAgent(
			"copilot",
			[
				`printf '%s' '{"sessionId":"c-1","cwd":"/work/api","toolName":"shell"}' | '${HOOK}' copilot preToolUse`,
				`printf '%s' '{"sessionId":"c-1","cwd":"/work/api"}' | '${HOOK}' copilot agentStop`,
			].join("\n"),
		);
		children.push(spawnInPty(agent));
		await waitFor(() => store.list("copilot")[0]?.state === "done");
		assert.equal(store.list("copilot")[0]?.cwd, "/work/api");
	});

	it("drops sessions whose process died and discovers running agents", async () => {
		const monitor = new ProcessMonitor(store, new ProcessTable(0), silent, () => ingestor.drain());
		const copilot = children[1];
		assert.ok(copilot !== undefined);
		killGroup(copilot);
		await new Promise((r) => setTimeout(r, 200));

		const codex = await fakeAgent("codex", "");
		children.push(spawnInPty(codex));
		await new Promise((r) => setTimeout(r, 300));

		await monitor.scan();
		assert.equal(store.list("copilot").length, 0);
		assert.equal(store.list("claude").length, 1);
		assert.equal(store.list("codex")[0]?.state, "idle");
	});

	it("never fails or blocks the agent when the plugin is down", async () => {
		const started = Date.now();
		const code = await new Promise<number | null>((done) => {
			const child = spawn("sh", ["-c", `printf '{}' | JETDECK_SOCKET='${join(dir, "missing.sock")}' '${HOOK}' claude Stop`]);
			child.on("exit", done);
		});
		assert.equal(code, 0);
		assert.ok(Date.now() - started < 1_000);
	});

	it("rejects malformed deliveries", async () => {
		const status = await new Promise<number>((done, reject) => {
			const req = request(
				{ socketPath, path: "/v1/events?agent=evil&event=Stop", method: "POST", headers: { "x-jetdeck-ppid": "1" } },
				(res) => {
					res.resume();
					done(res.statusCode ?? 0);
				},
			);
			req.on("error", reject);
			req.end("{}");
		});
		assert.equal(status, 400);
	});
});
