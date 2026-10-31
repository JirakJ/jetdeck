import {
	action,
	SingletonAction,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type KeyUpEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import { isAgentFilter, type AgentFilter, type Session } from "../domain/agent.ts";
import { renderEmptySlot, renderSessionKey, toDataUrl } from "../presentation/key-renderer.ts";
import { holdIntent, ImageCache, type JetDeckContext, type Refreshable } from "./context.ts";
import { PressTracker } from "./press-tracker.ts";

export type SessionKeySettings = {
	agent?: string;
	slot?: number | string;
};

interface SlotBinding {
	readonly filter: AgentFilter;
	readonly slot: number;
}

export const SESSION_ACTION_UUID = "com.jakubjirak.jetdeck.session";

/**
 * One key = one agent session slot. Shows live state; press jumps to the session's terminal,
 * hold approves a pending prompt or interrupts a running turn.
 */
@action({ UUID: SESSION_ACTION_UUID })
export class SessionKeyAction extends SingletonAction<SessionKeySettings> implements Refreshable {
	readonly #ctx: JetDeckContext;
	readonly #bindings = new Map<string, SlotBinding>();
	readonly #keys = new Map<string, KeyAction<SessionKeySettings>>();
	readonly #images = new ImageCache();
	readonly #press = new PressTracker();

	constructor(ctx: JetDeckContext) {
		super();
		this.#ctx = ctx;
	}

	override onWillAppear(ev: WillAppearEvent<SessionKeySettings>): void {
		if (!ev.action.isKey()) return;
		this.#keys.set(ev.action.id, ev.action);
		this.#bindings.set(ev.action.id, parseSettings(ev.payload.settings));
		this.#images.forget(ev.action.id);
		this.refresh(Date.now(), false);
	}

	override onWillDisappear(ev: WillDisappearEvent<SessionKeySettings>): void {
		this.#keys.delete(ev.action.id);
		this.#bindings.delete(ev.action.id);
		this.#images.forget(ev.action.id);
		this.#press.cancel(ev.action.id);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<SessionKeySettings>): void {
		this.#bindings.set(ev.action.id, parseSettings(ev.payload.settings));
		this.refresh(Date.now(), false);
	}

	override onKeyDown(ev: KeyDownEvent<SessionKeySettings>): void {
		const key = ev.action;
		this.#press.down(key.id, () => void this.#hold(key));
	}

	override onKeyUp(ev: KeyUpEvent<SessionKeySettings>): void {
		if (this.#press.up(ev.action.id)) void this.#focus(ev.action);
	}

	refresh(now: number, pulse: boolean): void {
		const filters = new Set([...this.#bindings.values()].map((b) => b.filter));
		for (const filter of filters) this.#ctx.slots.sync(filter, this.#ctx.store.list(filter));

		for (const [id, key] of this.#keys) {
			const binding = this.#bindings.get(id);
			if (binding === undefined) continue;
			const session = this.#sessionFor(binding);
			const svg =
				session === null
					? renderEmptySlot(binding.filter, binding.slot)
					: renderSessionKey(session, binding.slot, now, pulse);
			if (this.#images.changed(id, svg)) void key.setImage(toDataUrl(svg)).catch(() => undefined);
		}
	}

	#sessionFor(binding: SlotBinding): Session | null {
		const key = this.#ctx.slots.keyAt(binding.filter, binding.slot);
		return key === null ? null : (this.#ctx.store.get(key) ?? null);
	}

	async #focus(key: KeyAction<SessionKeySettings>): Promise<void> {
		const binding = this.#bindings.get(key.id);
		const session = binding === undefined ? null : this.#sessionFor(binding);
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

	async #hold(key: KeyAction<SessionKeySettings>): Promise<void> {
		const binding = this.#bindings.get(key.id);
		const session = binding === undefined ? null : this.#sessionFor(binding);
		const intent = session === null ? null : holdIntent(session);
		if (session === null || intent === null || !this.#ctx.terminals.capabilities(session.terminal).keys) {
			await key.showAlert();
			return;
		}
		try {
			await this.#ctx.terminals.sendKey(session.terminal, intent.key);
			this.#ctx.log.info(`${intent.verb} ${session.key}`);
			await key.showOk();
		} catch (error) {
			this.#ctx.log.warn(`${intent.verb} ${session.key} failed: ${String(error)}`);
			await key.showAlert();
		}
	}
}

function parseSettings(settings: SessionKeySettings): SlotBinding {
	const filter = isAgentFilter(settings.agent) ? settings.agent : "any";
	const requested = Number(settings.slot);
	const slot = Number.isInteger(requested) && requested >= 1 && requested <= 99 ? requested : 1;
	return { filter, slot };
}
