import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";

import type { DeviceMetadata } from "../protocol/models";
import { OCTI_WEB_CHANNEL } from "../version";

/**
 * Persistent fallback for {@code ConnectorManager.perConnectorState}. On tab
 * reload the dashboard would otherwise render empty until the first
 * `refreshAll()` completes (hundreds of ms on a fast connection, multiple
 * seconds on slow). Android persists merged state to disk for the same
 * reason — see `app-main/.claude/rules/architecture.md`. This module is
 * web's parallel implementation.
 *
 * Storage uses IndexedDB's structured-clone serialization rather than JSON,
 * which means we can store {@link Date} and {@link Uint8Array} (used by
 * {@code ClipboardInfo.data}) directly without an encoding step on the way
 * in or a hydration step on the way out.
 *
 * Threat model: cached payloads include sensitive material (clipboard text,
 * device labels). The cache is NOT encrypted at rest. An attacker with
 * filesystem access to the browser profile already has the credentials DB
 * (which stores the Tink keyset) and can read live payloads from any server
 * the user has linked. Cache encryption with a key kept in the same profile
 * doesn't materially harden anything, so we skip it. Matches the threat
 * model documented in `credentials-repo.ts`.
 */

/**
 * Bump this when the on-disk shape changes incompatibly (new required
 * field, removed field whose absence breaks downstream code, semantics
 * change for an existing field). On read, entries with a mismatching
 * version are discarded. The discard is silent — the next successful
 * refresh fills the cache back in.
 */
export const CURRENT_CACHE_VERSION = 1;

/**
 * One row's worth of stored connector state. Mirrors the live
 * {@link ConnectorRefreshState} shape but with two structural differences:
 *   - Adds {@code connectorId} (the primary key) and {@code version}.
 *   - Serialises the inner Maps as arrays for shape validation (arrays are
 *     easier to defensively validate than Maps, and the round-trip is
 *     cheap).
 *
 * Module {@code value} entries are stored verbatim — they're whatever the
 * decoder produced. Today every module value is structured-clone-safe
 * ({@code MetaInfo} / {@code ClipboardInfo} with Uint8Array data /
 * {@code FileShareInfo} / power / wifi / connectivity / apps).
 */
export interface CachedConnectorState {
  connectorId: string;
  version: number;
  lastError: string | null;
  lastRefreshedAt: Date | null;
  lastSuccessAt: Date | null;
  devices: ReadonlyArray<CachedDevice>;
}

export interface CachedDevice {
  id: string;
  raw: DeviceMetadata;
  modules: ReadonlyArray<CachedModuleEntry>;
}

export interface CachedModuleEntry {
  moduleId: string;
  value: unknown;
  modifiedAt: Date | null;
  error: string | null;
}

interface ConnectorStateCacheDB extends DBSchema {
  "connector-state": {
    key: string; // connectorId
    value: CachedConnectorState;
  };
}

/**
 * Channel-scoped database — same isolation rationale as
 * {@code credentials-repo.ts}: canary and stable share the origin so
 * suffixing by channel keeps their caches independent.
 */
const DB_NAME = `octi-web-connector-cache-${OCTI_WEB_CHANNEL}`;
const DB_VERSION = 1;
const STORE = "connector-state";

let dbPromise: Promise<IDBPDatabase<ConnectorStateCacheDB>> | null = null;

function getDb(): Promise<IDBPDatabase<ConnectorStateCacheDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ConnectorStateCacheDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "connectorId" });
        }
      },
    });
  }
  return dbPromise;
}

export class ConnectorStateCache {
  /**
   * Look up a connector's last persisted state. Returns {@code null} when:
   *   - the connectorId isn't in the cache (fresh install / first run);
   *   - the entry's {@code version} doesn't match {@link CURRENT_CACHE_VERSION}
   *     (schema bump invalidated it — handled by silent discard, the next
   *     successful refresh repopulates);
   *   - the entry fails defensive shape validation. A misshaped entry
   *     means a decoder changed without the cache version being bumped;
   *     we treat it as cache-miss rather than crashing the dashboard.
   */
  async read(connectorId: string): Promise<CachedConnectorState | null> {
    const db = await getDb();
    const raw = await db.get(STORE, connectorId);
    if (!raw) return null;
    if (!isValidCachedConnectorState(raw)) {
      // Drop the malformed entry so we don't keep re-failing the check.
      await db.delete(STORE, connectorId).catch(() => undefined);
      console.warn(
        "[ConnectorStateCache] discarded malformed entry for",
        connectorId,
      );
      return null;
    }
    return raw;
  }

