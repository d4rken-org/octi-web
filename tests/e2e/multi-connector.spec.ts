import { expect, test } from "@playwright/test";
import { blobForProject, loadBootstrapPeerFrom } from "./peer";
import {
  addSyncSourceViaPaste,
  linkViaPaste,
  waitForScreenReady,
  watchUncaughtErrors,
} from "./helpers";
import { octiServerConnectorId } from "../../src/protocol/connector-id";
import { serverBaseUrl } from "../../src/protocol/models";

/**
 * Real-browser multi-connector E2E. The vitest smoke suite
 * (`src/__smoke__/multi-connector.test.ts`) drives `ConnectorManager` directly;
 * this drives the actual UI:
 *
 *   1. Onboard against server A (paste-link peer A) → dashboard, peer A visible.
 *   2. Add server B from Settings → Sync sources → Add another (paste-link peer B).
 *   3. Both connectors are listed; both peers render on the merged dashboard.
 *
 * Two distinct peers (one per server) is the clearest "multiple connectors all
 * render in the real UI" signal — peer B's card only appears if connector B
 * refreshed AND decrypted, so it subsumes a per-connector health check.
 * Same-peer-on-both-servers dedupe is already covered by the vitest smoke.
 *
 * Needs two bootstrap files, one per server — see the `e2e-smoke` CI job.
 */

const PEER_A_FILE = process.env.BOOTSTRAP_PEER_A_FILE ?? "peer-a.json";
const PEER_B_FILE = process.env.BOOTSTRAP_PEER_B_FILE ?? "peer-b.json";

test("link two connectors via UI + merged dashboard", async ({ page }, testInfo) => {
  // Two real joins plus refresh cycles against two servers — comfortably above
  // the 60s config default.
  test.setTimeout(120_000);

  const peerA = loadBootstrapPeerFrom(PEER_A_FILE);
  const peerB = loadBootstrapPeerFrom(PEER_B_FILE);

  // Guard against a CI miswiring (both files pointing at the same server): the
  // connector-id encodes only domain + accountId, and both CI servers share
  // 127.0.0.1, so a same-server mistake wouldn't be obvious downstream.
  expect(
    serverBaseUrl(peerA.serverAddress),
    "peer A and peer B must live on different sync-servers",
  ).not.toBe(serverBaseUrl(peerB.serverAddress));

  const blobA = blobForProject(peerA, testInfo.project.name);
  const blobB = blobForProject(peerB, testInfo.project.name);
  const assertNoUncaught = watchUncaughtErrors(page);

  // 1. Onboard against server A.
  await page.goto("/");
  await waitForScreenReady(page, "onboarding");
  await linkViaPaste(page, blobA);
  await expect(
    page.locator(`[data-testid="device-card"][data-device-id="${peerA.deviceId}"]`),
    "peer A visible after first link",
  ).toBeVisible();

  // 2. Add server B through the in-dashboard add-source flow.
  await addSyncSourceViaPaste(page, blobB, 2);

  // Both connectors are listed, identified by their wire connector-id
  // (kserver-<domain>-<accountId>) — distinguishes the two servers by account
  // since both share 127.0.0.1 in CI.
  const expectedIds = [
    octiServerConnectorId(peerA.serverAddress, peerA.accountId),
    octiServerConnectorId(peerB.serverAddress, peerB.accountId),
  ].sort();
  const actualIds = await page
    .locator('[data-testid="connector-card"]')
    .evaluateAll((cards) => cards.map((c) => c.getAttribute("data-connector-id")));
  expect(actualIds.filter((id): id is string => id !== null).sort()).toEqual(expectedIds);

  // 3. Reload to a clean dashboard (no stacked Settings/Sources sheets occluding
  //    the grid; the persisted credentials re-bootstrap both connectors) and
  //    assert both peers render on the merged dashboard.
  await page.goto("/");
  await waitForScreenReady(page, "dashboard");

  await expect(
    page.locator(`[data-testid="device-card"][data-device-id="${peerA.deviceId}"]`),
    "peer A visible on merged dashboard",
  ).toBeVisible();
  await expect(
    page.locator(`[data-testid="device-card"][data-device-id="${peerB.deviceId}"]`),
    "peer B visible on merged dashboard",
  ).toBeVisible();
  await expect(page.locator(".banner.err"), "no decode-error banner").toHaveCount(0);

  assertNoUncaught();
});
