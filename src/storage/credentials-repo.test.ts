// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { CredentialsRepo, type CredentialRecord } from "./credentials-repo";

function makeRecord(overrides: Partial<CredentialRecord> = {}): CredentialRecord {
  return {
    accountId: "acct-1",
    devicePassword: "pwd-1",
    ownDeviceId: "dev-1",
    deviceLabel: "Firefox on Linux",
    serverAddress: { domain: "sync.test", protocol: "https", port: 443 },
    encryptionKeyset: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("CredentialsRepo", () => {
  beforeEach(async () => {
    // Each test gets a clean slate. wipe() clears the store but doesn't drop
    // the DB; combined with localStorage.clear() this is enough for isolation.
    localStorage.clear();
    const repo = new CredentialsRepo();
    await repo.wipe();
  });

  it("save → getActive roundtrips all fields including Uint8Array and nested serverAddress", async () => {
    const repo = new CredentialsRepo();
    const record = makeRecord();
    await repo.save(record);
    const loaded = await repo.getActive();
    expect(loaded).toBeDefined();
    expect(loaded!.accountId).toBe(record.accountId);
    expect(loaded!.devicePassword).toBe(record.devicePassword);
    expect(loaded!.ownDeviceId).toBe(record.ownDeviceId);
    expect(loaded!.deviceLabel).toBe(record.deviceLabel);
    expect(loaded!.createdAt).toBe(record.createdAt);
    expect(loaded!.serverAddress).toEqual(record.serverAddress);
    // Compare keyset bytes by content. Structured clone in fake-indexeddb can
    // round-trip Uint8Array as a Buffer (Node) which trips Vitest's toEqual on
    // the parent record even though contents match. Compare values via Array.
    expect(Array.from(loaded!.encryptionKeyset)).toEqual(Array.from(record.encryptionKeyset));
  });

  it("getActive returns undefined when nothing has been saved", async () => {
    const repo = new CredentialsRepo();
    expect(await repo.getActive()).toBeUndefined();
  });

  it("getActive clears the stale localStorage pointer when the record was deleted out-of-band", async () => {
    const repo = new CredentialsRepo();
    await repo.save(makeRecord({ accountId: "ghost" }));
    // Out-of-band delete: drop the record but leave the active-pointer.
    const db = await indexedDB.open("octi-web", 1);
    await new Promise<void>((resolve, reject) => {
      db.addEventListener("success", () => {
        const tx = db.result.transaction("credentials", "readwrite");
        tx.objectStore("credentials").delete("ghost");
        tx.addEventListener("complete", () => {
          db.result.close();
          resolve();
        });
        tx.addEventListener("error", () => reject(tx.error));
      });
      db.addEventListener("error", () => reject(db.error));
    });
    expect(localStorage.getItem("octi-web.active-account-id")).toBe("ghost");
    const result = await repo.getActive();
    expect(result).toBeUndefined();
    // Stale pointer scrubbed.
    expect(localStorage.getItem("octi-web.active-account-id")).toBeNull();
  });

  it("listAll returns every stored record regardless of which is active", async () => {
    const repo = new CredentialsRepo();
    await repo.save(makeRecord({ accountId: "a" }));
    await repo.save(makeRecord({ accountId: "b" }));
    const all = await repo.listAll();
    expect(all.map((r) => r.accountId).sort()).toEqual(["a", "b"]);
  });

  it("clearActive removes only the current record + pointer", async () => {
    const repo = new CredentialsRepo();
    await repo.save(makeRecord({ accountId: "a" }));
    await repo.save(makeRecord({ accountId: "b" })); // last save wins as active
    await repo.clearActive();
    expect(await repo.getActive()).toBeUndefined();
    const remaining = await repo.listAll();
    // 'b' was cleared, 'a' remains.
    expect(remaining.map((r) => r.accountId)).toEqual(["a"]);
  });

  it("wipe drops everything from the store and the active pointer", async () => {
    const repo = new CredentialsRepo();
    await repo.save(makeRecord({ accountId: "a" }));
    await repo.save(makeRecord({ accountId: "b" }));
    await repo.wipe();
    expect(await repo.listAll()).toEqual([]);
    expect(localStorage.getItem("octi-web.active-account-id")).toBeNull();
  });
});
