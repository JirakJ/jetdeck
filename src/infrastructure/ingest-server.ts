import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { isAgentKind, type AgentKind } from "../domain/agent.ts";

/** One hook invocation as received from `jetdeck-hook`. */
export interface HookDelivery {
	readonly agent: AgentKind;
	readonly event: string;
	/** Parent pid of the hook process; the agent process is found by walking up from it. */
	readonly ppid: number;
	readonly termProgram: string;
	readonly terminalEmulator: string;
	readonly payload: unknown;
	readonly receivedAt: number;
}

export type DeliveryHandler = (delivery: HookDelivery) => void;
export type StatusProvider = () => unknown;

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * HTTP/1.1 server on a user-private Unix socket. Hooks get `204` as soon as the request is parsed;
 * processing happens off the agent's critical path.
 */
export class IngestServer {
	readonly #socketPath: string;
	readonly #onDelivery: DeliveryHandler;
	readonly #status: StatusProvider;
	#server: Server | null = null;

	constructor(socketPath: string, onDelivery: DeliveryHandler, status: StatusProvider) {
		this.#socketPath = socketPath;
		this.#onDelivery = onDelivery;
		this.#status = status;
	}

	async start(): Promise<void> {
		await mkdir(dirname(this.#socketPath), { recursive: true, mode: 0o700 });
		await chmod(dirname(this.#socketPath), 0o700);
		await removeStaleSocket(this.#socketPath);

		const server = createServer((req, res) => this.#handle(req, res));
		server.keepAliveTimeout = 1_000;
		server.headersTimeout = 2_000;
		server.requestTimeout = 5_000;

		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.#socketPath, () => {
				server.off("error", reject);
				resolve();
			});
		});
		await chmod(this.#socketPath, 0o600);
		this.#server = server;
	}

	async stop(): Promise<void> {
		const server = this.#server;
		this.#server = null;
		if (server === null) return;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await unlink(this.#socketPath).catch(() => undefined);
	}

	#handle(req: IncomingMessage, res: ServerResponse): void {
		const url = new URL(req.url ?? "/", "http://jetdeck");

		if (req.method === "GET" && url.pathname === "/v1/status") {
			const body = JSON.stringify(this.#status());
			res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
			res.end(body);
			return;
		}

		if (req.method !== "POST" || url.pathname !== "/v1/events") {
			reply(res, 404);
			req.resume();
			return;
		}

		const agent = url.searchParams.get("agent");
		const event = url.searchParams.get("event") ?? "";
		const ppid = Number(req.headers["x-jetdeck-ppid"]);
		if (!isAgentKind(agent) || event.length === 0 || !Number.isInteger(ppid) || ppid <= 1) {
			reply(res, 400);
			req.resume();
			return;
		}

		const chunks: Buffer[] = [];
		let size = 0;
		let rejected = false;
		req.on("data", (chunk: Buffer) => {
			if (rejected) return;
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				rejected = true;
				reply(res, 413);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (rejected) return;
			reply(res, 204);
			this.#onDelivery({
				agent,
				event,
				ppid,
				termProgram: header(req, "x-jetdeck-term"),
				terminalEmulator: header(req, "x-jetdeck-emulator"),
				payload: parseJson(Buffer.concat(chunks)),
				receivedAt: Date.now(),
			});
		});
		req.on("error", () => reply(res, 400));
	}
}

function reply(res: ServerResponse, status: number): void {
	if (res.headersSent) return;
	res.writeHead(status, { "content-length": 0 });
	res.end();
}

function header(req: IncomingMessage, name: string): string {
	const value = req.headers[name];
	return typeof value === "string" ? value : "";
}

function parseJson(body: Buffer): unknown {
	if (body.length === 0) return {};
	try {
		return JSON.parse(body.toString("utf8"));
	} catch {
		return {};
	}
}

/** Removes a leftover socket file unless another live process is still serving it. */
async function removeStaleSocket(path: string): Promise<void> {
	let isSocket = false;
	try {
		isSocket = (await lstat(path)).isSocket();
	} catch {
		return;
	}
	if (!isSocket) throw new Error(`${path} exists and is not a socket`);

	const live = await new Promise<boolean>((resolve) => {
		const probe = createConnection(path);
		probe.once("connect", () => {
			probe.destroy();
			resolve(true);
		});
		probe.once("error", () => resolve(false));
	});
	// A previous plugin instance that is still alive is being replaced by this one; Stream Deck runs one instance.
	if (live) console.warn(`jetdeck: taking over live socket ${path}`);
	await unlink(path);
}
