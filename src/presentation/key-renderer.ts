import { AGENT_LABEL, projectName, type AgentFilter, type AgentKind, type Session, type SessionState } from "../domain/agent.ts";
import type { PromptTarget } from "../domain/target-selector.ts";
import { clip, SIZE, svg, text } from "./svg.ts";


interface Palette {
	readonly bg: string;
	readonly bgAlt: string;
	readonly accent: string;
	readonly fg: string;
}

const STATE_PALETTE: Readonly<Record<SessionState, Palette>> = {
	idle: { bg: "#1c2128", bgAlt: "#1c2128", accent: "#8b949e", fg: "#c9d1d9" },
	working: { bg: "#0d3321", bgAlt: "#0d3321", accent: "#3fb950", fg: "#e6edf3" },
	awaiting: { bg: "#6b4500", bgAlt: "#3a2600", accent: "#f2cc60", fg: "#fff8e1" },
	done: { bg: "#0b2a5c", bgAlt: "#0b2a5c", accent: "#58a6ff", fg: "#e6edf3" },
	error: { bg: "#5c0a10", bgAlt: "#5c0a10", accent: "#ff7b72", fg: "#ffe5e3" },
};

const STATE_LABEL: Readonly<Record<SessionState, string>> = {
	idle: "IDLE",
	working: "WORKING",
	awaiting: "WAITING",
	done: "DONE",
	error: "ERROR",
};

export const AGENT_COLOR: Readonly<Record<AgentKind, string>> = {
	claude: "#e8875f",
	codex: "#f0f6fc",
	copilot: "#b392f0",
};

/** Renders one session key. `pulse` alternates the background of sessions waiting for the user. */
export function renderSessionKey(session: Session, slot: number, now: number, pulse: boolean): string {
	const palette = STATE_PALETTE[session.state];
	const bg = session.state === "awaiting" && pulse ? palette.bgAlt : palette.bg;
	const name = projectName(session.cwd);
	const nameSize = name.length <= 7 ? 27 : name.length <= 10 ? 22 : 18;
	const activity = session.state === "idle" && session.activity === null ? null : session.activity;

	return svg(
		bg,
		[
			header(session.agent, `${slot}`),
			text(SIZE / 2, 74, clip(name, 12), nameSize, palette.fg, 700),
			activity === null ? "" : text(SIZE / 2, 98, clip(activity, 15), 15, palette.fg, 500, 0.75),
			band(palette.accent, `${STATE_LABEL[session.state]} ${elapsed(session, now)}`.trim()),
		].join(""),
	);
}

/** Key for a slot that currently has no session. */
export function renderEmptySlot(filter: AgentFilter, slot: number): string {
	const label = filter === "any" ? "AGENT" : AGENT_LABEL[filter];
	const color = filter === "any" ? "#6e7681" : AGENT_COLOR[filter];
	return svg(
		"#0d1117",
		[
			`<circle cx="22" cy="22" r="5" fill="${color}" opacity="0.45"/>`,
			text(34, 27, label, 14, "#6e7681", 700, 1, "start"),
			text(SIZE - 14, 27, `${slot}`, 14, "#484f58", 700, 1, "end"),
			text(SIZE / 2, 86, "—", 30, "#30363d", 700),
		].join(""),
	);
}

/** "Needs You" key: number of sessions blocked on the user, or an overview when nothing is pending. */
export function renderAttentionKey(
	awaiting: readonly Session[],
	working: number,
	pulse: boolean,
	now: number,
): string {
	const first = awaiting[0];
	if (first !== undefined) {
		const palette = STATE_PALETTE.awaiting;
		return svg(
			pulse ? palette.bgAlt : palette.bg,
			[
				text(SIZE / 2, 30, "NEEDS YOU", 16, palette.accent, 800),
				text(SIZE / 2, 88, `${awaiting.length}`, 56, palette.fg, 800),
				text(SIZE / 2, 124, clip(`${projectName(first.cwd)} ${duration(now - first.stateSince)}`, 15), 15, palette.fg, 600, 0.85),
			].join(""),
		);
	}
	const palette = working > 0 ? STATE_PALETTE.working : STATE_PALETTE.idle;
	return svg(
		palette.bg,
		[
			text(SIZE / 2, 30, "AGENTS", 16, palette.accent, 800),
			text(SIZE / 2, 88, working > 0 ? `${working}` : "✓", 52, palette.fg, 800),
			text(SIZE / 2, 124, working > 0 ? "working" : "all clear", 16, palette.fg, 600, 0.8),
		].join(""),
	);
}

