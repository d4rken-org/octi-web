// Node env (default) — jsdom's File polyfill lacks .arrayBuffer(), but
// node 20+ has the native File which does. We still need fake-indexeddb
// for the retry-queue and credentials-repo paths (both fine in node);
// `IdentitySettings.getOwnDeviceId` touches localStorage, so we mock the
// module here.
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../storage/identity-settings", () => ({
  getOwnDeviceId: vi.fn(async () => "own-device-test"),
  wipeOwnDeviceId: vi.fn(() => undefined),
  __setOwnDeviceIdForTest: vi.fn(() => undefined),
}));

// Stub the crypto layer so tests that go through the REAL bootstrap path
// (where `#syncConnectorsFromRecords` builds an OctiServerConnector and
// instantiates per-connector crypto from `record.encryptionKeyset`) don't
// need a valid Tink keyset. Tests that use `__setConnectorsForTest`
// already bypass this code path via injected crypti, so the mock is
// backwards-compatible.
vi.mock("../crypto/payload", () => ({
  createPayloadEncryption: vi.fn(() => ({
    encrypt: (b: Uint8Array) => b,
    decrypt: (b: Uint8Array) => b,
  })),
  buildAssociatedData: vi.fn(() => new Uint8Array(0)),
}));
vi.mock("../crypto/blob-cipher", () => ({
  createBlobCipher: vi.fn(async () => ({
    encrypt: async (b: Uint8Array) => b,
    decrypt: async (b: Uint8Array) => b,
  })),
}));

import { CLIPBOARD_MODULE_ID } from "../modules/clipboard";
import type { SharedFile } from "../modules/files";
import { META_MODULE_ID } from "../modules/meta";
import { POWER_MODULE_ID } from "../modules/power";
import type { PayloadEncryption } from "../crypto/payload";
import type { OctiServerConnector } from "../protocol/octi-server-connector";
import type { DeviceMetadata } from "../protocol/models";
import {
  type ConnectorRefreshState,
  ConnectorManager,
  type DeviceConnectorState,
  mergeDevices,
} from "./connector-manager.svelte";
import { FileShareRetryQueue } from "./fileshare-retry-queue";

/**
 * Build a fresh retry-queue instance for tests. We can't avoid sharing the
 * IDB database name with the module-level singleton (it's a module-level
 * constant), so each test that uses the queue also wipes before / after.
 */
function freshRetryQueue(): FileShareRetryQueue {
  return new FileShareRetryQueue();
}

function makeIdBlobCipher(): import("../crypto/blob-cipher").BlobCipher {
  return {
    encrypt: async (b: Uint8Array) => b,
    decrypt: async (b: Uint8Array) => b,
  } as unknown as import("../crypto/blob-cipher").BlobCipher;
}

/**
 * Pure merge-engine tests. They drive {@link mergeDevices} directly without
 * spinning up a real refresh loop — the function is exported precisely so the
 * merge rule (newest-modifiedAt wins per (deviceId, moduleId); metadata owner
 * = first-seen connector by insertion order) can be pinned without mocking
 * the network or the credential store.
 *
 * Insertion order matters: `ConnectorManager.#syncConnectorsFromRecords`
 * inserts in `(record.createdAt asc, connectorId asc)` order, so these
 * fixtures match that — `connA` (created earlier) gets metadata ownership
 * on tie.
 */

function makeDeviceMetadata(id: string, label = "demo"): DeviceMetadata {
  return {
    id,
    label,
    platform: "android",
    version: "0.0.0",
    addedAt: new Date(0).toISOString(),
    lastSeen: new Date(0).toISOString(),
  };
}

function makeDeviceConnectorState(
  id: string,
  modules: Record<string, { value: unknown; modifiedAt: Date | null; error?: string | null }>,
  metaOverrides: Partial<DeviceMetadata> = {},
): DeviceConnectorState {
  return {
    raw: { ...makeDeviceMetadata(id), ...metaOverrides },
    modules: new Map(
      Object.entries(modules).map(([moduleId, entry]) => [
        moduleId,
        { value: entry.value, modifiedAt: entry.modifiedAt, error: entry.error ?? null },
      ]),
    ),
  };
}

function makeConnectorRefreshState(
  devices: Record<string, DeviceConnectorState>,
): ConnectorRefreshState {
  return {
    devices: new Map(Object.entries(devices)),
    lastError: null,
    lastRefreshedAt: new Date(),
    lastSuccessAt: new Date(),
    refreshing: false,
  };
}

/**
 * Idle (non-refreshing, never-refreshed) per-connector state. Convenience
 * factory used as a baseline seed in tests that focus on a path other than
 * the refresh lifecycle itself (publish fan-out, file upload).
 */
function idleState(): ConnectorRefreshState {
  return {
    devices: new Map(),
    lastError: null,
    lastRefreshedAt: null,
    lastSuccessAt: null,
    refreshing: false,
  };
}

