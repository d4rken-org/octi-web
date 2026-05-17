import { deriveBlobIkm } from "./hkdf";
import {
  expectedCiphertextSize,
  streamingAeadDecrypt,
  streamingAeadEncrypt,
} from "./streaming-aead";

/**
 * Convenience wrapper around the Tink-equivalent streaming AEAD primitive for
 * Octi file blobs. Mirrors Android's `OctiServerBlobStore`:
 *
 *   ikm  = HKDF-SHA256(keysetBytes, salt="octi-blob", info="octi-blob-stream-v1", 32)
 *   aad  = "${deviceId}:${moduleId}:${blobKey}"
 *   wire = streamingAead.encrypt(ikm, plaintext, aad)
 *
 * Cache the {@link BlobCipher} via {@link createBlobCipher} when you're going to
 * encrypt/decrypt multiple blobs in a session — the outer HKDF runs once instead
 * of per call.
 */
export interface BlobCipher {
  encrypt(plaintext: Uint8Array, deviceId: string, moduleId: string, blobKey: string): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array, deviceId: string, moduleId: string, blobKey: string): Promise<Uint8Array>;
  ciphertextSize(plaintextSize: number): number;
}

export async function createBlobCipher(keysetBytes: Uint8Array): Promise<BlobCipher> {
  const ikm = await deriveBlobIkm(keysetBytes);
  return {
    encrypt: (plaintext, deviceId, moduleId, blobKey) =>
      streamingAeadEncrypt(ikm, plaintext, buildBlobAad(deviceId, moduleId, blobKey)),
    decrypt: (ciphertext, deviceId, moduleId, blobKey) =>
      streamingAeadDecrypt(ikm, ciphertext, buildBlobAad(deviceId, moduleId, blobKey)),
    ciphertextSize: expectedCiphertextSize,
  };
}

export function buildBlobAad(deviceId: string, moduleId: string, blobKey: string): Uint8Array {
  return new TextEncoder().encode(`${deviceId}:${moduleId}:${blobKey}`);
}
