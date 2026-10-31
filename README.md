# JetDeck

Stream Deck XL plugin that turns your keys into a live control surface for terminal coding agents —
**Claude Code**, **OpenAI Codex CLI** and **GitHub Copilot CLI**.

- **See every session at a glance.** Each key shows agent, project, state and timer:
  `WORKING 3:07` · `WAITING 42s` (pulsing) · `DONE 5:12` · `ERROR` · `IDLE`, plus the running tool or pending permission.
- **Press** → jump to the exact terminal tab/split the agent runs in.
- **Hold** → approve the pending prompt (sends Enter) or interrupt the running turn (sends Esc).
- **Needs You** key counts sessions blocked on you; press jumps to the longest-waiting one, hold approves it.
- **Send Prompt** keys type a saved prompt into the most ready matching session and bring it forward.
- **System Metric** keys show live CPU (P/E cores), GPU (load, power), Neural Engine, RAM and disk with sparklines.

## How it works

```
agent hook ──stdin JSON──▶ ~/.jetdeck/bin/jetdeck-hook ──HTTP over Unix socket──▶ plugin
                                (sh + curl, ~5 ms,              (~/.jetdeck/ingest.sock, 0600)
                                 never blocks the agent)                 │
                                                       ps process tree ──┤ resolve agent pid, TTY, terminal app
                                                                         ▼
                                                     SessionStore (state machine) ──▶ SVG keys @ 4 fps
                                                                         │
                                                     AppleScript (Ghostty / Terminal.app) ◀── press / hold
```

- **One session = one agent process.** Identity is the outermost agent pid, so `/clear`, resumes and nested shims
  never duplicate keys. A process scan every 4 s picks up agents started before the plugin and drops sessions
  whose process died without a `SessionEnd`.
- **Hooks are fire-and-forget.** The plugin acknowledges with `204` before doing any work; if the plugin is down the
  hook drains stdin and exits `0`. Agent behaviour is never changed — JetDeck observes, it does not decide.
- **Sticky slots.** A session keeps its slot (1, 2, 3, …) for its whole life; new sessions take the lowest free slot.

### Terminal support

| Terminal | Jump to session | Send prompt | Approve / interrupt |
|---|---|---|---|
| Ghostty 1.4+ | exact split / tab | typed, optional submit | ✅ |
| Terminal.app | exact tab | always submitted | ✅ (Esc needs Accessibility for Stream Deck) |
| IntelliJ / VS Code terminals | app only | — | — |

Terminal detection walks the process tree, so it works regardless of `TERM_PROGRAM`.

## Install

Requirements: macOS 13+, Stream Deck app 7.1+, Node.js 24+, `curl`.

```sh
git clone https://github.com/JirakJ/jetdeck && cd jetdeck
npm ci
npm run check            # typecheck + tests + bundle
npm run hooks:install    # installs ~/.jetdeck/bin/jetdeck-hook and registers it with all three agents
npm run link             # links the plugin into Stream Deck
npm run profile:install  # adds a ready-made JetDeck page to the XL profile and makes it current
```

`hooks:install` is idempotent, keeps every existing hook and writes a `.jetdeck-backup` of each file it changes:

| Agent | File | Events |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | SessionStart, UserPromptSubmit, Pre/PostToolUse(+Failure), PermissionRequest/Denied, Notification, Elicitation(+Result), Stop, StopFailure, SessionEnd |
| Codex | `~/.codex/hooks.json` | SessionStart, UserPromptSubmit, Pre/PostToolUse, PermissionRequest, Stop, Interrupt, SessionEnd |
| Copilot CLI | `~/.copilot/hooks/jetdeck.json` | sessionStart, userPromptSubmitted, pre/postToolUse(+Failure), permissionRequest, notification, agentStop, errorOccurred, sessionEnd |

Codex requires hook trust: run `/hooks` once inside Codex and approve the JetDeck entries.
Already-running sessions pick up new hooks on their next start; until then they show as `IDLE` via the process scan.

Remove everything with `npm run hooks:uninstall`.

## Use

`npm run profile:install` writes this XL page (other pages are kept; re-running replaces only the JetDeck page):

| Row | Keys |
|---|---|
| 1 | **Needs You** · Claude 1–7 |
| 2 | Codex 1–4 · Copilot 1–4 |
| 3 | Send Prompt: Review · Run tests · Commit · Fix error · Simplify · Plan first · Status · Continue |
| 4 | CPU · GPU · ANE · RAM · Disk · Power · any agent 8–9 |

Every key is editable in the Stream Deck app: **Agent Session** has *Agent* (any / Claude / Codex / Copilot) and
*Slot*; **Send Prompt** has label, prompt text, target and submit.

The first jump or keystroke into Ghostty / Terminal triggers the macOS Automation prompt
(“Stream Deck wants to control Ghostty”) — allow it once.

`npm run status` prints what the plugin currently tracks:

```
claude   pid 81234   waiting      12s  ghostty         /dev/ttys003  /Users/me/work/jetdeck  Bash: rm -rf dist
codex    pid 80111   working     188s  apple-terminal  /dev/ttys001  /Users/me/work/api      apply_patch
```

### System metrics

`jetdeck-metrics` (`native/jetdeck-metrics.c`) is a small C sampler compiled by `npm run build` on macOS. It needs no
root and runs only while a metric key is on screen.

| Key | Value | Detail | Source |
|---|---|---|---|
| CPU | mean core active residency | P / E cluster load | IOReport *CPU Core Performance States* |
| GPU | device utilisation | power (W) · GPU memory | IOAccelerator *PerformanceStatistics*, IOReport *GPU Energy* |
| ANE | share of time the Neural Engine drives memory traffic | active / idle | IOReport *PMP / SOC Floor* (ANE AF bandwidth) |
| RAM | app + wired + compressed / installed | used / total, swap | `host_statistics64`, `vm.swapusage`; colour = memory pressure |
| Disk | used share of the boot volume | free incl. purgeable | `kCFURLVolumeAvailableCapacityForImportantUsageKey` |

| Power | package watts | CPU / GPU / ANE watts, thermal pressure | `powermetrics` (needs `npm run power:enable`) |

Apple exposes no unprivileged ANE utilisation counter, and on current macOS the per-block energy counters are frozen
for non-root processes, so ANE is reported as activity; its watts (and CPU / package power) come from `powermetrics`.

`npm run power:enable` asks for your password once and installs `/etc/sudoers.d/jetdeck-powermetrics`, allowing
exactly `powermetrics --samplers cpu_power,gpu_power,ane_power,thermal -i 1000 -f plist` without a password — no other
arguments, so `powermetrics -o FILE` (a root file write) stays protected. `npm run power:disable` removes it.

## Development

```sh
npm run watch      # rebuild on change and restart the plugin
npm test           # unit + end-to-end (real hook → socket → process table → store, in a real PTY)
npm run validate   # Stream Deck manifest validation
npm run pack       # dist/com.jakubjirak.jetdeck.streamDeckPlugin
```

Layout: `src/domain` (state machine, normalisation, slots — pure), `src/application` (ingestion, process
monitoring), `src/infrastructure` (socket server, process table, terminal control), `src/presentation` (SVG keys),
`src/actions` (Stream Deck actions), `hook/` (the agent-side hook), `scripts/` (build, hook installer, status).
