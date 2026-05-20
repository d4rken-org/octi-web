<img src=".github/featureGraphic.jpg" width="400">

# Octi Web

[![GitHub release (latest SemVer including pre-releases)](https://img.shields.io/github/v/release/d4rken-org/octi-web?include_prereleases)](https://github.com/d4rken-org/octi-web/releases/latest)
[![Code tests & eval](https://github.com/d4rken-org/octi-web/actions/workflows/code-checks.yml/badge.svg)](https://github.com/d4rken-org/octi-web/actions/workflows/code-checks.yml)
[![License: GPL v3](https://img.shields.io/github/license/d4rken-org/octi-web)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Octi-5865F2?logo=discord&logoColor=white)](https://discord.gg/s7V4C6zuVy)

A browser client for [Octi](https://github.com/d4rken-org/octi), so all your devices
stay in reach even when your phone isn't. Pairs with the same end-to-end encrypted
[sync-server](https://github.com/d4rken-org/octi-server) as the Android and desktop apps.

## Use

### With the official Octi server

The Octi server I host (the one the published Android/Desktop apps talk to) only
accepts browser traffic from **[web.octi.darken.eu](https://web.octi.darken.eu)**. Open
that URL in any modern browser and pair via paste-link or QR — your existing Octi account
"just works."

A self-hosted copy of Octi Web *cannot* reach the official server.

### With a self-hosted sync-server

If you run your own [octi-server](https://github.com/d4rken-org/octi-server) you have
two options: point the hosted SPA at it (no install needed — `web.octi.darken.eu` is in
`octi-server`'s default CORS allowlist), or run your own copy of the SPA.

#### Run your own SPA

Download `octi-web-<version>.tar.gz` from the
[latest release](https://github.com/d4rken-org/octi-web/releases/latest), extract, and
serve with any static host:

```bash
tar xzf octi-web-*.tar.gz
python3 -m http.server -d dist 8080
# or: nginx, caddy, GitHub Pages, S3 + CloudFront, …
```

Or run the Docker image:

```bash
docker run -p 8080:80 ghcr.io/d4rken-org/octi-web:latest
```

#### Sync-server CORS

A browser SPA can only reach the sync-server if the server allows the SPA's origin.

**Default allowlist** (no flag needed):
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

#### Mixed-content caveat

Browsers block HTTPS pages from talking to plain HTTP servers. If your sync-server is
HTTP-only (LAN setup), serve your own SPA over HTTP on the same network — the public
`web.octi.darken.eu` is HTTPS and can only reach HTTPS sync-servers.

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

## License

Octi Web's code is available under a [GPL v3](LICENSE) license, this excludes:

* Octi icons, logos, mascots, marketing materials and assets.
* Octi animations and videos.
* Octi documentation.
* Translations.

## Octi family

* [Octi](https://github.com/d4rken-org/octi) — the Android app.
* [Octi Server](https://github.com/d4rken-org/octi-server) — the end-to-end encrypted sync-server.
* [Octi Web](https://github.com/d4rken-org/octi-web) — this browser client.
* [Octi Desktop](https://github.com/d4rken-org/octi-desktop) — Compose Multiplatform desktop client (Linux / macOS / Windows).
