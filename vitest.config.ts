import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Component tests import `.svelte` files directly. Under Vitest, seed Vite's
  // client environment for the Svelte plugin's CSS preprocessor and resolve
  // Svelte's browser entry so `mount()` is available in jsdom.
  environments: {
    client: {},
  },
  resolve: {
    conditions: ["browser"],
  },
  // The svelte plugin compiles `.svelte` and `.svelte.ts` files so vitest can
  // load runes-based modules (notably `ConnectorManager` in
  // `src/sync/connector-manager.svelte.ts`). Without this, `$state` /
  // `$derived` blow up at module load with `$state is not defined`.
  plugins: [svelte({ hot: false })],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The smoke suite has its own config (vitest.smoke.config.ts) — exclude it
    // here so `pnpm test` doesn't try to run it without a configured server.
    exclude: ["node_modules/**", "src/__smoke__/**"],
    // Fetch + verify the cross-repo wire-format fixtures from d4rken-org/octi at
    // the SHA pinned in fixture-lock.json before any test runs. Idempotent —
    // the sync skips network access when the local cache already matches.
    // Smoke tests do NOT load this (separate config) — they hit a real
    // sync-server and shouldn't be coupled to raw.githubusercontent.com.
    globalSetup: ["./tools/sync-fixtures.ts"],
  },
});
