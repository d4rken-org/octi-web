import { type BlobCipher, createBlobCipher } from "../crypto/blob-cipher";
import { type PayloadEncryption, createPayloadEncryption } from "../crypto/payload";
import { APPS_MODULE_ID, decodeAppsInfo, type AppsInfo } from "../modules/apps";
import {
  CLIPBOARD_MODULE_ID,
  type ClipboardInfo,
  fetchPeerClipboard,
  publishOwnClipboard,
} from "../modules/clipboard";
import {
  CONNECTIVITY_MODULE_ID,
  type ConnectivityInfo,
  decodeConnectivityInfo,
} from "../modules/connectivity";
import { type EtagCache, createEtagCache, fetchPeerModule } from "../modules/fetch-module";
import {
  type DownloadedFile,
  FILES_MODULE_ID,
  type FileShareInfo,
  type SharedFile,
  type UploadResult,
  buildSharedFile,
  downloadSharedFile,
  fetchPeerFileShareInfo,
  publishSharedFileEntry,
  uploadFileBlobToConnector,
} from "../modules/files";
import {
  META_MODULE_ID,
  type MetaInfo,
  fetchPeerMetaInfo,
  publishOwnMetaInfo,
} from "../modules/meta";
import { POWER_MODULE_ID, decodePowerInfo, type PowerInfo } from "../modules/power";
import { WIFI_MODULE_ID, decodeWifiInfo, type WifiInfo } from "../modules/wifi";
import { sha256Hex } from "../protocol/blob-session";
import { OctiServerConnector } from "../protocol/octi-server-connector";
import type { DeviceMetadata } from "../protocol/models";
import {
  type CachedConnectorState,
  CURRENT_CACHE_VERSION as CACHE_CURRENT_VERSION,
  type ConnectorStateCache,
  connectorStateCache,
} from "../storage/connector-state-cache";
import {
  type CredentialRecord,
  credentialsRepo,
} from "../storage/credentials-repo";
import { getOwnDeviceId } from "../storage/identity-settings";
import { wipeLocalSyncData } from "../storage/wipe-all";
import {
  fileShareRetryQueue,
  MAX_ATTEMPTS as RETRY_MAX_ATTEMPTS,
  PENDING_TTL_MS as RETRY_PENDING_TTL_MS,
  type FileShareRetryQueue,
  type PendingPublish,
} from "./fileshare-retry-queue";

/**
 * Orchestrates one or more {@link OctiServerConnector}s, runs the per-connector
 * refresh loop, and produces a merged peer-device view modelled on Android's
 * `SyncManager.data.latestData()`:
 *
 *   - **Per-(deviceId, moduleId)**: newest `modifiedAt` wins across connectors.
 *     Missing/invalid `modifiedAt` is treated as the oldest possible value;
 *     ties break deterministically on `connectorId` ascending.
 *   - **Per-device metadata** (label / platform / lastSeen as the sync-server
 *     reports it): the first-seen-connector owns it (sorted by the connector's
 *     credential `createdAt` ascending, tiebreak `connectorId`). NOT
 *     newest-by-`lastSeen` — that would flip the label/platform between poll
 *     ticks, matching Android's choice (`ConnectorIssueAggregator.kt`'s
 *     `putIfAbsent(meta.deviceId, connector.identifier)`).
 *
 * Refresh model
 * -------------
 * - Each `refreshAll()` invocation bumps a global generation counter; each
 *   per-connector refresh also captures the connector's generation at start.
 *   Late completions from a removed or superseded refresh are dropped.
 * - A connector that errors keeps its previous {@link ConnectorRefreshState}
 *   (in-memory cache fallback) so the merged view stays populated through a
 *   transient blip. The error surfaces via {@link mergedIssues}.
 * - Per-connector reads are bounded by a small concurrency limit
 *   ({@link MODULE_FETCH_CONCURRENCY}) so `connectors * devices * modules`
 *   doesn't fan out into hundreds of simultaneous GETs.
 *
 * Publishes (own MetaInfo, own Clipboard, own FileShareInfo, file blobs) fan
 * out across all active connectors via `Promise.allSettled`. Each connector
 * encrypts with its own keyset; partial failures surface as connector-level
 * issues without blocking the others.
 */
export class ConnectorManager {
  /** Cap on simultaneous module GETs per connector. 6 = browser's typical per-origin pool. */
  static readonly MODULE_FETCH_CONCURRENCY = 6;

  // ─── Reactive state (consumed by the dashboard) ──────────────
  /** Connectors currently active. Rebuilt from `credentialsRepo.listAll()` on bootstrap and after add/remove. */
  connectors = $state<OctiServerConnector[]>([]);
  /** Per-connector refresh state. Survives errors so the merge stays populated. */
  perConnectorState = $state<Map<string, ConnectorRefreshState>>(new Map());
  /**
   * True while any refresh is in flight — a full-fan-out `refreshAll()` OR a
   * per-connector `refreshOne()`. Both paths route through
   * {@link #beginRefreshPass} / {@link #endRefreshPass}, which refcount via
   * {@link #loadingCount} to keep this flag accurate under overlapping
   * passes.
   *
   * Kept as `$state` rather than `$derived` so callers outside a Svelte
   * tracking scope (e.g. tests) see the live value on each read — Svelte 5
   * `$derived` only auto-recomputes for readers inside a tracker.
   */
  loading = $state(false);
  /** Refcount of currently-running refresh passes; plain field (non-`$state`). */
  #loadingCount = 0;
  /** Wall-clock of the last completed `refreshAll()` (any state). */
  lastRefreshedAt = $state<Date | null>(null);
  /** Wall-clock of the last `refreshAll()` where every connector succeeded. */
  lastSuccessAt = $state<Date | null>(null);

  // ─── Derived view ────────────────────────────────────────────
  /** Self-merge of `perConnectorState` per the rules in the class docstring. */
  mergedDevices = $derived<EnrichedDevice[]>(mergeDevices(this.perConnectorState));
  /** One {@link Issue} per connector that has a non-null `lastError`. */
  mergedIssues = $derived<Issue[]>(
    [...this.perConnectorState.entries()]
      .filter(([, s]) => s.lastError !== null)
      .map(([connectorId, s]) => ({ connectorId, message: s.lastError as string })),
  );

  // ─── Per-connector internal handles ──────────────────────────
  // Keyed by connectorId. Lifecycle is owned by the manager so add/remove
  // can wipe everything for one connector in one place.
  #crypti = new Map<string, PayloadEncryption>();
  #blobCipher = new Map<string, BlobCipher>();
  #etagCache = new Map<string, EtagCache<unknown>>();
  /**
   * Per-connector serialization gate for {@link publishSharedFileEntry}
   * calls. The publish path is read-modify-write against the connector's
   * own-device `FileShareInfo` document with `If-Match` precondition —
   * concurrent calls on the same connector race for the ETag and one
   * gets 412. Common race: a user upload's phase 2 firing while a
   * drained retry from the queue runs concurrently for the same
   * connector. We chain calls per-connector via a promise tail so they
   * serialize cleanly; different connectors stay independent.
   */
  #publishLocks = new Map<string, Promise<void>>();
  /**
   * Injectable retry queue. Defaults to the module-level singleton; tests
   * can substitute a fresh instance to avoid cross-test state on the
   * shared IDB DB. See {@link __setRetryQueueForTest}.
   */
  #retryQueue: FileShareRetryQueue = fileShareRetryQueue;
  /**
   * Single-flight guard for {@link #drainRetryQueue}. Concurrent drains
   * could double-process the same entry (one succeeds + deletes; the
   * other writes back stale state) since the per-connector publish lock
   * only serializes the network calls, not the queue's read-modify-write
   * row updates. Overlapping drains coalesce into one.
   */
  #drainInFlight: Promise<void> | null = null;
  /**
   * Persistent fallback for {@link perConnectorState}. Read on bootstrap so
   * the dashboard renders last-known data instantly on tab reload; written
   * (fire-and-forget) after every successful per-connector refresh. Tests
   * inject a fresh instance via {@link __setConnectorStateCacheForTest}.
   */
  #connectorStateCache: ConnectorStateCache = connectorStateCache;
  /**
   * Per-connector deletion generation. Bumped synchronously by
   * {@link removeConnector} (via {@link #invalidateConnectorRefresh}) and
   * by sign-out. A fire-and-forget cache write that was scheduled before
   * the bump checks the generation just before its `put` and skips if the
   * generation moved. Prevents a late refresh write from resurrecting a
   * cache row that {@link removeConnector} just deleted.
   *
   * Note: the gen check narrows the resurrection race window to microseconds
   * between the check and `db.put` queueing — IDB then serializes the put
   * and any subsequent delete in transaction-arrival order, so a stale put
   * can still in theory beat a delete to commit. The remaining residual
   * race is harmless: a stale cache row for a connector not in
   * `this.connectors` is inert (bootstrap doesn't iterate over it) and the
   * next sign-out's `wipeAll` cleans up.
   */
  #cacheWriteGen = new Map<string, number>();

