import "fake-indexeddb/auto";
import { openDB } from "idb";
import { beforeEach, describe, expect, it } from "vitest";
import {
  APPS_MODULE_ID,
  CLIPBOARD_MODULE_ID,
  CONNECTIVITY_MODULE_ID,
  FILES_MODULE_ID,
  META_MODULE_ID,
  POWER_MODULE_ID,
  WIFI_MODULE_ID,
} from "../modules/module-registry";
import { OCTI_WEB_CHANNEL } from "../version";
import { TileLayoutRepo } from "./tile-layout-repo";

const DB_NAME = `octi-web-tile-layouts-${OCTI_WEB_CHANNEL}`;
const DEVICE = "dev-1";

async function freshRepo(): Promise<TileLayoutRepo> {
  // fake-indexeddb resets per worker, but `dbPromise` inside the module is a
  // closure singleton. Wiping clears both the open handle and the DB itself,
  // so subsequent getOrDefault calls re-open a fresh DB.
  const repo = new TileLayoutRepo();
  await repo.wipeAll();
  return repo;
}

describe("TileLayoutRepo", () => {
  beforeEach(async () => {
    const repo = new TileLayoutRepo();
    await repo.wipeAll();
  });

  it("returns the platform default layout when no record exists", async () => {
    const repo = await freshRepo();
    const layout = await repo.getOrDefault({ deviceId: DEVICE, platform: "web" });
    // Power should be hidden on web (Android/desktop only), Meta/Clipboard/Files visible.
    expect(layout.order).toContain(POWER_MODULE_ID);
    expect(layout.hidden).toContain(POWER_MODULE_ID);
    expect(layout.hidden).toContain(WIFI_MODULE_ID);
    expect(layout.hidden).toContain(APPS_MODULE_ID);
    expect(layout.hidden).not.toContain(META_MODULE_ID);
    expect(layout.hidden).not.toContain(CLIPBOARD_MODULE_ID);
    expect(layout.hidden).not.toContain(FILES_MODULE_ID);
    // Power is the default hero (wide) — even when hidden the wide flag stays.
    expect(layout.wide).toContain(POWER_MODULE_ID);
  });

  it("Android default has nothing hidden", async () => {
    const repo = await freshRepo();
    const layout = await repo.getOrDefault({ deviceId: DEVICE, platform: "android" });
    expect(layout.hidden).toEqual([]);
    expect(layout.wide).toEqual([POWER_MODULE_ID]);
  });

  it("round-trips a saved layout", async () => {
    const repo = await freshRepo();
    const custom = {
      order: [CLIPBOARD_MODULE_ID, META_MODULE_ID, FILES_MODULE_ID],
      wide: [META_MODULE_ID],
      hidden: [],
    };
    await repo.save({ deviceId: DEVICE, layout: custom });
    const loaded = await repo.getOrDefault({ deviceId: DEVICE, platform: "web" });
    // mergeLayoutWithRegistry will splice in the modules missing from `order`.
    // The originally-saved order survives — POWER/WIFI/CONN/APPS get inserted
    // at their default-relative slots and hidden because they aren't supported
    // on web.
    expect(loaded.order.slice(0, 1)).toEqual([POWER_MODULE_ID]);
    expect(loaded.order).toContain(CLIPBOARD_MODULE_ID);
    expect(loaded.order).toContain(META_MODULE_ID);
    expect(loaded.wide).toEqual([META_MODULE_ID]);
    expect(loaded.hidden).toContain(POWER_MODULE_ID);
    expect(loaded.hidden).toContain(WIFI_MODULE_ID);
    expect(loaded.hidden).toContain(CONNECTIVITY_MODULE_ID);
    expect(loaded.hidden).toContain(APPS_MODULE_ID);
  });

  it("save → reload roundtrips a single device's layout independent of other devices", async () => {
    // `mergeLayoutWithRegistry` rewrites the `order` array against the
    // platform default (inserting missing modules at their default slots), so
    // assert via `wide` — which the merger preserves exactly.
    const repo = await freshRepo();
    await repo.save({
      deviceId: "d1",
      layout: { order: [META_MODULE_ID], wide: [META_MODULE_ID], hidden: [] },
    });
    await repo.save({
      deviceId: "d2",
      layout: { order: [CLIPBOARD_MODULE_ID], wide: [CLIPBOARD_MODULE_ID], hidden: [] },
    });
    const d1 = await repo.getOrDefault({ deviceId: "d1", platform: "android" });
    expect(d1.wide).toEqual([META_MODULE_ID]);
    const d2 = await repo.getOrDefault({ deviceId: "d2", platform: "android" });
    expect(d2.wide).toEqual([CLIPBOARD_MODULE_ID]);
  });

  it("wipeAll deletes the whole DB", async () => {
    const repo = await freshRepo();
    await repo.save({
      deviceId: DEVICE,
      layout: { order: [META_MODULE_ID], wide: [], hidden: [] },
    });
    await repo.wipeAll();
    const layout = await repo.getOrDefault({ deviceId: DEVICE, platform: "android" });
    // After wipe, no record → default Android layout (nothing hidden).
    expect(layout.hidden).toEqual([]);
    expect(layout.wide).toEqual([POWER_MODULE_ID]);
  });

  it("v1 → v2 upgrade drops the legacy store and recreates with the new keyPath", async () => {
    // Seed a v1 DB with the old composite keyPath: ["accountId", "deviceId"].
    const v1 = await openDB(DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore("layouts", { keyPath: ["accountId", "deviceId"] });
      },
    });
    await v1.put("layouts", {
      accountId: "legacy-acct",
      deviceId: "legacy-dev",
      order: [META_MODULE_ID],
      wide: [],
      hidden: [],
      updatedAt: 0,
    });
    v1.close();

    // Open via the repo — triggers upgrade(2) which drops the v1 store.
    const repo = new TileLayoutRepo();
    const layout = await repo.getOrDefault({ deviceId: "legacy-dev", platform: "android" });
    // Legacy row was dropped; we get the platform default.
    expect(layout.hidden).toEqual([]);

    // And the new keyPath is in effect: save a v2-shaped record and read it back.
    // Assert via `wide` since merge rewrites `order`.
    await repo.save({
      deviceId: "fresh",
      layout: { order: [META_MODULE_ID], wide: [META_MODULE_ID], hidden: [] },
    });
    const fresh = await repo.getOrDefault({ deviceId: "fresh", platform: "android" });
    expect(fresh.wide).toEqual([META_MODULE_ID]);
  });
});
