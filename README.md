# octi-web

Browser-based client for [Octi](https://github.com/d4rken-org/octi).
Talks directly to a user-hosted [Octi sync-server](https://github.com/d4rken-org/octi-server)
— no octi-web backend, deployable as static files to any host.

## Status

Pre-alpha. Useful enough to link to an existing Octi account from any modern browser and
round-trip MetaInfo, clipboard, and files alongside Android / desktop peers, with the same
end-to-end AES-256-GCM-SIV encryption.

| Capability | Status |
|---|---|
| Create a new account, or join an existing one (paste-link, QR scan, generate own share code) | works |
| Render every peer device with its MetaInfo (manufacturer, model, OS, app version) | works |
| Manual clipboard share (publish + read peers) | works |
| File share — upload, list across all devices, download with SHA-256 verify | works |
| 30 s foreground poll (paused when tab hidden, immediate refresh on focus / visibility change) | works |
| AES-256-GCM-SIV E2E encryption, wire-compatible with Tink keysets from the Android client | pinned by cross-language golden vectors |
| WebSocket push at `/v1/ws` | not yet (browsers can't set `Authorization` on the WS handshake) |
| Two-phase `DeleteRequest` UX | not yet |
| Auto-clipboard-watch, PWA install, read-only views for the non-Files/Clipboard/Meta modules | not yet |

## Develop

Requires Node.js 20+ and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm check        # svelte-check (types + svelte syntax)
pnpm test         # vitest (53 unit + golden-vector tests)
pnpm build        # production bundle in dist/
pnpm preview      # serve dist/ locally
```

The production bundle is ~91 KB gzipped, no runtime dependencies on remote scripts.

## Sync-server CORS

A browser SPA can only reach the sync-server if the server allows the SPA's origin.

**Default allowlist** (no flag needed — the official hosted SPA works OOB):
- `https://web.octi.darken.eu`
- `https://d4rken.github.io`
- `https://d4rken-org.github.io`

To add your own origin (e.g. local dev), override via `--cors-allowed-origins` (replaces
the defaults):

```bash
./bin/octi-server --datapath=./octi-data \
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

Requires `octi-server` with the CORS plugin
([d4rken-org/octi-server#22](https://github.com/d4rken-org/octi-server/pull/22)).

## Storage

Credentials (account ID, device password, encryption keyset, server address, device ID /
label) persist in IndexedDB under DB name `octi-web`. Use the dashboard's **Sign out**
button to wipe the database. There is no passphrase-wrap — the same trust model as the
Android client's plaintext DataStore. CSP (no remote scripts, no CDN, no analytics) is
the primary defense against XSS.

## Stack

| Layer | Choice |
|---|---|
| UI | Svelte 5 (runes) + Vite 6 |
| Language | TypeScript 5.7 |
| HTTP | native `fetch` |
| Encryption | hand-rolled Tink keyset parser + AES-256-GCM-SIV via `@noble/ciphers`, AesGcmHkdfStreaming via WebCrypto HKDF + AES-GCM |
| Compression | `fflate` (gzip module payloads, base64 LinkingData) |
| Persistence | `idb` over IndexedDB |
| QR | `jsqr` (decode), `qrcode` (encode) |
| Tests | `vitest` |

Wire types and crypto are ported from `app-main`'s `sync-core` rather than depending on it
as a module. Cross-language golden vectors (`src/crypto/__fixtures__/*.json`, emitted from
JVM Tink in [d4rken-org/octi#307](https://github.com/d4rken-org/octi/pull/307)) guard
against drift on every test run.

## Compatibility

- **Octi Server**: latest (requires the CORS plugin from PR #22).
- **Octi Android**: any version. Capability tags (octi#309 / octi-server#23) sharpen
  cross-client encryption-compat warnings but aren't required for sync to work.
- **Octi Desktop**: any version.

## License

[GPL-3.0](LICENSE), matching the rest of the Octi project.
