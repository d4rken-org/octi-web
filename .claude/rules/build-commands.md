# Build Commands

`pnpm` is the only supported package manager (pinned via `packageManager` in
`package.json` to keep CI deterministic). Node 24 — see
`.github/actions/common-setup/action.yml`.

## Install

```bash
pnpm install                  # --frozen-lockfile in CI
```

## Dev Server

```bash
pnpm dev                      # http://localhost:5173 with HMR
```

The dev server is configured in `vite.config.ts`. To run against a local
sync-server, also add `http://localhost:5173` to the server's
`OCTI_CORS_ALLOWED_ORIGINS` (see the project README).

## Type Check

```bash
pnpm check                    # svelte-check, no build artifact
```

This is the same command CI runs in the `Type check` job and is the fast
first signal — typos and prop-name mismatches in Svelte components surface
here.

## Tests

```bash
pnpm test                     # vitest run — unit suite only (no smoke)
pnpm test:watch               # vitest --watch
pnpm test:smoke               # __smoke__/* against a real sync-server
```

Smoke requires `SMOKE_SERVER_URL` — see [testing.md](testing.md#smoke-suite).

## Production Build

```bash
pnpm build                    # svelte-check && vite build → dist/
pnpm preview                  # serve the dist/ output for sanity check
```

`pnpm build` runs `svelte-check` first so a typing regression fails fast
without spending Vite time. The release pipeline (`release-tag.yml`) tars
`dist/` into `octi-web-<version>.tar.gz` and also publishes a Docker image
that serves the same bundle.

## Versioning

- Source of truth is `package.json#version` (read by `src/version.ts` via
  `resolveJsonModule`). Never duplicate the version string elsewhere.
- Format: `M.m.p` or `M.m.p-(rc|beta)N`, fields capped 0..99. See
  [release.md](release.md) for the bump workflow.
- `tools/release/bump.sh` is the parser/writer; `tools/release/bump.bats`
  pins its behaviour. Both run in CI under the `Release tooling` job.

## Context Management

When invoking these from inside an agent session, use the
`devtools:build-runner` Task agent so verbose Vite / svelte-check output stays
out of the main conversation. The sub-agent should report back:

- Success or failure
- Type/lint errors with file paths and line numbers
- Test failures with the failing assertion

Run gradle-equivalent commands directly in the main context only when the
user explicitly requests full output.
