import type { AgentFilter, Session } from "./agent.ts";

const ATTENTION_FIRST: Readonly<Record<Session["state"], number>> = {
	awaiting: 0,
	error: 1,
	done: 2,
	working: 3,
	idle: 4,
};

/** 1-based slot numbers that have a key on the deck; `null` means every slot is visible. */
export type VisibleSlots = ReadonlySet<number> | null;

/**
 * Sticky mapping of sessions onto numbered key slots per agent filter.
 *
 * - A visible session keeps its slot for its whole life, so keys never jump around when others start or end.
 * - New sessions take the lowest free slot that has a key.
 * - With more sessions than keys the surplus waits in hidden slots; whenever a key frees up, the hidden session that
 *   most needs you (waiting > error > done > working > idle, then most recently active) moves onto it.
 */
export class SlotAllocator {
	readonly #slots = new Map<AgentFilter, Array<string | null>>();

	/** Re-assigns slots for one filter given its current sessions (oldest first). */
	sync(filter: AgentFilter, sessions: readonly Session[], visible: VisibleSlots = null): void {
		const slots = this.#slots.get(filter) ?? [];
		const live = new Map(sessions.map((s) => [s.key, s]));
		const shown = (index: number): boolean => visible === null || visible.has(index + 1);
		const lastVisible = visible === null ? Number.POSITIVE_INFINITY : Math.max(0, ...visible) - 1;
		/** Lowest empty slot that has a key, possibly past the current end of the array; -1 if every key is taken. */
		const freeVisible = (): number => {
			const end = visible === null ? slots.length : lastVisible;
			for (let i = 0; i <= end; i++) if ((slots[i] ?? null) === null && shown(i)) return i;
			return -1;
		};
		const place = (index: number, key: string): void => {
			while (slots.length < index) slots.push(null);
			slots[index] = key;
		};

		for (let i = 0; i < slots.length; i++) {
			const key = slots[i];
			if (key !== null && key !== undefined && !live.has(key)) slots[i] = null;
		}

		const assigned = new Set(slots.filter((k): k is string => k !== null));
		for (const session of sessions) {
			if (assigned.has(session.key)) continue;
			const free = freeVisible();
			if (free >= 0) place(free, session.key);
			else slots.push(session.key);
		}

		const waiting = slots
			.map((key, index) => ({ key, index }))
			.filter((e): e is { key: string; index: number } => e.key !== null && !shown(e.index))
			.sort((a, b) => urgency(live.get(a.key), live.get(b.key)));
		for (const { key, index } of waiting) {
			const free = freeVisible();
			if (free < 0) break;
			slots[index] = null;
			place(free, key);
		}

		while (slots.length > 0 && slots[slots.length - 1] === null) slots.pop();
		this.#slots.set(filter, slots);
	}

	/** Session key shown on the 1-based slot, if any. */
	keyAt(filter: AgentFilter, slot: number): string | null {
		return this.#slots.get(filter)?.[slot - 1] ?? null;
	}

	/** Sessions of the filter that currently have no key on the deck. */
	hiddenCount(filter: AgentFilter, visible: VisibleSlots): number {
		if (visible === null) return 0;
		return (this.#slots.get(filter) ?? []).filter((key, index) => key !== null && !visible.has(index + 1)).length;
	}
}

function urgency(a: Session | undefined, b: Session | undefined): number {
	if (a === undefined || b === undefined) return 0;
	return ATTENTION_FIRST[a.state] - ATTENTION_FIRST[b.state] || b.lastEventAt - a.lastEventAt;
}
