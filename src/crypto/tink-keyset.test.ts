import { describe, expect, it } from "vitest";

import {
  generateAesGcmSivKeyset,
  getPrimaryKey,
  parseTinkKeyset,
  serializeTinkKeyset,
} from "./tink-keyset";
import { createPayloadEncryption } from "./payload";
import { loadInteropJson, type InteropTinkVectors } from "../__interop__/fixture-loader";

const fixture = loadInteropJson<InteropTinkVectors>("tink-vectors.json");

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
}

describe("tink-keyset writer", () => {
  it("round-trips a JVM-produced keyset byte-for-byte", () => {
    // The strongest writer test: parse a real JVM keyset, serialize it, and
    // assert byte equality. Any field-number, varint, or length disagreement
    // shows up as a hex diff. This pins us against tink-android 1.16.0's exact
    // wire format (including the field-3 key_value quirk).
    const original = base64ToBytes(fixture.gcmsiv.keysetBase64);
    const reserialized = serializeTinkKeyset(parseTinkKeyset(original));
    expect(bytesToHex(reserialized)).toBe(bytesToHex(original));
  });

  it("freshly generated keyset round-trips through parse + serialize", () => {
    const { bytes: original } = generateAesGcmSivKeyset();
    const reserialized = serializeTinkKeyset(parseTinkKeyset(original));
    expect(bytesToHex(reserialized)).toBe(bytesToHex(original));
  });

  it("freshly generated keyset has a non-zero 32-bit key id", () => {
    for (let i = 0; i < 100; i++) {
      const { keyset } = generateAesGcmSivKeyset();
      expect(keyset.primaryKeyId).toBeGreaterThan(0);
      expect(keyset.primaryKeyId).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("freshly generated keyset encrypts and decrypts under itself", () => {
    // E2E sanity: write → parse → use via createPayloadEncryption is exactly the
    // path the create-account flow takes (generate, persist bytes, later load).
    const { bytes } = generateAesGcmSivKeyset();
    const crypti = createPayloadEncryption(bytes);
    const ad = new TextEncoder().encode("test-device:test-module");
    const plaintext = new TextEncoder().encode("Octi web client");
    const ct = crypti.encrypt(plaintext, ad);
    expect(crypti.decrypt(ct, ad)).toEqual(plaintext);
  });

  it("two fresh keysets are different", () => {
    // Defends against a stuck PRNG / cached-key bug.
    const a = generateAesGcmSivKeyset();
    const b = generateAesGcmSivKeyset();
    expect(bytesToHex(a.bytes)).not.toBe(bytesToHex(b.bytes));
    expect(a.keyset.primaryKeyId).not.toBe(b.keyset.primaryKeyId);
  });

  it("getPrimaryKey returns the unique key in a single-key keyset", () => {
    const { keyset } = generateAesGcmSivKeyset();
    const primary = getPrimaryKey(keyset);
    expect(primary.keyId).toBe(keyset.primaryKeyId);
    expect(primary.outputPrefix).toBe("TINK");
    expect(primary.keyBytes.length).toBe(32);
  });
});
