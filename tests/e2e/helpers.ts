import { expect, type Page } from "@playwright/test";

/**
 * Shared helpers for the Playwright specs. Keep them small and focused — the
 * specs themselves should read like a series of clearly-named user actions.
 */

/**
 * Console-error messages Chromium emits unprompted that we want to ignore.
 * `frame-ancestors` in a <meta> tag is intentional — our CSP can't be served
 * via headers on a static-site host, and Chromium logs a warning the first
 * time it sees the meta tag. The CSP still works for the response-header use
 * case (which is the security-relevant one).
 */
const BENIGN_CONSOLE_ERROR_PATTERNS: readonly RegExp[] = [
  /Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element/,
];

function isBenign(text: string): boolean {
  return BENIGN_CONSOLE_ERROR_PATTERNS.some((re) => re.test(text));
}

/**
 * Attach pageerror + console-error watchers. Returns a closure that throws if
 * any uncaught error happened. Call it after each test step to fail fast.
 * Filters out benign-by-design Chromium messages (see {@link BENIGN_CONSOLE_ERROR_PATTERNS}).
 */
export function watchUncaughtErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("pageerror", (e) => {
    errors.push(`pageerror: ${e.message}`);
  });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (isBenign(text)) return;
    errors.push(`console.error: ${text}`);
  });
  return () => {
    expect(errors, "uncaught page errors during the run").toEqual([]);
  };
}

/**
 * Wait for the SPA's per-screen ready signal. Falls back to a clean assertion
 * message if the timeout fires, naming the expected signal.
 */
export async function waitForScreenReady(
  page: Page,
  signal: "onboarding" | "dashboard" | "tile-detail" | "settings",
  timeoutMs = 30_000,
): Promise<void> {
  try {
    await page.waitForFunction(
      (sig) => document.documentElement.getAttribute("data-screenshot-ready") === sig,
      signal,
      { timeout: timeoutMs },
    );
  } catch (e) {
    const observed = await page.evaluate(() =>
      document.documentElement.getAttribute("data-screenshot-ready"),
    );
    throw new Error(
      `Timed out waiting for data-screenshot-ready="${signal}" (observed "${observed}"): ${e}`,
    );
  }
}

/**
 * Common post-conditions before a screenshot:
 *  - no error banner visible (would silently ship a broken screenshot)
 *  - the fake phone peer is present in the device list
 *  - fonts have settled
 *  - all CSS animations are finished (reduced-motion CSS makes the sheet
 *    animation-less, but other transitions might still be in-flight)
 */
export async function assertReadyForCapture(
  page: Page,
  phoneDeviceId: string,
): Promise<void> {
  await expect(page.locator(".banner.err"), "no error banner before capture").toHaveCount(0);
  await expect(
    page.locator(`[data-testid="device-card"][data-device-id="${phoneDeviceId}"]`),
    "fake phone peer visible in dashboard",
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every((a) => a.playState === "finished" || a.playState === "idle"),
  );
}

/**
 * Drive the SPA's "Link by paste" onboarding flow with a captured LinkingData
 * blob. Leaves the SPA on the dashboard with the bootstrap peer linked.
 */
export async function linkViaPaste(page: Page, linkingDataBlob: string): Promise<void> {
  await page.locator('[data-testid="onboarding-paste"]').click();
  await page.locator('[data-testid="paste-textarea"]').fill(linkingDataBlob);
  await page.locator('[data-testid="paste-submit"]').click();
  await waitForScreenReady(page, "dashboard");
}

/**
 * Link a *second* (or further) sync source from inside the dashboard:
 * Settings → Sync sources → Add another → paste flow.
 *
 * Unlike {@link linkViaPaste}, the Add-Source sheet hosts an `<Onboarding>` with
 * `manageScreenshotMarker={false}`, so there is no `data-screenshot-ready`
 * transition to await. Success is observed by the Sync Sources list (mounted
 * behind the add sheet) growing to `expectedConnectorCount` cards; a join
 * failure is surfaced fast via LinkPaste's inline error instead of timing out.
 */
export async function addSyncSourceViaPaste(
  page: Page,
  linkingDataBlob: string,
  expectedConnectorCount: number,
): Promise<void> {
  await page.locator('[data-testid="nav-settings"]').click();
  await waitForScreenReady(page, "settings");
  await page.locator('[data-testid="settings-open-sources"]').click();
  await page.locator('[data-testid="add-sync-source"]').click();
  await page.locator('[data-testid="onboarding-paste"]').click();
  await page.locator('[data-testid="paste-textarea"]').fill(linkingDataBlob);
  await page.locator('[data-testid="paste-submit"]').click();

  const connectorCards = page.locator('[data-testid="connector-card"]');
  const pasteError = page.locator('[data-testid="paste-error"]');
  // Race the success signal (new card appears) against the failure signal
  // (inline error). `.catch` collapses each loser's timeout into a sentinel so
  // the pending branch never surfaces as an unhandled rejection.
  const outcome = await Promise.race([
    connectorCards
      .nth(expectedConnectorCount - 1)
      .waitFor({ state: "visible" })
      .then(() => "linked" as const)
      .catch(() => "timeout" as const),
    pasteError
      .waitFor({ state: "visible" })
      .then(() => "error" as const)
      .catch(() => "no-error" as const),
  ]);
  if (outcome === "error") {
    throw new Error(
      `Add sync source failed: ${(await pasteError.textContent())?.trim() || "(empty error)"}`,
    );
  }
  await expect(
    connectorCards,
    `${expectedConnectorCount} connector cards after adding sync source`,
  ).toHaveCount(expectedConnectorCount);
}
