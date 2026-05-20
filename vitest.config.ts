import { defineConfig } from "vitest/config";

export default defineConfig({
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
