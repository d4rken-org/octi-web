import { afterEach, describe, expect, it, vi } from "vitest";

import { CLIPBOARD_MODULE_ID } from "../modules/clipboard";
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
      ["connA", { devices: new Map(), lastError: null, lastRefreshedAt: null, lastSuccessAt: null }],
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
      ["connA", { devices: new Map(), lastError: null, lastRefreshedAt: null, lastSuccessAt: null }],
      ["connB", { devices: new Map(), lastError: null, lastRefreshedAt: null, lastSuccessAt: null }],
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
        { devices: new Map(), lastError: null, lastRefreshedAt: null, lastSuccessAt: null },
      ],
      [
        "connB",
        { devices: new Map(), lastError: null, lastRefreshedAt: null, lastSuccessAt: null },
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
      ["connA", { devices: new Map(), lastError: null, lastRefreshedAt: null, lastSuccessAt: null }],
      ["connB", { devices: new Map(), lastError: null, lastRefreshedAt: null, lastSuccessAt: null }],
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
      ["connA", { devices: new Map(), lastError: null, lastRefreshedAt: null, lastSuccessAt: null }],
      ["connB", { devices: new Map(), lastError: null, lastRefreshedAt: null, lastSuccessAt: null }],
    ]);

    const file = new File([new Uint8Array([9, 9])], "y.bin", { type: "application/octet-stream" });
    const result = await manager.uploadFile(file);

    expect(result.shared.availableOn).toEqual(["connB"]);
    expect(result.shared.connectorRefs).toEqual({ connB: "blob-B" });
    expect(manager.perConnectorState.get("connA")?.lastError).toMatch(/quota exceeded/);
  });
});
