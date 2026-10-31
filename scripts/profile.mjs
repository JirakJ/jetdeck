#!/usr/bin/env node
// Adds a ready-made "JetDeck" page to the Stream Deck XL profile and makes it the current page.
// Non-destructive: existing pages stay untouched, re-running replaces only the JetDeck page.
// Stream Deck keeps profiles in memory, so the app is quit before writing and relaunched afterwards.
//
//   node scripts/profile.mjs [--dry-run]

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = join(homedir(), "Library", "Application Support", "com.elgato.StreamDeck", "ProfilesV3");
const XL_MODELS = new Set(["20GAT9901", "20GAT9902", "20GBA9901"]);
const PAGE_NAME = "JetDeck";
const PLUGIN = { Name: "JetDeck", UUID: "com.jakubjirak.jetdeck", Version: "1.2.0.0" };
const dryRun = process.argv.includes("--dry-run");

const PROMPTS = [
	["Review", "Review the uncommitted changes for bugs, edge cases and missing tests. Report findings first, do not edit yet."],
	["Run tests", "Run the test suite, fix every failure at its root cause, then summarize what changed."],
	["Commit", "Commit the current changes in logical units with Conventional Commit messages, then push."],
	["Fix error", "Explain the last error and fix its root cause, not the symptom."],
	["Simplify", "Simplify the code you just changed without altering behavior; keep the diff minimal."],
	["Plan first", "Before writing any code, propose a short step-by-step plan and wait for my go-ahead."],
	["Status", "Give me a three-line status: done, in progress, blocked."],
	["Continue", "Continue."],
];

function action(uuid, name, settings) {
	return {
		ActionID: randomUUID(),
		LinkedTitle: false,
		Name: name,
		Plugin: PLUGIN,
		Resources: null,
		Settings: settings,
		State: 0,
		States: [{ ShowTitle: false }],
		UUID: uuid,
	};
}

const session = (agent, slot) => action("com.jakubjirak.jetdeck.session", "Agent Session", { agent, slot });
const metric = (kind) => action("com.jakubjirak.jetdeck.metric", "System Metric", { metric: kind });
const prompt = (label, text) =>
	action("com.jakubjirak.jetdeck.prompt", "Send Prompt", { label, prompt: text, target: "any", submit: true });

/** 8 × 4 layout, keys are "column,row". */
function layout() {
	const keys = {};
	keys["0,0"] = action("com.jakubjirak.jetdeck.attention", "Needs You", {});
	for (let i = 1; i <= 7; i++) keys[`${i},0`] = session("claude", i);
	for (let i = 1; i <= 4; i++) keys[`${i - 1},1`] = session("codex", i);
	for (let i = 1; i <= 4; i++) keys[`${i + 3},1`] = session("copilot", i);
	PROMPTS.forEach(([label, text], i) => (keys[`${i},2`] = prompt(label, text)));
	["cpu", "gpu", "ane", "ram", "disk", "power"].forEach((kind, i) => (keys[`${i},3`] = metric(kind)));
	for (let i = 1; i <= 2; i++) keys[`${i + 5},3`] = session("any", i + 7);
	return keys;
}

async function findXlProfile() {
	for (const entry of await readdir(ROOT)) {
		if (!entry.endsWith(".sdProfile")) continue;
		const dir = join(ROOT, entry);
		const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
		if (XL_MODELS.has(manifest.Device?.Model)) return { dir, manifest };
	}
	throw new Error("No Stream Deck XL profile found. Connect the XL and open the Stream Deck app once.");
}

async function existingJetDeckPage(dir, pages) {
	for (const id of pages) {
		try {
			const page = JSON.parse(await readFile(join(dir, "Profiles", id.toUpperCase(), "manifest.json"), "utf8"));
			if (page.Name === PAGE_NAME) return id;
		} catch {
			// Page folder missing; ignore.
		}
	}
	return null;
}

function streamDeckRunning() {
	try {
		execFileSync("pgrep", ["-x", "Stream Deck"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** Quits Stream Deck and waits until it is gone; its shutdown can hang, so it is killed after 10 s. */
async function quitStreamDeck() {
	try {
		execFileSync("osascript", ["-e", 'quit application id "com.elgato.StreamDeck"'], { stdio: "ignore", timeout: 15_000 });
	} catch {
		// Not running, or the quit event timed out.
	}
	for (let i = 0; i < 40 && streamDeckRunning(); i++) await new Promise((r) => setTimeout(r, 250));
	if (streamDeckRunning()) {
		execFileSync("pkill", ["-9", "-x", "Stream Deck"], { stdio: "ignore" });
		await new Promise((r) => setTimeout(r, 500));
	}
}

const { dir, manifest } = await findXlProfile();
const pages = manifest.Pages.Pages;
const pageId = (await existingJetDeckPage(dir, pages)) ?? randomUUID().toLowerCase();
const page = { Controllers: [{ Actions: layout(), Type: "Keypad" }], Icon: "", Name: PAGE_NAME };

if (dryRun) {
	console.log(JSON.stringify({ profile: dir, pageId, page }, null, 2));
	process.exit(0);
}

await quitStreamDeck();

const pageDir = join(dir, "Profiles", pageId.toUpperCase());
await mkdir(join(pageDir, "Images"), { recursive: true });
await writeFile(join(pageDir, "manifest.json"), JSON.stringify(page));
manifest.Pages.Pages = [pageId, ...pages.filter((p) => p !== pageId)];
manifest.Pages.Current = pageId;
await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));

execFileSync("open", ["-g", "-b", "com.elgato.StreamDeck"], { stdio: "ignore" });
console.log(`JetDeck page ${pageId} written to ${manifest.Name} and set as current.`);
