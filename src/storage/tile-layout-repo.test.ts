import "fake-indexeddb/auto";
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
import { TileLayoutRepo } from "./tile-layout-repo";

const ACCOUNT = "acct-1";
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
    const layout = await repo.getOrDefault({ accountId: ACCOUNT, deviceId: DEVICE, platform: "web" });
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
    const layout = await repo.getOrDefault({ accountId: ACCOUNT, deviceId: DEVICE, platform: "android" });
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
    await repo.save({ accountId: ACCOUNT, deviceId: DEVICE, layout: custom });
    const loaded = await repo.getOrDefault({
      accountId: ACCOUNT,
      deviceId: DEVICE,
      platform: "web",
    });
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

  it("deleteForAccount removes only that account's records", async () => {
    const repo = await freshRepo();
    await repo.save({
      accountId: "a",
      deviceId: "d1",
      layout: { order: [META_MODULE_ID], wide: [], hidden: [] },
    });
    await repo.save({
      accountId: "b",
      deviceId: "d1",
      layout: { order: [META_MODULE_ID], wide: [], hidden: [] },
    });
    await repo.deleteForAccount("a");
    const aFresh = await repo.getOrDefault({ accountId: "a", deviceId: "d1", platform: "android" });
    // Account a's record gone → default Android layout
    expect(aFresh.hidden).toEqual([]);
    // Account b's record survives — saved layout had no power, merge keeps it.
    const bSaved = await repo.getOrDefault({ accountId: "b", deviceId: "d1", platform: "android" });
    expect(bSaved.order).toContain(META_MODULE_ID);
  });

  it("wipeAll deletes the whole DB", async () => {
    const repo = await freshRepo();
    await repo.save({
      accountId: ACCOUNT,
      deviceId: DEVICE,
      layout: { order: [META_MODULE_ID], wide: [], hidden: [] },
    });
    await repo.wipeAll();
    const layout = await repo.getOrDefault({
      accountId: ACCOUNT,
      deviceId: DEVICE,
      platform: "android",
    });
    // After wipe, no record → default Android layout (nothing hidden).
    expect(layout.hidden).toEqual([]);
    expect(layout.wide).toEqual([POWER_MODULE_ID]);
  });
});
