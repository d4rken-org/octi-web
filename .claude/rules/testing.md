# Testing

## Framework

- **vitest** for everything. Tests live next to the source as `*.test.ts`,
  picked up by `vitest.config.ts`'s `src/**/*.test.ts` include.
- Default environment is `node`. Tests that need DOM / IndexedDB opt in with
  the `// @vitest-environment jsdom` pragma at the top of the file.
- No global setup file — each test imports what it needs (`fake-indexeddb/auto`,
  fixtures, etc.).

## Patterns

```ts
// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { CredentialsRepo } from "./credentials-repo";

describe("CredentialsRepo", () => {
  beforeEach(async () => {
    localStorage.clear();
    await new CredentialsRepo().wipe();
  });

  it("save → getActive roundtrips all fields", async () => {
    // arrange / act / assert
  });
});
```

- Per-file isolation: `beforeEach` clears the DB / storage rather than relying
  on global state. Vitest runs files in parallel so cross-file state leakage
  is its own debugging hell.
- Use real implementations where cheap: `fake-indexeddb` for repo tests, real
  noble-ciphers + Tink parsing for crypto tests. Mock only when the real
  dependency is network or non-deterministic.

## Wire-format Tests

Each file that produces or consumes a network byte/JSON shape has a paired
test that pins the format:

- `protocol/octi-api.test.ts`, `protocol/blob-session.test.ts` — REST shapes.
- `protocol/capabilities.test.ts` — `OCTI_WEB_CAPABILITIES` invariants (regex,
  sort, header size). Must stay green or the sync-server validator rejects us.
- `crypto/payload.test.ts`, `crypto/streaming-aead.test.ts`, `crypto/tink-keyset.test.ts`
  — wire bytes vs Tink/Android fixtures fetched from
  [`d4rken-org/octi`](https://github.com/d4rken-org/octi) at the commit SHA pinned
  in `fixture-lock.json`. `tools/sync-fixtures.ts` is wired as vitest `globalSetup`,
  so any `pnpm test` invocation refreshes the cache before tests run; explicit
  `pnpm fixtures:sync` does the same thing manually. Loader + materialization
  helpers live at [`src/__interop__/fixture-loader.ts`](../../src/__interop__/fixture-loader.ts).
  Regenerate fixtures upstream in app-main and bump the lockfile here — never
  edit cached files.
- `__interop__/desktop-{meta,clipboard,files}.test.ts` — same idea pointing at
  the second source. Fetched from
  [`d4rken-org/octi-desktop`](https://github.com/d4rken-org/octi-desktop) at the
  SHA pinned in `fixture-lock.json#sources["d4rken-org/octi-desktop"]`. Pins the
  per-module wire shape octi-desktop emits (`SharedFile.blobKey` is a plain UUID
  here, not `sha256:<hex>` like web/android).
- `modules/<name>.test.ts` — backward-compat JSON for each module.
- `linking/linking-data.test.ts` — gzip + base64 link payload.
- `__interop__/published-self-check.test.ts` — pins what octi-web publishes
  for app-main and octi-desktop to consume. Re-runs the generator
  (`tools/generate-fixtures.ts`) and asserts the committed
  `src/__interop__/published/{manifest, octi-web-{meta,clipboard,files}}.json`
  files are byte-equal to fresh output. Regenerate via `pnpm fixtures:generate`
  after touching `serializeXxxInfo` or the canonical inputs in the generator.

### Multi-source `fixture-lock.json`

Schema v2 — one entry per upstream producer. Cache laid out as
`.cache/interop-fixtures/<owner>/<repo>/<sha>/` (gitignored). The parser also
accepts the legacy v1 flat shape so a hand-edit revert during the migration
window still parses.

```json
{
  "schemaVersion": 2,
  "sources": {
    "d4rken-org/octi":         { "ref": "<sha40>", "manifest_sha256": "<sha256>" },
    "d4rken-org/octi-desktop": { "ref": "<sha40>", "manifest_sha256": "<sha256>" }
  }
}
```

To bump one source, change its `ref` and recompute `manifest_sha256` via
`sha256sum` on the manifest at that SHA. The other source stays anchored.

When changing wire format intentionally, update the fixture in a dedicated
commit so the diff is reviewable in isolation.

## Upstream gating (this repo's CI)

`.github/workflows/cross-repo-verify.yml` runs on every PR. On PRs that touch
the allowlisted wire-format paths (`src/modules/`, `src/__interop__/published/`,
`tools/generate-fixtures.ts`, and the workflow itself), it checks out app-main
and octi-desktop at their default branches and runs their consumer suites
against this PR's HEAD using the `INTEROP_FIXTURE_OVERRIDES` env var the
consumer sync code already accepts (sister gates: app-main's
`.github/workflows/cross-repo-verify.yml`, A3 / B-phase). A wire-incompatible
serializer change is blocked at the octi-web PR, not discovered later when a
consumer happens to bump its pin.

PRs that don't touch the allowlist still run the workflow but echo "no
wire-format-relevant paths changed; consumer verify will be skipped." and
exit 0 — required-check status reports green without leaving the check pending.

The override path drops the locked `manifest_sha256` as a trust anchor (no
committed sha can pin against an arbitrary head SHA) — per-file sha256s in the
consumer's freshly-fetched manifest stay as the anchor for that run.

### Fork PR limitation

Cross-repo `actions/checkout` of `${{ github.event.pull_request.head.sha }}`
works for same-repo branch PRs but NOT for fork PRs: the consumer's
`raw.githubusercontent.com` fetch of a fork-only SHA returns 404 against the
upstream's path. Fork contributors get a clear failure in the verify job.
Same constraint exists for any GitHub Actions secret access, so this is not
a new restriction — same gate behaviour as app-main and octi-desktop's
sister workflows.

## Smoke Suite

`src/__smoke__/smoke.test.ts` is excluded from the default `pnpm test` (the
unit suite shouldn't depend on a running server). Run it via:

```bash
pnpm test:smoke          # expects SMOKE_SERVER_URL set
```

CI runs it against a pinned `ghcr.io/d4rken-org/octi-server@sha256:…` service
in `.github/workflows/code-checks.yml`. The digest is pinned deliberately —
bumping it is a conscious "we're testing against the newer server" change.

To run locally:

```bash
docker run --rm -p 18080:8080 \
  -e OCTI_CORS_ALLOWED_ORIGINS=http://127.0.0.1 \
  ghcr.io/d4rken-org/octi-server:latest
SMOKE_SERVER_URL=http://127.0.0.1:18080 pnpm test:smoke
```

## Assertions

- Use vitest's built-in `expect(...).toBe(...)` / `toEqual(...)` /
  `toMatchObject(...)`. No external assertion library.
- For async error assertions: `await expect(fn()).rejects.toThrow(...)`.
- Snapshot tests aren't used today and shouldn't be added casually — they
  drift silently and reviewers stop reading them. Prefer explicit assertions.

## Context Management

Build/test commands are noisy. When running `pnpm build`, `pnpm test`, or
`pnpm test:smoke` from an agent, prefer the `devtools:build-runner` agent so
the verbose Vite / svelte-check output stays out of the main context. Run
directly only when the user explicitly asks for full output.
