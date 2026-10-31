import {
	action,
	SingletonAction,
	type KeyAction,
	type KeyDownEvent,
	type KeyUpEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import { selectAttentionTarget } from "../domain/target-selector.ts";
import { renderAttentionKey, toDataUrl } from "../presentation/key-renderer.ts";
import { ImageCache, type JetDeckContext, type Refreshable } from "./context.ts";
import { PressTracker } from "./press-tracker.ts";

export const ATTENTION_ACTION_UUID = "com.jakubjirak.jetdeck.attention";

/**
 * Aggregate key across all agents: counts sessions blocked on you. Press jumps to the longest-waiting one
 * (or the most recently finished one), hold approves it.
 */
@action({ UUID: ATTENTION_ACTION_UUID })
export class AttentionKeyAction extends SingletonAction implements Refreshable {
	readonly #ctx: JetDeckContext;
	readonly #keys = new Map<string, KeyAction<JsonObject>>();
	readonly #images = new ImageCache();
	readonly #press = new PressTracker();

	constructor(ctx: JetDeckContext) {
		super();
		this.#ctx = ctx;
	}

	override onWillAppear(ev: WillAppearEvent): void {
		if (!ev.action.isKey()) return;
		this.#keys.set(ev.action.id, ev.action);
		this.#images.forget(ev.action.id);
		this.refresh(Date.now(), false);
	}

	override onWillDisappear(ev: WillDisappearEvent): void {
		this.#keys.delete(ev.action.id);
		this.#images.forget(ev.action.id);
		this.#press.cancel(ev.action.id);
	}

	override onKeyDown(ev: KeyDownEvent): void {
		const key = ev.action;
		this.#press.down(key.id, () => void this.#approve(key));
	}

	override onKeyUp(ev: KeyUpEvent): void {
		if (this.#press.up(ev.action.id)) void this.#jump(ev.action);
	}

	refresh(now: number, pulse: boolean): void {
		if (this.#keys.size === 0) return;
		const awaiting = this.#ctx.store.awaiting();
		const working = this.#ctx.store.list("any").filter((s) => s.state === "working").length;
		const svg = renderAttentionKey(awaiting, working, pulse, now);
		for (const [id, key] of this.#keys) {
			if (this.#images.changed(id, svg)) void key.setImage(toDataUrl(svg)).catch(() => undefined);
		}
	}

	async #jump(key: KeyAction<JsonObject>): Promise<void> {
		const session = selectAttentionTarget(this.#ctx.store);
		if (session === null) {
			await key.showAlert();
			return;
		}
		try {
			await this.#ctx.terminals.focus(session.terminal);
		} catch (error) {
			this.#ctx.log.warn(`focus ${session.key} failed: ${String(error)}`);
			await key.showAlert();
		}
	}

	async #approve(key: KeyAction<JsonObject>): Promise<void> {
		const session = this.#ctx.store.awaiting()[0];
		if (session === undefined || !this.#ctx.terminals.capabilities(session.terminal).keys) {
			await key.showAlert();
			return;
		}
		try {
			await this.#ctx.terminals.sendKey(session.terminal, "enter");
			this.#ctx.log.info(`approve ${session.key}`);
			await key.showOk();
		} catch (error) {
			this.#ctx.log.warn(`approve ${session.key} failed: ${String(error)}`);
			await key.showAlert();
		}
	}
}
