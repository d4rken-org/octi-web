# Code Style

## General Principles

- Package by feature, not by layer. New code belongs next to the feature it
  serves, not in a `helpers/` or `services/` dumping ground.
- Prefer adding to an existing file over creating a new one. Only split when a
  file grows a second responsibility, not pre-emptively.
- Write minimal, concise code. Don't add layers, abstractions, or options that
  don't yet have a second caller.
- Cancel-able async work should respect `AbortSignal` where the upstream
  (`fetch`, `setTimeout`) supports it; the dashboard's poll loop is the
  canonical example.
- Don't comment obvious code. Add a comment only when the WHY is non-obvious:
  a wire-format quirk, a workaround for a known platform bug, an invariant that
  isn't visible from the type signature. The `serverAdress` typo in
  `protocol/models.ts` is a textbook case.

## TypeScript

- `tsconfig.json` is `strict` + `noUnusedLocals` + `noUnusedParameters` +
  `noFallthroughCasesInSwitch` + `verbatimModuleSyntax`. Imports of types must
  use `import type { … }` — the build will fail otherwise.
- `moduleResolution: bundler`, `target: ES2022`. Use modern syntax (top-level
  await, `Array.prototype.at`, nullish coalescing) without polyfills.
- No `any`. Prefer narrow generics + `unknown` for opaque payloads, then
  validate at the decoder boundary.
- Use `readonly`, `Object.freeze`, and `as const` for invariants the rest of
  the codebase relies on (e.g. `OCTI_WEB_CAPABILITIES`).
- Decoders that take `unknown` (post-`JSON.parse` peer data) must validate the
  required fields and throw a descriptive `Error` on shape mismatch — never
  silently coerce. The dashboard catches per-module decode errors and renders
  the `error` tile state.

## Svelte 5

- Use **runes** exclusively: `$state`, `$derived`, `$props`, `$effect`. No
  Svelte 4 `let`-as-prop or store contracts in component code (plain reactive
  state inside components is fine; long-lived shared state lives in a TS
  module that exposes a small typed API).
- Props are typed with the destructuring `$props` form:
  ```svelte
  let { record, onSignOut }: { record: CredentialRecord; onSignOut: () => void } = $props();
  ```
- Side effects in components go in `$effect` or `onMount` / `onDestroy`. Don't
  reach into reactive state from outside the component (no exported writable
  stores from .svelte files).
- Split stateful host / pure presentation when the same view is reachable from
  multiple entry points or has a Storybook-like preview need. Don't pre-split
  for components that only render once.
- Compact tiles vs detail sheets: per-module `tiles/<Module>Tile.svelte` is the
  grid cell (uses `Tile.svelte` shell), `dashboard/Sheet.svelte` opens the
  module-specific detail body. Mirror the Android `<Module>ModuleTile.kt` /
  detail layout.

## Wire-format Code

- Anything that crosses the network has a paired `*.test.ts` next to it. The
  test pins the JSON keys / byte layout against fixtures generated from the
  Android side (`TinkVectorsExportTest`, etc.). When changing the encoding
  side, update the fixture deliberately, never in the same commit as the
  consumer change.
- Inject the `version` string from `src/version.ts`; don't hard-code
  `octi-web/x.y.z` anywhere except `package.json`.
- HTTP requests go through `src/protocol/`. UI components never call `fetch`
  themselves — wrap the call there so headers (`X-Device-ID`,
  `Octi-Device-Capabilities`, auth) stay consistent.

## Error Handling

- The protocol layer throws `OctiApiError` with status + path + body so
  callers can branch on HTTP code. Don't downgrade to `Error` — losing the
  status information makes the dashboard's retry logic guess.
- Background tasks (the poll loop, file-transfer chunks) log and continue.
  Foreground actions surface errors to the user via component-local error
  state.
- Don't add try/catch for scenarios that can't happen. Only validate at system
  boundaries (decoded wire data, user-pasted input).
