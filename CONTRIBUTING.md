# Contributing to JetDeck

Thanks for helping! Bug reports, terminal integrations and layouts for other Stream Deck models are especially welcome.

## Setup

```sh
git clone https://github.com/JirakJ/jetdeck && cd jetdeck
npm ci --include=dev
npm run link        # links your checkout into Stream Deck
npm run watch       # rebuilds on change and restarts the plugin
```

Requirements: macOS 13+, Node.js 24+, Xcode Command Line Tools, Stream Deck app 7.1+.

## Before you open a pull request

```sh
npm run check       # typecheck + build (incl. the native sampler on macOS) + all tests
npm run validate    # Stream Deck manifest validation
```

- **Tests exercise real behaviour.** Prefer real processes, sockets and files over mocks (see
  `test/integration/`). Pure logic lives in `src/domain` and is unit-tested there.
- **Keep the layers clean.** `domain` has no I/O; `application` orchestrates; `infrastructure` talks to the OS;
  `presentation` only turns state into SVG; `actions` bind it to Stream Deck.
- **The hook must stay harmless.** `hook/jetdeck-hook` must never print, block, fail or alter agent behaviour.
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:` …).
- **User-visible changes** get a line in `CHANGELOG.md`; if keys change, run `npm run docs:images`.

## Adding a terminal

Implement focus / text / key support in `src/infrastructure/terminal-controller.ts`, detect it in
`src/infrastructure/process-table.ts`, add a row to the README table and test it against the real application.

## Releasing (maintainers)

Bump `package.json`, the manifest `Version`, the profile plugin version and `CHANGELOG.md`, then:

```sh
npm run check && npm run pack
git tag -a vX.Y.Z -m "JetDeck X.Y.Z" && git push origin vX.Y.Z
gh release create vX.Y.Z dist/com.jakubjirak.jetdeck.streamDeckPlugin --notes-file <changelog section>
```