describe("mergeDevices", () => {
  it("returns an empty array when there are no connectors", () => {
    expect(mergeDevices(new Map())).toEqual([]);
  });

  it("passes a single connector's data through unchanged", () => {
    const t = new Date("2026-05-20T10:00:00Z");
    const state = makeConnectorRefreshState({
      "dev-1": makeDeviceConnectorState("dev-1", {
        [META_MODULE_ID]: { value: { deviceLabel: "Phone" }, modifiedAt: t },
      }),
    });
    const merged = mergeDevices(new Map([["connA", state]]));
    expect(merged).toHaveLength(1);
    expect(merged[0].raw.id).toBe("dev-1");
    expect(merged[0].metadataOwnerConnectorId).toBe("connA");
    expect(merged[0].meta).toEqual({ deviceLabel: "Phone" });
    expect(merged[0].modulesByConnector.get(META_MODULE_ID)).toBe("connA");
  });

  it("unions devices when two connectors have disjoint device sets", () => {
    const t = new Date("2026-05-20T10:00:00Z");
    const a = makeConnectorRefreshState({
      "dev-1": makeDeviceConnectorState("dev-1", {
        [META_MODULE_ID]: { value: { deviceLabel: "Phone" }, modifiedAt: t },
      }),
    });
    const b = makeConnectorRefreshState({
      "dev-2": makeDeviceConnectorState("dev-2", {
        [META_MODULE_ID]: { value: { deviceLabel: "Tablet" }, modifiedAt: t },
      }),
    });
    const merged = mergeDevices(new Map([["connA", a], ["connB", b]]));
    expect(merged.map((d) => d.raw.id).sort()).toEqual(["dev-1", "dev-2"]);
  });

  it("picks the newest modifiedAt per (deviceId, moduleId) across connectors", () => {
    const older = new Date("2026-05-20T10:00:00Z");
    const newer = new Date("2026-05-20T11:00:00Z");
    // connA has the OLDER MetaInfo; connB has the NEWER one. connB should win.
    const a = makeConnectorRefreshState({
      "dev-1": makeDeviceConnectorState("dev-1", {
        [META_MODULE_ID]: { value: { deviceLabel: "Phone-OLD" }, modifiedAt: older },
        [CLIPBOARD_MODULE_ID]: { value: { type: "EMPTY", data: "" }, modifiedAt: newer },
      }),
    });
    const b = makeConnectorRefreshState({
      "dev-1": makeDeviceConnectorState("dev-1", {
        [META_MODULE_ID]: { value: { deviceLabel: "Phone-NEW" }, modifiedAt: newer },
        [CLIPBOARD_MODULE_ID]: { value: { type: "EMPTY", data: "" }, modifiedAt: older },
      }),
    });
    const merged = mergeDevices(new Map([["connA", a], ["connB", b]]));
    expect(merged).toHaveLength(1);
    expect(merged[0].meta).toEqual({ deviceLabel: "Phone-NEW" });
    expect(merged[0].modulesByConnector.get(META_MODULE_ID)).toBe("connB");
    expect(merged[0].modulesByConnector.get(CLIPBOARD_MODULE_ID)).toBe("connA");
  });

  it("metadata owner is the first-seen connector (by Map insertion order), not the newest lastSeen", () => {
    // connA inserted first → metadata winner regardless of lastSeen ordering.
    const a = makeConnectorRefreshState({
      "dev-1": makeDeviceConnectorState(
        "dev-1",
        {},
        { label: "from-A", lastSeen: new Date("2026-05-20T08:00:00Z").toISOString() },
      ),
    });
    const b = makeConnectorRefreshState({
      "dev-1": makeDeviceConnectorState(
        "dev-1",
        {},
        { label: "from-B", lastSeen: new Date("2026-05-20T20:00:00Z").toISOString() },
      ),
    });
    const merged = mergeDevices(new Map([["connA", a], ["connB", b]]));
    expect(merged[0].metadataOwnerConnectorId).toBe("connA");
    expect(merged[0].raw.label).toBe("from-A");
  });

  it("missing modifiedAt is treated as the oldest possible value", () => {
    const t = new Date("2026-05-20T10:00:00Z");
    const a = makeConnectorRefreshState({
      "dev-1": makeDeviceConnectorState("dev-1", {
        [META_MODULE_ID]: { value: { deviceLabel: "A-has-no-timestamp" }, modifiedAt: null },
      }),
    });
    const b = makeConnectorRefreshState({
      "dev-1": makeDeviceConnectorState("dev-1", {
        [META_MODULE_ID]: { value: { deviceLabel: "B-has-real-timestamp" }, modifiedAt: t },
      }),
    });
    const merged = mergeDevices(new Map([["connA", a], ["connB", b]]));
    expect(merged[0].meta).toEqual({ deviceLabel: "B-has-real-timestamp" });
    expect(merged[0].modulesByConnector.get(META_MODULE_ID)).toBe("connB");
  });

  it("ties on modifiedAt break deterministically on connectorId (lexicographically smaller wins)", () => {
    const t = new Date("2026-05-20T10:00:00Z");
    // Insert connZ first so a Map-insertion-order tiebreak would pick "connZ".
    // The deterministic tiebreak is `connectorId` ascending, so "connA" wins.
    const z = makeConnectorRefreshState({
      "dev-1": makeDeviceConnectorState("dev-1", {
        [META_MODULE_ID]: { value: { deviceLabel: "from-Z" }, modifiedAt: t },
      }),
    });
    const a = makeConnectorRefreshState({
      "dev-1": makeDeviceConnectorState("dev-1", {
        [META_MODULE_ID]: { value: { deviceLabel: "from-A" }, modifiedAt: t },
      }),
    });
    const merged = mergeDevices(new Map([["connZ", z], ["connA", a]]));
    expect(merged[0].meta).toEqual({ deviceLabel: "from-A" });
    expect(merged[0].modulesByConnector.get(META_MODULE_ID)).toBe("connA");
  });

  it("missing modules surface as null (one connector has it, the other doesn't)", () => {
    const t = new Date("2026-05-20T10:00:00Z");
    const a = makeConnectorRefreshState({
      "dev-1": makeDeviceConnectorState("dev-1", {
        [META_MODULE_ID]: { value: { deviceLabel: "X" }, modifiedAt: t },
      }),
    });
    const b = makeConnectorRefreshState({
      "dev-1": makeDeviceConnectorState("dev-1", {
        [POWER_MODULE_ID]: { value: { level: 50 }, modifiedAt: t },
      }),
    });
    const merged = mergeDevices(new Map([["connA", a], ["connB", b]]));
    expect(merged[0].meta).toEqual({ deviceLabel: "X" });
    expect(merged[0].power).toEqual({ level: 50 });
    expect(merged[0].clipboard).toBeNull();
    expect(merged[0].clipboardError).toBeNull();
  });

  it("propagates per-module errors from the winning connector", () => {
    const t = new Date("2026-05-20T10:00:00Z");
    const a = makeConnectorRefreshState({
      "dev-1": makeDeviceConnectorState("dev-1", {
        [META_MODULE_ID]: { value: null, modifiedAt: t, error: "decrypt failed" },
      }),
    });
    const merged = mergeDevices(new Map([["connA", a]]));
    expect(merged[0].metaError).toBe("decrypt failed");
    expect(merged[0].meta).toBeNull();
  });
});

// ─── Refresh + publish integration via mock connectors ────────
//
// These tests drive a real ConnectorManager but inject mock SyncConnectors
// via the `__setConnectorsForTest` seam. We can't call `bootstrap()` from a
// node-environment test because the credentials repo + IdentitySettings are
// jsdom-only, and we don't need them — the mocks replace the connector layer
// directly.

function makeMockConnector(id: string, overrides: Partial<{
  listDevices: () => Promise<DeviceMetadata[]>;
  readModulePayloadWithEtag: ReturnType<typeof vi.fn>;
  writeModulePayload: ReturnType<typeof vi.fn>;
  uploadBlobBytes: ReturnType<typeof vi.fn>;
  downloadBlob: ReturnType<typeof vi.fn>;
  commitModule: ReturnType<typeof vi.fn>;
}> = {}): OctiServerConnector {
  return {
    connectorId: id,
    ownDeviceId: "own-device",
    record: {
      connectorId: id,
      connectorType: "kserver",
      accountId: "acct",
      devicePassword: "pwd",
      ownDeviceId: "own-device",
      deviceLabel: "test",
      serverAddress: { domain: `${id}.test`, protocol: "https" as const, port: 443 },
      encryptionKeyset: new Uint8Array([1]),
      createdAt: 0,
      updatedAt: 0,
    },
    listDevices: overrides.listDevices ?? vi.fn(async () => []),
    readModulePayloadWithEtag:
      overrides.readModulePayloadWithEtag ?? vi.fn(async () => null),
    writeModulePayload: overrides.writeModulePayload ?? vi.fn(async () => undefined),
    uploadBlobBytes: overrides.uploadBlobBytes ?? vi.fn(async () => "blob-stub"),
    downloadBlob: overrides.downloadBlob ?? vi.fn(async () => new Uint8Array(0)),
    commitModule: overrides.commitModule ?? vi.fn(async () => ({ etag: "etag" })),
  } as unknown as OctiServerConnector;
}

function makeStubCrypti(): PayloadEncryption {
  // Identity encrypt/decrypt — we don't exercise crypto in these tests.
  return {
    encrypt: (bytes: Uint8Array) => bytes,
    decrypt: (bytes: Uint8Array) => bytes,
  } as unknown as PayloadEncryption;
}