  // ─── Generation guards ───────────────────────────────────────
  #refreshSeq = 0;
  #connectorSeq = new Map<string, number>();
  /**
   * Per-connector spinner-clear token. Bumped at the start of every
   * `#refreshOne` (whether driven by `refreshAll` or by a public
   * `refreshOne`). Only the most-recent pass may clear that connector's
   * `refreshing` flag on exit — so a late completion of an older pass
   * can't drop the spinner while a newer pass is still in flight.
   */
  #refreshOneToken = new Map<string, number>();
  /**
   * Single-flight guard for connector-list rebuilds. {@link bootstrap},
   * {@link addConnector}, and {@link removeConnector} all rebuild the list
   * from `credentialsRepo.listAll()` after async work (crypto setup, repo
   * I/O). Concurrent calls would race — the second one's read of
   * `listAll()` could be staler than the first's, and the assignment to
   * `this.connectors` would lose the newer state. We serialize them.
   */
  #syncInFlight: Promise<void> | null = null;

  // ─── Bootstrap ───────────────────────────────────────────────
  /**
   * Initialize from persistent storage. Reads all credentials, builds a
   * connector + crypti + blobCipher for each, then seeds `perConnectorState`
   * from the on-disk cache so the dashboard renders last-known data
   * immediately on tab reload (the first {@link refreshAll} then overwrites
   * with fresh data in the background).
   *
   * Safe to call repeatedly; connectors whose credentials are gone get torn
   * down. The cache-seed step intentionally only fills in connectors with
   * empty `perConnectorState` — calling `bootstrap()` after an `addConnector`
   * or label-rename must NOT clobber the just-fetched live data with a
   * stale cache snapshot.
   */
  async bootstrap(): Promise<void> {
    await this.#syncConnectorsSerialized();
    await this.#seedFromCache();
  }

  /**
   * Add a freshly-saved credential. The credential must already be persisted
   * via {@link credentialsRepo.save} before this call — the manager rebuilds
   * its connector list from storage to keep one source of truth.
   */
  async addConnector(_record: CredentialRecord): Promise<void> {
    await this.#syncConnectorsSerialized();
    // Trigger an immediate refresh for the new connector. The bumped
    // generation in #syncConnectorsFromRecords already invalidated any
    // in-flight competing refresh for that slot.
    void this.refreshAll();
  }

  /**
   * Sign-out: tear down every in-memory connector slot AND wipe local
   * persistence in one step. Sign-out used to inline `wipeLocalSyncData()`
   * directly from `DashboardStub`, but that left a window where an
   * in-flight `refreshAll` could finish AFTER the wipe and re-create the
   * cache row it just deleted (`connectorId` is stable for the same
   * server/account, so a future re-link could then seed pre-sign-out
   * data). Routing through the manager bumps every per-connector
   * generation BEFORE the wipe, invalidating those in-flight writes.
   *
   * Order matters:
   *   1. Bump every connector's `#refreshSeq` / `#refreshOneToken` /
   *      `#cacheWriteGen` so already-in-flight refresh writes and cache
   *      writes return "stale" or skip their `put`.
   *   2. Bump the GLOBAL `#refreshSeq` so any `refreshAll()` in flight
   *      stops looking authoritative.
   *   3. Clear in-memory state + crypto runtimes so the dashboard's
   *      reactive views snap to empty immediately.
   *   4. Call `wipeLocalSyncData()` to drop the IDB databases.
   *
   * Caller (DashboardStub) follows up with the route flip back to
   * Onboarding via the `onSignOut` callback.
   */
  async signOut(): Promise<void> {
    // Step 1: per-connector gen bumps. Iterate `connectors` AND
    // `perConnectorState` keys — a connector may exist in one but not
    // the other if a teardown was in flight.
    const idsToInvalidate = new Set<string>([
      ...this.connectors.map((c) => c.connectorId),
      ...this.perConnectorState.keys(),
    ]);
    for (const id of idsToInvalidate) {
      this.#invalidateConnectorRefresh(id);
    }
    // Step 2: global refresh seq so a `refreshAll` currently fanning out
    // returns early instead of writing per-connector results.
    this.#refreshSeq++;
    // Step 3: clear runtime state. The order doesn't matter — they're all
    // private. Replace `perConnectorState` reference for Svelte reactivity.
    this.connectors = [];
    this.perConnectorState = new Map();
    this.#crypti.clear();
    this.#blobCipher.clear();
    this.#etagCache.clear();
    this.#publishLocks.clear();
    // Step 4: persistent wipe.
    await wipeLocalSyncData();
  }

  /**
   * Remove one connector. Invalidates any in-flight refresh for that slot,
   * deletes its credential record, drops per-connector state and caches.
   * Other connectors keep working.
   */
  async removeConnector(connectorId: string): Promise<void> {
    this.#invalidateConnectorRefresh(connectorId);
    this.perConnectorState.delete(connectorId);
    this.perConnectorState = new Map(this.perConnectorState); // trigger reactivity
    this.#crypti.delete(connectorId);
    this.#blobCipher.delete(connectorId);
    this.#etagCache.delete(connectorId);
    // Drop persistent data for this connector. Errors are swallowed so a
    // failed prune/delete doesn't block the removal — the retry queue and
    // state cache are best-effort. Stale rows are inert (bootstrap only
    // seeds connectors that are still in credentials), and the next
    // sign-out's `wipeLocalSyncData()` cleans them up regardless.
    await Promise.all([
      this.#retryQueue.pruneConnector(connectorId).catch(() => undefined),
      this.#connectorStateCache.delete(connectorId).catch(() => undefined),
    ]);
    await credentialsRepo.deleteByConnectorId(connectorId);
    await this.#syncConnectorsSerialized();
  }

  /**
   * Serialize all connector-list rebuilds. Concurrent callers await the
   * single in-flight pass so their views of `credentialsRepo.listAll()`
   * don't race.
   */
  async #syncConnectorsSerialized(): Promise<void> {
    if (this.#syncInFlight) {
      // Wait for the in-flight rebuild, then chain ours after — they may
      // disagree about what's in the repo. Each call's intent is "make the
      // manager reflect the current persistent state"; running back-to-back
      // converges.
      await this.#syncInFlight;
    }
    const job = (async () => {
      const records = await credentialsRepo.listAll();
      const ownDeviceId = await getOwnDeviceId();
      await this.#syncConnectorsFromRecords(records, ownDeviceId);
    })();
    this.#syncInFlight = job;
    try {
      await job;
    } finally {
      if (this.#syncInFlight === job) this.#syncInFlight = null;
    }
  }

