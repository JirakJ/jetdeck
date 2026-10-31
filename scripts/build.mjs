#!/usr/bin/env node
// Bundles the plugin into a single ESM file inside the .sdPlugin folder.
//   node scripts/build.mjs           production bundle
//   node scripts/build.mjs --watch   rebuild on change and restart the plugin in Stream Deck
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
	absWorkingDir: ROOT,
	entryPoints: ["src/plugin.ts"],
	outfile: "com.jakubjirak.jetdeck.sdPlugin/bin/plugin.mjs",
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	minify: !watch,
	sourcemap: watch ? "inline" : "linked",
	legalComments: "none",
	// `ws` probes these optional native addons with require(); they are not needed.
	external: ["bufferutil", "utf-8-validate"],
	banner: {
		js: "import { createRequire as __jetdeckCreateRequire } from 'node:module'; const require = __jetdeckCreateRequire(import.meta.url);",
	},
	logLevel: "info",
};

if (watch) {
	const restart = {
		name: "restart-plugin",
		setup(build) {
			build.onEnd((result) => {
				if (result.errors.length > 0) return;
				execFile(join(ROOT, "node_modules", ".bin", "streamdeck"), ["restart", "com.jakubjirak.jetdeck"], () => undefined);
			});
		},
	};
	const context = await esbuild.context({ ...options, plugins: [restart] });
	await context.watch();
} else {
	await esbuild.build(options);
}
