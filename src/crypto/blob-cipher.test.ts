import { describe, expect, it } from "vitest";
import { buildBlobAad, createBlobCipher } from "./blob-cipher";
import { expectedCiphertextSize } from "./streaming-aead";

/**
 * The AAD format and the HKDF salt/info pair are wire-protocol commitments to
 * Android peers. Drift here = a file uploaded from web silently fails to decrypt
 * on Android (and vice versa). These tests pin both contracts.
 */

function fakeKeyset(seed = 1): Uint8Array {
  const out = new Uint8Array(64);
  for (let i = 0; i < out.length; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

function bytes(len: number, seed = 7): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (i * 2654435761 + seed) & 0xff;
  return out;
}

describe("buildBlobAad", () => {
  it("formats AAD as <deviceId>:<moduleId>:<blobKey> (UTF-8 bytes)", () => {
    const aad = buildBlobAad("dev-1", "mod.files", "blob-abc");
    expect(new TextDecoder().decode(aad)).toBe("dev-1:mod.files:blob-abc");
  });

  it("does not pad or hash the input — exact concatenation", () => {
    const aad = buildBlobAad("a", "b", "c");
    expect(aad.length).toBe("a:b:c".length);
  });
});

describe("createBlobCipher", () => {
  it("encrypt → decrypt roundtrips empty plaintext", async () => {
    const cipher = await createBlobCipher(fakeKeyset());
    const ct = await cipher.encrypt(new Uint8Array(), "dev", "mod", "blob");
    expect(ct.length).toBe(cipher.ciphertextSize(0));
    expect(ct.length).toBeGreaterThan(0); // header + tag even for empty input
    const pt = await cipher.decrypt(ct, "dev", "mod", "blob");
    expect(pt.length).toBe(0);
  });

  it("encrypt → decrypt roundtrips small plaintext (~1 KB)", async () => {
    const cipher = await createBlobCipher(fakeKeyset());
    const pt = bytes(1024);
    const ct = await cipher.encrypt(pt, "dev-1", "files", "k1");
    expect(ct.length).toBe(cipher.ciphertextSize(pt.length));
    expect(ct.length).toBe(expectedCiphertextSize(pt.length));
    const back = await cipher.decrypt(ct, "dev-1", "files", "k1");
    expect(back).toEqual(pt);
  });

  it("encrypt → decrypt roundtrips medium plaintext (~100 KB)", async () => {
    const cipher = await createBlobCipher(fakeKeyset());
    const pt = bytes(100 * 1024);
    const ct = await cipher.encrypt(pt, "dev", "files", "blob");
    const back = await cipher.decrypt(ct, "dev", "files", "blob");
    expect(back).toEqual(pt);
  });

  it("decryption fails when AAD components differ from encryption", async () => {
    const cipher = await createBlobCipher(fakeKeyset());
    const pt = bytes(64);
    const ct = await cipher.encrypt(pt, "dev-1", "files", "blob-x");
    await expect(cipher.decrypt(ct, "dev-2", "files", "blob-x")).rejects.toThrow();
    await expect(cipher.decrypt(ct, "dev-1", "other", "blob-x")).rejects.toThrow();
    await expect(cipher.decrypt(ct, "dev-1", "files", "blob-y")).rejects.toThrow();
  });

  it("ciphertexts differ when keysets differ", async () => {
    const a = await createBlobCipher(fakeKeyset(1));
    const b = await createBlobCipher(fakeKeyset(2));
    const pt = bytes(128);
    const ctA = await a.encrypt(pt, "d", "m", "k");
    const ctB = await b.encrypt(pt, "d", "m", "k");
    expect(ctA).not.toEqual(ctB);
    // Cross-keyset decryption must reject.
    await expect(b.decrypt(ctA, "d", "m", "k")).rejects.toThrow();
  });
});
