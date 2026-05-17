# octi-web

Browser-based Octi client. Talks directly to a user-hosted Octi sync-server — no octi-web backend.

## Status

**M1 scaffold.** Crypto, account creation, device list, clipboard, files all land in later milestones (see `/home/darken/.claude/plans/together-with-codex-i-joyful-river.md`).

## Develop

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm check        # svelte-check (types + svelte syntax)
pnpm build        # production bundle in dist/
pnpm test         # vitest (added in M2)
```

## Sync-server CORS

A browser SPA can only reach the sync-server if the server allows the SPA's origin.

**Default allowlist** (no flag needed — the official hosted SPA works OOB):
- `https://web.octi.darken.eu`
- `https://d4rken.github.io`
- `https://d4rken-org.github.io`

To add your own origin (e.g. local dev), override via `--cors-allowed-origins` (replaces the defaults):

```bash
./bin/octi-server --datapath=./data \
  --cors-allowed-origins=https://web.octi.darken.eu,http://localhost:5173
```

Or via Docker (env var maps to the flag):

```bash
docker run -e OCTI_CORS_ALLOWED_ORIGINS=https://web.octi.darken.eu,http://localhost:5173 \
  -v octi-data:/etc/octi-server -p 8080:8080 ghcr.io/d4rken-org/octi-server
```

To disable browser access entirely (Android/desktop clients only):
`--cors-allowed-origins=` (empty value).

Origins must look like `scheme://host[:port]` — no trailing slash, no wildcards.

## Storage

Credentials (account ID, device password, encryption keyset, server address, device ID/label) are
persisted to IndexedDB under DB name `octi-web`. Use the Settings screen's "Sign out (wipe)"
button to clear the database.
