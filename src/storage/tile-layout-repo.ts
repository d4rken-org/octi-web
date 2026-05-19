import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import {
  defaultLayoutForPlatform,
  mergeLayoutWithRegistry,
  type TileLayout,
} from "../modules/module-registry";

/**
 * Per-device tile layout persistence.
 *
 * Opens a SEPARATE IndexedDB database (`octi-web-tile-layouts`) so its schema
 * version can move independently from `credentials-repo`'s `octi-web` DB. If
 * we shared the DB, a `tile-layout` migration would conflict with an existing
 * open v1 connection from the credentials repo and trigger blocked-upgrade
 * errors at startup. Two-DB isolation costs us nothing — IndexedDB handles
 * dozens of databases per origin without issue.
 *
 * Records are keyed by (accountId, deviceId). Sign-out should wipe both
 * databases together (see {@link wipeAll}).
 */
export interface TileLayoutRecord {
  accountId: string;
  deviceId: string;
  order: string[];
  wide: string[];
  hidden: string[];
  updatedAt: number;
}

interface TileLayoutDB extends DBSchema {
  layouts: {
    key: [string, string]; // [accountId, deviceId]
    value: TileLayoutRecord;
  };
}

const DB_NAME = "octi-web-tile-layouts";
const DB_VERSION = 1;
const STORE = "layouts";

let dbPromise: Promise<IDBPDatabase<TileLayoutDB>> | null = null;

function getDb(): Promise<IDBPDatabase<TileLayoutDB>> {
  if (!dbPromise) {
    dbPromise = openDB<TileLayoutDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore(STORE, { keyPath: ["accountId", "deviceId"] });
        }
      },
    });
  }
  return dbPromise;
}

function recordToLayout(rec: TileLayoutRecord): TileLayout {
  return { order: rec.order, wide: rec.wide, hidden: rec.hidden };
}

export class TileLayoutRepo {
  /**
   * Get the saved layout for a device, or compute the default for this
   * platform if no record exists. Saved layouts are merged against the
   * current registry to absorb modules added in newer web versions.
   */
  async getOrDefault(args: {
    accountId: string;
    deviceId: string;
    platform: string;
  }): Promise<TileLayout> {
    const db = await getDb();
    const rec = await db.get(STORE, [args.accountId, args.deviceId]);
    if (!rec) return defaultLayoutForPlatform(args.platform);
    return mergeLayoutWithRegistry(recordToLayout(rec), args.platform);
  }

  async save(args: {
    accountId: string;
    deviceId: string;
    layout: TileLayout;
  }): Promise<void> {
    const db = await getDb();
    await db.put(STORE, {
      accountId: args.accountId,
      deviceId: args.deviceId,
      order: args.layout.order,
      wide: args.layout.wide,
      hidden: args.layout.hidden,
      updatedAt: Date.now(),
    });
  }

  async deleteForAccount(accountId: string): Promise<void> {
    const db = await getDb();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    let cursor = await store.openCursor();
    while (cursor) {
      if (cursor.key[0] === accountId) {
        await cursor.delete();
      }
      cursor = await cursor.continue();
    }
    await tx.done;
  }

  /** Hard reset — drops the whole DB. Used by sign-out. */
  async wipeAll(): Promise<void> {
    if (dbPromise) {
      const db = await dbPromise;
      db.close();
      dbPromise = null;
    }
    await indexedDB.deleteDatabase(DB_NAME);
  }
}

export const tileLayoutRepo = new TileLayoutRepo();