/** Static key for a saved prompt. */
export function renderPromptKey(label: string, target: PromptTarget, flash: "ok" | "fail" | null): string {
	const accent = target === "attention" ? "#f2cc60" : target === "any" ? "#8b949e" : AGENT_COLOR[target];
	const bg = flash === "ok" ? "#0d3321" : flash === "fail" ? "#5c0a10" : "#161b22";
	const targetLabel = target === "attention" ? "→ WAITING" : target === "any" ? "→ AGENT" : `→ ${AGENT_LABEL[target]}`;
	const lines = wrap(label.length > 0 ? label : "Prompt", 11, 3);
	const lineHeight = 24;
	const startY = 84 - ((lines.length - 1) * lineHeight) / 2;

	return svg(
		bg,
		[
			`<rect x="3" y="3" width="${SIZE - 6}" height="${SIZE - 6}" rx="14" fill="none" stroke="${accent}" stroke-width="3" opacity="0.7"/>`,
			text(SIZE / 2, 30, targetLabel, 14, accent, 800),
			...lines.map((line, i) => text(SIZE / 2, startY + i * lineHeight, line, 21, "#e6edf3", 700)),
		].join(""),
	);
}

export { toDataUrl } from "./svg.ts";

function header(agent: AgentKind, right: string): string {
	return [
		`<circle cx="22" cy="22" r="6" fill="${AGENT_COLOR[agent]}"/>`,
		text(35, 27, AGENT_LABEL[agent], 14, "#e6edf3", 800, 0.9, "start"),
		text(SIZE - 14, 27, right, 14, "#e6edf3", 700, 0.55, "end"),
	].join("");
}

function band(accent: string, label: string): string {
	return [
		`<rect x="0" y="${SIZE - 34}" width="${SIZE}" height="34" fill="${accent}"/>`,
		text(SIZE / 2, SIZE - 12, label, 15, "#0d1117", 800),
	].join("");
}

function elapsed(session: Session, now: number): string {
	switch (session.state) {
		case "working":
			return duration(now - (session.turnStartedAt ?? session.stateSince));
		case "awaiting":
		case "done":
		case "error":
			return duration(now - session.stateSince);
		case "idle":
			return "";
	}
}

/** Compact duration: `42s`, `3:07`, `1h12`, `3d`. */
export function duration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1_000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return `${minutes}:${String(total % 60).padStart(2, "0")}`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h${String(minutes % 60).padStart(2, "0")}`;
	return `${Math.floor(hours / 24)}d`;
}

export function wrap(value: string, width: number, maxLines: number): string[] {
	const words = value.trim().split(/\s+/u).filter((w) => w.length > 0);
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		const candidate = line.length === 0 ? word : `${line} ${word}`;
		if (candidate.length <= width || line.length === 0) {
			line = candidate;
		} else {
			lines.push(line);
			line = word;
		}
	}
	if (line.length > 0) lines.push(line);
	const clipped = lines.slice(0, maxLines).map((l) => clip(l, width));
	if (lines.length > maxLines) {
		const last = clipped[maxLines - 1] ?? "";
		if (!last.endsWith("…")) {
			const chars = [...last];
			clipped[maxLines - 1] = `${(chars.length < width ? chars : chars.slice(0, width - 1)).join("")}…`;
		}
	}
	return clipped;
}
