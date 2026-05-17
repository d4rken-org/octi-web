import { describe, expect, it } from "vitest";

import {
  CLIPBOARD_MAX_BYTES,
  clipboardText,
  deserializeClipboardInfo,
  emptyClipboard,
  serializeClipboardInfo,
  textClipboard,
  type ClipboardInfo,
} from "./clipboard";

describe("ClipboardInfo wire format", () => {
  it("round-trips SIMPLE_TEXT through serialize/deserialize", () => {
    const original = textClipboard("Hello clipboard");
    const out = deserializeClipboardInfo(serializeClipboardInfo(original));
    expect(out.type).toBe("SIMPLE_TEXT");
    expect(clipboardText(out)).toBe("Hello clipboard");
  });

  it("round-trips EMPTY through serialize/deserialize", () => {
    const out = deserializeClipboardInfo(serializeClipboardInfo(emptyClipboard()));
    expect(out.type).toBe("EMPTY");
    expect(out.data.byteLength).toBe(0);
  });

  it("encodes data as base64 on the wire (matches Android ByteStringSerializer)", () => {
    const info = textClipboard("hi");
    const json = JSON.parse(new TextDecoder().decode(serializeClipboardInfo(info)));
    expect(json).toEqual({ type: "SIMPLE_TEXT", data: "aGk=" });
  });

  it("preserves non-ASCII UTF-8 bytes", () => {
    const original = textClipboard("café 👋 你好");
    expect(clipboardText(deserializeClipboardInfo(serializeClipboardInfo(original)))).toBe(
      "café 👋 你好",
    );
  });

  it("rejects payloads above the 32 KiB cap", () => {
    expect(() => textClipboard("x".repeat(CLIPBOARD_MAX_BYTES + 1))).toThrow(/too large/i);
  });

  it("serialize also rejects oversize payloads (defensive double-check)", () => {
    const oversize: ClipboardInfo = {
      type: "SIMPLE_TEXT",
      data: new Uint8Array(CLIPBOARD_MAX_BYTES + 1),
    };
    expect(() => serializeClipboardInfo(oversize)).toThrow(/too large/i);
  });

  it("rejects unknown type values on deserialize", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ type: "VIDEO", data: "" }));
    expect(() => deserializeClipboardInfo(bytes)).toThrow(/Unknown ClipboardInfo/);
  });

  it("clipboardText returns empty string for EMPTY type", () => {
    expect(clipboardText(emptyClipboard())).toBe("");
  });
});
