// Codex hook trust, reproduced byte for byte.
//
// Codex runs a non-managed hook only after it was approved in `/hooks`, which stores one entry per handler:
//   [hooks.state."<hooks.json path>:<event_snake>:<group index>:<handler index>"]
//   trusted_hash = "sha256:<hex>"
// <hex> is SHA-256 over the compact, key-sorted JSON of { event_name, matcher?, hooks: [handler] }, where the handler
// carries type, command, timeout (default 600) and async (default false), plus statusMessage / commandWindows when set.
// Writing these entries for JetDeck's own handlers has the same effect as approving them in `/hooks`.
import { createHash } from "node:crypto";

export const snakeCase = (event) => event.replace(/(?<!^)(?=[A-Z])/gu, "_").toLowerCase();

function sortedJson(value) {
	if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const keys = Object.keys(value)
			.filter((key) => value[key] !== undefined)
			.sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export function codexTrustHash(event, group, handler) {
	const identity = {
		event_name: snakeCase(event),
		matcher: typeof group.matcher === "string" && group.matcher.length > 0 ? group.matcher : undefined,
		hooks: [
			{
				type: handler.type ?? "command",
				command: handler.command,
				timeout: handler.timeout ?? 600,
				async: handler.async ?? false,
				statusMessage: handler.statusMessage,
				commandWindows: handler.commandWindows ?? handler.command_windows,
			},
		],
	};
	return `sha256:${createHash("sha256").update(sortedJson(identity)).digest("hex")}`;
}

/** Trust entries (key -> hash) for every handler whose command contains `marker`, keyed exactly like Codex. */
export function codexTrustEntries(hooks, hooksPath, marker) {
	const entries = new Map();
	for (const [event, groups] of Object.entries(hooks ?? {})) {
		if (!Array.isArray(groups)) continue;
		groups.forEach((group, gi) =>
			(group?.hooks ?? []).forEach((handler, hi) => {
				if (!String(handler?.command ?? "").includes(marker)) return;
				entries.set(`${hooksPath}:${snakeCase(event)}:${gi}:${hi}`, codexTrustHash(event, group, handler));
			}),
		);
	}
	return entries;
}

const STATE_BLOCK = /^\[hooks\.state\."([^"\n]+)"\][ \t]*\n((?:(?!\[)[^\n]*(?:\n|$))*)/gmu;
const BANNER = "# JetDeck hooks, trusted by `npm run hooks:install` (same effect as approving them in Codex /hooks)";

/**
 * Returns config.toml text in which exactly `wanted` JetDeck entries are trusted. Earlier JetDeck entries (recognised by
 * one of `previousHashes` under `hooksPath`) and any entry whose key is about to be reused are removed, so a table is
 * never defined twice. All other content is kept verbatim.
 */
export function rewriteCodexTrust(text, wanted, previousHashes, hooksPath) {
	const stale = (key, body) => {
		if (wanted.has(key)) return true;
		const hash = /^trusted_hash\s*=\s*"([^"]+)"/mu.exec(body)?.[1];
		return key.startsWith(`${hooksPath}:`) && hash !== undefined && previousHashes.has(hash);
	};
	let next = text.replace(STATE_BLOCK, (block, key, body) => (stale(key, body) ? "" : block));
	next = next.split("\n").filter((line) => line !== BANNER).join("\n");
	next = next.replace(/\n{3,}/gu, "\n\n").replace(/\n+$/u, "");
	if (wanted.size > 0) {
		const blocks = [...wanted].map(([key, hash]) => `[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = "${hash}"`);
		next = `${next}${next.length > 0 ? "\n\n" : ""}${BANNER}\n${blocks.join("\n\n")}`;
	}
	return next.length > 0 ? `${next}\n` : next;
}