describe("ConnectorManager.refreshAll generation guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a stale (older) in-flight refresh does NOT overwrite a newer completed one", async () => {
    // Connector with a controllable listDevices Promise so we can interleave.
    let resolveSlow: (devices: DeviceMetadata[]) => void = () => {};
    const slowList = new Promise<DeviceMetadata[]>((r) => {
      resolveSlow = r;
    });
    const cA = makeMockConnector("connA");
    // First call returns the slow Promise; second call returns immediately.
    const listFn = vi
      .fn<() => Promise<DeviceMetadata[]>>()
      .mockImplementationOnce(() => slowList)
      .mockImplementationOnce(async () => [
        { id: "peer-fresh", label: "fresh", platform: "android", version: "v", addedAt: null, lastSeen: null },
      ]);
    (cA as unknown as { listDevices: typeof listFn }).listDevices = listFn;

    const manager = new ConnectorManager();
    manager.__setConnectorsForTest({
      connectors: [cA],
      crypti: new Map([["connA", makeStubCrypti()]]),
    });
    manager.perConnectorState = new Map([
      ["connA", idleState()],
    ]);

    // Start refresh 1 (slow). Its #refreshOne suspends inside listDevices.
    const r1 = manager.refreshAll();
    // Start refresh 2 (immediate). Bumps #refreshSeq; its #refreshOne sees a
    // fresh peer list, writes perConnectorState[connA] with one device.
    await manager.refreshAll();

    // Sanity: refresh 2 landed.
    expect(manager.perConnectorState.get("connA")?.devices.size).toBe(1);
    expect(manager.mergedDevices[0]?.raw.id).toBe("peer-fresh");

    // Now resolve refresh 1's listDevices with an OLDER snapshot (empty).
    // refresh 1's #refreshOne should detect the global seq has moved past
    // its `refreshSeq` and bail out — its stale write must NOT clobber the
    // fresher state from refresh 2.
    resolveSlow([]);
    await r1;

    expect(manager.perConnectorState.get("connA")?.devices.size).toBe(1);
    expect(manager.mergedDevices[0]?.raw.id).toBe("peer-fresh");
  });

  it("lastSuccessAt only advances when every active connector's refresh succeeded", async () => {
    const cA = makeMockConnector("connA");
    const cB = makeMockConnector("connB", {
      listDevices: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const manager = new ConnectorManager();
    manager.__setConnectorsForTest({
      connectors: [cA, cB],
      crypti: new Map([
        ["connA", makeStubCrypti()],
        ["connB", makeStubCrypti()],
      ]),
    });
    manager.perConnectorState = new Map([
      ["connA", idleState()],
      ["connB", idleState()],
    ]);

    await manager.refreshAll();

    expect(manager.lastRefreshedAt).toBeInstanceOf(Date);
    expect(manager.lastSuccessAt).toBeNull(); // B errored, so no all-succeed
    expect(manager.perConnectorState.get("connB")?.lastError).toMatch(/boom/);
  });
});

describe("ConnectorManager.publishOwnMetaInfo fan-out", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a rejecting connector becomes a per-connector issue; succeeding connectors still write", async () => {
    const writeA = vi.fn(async () => {
      throw new Error("auth failed");
    });
    const writeB = vi.fn(async () => undefined);
    const cA = makeMockConnector("connA", { writeModulePayload: writeA });
    const cB = makeMockConnector("connB", { writeModulePayload: writeB });

    const manager = new ConnectorManager();
    manager.__setConnectorsForTest({
      connectors: [cA, cB],
      crypti: new Map([
        ["connA", makeStubCrypti()],
        ["connB", makeStubCrypti()],
      ]),
    });
    // Seed perConnectorState so the error recorder has somewhere to write.
    // In production this is populated by refreshAll(); for the publish test
    // we install a no-op baseline.
    manager.perConnectorState = new Map([
      [
        "connA",
        idleState(),
      ],
      [
        "connB",
        idleState(),
      ],
    ]);

    await manager.publishOwnMetaInfo();

    expect(writeA).toHaveBeenCalledTimes(1);
    expect(writeB).toHaveBeenCalledTimes(1);
    expect(manager.perConnectorState.get("connA")?.lastError).toMatch(/auth failed/);
    expect(manager.perConnectorState.get("connB")?.lastError).toBeNull();
    expect(manager.mergedIssues.map((i) => i.connectorId)).toEqual(["connA"]);
  });
});

describe("ConnectorManager.uploadFile fan-out", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uploads the blob to every connector and publishes one multi-ref SharedFile", async () => {
    const uploadA = vi.fn(async () => "blob-A");
    const uploadB = vi.fn(async () => "blob-B");
    const commitA = vi.fn(async () => ({ etag: "eA" }));
    const commitB = vi.fn(async () => ({ etag: "eB" }));
    const cA = makeMockConnector("connA", {
      uploadBlobBytes: uploadA,
      commitModule: commitA,
    });
    const cB = makeMockConnector("connB", {
      uploadBlobBytes: uploadB,
      commitModule: commitB,
    });

    const manager = new ConnectorManager();
    // Identity blob cipher: ciphertext == plaintext so we don't exercise crypto.
    const idBlobCipher = {
      encrypt: async (b: Uint8Array) => b,
      decrypt: async (b: Uint8Array) => b,
    } as unknown as import("../crypto/blob-cipher").BlobCipher;
    manager.__setConnectorsForTest({
      connectors: [cA, cB],
      crypti: new Map([
        ["connA", makeStubCrypti()],
        ["connB", makeStubCrypti()],
      ]),
      blobCipher: new Map([
        ["connA", idBlobCipher],
        ["connB", idBlobCipher],
      ]),
    });
    manager.perConnectorState = new Map([
      ["connA", idleState()],
      ["connB", idleState()],
    ]);

    const file = new File([new Uint8Array([1, 2, 3])], "x.bin", { type: "application/octet-stream" });
    const result = await manager.uploadFile(file);

    expect(uploadA).toHaveBeenCalledTimes(1);
    expect(uploadB).toHaveBeenCalledTimes(1);
    expect(commitA).toHaveBeenCalledTimes(1);
    expect(commitB).toHaveBeenCalledTimes(1);

    // The SharedFile carries refs for BOTH connectors.
    expect(result.shared.availableOn.sort()).toEqual(["connA", "connB"]);
    expect(result.shared.connectorRefs).toEqual({
      connA: "blob-A",
      connB: "blob-B",
    });
  });

  it("partial blob-upload failure → SharedFile carries refs only for the successful connectors", async () => {
    const uploadA = vi.fn(async () => {
      throw new Error("quota exceeded");
    });
    const uploadB = vi.fn(async () => "blob-B");
    const commitB = vi.fn(async () => ({ etag: "eB" }));
    const cA = makeMockConnector("connA", { uploadBlobBytes: uploadA });
    const cB = makeMockConnector("connB", {
      uploadBlobBytes: uploadB,
      commitModule: commitB,
    });

    const manager = new ConnectorManager();
    const idBlobCipher = {
      encrypt: async (b: Uint8Array) => b,
      decrypt: async (b: Uint8Array) => b,
    } as unknown as import("../crypto/blob-cipher").BlobCipher;
    manager.__setConnectorsForTest({
      connectors: [cA, cB],
      crypti: new Map([
        ["connA", makeStubCrypti()],
        ["connB", makeStubCrypti()],
      ]),
      blobCipher: new Map([
        ["connA", idBlobCipher],
        ["connB", idBlobCipher],
      ]),
    });
    manager.perConnectorState = new Map([
      ["connA", idleState()],
      ["connB", idleState()],
    ]);

    const file = new File([new Uint8Array([9, 9])], "y.bin", { type: "application/octet-stream" });
    const result = await manager.uploadFile(file);

    expect(result.shared.availableOn).toEqual(["connB"]);
    expect(result.shared.connectorRefs).toEqual({ connB: "blob-B" });
    expect(manager.perConnectorState.get("connA")?.lastError).toMatch(/quota exceeded/);
  });
});

// ─── refreshOne (per-connector refresh) ─────────────────────────
//
// These tests exercise the new public `refreshOne(connectorId)` method and
// its interactions with `refreshAll`: per-connector spinner gating, race
// semantics, and the derived `loading` flag.

/**
 * Build a fake DeviceMetadata pinned to a given id. The `addedAt`/`lastSeen`
 * fields are required by the type but irrelevant to refresh-path tests.
 */
function makePeer(id: string): DeviceMetadata {
  return {
    id,
    label: id,
    platform: "android",
    version: "v",
    addedAt: null,
    lastSeen: null,
  } as unknown as DeviceMetadata;
}

