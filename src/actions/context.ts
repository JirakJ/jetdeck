import type { Session } from "../domain/agent.ts";
import type { SessionStore } from "../domain/session-store.ts";
import type { SlotAllocator } from "../domain/slot-allocator.ts";
import type { TerminalController, TerminalKey } from "../infrastructure/terminal-controller.ts";

/** Shared services every JetDeck action works with. */
export interface JetDeckContext {
	readonly store: SessionStore;
	readonly slots: SlotAllocator;
	readonly terminals: TerminalController;
	readonly log: Log;
}

export interface Log {
	debug(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

/** An action that repaints its visible keys from the current store state. */
export interface Refreshable {
	refresh(now: number, pulse: boolean): void;
}

/** Remembers the last image per key so Stream Deck only receives actual changes. */
export class ImageCache {
	readonly #last = new Map<string, string>();

	/** Returns `true` when `image` differs from what the key shows. */
	changed(id: string, image: string): boolean {
		if (this.#last.get(id) === image) return false;
		this.#last.set(id, image);
		return true;
	}

	forget(id: string): void {
		this.#last.delete(id);
	}
}

export type HoldIntent = { readonly key: TerminalKey; readonly verb: "approve" | "interrupt" } | null;

/** What holding a key does to a session: approve a pending prompt, or interrupt a running turn. */
export function holdIntent(session: Session): HoldIntent {
	if (session.state === "awaiting") return { key: "enter", verb: "approve" };
	if (session.state === "working") return { key: "escape", verb: "interrupt" };
	return null;
}
