import {
	action,
	SingletonAction,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import { isPromptTarget, selectPromptTarget, type PromptTarget } from "../domain/target-selector.ts";
import { renderPromptKey, toDataUrl } from "../presentation/key-renderer.ts";
import { ImageCache, type JetDeckContext, type Refreshable } from "./context.ts";

export type PromptKeySettings = {
	label?: string;
	prompt?: string;
	target?: string;
	submit?: boolean | string;
};

interface PromptBinding {
	readonly label: string;
	readonly prompt: string;
	readonly target: PromptTarget;
	readonly submit: boolean;
}

export const PROMPT_ACTION_UUID = "com.jakubjirak.jetdeck.prompt";

const FLASH_MS = 700;

/** Sends a saved prompt to the best-matching agent session and brings its terminal forward. */
@action({ UUID: PROMPT_ACTION_UUID })
export class PromptKeyAction extends SingletonAction<PromptKeySettings> implements Refreshable {
	readonly #ctx: JetDeckContext;
	readonly #bindings = new Map<string, PromptBinding>();
	readonly #keys = new Map<string, KeyAction<PromptKeySettings>>();
	readonly #flash = new Map<string, { readonly kind: "ok" | "fail"; readonly until: number }>();
	readonly #images = new ImageCache();

	constructor(ctx: JetDeckContext) {
		super();
		this.#ctx = ctx;
	}

	override onWillAppear(ev: WillAppearEvent<PromptKeySettings>): void {
		if (!ev.action.isKey()) return;
		this.#keys.set(ev.action.id, ev.action);
		this.#bindings.set(ev.action.id, parseSettings(ev.payload.settings));
		this.#images.forget(ev.action.id);
		this.refresh(Date.now());
	}

	override onWillDisappear(ev: WillDisappearEvent<PromptKeySettings>): void {
		this.#keys.delete(ev.action.id);
		this.#bindings.delete(ev.action.id);
		this.#flash.delete(ev.action.id);
		this.#images.forget(ev.action.id);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<PromptKeySettings>): void {
		this.#bindings.set(ev.action.id, parseSettings(ev.payload.settings));
		this.refresh(Date.now());
	}

	override async onKeyDown(ev: KeyDownEvent<PromptKeySettings>): Promise<void> {
		const binding = parseSettings(ev.payload.settings);
		const ok = await this.#send(binding);
		this.#flash.set(ev.action.id, { kind: ok ? "ok" : "fail", until: Date.now() + FLASH_MS });
		this.refresh(Date.now());
		if (!ok) await ev.action.showAlert();
	}

	refresh(now: number): void {
		for (const [id, key] of this.#keys) {
			const binding = this.#bindings.get(id);
			if (binding === undefined) continue;
			const flash = this.#flash.get(id);
			const active = flash !== undefined && flash.until > now ? flash.kind : null;
			if (flash !== undefined && active === null) this.#flash.delete(id);
			const svg = renderPromptKey(binding.label, binding.target, active);
			if (this.#images.changed(id, svg)) void key.setImage(toDataUrl(svg)).catch(() => undefined);
		}
	}

	async #send(binding: PromptBinding): Promise<boolean> {
		if (binding.prompt.length === 0) return false;
		const session = selectPromptTarget(this.#ctx.store, binding.target);
		if (session === null) return false;
		const capabilities = this.#ctx.terminals.capabilities(session.terminal);
		try {
			if (!capabilities.input) {
				await this.#ctx.terminals.focus(session.terminal);
				return false;
			}
			await this.#ctx.terminals.sendText(session.terminal, binding.prompt, binding.submit);
			await this.#ctx.terminals.focus(session.terminal);
			this.#ctx.log.info(`prompt "${binding.label}" -> ${session.key}`);
			return true;
		} catch (error) {
			this.#ctx.log.warn(`prompt "${binding.label}" -> ${session.key} failed: ${String(error)}`);
			return false;
		}
	}
}

function parseSettings(settings: PromptKeySettings): PromptBinding {
	const prompt = typeof settings.prompt === "string" ? settings.prompt.trim() : "";
	const label = typeof settings.label === "string" && settings.label.trim().length > 0 ? settings.label.trim() : prompt;
	return {
		label,
		prompt,
		target: isPromptTarget(settings.target) ? settings.target : "any",
		submit: settings.submit === undefined ? true : settings.submit === true || settings.submit === "true",
	};
}