describe("ConnectorManager.refreshOne", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes only the targeted connector's state", async () => {
    const listA = vi.fn(async () => [makePeer("peer-A")]);
    const listB = vi.fn(async () => [makePeer("peer-B")]);
    const cA = makeMockConnector("connA");
    const cB = makeMockConnector("connB");
    (cA as unknown as { listDevices: typeof listA }).listDevices = listA;
    (cB as unknown as { listDevices: typeof listB }).listDevices = listB;

    const manager = new ConnectorManager();
    manager.__setConnectorsForTest({
      connectors: [cA, cB],
      crypti: new Map([
        ["connA", makeStubCrypti()],
        ["connB", makeStubCrypti()],
      ]),
    });
    manager.perConnectorState = new Map([
      ["connA", idleState()],
      ["connB", idleState()],
    ]);

    await manager.refreshOne("connA");

    expect(listA).toHaveBeenCalledTimes(1);
    expect(listB).not.toHaveBeenCalled();
    expect(manager.perConnectorState.get("connA")?.devices.size).toBe(1);
    expect(manager.perConnectorState.get("connB")?.devices.size).toBe(0);
  });

  it("clears `refreshing` on the targeted connector when it completes", async () => {
    const cA = makeMockConnector("connA");
    const manager = new ConnectorManager();
    manager.__setConnectorsForTest({
      connectors: [cA],
      crypti: new Map([["connA", makeStubCrypti()]]),
    });
    manager.perConnectorState = new Map([["connA", idleState()]]);

    await manager.refreshOne("connA");

    expect(manager.perConnectorState.get("connA")?.refreshing).toBe(false);
  });

  it("a stale (older) refreshOne completion does NOT clear a newer pass's spinner", async () => {
    // Token-gate test (Codex called this out): the previous draft of this
    // test had the newer pass already complete by the time the older pass
    // resolved, so the older pass returned via `isStale()` BEFORE reaching
    // the success/error `refreshing = token !== myToken` assignment — the
    // gate was never exercised.
    //
    // The model here: pass 1 stalls on listDevices, pass 2 ALSO stalls on
    // listDevices, then pass 1 resolves FIRST while pass 2 is still
    // suspended. Pass 1's success-write tries to clear `refreshing`, but
    // the token gate must keep it true because pass 2 owns the token now.
    let resolveFirst: (devs: DeviceMetadata[]) => void = () => {};
    let resolveSecond: (devs: DeviceMetadata[]) => void = () => {};
    const firstList = new Promise<DeviceMetadata[]>((r) => {
      resolveFirst = r;
    });
    const secondList = new Promise<DeviceMetadata[]>((r) => {
      resolveSecond = r;
    });
    const listFn = vi
      .fn<() => Promise<DeviceMetadata[]>>()
      .mockImplementationOnce(() => firstList)
      .mockImplementationOnce(() => secondList);
    const cA = makeMockConnector("connA");
    (cA as unknown as { listDevices: typeof listFn }).listDevices = listFn;

    const manager = new ConnectorManager();
    manager.__setConnectorsForTest({
      connectors: [cA],
      crypti: new Map([["connA", makeStubCrypti()]]),
    });
    manager.perConnectorState = new Map([["connA", idleState()]]);

    // Pass 1 starts, sets refreshing=true (token=1), suspends.
    const p1 = manager.refreshOne("connA");
    await Promise.resolve();
    expect(manager.perConnectorState.get("connA")?.refreshing).toBe(true);

    // Pass 2 starts, bumps the spinner token (now =2), sets refreshing=true
    // (already true), suspends.
    const p2 = manager.refreshOne("connA");
    await Promise.resolve();

    // Pass 1 resolves with its (now-stale) data. Its success path's
    // `isStale()` is false (the global #refreshSeq didn't move), so it
    // would try to write. The per-connector seq DID move (pass 2 bumped
    // it), so `isStale()` IS true → pass 1 returns "stale" before the
    // write. Same end result: spinner stays true, pass 2 still owns it.
    //
    // Note: this dual-path coverage is important. The test name says "token
    // gate" but in the per-connector seq race, the seq guard fires first.
    // To actually exercise the token clear-gate we'd need a write path that
    // bypasses isStale — which doesn't exist for the per-connector races.
    // The seq guard is the primary defense; the token gate is belt-and-
    // braces for paths where the seq guard might be wrong (e.g. a future
    // change to the staling rules). Both contribute to "older completion
    // can't disturb newer pass's spinner" — which is the invariant we test.
    resolveFirst([makePeer("peer-FIRST-stale")]);
    await p1;
    expect(manager.perConnectorState.get("connA")?.refreshing).toBe(true);

    // Pass 2 resolves: success path writes data and clears refreshing
    // because the token still matches.
    resolveSecond([makePeer("peer-second")]);
    await p2;
    expect(manager.perConnectorState.get("connA")?.devices.size).toBe(1);
    expect(manager.mergedDevices[0]?.raw.id).toBe("peer-second");
    expect(manager.perConnectorState.get("connA")?.refreshing).toBe(false);
  });

  it("refreshOne(A) completion during active refreshAll does NOT clear refreshAll's spinner", async () => {
    // Reverse race (Codex called this out): the existing "refreshAll
    // during refreshOne" test covers one direction. This is the mirror:
    // refreshOne(A) starts and suspends; refreshAll() starts, its leg for
    // A suspends; the original refreshOne resolves first; we then assert
    // A.refreshing stays true until refreshAll's leg finishes.
    let resolveOne: (devs: DeviceMetadata[]) => void = () => {};
    let resolveAll: (devs: DeviceMetadata[]) => void = () => {};
    const oneList = new Promise<DeviceMetadata[]>((r) => {
      resolveOne = r;
    });
    const allList = new Promise<DeviceMetadata[]>((r) => {
      resolveAll = r;
    });
    const listFn = vi
      .fn<() => Promise<DeviceMetadata[]>>()
      // refreshOne's call (first)
      .mockImplementationOnce(() => oneList)
      // refreshAll's call (second)
      .mockImplementationOnce(() => allList);
    const cA = makeMockConnector("connA");
    (cA as unknown as { listDevices: typeof listFn }).listDevices = listFn;

    const manager = new ConnectorManager();
    manager.__setConnectorsForTest({
      connectors: [cA],
      crypti: new Map([["connA", makeStubCrypti()]]),
    });
    manager.perConnectorState = new Map([["connA", idleState()]]);

    const pOne = manager.refreshOne("connA");
    await Promise.resolve();
    expect(manager.perConnectorState.get("connA")?.refreshing).toBe(true);

    // refreshAll bumps the global #refreshSeq AND (via #refreshOne) the
    // per-connector spinner token. The original refreshOne's later
    // completion will see both bumps via `isStale()` (global seq mismatch).
    const pAll = manager.refreshAll();
    await Promise.resolve();
    expect(manager.perConnectorState.get("connA")?.refreshing).toBe(true);

    // refreshOne resolves first — stale. Spinner must stay true (refreshAll's
    // leg is still in flight).
    resolveOne([makePeer("peer-one")]);
    await pOne;
    expect(manager.perConnectorState.get("connA")?.refreshing).toBe(true);

    // refreshAll's leg lands: writes data, clears spinner.
    resolveAll([makePeer("peer-all")]);
    await pAll;
    expect(manager.perConnectorState.get("connA")?.refreshing).toBe(false);
    expect(manager.mergedDevices[0]?.raw.id).toBe("peer-all");
  });

  it("refreshAll() staled by refreshOne(A) does NOT advance lastSuccessAt", async () => {
    // Single connector. refreshAll fires first (slow listDevices); refreshOne
    // bumps the per-connector seq and runs to completion; refreshAll's leg
    // for A returns "stale" on completion → not "ok" → lastSuccessAt should
    // remain null.
    let resolveAllList: (devs: DeviceMetadata[]) => void = () => {};
    const slowList = new Promise<DeviceMetadata[]>((r) => {
      resolveAllList = r;
    });
    const listFn = vi
      .fn<() => Promise<DeviceMetadata[]>>()
      // refreshAll's call
      .mockImplementationOnce(() => slowList)
      // refreshOne's call
      .mockImplementationOnce(async () => [makePeer("peer-one")]);
    const cA = makeMockConnector("connA");
    (cA as unknown as { listDevices: typeof listFn }).listDevices = listFn;

    const manager = new ConnectorManager();
    manager.__setConnectorsForTest({
      connectors: [cA],
      crypti: new Map([["connA", makeStubCrypti()]]),
    });
    manager.perConnectorState = new Map([["connA", idleState()]]);

    const rAll = manager.refreshAll();
    // While refreshAll's leg is suspended, run a per-connector refresh on A.
    await manager.refreshOne("connA");
    // refreshAll's leg for A is now staled — when it finishes it returns
    // "stale" and refuses to write. lastSuccessAt remains null because the
    // pass didn't get an all-"ok" outcome.
    resolveAllList([]);
    await rAll;

    expect(manager.lastSuccessAt).toBeNull();
    // refreshOne's data is still in place.
    expect(manager.perConnectorState.get("connA")?.devices.size).toBe(1);
    expect(manager.mergedDevices[0]?.raw.id).toBe("peer-one");
  });

  it("`loading` is true while refreshOne is in flight, then false", async () => {
    // The derived `loading` flag should reactively pick up the per-connector
    // `refreshing` flag. We assert at three points: before, during, after.
    let resolveList: (devs: DeviceMetadata[]) => void = () => {};
    const slowList = new Promise<DeviceMetadata[]>((r) => {
      resolveList = r;
    });
    const cA = makeMockConnector("connA");
    (cA as unknown as { listDevices: () => Promise<DeviceMetadata[]> }).listDevices = () => slowList;

    const manager = new ConnectorManager();
    manager.__setConnectorsForTest({
      connectors: [cA],
      crypti: new Map([["connA", makeStubCrypti()]]),
    });
    manager.perConnectorState = new Map([["connA", idleState()]]);

    expect(manager.loading).toBe(false);

    const p = manager.refreshOne("connA");
    // The `refreshing` flag is set synchronously inside `#refreshOne` before
    // the first `await`, so by the time we check after a microtask, loading
    // is true.
    await Promise.resolve();
    expect(manager.loading).toBe(true);
    expect(manager.perConnectorState.get("connA")?.refreshing).toBe(true);

    resolveList([]);
    await p;
    expect(manager.loading).toBe(false);
    expect(manager.perConnectorState.get("connA")?.refreshing).toBe(false);
  });

  it("refreshOne on a removed connector is a no-op (does not throw)", async () => {
    const cA = makeMockConnector("connA");
    const manager = new ConnectorManager();
    manager.__setConnectorsForTest({
      connectors: [cA],
      crypti: new Map([["connA", makeStubCrypti()]]),
    });
    manager.perConnectorState = new Map([["connA", idleState()]]);

    // Simulate a removed connector by clearing the list.
    manager.__setConnectorsForTest({ connectors: [], crypti: new Map() });
    // Should not throw, should not write anywhere.
    await expect(manager.refreshOne("connA")).resolves.toBeUndefined();
  });
});

