# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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
