# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.3.0] - 2026-10-31

### Added
- `hooks:install` trusts JetDeck's own Codex hooks automatically by writing the same `hooks.state` entries Codex
  `/hooks` writes (hash reproduced byte for byte); uninstall removes them. No manual `/hooks` step any more.
- One-line installer: `curl -fsSL https://raw.githubusercontent.com/JirakJ/jetdeck/main/install.sh | sh`.
- Public documentation: README with rendered key images, architecture, security model, troubleshooting;
  CONTRIBUTING, SECURITY, issue and PR templates; `npm run docs:images` renders the images with the real renderers.
- CI on macOS (native sampler, tests, manifest validation) and Linux.

### Changed
- Licensed under MIT.

## [1.2.0] - 2026-10-31

### Added
- **Power** metric: package watts with CPU / GPU / ANE breakdown and thermal pressure (key turns amber / red when
  macOS throttles); the ANE key shows Neural Engine watts, the CPU key CPU watts.
- `npm run power:enable | power:disable | power:status`: installs a sudoers rule that allows exactly one pinned
  `powermetrics` command without a password; any other `powermetrics` arguments (e.g. `-o`, which writes files as root)
  still require the password.
- `jetdeck-metrics` reads the `powermetrics` plist stream on a background thread, drops stale readings after 3.5 s and
  retries every 30 s, so enabling power later needs no restart.
- Profile row 4: CPU · GPU · ANE · RAM · Disk · Power · any agent 8–9.

## [1.1.0] - 2026-10-31

### Added
- **System Metric** action: live CPU (P/E cores), GPU (load, power, memory), Neural Engine activity, RAM (coloured by
  macOS memory pressure, swap shown) and disk (free space incl. purgeable) with a 48-second sparkline; press opens
  Activity Monitor.
- `jetdeck-metrics`: native universal (arm64 + x86_64) C sampler built from IOReport, IOKit and Mach host statistics;
  no root, ~1 sample/s, runs only while a metric key is visible and exits with the plugin.
- Profile row 4 now shows CPU · GPU · ANE · RAM · Disk next to three overflow agent slots.

### Fixed
- `profile:install` waits for Stream Deck to exit (and kills a hung shutdown) before writing the profile.

## [1.0.0] - 2026-10-31

### Added
- **Agent Session** action: live state (idle / working / waiting / done / error), project, running tool or pending
  permission and timers for Claude Code, Codex and Copilot CLI sessions; press jumps to the exact terminal,
  hold approves a pending prompt or interrupts the running turn.
- **Needs You** action: count of sessions waiting for the user; press jumps to the longest-waiting session, hold approves it.
- **Send Prompt** action: types a saved prompt into the most ready matching session and focuses it.
- `jetdeck-hook`: zero-dependency `sh` + `curl` hook forwarding agent hook payloads over a user-private Unix socket.
- Hook installer for Claude Code, Codex and Copilot CLI (idempotent, backups, uninstall).
- Process-table resolution of agent pid, TTY and hosting terminal; periodic discovery and cleanup of sessions.
- Ghostty (AppleScript, exact split/tab) and Terminal.app control; app-level focus for IntelliJ and VS Code terminals.
- `npm run status` to inspect tracked sessions.
- `npm run profile:install`: ready-made, non-destructive XL page with the full layout.
