# Agent Instructions

## Core Principles

- Read existing code before making changes. The web client mirrors Android
  wire formats — assumptions that aren't pinned by a test almost always wrong.
- Follow existing patterns. If a new file needs the same shape as a sibling
  (e.g. another `modules/<name>.ts`), copy from the closest sibling and adapt.
- After non-trivial changes, run `pnpm check` (svelte-check) and the relevant
  `pnpm test` slice. `pnpm build` only when you've changed Vite config or
  release packaging — it duplicates `pnpm check`.
- Delegate verbose builds/tests to `devtools:build-runner` so the main
  conversation stays scannable.
- Exploring vs implementing: use read-only tools to understand the area, then
  make minimal focused edits. Don't refactor on the side.

## Adding a New Module

Mirror the Android-side module. Steps for "add module `foo`":

1. Create `src/modules/foo.ts` with:
   - `export const FOO_MODULE_ID = "eu.darken.octi.module.core.foo";` (use the
     exact ID the Android `Module.id` returns).
   - `interface FooInfo` matching the wire shape.
   - `decodeFooInfo(raw: unknown): FooInfo` — validate every required field;
     throw on shape mismatch.
   - Optional `serializeFooInfo` + `publishOwnFoo` if web also produces it.
2. Add `src/modules/foo.test.ts` pinning the JSON keys against a fixture
   captured from a real Android payload. Place fixtures next to the source
   or under a `__fixtures__/` sibling.
3. Register in `src/modules/module-registry.ts`:
   - Add to `MODULE_DEFS` with label, `defaultOrderIndex`, `defaultWide`,
     `publishedByPlatforms`, and `decode: decodeFooInfo`.
   - Pick the right `publishedByPlatforms` set (`PLATFORMS_FULL`,
     `PLATFORMS_ANDROID_DESKTOP`, `PLATFORMS_ANDROID_ONLY`).
4. Build the tile + sheet UI under `src/ui/dashboard/tiles/`:
   - `FooTile.svelte` — compact tile content (uses `Tile.svelte` shell).
   - `FooSheet.svelte` if it has a detail view; wire it into `Sheet.svelte`.
   - Reference the Android `<Foo>ModuleTile.kt` for the visual mirror.
5. Update `TileGrid.svelte` and `DashboardStub.svelte` to import + dispatch
   the new tile component. Add the per-peer state map to the dashboard.

If the module is bidirectional (we publish), add the encrypt + commit path
in `DashboardStub.svelte` next to the existing meta / clipboard publishers.

## Adding an HTTP Endpoint

1. Add the wrapper to `src/protocol/octi-api.ts` (or `blob-session.ts` if
   it's resumable upload). Always thread the call through `deviceHeaders()`
   so the standard headers — including `Octi-Device-Capabilities` — go out.
2. Throw `OctiApiError` on non-2xx so callers can branch on status code.
3. Add a test in `protocol/<file>.test.ts` that exercises the URL shape, the
   request body, and the error path. Don't mock at fetch level — use a
   stub server from `fetch-mock` if needed, or stand the request up via
   `vi.fn()`.

## Cross-repo Coordination

A wire-format change touches at least two repositories. Before merging:

- **Android** (`octi`): producer/consumer of the same module/header. New
  capability namespaces or modules land here too.
- **octi-server**: validates headers, persists per-device records, routes
  module payloads. CORS-changing or header-changing work needs a sister PR.
- **octi-desktop**: Kotlin port of the same wire format; lags Android
  slightly but should not be left behind by web.

Link sister PRs in the description so review can verify end-to-end behaviour.

## Common Pitfalls to Avoid

- **Don't bypass `protocol/`**. UI components must not call `fetch` directly
  — the headers (`X-Device-ID`, `Octi-Device-Capabilities`, auth) only stay
  consistent if everyone goes through `octi-api.ts` / `blob-session.ts`.
- **Don't ad-hoc JSON-decode peer payloads**. Use the registered decoder
  from `modules/<name>.ts`. The decoder is paired with a fixture test for a
  reason — it's the contract.
- **Don't fork the version string**. Read `OCTI_WEB_VERSION` from
  `src/version.ts`; bump `package.json` only.
- **Don't drop `Octi-Device-Capabilities`** when adding a new HTTP call. The
  server uses the most recent header value to refresh the device record;
  omitting it on a routine call leaves capability data stale. See
  [device-capabilities.md](device-capabilities.md).
- **Don't conflate `serverAddress` and `serverAdress`**. `LinkingData` uses
  the correctly-spelled key; `Credentials` uses the typo. Both ship today.
- **Don't add a new `JSON.parse` site for known wire shapes**. Add a typed
  decoder once and import it.
- **Don't introduce a new IndexedDB store inside an existing DB**. Open a
  separate DB (see `tile-layout-repo.ts`'s rationale) so schema bumps don't
  block the other repo's open connection.
- **Don't mix `let`-as-prop Svelte 4 syntax with runes**. We are Svelte 5
  runes-only; `$props()` everywhere.
- **Don't commit screenshots / assets under `dist/`** — build output is
  gitignored and rebuilt by CI.

## When in Doubt

- Look at the most recent similar change via `git log -p -- <file>`.
- Look at the Android-side equivalent in `app-main/` to confirm wire
  semantics. The two clients evolve together.
- For non-trivial multi-file changes, run `devtools:plan-codex` for a
  second-opinion review of the plan before implementing.
