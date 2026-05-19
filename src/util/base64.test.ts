import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "./base64";

describe("bytesToBase64 / base64ToBytes", () => {
  it("round-trips empty", () => {
    expect(bytesToBase64(new Uint8Array())).toBe("");
    expect(base64ToBytes("")).toEqual(new Uint8Array());
  });

  it("round-trips a single byte (forces 2 chars of padding)", () => {
    const bytes = new Uint8Array([0x4d]);
    const b64 = bytesToBase64(bytes);
    expect(b64).toBe("TQ==");
    expect(base64ToBytes(b64)).toEqual(bytes);
  });

  it("round-trips three bytes (no padding)", () => {
    const bytes = new Uint8Array([0x4d, 0x61, 0x6e]); // "Man"
    expect(bytesToBase64(bytes)).toBe("TWFu");
    expect(base64ToBytes("TWFu")).toEqual(bytes);
  });

  it("preserves high-byte (non-ASCII) values across the roundtrip", () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x80, 0x7f, 0xc3, 0xa9]);
    expect(base64ToBytes(bytes64Encode(bytes))).toEqual(bytes);
    function bytes64Encode(b: Uint8Array) {
      return bytesToBase64(b);
    }
  });

  it("round-trips 10 KiB of pseudo-random bytes", () => {
    const bytes = new Uint8Array(10_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 2654435761) & 0xff;
    const roundtripped = base64ToBytes(bytesToBase64(bytes));
    expect(roundtripped).toEqual(bytes);
  });
});
