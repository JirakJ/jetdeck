#!/usr/bin/env node
// Prints the sessions the running JetDeck plugin currently tracks.
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const socketPath = process.env.JETDECK_SOCKET ?? join(homedir(), ".jetdeck", "ingest.sock");

const req = request({ socketPath, path: "/v1/status", method: "GET", timeout: 2_000 }, (res) => {
	let body = "";
	res.setEncoding("utf8");
	res.on("data", (chunk) => (body += chunk));
	res.on("end", () => {
		const { sessions } = JSON.parse(body);
		if (sessions.length === 0) {
			console.log("No agent sessions.");
			return;
		}
		const now = Date.now();
		for (const s of sessions) {
			const age = Math.round((now - s.stateSince) / 1000);
			console.log(
				`${s.agent.padEnd(8)} pid ${String(s.pid).padEnd(7)} ${s.state.padEnd(9)} ${String(age).padStart(5)}s  ` +
					`${s.terminal.kind.padEnd(15)} ${s.terminal.tty ?? "-"}  ${s.cwd ?? "-"}  ${s.activity ?? ""}`,
			);
		}
	});
});
req.on("timeout", () => req.destroy(new Error("timeout")));
req.on("error", (error) => {
	console.error(`JetDeck plugin is not reachable on ${socketPath}: ${error.message}`);
	process.exit(1);
});
req.end();
