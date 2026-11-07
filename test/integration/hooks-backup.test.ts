/**
 * Runs the real installer against a throwaway home directory. `.jetdeck-backup` is the only copy of the user's
 * pre-JetDeck configuration, so nothing the installer does later may replace it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const INSTALLER = resolve(import.meta.dirname, "../../scripts/hooks.mjs");
const ORIGINAL_SETTINGS = `${JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }, null, 2)}\n`;
const ORIGINAL_CODEX_HOOKS = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node lint.mjs" }] }] } }, null, 2)}\n`;
const ORIGINAL_CODEX_CONFIG = 'model = "gpt-5"\n';

describe("hooks installer backups", () => {
	let home: string;
	let settings: string;
	let codexHooks: string;
	let codexConfig: string;
	const backup = (path: string) => `${path}.jetdeck-backup`;

	function run(...args: string[]) {
		const env = { PATH: process.env.PATH, HOME: home };
		return spawnSync(process.execPath, [INSTALLER, ...args], { env, encoding: "utf8", timeout: 20_000 });
	}

	function runOk(...args: string[]): void {
		const result = run(...args);
		assert.equal(result.status, 0, result.stderr);
	}

	async function seed(path: string, text: string): Promise<void> {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, text);
	}

	async function seedAll(): Promise<void> {
		await seed(settings, ORIGINAL_SETTINGS);
		await seed(codexHooks, ORIGINAL_CODEX_HOOKS);
		await seed(codexConfig, ORIGINAL_CODEX_CONFIG);
	}

	async function assertOriginalsBackedUp(): Promise<void> {
		assert.equal(await readFile(backup(settings), "utf8"), ORIGINAL_SETTINGS);
		assert.equal(await readFile(backup(codexHooks), "utf8"), ORIGINAL_CODEX_HOOKS);
		assert.equal(await readFile(backup(codexConfig), "utf8"), ORIGINAL_CODEX_CONFIG);
	}

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "jetdeck-backup-"));
		settings = join(home, ".claude", "settings.json");
		codexHooks = join(home, ".codex", "hooks.json");
		codexConfig = join(home, ".codex", "config.toml");
	});

	afterEach(async () => {
		await rm(home, { recursive: true, force: true });
	});

	it("keeps the original configuration when install runs again", async () => {
		await seedAll();
		runOk("install");
		await assertOriginalsBackedUp();
		assert.notEqual(await readFile(settings, "utf8"), ORIGINAL_SETTINGS);

		runOk("install");
		await assertOriginalsBackedUp();
	});

	it("keeps the original configuration across uninstall and reinstall", async () => {
		await seedAll();
		runOk("install");
		runOk("uninstall");
		await assertOriginalsBackedUp();

		runOk("install");
		await assertOriginalsBackedUp();
	});

	it("does not fold later user edits into the backup, and keeps them in the live file", async () => {
		await seedAll();
		runOk("install");
		const edited = JSON.parse(await readFile(settings, "utf8"));
		edited.theme = "dark";
		await writeFile(settings, JSON.stringify(edited));

		runOk("install");
		await assertOriginalsBackedUp();
		assert.equal(JSON.parse(await readFile(settings, "utf8")).theme, "dark");
	});

	it("keeps the original Copilot hooks file when install runs again", async () => {
		const copilot = join(home, ".copilot", "hooks", "jetdeck.json");
		await seed(copilot, '{"version":1,"hooks":{}}\n');
		runOk("install");
		runOk("install");
		assert.equal(await readFile(backup(copilot), "utf8"), '{"version":1,"hooks":{}}\n');
	});

	it("creates no backup for a file that did not exist before install", async () => {
		runOk("install");
		await assert.rejects(access(backup(settings)), { code: "ENOENT" });
		await assert.rejects(access(backup(codexHooks)), { code: "ENOENT" });
	});

	it("writes no backup during a dry run", async () => {
		await seedAll();
		runOk("install", "--dry-run");
		await assert.rejects(access(backup(settings)), { code: "ENOENT" });
		await assert.rejects(access(backup(codexConfig)), { code: "ENOENT" });
		assert.equal(await readFile(settings, "utf8"), ORIGINAL_SETTINGS);
	});

	it("refuses to rewrite a file whose backup path is not a regular file", async () => {
		await seedAll();
		await mkdir(backup(settings));

		const result = run("install");
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /existing backup is not a regular file/u);
		assert.equal(await readFile(settings, "utf8"), ORIGINAL_SETTINGS);
	});
});
