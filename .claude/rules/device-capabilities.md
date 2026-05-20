# Device Capabilities

Web declares its per-peer feature capabilities via the `Octi-Device-Capabilities` HTTP header.
The data is consumed by Android peers (`octi#309`) and persisted by the sync-server
(`octi-server#23`). Today, web is producer-only — we don't yet read other peers' capability
sets ourselves.

## Wire contract (cross-platform)

The contract is shared by **all four** implementations (this web client, Android, desktop,
sync-server). Drift here breaks interop.

### Tag format

- `<namespace>:<value>` — ASCII, lowercase namespace.
- Regex: `/^[a-z][a-z0-9]*:[A-Za-z0-9._\-]+$/`
- Marker convention: `<namespace>:_reported` — emitted by any producer that participates in a
  namespace. Distinguishes "I don't speak this namespace" (no marker) from "I speak it and
  explicitly don't support this value" (marker present, value absent).

### Limits

| Limit | Value |
|---|---|
| Max tags per device | 64 |
| Max length per tag | 128 chars |
| Max header byte length | 4096 |

The sync-server validator rejects the **whole set** on any bad tag (no partial acceptance) —
we must produce valid output every time. Our `capabilities.test.ts` pins this.

### Wire transport

- **Outbound**: `Octi-Device-Capabilities` HTTP header on every authenticated request.
  Value is a JSON-stringified `Array<string>`, canonically **sorted**.
- **Inbound**: not consumed by web today. A future feature that needs to know whether a peer
  can decrypt a given mode would read the same field from the device-list response (each
  device entry has a `capabilities` JSON array).

## Where the code lives

| File | Role |
|---|---|
| `src/protocol/octi-api.ts` | `OCTI_WEB_CAPABILITIES` — frozen, sorted source of truth for our declared tags. `OCTI_WEB_CAPABILITIES_HEADER` — the serialized header value. Sent by `deviceHeaders()` on every authenticated request. |
| `src/protocol/blob-session.ts` | Also sends `Octi-Device-Capabilities` so blob uploads update the same per-device record on the server |
| `src/protocol/capabilities.test.ts` | Pins the format invariants: tags match the cross-platform regex, set is canonically sorted, header stays within size limits, encryption marker + value tags present |

## What web declares today

```ts
// src/protocol/octi-api.ts
export const OCTI_WEB_CAPABILITIES: readonly string[] = Object.freeze(
  ["encryption:AES256_GCM_SIV", "encryption:_reported"].sort(),
);
```

- `encryption:AES256_GCM_SIV` — web's payload crypto only ships GCM-SIV (no SIV fallback).
- `encryption:_reported` — the authority marker, says "this device authoritatively reports
  its encryption capabilities". Android peers without this marker fall back to a version
  heuristic; with it, our tag set is treated as authoritative regardless of platform.

## Adding a new capability namespace

If web gains a feature that other peers should be able to detect:

1. **Add tags to `OCTI_WEB_CAPABILITIES`** in `octi-api.ts`:
   ```ts
   export const OCTI_WEB_CAPABILITIES: readonly string[] = Object.freeze(
     [
       "encryption:AES256_GCM_SIV",
       "encryption:_reported",
       "newns:_reported",
       "newns:some-value",
     ].sort(),
   );
   ```

2. **Extend `capabilities.test.ts`** with assertions for the new namespace.

3. **Coordinate cross-repo**: the namespace becomes meaningful only once at least one
   *consumer* (Android `Capability.kt` or sync-server-side reader) recognises it. Without a
   consumer, the tags are just bytes on the wire — not harmful, but useless.

If web later needs to *consume* peer capabilities (e.g. to suppress a UI hint when a peer
can't read what we wrote), add a reader that fetches `GET /v1/devices`, validates the
returned `capabilities` array with the same regex/limits, and applies the authority rules:

| Peer state | Verdict |
|---|---|
| `capabilities` field missing/null | Unknown |
| Array present, `<ns>:_reported` absent | Namespace unknown for this peer |
| Array present, `<ns>:_reported` present, `<ns>:value` absent | Known-unsupported |
| Array present, `<ns>:_reported` present, `<ns>:value` present | Known-supported |

## Cross-references

- **Android** (worked example): `app-main/.claude/rules/device-capabilities.md`.
- **Desktop** (Kotlin port): `app-desktop/.claude/rules/device-capabilities.md`.
- **Server** (parse + echo): `sync-server/.claude/rules/device-capabilities.md` and
  `parseCapabilitiesHeader` in `HttpExtensions.kt`.

Sister PRs: [octi#309](https://github.com/d4rken-org/octi/pull/309),
[octi-server#23](https://github.com/d4rken-org/octi-server/pull/23). Web-side implementation
landed on `feature/onboarding` (commit `5ff5fd7`).
