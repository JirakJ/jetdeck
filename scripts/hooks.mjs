#!/usr/bin/env node
// Installs / removes the JetDeck hook in Claude Code, Codex and Copilot CLI user configs.
// Idempotent, preserves every foreign hook, and backs up each file it rewrites.
//
//   node scripts/hooks.mjs install [--dry-run]
//   node scripts/hooks.mjs uninstall [--dry-run]

import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK_SOURCE = join(ROOT, "hook", "jetdeck-hook");
const HOOK_TARGET = join(HOME, ".jetdeck", "bin", "jetdeck-hook");
const MARKER = "/.jetdeck/bin/jetdeck-hook";

const CLAUDE_EVENTS = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"PermissionRequest",
	"PermissionDenied",
	"Notification",
	"Elicitation",
	"ElicitationResult",
	"Stop",
	"StopFailure",
	"SessionEnd",
];
const CODEX_EVENTS = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PermissionRequest",
	"Stop",
	"Interrupt",
	"SessionEnd",
];
const COPILOT_EVENTS = [
	"sessionStart",
	"userPromptSubmitted",
	"preToolUse",
	"postToolUse",
	"postToolUseFailure",
	"permissionRequest",
	"notification",
	"agentStop",
	"errorOccurred",
	"sessionEnd",
];

const claudeSettings = join(process.env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude"), "settings.json");
const codexHooks = join(process.env.CODEX_HOME ?? join(HOME, ".codex"), "hooks.json");
const copilotHooks = join(process.env.COPILOT_HOME ?? join(HOME, ".copilot"), "hooks", "jetdeck.json");

const [command, ...flags] = process.argv.slice(2);
const dryRun = flags.includes("--dry-run");

const hookCommand = (agent, event) => `"${HOOK_TARGET}" ${agent} ${event}`;

/** Removes JetDeck handlers from a Claude/Codex-style `{ hooks: { Event: [ { hooks: [...] } ] } }` tree. */
function stripGrouped(hooks) {
	const result = {};
	for (const [event, groups] of Object.entries(hooks ?? {})) {
		if (!Array.isArray(groups)) {
			result[event] = groups;
			continue;
		}
		const kept = groups
			.map((group) =>
				Array.isArray(group?.hooks)
					? { ...group, hooks: group.hooks.filter((h) => !String(h?.command ?? "").includes(MARKER)) }
					: group,
			)
			.filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
		if (kept.length > 0) result[event] = kept;
	}
	return result;
}

function addGrouped(hooks, agent, events, timeoutFor) {
	const result = { ...hooks };
	for (const event of events) {
		const groups = Array.isArray(result[event]) ? [...result[event]] : [];
		groups.push({ hooks: [{ type: "command", command: hookCommand(agent, event), timeout: timeoutFor(event) }] });
		result[event] = groups;
	}
	return result;
}

async function readJson(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw new Error(`${path}: ${error.message}`);
	}
}

async function writeJson(path, value) {
	const text = `${JSON.stringify(value, null, 2)}\n`;
	if (dryRun) {
		console.log(`--- ${path}\n${text}`);
		return;
	}
	await mkdir(dirname(path), { recursive: true });
	if (await exists(path)) await copyFile(path, `${path}.jetdeck-backup`);
	await writeFile(path, text, "utf8");
}

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function updateGroupedFile(path, agent, events, timeoutFor, install) {
	const current = (await readJson(path)) ?? {};
	const stripped = stripGrouped(current.hooks);
	const hooks = install ? addGrouped(stripped, agent, events, timeoutFor) : stripped;
	const next = { ...current, hooks };
	if (Object.keys(hooks).length === 0) delete next.hooks;
	if (!install && JSON.stringify(next) === JSON.stringify(current)) return false;
	await writeJson(path, next);
	return true;
}

async function install() {
	if (!dryRun) {
		await mkdir(dirname(HOOK_TARGET), { recursive: true, mode: 0o700 });
		await copyFile(HOOK_SOURCE, HOOK_TARGET);
		await chmod(HOOK_TARGET, 0o755);
	}
	console.log(`hook       ${HOOK_TARGET}`);

	await updateGroupedFile(claudeSettings, "claude", CLAUDE_EVENTS, () => 5, true);
	console.log(`claude     ${claudeSettings}`);

	// Codex caps SessionEnd/Interrupt hooks at 3 s.
	await updateGroupedFile(codexHooks, "codex", CODEX_EVENTS, (e) => (e === "SessionEnd" || e === "Interrupt" ? 2 : 5), true);
	console.log(`codex      ${codexHooks}  (run /hooks once inside Codex to trust them)`);

	const copilot = { version: 1, hooks: {} };
	for (const event of COPILOT_EVENTS) {
		copilot.hooks[event] = [{ type: "command", bash: hookCommand("copilot", event), timeoutSec: 5 }];
	}
	await writeJson(copilotHooks, copilot);
	console.log(`copilot    ${copilotHooks}`);
}

async function uninstall() {
	if (await updateGroupedFile(claudeSettings, "claude", [], () => 5, false)) console.log(`claude     cleaned ${claudeSettings}`);
	if (await updateGroupedFile(codexHooks, "codex", [], () => 5, false)) console.log(`codex      cleaned ${codexHooks}`);
	if (!dryRun) {
		await rm(copilotHooks, { force: true });
		await rm(HOOK_TARGET, { force: true });
	}
	console.log(`copilot    removed ${copilotHooks}`);
	console.log(`hook       removed ${HOOK_TARGET}`);
}

switch (command) {
	case "install":
		await install();
		break;
	case "uninstall":
		await uninstall();
		break;
	default:
		console.error("usage: node scripts/hooks.mjs install|uninstall [--dry-run]");
		process.exit(2);
}
