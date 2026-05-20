import { describe, expect, it, vi } from "vitest";
import type { BlobCipher } from "../crypto/blob-cipher";
import type { PayloadEncryption } from "../crypto/payload";
import { octiServerConnectorId } from "../protocol/connector-id";
import type { ServerAddress } from "../protocol/models";
import type { OctiServerConnector } from "../protocol/octi-server-connector";
import {
  deserializeFileShareInfo,
  downloadSharedFile,
  type FileShareInfo,
  serializeFileShareInfo,
  type SharedFile,
  uploadFile,
} from "./files";

/**
 * These tests cover two layers of the files module:
 *
 *  1. **Behavior** — uploadFile keys `availableOn[]` / `connectorRefs{}` by
 *     the uploading connector's id; downloadSharedFile looks up by our
 *     connector id and refuses files that aren't stored on our server.
 *  2. **Wire format** — `FileShareInfo` round-trips byte-exactly through
 *     serialize/deserialize, null-strips for the Android strict decoder,
 *     emits `connectorRefs` map values as bare strings (matching Android's
 *     `@JvmInline value class RemoteBlobRef`), and coerces empty/partial
 *     payloads to the canonical empty shape.
 *
 * Behavior tests mock the connector and crypto layer. Wire-format tests
 * exercise the real (de)serializers against fixed samples.
 */

const FAKE_CONNECTOR_ID = "kserver-sync.test-acct-1";
const OWN_DEVICE_ID = "dev-1";

function makeFakeConnector(overrides: Partial<{
  uploadBlobBytes: ReturnType<typeof vi.fn>;
  downloadBlob: ReturnType<typeof vi.fn>;
  readModulePayloadWithEtag: ReturnType<typeof vi.fn>;
  commitModule: ReturnType<typeof vi.fn>;
}> = {}): OctiServerConnector {
  return {
    connectorId: FAKE_CONNECTOR_ID,
    ownDeviceId: OWN_DEVICE_ID,
    uploadBlobBytes: overrides.uploadBlobBytes ?? vi.fn(async () => "server-blob-id-42"),
    downloadBlob: overrides.downloadBlob ?? vi.fn(async () => new Uint8Array([7, 7, 7])),
    readModulePayloadWithEtag:
      overrides.readModulePayloadWithEtag ?? vi.fn(async () => null),
    commitModule: overrides.commitModule ?? vi.fn(async () => ({ etag: "etag-new" })),
  } as unknown as OctiServerConnector;
}

function makePassthroughCrypti(): PayloadEncryption {
  // Identity: encrypt/decrypt return the same bytes. uploadFile reads its own
  // FileShareInfo back from `readModulePayloadWithEtag`; we stub that to null
  // (no prior payload), so the decrypt path is never exercised here.
  return {
    encrypt: (plaintext: Uint8Array) => plaintext,
    decrypt: (ciphertext: Uint8Array) => ciphertext,
  } as unknown as PayloadEncryption;
}

function makePassthroughBlobCipher(): BlobCipher {
  return {
    encrypt: async (bytes: Uint8Array) => bytes,
    decrypt: async (bytes: Uint8Array) => bytes,
  } as unknown as BlobCipher;
}

describe("uploadFile wire keying", () => {
  it("writes availableOn and connectorRefs keyed by connector.connectorId", async () => {
    const commit = vi.fn(async () => ({ etag: "etag" }));
    const upload = vi.fn(async () => "server-blob-id-42");
    const connector = makeFakeConnector({ commitModule: commit, uploadBlobBytes: upload });

    const file = new File([new Uint8Array([1, 2, 3])], "hello.txt", { type: "text/plain" });
    const res = await uploadFile({
      connector,
      crypti: makePassthroughCrypti(),
      blobCipher: makePassthroughBlobCipher(),
      file,
    });

    expect(res.shared.availableOn).toEqual([FAKE_CONNECTOR_ID]);
    expect(res.shared.connectorRefs).toEqual({ [FAKE_CONNECTOR_ID]: "server-blob-id-42" });

    // commitModule receives the blob id we just uploaded (server replaces, not merges).
    // First write on this module → If-None-Match: *. The ifMatch key is absent
    // from the spread (not set to undefined), so don't include it in the matcher.
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        blobIds: ["server-blob-id-42"],
        ifNoneMatchStar: true,
      }),
    );
  });
});

