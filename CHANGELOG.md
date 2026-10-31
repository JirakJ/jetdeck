# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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
