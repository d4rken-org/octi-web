import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { deriveBlobIkm } from "./hkdf";
import {
  expectedCiphertextSize,
  STREAMING_AEAD,
  streamingAeadDecrypt,
  streamingAeadEncrypt,
} from "./streaming-aead";

interface FixtureVector {
  name: string;
  aad: string;
  plaintextBase64: string;
  plaintextSize: number;
  ciphertextBase64: string;
  ciphertextSize: number;
}

interface Fixture {
  keysetType: string;
  keysetBase64: string;
  vectors: FixtureVector[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(HERE, "__fixtures__", "streaming-vectors.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as Fixture;

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

describe("streaming AEAD — JVM↔TS golden vectors", () => {
  it("fixture sanity", () => {
    expect(fixture.keysetType).toBe("AES256_GCM_SIV");
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(3);
    const twoSegments = fixture.vectors.find((v) => v.name === "two-segments");
    expect(twoSegments).toBeDefined();
    expect(twoSegments!.plaintextSize).toBeGreaterThan(STREAMING_AEAD.PLAINTEXT_FIRST_SEGMENT);
  });

  for (const v of fixture.vectors) {
    it(`decrypts JVM ciphertext: ${v.name} (${v.plaintextSize} B plaintext)`, async () => {
      // The load-bearing check: a ciphertext produced by Android's
      // StreamingPayloadCipher (Tink AesGcmHkdfStreaming) must decrypt under
      // our TS port. Fails noisily on any wire-format / HKDF / AAD / nonce
      // drift.
      const ikm = await deriveBlobIkm(base64ToBytes(fixture.keysetBase64));
      const plaintext = base64ToBytes(v.plaintextBase64);
      const aad = new TextEncoder().encode(v.aad);
      const ciphertext = base64ToBytes(v.ciphertextBase64);

      const decrypted = await streamingAeadDecrypt(ikm, ciphertext, aad);
      expect(decrypted.length).toBe(plaintext.length);
      // Byte-equality across multi-MB Uint8Array is faster via length+sample compare
      // than `toEqual` on the whole thing; vitest's toEqual stringifies on failure.
      expect(decrypted).toEqual(plaintext);
    });
  }

  for (const v of fixture.vectors) {
    it(`roundtrips TS→TS: ${v.name}`, async () => {
      const ikm = await deriveBlobIkm(base64ToBytes(fixture.keysetBase64));
      const plaintext = base64ToBytes(v.plaintextBase64);
      const aad = new TextEncoder().encode(v.aad);

      const ct = await streamingAeadEncrypt(ikm, plaintext, aad);
      expect(ct.length).toBe(expectedCiphertextSize(plaintext.length));
      const pt = await streamingAeadDecrypt(ikm, ct, aad);
      expect(pt).toEqual(plaintext);
    });
  }

  it("decrypt fails on wrong AAD", async () => {
    const ikm = await deriveBlobIkm(base64ToBytes(fixture.keysetBase64));
    const v = fixture.vectors.find((x) => x.name === "short")!;
    const ciphertext = base64ToBytes(v.ciphertextBase64);
    const wrong = new TextEncoder().encode(`${v.aad}-tampered`);
    await expect(streamingAeadDecrypt(ikm, ciphertext, wrong)).rejects.toThrow();
  });

  it("decrypt fails on tampered ciphertext", async () => {
    const ikm = await deriveBlobIkm(base64ToBytes(fixture.keysetBase64));
    const v = fixture.vectors.find((x) => x.name === "short")!;
    const aad = new TextEncoder().encode(v.aad);
    const tampered = base64ToBytes(v.ciphertextBase64);
    // Flip a bit in the body (past the header).
    tampered[tampered.length - 1] ^= 0x01;
    await expect(streamingAeadDecrypt(ikm, tampered, aad)).rejects.toThrow();
  });

  it("expectedCiphertextSize matches actual encrypt output for typical sizes", async () => {
    const ikm = await deriveBlobIkm(base64ToBytes(fixture.keysetBase64));
    for (const size of [0, 1, 100, STREAMING_AEAD.PLAINTEXT_FIRST_SEGMENT - 1,
      STREAMING_AEAD.PLAINTEXT_FIRST_SEGMENT,
      STREAMING_AEAD.PLAINTEXT_FIRST_SEGMENT + 1,
      STREAMING_AEAD.PLAINTEXT_FIRST_SEGMENT + STREAMING_AEAD.PLAINTEXT_NEXT_SEGMENT]) {
      const pt = new Uint8Array(size);
      const ct = await streamingAeadEncrypt(ikm, pt, new TextEncoder().encode("aad"));
      expect(ct.length).toBe(expectedCiphertextSize(size));
    }
  });
});
