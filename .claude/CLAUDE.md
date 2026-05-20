# Octi Web

Browser client for [Octi](https://github.com/d4rken-org/octi). Pairs with the same
end-to-end encrypted [sync-server](https://github.com/d4rken-org/octi-server) as the
Android and desktop apps and renders peer device state on a dashboard.

- **Package**: `octi-web` (SPA, no backend)
- **Stack**: Svelte 5 (runes) + Vite + TypeScript (strict). pnpm for installs, vitest for tests.
- **Distribution**: tar.gz on GitHub releases, Docker image on `ghcr.io/d4rken-org/octi-web`, hosted at `web.octi.darken.eu`.

## Rules

- [Architecture](rules/architecture.md) — `src/` layout, module registry, sync poll loop, UI Tile/Sheet pattern, IndexedDB credentials
- [Code Style](rules/code-style.md) — TypeScript strict, Svelte 5 runes, package-by-feature, doc-comment policy
- [Testing](rules/testing.md) — vitest, colocated `*.test.ts`, fake-indexeddb, real-server smoke suite
- [Build Commands](rules/build-commands.md) — pnpm scripts, svelte-check, vite build
- [Commit Guidelines](rules/commit-guidelines.md) — Commit message format and examples
- [Pull Request Guidelines](rules/pull-request-guidelines.md) — PR title, description, labels (canonical ref: sdmaid-se)
- [Agent Instructions](rules/agent-instructions.md) — Common pitfalls, cross-peer interop rules, how to add a module
- [Release](rules/release.md) — `release-prepare.yml` + `release-tag.yml`, `bump.sh`, channel mapping
- [Device Capabilities](rules/device-capabilities.md) — Per-peer capability tag set: wire contract, namespaces, how to add new ones
