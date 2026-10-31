import { homedir } from "node:os";
import { join } from "node:path";
import streamDeck from "@elgato/streamdeck";
import { AttentionKeyAction } from "./actions/attention-key.ts";
import type { JetDeckContext, Refreshable } from "./actions/context.ts";
import { PromptKeyAction } from "./actions/prompt-key.ts";
import { SessionKeyAction } from "./actions/session-key.ts";
import { EventIngestor } from "./application/event-ingestor.ts";
import { ProcessMonitor } from "./application/process-monitor.ts";
import { SessionStore } from "./domain/session-store.ts";
import { SlotAllocator } from "./domain/slot-allocator.ts";
import { IngestServer } from "./infrastructure/ingest-server.ts";
import { ProcessTable } from "./infrastructure/process-table.ts";
import { TerminalController } from "./infrastructure/terminal-controller.ts";

const SOCKET_PATH = process.env["JETDECK_SOCKET"] ?? join(homedir(), ".jetdeck", "ingest.sock");
const FRAME_MS = 250;
const PULSE_MS = 600;

const log = streamDeck.logger.createScope("jetdeck");
const store = new SessionStore();
const processes = new ProcessTable();
const ctx: JetDeckContext = {
	store,
	slots: new SlotAllocator(),
	terminals: new TerminalController(),
	log,
};

const ingestor = new EventIngestor(store, processes, log);
const monitor = new ProcessMonitor(store, processes, log, () => ingestor.drain());
const server = new IngestServer(SOCKET_PATH, ingestor.accept, () => ({
	socket: SOCKET_PATH,
	sessions: store.list("any"),
}));

const sessionKeys = new SessionKeyAction(ctx);
const attentionKeys = new AttentionKeyAction(ctx);
const promptKeys = new PromptKeyAction(ctx);
streamDeck.actions.registerAction(sessionKeys);
streamDeck.actions.registerAction(attentionKeys);
streamDeck.actions.registerAction(promptKeys);
const views: readonly Refreshable[] = [sessionKeys, attentionKeys, promptKeys];

function repaint(): void {
	const now = Date.now();
	const pulse = Math.floor(now / PULSE_MS) % 2 === 1;
	for (const view of views) view.refresh(now, pulse);
}

store.subscribe(repaint);
setInterval(repaint, FRAME_MS);

streamDeck.system.onSystemDidWakeUp(() => void monitor.scan());

await streamDeck.connect();
try {
	await server.start();
	log.info(`listening on ${SOCKET_PATH}`);
} catch (error) {
	log.error(`cannot listen on ${SOCKET_PATH}: ${String(error)}`);
}
monitor.start();

const shutdown = (): void => {
	monitor.stop();
	void server.stop().finally(() => process.exit(0));
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
