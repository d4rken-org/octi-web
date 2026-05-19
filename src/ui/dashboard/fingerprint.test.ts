import { describe, expect, it } from "vitest";
import { bytesToHex, formatFingerprint } from "./fingerprint";

describe("formatFingerprint", () => {
  it("groups a 64-char hex digest into 16 4-char groups", () => {
    const hex = "0123456789abcdef".repeat(4); // 64 chars
    const out = formatFingerprint(hex);
    expect(out).toBe("0123 4567 89ab cdef 0123 4567 89ab cdef 0123 4567 89ab cdef 0123 4567 89ab cdef");
  });

  it("returns empty string for empty input (no separators around nothing)", () => {
    expect(formatFingerprint("")).toBe("");
  });

  it("handles input shorter than one group", () => {
    expect(formatFingerprint("ab")).toBe("ab");
  });

  it("handles input exactly one group long", () => {
    expect(formatFingerprint("abcd")).toBe("abcd");
  });

  it("throws on odd-length input (digests are always even)", () => {
    expect(() => formatFingerprint("abc")).toThrow(/even/);
  });

  it("throws on non-hex input", () => {
    expect(() => formatFingerprint("ZZZZ")).toThrow(/lowercase hex/);
    expect(() => formatFingerprint("ABCD")).toThrow(/lowercase hex/);
  });
});

describe("bytesToHex", () => {
  it("encodes each byte as two lowercase hex chars", () => {
    expect(bytesToHex(new Uint8Array([0, 1, 16, 255]))).toBe("00011 0ff".replace(/\s/g, ""));
    expect(bytesToHex(new Uint8Array([0, 1, 16, 255]))).toBe("000110ff");
  });

  it("encodes an empty array as empty string", () => {
    expect(bytesToHex(new Uint8Array(0))).toBe("");
  });

  it("preserves byteOffset (handles subarrays correctly)", () => {
    const full = new Uint8Array([1, 2, 3, 4, 5]);
    const slice = full.subarray(2, 4); // [3, 4]
    expect(bytesToHex(slice)).toBe("0304");
  });
});
