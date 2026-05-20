import { test } from "@playwright/test";
import { blobForProject, loadBootstrapPeer } from "./peer";
import {
  assertReadyForCapture,
  linkViaPaste,
  waitForScreenReady,
  watchUncaughtErrors,
} from "./helpers";

/**
 * Screenshot capture flow. Each Playwright project (desktop, mobile) runs:
 *
 *   1. onboarding   — fresh context, captures the welcome screen.
 *   2. dashboard    — one big test that links the SPA to the bootstrap peer,
 *                     captures the dashboard, opens the clipboard tile (sheet
 *                     capture), opens edit mode (desktop only), and opens
 *                     settings (desktop only).
 *
 * Why one big test: Playwright recreates the browser context per test even
 * inside `describe.serial`, so the credentials populated by linking would be
 * thrown away between tests. Doing the link + all post-link captures inside a
 * single test keeps the IDB / browser context coherent. The cost is a longer
 * single test rather than many short ones — but Playwright's trace + artifact
 * reporting still pinpoints failures at the step level.
 *
 * Each post-link capture writes to {@code screenshots/full-<project>-<name>.png};
 * the thumbnail script picks them up afterwards.
 */

test("onboarding", async ({ page }, testInfo) => {
  const assertNoUncaught = watchUncaughtErrors(page);

  await page.goto("/");
  await waitForScreenReady(page, "onboarding");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every((a) => a.playState === "finished" || a.playState === "idle"),
  );
  await page.screenshot({
    path: `screenshots/full-${testInfo.project.name}-onboarding.png`,
    fullPage: true,
  });

  assertNoUncaught();
});

test("dashboard flow", async ({ page }, testInfo) => {
  const peer = loadBootstrapPeer();
  const blob = blobForProject(peer, testInfo.project.name);
  const assertNoUncaught = watchUncaughtErrors(page);
  const projectName = testInfo.project.name;
  const isMobile = projectName === "mobile";

  // 1. Boot the SPA on a clean origin and link to the bootstrap peer.
  await page.goto("/");
  await linkViaPaste(page, blob);
  await assertReadyForCapture(page, peer.deviceId);

  // 2. Capture the dashboard with the phone peer visible.
  await page.screenshot({
    path: `screenshots/full-${projectName}-dashboard.png`,
    fullPage: true,
  });

  // 3. Open the phone's clipboard tile → capture the sheet.
  const phoneCard = page.locator(
    `[data-testid="device-card"][data-device-id="${peer.deviceId}"]`,
  );
  await phoneCard
    .locator('[data-testid="tile"][data-module-id="eu.darken.octi.module.core.clipboard"]')
    .click();
  await waitForScreenReady(page, "tile-detail");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every((a) => a.playState === "finished" || a.playState === "idle"),
  );
  await page.screenshot({
    path: `screenshots/full-${projectName}-tile-detail.png`,
    fullPage: true,
  });
  // Close the sheet so the dashboard is clean for the next capture.
  await page.keyboard.press("Escape");
  await waitForScreenReady(page, "dashboard");

  if (isMobile) {
    // Mobile project skips edit + settings — desktop is canonical for those.
    assertNoUncaught();
    return;
  }

  // 4. Open the phone card's overflow menu → "Edit tiles" → capture.
  await phoneCard.locator('[data-testid="overflow-menu"]').click();
  await page.locator('[data-testid="edit-tiles-button"]').click();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every((a) => a.playState === "finished" || a.playState === "idle"),
  );
  await page.screenshot({
    path: `screenshots/full-${projectName}-dashboard-edit.png`,
    fullPage: true,
  });

  // 5. Settings screen.
  await page.goto("/"); // Cancel edit mode by reloading; cleaner than chasing the cancel button.
  await waitForScreenReady(page, "dashboard");
  await page.locator('[data-testid="nav-settings"]').click();
  await waitForScreenReady(page, "settings");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every((a) => a.playState === "finished" || a.playState === "idle"),
  );
  await page.screenshot({
    path: `screenshots/full-${projectName}-settings.png`,
    fullPage: true,
  });

  assertNoUncaught();
});