  async #syncConnectorsFromRecords(
    records: CredentialRecord[],
    ownDeviceId: string,
  ): Promise<void> {
    // Sorted-by-createdAt so the metadata-owner tiebreak below is stable.
    const sorted = [...records].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.connectorId < b.connectorId ? -1 : 1;
    });
    const next = sorted.map((r) => new OctiServerConnector(r, ownDeviceId));
    // Drop runtime state for connectors no longer in the list.
    const nextIds = new Set(next.map((c) => c.connectorId));
    for (const id of [...this.perConnectorState.keys()]) {
      if (!nextIds.has(id)) {
        this.#invalidateConnectorRefresh(id);
        this.perConnectorState.delete(id);
        this.#crypti.delete(id);
        this.#blobCipher.delete(id);
        this.#etagCache.delete(id);
      }
    }
    this.perConnectorState = new Map(this.perConnectorState);
    // Build crypto runtimes for any new connectors. Seed an empty
    // ConnectorRefreshState too — that gives mergeDevices() a deterministic
    // insertion order matching `(createdAt asc, connectorId asc)` (the
    // first-seen-owner tiebreak no longer depends on which connector's
    // refresh finishes first), and gives `#recordPublishError` somewhere to
    // write for publishes that happen before the first refreshAll() (e.g.
    // the dashboard's bootstrap MetaInfo publish).
    const nextState = new Map<string, ConnectorRefreshState>();
    for (const c of next) {
      if (!this.#crypti.has(c.connectorId)) {
        this.#crypti.set(c.connectorId, createPayloadEncryption(c.record.encryptionKeyset));
      }
      if (!this.#blobCipher.has(c.connectorId)) {
        this.#blobCipher.set(c.connectorId, await createBlobCipher(c.record.encryptionKeyset));
      }
      if (!this.#etagCache.has(c.connectorId)) {
        this.#etagCache.set(c.connectorId, createEtagCache<unknown>());
      }
      nextState.set(
        c.connectorId,
        this.perConnectorState.get(c.connectorId) ?? {
          devices: new Map(),
          lastError: null,
          lastRefreshedAt: null,
          lastSuccessAt: null,
          refreshing: false,
        },
      );
    }
    this.perConnectorState = nextState;
    this.connectors = next;
  }

  #bumpConnectorSeq(connectorId: string): void {
    this.#connectorSeq.set(connectorId, (this.#connectorSeq.get(connectorId) ?? 0) + 1);
  }

  /**
   * Serialize `fn` against any other publish currently running on the same
   * connector. The publish path
   * ({@code publishSharedFileEntry → readModulePayloadWithEtag + commitModule})
   * is read-modify-write with `If-Match` — concurrent callers on the same
   * connector both read the same ETag, one wins, the other gets 412.
   * Common collision: phase 2 of `uploadFile` firing while
   * `drainRetryQueue` retries a prior pending publish on the same
   * connector. We avoid the 412 by chaining each new caller behind the
   * previous on a per-connector promise tail.
   *
   * Errors thrown by `fn` propagate to that caller only — subsequent
   * waiters always proceed.
   */
  async #runUnderPublishLock<T>(
    connectorId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prior = this.#publishLocks.get(connectorId) ?? Promise.resolve();
    let resolveTail!: () => void;
    const newTail = new Promise<void>((r) => {
      resolveTail = r;
    });
    this.#publishLocks.set(connectorId, newTail);
    try {
      await prior; // wait for any prior publish on this connector
      return await fn();
    } finally {
      resolveTail();
      // If nothing else chained behind us, drop the map entry so an idle
      // map doesn't accumulate per-connector slots over the lifetime of
      // the manager.
      if (this.#publishLocks.get(connectorId) === newTail) {
        this.#publishLocks.delete(connectorId);
      }
    }
  }

  /**
   * Invalidate every in-flight refresh signal for one connector — used on
   * teardown (`removeConnector`, `#syncConnectorsFromRecords` when a
   * credential is gone). Bumps three counters:
   *   - `#connectorSeq` so any in-flight `#refreshOne` writes are discarded.
   *   - `#refreshOneToken` so any late completion's spinner clear is a no-op
   *     even if the connector's row is later re-created (defensive — the
   *     `#updateState` no-op on missing slot would catch it anyway).
   *   - `#cacheWriteGen` so a fire-and-forget cache write scheduled before
   *     the bump checks the new generation and skips.
   *
   * Centralised so the teardown paths stay in sync; an earlier draft bumped
   * only one and that was the kind of drift that becomes a bug later.
   */
  #invalidateConnectorRefresh(connectorId: string): void {
    this.#bumpConnectorSeq(connectorId);
    this.#refreshOneToken.set(
      connectorId,
      (this.#refreshOneToken.get(connectorId) ?? 0) + 1,
    );
    this.#cacheWriteGen.set(
      connectorId,
      (this.#cacheWriteGen.get(connectorId) ?? 0) + 1,
    );
  }

  // ─── Persistent connector-state cache ───────────────────────
  /**
   * Read the on-disk cache for every active connector and seed
   * `perConnectorState`. Iterates `this.connectors` in array order (which
   * is already `(createdAt asc, connectorId asc)` from
   * `#syncConnectorsFromRecords`) so the Map's insertion order matches —
   * the metadata-owner tiebreak in {@link mergeDevices} depends on this.
   *
   * Only seeds connectors whose live state is still empty
   * ({@code devices.size === 0}). Calling `bootstrap()` after an
   * `addConnector` or label rename must NOT clobber live data with a stale
   * cache snapshot.
   */
  async #seedFromCache(): Promise<void> {
    for (const connector of this.connectors) {
      const id = connector.connectorId;
      // Capture the BEFORE-await state so we can detect mid-await changes.
      // Two races can interleave with the `await cache.read(id)`:
      //   1. A refresh completes and writes fresh `perConnectorState[id]`.
      //      The stale cache must NOT clobber it — assert the slot is
      //      still the same empty `live` reference on return.
      //   2. `removeConnector(id)` runs, deleting the slot entirely (and
      //      bumping every generation counter). The connector is gone
      //      from `this.connectors` and the slot is missing from
      //      `perConnectorState`. We must NOT resurrect either.
      const liveBefore = this.perConnectorState.get(id);
      if (!liveBefore || liveBefore.devices.size > 0) continue;
      const cached = await this.#connectorStateCache.read(id).catch((e) => {
        console.warn("[ConnectorManager] cache read failed", id, e);
        return null;
      });
      if (!cached) continue;
      // Post-await guards. Identity comparison (`liveNow !== liveBefore`)
      // catches a refresh that replaced the slot; the explicit connectors
      // check catches a remove that emptied the list.
      const liveNow = this.perConnectorState.get(id);
      if (liveNow !== liveBefore) continue;
      if (!this.connectors.some((c) => c.connectorId === id)) continue;
      this.perConnectorState.set(id, deserializeFromCache(cached));
    }
    // Single reactivity bump after seeding all connectors — avoids one
    // Svelte invalidation per connector during bootstrap.
    this.perConnectorState = new Map(this.perConnectorState);
  }

  /**
   * Fire-and-forget cache write after a successful per-connector refresh.
   * Errors (quota, transient IDB failure) are logged + swallowed: the
   * cache is best-effort and a miss just means the next bootstrap shows
   * the empty grid for a few hundred ms before the first refresh fills it.
   *
   * The deletion-generation guard before the put narrows the
   * remove-then-resurrect race window to microseconds (see the docstring
   * on {@link #cacheWriteGen}).
   */
  #writeCacheGuarded(connectorId: string, state: ConnectorRefreshState): void {
    const myGen = this.#cacheWriteGen.get(connectorId) ?? 0;
    const entry = serializeToCache(connectorId, state);
    // `writeIfCurrent` evaluates the predicate AFTER `getDb()` resolves,
    // right before queuing the put. Pushing the gen check down past the
    // DB-open async gap shrinks the residual race window vs. checking the
    // gen here in the caller. See {@link ConnectorStateCache.writeIfCurrent}.
    void this.#connectorStateCache
      .writeIfCurrent(
        entry,
        () => (this.#cacheWriteGen.get(connectorId) ?? 0) === myGen,
      )
      .catch((e) => {
        console.warn("[ConnectorManager] cache write failed", connectorId, e);
      });
  }

  /** Increment the refresh refcount; flip {@link loading} on the rising edge. */
  #beginRefreshPass(): void {
    this.#loadingCount++;
    if (this.#loadingCount === 1) this.loading = true;
  }

  /** Decrement the refresh refcount; flip {@link loading} on the falling edge. */
  #endRefreshPass(): void {
    this.#loadingCount--;
    if (this.#loadingCount === 0) this.loading = false;
  }

  // ─── Refresh ─────────────────────────────────────────────────
  /**
   * Fan-out refresh across all active connectors. Per-connector errors are
   * captured into `perConnectorState.lastError` and surface via
   * {@link mergedIssues}; they do NOT block the merge or the other connectors.
   */
  async refreshAll(): Promise<void> {
    const mySeq = ++this.#refreshSeq;
    this.#beginRefreshPass();
    try {
      const results = await Promise.all(this.connectors.map((c) => this.#refreshOne(c, mySeq)));
      if (mySeq !== this.#refreshSeq) return; // a newer refreshAll superseded us
      const now = new Date();
      this.lastRefreshedAt = now;
      // `#refreshOne` swallows its own per-connector errors and returns a
      // success flag, so we can't infer success from Promise.allSettled —
      // it would mark every refresh as fulfilled. Track explicit success
      // counts: `lastSuccessAt` only advances when every active connector's
      // refresh completed without error.
      //
      // Note: `"stale"` (e.g. a per-connector `refreshOne(A)` raced this
      // pass's leg for A) is NOT `"ok"` — so a full-pass success indicator
      // only fires when every connector's full-pass leg landed cleanly,
      // matching the existing semantics.
      if (results.length > 0 && results.every((r) => r === "ok")) {
        this.lastSuccessAt = now;
      }
      // Drain pending file-share publishes after the refresh writes settle.
      // We run this on every `refreshAll` regardless of pass-level success —
      // a retry attempt isn't tied to "every connector succeeded this tick",
      // and `drainRetryQueue` handles per-connector failures internally.
      // Errors are swallowed so drain blowups don't crash the refresh loop;
      // surfacing happens via `lastError` on the affected connectors.
      await this.#drainRetryQueue().catch((e) => {
        console.warn("[ConnectorManager] retry-queue drain failed", e);
      });
    } finally {
      this.#endRefreshPass();
    }
  }

  /**
   * Refresh exactly one connector. Used by the Sync Sources screen's per-card
   * Refresh button so a single failing connector can be retried without
   * fanning out across every other linked source.
   *
   * Race semantics:
   *   - **`refreshOne` during `refreshAll`**: this call's per-connector token
   *     bump stales the full-pass leg for the same connector (it returns
   *     `"stale"` and skips its write). `refreshAll`'s `lastSuccessAt`
   *     guard treats `"stale"` as not-`"ok"`, so it won't advance for that
   *     pass — accurate, since we never observed an all-clear in a single
   *     fanned-out tick.
   *   - **`refreshAll` during `refreshOne`**: `refreshAll` bumps the global
   *     `#refreshSeq` → this `#refreshOne(connector, oldRefreshSeq)`'s
   *     `isStale()` fires and discards its write. The token gate also
   *     prevents its late completion from clearing a newer pass's spinner.
   *   - **`refreshOne(A)` during `refreshOne(A)`**: the second call bumps
   *     both the per-connector seq and token. The first call's write is
   *     staled and its spinner clear is gated; only the second writes.
   */
  async refreshOne(connectorId: string): Promise<void> {
    const connector = this.connectors.find((c) => c.connectorId === connectorId);
    if (!connector) return; // already removed
    // Invalidate any older in-flight pass for this connector (whether driven
    // by `refreshAll` or by a prior `refreshOne`).
    this.#bumpConnectorSeq(connectorId);
    this.#beginRefreshPass();
    try {
      // Use the current global `refreshSeq` as the captured tag: refreshOne
      // doesn't supersede a refreshAll, so it shouldn't bump the global. If a
      // refreshAll starts mid-flight, the `isStale()` guard in `#refreshOne`
      // will see the global advance and discard our write — that's the right
      // behaviour (the full-pass result is the more authoritative one).
      await this.#refreshOne(connector, this.#refreshSeq);
    } finally {
      this.#endRefreshPass();
    }
  }

  async #refreshOne(
    connector: OctiServerConnector,
    refreshSeq: number,
  ): Promise<"ok" | "error" | "stale"> {
    const connectorId = connector.connectorId;
    const startConnectorSeq = this.#connectorSeq.get(connectorId) ?? 0;
    const crypti = this.#crypti.get(connectorId);
    const cache = this.#etagCache.get(connectorId);
    // `crypti`/`cache` are populated in `#syncConnectorsFromRecords` for every
    // active connector and only deleted on remove. So `undefined` here means
    // the connector was removed between `refreshOne()` (which checked
    // `this.connectors` for membership) and now — i.e. a teardown race. We
    // skip the token bump and the `refreshing=true` write because the row
    // has been removed from `perConnectorState` and there's nothing to
    // spin on. Returning "stale" lets `refreshAll` correctly treat this
    // leg as not-`"ok"` for its `lastSuccessAt` guard.
    if (!crypti || !cache) return "stale";

    // Bump and capture the spinner-clear token for THIS pass. Only this
    // exact token may clear `refreshing` on exit — a later pass increments
    // the token and the older completion no-ops on its way out, leaving
    // the newer pass's spinner visible.
    const myToken = (this.#refreshOneToken.get(connectorId) ?? 0) + 1;
    this.#refreshOneToken.set(connectorId, myToken);

    const isStale = (): boolean =>
      // Either the connector was removed mid-flight OR a fresher refreshAll
      // bumped the global generation. In either case our writes are
      // semantically out-of-date — drop them.
      //
      // Use the same `?? 0` fallback as `startConnectorSeq`: the Map starts
      // empty so `get(...)` returns `undefined` until `removeConnector`
      // bumps it. Without this normalization, `undefined !== 0` always
      // returns true and every refresh appears stale.
      (this.#connectorSeq.get(connectorId) ?? 0) !== startConnectorSeq ||
      refreshSeq !== this.#refreshSeq;

    // Flip `refreshing=true` for this connector's spinner. Use the per-state
    // update helper so the Map reference is replaced (Svelte reactivity).
    this.#updateState(connectorId, (s) => ({ ...s, refreshing: true }));

    try {
      const devices = await connector.listDevices();
      // Per-device, per-module fetches with bounded concurrency.
      const tasks: Array<() => Promise<RefreshedModule>> = [];
      for (const d of devices) {
        for (const m of MODULE_FETCHERS) {
          tasks.push(async () => {
            const r = await m.fetch(connector, crypti, cache, d.id);
            return {
              deviceId: d.id,
              moduleId: m.moduleId,
              value: r.value,
              modifiedAt: r.modifiedAt,
              error: r.error,
            };
          });
        }
      }
      const refreshed = await runWithConcurrency(
        ConnectorManager.MODULE_FETCH_CONCURRENCY,
        tasks,
      );
      if (isStale()) return "stale";

      // Reshape into devices map.
      const deviceMap = new Map<string, DeviceConnectorState>();
      for (const d of devices) {
        deviceMap.set(d.id, { raw: d, modules: new Map() });
      }
      for (const r of refreshed) {
        const entry = deviceMap.get(r.deviceId);
        if (!entry) continue;
        entry.modules.set(r.moduleId, { value: r.value, modifiedAt: r.modifiedAt, error: r.error });
      }

      this.#updateState(connectorId, () => ({
        devices: deviceMap,
        lastError: null,
        lastRefreshedAt: new Date(),
        lastSuccessAt: new Date(),
        // Spinner clears only if this token is still the latest. A newer
        // pass left `refreshing=true` and bumped the token; leave it.
        refreshing: this.#refreshOneToken.get(connectorId) !== myToken,
      }));
      // Persist for next session's bootstrap. Fire-and-forget — the IDB
      // write doesn't gate the next refresh tick. See
      // {@link #writeCacheGuarded} for the deletion-race guard.
      const fresh = this.perConnectorState.get(connectorId);
      if (fresh) this.#writeCacheGuarded(connectorId, fresh);
      return "ok";
    } catch (e) {
      if (isStale()) return "stale";
      this.#updateState(connectorId, (prev) => ({
        devices: prev.devices,
        lastError: e instanceof Error ? e.message : String(e),
        lastRefreshedAt: new Date(),
        lastSuccessAt: prev.lastSuccessAt,
        refreshing: this.#refreshOneToken.get(connectorId) !== myToken,
      }));
      return "error";
    }
    // No `finally` cleanup needed:
    //   - Stale returns (`isStale()` true) intentionally leave the row
    //     untouched; the newer pass is in charge of `refreshing`.
    //   - The success / error paths above already clear `refreshing` only
    //     when this token is still the latest (token gate).
    //   - The earliest return (`!crypti || !cache`) bails BEFORE setting
    //     `refreshing=true`, so there's nothing to clean up.
  }

  /**
   * Mutate `perConnectorState.get(id)` in place AND replace the Map
   * reference so Svelte's `$state(Map)` reactivity fires. If the slot is
   * gone (connector removed mid-flight), this is a no-op.
   *
   * Centralised so every refresh / publish path that touches per-connector
   * state goes through the same shape — adding a new field (e.g. `refreshing`)
   * only needs to be threaded through here and the type, not every site.
   */
  #updateState(
    connectorId: string,
    transform: (prev: ConnectorRefreshState) => ConnectorRefreshState,
  ): void {
    const prev = this.perConnectorState.get(connectorId);
    if (!prev) return;
    this.perConnectorState.set(connectorId, transform(prev));
    this.perConnectorState = new Map(this.perConnectorState); // reactivity
  }

  // ─── Publish fan-out (own modules) ──────────────────────────
  /**
   * Publish own MetaInfo to every connector. Each connector encrypts with
   * its own keyset. Partial failures become per-connector issues; the
   * successful writes still go through.
   */
  async publishOwnMetaInfo(): Promise<void> {
    await Promise.allSettled(
      this.connectors.map(async (c) => {
        const crypti = this.#crypti.get(c.connectorId);
        if (!crypti) return;
        try {
          await publishOwnMetaInfo({ connector: c, crypti });
        } catch (e) {
          this.#recordPublishError(c.connectorId, "MetaInfo", e);
          throw e;
        }
      }),
    );
  }

  async publishOwnClipboard(info: ClipboardInfo): Promise<void> {
    await Promise.allSettled(
      this.connectors.map(async (c) => {
        const crypti = this.#crypti.get(c.connectorId);
        if (!crypti) return;
        try {
          await publishOwnClipboard({ connector: c, crypti, info });
        } catch (e) {
          this.#recordPublishError(c.connectorId, "Clipboard", e);
          throw e;
        }
      }),
    );
  }

  #recordPublishError(connectorId: string, moduleLabel: string, e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    this.#updateState(connectorId, (prev) => ({
      ...prev,
      lastError: `${moduleLabel} publish failed: ${msg}`,
      lastRefreshedAt: new Date(),
    }));
  }

  // ─── File-share fan-out ─────────────────────────────────────
  /**
   * Two-phase fan-out file upload:
   *   1. Encrypt + upload the blob to EVERY active connector in parallel.
   *      Each connector has its own encryption keyset, so the ciphertext
   *      differs per connector. Each server returns a connector-scoped
   *      `blobId`.
   *   2. Build ONE multi-ref {@link SharedFile} (`availableOn` lists every
   *      connector that succeeded, `connectorRefs` maps each to its blob id),
   *      then publish it to every successful connector's own-device
   *      `FileShareInfo`.
   *
   * Partial failures: any connector whose phase-1 upload throws is recorded
   * as a per-connector issue and excluded from the SharedFile's connector
   * sets. The succeeding connectors still publish a coherent
   * `FileShareInfo`. If ALL phase-1 uploads fail, the call rejects with the
   * first reason and no FileShareInfo is published.
   *
   * v1 does NOT retry partial failures on the next poll tick; the user
   * re-uploads to retry. Reflected in the v2 follow-up list in the plan.
   */
  async uploadFile(
    file: File,
    onProgress?: (bytes: number, total: number) => void,
  ): Promise<UploadResult> {
    if (this.connectors.length === 0) {
      throw new Error("No active sync sources — link an account first.");
    }
    const plaintextBytes = new Uint8Array(await file.arrayBuffer());
    const plaintextChecksum = await sha256Hex(plaintextBytes);
    const blobKey = `sha256:${plaintextChecksum}`;

    // Phase 1: fan-out blob upload. `onProgress` is intentionally only wired
    // to the first connector — multiple concurrent progress streams would
    // clobber each other; a single source is enough for the indeterminate
    // progress bar the UI shows today.
    const connectorsForUpload = [...this.connectors];
    const blobResults = await Promise.allSettled(
      connectorsForUpload.map(async (c, i) => {
        const blobCipher = this.#blobCipher.get(c.connectorId);
        if (!blobCipher) throw new Error(`No blob cipher for ${c.connectorId}`);
        const { blobId } = await uploadFileBlobToConnector({
          connector: c,
          blobCipher,
          plaintextBytes,
          blobKey,
          onProgress: i === 0 ? onProgress : undefined,
        });
        return { connectorId: c.connectorId, blobId };
      }),
    );

    const uploads: Array<{ connectorId: string; blobId: string }> = [];
    blobResults.forEach((r, i) => {
      const c = connectorsForUpload[i];
      if (r.status === "fulfilled") {
        uploads.push(r.value);
      } else {
        this.#recordPublishError(c.connectorId, "File blob upload", r.reason);
      }
    });

    if (uploads.length === 0) {
      const firstErr = blobResults.find((r) => r.status === "rejected") as
        | PromiseRejectedResult
        | undefined;
      throw new Error(
        `Blob upload failed on every sync source: ${firstErr ? firstErr.reason : "unknown"}`,
      );
    }

    const shared = buildSharedFile({
      file,
      plaintextSize: plaintextBytes.length,
      blobKey,
      plaintextChecksum,
      uploads,
    });

    // Phase 2: fan-out FileShareInfo publish (only to connectors whose blob
    // upload succeeded; publishing on a connector whose blob is missing
    // would leave a dangling `connectorRefs` entry).
    //
    // Each publish is serialized per-connector against any concurrent retry
    // drain via {@link #runUnderPublishLock} — both paths read-modify-write
    // the same FileShareInfo document with `If-Match`, so without the lock
    // they'd race the ETag and one would 412.
    //
    // Disconnect-during-lock-wait: re-resolving `this.connectors.find()`
    // INSIDE the locked block matters. If a `removeConnector` runs while
    // we're queued behind another publish, the connector is gone by the
    // time we'd actually publish — we'd talk to a torn-down `crypti`
    // (cleared by `removeConnector`) AND enqueue a retry for an id that
    // pruneConnector has already swept. The pattern below resolves both
    // by checking after the lock and returning `"skipped"` so the caller
    // doesn't count it toward success or failure.
    const publishResults: PromiseSettledResult<"published" | "skipped">[] =
      await Promise.allSettled(
        uploads.map(({ connectorId }) =>
          this.#runUnderPublishLock(connectorId, async (): Promise<"published" | "skipped"> => {
            const c = this.connectors.find((c) => c.connectorId === connectorId);
            if (!c) return "skipped";
            const crypti = this.#crypti.get(connectorId);
            if (!crypti) return "skipped";
            try {
              await publishSharedFileEntry({ connector: c, crypti, shared });
              return "published";
            } catch (e) {
              this.#recordPublishError(connectorId, "FileShareInfo", e);
              throw e;
            }
          }),
        ),
      );

    // Classify outcomes. Only true rejections (publish threw) go in
    // `failedConnectorIds` for enqueue — skipped means the connector was
    // gone before we could publish, and re-adding it later wouldn't
    // auto-recover this entry anyway, so a queue row would just dangle.
    let successCount = 0;
    const failedConnectorIds: string[] = [];
    publishResults.forEach((r, i) => {
      const connectorId = uploads[i].connectorId;
      if (r.status === "rejected") {
        failedConnectorIds.push(connectorId);
      } else if (r.value === "published") {
        successCount++;
      }
      // r.value === "skipped" — neither success nor failure; ignore.
    });

    // Track whether we actually persisted the retry to IDB so the throw
    // message below doesn't lie ("queued for retry") when enqueue itself
    // failed.
    let retryPersisted = false;
    if (failedConnectorIds.length > 0) {
      try {
        const { evicted } = await this.#retryQueue.enqueue({
          shared,
          pendingConnectorIds: failedConnectorIds,
        });
        retryPersisted = true;
        for (const ev of evicted) {
          this.#recordRetryDrop(ev, "queue full — older entry evicted");
        }
      } catch (e) {
        console.warn("[ConnectorManager] enqueue retry failed", e);
        // Surface a per-connector issue so the user knows nothing is
        // coming back automatically — they need to re-upload.
        for (const id of failedConnectorIds) {
          this.#recordPublishError(
            id,
            "FileShareInfo retry",
            new Error("Could not queue retry locally"),
          );
        }
      }
    }

    // Two distinct failure modes for "nothing was published":
    //   1. Every phase-2 attempt rejected → some blobs landed but no doc
    //      references them. The retry queue (if persisted) redrives this
    //      on the next refresh tick.
    //   2. Every phase-2 target was skipped because every connector
    //      disconnected between phase 1 and phase 2 → blobs are dangling
    //      and won't be auto-recovered (we don't enqueue skipped ones).
    //      User must re-upload after re-linking.
    if (successCount === 0) {
      const firstErr = publishResults.find((r) => r.status === "rejected") as
        | PromiseRejectedResult
        | undefined;
      const message = firstErr
        ? `File share publish failed on every connector: ${firstErr.reason}${
            retryPersisted ? " (queued for retry)" : ""
          }`
        : `File "${file.name}" couldn't be shared — every sync source disconnected before metadata publish`;
      throw new Error(message);
    }
    return { shared };
  }

  // ─── File-share retry drain ─────────────────────────────────
  /**
   * Walk the file-share retry queue and reattempt each pending publish on
   * its remaining target connectors. Called from {@link refreshAll} at the
   * end of every pass so retries piggyback on the existing poll cadence.
   *
   * For each entry:
   *   - If older than {@link RETRY_PENDING_TTL_MS}: drop. The sync-server's
   *     unlinked-blob TTL is 10 minutes; past our 8-minute safety window,
   *     a successful publish might point at an already-GC'd blob. Surface
   *     an issue and let the user re-upload.
   *   - Otherwise for each `pendingConnectorId` still in `this.connectors`:
   *     publish under the per-connector lock. On success, drop the id from
   *     `pendingConnectorIds`. On failure, leave it for the next pass.
   *   - Increment `attempts` and update `lastAttemptAt` once per entry.
   *   - If `pendingConnectorIds` empties: delete the entry.
   *   - If `attempts` hits {@link RETRY_MAX_ATTEMPTS}: drop and surface an
   *     issue per remaining connector.
   *
   * Disconnected connectors in `pendingConnectorIds` are silently skipped
   * by drain (no publish attempted, no attempts increment for them
   * specifically) — `removeConnector` already calls
   * {@code retryQueue.pruneConnector(id)}, so seeing one here would only
   * be a pruneConnector race. They get cleaned up on the next remove or
   * the entry's TTL.
   */
  async #drainRetryQueue(): Promise<void> {
    // Single-flight: overlapping `refreshAll()` calls share one drain.
    // Without this, two parallel drains both `list()` the snapshot, both
    // try to publish, and the one that finishes second can resurrect a
    // queue entry the first already deleted — the per-connector publish
    // lock only covers the network call, not the IDB row R-M-W.
    if (this.#drainInFlight) return this.#drainInFlight;
    const job = this.#drainRetryQueueInner();
    this.#drainInFlight = job;
    try {
      await job;
    } finally {
      if (this.#drainInFlight === job) this.#drainInFlight = null;
    }
  }

  async #drainRetryQueueInner(): Promise<void> {
    const all = await this.#retryQueue.list().catch(() => [] as PendingPublish[]);
    if (all.length === 0) return;

    const now = Date.now();
    // Process entries in parallel — each entry's publishes are already
    // serialized per-connector by the publish lock, and different entries
    // targeting the same connector serialize transparently through that
    // same lock. So parallel here is safe and faster.
    await Promise.all(
      all.map(async (entry) => {
        // TTL: drop expired entries before we attempt them. The blob they
        // reference may already be GC'd on the server side.
        if (now - entry.createdAt > RETRY_PENDING_TTL_MS) {
          await this.#retryQueue.delete(entry.id).catch(() => undefined);
          this.#recordRetryDrop(entry, "expired before all sync sources accepted");
          return;
        }

        const remaining: string[] = [];
        for (const connectorId of entry.pendingConnectorIds) {
          // We re-resolve connector + crypto inside the lock below.
          // Checking them OUTSIDE the lock is just a fast-path
          // optimisation — if the connector is already gone before we
          // queue up, skip the lock entirely.
          if (!this.connectors.some((c) => c.connectorId === connectorId)) {
            continue;
          }
          try {
            const outcome = await this.#runUnderPublishLock(
              connectorId,
              async (): Promise<"published" | "skipped"> => {
                // Re-check after acquiring the lock. A `removeConnector`
                // racing with us would have cleared crypti by the time
                // we'd publish; without this check we'd talk to a torn-
                // down crypti and either crash or write to a connector
                // the user just disconnected.
                const connector = this.connectors.find((c) => c.connectorId === connectorId);
                if (!connector) return "skipped";
                const crypti = this.#crypti.get(connectorId);
                if (!crypti) return "skipped";
                await publishSharedFileEntry({ connector, crypti, shared: entry.shared });
                return "published";
              },
            );
            if (outcome === "skipped") {
              // Connector vanished mid-attempt — drop it from this
              // entry's pending list (matches removeConnector's prune).
              continue;
            }
          } catch (e) {
            // Still failing on this connector; keep it for the next drain.
            remaining.push(connectorId);
            this.#recordPublishError(connectorId, "FileShareInfo retry", e);
          }
        }

        const nextAttempts = entry.attempts + 1;
        if (remaining.length === 0) {
          // Every target succeeded (or vanished) — entry is done.
          await this.#retryQueue.delete(entry.id).catch(() => undefined);
          return;
        }
        if (nextAttempts >= RETRY_MAX_ATTEMPTS) {
          await this.#retryQueue.delete(entry.id).catch(() => undefined);
          this.#recordRetryDrop(
            { ...entry, pendingConnectorIds: remaining },
            `gave up after ${RETRY_MAX_ATTEMPTS} attempts`,
          );
          return;
        }
        await this.#retryQueue
          .update({
            ...entry,
            pendingConnectorIds: remaining,
            attempts: nextAttempts,
            lastAttemptAt: now,
          })
          .catch(() => undefined);
      }),
    );
  }

  /**
   * Surface a one-shot issue for each connector affected by a dropped
   * retry entry (TTL expiry, queue cap eviction, or attempts cap). Writes
   * via {@link #recordPublishError}'s normal channel so the issue appears
   * in {@link mergedIssues} alongside other connector errors.
   */
  #recordRetryDrop(entry: PendingPublish, reason: string): void {
    for (const connectorId of entry.pendingConnectorIds) {
      this.#recordPublishError(
        connectorId,
        "FileShareInfo retry",
        new Error(`File "${entry.shared.name}" ${reason}`),
      );
    }
  }

  /**
   * Download a {@link SharedFile} from any connector that hosts it AND is
   * one of our active connectors. Picks the first match deterministically
   * (insertion order of `this.connectors`, which is `(createdAt asc,
   * connectorId asc)`). Throws if no active connector hosts this file.
   */
  async downloadFile(file: SharedFile, ownerDeviceId: string): Promise<DownloadedFile> {
    const candidate = this.connectors.find((c) => c.connectorId in file.connectorRefs);
    if (!candidate) {
      throw new Error(
        `File "${file.name}" isn't stored on any of your sync sources; available on: ${
          Object.keys(file.connectorRefs).join(", ") || "(none)"
        }`,
      );
    }
    const blobCipher = this.#blobCipher.get(candidate.connectorId);
    if (!blobCipher) {
      throw new Error(`BlobCipher missing for ${candidate.connectorId}`);
    }
    return downloadSharedFile({
      connector: candidate,
      blobCipher,
      ownerDeviceId,
      file,
    });
  }

  // ─── Internal accessors (sync layer only) ───────────────────
  /**
   * Reveal the per-connector {@link PayloadEncryption} so internal helpers
   * (and tests) can encrypt per-connector. Not for external use — the public
   * surface is the fan-out methods above.
   */
  cryptiFor(connectorId: string): PayloadEncryption | undefined {
    return this.#crypti.get(connectorId);
  }

  blobCipherFor(connectorId: string): BlobCipher | undefined {
    return this.#blobCipher.get(connectorId);
  }

  // ─── Test seam ──────────────────────────────────────────────
  /**
   * Replace the manager's internal connector list + per-connector crypto
   * runtimes with mocks. Test-only — production goes through
   * {@link bootstrap} / {@link addConnector} which read from
   * `credentialsRepo` and build real connectors.
   */
  __setConnectorsForTest(args: {
    connectors: OctiServerConnector[];
    crypti: Map<string, PayloadEncryption>;
    blobCipher?: Map<string, BlobCipher>;
  }): void {
    this.connectors = args.connectors;
    this.#crypti = args.crypti;
    if (args.blobCipher) this.#blobCipher = args.blobCipher;
    // Reset the per-connector caches so each test starts clean.
    for (const c of args.connectors) {
      if (!this.#etagCache.has(c.connectorId)) {
        this.#etagCache.set(c.connectorId, createEtagCache<unknown>());
      }
    }
  }

  /**
   * Swap the retry queue. Lets tests inject a fresh instance so cases that
   * exercise enqueue / drain don't share state on the module-level
   * singleton's IDB database — vitest can run tests in parallel and
   * cross-test bleed there would be its own debugging hell.
   */
  __setRetryQueueForTest(q: FileShareRetryQueue): void {
    this.#retryQueue = q;
  }

  /**
   * Swap the connector-state cache. Same rationale as
   * {@link __setRetryQueueForTest} — lets the tests use a fresh instance
   * so cross-test state on the module-level singleton doesn't leak.
   */
  __setConnectorStateCacheForTest(c: ConnectorStateCache): void {
    this.#connectorStateCache = c;
  }
}

