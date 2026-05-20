import { describe, expect, it, vi } from "vitest";
import type { OctiServerConnector } from "../protocol/octi-server-connector";
import type { BlobCipher } from "../crypto/blob-cipher";
import type { PayloadEncryption } from "../crypto/payload";
import {
  downloadSharedFile,
  type SharedFile,
  uploadFile,
} from "./files";

/**
 * These tests pin the connector-id wire keying for FileShareInfo:
 *  - uploadFile writes `availableOn[]` and `connectorRefs{}` keyed by the
 *    uploading connector's id (matches the Android peer's expectations).
 *  - downloadSharedFile looks up by our connector id and refuses files
 *    that aren't stored on our server.
 *
 * They mock both the connector and the crypto layer so the assertions are
 * about *what* gets written to FileShareInfo, not about wire bytes.
 */

const CONNECTOR_ID = "kserver-sync.test-acct-1";
const OWN_DEVICE_ID = "dev-1";

function makeFakeConnector(overrides: Partial<{
  uploadBlobBytes: ReturnType<typeof vi.fn>;
  downloadBlob: ReturnType<typeof vi.fn>;
  readModulePayloadWithEtag: ReturnType<typeof vi.fn>;
  commitModule: ReturnType<typeof vi.fn>;
}> = {}): OctiServerConnector {
  return {
    connectorId: CONNECTOR_ID,
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

    expect(res.shared.availableOn).toEqual([CONNECTOR_ID]);
    expect(res.shared.connectorRefs).toEqual({ [CONNECTOR_ID]: "server-blob-id-42" });

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
      availableOn: [CONNECTOR_ID],
      connectorRefs: { [CONNECTOR_ID]: "remote-blob-77" },
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
      availableOn: [CONNECTOR_ID],
      connectorRefs: { [CONNECTOR_ID]: "remote-blob-77" },
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

// Inline SHA-256 hex helper so the test doesn't depend on protocol exports.
// Web crypto subtle is available in vitest's jsdom default; this file doesn't
// pin the env so we use Node-style WebCrypto via globalThis.crypto.
async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
