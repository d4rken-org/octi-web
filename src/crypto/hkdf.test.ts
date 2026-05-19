import { describe, expect, it } from "vitest";
import { deriveBlobIkm, hkdfSha256 } from "./hkdf";

// RFC 5869 — HMAC-based Extract-and-Expand Key Derivation Function.
// Vectors below are appendix A test cases for HMAC-SHA-256, copied verbatim from
// https://datatracker.ietf.org/doc/html/rfc5869#appendix-A. Any drift here means
// our blob-IKM derivation is producing keys that don't match Android, which
// silently breaks peer file decryption.
function hex(s: string): Uint8Array {
  const clean = s.replace(/\s/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("hkdfSha256", () => {
  it("matches RFC 5869 Test Case 1 (basic, 22-byte IKM)", async () => {
    const okm = await hkdfSha256(
      hex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"),
      hex("000102030405060708090a0b0c"),
      hex("f0f1f2f3f4f5f6f7f8f9"),
      42,
    );
    expect(toHex(okm)).toBe(
      "3cb25f25faacd57a90434f64d0362f2a" +
        "2d2d0a90cf1a5a4c5db02d56ecc4c5bf" +
        "34007208d5b887185865",
    );
  });

  it("matches RFC 5869 Test Case 2 (longer inputs, 80-byte IKM/salt/info)", async () => {
    const ikm =
      "000102030405060708090a0b0c0d0e0f" +
      "101112131415161718191a1b1c1d1e1f" +
      "202122232425262728292a2b2c2d2e2f" +
      "303132333435363738393a3b3c3d3e3f" +
      "404142434445464748494a4b4c4d4e4f";
    const salt =
      "606162636465666768696a6b6c6d6e6f" +
      "707172737475767778797a7b7c7d7e7f" +
      "808182838485868788898a8b8c8d8e8f" +
      "909192939495969798999a9b9c9d9e9f" +
      "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf";
    const info =
      "b0b1b2b3b4b5b6b7b8b9babbbcbdbebf" +
      "c0c1c2c3c4c5c6c7c8c9cacbcccdcecf" +
      "d0d1d2d3d4d5d6d7d8d9dadbdcdddedf" +
      "e0e1e2e3e4e5e6e7e8e9eaebecedeeef" +
      "f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff";
    const okm = await hkdfSha256(hex(ikm), hex(salt), hex(info), 82);
    expect(toHex(okm)).toBe(
      "b11e398dc80327a1c8e7f78c596a4934" +
        "4f012eda2d4efad8a050cc4c19afa97c" +
        "59045a99cac7827271cb41c65e590e09" +
        "da3275600c2f09b8367793a9aca3db71" +
        "cc30c58179ec3e87c14c01d5c1f3434f" +
        "1d87",
    );
  });

  it("matches RFC 5869 Test Case 3 (empty salt + empty info)", async () => {
    const okm = await hkdfSha256(
      hex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"),
      new Uint8Array(),
      new Uint8Array(),
      42,
    );
    expect(toHex(okm)).toBe(
      "8da4e775a563c18f715f802a063c5a31" +
        "b8a11f5c5ee1879ec3454e5f3c738d2d" +
        "9d201395faa4b61a96c8",
    );
  });
});

describe("deriveBlobIkm", () => {
  it("derives a 32-byte IKM from a Tink keyset using the octi-blob salt+info", async () => {
    const keysetBytes = hex(
      "08bbd0f4cd0312540a4854797065" +
        "2e676f6f676c65617069732e636f6d2f676f6f676c652e63727970746f2e74696e6b" +
        "2e4165733235365f47636d5f5369764b657912061220ffeeddccbbaa99887766" +
        "55443322110018102001",
    );
    const ikm = await deriveBlobIkm(keysetBytes);
    expect(ikm.length).toBe(32);
    // Determinism: same input → same output.
    const again = await deriveBlobIkm(keysetBytes);
    expect(toHex(again)).toBe(toHex(ikm));
  });

  it("derives different IKMs for different keyset bytes", async () => {
    const a = await deriveBlobIkm(hex("0102030405060708"));
    const b = await deriveBlobIkm(hex("0102030405060709"));
    expect(toHex(a)).not.toBe(toHex(b));
  });
});
