import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TerminalKind, TerminalRef } from "../domain/agent.ts";

const run = promisify(execFile);

export type TerminalKey = "enter" | "escape";

export interface TerminalCapabilities {
	/** `exact` focuses the very tab/split, `app` only brings the hosting app forward. */
	readonly focus: "exact" | "app" | "none";
	readonly input: boolean;
	/** Whether text can be typed without submitting it. */
	readonly draftInput: boolean;
	readonly keys: boolean;
}

export class TerminalError extends Error {
	override readonly name = "TerminalError";
}

const CAPABILITIES: Readonly<Record<TerminalKind, TerminalCapabilities>> = {
	ghostty: { focus: "exact", input: true, draftInput: true, keys: true },
	"apple-terminal": { focus: "exact", input: true, draftInput: false, keys: true },
	vscode: { focus: "app", input: false, draftInput: false, keys: false },
	jetbrains: { focus: "app", input: false, draftInput: false, keys: false },
	unknown: { focus: "app", input: false, draftInput: false, keys: false },
};

const GHOSTTY_FIND = `
	set matches to (every terminal whose tty is ttyPath)
	if (count of matches) is 0 then error "No Ghostty terminal on " & ttyPath number 4040
	set t to item 1 of matches`;

const GHOSTTY_FOCUS = `on run argv
	set ttyPath to item 1 of argv
	tell application "Ghostty"
		${GHOSTTY_FIND}
		focus t
		activate
	end tell
end run`;

const GHOSTTY_INPUT = `on run argv
	set ttyPath to item 1 of argv
	set payload to item 2 of argv
	set submit to item 3 of argv
	tell application "Ghostty"
		${GHOSTTY_FIND}
		input text payload to t
		if submit is "1" then
			delay 0.08
			send key "enter" to t
		end if
	end tell
end run`;

const GHOSTTY_KEY = `on run argv
	set ttyPath to item 1 of argv
	set keyName to item 2 of argv
	tell application "Ghostty"
		${GHOSTTY_FIND}
		send key keyName to t
	end tell
end run`;

const APPLE_TERMINAL = `on run argv
	set ttyPath to item 1 of argv
	set mode to item 2 of argv
	set payload to item 3 of argv
	tell application "Terminal"
		repeat with w in windows
			repeat with t in tabs of w
				if tty of t is ttyPath then
					if mode is "focus" or mode is "escape" then
						set selected of t to true
						set index of w to 1
						activate
					end if
					if mode is "text" then do script payload in t
					if mode is "enter" then do script "" in t
					if mode is "escape" then
						delay 0.1
						tell application "System Events" to key code 53
					end if
					return
				end if
			end repeat
		end repeat
	end tell
	error "No Terminal tab on " & ttyPath number 4040
end run`;

/** Focuses agent terminals and drives their input via each terminal's AppleScript dictionary. */
export class TerminalController {
	capabilities(terminal: TerminalRef): TerminalCapabilities {
		return CAPABILITIES[terminal.kind];
	}

	async focus(terminal: TerminalRef): Promise<void> {
		switch (terminal.kind) {
			case "ghostty":
				await osascript(GHOSTTY_FOCUS, requireTty(terminal));
				return;
			case "apple-terminal":
				await osascript(APPLE_TERMINAL, requireTty(terminal), "focus", "");
				return;
			case "vscode":
			case "jetbrains":
			case "unknown":
				await activateApp(terminal);
				return;
		}
	}

	async sendText(terminal: TerminalRef, text: string, submit: boolean): Promise<void> {
		switch (terminal.kind) {
			case "ghostty":
				await osascript(GHOSTTY_INPUT, requireTty(terminal), text, submit ? "1" : "0");
				return;
			case "apple-terminal":
				// Terminal's `do script` always appends a newline, so text is always submitted there.
				await osascript(APPLE_TERMINAL, requireTty(terminal), "text", text);
				return;
			default:
				throw new TerminalError(`Typing into ${terminal.kind} terminals is not supported`);
		}
	}

	async sendKey(terminal: TerminalRef, key: TerminalKey): Promise<void> {
		switch (terminal.kind) {
			case "ghostty":
				await osascript(GHOSTTY_KEY, requireTty(terminal), key);
				return;
			case "apple-terminal":
				await osascript(APPLE_TERMINAL, requireTty(terminal), key, "");
				return;
			default:
				throw new TerminalError(`Sending keys to ${terminal.kind} terminals is not supported`);
		}
	}
}

function requireTty(terminal: TerminalRef): string {
	if (terminal.tty === null) throw new TerminalError("Session has no controlling terminal");
	return terminal.tty;
}

async function activateApp(terminal: TerminalRef): Promise<void> {
	if (terminal.appBundle === null) throw new TerminalError(`No app known for ${terminal.kind} terminal`);
	await run("open", ["-a", terminal.appBundle], { timeout: 5_000 });
}

async function osascript(script: string, ...args: string[]): Promise<void> {
	try {
		await run("osascript", ["-e", script, ...args], { timeout: 8_000 });
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw new TerminalError(stderr !== undefined && stderr.length > 0 ? stderr : String(error));
	}
}
