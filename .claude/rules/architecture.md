# Architecture

Single-page Svelte 5 app served as static files. There is no backend in this repo —
the SPA talks to a deployed [`octi-server`](https://github.com/d4rken-org/octi-server)
over HTTPS using the same REST/encryption protocol as the Android and desktop apps.

## `src/` Layout

Packaged by feature, not by layer. Each directory is a vertical slice.

| Path | Role |
|---|---|
| `src/main.ts`, `src/App.svelte` | Bootstrap. Mounts onboarding or dashboard based on stored credentials. |
| `src/protocol/` | Sync-server REST wrappers (`octi-api.ts`), wire models (`models.ts`), resumable blob session API (`blob-session.ts`). All HTTP goes through here — UI never calls `fetch` directly. |
| `src/crypto/` | Payload AEAD (`payload.ts`, AES-256-GCM-SIV), Tink keyset parse/serialize (`tink-keyset.ts`), HKDF (`hkdf.ts`), streaming-AEAD for blobs (`streaming-aead.ts`, `blob-cipher.ts`). Wire-format compatible with the Android `PayloadEncryption` / `BlobCipher`. |
| `src/modules/` | One file per Octi module (`power`, `wifi`, `connectivity`, `clipboard`, `files`, `apps`, `meta`). Each exports `<MODULE>_MODULE_ID`, a `decode…Info`/`deserialize…Info`, and (where applicable) `publishOwn…` / `fetchPeer…` helpers. `module-registry.ts` is the single source of truth tying them together for the dashboard. |
| `src/sync/` | Foreground `poll-loop.ts` — drives periodic refresh when the tab is visible. |
| `src/storage/` | IndexedDB repos: `credentials-repo.ts` (one record per linked account), `tile-layout-repo.ts` (per-device dashboard layout). Each repo opens its own DB so schema versions evolve independently. |
| `src/ui/` | Svelte components. Top-level routes (`Onboarding`, `DashboardStub`, link/share flows). `ui/dashboard/` houses the dashboard's tile grid + per-module `tiles/` + `Sheet.svelte` detail surface. |
| `src/linking/` | Paste-link / QR linking payload (`linking-data.ts`), QR scanning helpers (`qr.ts`). |
| `src/util/` | Cross-cutting helpers (`base64`, `browser-detect`). Keep this small. |
| `src/__smoke__/` | End-to-end suite against a real sync-server. Skipped by `pnpm test`; run explicitly via `pnpm test:smoke`. |
| `src/version.ts` | Reads `package.json#version`; exposes `OCTI_WEB_VERSION` (`octi-web/<semver>`) used in the `Octi-Device-Version` HTTP header. |

## Module System (mirror of Android)

Each Octi module — power, wifi, connectivity, clipboard, files, apps, meta — has
the same shape on the wire across all clients. On web, `src/modules/<name>.ts`
exports the decoder for incoming peer payloads (and, for modules we publish from
the browser, the encoder + publish helper).

`modules/module-registry.ts` is the **single source of truth** for the dashboard:

- `MODULE_DEFS` lists every module with its label, default order, default-wide
  flag, the set of platforms that publish it, the decoder, and tile/sheet
  components.
- `defaultLayoutForPlatform()` + `mergeLayoutWithRegistry()` produce a
  `TileLayout` ({order, wide, hidden}) per device. Modules a platform doesn't
  publish are hidden by default but kept in the saved layout so the tile editor
  can un-hide them.
- `normalizePlatform()` collapses `desktop-linux` / `desktop-windows` /
  `desktop-macos` to `desktop`, so the registry's platform sets match.

Adding a new module is a registry edit + new module file + new tile components.
See [Agent Instructions](agent-instructions.md).

## Sync Flow

```
poll-loop.ts (visibility-gated, 30s default)
   │
   ▼
DashboardStub.svelte.refresh()
   │
   ├─► listDevices()                  ── /v1/devices
   │
   └─► per peer × per module:
         readModulePayload()          ── /v1/module/{id}?device-id=…
           │
           ▼
         crypto/payload.ts (gunzip + AES-GCM-SIV decrypt)
           │
           ▼
         modules/<name>.ts.decode…    ── typed model
           │
           ▼
         dashboard/tiles/…            ── render
```

- The `poll-loop` pauses on `visibilitychange` → hidden, runs an extra refresh on
  return to visible / on `focus`, and skips overlapping ticks (`inFlight` guard).
  Errors are swallowed + logged so a single bad cycle doesn't stop the loop.
- Per-module `publishOwn…` paths (currently `meta` and `clipboard`) take the
  inverse route: build → encode → `payload.ts` encrypt → `commitModule()` PUT.
- File transfers go through the resumable blob-session API in
  `protocol/blob-session.ts` — three calls (create, append, finalize), with
  streaming AEAD applied chunk-by-chunk so we never hold the full plaintext.

## Persistence

Two IndexedDB databases, both opened lazily:

- `octi-web`: `credentials` store. One `CredentialRecord` per linked account
  (server address, account UUID, device password, our device UUID, the shared
  Tink keyset bytes). `getActive()` returns the single record v1 ever has.
- `octi-web-tile-layouts`: `tile-layouts` store. Per `(accountId, deviceId)`,
  the saved `TileLayout`. Separate DB so schema migrations can move
  independently.

Sign-out (`credentialsRepo.wipeAll()` + corresponding tile-layout wipe) clears
both.

## UI Pattern

- **Onboarding split**: `Onboarding.svelte` is a tiny mode-switcher to
  `CreateAccount` / `LinkPaste` / `LinkScan`. Each finishes by writing a
  `CredentialRecord` and calling `onDone()` to flip `App.svelte` into the
  dashboard.
- **Dashboard**: `DashboardStub.svelte` owns the sync loop and per-peer state
  maps; `dashboard/TileGrid.svelte` is pure presentation given a layout +
  decoded data; `dashboard/tiles/<Module>Tile.svelte` are compact tiles;
  `dashboard/Sheet.svelte` is the detail bottom sheet that opens per tile.
- **Components are split host/stateless where it matters**: stateful container
  (collects from repo / API / Svelte stores) + pure presentation child taking
  decoded data via `$props`. Use Svelte 5 runes (`$state`, `$props`,
  `$derived`) — no Svelte 4 `let`-export syntax.

## Wire Compatibility

The web client must produce byte-identical wire output for shared formats —
otherwise Android / desktop peers can't read what we publish (and vice versa).
Hot spots:

- `protocol/octi-api.ts` HTTP headers (`X-Device-ID`, `Octi-Device-Platform`,
  `Octi-Device-Version`, `Octi-Device-Label`, `Octi-Device-Capabilities`,
  `Authorization`). See [device-capabilities.md](device-capabilities.md).
- `crypto/payload.ts` framing: `0x01 || keyId(4 BE) || nonce(12) || ct+tag`,
  with `AD = UTF-8("${targetDeviceId}:${moduleId}")`. Pinned by
  `payload.test.ts` via Tink-generated fixtures.
- `linking/linking-data.ts` outer key is `serverAddress` (correctly spelled),
  but `Credentials` on wire is `serverAdress` (typo). Don't conflate.
- Each `modules/<name>.ts` decoder is paired with a backward-compat test that
  pins the JSON keys the Android client emits.
