import type { AgentKind } from "./agent.ts";
import type { AgentSignal } from "./agent-event.ts";

/** Fields every supported agent may put on a hook payload, in snake_case or camelCase. */
export interface HookFields {
	readonly sessionId: string | null;
	readonly cwd: string | null;
}

export interface NormalizedHook {
	readonly fields: HookFields;
	readonly signal: AgentSignal;
}

type Payload = Readonly<Record<string, unknown>>;

const MAX_DETAIL = 80;

/**
 * Maps a raw hook invocation of Claude Code, Codex or Copilot CLI onto an {@link AgentSignal}.
 * The event name comes from the hook command line (Copilot's camelCase payloads carry none),
 * the payload is whatever JSON the agent wrote to the hook's stdin.
 */
export function normalizeHook(agent: AgentKind, eventName: string, payload: unknown): NormalizedHook {
	const data: Payload = isRecord(payload) ? payload : {};
	return {
		fields: {
			sessionId: str(data, "session_id", "sessionId"),
			cwd: str(data, "cwd"),
		},
		signal: toSignal(agent, canonical(eventName), data),
	};
}

function toSignal(agent: AgentKind, event: string, data: Payload): AgentSignal {
	switch (event) {
		case "sessionstart":
			return { type: "session-start" };
		case "userpromptsubmit":
		case "userpromptsubmitted":
			return { type: "prompt" };
		case "pretooluse":
			return { type: "tool-start", tool: toolName(data) };
		case "posttooluse":
			return { type: "tool-end", tool: toolName(data), failed: false };
		case "posttoolusefailure":
			return { type: "tool-end", tool: toolName(data), failed: true };
		case "permissionrequest":
			return { type: "permission", detail: permissionDetail(data) };
		case "permissiondenied":
			return { type: "resumed" };
		case "notification":
			return notificationSignal(agent, data);
		case "elicitation":
			return { type: "needs-input", detail: str(data, "message") };
		case "elicitationresult":
			return { type: "resumed" };
		case "stop":
		case "agentstop":
			return { type: "turn-end" };
		case "interrupt":
			return { type: "interrupt" };
		case "stopfailure":
		case "erroroccurred":
			return { type: "error", message: errorMessage(data) };
		case "sessionend":
			return { type: "session-end" };
		default:
			return { type: "note", message: null };
	}
}

function notificationSignal(agent: AgentKind, data: Payload): AgentSignal {
	const kind = str(data, "notification_type", "notificationType", "type");
	const message = truncate(str(data, "message", "title"));
	switch (kind) {
		case "permission_prompt":
			return { type: "permission", detail: message };
		case "elicitation_dialog":
		case "elicitation_url_dialog":
		case "agent_needs_input":
			return { type: "needs-input", detail: message };
		case "elicitation_complete":
		case "elicitation_response":
			return { type: "resumed" };
		case "idle_prompt":
		case "agent_completed":
			return { type: "turn-end" };
		case null:
			break;
		default:
			return { type: "note", message };
	}
	// Untyped notifications (older Claude Code builds, Copilot CLI): classify by wording.
	if (message !== null) {
		if (/permission|approv|allow/iu.test(message)) return { type: "permission", detail: message };
		if (/waiting for (your )?input|needs? (your )?input|idle/iu.test(message)) {
			return agent === "copilot" ? { type: "needs-input", detail: message } : { type: "turn-end" };
		}
	}
	return { type: "note", message };
}

function toolName(data: Payload): string | null {
	return str(data, "tool_name", "toolName");
}

function permissionDetail(data: Payload): string | null {
	const tool = toolName(data);
	const input = data["tool_input"] ?? data["toolInput"] ?? data["toolArgs"];
	const description = isRecord(input) ? str(input, "description", "command") : null;
	if (tool !== null && description !== null) return truncate(`${tool}: ${description}`);
	return truncate(tool ?? description ?? str(data, "message"));
}

function errorMessage(data: Payload): string | null {
	const error = data["error"];
	if (isRecord(error)) return truncate(str(error, "message", "name"));
	if (typeof error === "string") return truncate(error);
	return truncate(str(data, "error_type", "message", "reason"));
}

function canonical(eventName: string): string {
	return eventName.toLowerCase().replace(/[^a-z]/gu, "");
}

function str(data: Payload, ...keys: readonly string[]): string | null {
	for (const key of keys) {
		const value = data[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return null;
}

function truncate(value: string | null): string | null {
	if (value === null) return null;
	const single = value.replace(/\s+/gu, " ");
	return single.length > MAX_DETAIL ? `${single.slice(0, MAX_DETAIL - 1)}…` : single;
}

function isRecord(value: unknown): value is Payload {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
