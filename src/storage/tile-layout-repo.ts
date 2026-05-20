import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";
import {
  defaultLayoutForPlatform,
  mergeLayoutWithRegistry,
  type TileLayout,
} from "../modules/module-registry";
import { OCTI_WEB_CHANNEL } from "../version";

/**
 * Per-device tile layout persistence.
 *
 * Opens a SEPARATE IndexedDB database from `credentials-repo` so its schema
 * version can move independently — sharing the DB would let a tile-layout
 * migration block on an open v1 credentials connection at startup.
 *
 * Records are keyed by `deviceId` alone, mirroring the Android client's
 * `Map<DeviceId, TileLayoutConfig>` in `DashboardConfig.kt`. This relies on
 * the cross-platform invariant that a physical device has a single stable
 * `deviceId` UUID regardless of which connector reaches it — Android
 * deduplicates the dashboard grid on that same key. Sign-out should wipe
 * both databases together (see {@link TileLayoutRepo.wipeAll}).
 *
 * Channel-scoped DB name: canary and stable share the origin, and bumping
 * the version without isolation would let one channel's upgrade trip the
 * other channel's open connection.
 */
export interface TileLayoutRecord {
  deviceId: string;
  order: string[];
  wide: string[];
  hidden: string[];
  updatedAt: number;
}

interface TileLayoutDB extends DBSchema {
  layouts: {
    key: string; // deviceId
    value: TileLayoutRecord;
  };
}

const DB_NAME = `octi-web-tile-layouts-${OCTI_WEB_CHANNEL}`;
const DB_VERSION = 2;
const STORE = "layouts";

let dbPromise: Promise<IDBPDatabase<TileLayoutDB>> | null = null;

function getDb(): Promise<IDBPDatabase<TileLayoutDB>> {
  if (!dbPromise) {
    dbPromise = openDB<TileLayoutDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // v2 schema-of-record: keyPath = "deviceId". Handles fresh installs
        // (no stores yet) and any pre-launch v1 carriers (delete + recreate is
        // safe because v1 never shipped a real user). Channel-scoped DB name
        // means stable and canary upgrade independently.
        if (db.objectStoreNames.contains(STORE)) {
          db.deleteObjectStore(STORE);
        }
        db.createObjectStore(STORE, { keyPath: "deviceId" });
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
    deviceId: string;
    platform: string;
  }): Promise<TileLayout> {
    const db = await getDb();
    const rec = await db.get(STORE, args.deviceId);
    if (!rec) return defaultLayoutForPlatform(args.platform);
    return mergeLayoutWithRegistry(recordToLayout(rec), args.platform);
  }

  async save(args: {
    deviceId: string;
    layout: TileLayout;
  }): Promise<void> {
    const db = await getDb();
    await db.put(STORE, {
      deviceId: args.deviceId,
      order: args.layout.order,
      wide: args.layout.wide,
      hidden: args.layout.hidden,
      updatedAt: Date.now(),
    });
  }

  /**
   * Hard reset — closes the open connection (if any) and drops the whole DB.
   * Used by sign-out + test isolation.
   *
   * Uses `idb`'s {@link deleteDB} rather than `indexedDB.deleteDatabase()`
   * — the latter returns an `IDBOpenDBRequest`, not a Promise, so awaiting it
   * is a no-op and the caller would race past while deletion is still in
   * flight.
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

export const tileLayoutRepo = new TileLayoutRepo();