  /**
   * Persist one connector's state. Overwrites any existing row for the same
   * connectorId. Throws on IDB errors (quota, transaction abort) — callers
   * decide whether to swallow or surface.
   */
  async write(entry: CachedConnectorState): Promise<void> {
    const db = await getDb();
    await db.put(STORE, entry);
  }

  /**
   * Conditional write: the `stillCurrent` predicate is evaluated AFTER
   * `getDb()` resolves, immediately before queuing the put. Returns
   * {@code true} if the write was attempted, {@code false} if the predicate
   * returned false (i.e. the caller's generation bumped during the open).
   *
   * Used by {@code ConnectorManager.#writeCacheGuarded} to narrow the
   * remove-then-resurrect race window. With a plain `write()`, the
   * generation check happens in the caller BEFORE `getDb()` — the open
   * itself is an async gap during which `removeConnector` can run. Pushing
   * the predicate down past `getDb()` shrinks the residual race window to
   * the microseconds between the predicate call and the `db.put()` queue
   * entry; IDB then serialises any subsequent delete against the put in
   * transaction-arrival order.
   *
   * Note: the residual race (predicate-true → put queued → remove's delete
   * queued) is still acceptable in design — stale cache rows are inert
   * (bootstrap only seeds connectors still in credentials) and the next
   * sign-out's `wipeAll` cleans up.
   */
  async writeIfCurrent(
    entry: CachedConnectorState,
    stillCurrent: () => boolean,
  ): Promise<boolean> {
    const db = await getDb();
    if (!stillCurrent()) return false;
    await db.put(STORE, entry);
    return true;
  }

  /** Remove a single connector's cached state. */
  async delete(connectorId: string): Promise<void> {
    const db = await getDb();
    await db.delete(STORE, connectorId);
  }

  /**
   * Drop the entire cache database. Used by sign-out. Mirrors
   * {@code CredentialsRepo.wipeAll} — uses {@link deleteDB} so the promise
   * actually waits for the deletion (unlike raw
   * {@code indexedDB.deleteDatabase()}, which returns a non-thenable
   * {@code IDBOpenDBRequest}).
   */
  async wipeAll(): Promise<void> {
    if (dbPromise) {
      const db = await dbPromise;
      db.close();
      dbPromise = null;
    }
    await deleteDB(DB_NAME);
  }
}

/**
 * Defensive shape validation. Only the fields {@code mergeDevices} reads or
 * the dashboard renders need to be the expected types. We don't deep-check
 * module {@code value} payloads — they're opaque to the cache layer and the
 * dashboard's per-module renderers already guard against missing fields.
 */
function isValidCachedConnectorState(raw: unknown): raw is CachedConnectorState {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  if (typeof r.connectorId !== "string") return false;
  if (r.version !== CURRENT_CACHE_VERSION) return false;
  if (r.lastError !== null && typeof r.lastError !== "string") return false;
  if (r.lastRefreshedAt !== null && !(r.lastRefreshedAt instanceof Date)) return false;
  if (r.lastSuccessAt !== null && !(r.lastSuccessAt instanceof Date)) return false;
  if (!Array.isArray(r.devices)) return false;
  for (const d of r.devices) {
    if (typeof d !== "object" || d === null) return false;
    const dd = d as Record<string, unknown>;
    if (typeof dd.id !== "string") return false;
    if (typeof dd.raw !== "object" || dd.raw === null) return false;
    if (!Array.isArray(dd.modules)) return false;
    for (const m of dd.modules) {
      if (typeof m !== "object" || m === null) return false;
      const mm = m as Record<string, unknown>;
      if (typeof mm.moduleId !== "string") return false;
      if (mm.modifiedAt !== null && !(mm.modifiedAt instanceof Date)) return false;
      if (mm.error !== null && typeof mm.error !== "string") return false;
      // `value` is intentionally not deep-validated.
    }
  }
  return true;
}

export const connectorStateCache = new ConnectorStateCache();
