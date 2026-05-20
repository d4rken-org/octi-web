import { expect, test } from "@playwright/test";
import { blobForProject, loadBootstrapPeer } from "./peer";
import { linkViaPaste, watchUncaughtErrors, waitForScreenReady } from "./helpers";

/**
 * Non-screenshot E2E smoke. Runs on every PR/main push from `code-checks.yml`
 * so selectors and the bootstrap-peer protocol drift never blindside a release.
 *
 *   1. SPA boots into the Onboarding screen on a clean origin.
 *   2. Paste-link flow successfully redeems the bootstrap-peer's share code.
 *   3. Dashboard renders with the phone peer's deviceId visible.
 *   4. No console errors, no error banners.
 *
 * Mobile + desktop run identical flows — covers responsive layout-induced
 * selector breakage too.
 */

test("link via paste + first decode", async ({ page }, testInfo) => {
  const peer = loadBootstrapPeer();
  const blob = blobForProject(peer, testInfo.project.name);
  const assertNoUncaught = watchUncaughtErrors(page);

  await page.goto("/");
  await waitForScreenReady(page, "onboarding");

  await linkViaPaste(page, blob);

  await expect(
    page.locator(`[data-testid="device-card"][data-device-id="${peer.deviceId}"]`),
    "phone peer in dashboard after linking",
  ).toBeVisible();
  await expect(page.locator(".banner.err"), "no decode-error banner").toHaveCount(0);

  assertNoUncaught();
});
