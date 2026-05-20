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
  type CredentialRecord,
  credentialsRepo,
} from "../storage/credentials-repo";
import { getOwnDeviceId } from "../storage/identity-settings";

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
  /** True while at least one connector's refresh is in flight. */
  loading = $state(false);
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

  // ─── Generation guards ───────────────────────────────────────
  #refreshSeq = 0;
  #connectorSeq = new Map<string, number>();
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
   * connector + crypti + blobCipher for each, but does NOT trigger refresh
   * (caller composes that with the poll-loop). Safe to call repeatedly;
   * connectors whose credentials are gone get torn down.
   */
  async bootstrap(): Promise<void> {
    await this.#syncConnectorsSerialized();
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
   * Remove one connector. Invalidates any in-flight refresh for that slot,
   * deletes its credential record, drops per-connector state and caches.
   * Other connectors keep working.
   */
  async removeConnector(connectorId: string): Promise<void> {
    this.#bumpConnectorSeq(connectorId);
    this.perConnectorState.delete(connectorId);
    this.perConnectorState = new Map(this.perConnectorState); // trigger reactivity
    this.#crypti.delete(connectorId);
    this.#blobCipher.delete(connectorId);
    this.#etagCache.delete(connectorId);
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
        this.#bumpConnectorSeq(id);
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
        },
      );
    }
    this.perConnectorState = nextState;
    this.connectors = next;
  }

  #bumpConnectorSeq(connectorId: string): void {
    this.#connectorSeq.set(connectorId, (this.#connectorSeq.get(connectorId) ?? 0) + 1);
  }

  // ─── Refresh ─────────────────────────────────────────────────
  /**
   * Fan-out refresh across all active connectors. Per-connector errors are
   * captured into `perConnectorState.lastError` and surface via
   * {@link mergedIssues}; they do NOT block the merge or the other connectors.
   */
  async refreshAll(): Promise<void> {
    const mySeq = ++this.#refreshSeq;
    this.loading = true;
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
      if (results.length > 0 && results.every((r) => r === "ok")) {
        this.lastSuccessAt = now;
      }
    } finally {
      if (mySeq === this.#refreshSeq) this.loading = false;
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
    if (!crypti || !cache) return "stale"; // raced with remove

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

      this.perConnectorState.set(connectorId, {
        devices: deviceMap,
        lastError: null,
        lastRefreshedAt: new Date(),
        lastSuccessAt: new Date(),
      });
      this.perConnectorState = new Map(this.perConnectorState); // reactivity
      return "ok";
    } catch (e) {
      if (isStale()) return "stale";
      const prev = this.perConnectorState.get(connectorId);
      this.perConnectorState.set(connectorId, {
        devices: prev?.devices ?? new Map(),
        lastError: e instanceof Error ? e.message : String(e),
        lastRefreshedAt: new Date(),
        lastSuccessAt: prev?.lastSuccessAt ?? null,
      });
      this.perConnectorState = new Map(this.perConnectorState);
      return "error";
    }
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
    const prev = this.perConnectorState.get(connectorId);
    if (!prev) return;
    this.perConnectorState.set(connectorId, {
      ...prev,
      lastError: `${moduleLabel} publish failed: ${msg}`,
      lastRefreshedAt: new Date(),
    });
    this.perConnectorState = new Map(this.perConnectorState);
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
    const publishResults = await Promise.allSettled(
      uploads.map(async ({ connectorId }) => {
        const c = this.connectors.find((c) => c.connectorId === connectorId);
        if (!c) throw new Error(`Connector ${connectorId} disappeared during publish`);
        const crypti = this.#crypti.get(connectorId);
        if (!crypti) throw new Error(`Crypto missing for ${connectorId}`);
        try {
          await publishSharedFileEntry({ connector: c, crypti, shared });
        } catch (e) {
          this.#recordPublishError(connectorId, "FileShareInfo", e);
          throw e;
        }
      }),
    );

    const publishOK = publishResults.filter((r) => r.status === "fulfilled").length;
    if (publishOK === 0) {
      // Blobs may have landed on the servers but no FileShareInfo document
      // references them, so peers won't see the file and the server's GC
      // will eventually drop the orphans. Reject so the dashboard's "Shared"
      // status doesn't lie.
      const firstErr = publishResults.find((r) => r.status === "rejected") as
        | PromiseRejectedResult
        | undefined;
      throw new Error(
        `File share publish failed on every connector: ${firstErr ? firstErr.reason : "unknown"}`,
      );
    }
    return { shared };
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

