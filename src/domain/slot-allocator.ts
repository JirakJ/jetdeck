import type { AgentFilter, Session } from "./agent.ts";

/**
 * Sticky mapping of sessions onto numbered key slots per agent filter.
 * A session keeps its slot for its whole life, so keys never jump around when other sessions start or end;
 * new sessions take the lowest free slot.
 */
export class SlotAllocator {
	readonly #slots = new Map<AgentFilter, Array<string | null>>();

	/** Re-assigns slots for one filter given its current sessions (oldest first). */
	sync(filter: AgentFilter, sessions: readonly Session[]): void {
		const slots = this.#slots.get(filter) ?? [];
		const live = new Set(sessions.map((s) => s.key));

		for (let i = 0; i < slots.length; i++) {
			const key = slots[i];
			if (key !== null && key !== undefined && !live.has(key)) slots[i] = null;
		}

		const assigned = new Set(slots.filter((k): k is string => k !== null));
		for (const session of sessions) {
			if (assigned.has(session.key)) continue;
			const free = slots.indexOf(null);
			if (free >= 0) slots[free] = session.key;
			else slots.push(session.key);
		}

		while (slots.length > 0 && slots[slots.length - 1] === null) slots.pop();
		this.#slots.set(filter, slots);
	}

	/** Session key shown on the 1-based slot, if any. */
	keyAt(filter: AgentFilter, slot: number): string | null {
		return this.#slots.get(filter)?.[slot - 1] ?? null;
	}
}
