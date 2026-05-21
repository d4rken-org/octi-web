import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

/**
 * Smoke suite — runs against a real `octi-server` (CI services pin one;
 * locally, set `SMOKE_SERVER_URL`). Deliberately does NOT inherit the unit
 * suite's `globalSetup`: the cross-repo wire-format fixture sync is a unit-test
 * concern and we don't want raw.githubusercontent.com availability to gate
 * the smoke job.
 */
export default defineConfig({
  plugins: [svelte({ hot: false })],
  test: {
    environment: "node",
    include: ["src/__smoke__/**/*.test.ts"],
  },
});