// ─── Cache (de)serialization ────────────────────────────────────
/**
 * Convert the live {@link ConnectorRefreshState} (Maps) into the storage
 * shape (arrays). Maps would structured-clone fine too, but arrays are
 * easier for the cache's defensive shape validator to check on read.
 *
 * The `refreshing` field is intentionally NOT persisted — a spinner that
 * was true at the moment of process exit must not come back true on the
 * next session.
 */
function serializeToCache(
  connectorId: string,
  state: ConnectorRefreshState,
): CachedConnectorState {
  return {
    connectorId,
    version: CACHE_CURRENT_VERSION,
    lastError: state.lastError,
    lastRefreshedAt: state.lastRefreshedAt,
    lastSuccessAt: state.lastSuccessAt,
    devices: Array.from(state.devices.values()).map((d) => ({
      id: d.raw.id,
      raw: d.raw,
      modules: Array.from(d.modules.entries()).map(([moduleId, m]) => ({
        moduleId,
        value: m.value,
        modifiedAt: m.modifiedAt,
        error: m.error,
      })),
    })),
  };
}

/** Inverse of {@link serializeToCache}. */
function deserializeFromCache(cached: CachedConnectorState): ConnectorRefreshState {
  const devices = new Map<string, DeviceConnectorState>();
  for (const d of cached.devices) {
    const modules = new Map<string, ModuleEntry>();
    for (const m of d.modules) {
      modules.set(m.moduleId, {
        value: m.value,
        modifiedAt: m.modifiedAt,
        error: m.error,
      });
    }
    devices.set(d.id, { raw: d.raw, modules });
  }
  return {
    devices,
    lastError: cached.lastError,
    lastRefreshedAt: cached.lastRefreshedAt,
    lastSuccessAt: cached.lastSuccessAt,
    refreshing: false,
  };
}

