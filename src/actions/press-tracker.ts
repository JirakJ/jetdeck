/**
 * Distinguishes short presses from holds. The hold action fires while the key is still down,
 * so the user gets feedback without having to guess when to let go.
 */
export class PressTracker {
	readonly #holdMs: number;
	readonly #pending = new Map<string, { timer: NodeJS.Timeout; held: boolean }>();

	constructor(holdMs = 450) {
		this.#holdMs = holdMs;
	}

	down(id: string, onHold: () => void): void {
		this.cancel(id);
		const entry = {
			held: false,
			timer: setTimeout(() => {
				entry.held = true;
				onHold();
			}, this.#holdMs),
		};
		this.#pending.set(id, entry);
	}

	/** Returns `true` when the release completes a short press (the hold action did not fire). */
	up(id: string): boolean {
		const entry = this.#pending.get(id);
		if (entry === undefined) return false;
		clearTimeout(entry.timer);
		this.#pending.delete(id);
		return !entry.held;
	}

	cancel(id: string): void {
		const entry = this.#pending.get(id);
		if (entry === undefined) return;
		clearTimeout(entry.timer);
		this.#pending.delete(id);
	}
}
