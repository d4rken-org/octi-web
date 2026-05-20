import { OCTI_WEB_CHANNEL } from "../version";
import { credentialsRepo } from "./credentials-repo";

/**
 * Per-install (per-channel-per-origin) identity for this browser. The own
 * device UUID is generated once and reused for every sync connector this
 * browser pairs with — matching the Android client where `SyncSettings.deviceId`
 * is a single value advertised to every connector.
 *
 * Why one ID across all connectors: when a peer reaches us via two connectors,
 * their merge logic dedups on `deviceId`. If we registered as a different
 * device on each Octi-server account, the peer would see two cards for the
 * same physical browser, defeating the merge. See Android `SyncSettings.kt`
 * (`val deviceId by lazy { ... }`) for the canonical pattern.
 *
 * Channel-scoped (`stable`/`canary` keep separate IDs) for the same reason
 * IndexedDB DB names are: each channel is an independent device on the sync
 * account, even on the same origin.
 *
 * Storage: localStorage. Survives across credential add/remove; only wiped
 * on full sign-out (and on browser data clears, like any localStorage value).
 */
const STORAGE_KEY = `octi-web.${OCTI_WEB_CHANNEL}.own-device-id`;

let cached: string | null = null;
/**
 * Single-flight init promise. Multiple concurrent callers (different tabs
 * mounting at the same time, or App.svelte bootstrap racing with a link-flow
 * import) share one resolution so the same UUID lands in localStorage and
 * in-memory. A post-await localStorage recheck catches the cross-tab case
 * where a sibling tab wrote a different value during our async work.
 */
let inFlight: Promise<string> | null = null;

/**
 * Resolve the own-device UUID for this browser. Lazy-init order:
 *   1. localStorage already set → return it.
 *   2. Any existing credential has an `ownDeviceId` → seed from the
 *      earliest-created one (preserves in-flight dev installs that linked
 *      before this module existed).
 *   3. Otherwise generate a fresh `crypto.randomUUID()`.
 *
 * Result is persisted to localStorage and memoized in-module.
 */
export async function getOwnDeviceId(): Promise<string> {
  if (cached !== null) return cached;
  if (inFlight !== null) return inFlight;

  inFlight = (async () => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      cached = stored;
      return stored;
    }

    // Seed from an existing credential if one exists. Multi-credential dev
    // installs (which shouldn't exist yet, but defensively) pick the earliest
    // by `createdAt`.
    const existing = await credentialsRepo.listAll();
    // Re-check localStorage after the await: a sibling tab might have written
    // its own value in the meantime, and we want to converge on theirs rather
    // than overwrite.
    const concurrent = localStorage.getItem(STORAGE_KEY);
    if (concurrent) {
      cached = concurrent;
      return concurrent;
    }
    if (existing.length > 0) {
      const earliest = existing.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
      cached = earliest.ownDeviceId;
      localStorage.setItem(STORAGE_KEY, cached);
      return cached;
    }

    const fresh = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, fresh);
    cached = fresh;
    return fresh;
  })();

  try {
    return await inFlight;
  } finally {
    // Keep `cached` populated; clear the in-flight slot so retries after
    // wipeOwnDeviceId() can start a new init.
    inFlight = null;
  }
}

/**
 * Clear the cached UUID + localStorage entry. Used by sign-out-everything.
 * Does NOT delete credentials (that's `CredentialsRepo.wipeAll()`).
 */
export function wipeOwnDeviceId(): void {
  cached = null;
  inFlight = null;
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Test-only hook. Forces the cached value to a specific UUID, bypassing
 * localStorage seeding. Production code never calls this.
 */
export function __setOwnDeviceIdForTest(value: string | null): void {
  cached = value;
  inFlight = null;
  if (value === null) {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, value);
  }
}
