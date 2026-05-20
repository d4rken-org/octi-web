// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { openDB } from "idb";
import { beforeEach, describe, expect, it } from "vitest";
import { CredentialsRepo, type CredentialRecord } from "./credentials-repo";
import { OCTI_WEB_CHANNEL } from "../version";

// Mirror the channel-scoped DB name from credentials-repo.ts. Tests run with
// VITE_CHANNEL unset → channel = "stable".
const DB_NAME = `octi-web-${OCTI_WEB_CHANNEL}`;

function makeRecord(overrides: Partial<CredentialRecord> = {}): CredentialRecord {
  const accountId = overrides.accountId ?? "acct-1";
  const serverAddress = overrides.serverAddress ?? {
    domain: "sync.test",
    protocol: "https" as const,
    port: 443,
  };
  return {
    connectorId: `kserver-${serverAddress.domain}-${accountId}`,
    connectorType: "kserver",
    accountId,
    devicePassword: "pwd-1",
    ownDeviceId: "dev-1",
    deviceLabel: "Firefox on Linux",
    serverAddress,
    encryptionKeyset: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("CredentialsRepo", () => {
  beforeEach(async () => {
    // fake-indexeddb persists across tests within a worker; wipeAll() closes
    // the module's open connection AND drops the DB so each test sees a clean
    // slate (and the v1→v2 upgrade test can roll back to v1).
    localStorage.clear();
    const repo = new CredentialsRepo();
    await repo.wipeAll();
  });

  it("save → getActive roundtrips all fields including Uint8Array and nested serverAddress", async () => {
    const repo = new CredentialsRepo();
    const record = makeRecord();
    await repo.save(record);
    const loaded = await repo.getActive();
    expect(loaded).toBeDefined();
    expect(loaded!.connectorId).toBe(record.connectorId);
    expect(loaded!.connectorType).toBe("kserver");
    expect(loaded!.accountId).toBe(record.accountId);
    expect(loaded!.devicePassword).toBe(record.devicePassword);
    expect(loaded!.ownDeviceId).toBe(record.ownDeviceId);
    expect(loaded!.deviceLabel).toBe(record.deviceLabel);
    expect(loaded!.createdAt).toBe(record.createdAt);
    expect(loaded!.serverAddress).toEqual(record.serverAddress);
    // save() bumps updatedAt to "now"; just assert it moved forward from the fixture.
    expect(loaded!.updatedAt).toBeGreaterThanOrEqual(record.updatedAt);
    // Compare keyset bytes by content. Structured clone in fake-indexeddb can
    // round-trip Uint8Array as a Buffer (Node) which trips Vitest's toEqual on
    // the parent record even though contents match. Compare values via Array.
    expect(Array.from(loaded!.encryptionKeyset)).toEqual(Array.from(record.encryptionKeyset));
  });

  it("getActive returns undefined when nothing has been saved", async () => {
    const repo = new CredentialsRepo();
    expect(await repo.getActive()).toBeUndefined();
  });

  it("getActive returns the record with the highest updatedAt across multiple records", async () => {
    const repo = new CredentialsRepo();
    const a = makeRecord({ accountId: "a", updatedAt: 1_000 });
    const b = makeRecord({ accountId: "b", updatedAt: 2_000 });
    // Save then read raw without going through save()'s timestamp bump, so we
    // can control updatedAt deterministically. Use a low-level idb client.
    const db = await openDB(DB_NAME, 2, {
      upgrade(db) {
        if (db.objectStoreNames.contains("credentials")) db.deleteObjectStore("credentials");
        db.createObjectStore("credentials", { keyPath: "connectorId" });
      },
    });
    await db.put("credentials", a);
    await db.put("credentials", b);
    db.close();
    const active = await repo.getActive();
    expect(active!.connectorId).toBe(b.connectorId);
  });

  it("getActive tie-breaks deterministically on connectorId when updatedAt is equal", async () => {
    const repo = new CredentialsRepo();
    // Identical updatedAt; lexicographically smaller connectorId wins.
    const a = makeRecord({ accountId: "aaa", updatedAt: 5_000 });
    const b = makeRecord({ accountId: "bbb", updatedAt: 5_000 });
    const db = await openDB(DB_NAME, 2, {
      upgrade(db) {
        if (db.objectStoreNames.contains("credentials")) db.deleteObjectStore("credentials");
        db.createObjectStore("credentials", { keyPath: "connectorId" });
      },
    });
    await db.put("credentials", a);
    await db.put("credentials", b);
    db.close();
    const active = await repo.getActive();
    expect(active!.connectorId).toBe(a.connectorId); // "kserver-sync.test-aaa" < "...-bbb"
  });

  it("listAll returns every stored record", async () => {
    const repo = new CredentialsRepo();
    await repo.save(makeRecord({ accountId: "a" }));
    await repo.save(makeRecord({ accountId: "b" }));
    const all = await repo.listAll();
    expect(all.map((r) => r.accountId).sort()).toEqual(["a", "b"]);
  });

  it("save bumps updatedAt to Date.now()", async () => {
    const repo = new CredentialsRepo();
    const before = Date.now();
    await repo.save(makeRecord({ updatedAt: 0 }));
    const loaded = await repo.getActive();
    expect(loaded!.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("replaceAllWith atomically clears existing records and installs the new one", async () => {
    const repo = new CredentialsRepo();
    await repo.save(makeRecord({ accountId: "old" }));
    await repo.save(makeRecord({ accountId: "older" }));
    expect(await repo.listAll()).toHaveLength(2);
    await repo.replaceAllWith(makeRecord({ accountId: "new" }));
    const all = await repo.listAll();
    expect(all).toHaveLength(1);
    expect(all[0].accountId).toBe("new");
  });

  it("wipe drops everything from the store", async () => {
    const repo = new CredentialsRepo();
    await repo.save(makeRecord({ accountId: "a" }));
    await repo.save(makeRecord({ accountId: "b" }));
    await repo.wipe();
    expect(await repo.listAll()).toEqual([]);
  });

  it("v1 → v2 upgrade drops the legacy store and recreates with the new keyPath", async () => {
    // Seed a v1 DB with the old keyPath: "accountId".
    const v1 = await openDB(DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore("credentials", { keyPath: "accountId" });
      },
    });
    await v1.put("credentials", {
      accountId: "legacy",
      devicePassword: "p",
      ownDeviceId: "d",
      deviceLabel: "L",
      serverAddress: { domain: "sync.test", protocol: "https", port: 443 },
      encryptionKeyset: new Uint8Array([1]),
      createdAt: 1,
    });
    v1.close();

    // Open via the repo — triggers upgrade(2).
    const repo = new CredentialsRepo();
    // listAll should return nothing because the store was dropped and recreated.
    expect(await repo.listAll()).toEqual([]);

    // Verify the new keyPath is in effect: a v2-shaped record must save by `connectorId`.
    const fresh = makeRecord({ accountId: "fresh" });
    await repo.save(fresh);
    const all = await repo.listAll();
    expect(all).toHaveLength(1);
    expect(all[0].connectorId).toBe(fresh.connectorId);
  });
});
