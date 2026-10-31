# Security policy

JetDeck runs locally, has no network component and is designed to only *observe* coding agents. Its trust boundaries:

- `~/.jetdeck/ingest.sock` (directory `0700`, socket `0600`) — accepts hook events from your own user only.
- `~/.jetdeck/bin/jetdeck-hook` — forwards events, always exits `0`, prints nothing, so it cannot influence an agent.
- Codex `hooks.state` trust entries — written only for JetDeck's own handlers.
- `/etc/sudoers.d/jetdeck-powermetrics` (opt-in) — allows one exact `powermetrics` command line without a password.
- AppleScript automation of Ghostty / Terminal.app — focus, typing a saved prompt, Enter / Esc, only on key press.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's
[private vulnerability reporting](https://github.com/JirakJ/jetdeck/security/advisories/new) with steps to
reproduce and the affected version. You will get an answer within a few days; fixes are released as soon as they are
verified, with credit if you want it.