// ─── Module fetcher table ───────────────────────────────────────
/** Per-module result shape returned from the fetcher table — pre-`moduleId`. */
interface FetcherOutcome {
  value: unknown;
  modifiedAt: Date | null;
  error: string | null;
}

interface ModuleFetcher {
  moduleId: string;
  fetch: (
    connector: OctiServerConnector,
    crypti: PayloadEncryption,
    cache: EtagCache<unknown>,
    peerDeviceId: string,
  ) => Promise<FetcherOutcome>;
}

/**
 * Wrap a module fetcher so a thrown error becomes `{value: null,
 * modifiedAt: null, error: msg}` instead of propagating. Lets `#refreshOne`
 * collect per-module errors per device without blowing up the whole connector
 * tick on one bad payload.
 */
function wrapFetcherErr(
  fn: () => Promise<{ value: unknown; modifiedAt: Date | null }>,
): Promise<FetcherOutcome> {
  return fn()
    .then((r) => ({ value: r.value, modifiedAt: r.modifiedAt, error: null }))
    .catch((e) => ({
      value: null,
      modifiedAt: null,
      error: e instanceof Error ? e.message : String(e),
    }));
}

const MODULE_FETCHERS: ModuleFetcher[] = [
  {
    moduleId: META_MODULE_ID,
    fetch: (c, crypti, _cache, peerDeviceId) =>
      wrapFetcherErr(() =>
        fetchPeerMetaInfo({ connector: c, crypti, peerDeviceId }),
      ),
  },
  {
    moduleId: CLIPBOARD_MODULE_ID,
    fetch: (c, crypti, _cache, peerDeviceId) =>
      wrapFetcherErr(() =>
        fetchPeerClipboard({ connector: c, crypti, peerDeviceId }),
      ),
  },
  {
    moduleId: FILES_MODULE_ID,
    fetch: (c, crypti, _cache, peerDeviceId) =>
      wrapFetcherErr(() =>
        // fetchPeerFileShareInfo returns `{ info, modifiedAt }` — adapt to the
        // common shape used by every other fetcher.
        fetchPeerFileShareInfo({ connector: c, crypti, peerDeviceId }).then((r) => ({
          value: r.info,
          modifiedAt: r.modifiedAt,
        })),
      ),
  },
  {
    moduleId: POWER_MODULE_ID,
    fetch: (c, crypti, cache, peerDeviceId) =>
      wrapFetcherErr(() =>
        fetchPeerModule({
          connector: c,
          crypti,
          peerDeviceId,
          moduleId: POWER_MODULE_ID,
          decode: decodePowerInfo,
          cache,
        }),
      ),
  },
  {
    moduleId: WIFI_MODULE_ID,
    fetch: (c, crypti, cache, peerDeviceId) =>
      wrapFetcherErr(() =>
        fetchPeerModule({
          connector: c,
          crypti,
          peerDeviceId,
          moduleId: WIFI_MODULE_ID,
          decode: decodeWifiInfo,
          cache,
        }),
      ),
  },
  {
    moduleId: CONNECTIVITY_MODULE_ID,
    fetch: (c, crypti, cache, peerDeviceId) =>
      wrapFetcherErr(() =>
        fetchPeerModule({
          connector: c,
          crypti,
          peerDeviceId,
          moduleId: CONNECTIVITY_MODULE_ID,
          decode: decodeConnectivityInfo,
          cache,
        }),
      ),
  },
  {
    moduleId: APPS_MODULE_ID,
    fetch: (c, crypti, cache, peerDeviceId) =>
      wrapFetcherErr(() =>
        fetchPeerModule({
          connector: c,
          crypti,
          peerDeviceId,
          moduleId: APPS_MODULE_ID,
          decode: decodeAppsInfo,
          cache,
        }),
      ),
  },
];