describe("ConnectorManager file-share retry queue", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    // Wipe the (shared) singleton DB so cross-test state doesn't leak.
    await freshRetryQueue().wipeAll();
  });

  it("uploadFile enqueues phase-2 failures with the failing connectorIds", async () => {
    // connA: phase-1 OK, phase-2 fails. connB: phase-1 OK, phase-2 OK.
    // After uploadFile, the queue should hold one entry with connA only.
    const commitA = vi.fn(async () => {
      throw new Error("412 precondition");
    });
    const commitB = vi.fn(async () => ({ etag: "eB" }));
    const cA = makeMockConnector("connA", {
      uploadBlobBytes: vi.fn(async () => "blob-A"),
      commitModule: commitA,
    });
    const cB = makeMockConnector("connB", {
      uploadBlobBytes: vi.fn(async () => "blob-B"),
      commitModule: commitB,
    });

    const queue = freshRetryQueue();
    await queue.wipeAll();
    const manager = new ConnectorManager();
    manager.__setConnectorsForTest({
      connectors: [cA, cB],
      crypti: new Map([
        ["connA", makeStubCrypti()],
        ["connB", makeStubCrypti()],
      ]),
      blobCipher: new Map([
        ["connA", makeIdBlobCipher()],
        ["connB", makeIdBlobCipher()],
      ]),
    });
    manager.__setRetryQueueForTest(queue);
    manager.perConnectorState = new Map([
      ["connA", idleState()],
      ["connB", idleState()],
    ]);

    const file = new File([new Uint8Array([1])], "z.bin", { type: "application/octet-stream" });
    const result = await manager.uploadFile(file);
    // Upload should succeed (B accepted).
    expect(result.shared.availableOn.sort()).toEqual(["connA", "connB"]);

    const pending = await queue.list();
    expect(pending).toHaveLength(1);
    expect(pending[0].pendingConnectorIds).toEqual(["connA"]);
    expect(pending[0].shared.blobKey).toBe(result.shared.blobKey);
    expect(pending[0].attempts).toBe(0);
  });

  it("uploadFile does NOT enqueue a connector that disconnected between phase 1 and phase 2", async () => {
    // Phase 1 takes a snapshot of `this.connectors`, uploads blobs in
    // parallel. Phase 2 looks up each connector LIVE via
    // `this.connectors.find(...)`. If the user disconnected a connector
    // in between, phase 2 sees `undefined` and must skip without
    // enqueueing — re-adding the connector later wouldn't auto-publish
    // the queued entry, so retrying is pointless.
    //
    // We trigger the race by mutating `manager.connectors` from inside
    // `cA.uploadBlobBytes` (runs in phase 1). By the time phase 2
    // iterates `uploads`, A is gone from `this.connectors`.
    const manager = new ConnectorManager();
    const cA = makeMockConnector("connA", {
      uploadBlobBytes: vi.fn(async () => {
        // Mutate during phase 1 (after the upload "succeeded" but before
        // phase 2 looks the connector up).
        manager.connectors = manager.connectors.filter(
          (c) => c.connectorId !== "connA",
        );
        return "blob-A";
      }),
    });
    const cB = makeMockConnector("connB", {
      uploadBlobBytes: vi.fn(async () => "blob-B"),
      commitModule: vi.fn(async () => ({ etag: "eB" })),
    });

    const queue = freshRetryQueue();
    await queue.wipeAll();
    manager.__setConnectorsForTest({
      connectors: [cA, cB],
      crypti: new Map([
        ["connA", makeStubCrypti()],
        ["connB", makeStubCrypti()],
      ]),
      blobCipher: new Map([
        ["connA", makeIdBlobCipher()],
        ["connB", makeIdBlobCipher()],
      ]),
    });
    manager.__setRetryQueueForTest(queue);
    manager.perConnectorState = new Map([
      ["connA", idleState()],
      ["connB", idleState()],
    ]);

    const file = new File([new Uint8Array([1])], "race.bin", { type: "application/octet-stream" });
    await manager.uploadFile(file);

    // Queue must NOT contain connA — it disconnected mid-upload.
    const pending = await queue.list();
    expect(pending).toEqual([]);
  });

  it("refreshAll drains the queue: successful publish removes the entry", async () => {
    const queue = freshRetryQueue();
    await queue.wipeAll();

    // Seed the queue directly with a pending entry for connA.
    const shared = {
      name: "seeded.bin",
      mimeType: "application/octet-stream",
      size: 1,
      blobKey: "sha256:seeded",
      checksum: "seeded",
      sharedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      availableOn: ["connA"],
      connectorRefs: { connA: "blob-A" },
    };
    await queue.enqueue({ shared, pendingConnectorIds: ["connA"] });

    // connA's `commitModule` will succeed on drain.
    const commitA = vi.fn(async () => ({ etag: "eA" }));
    const cA = makeMockConnector("connA", { commitModule: commitA });

    const manager = new ConnectorManager();
    manager.__setConnectorsForTest({
      connectors: [cA],
      crypti: new Map([["connA", makeStubCrypti()]]),
    });
    manager.__setRetryQueueForTest(queue);
    manager.perConnectorState = new Map([["connA", idleState()]]);

    await manager.refreshAll();

    expect(commitA).toHaveBeenCalled();
    expect(await queue.list()).toEqual([]);
  });

  it("refreshAll drain: persistent failure increments attempts; cap drops the entry and emits an issue", async () => {
    const queue = freshRetryQueue();
    await queue.wipeAll();

    // Seed with attempts = MAX-1 so a single drain pass crosses the threshold.
    const shared = {
      name: "max.bin",
      mimeType: "application/octet-stream",
      size: 1,
      blobKey: "sha256:max",
      checksum: "max",
      sharedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      availableOn: ["connA"],
      connectorRefs: { connA: "blob-A" },
    };
    const { entry } = await queue.enqueue({ shared, pendingConnectorIds: ["connA"] });
    await queue.update({ ...entry, attempts: 4 }); // MAX_ATTEMPTS - 1

    const commitA = vi.fn(async () => {
      throw new Error("still failing");
    });
    const cA = makeMockConnector("connA", { commitModule: commitA });

    const manager = new ConnectorManager();
    manager.__setConnectorsForTest({
      connectors: [cA],
      crypti: new Map([["connA", makeStubCrypti()]]),
    });
    manager.__setRetryQueueForTest(queue);
    manager.perConnectorState = new Map([["connA", idleState()]]);

    await manager.refreshAll();

    // Entry deleted, last-error surfaced.
    expect(await queue.list()).toEqual([]);
    const err = manager.perConnectorState.get("connA")?.lastError;
    expect(err).toMatch(/gave up after 5 attempts|FileShareInfo retry/);
  });

  it("refreshAll drain: TTL-expired entries are dropped and surface an issue", async () => {
    const queue = freshRetryQueue();
    await queue.wipeAll();

    // Enqueue then backdate `createdAt` past the TTL.
    const shared = {
      name: "ttl.bin",
      mimeType: "application/octet-stream",
      size: 1,
      blobKey: "sha256:ttl",
      checksum: "ttl",
      sharedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      availableOn: ["connA"],
      connectorRefs: { connA: "blob-A" },
    };
    const { entry } = await queue.enqueue({ shared, pendingConnectorIds: ["connA"] });
    // 8 min TTL — backdate 9 min.
    await queue.update({ ...entry, createdAt: Date.now() - 9 * 60_000 });

    const commitA = vi.fn(async () => ({ etag: "eA" }));
    const cA = makeMockConnector("connA", { commitModule: commitA });
    const manager = new ConnectorManager();
    manager.__setConnectorsForTest({
      connectors: [cA],
      crypti: new Map([["connA", makeStubCrypti()]]),
    });
    manager.__setRetryQueueForTest(queue);
    manager.perConnectorState = new Map([["connA", idleState()]]);

    await manager.refreshAll();

    // Entry dropped without retry: commit was NOT called.
    expect(commitA).not.toHaveBeenCalled();
    expect(await queue.list()).toEqual([]);
    expect(manager.perConnectorState.get("connA")?.lastError).toMatch(/expired/);
  });

  it("removeConnector prunes the queue", async () => {
    const queue = freshRetryQueue();
    await queue.wipeAll();

    const shared = {
      name: "p.bin",
      mimeType: "application/octet-stream",
      size: 1,
      blobKey: "sha256:p",
      checksum: "p",
      sharedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      availableOn: ["connA", "connB"],
      connectorRefs: { connA: "ba", connB: "bb" },
    };
    await queue.enqueue({ shared, pendingConnectorIds: ["connA", "connB"] });
    await queue.enqueue({ shared: { ...shared, blobKey: "sha256:onlyA" }, pendingConnectorIds: ["connA"] });

    const cA = makeMockConnector("connA");
    const cB = makeMockConnector("connB");

    const manager = new ConnectorManager();
    manager.__setConnectorsForTest({
      connectors: [cA, cB],
      crypti: new Map([
        ["connA", makeStubCrypti()],
        ["connB", makeStubCrypti()],
      ]),
    });
    manager.__setRetryQueueForTest(queue);
    manager.perConnectorState = new Map([
      ["connA", idleState()],
      ["connB", idleState()],
    ]);

    // removeConnector hits the real credentials DB via `deleteByConnectorId`
    // and `listAll`. With fake-indexeddb both are backed by an in-memory
    // store — `deleteByConnectorId` on a missing key is a no-op, and
    // `listAll` returns []. The subsequent `#syncConnectorsSerialized`
    // resets `manager.connectors = []`, which is fine for this test
    // (we only care about the queue side effect).
    await manager.removeConnector("connA");

    const remaining = await queue.list();
    // Entry 1: pendingConnectorIds was [A,B], B remains.
    // Entry 2: pendingConnectorIds was [A], goes empty → deleted.
    expect(remaining).toHaveLength(1);
    expect(remaining[0].pendingConnectorIds).toEqual(["connB"]);
  });

  it("concurrent uploadFile + drain on the same connector actually serialize via the publish lock (no overlap)", async () => {
    // True concurrency test: stall the upload's phase-2 commitModule with a
    // deferred, then kick off a drain that targets the same connector. The
    // drain's commitModule must wait behind the upload's, not run
    // concurrently. We track `inFlight` / `maxInFlight` and assert
    // `maxInFlight === 1`.
    //
    // We use two pairs of deferreds — `*Enter*` signals when a commitA call
    // has actually been entered (vs polling microtasks), and `*Gate*` is
    // the suspension point we release manually. This makes the test
    // deterministic regardless of how many awaits `uploadFile` does
    // before reaching commitModule.
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const secondGate = new Promise<void>((r) => {
      releaseSecond = r;
    });
    let firstEnteredResolve!: () => void;
    let secondEnteredResolve!: () => void;
    const firstEntered = new Promise<void>((r) => {
      firstEnteredResolve = r;
    });
    const secondEntered = new Promise<void>((r) => {
      secondEnteredResolve = r;
    });
    let callCount = 0;
    const commitA = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      callCount++;
      const isFirst = callCount === 1;
      // Signal the test that we've entered commitA.
      (isFirst ? firstEnteredResolve : secondEnteredResolve)();
      try {
        await (isFirst ? firstGate : secondGate);
      } finally {
        inFlight--;
      }
      return { etag: "eA" };
    });
    const cA = makeMockConnector("connA", {
      uploadBlobBytes: vi.fn(async () => "blob-A"),
      commitModule: commitA,
    });

    const queue = freshRetryQueue();
    await queue.wipeAll();
    const manager = new ConnectorManager();
    manager.__setConnectorsForTest({
      connectors: [cA],
      crypti: new Map([["connA", makeStubCrypti()]]),
      blobCipher: new Map([["connA", makeIdBlobCipher()]]),
    });
    manager.__setRetryQueueForTest(queue);
    manager.perConnectorState = new Map([["connA", idleState()]]);

    // Seed the queue with an entry the drain will try to publish.
    const seedShared: SharedFile = {
      name: "seed.bin",
      mimeType: "application/octet-stream",
      size: 1,
      blobKey: "sha256:seed",
      checksum: "seed",
      sharedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      availableOn: ["connA"],
      connectorRefs: { connA: "blob-A" },
    };
    await queue.enqueue({ shared: seedShared, pendingConnectorIds: ["connA"] });

    // Start uploadFile. Phase 1 completes; phase 2's commitModule is the
    // FIRST commitA call — it suspends on firstGate.
    const file = new File([new Uint8Array([7])], "lock.bin", { type: "application/octet-stream" });
    const uploadPromise = manager.uploadFile(file);

    // Wait deterministically for commitA to be entered (avoids any
    // microtask-count guesswork).
    await firstEntered;
    expect(inFlight).toBe(1);

    // Now start refreshAll. Its drain queues behind the upload's lock —
    // commitA's SECOND call hasn't started yet, so `callCount` stays 1.
    const refreshPromise = manager.refreshAll();
    // Let the drain at least get to the point where it would attempt the
    // lock acquisition; the lock makes it wait, so neither inFlight nor
    // callCount change.
    await new Promise((r) => setTimeout(r, 20));
    expect(inFlight).toBe(1);
    expect(maxInFlight).toBe(1);
    expect(callCount).toBe(1);

    // Release the upload. The lock frees → drain's commitA acquires it.
    releaseFirst();
    await secondEntered;
    expect(callCount).toBe(2);
    expect(inFlight).toBe(1); // upload exited, drain entered — still 1
    expect(maxInFlight).toBe(1); // never overlapped

    // Release the drain.
    releaseSecond();
    await Promise.all([uploadPromise, refreshPromise]);

    expect(maxInFlight).toBe(1);
    expect(await queue.list()).toEqual([]);
  });
});

