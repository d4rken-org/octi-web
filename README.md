<img src=".github/featureGraphic.jpg" width="400">

# Octi Web

[![GitHub release (latest SemVer including pre-releases)](https://img.shields.io/github/v/release/d4rken-org/octi-web?include_prereleases)](https://github.com/d4rken-org/octi-web/releases/latest)
[![Code tests & eval](https://github.com/d4rken-org/octi-web/actions/workflows/code-checks.yml/badge.svg)](https://github.com/d4rken-org/octi-web/actions/workflows/code-checks.yml)
[![License: GPL v3](https://img.shields.io/github/license/d4rken-org/octi-web)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Octi-5865F2?logo=discord&logoColor=white)](https://discord.gg/s7V4C6zuVy)

A browser client for [Octi](https://github.com/d4rken-org/octi), so all your devices
stay in reach even when your phone isn't. Pairs with the same end-to-end encrypted
[sync-server](https://github.com/d4rken-org/octi-server) as the Android and desktop apps.

## Install

### Use the hosted version
Open **[web.octi.darken.eu](https://web.octi.darken.eu)** in any modern browser. Pair with
your phone via paste-link or QR — your existing Octi account "just works."

### Self-host (static)
Download `octi-web-<version>.tar.gz` from the
[latest release](https://github.com/d4rken-org/octi-web/releases/latest), extract, and
serve with any static host:

```bash
tar xzf octi-web-*.tar.gz
python3 -m http.server -d dist 8080
# or: nginx, caddy, GitHub Pages, S3 + CloudFront, …
```

### Self-host (Docker)
```bash
docker run -p 8080:80 ghcr.io/d4rken-org/octi-web:latest
```

### Mixed-content caveat
Browsers block HTTPS pages from talking to plain HTTP servers. If your sync-server
is HTTP-only (LAN setup), use the Docker or static self-host options served over HTTP
on the same network — the public **web.octi.darken.eu** is HTTPS and can only reach
HTTPS sync-servers.

## Features

- Pair with phone/desktop via paste-link or QR scan; generate your own share code to
  invite a new device.
- Per-device cards mirroring the Android UI: clipboard, files, apps, wifi, power,
  connectivity. Click any tile for a detail sheet with copyable fields.
- File share: drag-and-drop upload, list across all devices, download with SHA-256
  verification.
- End-to-end encrypted (AES-256-GCM-SIV, Tink-keyset-compatible with Android peers).
- No web backend of its own — only your sync-server, the browser, and the static SPA
  bytes. Strict Content-Security-Policy: no remote scripts, no CDN, no analytics.

Hungry for details? [Check the Octi wiki](https://github.com/d4rken-org/octi/wiki).
Still have questions? [Join us on Discord](https://discord.gg/s7V4C6zuVy)!

## Sync-server CORS

A browser SPA can only reach the sync-server if the server allows the SPA's origin.

**Default allowlist** (no flag needed — the official hosted SPA works out of the box):
- `https://web.octi.darken.eu`
- `https://d4rken.github.io`
- `https://d4rken-org.github.io`

To add your own origin (e.g. local dev), override via `--cors-allowed-origins`
(replaces the defaults):

```bash
./bin/octi-server --datapath=./octi-data \
  --cors-allowed-origins=https://web.octi.darken.eu,http://localhost:5173
```

Requires `octi-server` with the CORS plugin
([d4rken-org/octi-server#22](https://github.com/d4rken-org/octi-server/pull/22)).

## Compatibility

- **Octi Server**: latest (CORS plugin from PR #22 required).
- **Octi Android / Desktop**: any recent version. Capability tags
  ([octi#309](https://github.com/d4rken-org/octi/pull/309) /
  [octi-server#23](https://github.com/d4rken-org/octi-server/pull/23)) sharpen
  cross-client compatibility warnings but aren't required for sync to work.

## Develop

Requires Node 22+ and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm check        # svelte-check (types + svelte syntax)
pnpm test         # vitest (unit + golden-vector tests)
pnpm test:smoke   # E2E against SMOKE_SERVER_URL (skipped if unset)
pnpm build        # production bundle in dist/
pnpm preview      # serve dist/ locally
```

Releases are cut via the **Release prepare** workflow in the Actions tab — see its input
descriptions for the dispatch UX.

## License

[GPL-3.0](LICENSE), matching the rest of the Octi project.
