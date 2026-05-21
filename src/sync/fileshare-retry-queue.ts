import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";

import type { SharedFile } from "../modules/files";
import { OCTI_WEB_CHANNEL } from "../version";

/**
 * Persistence layer for "phase-2 file-share publishes that haven't landed
 * on every target connector yet". The orchestration (which connector to
 * try next, holding the publish lock, calling `publishSharedFileEntry`,
 * surfacing errors) lives in {@link ConnectorManager}; this module is
 * intentionally pure storage so the two responsibilities don't bleed.
 *
 * Background — see {@code .claude/rules/architecture.md}:
 *
 * `ConnectorManager.uploadFile` is a two-phase fan-out:
 *   1. encrypt + upload the blob to every connector (phase 1).
 *   2. publish a multi-ref `FileShareInfo` document referencing those
 *      blobs to every connector whose phase 1 succeeded (phase 2).
 *
 * If phase 2 fails on a subset of connectors (412 conflict, transient
 * network), peers reaching us via those connectors don't see the file
 * even though its blob is on those servers. Before FU4, the failure
 * surfaced as an issue and the user had to re-upload to retry. This
 * queue lets `refreshAll` redrive the missing phase-2 publishes.
 *
 * Scope: phase-2 retries ONLY. Phase-1 (blob upload) failures still
 * require the user to re-upload — retrying phase 1 would mean persisting
 * the plaintext, which has bigger storage + security implications.
 */
export interface PendingPublish {
  /** Server-issued-style local UUID; key for the IDB store. */
  id: string;
  /**
   * The {@link SharedFile} entry assembled by `uploadFile` at the moment
   * of the original upload. Already contains the per-connector `blobId`s
   * for every connector whose phase 1 succeeded — the retry only needs
   * to commit the metadata document referencing them.
   */
  shared: SharedFile;
  /**
   * Connectors that still need a successful phase-2 publish. The
   * connector-id format matches `OctiServerConnector.connectorId`
   * ({@code kserver-<domain>-<accountId>}). Drained-successful entries
   * are removed from this list; when it goes empty the whole entry is
   * deleted from the queue.
   */
  pendingConnectorIds: string[];
  /** Epoch ms when first enqueued. Used to enforce {@link PENDING_TTL_MS}. */
  createdAt: number;
  /** Epoch ms of the most recent drain attempt, or {@code null} before any. */
  lastAttemptAt: number | null;
  /**
   * Number of drain passes that have included this entry. Capped by
   * {@link MAX_ATTEMPTS}; on cap the entry is deleted and an issue
   * surfaces via {@link ConnectorManager.mergedIssues}.
   */
  attempts: number;
}

/**
 * Drop pending entries older than this. The sync-server's
 * unlinked-blob TTL is 10 minutes (complete-state holds blobs that
 * aren't yet linked from a FileShareInfo). Past that window, a successful
 * phase-2 publish would point at a blob the server has already GC'd, so
 * the joiner would see a 404. The 2-minute safety margin under the
 * server TTL covers clock skew + drain latency.
 */
export const PENDING_TTL_MS = 8 * 60_000;

/** Drop the entry after this many drain attempts and surface a one-shot issue. */
export const MAX_ATTEMPTS = 5;

/**
 * Maximum queue depth. On enqueue overflow the oldest entries are evicted
 * (by `createdAt` ascending) and returned alongside the new entry so the
 * caller can surface a one-shot issue ("Retry queue full; dropped …").
 */
export const QUEUE_CAP = 100;

interface RetryQueueDB extends DBSchema {
  "pending-publishes": {
    key: string; // PendingPublish.id
    value: PendingPublish;
  };
}

/**
 * Channel-scoped database. Same reasoning as {@code credentials-repo.ts}:
 * canary and stable share the origin, so suffixing by channel isolates
 * schemas and avoids cross-channel cross-talk.
 */
const DB_NAME = `octi-web-fileshare-retry-${OCTI_WEB_CHANNEL}`;
const DB_VERSION = 1;
const STORE = "pending-publishes";

let dbPromise: Promise<IDBPDatabase<RetryQueueDB>> | null = null;

function getDb(): Promise<IDBPDatabase<RetryQueueDB>> {
  if (!dbPromise) {
    dbPromise = openDB<RetryQueueDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

/** Result of an enqueue with cap-overflow eviction. */
export interface EnqueueResult {
  entry: PendingPublish;
  evicted: PendingPublish[];
}

export class FileShareRetryQueue {
  /**
   * Add a new pending-publish entry. If the queue is at {@link QUEUE_CAP},
   * evict the oldest by {@code createdAt} (ascending) until there's room
   * for the new one. Evicted entries are returned so the caller can surface
   * a per-connector issue for each affected connector.
   */
  async enqueue(args: {
    shared: SharedFile;
    pendingConnectorIds: string[];
  }): Promise<EnqueueResult> {
    const db = await getDb();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const existing: PendingPublish[] = await store.getAll();
    // Evict oldest first. We want length == QUEUE_CAP - 1 BEFORE adding
    // (so the new entry brings it to exactly QUEUE_CAP).
    const sorted = [...existing].sort((a, b) => a.createdAt - b.createdAt);
    const evicted: PendingPublish[] = [];
    while (sorted.length >= QUEUE_CAP) {
      const drop = sorted.shift();
      if (!drop) break;
      evicted.push(drop);
      await store.delete(drop.id);
    }
    const entry: PendingPublish = {
      id: crypto.randomUUID(),
      shared: args.shared,
      pendingConnectorIds: [...args.pendingConnectorIds],
      createdAt: Date.now(),
      lastAttemptAt: null,
      attempts: 0,
    };
    await store.put(entry);
    await tx.done;
    return { entry, evicted };
  }

  /** List every pending entry (unsorted). Caller sorts if order matters. */
  async list(): Promise<PendingPublish[]> {
    const db = await getDb();
    return db.getAll(STORE);
  }

  /**
   * Write an updated entry back. Used by the drain loop to record progress
   * (decremented `pendingConnectorIds`, incremented `attempts`, updated
   * `lastAttemptAt`).
   */
  async update(entry: PendingPublish): Promise<void> {
    const db = await getDb();
    await db.put(STORE, entry);
  }

  /** Remove a single entry by id. */
  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.delete(STORE, id);
  }

  /**
   * Sweep the queue when a connector is removed: drop the given connectorId
   * from every entry's `pendingConnectorIds`. Entries that go empty as a
   * result are deleted. Returns counts so the caller can log / reason.
   */
  async pruneConnector(connectorId: string): Promise<{ deleted: number; updated: number }> {
    const db = await getDb();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const all: PendingPublish[] = await store.getAll();
    let deleted = 0;
    let updated = 0;
    for (const entry of all) {
      if (!entry.pendingConnectorIds.includes(connectorId)) continue;
      const next = entry.pendingConnectorIds.filter((c) => c !== connectorId);
      if (next.length === 0) {
        await store.delete(entry.id);
        deleted++;
      } else {
        await store.put({ ...entry, pendingConnectorIds: next });
        updated++;
      }
    }
    await tx.done;
    return { deleted, updated };
  }

  /**
   * Drop the whole database. Used by sign-out. Mirrors
   * {@code CredentialsRepo.wipeAll} — uses {@code idb.deleteDB} so the
   * promise actually awaits deletion (unlike the raw
   * {@code indexedDB.deleteDatabase()} which returns an `IDBOpenDBRequest`,
   * not a thenable).
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

export const fileShareRetryQueue = new FileShareRetryQueue();