interface RefreshedModule {
  deviceId: string;
  moduleId: string;
  value: unknown;
  modifiedAt: Date | null;
  error: string | null;
}

async function runWithConcurrency<T>(limit: number, tasks: Array<() => Promise<T>>): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      out[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}

// ─── Types: per-connector state ─────────────────────────────────
export interface ModuleEntry {
  value: unknown; // typed per moduleId, see exportShape() below
  modifiedAt: Date | null;
  error: string | null;
}

export interface DeviceConnectorState {
  raw: DeviceMetadata;
  modules: Map<string, ModuleEntry>;
}

export interface ConnectorRefreshState {
  devices: Map<string, DeviceConnectorState>;
  lastError: string | null;
  lastRefreshedAt: Date | null;
  lastSuccessAt: Date | null;
  /**
   * True while a refresh is currently in flight for this connector — set
   * by `ConnectorManager.refreshOne()` or the per-connector legs of
   * `refreshAll()`. Used by `ConnectorCard` to show a per-row spinner.
   * Cleared only by the most-recent in-flight pass (token gate in
   * `ConnectorManager`) so a stale older completion can't drop a newer
   * pass's spinner.
   */
  refreshing: boolean;
}

export interface Issue {
  connectorId: string;
  message: string;
}

// ─── Merge engine ───────────────────────────────────────────────
export interface EnrichedDevice {
  raw: DeviceMetadata;
  /** ConnectorId that owns the raw metadata (first-seen tiebreak). */
  metadataOwnerConnectorId: string;
  meta: MetaInfo | null;
  metaError: string | null;
  clipboard: ClipboardInfo | null;
  clipboardError: string | null;
  fileShare: FileShareInfo | null;
  fileShareError: string | null;
  power: PowerInfo | null;
  powerError: string | null;
  wifi: WifiInfo | null;
  wifiError: string | null;
  connectivity: ConnectivityInfo | null;
  connectivityError: string | null;
  apps: AppsInfo | null;
  appsError: string | null;
  /** Per-module: which connector contributed the winning value. Used by file download. */
  modulesByConnector: Map<string, string>;
}

