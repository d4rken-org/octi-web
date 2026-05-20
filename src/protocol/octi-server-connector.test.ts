import { afterEach, describe, expect, it, vi } from "vitest";
import type { OctiServerCredentialRecord } from "../storage/credentials-repo";
import { OCTI_WEB_VERSION } from "../version";
import { octiServerConnectorId } from "./connector-id";

// Mock the underlying free functions so we can assert the connector forwards
// `server`, `creds`, and `version` correctly — pure getter tests would miss a
// typo'd wrapper that, e.g., reuses the same `targetDeviceId` for both reads
// and writes.
vi.mock("./octi-api", () => ({
  createShareCode: vi.fn(async () => ({ code: "share-stub" })),
  listDevices: vi.fn(async () => []),
  readModulePayload: vi.fn(async () => null),
  readModulePayloadWithEtag: vi.fn(async () => null),
  writeModulePayload: vi.fn(async () => undefined),
  commitModule: vi.fn(async () => ({ etag: "etag-stub" })),
}));
vi.mock("./blob-session", () => ({
  uploadBlobBytes: vi.fn(async () => "blob-stub"),
  downloadBlob: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

import * as api from "./octi-api";
import * as blob from "./blob-session";
import { OctiServerConnector } from "./octi-server-connector";

const RECORD: OctiServerCredentialRecord = {
  connectorId: "kserver-sync.test-acct-1",
  connectorType: "kserver",
  accountId: "acct-1",
  devicePassword: "pwd-1",
  ownDeviceId: "dev-1",
  deviceLabel: "test",
  serverAddress: { domain: "sync.test", protocol: "https", port: 443 },
  encryptionKeyset: new Uint8Array([1]),
  createdAt: 0,
  updatedAt: 0,
};
const SERVER = RECORD.serverAddress;
const CREDS = {
  accountId: "acct-1",
  devicePassword: "pwd-1",
  deviceId: "dev-1",
};

describe("octiServerConnectorId", () => {
  it("matches the wire format kserver-<domain>-<accountId>", () => {
    expect(
      octiServerConnectorId(
        { domain: "sync.test", protocol: "https", port: 443 },
        "acct-1",
      ),
    ).toBe("kserver-sync.test-acct-1");
  });

  it("ignores port — domain alone identifies the connector subtype", () => {
    expect(
      octiServerConnectorId(
        { domain: "sync.test", protocol: "https", port: 8443 },
        "acct-1",
      ),
    ).toBe("kserver-sync.test-acct-1");
  });
});

describe("OctiServerConnector getters", () => {
  it("derives connectorId, ownDeviceId, server, creds from the record", () => {
    const c = new OctiServerConnector(RECORD);
    expect(c.connectorId).toBe("kserver-sync.test-acct-1");
    expect(c.ownDeviceId).toBe("dev-1");
    expect(c.server).toEqual(SERVER);
    expect(c.creds).toEqual(CREDS);
    expect(c.record).toBe(RECORD);
  });
});

describe("OctiServerConnector forwarding", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("createShareCode forwards server + creds", async () => {
    const c = new OctiServerConnector(RECORD);
    await c.createShareCode();
    expect(api.createShareCode).toHaveBeenCalledWith({ server: SERVER, creds: CREDS });
  });

  it("listDevices forwards server + creds", async () => {
    const c = new OctiServerConnector(RECORD);
    await c.listDevices();
    expect(api.listDevices).toHaveBeenCalledWith({ server: SERVER, creds: CREDS });
  });

  it("readModulePayload forwards per-call args alongside server + creds", async () => {
    const c = new OctiServerConnector(RECORD);
    await c.readModulePayload({ targetDeviceId: "peer-x", moduleId: "mod-x" });
    expect(api.readModulePayload).toHaveBeenCalledWith({
      server: SERVER,
      creds: CREDS,
      targetDeviceId: "peer-x",
      moduleId: "mod-x",
    });
  });

  it("readModulePayloadWithEtag forwards per-call args", async () => {
    const c = new OctiServerConnector(RECORD);
    await c.readModulePayloadWithEtag({ targetDeviceId: "peer-y", moduleId: "mod-y" });
    expect(api.readModulePayloadWithEtag).toHaveBeenCalledWith({
      server: SERVER,
      creds: CREDS,
      targetDeviceId: "peer-y",
      moduleId: "mod-y",
    });
  });

  it("writeModulePayload forwards deviceTag when supplied", async () => {
    const c = new OctiServerConnector(RECORD);
    const ct = new Uint8Array([9]);
    const tag = { version: "v", label: "L" };
    await c.writeModulePayload({
      targetDeviceId: "dev-1",
      moduleId: "mod-z",
      ciphertext: ct,
      deviceTag: tag,
    });
    expect(api.writeModulePayload).toHaveBeenCalledWith({
      server: SERVER,
      creds: CREDS,
      targetDeviceId: "dev-1",
      moduleId: "mod-z",
      ciphertext: ct,
      deviceTag: tag,
    });
  });

  it("commitModule forwards ifMatch / ifNoneMatchStar precondition headers", async () => {
    const c = new OctiServerConnector(RECORD);
    const doc = new Uint8Array([0]);
    await c.commitModule({
      targetDeviceId: "dev-1",
      moduleId: "files",
      documentBytes: doc,
      blobIds: ["b1", "b2"],
      ifMatch: "etag-old",
    });
    expect(api.commitModule).toHaveBeenLastCalledWith({
      server: SERVER,
      creds: CREDS,
      targetDeviceId: "dev-1",
      moduleId: "files",
      documentBytes: doc,
      blobIds: ["b1", "b2"],
      ifMatch: "etag-old",
      ifNoneMatchStar: undefined,
    });
    await c.commitModule({
      targetDeviceId: "dev-1",
      moduleId: "files",
      documentBytes: doc,
      blobIds: [],
      ifNoneMatchStar: true,
    });
    expect(api.commitModule).toHaveBeenLastCalledWith({
      server: SERVER,
      creds: CREDS,
      targetDeviceId: "dev-1",
      moduleId: "files",
      documentBytes: doc,
      blobIds: [],
      ifMatch: undefined,
      ifNoneMatchStar: true,
    });
  });

  it("uploadBlobBytes injects OCTI_WEB_VERSION and forwards onProgress", async () => {
    const c = new OctiServerConnector(RECORD);
    const ct = new Uint8Array([1, 2]);
    const onProgress = vi.fn();
    await c.uploadBlobBytes({
      targetDeviceId: "dev-1",
      moduleId: "files",
      ciphertext: ct,
      onProgress,
    });
    expect(blob.uploadBlobBytes).toHaveBeenCalledWith({
      server: SERVER,
      creds: CREDS,
      version: OCTI_WEB_VERSION,
      targetDeviceId: "dev-1",
      moduleId: "files",
      ciphertext: ct,
      onProgress,
    });
  });

  it("downloadBlob injects OCTI_WEB_VERSION and forwards targetDeviceId + moduleId + blobId", async () => {
    const c = new OctiServerConnector(RECORD);
    await c.downloadBlob({ targetDeviceId: "peer-z", moduleId: "files", blobId: "b-99" });
    expect(blob.downloadBlob).toHaveBeenCalledWith({
      server: SERVER,
      creds: CREDS,
      version: OCTI_WEB_VERSION,
      targetDeviceId: "peer-z",
      moduleId: "files",
      blobId: "b-99",
    });
  });
});