describe("downloadSharedFile wire keying", () => {
  it("reads the blob id from file.connectorRefs[connector.connectorId]", async () => {
    const download = vi.fn(async () => new Uint8Array([4, 5, 6]));
    const connector = makeFakeConnector({ downloadBlob: download });
    const file: SharedFile = {
      name: "demo.bin",
      mimeType: "application/octet-stream",
      size: 3,
      blobKey: "sha256:0000",
      // Pre-compute a checksum of the passthrough-decrypted ciphertext above.
      checksum: await sha256OfBytes(new Uint8Array([4, 5, 6])),
      sharedAt: new Date(0).toISOString(),
      expiresAt: new Date(0).toISOString(),
      availableOn: [FAKE_CONNECTOR_ID],
      connectorRefs: { [FAKE_CONNECTOR_ID]: "remote-blob-77" },
    };

    const out = await downloadSharedFile({
      connector,
      blobCipher: makePassthroughBlobCipher(),
      ownerDeviceId: "owner-dev",
      file,
    });

    expect(download).toHaveBeenCalledWith({
      targetDeviceId: "owner-dev",
      moduleId: "eu.darken.octi.module.core.files",
      blobId: "remote-blob-77",
    });
    expect(Array.from(out.bytes)).toEqual([4, 5, 6]);
    expect(out.name).toBe("demo.bin");
    expect(out.mimeType).toBe("application/octet-stream");
  });

  it("throws when the file isn't stored on our connector", async () => {
    const connector = makeFakeConnector();
    const file: SharedFile = {
      name: "other-server.bin",
      mimeType: "application/octet-stream",
      size: 0,
      blobKey: "sha256:0000",
      checksum: "deadbeef",
      sharedAt: new Date(0).toISOString(),
      expiresAt: new Date(0).toISOString(),
      availableOn: ["kserver-other.test-acct-2"],
      connectorRefs: { "kserver-other.test-acct-2": "elsewhere" },
    };

    await expect(
      downloadSharedFile({
        connector,
        blobCipher: makePassthroughBlobCipher(),
        ownerDeviceId: "owner-dev",
        file,
      }),
    ).rejects.toThrow(/isn't stored on this server/);
  });

  it("throws on checksum mismatch", async () => {
    const download = vi.fn(async () => new Uint8Array([4, 5, 6]));
    const connector = makeFakeConnector({ downloadBlob: download });
    const file: SharedFile = {
      name: "tampered.bin",
      mimeType: "application/octet-stream",
      size: 3,
      blobKey: "sha256:abc",
      checksum: "f".repeat(64), // never matches the actual content's hash
      sharedAt: new Date(0).toISOString(),
      expiresAt: new Date(0).toISOString(),
      availableOn: [FAKE_CONNECTOR_ID],
      connectorRefs: { [FAKE_CONNECTOR_ID]: "remote-blob-77" },
    };

    await expect(
      downloadSharedFile({
        connector,
        blobCipher: makePassthroughBlobCipher(),
        ownerDeviceId: "owner-dev",
        file,
      }),
    ).rejects.toThrow(/Checksum mismatch/);
  });
});

describe("FileShareInfo wire format", () => {
  const WIRE_SERVER: ServerAddress = {
    domain: "prod.kserver.octi.darken.eu",
    protocol: "https",
    port: 443,
  };
  const WIRE_ACCOUNT_ID = "11111111-1111-1111-1111-111111111111";
  const WIRE_CONNECTOR_ID = octiServerConnectorId(WIRE_SERVER, WIRE_ACCOUNT_ID);

  const sharedFile: SharedFile = {
    name: "report.pdf",
    mimeType: "application/pdf",
    size: 12345,
    blobKey: "sha256:deadbeef",
    checksum: "deadbeef",
    sharedAt: "2026-05-17T22:00:00Z",
    expiresAt: "2026-06-16T22:00:00Z",
    availableOn: [WIRE_CONNECTOR_ID],
    connectorRefs: { [WIRE_CONNECTOR_ID]: "blob-id-opaque-xyz" },
  };

  const sample: FileShareInfo = {
    files: [sharedFile],
    deleteRequests: [
      {
        targetDeviceId: "22222222-2222-2222-2222-222222222222",
        blobKey: "sha256:cafebabe",
        requestedAt: "2026-05-17T22:00:00Z",
        retainUntil: "2026-05-24T22:00:00Z",
      },
    ],
  };

  it("round-trips through serialize/deserialize", () => {
    const bytes = serializeFileShareInfo(sample);
    expect(deserializeFileShareInfo(bytes)).toEqual(sample);
  });

  it("emits connectorRefs map value as a bare string (Android @JvmInline RemoteBlobRef)", () => {
    // RemoteBlobRef is a value class over String; flattening it to an object
    // like { id: "..." } would strict-fail on the Android decoder.
    const json = JSON.parse(new TextDecoder().decode(serializeFileShareInfo(sample)));
    expect(json.files[0].connectorRefs).toEqual({ [WIRE_CONNECTOR_ID]: "blob-id-opaque-xyz" });
    expect(typeof json.files[0].connectorRefs[WIRE_CONNECTOR_ID]).toBe("string");
  });

  it("emits availableOn as a plain array of connector-id strings", () => {
    const json = JSON.parse(new TextDecoder().decode(serializeFileShareInfo(sample)));
    expect(json.files[0].availableOn).toEqual([WIRE_CONNECTOR_ID]);
  });

  it("preserves all SharedFile wire keys exactly", () => {
    // Pins the JSON key set — adding/renaming a field needs a sister Android
    // change, and this test forces that conversation.
    const json = JSON.parse(new TextDecoder().decode(serializeFileShareInfo(sample)));
    expect(Object.keys(json.files[0]).sort()).toEqual(
      [
        "availableOn",
        "blobKey",
        "checksum",
        "connectorRefs",
        "expiresAt",
        "mimeType",
        "name",
        "sharedAt",
        "size",
      ].sort(),
    );
  });

  it("drops null-valued fields on the wire (Android strict-decoder compat)", () => {
    // Same null-stripping rule as MetaInfo — Android's strict decoder rejects
    // null for fields with non-nullable custom serializers.
    const withNulls = {
      ...sample,
      files: [{ ...sharedFile, mimeType: null as unknown as string }],
    };
    const json = JSON.parse(new TextDecoder().decode(serializeFileShareInfo(withNulls)));
    expect("mimeType" in json.files[0]).toBe(false);
    expect(json.files[0].name).toBe(sharedFile.name);
  });

  it("deserializes an empty top-level object to the empty FileShareInfo (forward-compat)", () => {
    // Older / freshly-initialised peers may publish `{}` before they have any
    // files; we coerce to the empty shape so the dashboard merge doesn't NPE.
    const bytes = new TextEncoder().encode("{}");
    expect(deserializeFileShareInfo(bytes)).toEqual({ files: [], deleteRequests: [] });
  });

  it("deserializes a payload with only files (no deleteRequests key)", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ files: [sharedFile] }));
    const out = deserializeFileShareInfo(bytes);
    expect(out.files).toEqual([sharedFile]);
    expect(out.deleteRequests).toEqual([]);
  });
});

// Inline SHA-256 hex helper so the test doesn't depend on protocol exports.
// Web crypto subtle is available in vitest's jsdom default; this file doesn't
// pin the env so we use Node-style WebCrypto via globalThis.crypto.
async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