/**
 * Public so tests can drive the merge directly without spinning up a real
 * refresh loop.
 */
export function mergeDevices(
  perConnectorState: Map<string, ConnectorRefreshState>,
): EnrichedDevice[] {
  // First-seen-connector wins for metadata ownership. The map's insertion
  // order matters: ConnectorManager.#syncConnectorsFromRecords sorts by
  // (createdAt asc, connectorId asc) before populating, so iteration order is
  // already the desired tiebreak.
  const owner = new Map<string, string>(); // deviceId → connectorId
  const winner = new Map<string, { connectorId: string; modifiedAt: Date | null; entry: ModuleEntry }>(); // key = `${deviceId}:${moduleId}`
  const byDevice = new Map<string, DeviceMetadata>();

  for (const [connectorId, state] of perConnectorState) {
    for (const [deviceId, dcs] of state.devices) {
      if (!owner.has(deviceId)) {
        owner.set(deviceId, connectorId);
        byDevice.set(deviceId, dcs.raw);
      }
      for (const [moduleId, entry] of dcs.modules) {
        const key = `${deviceId}:${moduleId}`;
        const cur = winner.get(key);
        if (!cur || isNewer(entry.modifiedAt, cur.modifiedAt, connectorId, cur.connectorId)) {
          winner.set(key, { connectorId, modifiedAt: entry.modifiedAt, entry });
        }
      }
    }
  }

  // Materialize EnrichedDevice for each device.
  const out: EnrichedDevice[] = [];
  for (const [deviceId, raw] of byDevice) {
    const ownerId = owner.get(deviceId) as string;
    const get = <T>(moduleId: string): { value: T | null; error: string | null; fromConnector: string | null } => {
      const w = winner.get(`${deviceId}:${moduleId}`);
      if (!w) return { value: null, error: null, fromConnector: null };
      return {
        value: (w.entry.value as T | null) ?? null,
        error: w.entry.error,
        fromConnector: w.connectorId,
      };
    };
    const meta = get<MetaInfo>(META_MODULE_ID);
    const clipboard = get<ClipboardInfo>(CLIPBOARD_MODULE_ID);
    const fileShare = get<FileShareInfo>(FILES_MODULE_ID);
    const power = get<PowerInfo>(POWER_MODULE_ID);
    const wifi = get<WifiInfo>(WIFI_MODULE_ID);
    const connectivity = get<ConnectivityInfo>(CONNECTIVITY_MODULE_ID);
    const apps = get<AppsInfo>(APPS_MODULE_ID);
    const modulesByConnector = new Map<string, string>();
    for (const [id, contributor] of [
      [META_MODULE_ID, meta.fromConnector],
      [CLIPBOARD_MODULE_ID, clipboard.fromConnector],
      [FILES_MODULE_ID, fileShare.fromConnector],
      [POWER_MODULE_ID, power.fromConnector],
      [WIFI_MODULE_ID, wifi.fromConnector],
      [CONNECTIVITY_MODULE_ID, connectivity.fromConnector],
      [APPS_MODULE_ID, apps.fromConnector],
    ] as const) {
      if (contributor) modulesByConnector.set(id, contributor);
    }
    out.push({
      raw,
      metadataOwnerConnectorId: ownerId,
      meta: meta.value,
      metaError: meta.error,
      clipboard: clipboard.value,
      clipboardError: clipboard.error,
      fileShare: fileShare.value,
      fileShareError: fileShare.error,
      power: power.value,
      powerError: power.error,
      wifi: wifi.value,
      wifiError: wifi.error,
      connectivity: connectivity.value,
      connectivityError: connectivity.error,
      apps: apps.value,
      appsError: apps.error,
      modulesByConnector,
    });
  }
  return out;
}

/**
 * Returns true if `(candidateAt, candidateConnectorId)` should beat
 * `(currentAt, currentConnectorId)`. Missing/invalid `modifiedAt` is the
 * oldest possible value (epoch 0). Ties on `modifiedAt` break on
 * `connectorId` ascending.
 */
function isNewer(
  candidateAt: Date | null,
  currentAt: Date | null,
  candidateConnectorId: string,
  currentConnectorId: string,
): boolean {
  const a = candidateAt?.getTime() ?? 0;
  const b = currentAt?.getTime() ?? 0;
  if (a !== b) return a > b;
  return candidateConnectorId < currentConnectorId;
}

