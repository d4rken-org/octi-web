import { describe, expect, it } from "vitest";

import { createPayloadEncryption } from "./payload";
import {
  INTEROP_LOCK,
  loadInteropJson,
  type InteropTinkVectors,
} from "../__interop__/fixture-loader";

const fixture = loadInteropJson<InteropTinkVectors>("tink-vectors.json");

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

describe("payload — JVM↔TS golden vectors (AES-GCM-SIV)", () => {
  const keysetBytes = base64ToBytes(fixture.gcmsiv.keysetBase64);

  it("fixture metadata sanity", () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.gcmsiv.keysetType).toBe("AES256_GCM_SIV");
    expect(fixture.siv.keysetType).toBe("AES256_SIV");
    expect(fixture.gcmsiv.vectors.length).toBeGreaterThanOrEqual(3);
    expect(INTEROP_LOCK.source).toBe("d4rken-org/octi");
  });

  for (const v of fixture.gcmsiv.vectors) {
    it(`decrypts JVM ciphertext: ${v.name}`, () => {
      // The load-bearing check: a ciphertext produced by JVM PayloadEncryption +
      // gzip wrap must decrypt + gunzip back to the original plaintext under our
      // TS implementation. This fails noisily on any wire-format drift (Tink
      // prefix layout, nonce position, AAD encoding, gzip wrap).
      const crypti = createPayloadEncryption(keysetBytes);
      const plaintext = base64ToBytes(v.plaintextBase64);
      const aad = new TextEncoder().encode(v.aad);
      const ciphertext = base64ToBytes(v.ciphertextBase64);
      // App-main pins this: Tink AEAD wire prefix byte is 0x01. Bail early so
      // a Tink upgrade that shifts the prefix is diagnosed up here, not as an
      // opaque "decrypt failed".
      expect(ciphertext[0]).toBe(0x01);

      const decrypted = crypti.decrypt(ciphertext, aad);
      expect(decrypted).toEqual(plaintext);
    });
  }

  for (const v of fixture.gcmsiv.vectors) {
    it(`roundtrips TS→TS: ${v.name}`, () => {
      // Sanity: our encrypt is the inverse of our decrypt. Doesn't prove JVM
      // compat on its own (any consistent bug passes), but catches accidental
      // changes to the local wire layout.
      const crypti = createPayloadEncryption(keysetBytes);
      const plaintext = base64ToBytes(v.plaintextBase64);
      const aad = new TextEncoder().encode(v.aad);

      const ct = crypti.encrypt(plaintext, aad);
      expect(crypti.decrypt(ct, aad)).toEqual(plaintext);
    });
  }

  it("decrypt fails on wrong AAD", () => {
    const crypti = createPayloadEncryption(keysetBytes);
    const v = fixture.gcmsiv.vectors.find((x) => x.plaintextBase64.length > 0)!;
    const ciphertext = base64ToBytes(v.ciphertextBase64);
    const wrongAad = new TextEncoder().encode(`${v.aad}-tampered`);
    expect(() => crypti.decrypt(ciphertext, wrongAad)).toThrow();
  });

  it("decrypt fails on tampered ciphertext", () => {
    const crypti = createPayloadEncryption(keysetBytes);
    const v = fixture.gcmsiv.vectors.find((x) => x.plaintextBase64.length > 0)!;
    const aad = new TextEncoder().encode(v.aad);
    const tampered = base64ToBytes(v.ciphertextBase64);
    // Flip a bit in the body (skip the 5-byte Tink prefix to avoid hitting the
    // prefix-mismatch error path; we want the AEAD tag verification to be what fails).
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => crypti.decrypt(tampered, aad)).toThrow();
  });
});

describe("payload — SIV keyset is rejected (v1 web client only supports GCM-SIV)", () => {
  it("parseTinkKeyset throws on the legacy SIV type_url", () => {
    const sivKeysetBytes = base64ToBytes(fixture.siv.keysetBase64);
    expect(() => createPayloadEncryption(sivKeysetBytes)).toThrow(/AesGcmSivKey/);
  });
});
