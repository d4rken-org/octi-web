import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createPayloadEncryption } from "./payload";

interface FixtureVector {
  name: string;
  plaintextBase64: string;
  ad: string;
  ciphertextBase64: string;
}

interface FixtureKeysetBlock {
  keysetType: string;
  keysetBase64: string;
  vectors: FixtureVector[];
}

interface Fixture {
  generatedAt: string;
  note: string;
  gcmsiv: FixtureKeysetBlock;
  siv: FixtureKeysetBlock;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(HERE, "__fixtures__", "tink-vectors.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as Fixture;

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

describe("payload — JVM↔TS golden vectors (AES-GCM-SIV)", () => {
  const keysetBytes = base64ToBytes(fixture.gcmsiv.keysetBase64);

  it("fixture metadata sanity", () => {
    expect(fixture.gcmsiv.keysetType).toBe("AES256_GCM_SIV");
    expect(fixture.gcmsiv.vectors.length).toBeGreaterThanOrEqual(3);
  });

  for (const v of fixture.gcmsiv.vectors) {
    it(`decrypts JVM ciphertext: ${v.name}`, () => {
      // The load-bearing check: a ciphertext produced by JVM PayloadEncryption +
      // gzip wrap must decrypt + gunzip back to the original plaintext under our
      // TS implementation. This fails noisily on any wire-format drift (Tink
      // prefix layout, nonce position, AD encoding, gzip wrap).
      const crypti = createPayloadEncryption(keysetBytes);
      const plaintext = base64ToBytes(v.plaintextBase64);
      const ad = new TextEncoder().encode(v.ad);
      const ciphertext = base64ToBytes(v.ciphertextBase64);

      const decrypted = crypti.decrypt(ciphertext, ad);
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
      const ad = new TextEncoder().encode(v.ad);

      const ct = crypti.encrypt(plaintext, ad);
      expect(crypti.decrypt(ct, ad)).toEqual(plaintext);
    });
  }

  it("decrypt fails on wrong AD", () => {
    const crypti = createPayloadEncryption(keysetBytes);
    const v = fixture.gcmsiv.vectors[1]!;
    const ciphertext = base64ToBytes(v.ciphertextBase64);
    const wrongAd = new TextEncoder().encode(`${v.ad}-tampered`);
    expect(() => crypti.decrypt(ciphertext, wrongAd)).toThrow();
  });

  it("decrypt fails on tampered ciphertext", () => {
    const crypti = createPayloadEncryption(keysetBytes);
    const v = fixture.gcmsiv.vectors[1]!;
    const ad = new TextEncoder().encode(v.ad);
    const tampered = base64ToBytes(v.ciphertextBase64);
    // Flip a bit in the body (skip the 5-byte Tink prefix to avoid hitting the
    // prefix-mismatch error path; we want the AEAD tag verification to be what fails).
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => crypti.decrypt(tampered, ad)).toThrow();
  });
});

describe("payload — SIV keyset is rejected (v1 web client only supports GCM-SIV)", () => {
  it("parseTinkKeyset throws on the legacy SIV type_url", () => {
    const sivKeysetBytes = base64ToBytes(fixture.siv.keysetBase64);
    expect(() => createPayloadEncryption(sivKeysetBytes)).toThrow(/AesGcmSivKey/);
  });
});
