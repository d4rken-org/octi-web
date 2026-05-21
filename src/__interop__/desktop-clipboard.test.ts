/**
 * Verify octi-web's ClipboardInfo decoder can consume what octi-desktop publishes.
 *
 * Pin: type enum + base64-encoded data. Uint8Array equality holds across the encode
 * boundary (desktop emits base64; web's deserializer base64-decodes back to bytes).
 */
import { describe, expect, it } from "vitest";

import {
  type InteropPublishedModuleFixture,
  type InteropPublishedVector,
  loadInteropJson,
  verifyVectorIntegrity,
} from "./fixture-loader";
import { CLIPBOARD_MODULE_ID, deserializeClipboardInfo } from "../modules/clipboard";

const SOURCE = "d4rken-org/octi-desktop";
const FIXTURE_FILE = "octi-desktop-clipboard.json";

const fixture = loadInteropJson<InteropPublishedModuleFixture>(FIXTURE_FILE, SOURCE);

function vector(name: string): InteropPublishedVector {
  const v = fixture.vectors.find((x) => x.name === name);
  if (!v) throw new Error(`vector '${name}' missing in ${fixture.module}`);
  verifyVectorIntegrity(v);
  return v;
}

function decode(v: InteropPublishedVector) {
  return deserializeClipboardInfo(new TextEncoder().encode(v.payloadJson));
}

describe("desktop clipboard interop", () => {
  it("fixture schema sanity", () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.module).toBe(CLIPBOARD_MODULE_ID);
    expect(fixture.producer).toBe(SOURCE);
    expect(fixture.vectors.map((v) => v.name)).toEqual([
      "EMPTY",
      "SIMPLE_TEXT_short",
      "SIMPLE_TEXT_unicode",
    ]);
  });

  it("'EMPTY' vector decodes to empty data", () => {
    const info = decode(vector("EMPTY"));
    expect(info.type).toBe("EMPTY");
    expect(info.data.byteLength).toBe(0);
  });

  it("'SIMPLE_TEXT_short' vector decodes ASCII payload", () => {
    const info = decode(vector("SIMPLE_TEXT_short"));
    expect(info.type).toBe("SIMPLE_TEXT");
    expect(info.data).toEqual(new TextEncoder().encode("hello from desktop"));
  });

  it("'SIMPLE_TEXT_unicode' vector decodes multi-codepoint payload", () => {
    const info = decode(vector("SIMPLE_TEXT_unicode"));
    expect(info.type).toBe("SIMPLE_TEXT");
    expect(info.data).toEqual(new TextEncoder().encode("café 👋 你好 — العربية"));
  });
});