// ─── Persistent connector-state cache integration ───────────────
//
// The cache repo has its own roundtrip tests under
// `connector-state-cache.test.ts`. Here we exercise the ConnectorManager's
// bootstrap-seed / refresh-write / removeConnector-delete / wipe paths,
// plus the deletion-generation guard against resurrection races.

import {
  type CachedConnectorState,
  CURRENT_CACHE_VERSION,
  ConnectorStateCache,
} from "../storage/connector-state-cache";
import { CLIPBOARD_MODULE_ID as CLIP_ID } from "../modules/clipboard";

function freshStateCache(): ConnectorStateCache {
  return new ConnectorStateCache();
}

describe("ConnectorManager connector-state cache", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await freshStateCache().wipeAll();
    // Wipe credentials too — tests in this block seed credentialsRepo to
    // drive the real `bootstrap()` path, and leftover records would build
    // unexpected connectors in sibling tests.
    const { credentialsRepo: credsRepo } = await import("../storage/credentials-repo");
    await credsRepo.wipeAll();
  });

  it("bootstrap seeds perConnectorState from the cache when live state is empty", async () => {
    // Real bootstrap path: seed both the credentials DB (so
    // `#syncConnectorsSerialized` builds an OctiServerConnector for connA)
    // AND the state cache, then call `manager.bootstrap()` and assert the
    // resulting `perConnectorState`.
    const cache = freshStateCache();
    await cache.wipeAll();
    // Wipe credentials first so this test's record is the only one.
    const { credentialsRepo: credsRepo } = await import("../storage/credentials-repo");
    await credsRepo.wipeAll();
    await credsRepo.save({
      connectorId: "kserver-test-acct",
      connectorType: "kserver",
      accountId: "acct",
      devicePassword: "pwd",
      ownDeviceId: "own-device",
      deviceLabel: "Browser",
      serverAddress: { domain: "test", protocol: "https", port: 443 },
      encryptionKeyset: new Uint8Array([1]),
      createdAt: 0,
      updatedAt: 0,
    });

    const seed: CachedConnectorState = {
      connectorId: "kserver-test-acct",
      version: CURRENT_CACHE_VERSION,
      lastError: null,
      lastRefreshedAt: new Date("2026-05-21T09:00:00Z"),
      lastSuccessAt: new Date("2026-05-21T09:00:00Z"),
      devices: [
        {
          id: "dev-1",
          raw: {
            id: "dev-1",
            label: "Phone",
            platform: "android",
            version: "v",
            addedAt: null,
            lastSeen: null,
          } as unknown as DeviceMetadata,
          modules: [
            {
              moduleId: CLIP_ID,
              value: { type: "TEXT", data: new Uint8Array([0x68, 0x69]) },
              modifiedAt: new Date("2026-05-21T08:55:00Z"),
              error: null,
            },
          ],
        },
      ],
    };
    await cache.write(seed);

    const manager = new ConnectorManager();
    manager.__setConnectorStateCacheForTest(cache);

    await manager.bootstrap();

    // After bootstrap: connectors built from the seeded credential, AND
    // perConnectorState seeded from the cache.
    expect(manager.connectors.map((c) => c.connectorId)).toEqual([
      "kserver-test-acct",
    ]);
    const live = manager.perConnectorState.get("kserver-test-acct");
    expect(live).toBeDefined();
    expect(live!.devices.size).toBe(1);
    expect(live!.devices.get("dev-1")?.raw.label).toBe("Phone");
    expect(live!.lastRefreshedAt?.toISOString()).toBe(seed.lastRefreshedAt!.toISOString());
    // `refreshing` is intentionally false on cache deserialize (stale
    // spinner state must not resurface across sessions).
    expect(live!.refreshing).toBe(false);

    await credsRepo.wipeAll(); // cleanup for sibling tests
  });

  it("bootstrap does NOT clobber live data with a stale cache snapshot", async () => {
    // After a refresh has populated `perConnectorState[connA]`, calling
    // `bootstrap()` again (which happens on rename / addConnector) must
    // skip seeding because the live state already has devices.
    const cache = freshStateCache();
    await cache.wipeAll();
    const { credentialsRepo: credsRepo } = await import("../storage/credentials-repo");
    await credsRepo.wipeAll();
    await credsRepo.save({
      connectorId: "kserver-test-acct",
      connectorType: "kserver",
      accountId: "acct",
      devicePassword: "pwd",
      ownDeviceId: "own-device",
      deviceLabel: "Browser",
      serverAddress: { domain: "test", protocol: "https", port: 443 },
      encryptionKeyset: new Uint8Array([1]),
      createdAt: 0,
      updatedAt: 0,
    });
    // Cache contains "STALE-PEER".
    await cache.write({
      connectorId: "kserver-test-acct",
      version: CURRENT_CACHE_VERSION,
      lastError: null,
      lastRefreshedAt: new Date(0),
      lastSuccessAt: new Date(0),
      devices: [
        {
          id: "stale-peer",
          raw: {
            id: "stale-peer",
            label: "STALE",
            platform: "android",
            version: "v",
            addedAt: null,
            lastSeen: null,
          } as unknown as DeviceMetadata,
          modules: [],
        },
      ],
    });

    const manager = new ConnectorManager();
    manager.__setConnectorStateCacheForTest(cache);
    await manager.bootstrap();

    // Simulate a refresh having landed: replace live state with a fresh
    // peer record.
    manager.perConnectorState = new Map([
      [
        "kserver-test-acct",
        {
          devices: new Map([
            [
              "fresh-peer",
              {
                raw: {
                  id: "fresh-peer",
                  label: "FRESH",
                  platform: "android",
                  version: "v",
                  addedAt: null,
                  lastSeen: null,
                } as unknown as DeviceMetadata,
                modules: new Map(),
              },
            ],
          ]),
          lastError: null,
          lastRefreshedAt: new Date(),
          lastSuccessAt: new Date(),
          refreshing: false,
        },
      ],
    ]);

    // Second bootstrap (rename / addConnector triggers this) must NOT
    // clobber the live FRESH peer with the cached STALE one.
    await manager.bootstrap();

    const live = manager.perConnectorState.get("kserver-test-acct");
    expect(live!.devices.has("fresh-peer")).toBe(true);
    expect(live!.devices.has("stale-peer")).toBe(false);

    await credsRepo.wipeAll();
  });

  it("removeConnector deletes the cache row", async () => {
    const cache = freshStateCache();
    await cache.wipeAll();
    await cache.write({
      connectorId: "connA",
      version: CURRENT_CACHE_VERSION,
      lastError: null,
      lastRefreshedAt: new Date(),
      lastSuccessAt: new Date(),
      devices: [],
    });
    expect(await cache.read("connA")).not.toBeNull();

    const cA = makeMockConnector("connA");
    const manager = new ConnectorManager();
    manager.__setConnectorsForTest({
      connectors: [cA],
      crypti: new Map([["connA", makeStubCrypti()]]),
    });
    manager.__setConnectorStateCacheForTest(cache);
    manager.perConnectorState = new Map([["connA", idleState()]]);

    await manager.removeConnector("connA");

    expect(await cache.read("connA")).toBeNull();
  });

  it("manager.signOut bumps every connector's gen BEFORE wiping; in-flight cache writes are skipped", async () => {
    // Drive a refresh that suspends inside the cache's `writeIfCurrent`
    // predicate. While suspended, call `manager.signOut()` (which bumps
    // every #cacheWriteGen). When the predicate is finally evaluated, it
    // sees the bumped gen and returns false — `db.put` is NOT called.
    const writes: CachedConnectorState[] = [];
    const stubCache = {
      read: vi.fn(async () => null),
      write: vi.fn(async (entry: CachedConnectorState) => {
        writes.push(entry);
      }),
      writeIfCurrent: vi.fn(
        async (entry: CachedConnectorState, stillCurrent: () => boolean) => {
          // Yield first so the test can call signOut between the
          // schedule and the predicate evaluation.
          await new Promise((r) => setTimeout(r, 10));
          if (!stillCurrent()) return false;
          writes.push(entry);
          return true;
        },
      ),
      delete: vi.fn(async () => undefined),
      wipeAll: vi.fn(async () => undefined),
    } as unknown as ConnectorStateCache;

    const cA = makeMockConnector("connA", {
      listDevices: vi.fn(async () => [
        {
          id: "dev-1",
          label: "Phone",
          platform: "android",
          version: "v",
          addedAt: null,
          lastSeen: null,
        } as unknown as DeviceMetadata,
      ]),
    });
    const manager = new ConnectorManager();
    manager.__setConnectorsForTest({
      connectors: [cA],
      crypti: new Map([["connA", makeStubCrypti()]]),
    });
    manager.__setConnectorStateCacheForTest(stubCache);
    manager.perConnectorState = new Map([["connA", idleState()]]);

    // Kick off the refresh (synchronously schedules a #writeCacheGuarded
    // call after listDevices resolves).
    const refreshPromise = manager.refreshAll();
    // Let the refresh complete its state-update + schedule the cache
    // write. The cache write is suspended inside writeIfCurrent's 10ms
    // gate. signOut bumps generations during that gap.
    await refreshPromise;
    expect(stubCache.writeIfCurrent).toHaveBeenCalledTimes(1);

    // Race signOut against the pending writeIfCurrent gate.
    await manager.signOut();
    // Yield until the gated write resolves; predicate must have returned
    // false, so nothing landed in `writes`.
    await new Promise((r) => setTimeout(r, 30));
    expect(writes).toHaveLength(0);
    // signOut also wipes IDB via wipeLocalSyncData (mocked via the stub's
    // wipeAll) — but wipeLocalSyncData wipes the singleton, not our stub,
    // so don't assert on stubCache.wipeAll. Instead assert that the
    // manager's in-memory state was cleared.
    expect(manager.connectors).toEqual([]);
    expect(manager.perConnectorState.size).toBe(0);
  });

  it("successful refresh writes the cache; reading it back is structurally identical", async () => {
    const cache = freshStateCache();
    await cache.wipeAll();
    const cA = makeMockConnector("connA", {
      listDevices: vi.fn(async () => [
        {
          id: "dev-1",
          label: "Phone",
          platform: "android",
          version: "v",
          addedAt: null,
          lastSeen: null,
        } as unknown as DeviceMetadata,
      ]),
    });
    const manager = new ConnectorManager();
    manager.__setConnectorsForTest({
      connectors: [cA],
      crypti: new Map([["connA", makeStubCrypti()]]),
    });
    manager.__setConnectorStateCacheForTest(cache);
    manager.perConnectorState = new Map([["connA", idleState()]]);

    await manager.refreshAll();

    // Cache write is fire-and-forget — yield to let the IDB put settle.
    await new Promise((r) => setTimeout(r, 20));

    const written = await cache.read("connA");
    expect(written).not.toBeNull();
    expect(written!.connectorId).toBe("connA");
    expect(written!.version).toBe(CURRENT_CACHE_VERSION);
    expect(written!.devices).toHaveLength(1);
    expect(written!.devices[0].id).toBe("dev-1");
  });

  it("removeConnector deletes the cache row", async () => {
    const cache = freshStateCache();
    await cache.wipeAll();
    await cache.write({
      connectorId: "connA",
      version: CURRENT_CACHE_VERSION,
      lastError: null,
      lastRefreshedAt: new Date(),
      lastSuccessAt: new Date(),
      devices: [],
    });
    expect(await cache.read("connA")).not.toBeNull();

    const cA = makeMockConnector("connA");
    const manager = new ConnectorManager();
    manager.__setConnectorsForTest({
      connectors: [cA],
      crypti: new Map([["connA", makeStubCrypti()]]),
    });
    manager.__setConnectorStateCacheForTest(cache);
    manager.perConnectorState = new Map([["connA", idleState()]]);

    await manager.removeConnector("connA");

    expect(await cache.read("connA")).toBeNull();
  });

  it("removeConnector during a pending cache write: writeIfCurrent predicate returns false and no put lands", async () => {
    // The publish-gate-style stub lets us race a `removeConnector` against
    // a pending `writeIfCurrent`. The predicate evaluates AFTER signOut's
    // gen bump, so the put is skipped.
    const writes: CachedConnectorState[] = [];
    const stubCache = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => undefined),
      writeIfCurrent: vi.fn(
        async (entry: CachedConnectorState, stillCurrent: () => boolean) => {
          // Suspend long enough for the test to invoke removeConnector.
          await new Promise((r) => setTimeout(r, 10));
          if (!stillCurrent()) return false;
          writes.push(entry);
          return true;
        },
      ),
      delete: vi.fn(async () => undefined),
      wipeAll: vi.fn(async () => undefined),
    } as unknown as ConnectorStateCache;

    const cA = makeMockConnector("connA", {
      listDevices: vi.fn(async () => [
        {
          id: "dev-1",
          label: "Phone",
          platform: "android",
          version: "v",
          addedAt: null,
          lastSeen: null,
        } as unknown as DeviceMetadata,
      ]),
    });
    const manager = new ConnectorManager();
    manager.__setConnectorsForTest({
      connectors: [cA],
      crypti: new Map([["connA", makeStubCrypti()]]),
    });
    manager.__setConnectorStateCacheForTest(stubCache);
    manager.perConnectorState = new Map([["connA", idleState()]]);

    // refreshAll schedules a writeIfCurrent that suspends in the gate.
    await manager.refreshAll();
    expect(stubCache.writeIfCurrent).toHaveBeenCalledTimes(1);

    // Race removeConnector against the suspended writeIfCurrent.
    // removeConnector bumps cacheWriteGen via #invalidateConnectorRefresh.
    await manager.removeConnector("connA");
    expect(stubCache.delete).toHaveBeenCalledWith("connA");

    // Let the suspended writeIfCurrent's predicate fire. Generation has
    // moved → predicate false → no put lands.
    await new Promise((r) => setTimeout(r, 30));
    expect(writes).toHaveLength(0);
  });
});
