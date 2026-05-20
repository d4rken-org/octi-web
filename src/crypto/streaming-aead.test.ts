import { describe, expect, it } from "vitest";

import { deriveBlobIkm } from "./hkdf";
import {
  expectedCiphertextSize,
  STREAMING_AEAD,
  streamingAeadDecrypt,
  streamingAeadEncrypt,
} from "./streaming-aead";
import {
  loadInteropJson,
  materializeStreamingPlaintext,
  type InteropStreamingVector,
  type InteropStreamingVectors,
} from "../__interop__/fixture-loader";

const fixture = loadInteropJson<InteropStreamingVectors>("streaming-vectors.json");

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** Resolve a vector's plaintext bytes, whether stored inline or as a pattern reference. */
function plaintextOf(v: InteropStreamingVector): Uint8Array {
  const hasInline = v.plaintextBase64 !== undefined;
  const hasPattern = v.plaintextPattern !== undefined;
  if (hasInline === hasPattern) {
    throw new Error(
      `streaming vector '${v.name}' must declare exactly one of plaintextBase64 / plaintextPattern`,
    );
  }
  const bytes = hasInline
    ? base64ToBytes(v.plaintextBase64!)
    : materializeStreamingPlaintext(v.plaintextPattern!);
  if (bytes.length !== v.plaintextSize) {
    throw new Error(
      `streaming vector '${v.name}' plaintextSize ${v.plaintextSize} disagrees with materialized ${bytes.length}`,
    );
  }
  return bytes;
}

describe("streaming AEAD — JVM↔TS golden vectors", () => {
  it("fixture sanity", () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.keysetType).toBe("AES256_GCM_SIV");
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(3);
    const multiSegment = fixture.vectors.find(
      (v) => v.plaintextSize > STREAMING_AEAD.PLAINTEXT_FIRST_SEGMENT,
    );
    expect(multiSegment).toBeDefined();
  });

  for (const v of fixture.vectors) {
    it(`decrypts JVM ciphertext: ${v.name} (${v.plaintextSize} B plaintext)`, async () => {
      // The load-bearing check: a ciphertext produced by Android's
      // StreamingPayloadCipher (Tink AesGcmHkdfStreaming) must decrypt under
      // our TS port. Fails noisily on any wire-format / HKDF / AAD / nonce
      // drift.
      const ikm = await deriveBlobIkm(base64ToBytes(fixture.keysetBase64));
      const plaintext = plaintextOf(v);
      const aad = new TextEncoder().encode(v.aad);
      const ciphertext = base64ToBytes(v.ciphertextBase64);
      expect(ciphertext.length).toBe(v.ciphertextSize);

      const decrypted = await streamingAeadDecrypt(ikm, ciphertext, aad);
      expect(decrypted.length).toBe(plaintext.length);
      expect(decrypted).toEqual(plaintext);
    });
  }

  for (const v of fixture.vectors) {
    it(`roundtrips TS→TS: ${v.name}`, async () => {
      const ikm = await deriveBlobIkm(base64ToBytes(fixture.keysetBase64));
      const plaintext = plaintextOf(v);
      const aad = new TextEncoder().encode(v.aad);

      const ct = await streamingAeadEncrypt(ikm, plaintext, aad);
      expect(ct.length).toBe(expectedCiphertextSize(plaintext.length));
      const pt = await streamingAeadDecrypt(ikm, ct, aad);
      expect(pt).toEqual(plaintext);
    });
  }

  it("decrypt fails on wrong AAD", async () => {
    const ikm = await deriveBlobIkm(base64ToBytes(fixture.keysetBase64));
    const v = fixture.vectors.find((x) => x.plaintextSize > 0)!;
    const ciphertext = base64ToBytes(v.ciphertextBase64);
    const wrong = new TextEncoder().encode(`${v.aad}-tampered`);
    await expect(streamingAeadDecrypt(ikm, ciphertext, wrong)).rejects.toThrow();
  });

  it("decrypt fails on tampered ciphertext", async () => {
    const ikm = await deriveBlobIkm(base64ToBytes(fixture.keysetBase64));
    const v = fixture.vectors.find((x) => x.plaintextSize > 0)!;
    const aad = new TextEncoder().encode(v.aad);
    const tampered = base64ToBytes(v.ciphertextBase64);
    // Flip a bit in the body (past the header).
    tampered[tampered.length - 1] ^= 0x01;
    await expect(streamingAeadDecrypt(ikm, tampered, aad)).rejects.toThrow();
  });

  it("expectedCiphertextSize matches actual encrypt output for typical sizes", async () => {
    const ikm = await deriveBlobIkm(base64ToBytes(fixture.keysetBase64));
    for (const size of [
      0,
      1,
      100,
      STREAMING_AEAD.PLAINTEXT_FIRST_SEGMENT - 1,
      STREAMING_AEAD.PLAINTEXT_FIRST_SEGMENT,
      STREAMING_AEAD.PLAINTEXT_FIRST_SEGMENT + 1,
      STREAMING_AEAD.PLAINTEXT_FIRST_SEGMENT + STREAMING_AEAD.PLAINTEXT_NEXT_SEGMENT,
    ]) {
      const pt = new Uint8Array(size);
      const ct = await streamingAeadEncrypt(ikm, pt, new TextEncoder().encode("aad"));
      expect(ct.length).toBe(expectedCiphertextSize(size));
    }
  });
});
