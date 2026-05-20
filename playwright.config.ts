import { defineConfig } from "@playwright/test";

/**
 * Playwright config for octi-web's release-time E2E + screenshot capture.
 *
 * Two specs live under `tests/e2e`:
 *   - `link-and-capture.spec.ts` — full screenshot capture run. Writes PNGs to
 *     `screenshots/`. Drives stable selectors + `data-screenshot-ready` waits.
 *   - `smoke.spec.ts`             — non-screenshot smoke that runs on every PR/
 *     main push. Asserts the link-and-decode happy path against a real
 *     sync-server. Cheap; doesn't write any artifacts.
 *
 * Both depend on a `bootstrap-peer.json` file produced by
 * {@code tools/screenshots/bootstrap-peer.ts}, surfaced via the
 * {@code BOOTSTRAP_PEER_FILE} env var.
 *
 * The {@code webServer} block boots `vite preview` against the prebuilt
 * `dist/`. CI builds with the right {@code VITE_*} env vars first, then runs
 * Playwright separately so both the build and the test surface failures
 * independently.
 */

export default defineConfig({
  testDir: "tests/e2e",
  reporter: "list",
  fullyParallel: false,
  workers: 1,
  // Reasonable per-test wall-time. Link + first decode against a real server
  // is the slowest path; the timeout has to cover server-side polling cadence.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    screenshot: "off",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
    },
    // Mobile project: define viewport explicitly. We avoid spreading
    // `devices["Pixel 7"]` because the preset overrides `deviceScaleFactor`,
    // which causes screenshot dimension drift vs. desktop.
    {
      name: "mobile",
      use: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: "pnpm exec vite preview --port 4173 --strictPort --host 127.0.0.1",
    port: 4173,
    timeout: 60_000,
    // Don't reuse a stale preview locally — a non-channel-correct preview on
    // port 4173 would silently corrupt screenshots.
    reuseExistingServer: false,
  },
});
