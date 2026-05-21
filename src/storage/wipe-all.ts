import { fileShareRetryQueue } from "../sync/fileshare-retry-queue";
import { credentialsRepo } from "./credentials-repo";
import { tileLayoutRepo } from "./tile-layout-repo";

/**
 * Single entry point for "wipe everything sign-out-related on this browser".
 * Sign-out used to inline these wipes in `DashboardStub.signOut`; centralising
 * them means a future PR adding a new persistent store can't accidentally
 * leave it behind on sign-out (which would resurrect on next link with stale
 * data — see the FU3 plan).
 *
 * Stores wiped today:
 *   - {@code CredentialsRepo} — linked accounts, encryption keysets.
 *   - {@code TileLayoutRepo} — per-device dashboard layouts.
 *   - {@code FileShareRetryQueue} — pending file-share publishes.
 *
 * NOT wiped: {@code IdentitySettings.ownDeviceId}. That intentionally persists
 * across sign-out so re-linking from the same browser keeps a single peer
 * record on the server (matching Android's `SyncSettings.deviceId`).
 *
 * Each wipe runs independently — a failure in one doesn't abort the others.
 * Failures are swallowed (logged via the repo's own throw → caught here) so
 * sign-out always completes from the user's perspective.
 */
export async function wipeLocalSyncData(): Promise<void> {
  await Promise.all([
    credentialsRepo.wipeAll().catch(() => undefined),
    tileLayoutRepo.wipeAll().catch(() => undefined),
    fileShareRetryQueue.wipeAll().catch(() => undefined),
  ]);
}
