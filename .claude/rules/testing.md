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
- `crypto/payload.test.ts` — wire bytes vs Tink/Android fixtures in
  `crypto/__fixtures__/`. Regenerate fixtures via the Android-side
  `TinkVectorsExportTest`; never tweak by hand.
- `modules/<name>.test.ts` — backward-compat JSON for each module.
- `linking/linking-data.test.ts` — gzip + base64 link payload.

When changing wire format intentionally, update the fixture in a dedicated
commit so the diff is reviewable in isolation.

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
