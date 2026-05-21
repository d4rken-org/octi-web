/**
 * Verify octi-web's MetaInfo decoder can consume what octi-desktop publishes.
 *
 * Loads `octi-desktop-meta.json` from `.cache/interop-fixtures/d4rken-org/octi-desktop/<ref>/`,
 * parses each `payloadJson` through the production `deserializeMetaInfo`, and asserts
 * field-level values match the canonical inputs in octi-desktop's `InteropFixtureGenerator.kt`.
 *
 * Sister tests: app-main's `DesktopMetaInteropTest` and octi-desktop's own
 * `InteropFixtureSelfVerifyTest`. Same producer, three independent consumers.
 */
import { describe, expect, it } from "vitest";

import {
  type InteropPublishedModuleFixture,
  type InteropPublishedVector,
  loadInteropJson,
  verifyVectorIntegrity,
} from "./fixture-loader";
import { deserializeMetaInfo, META_MODULE_ID } from "../modules/meta";

const SOURCE = "d4rken-org/octi-desktop";
const FIXTURE_FILE = "octi-desktop-meta.json";
const FAUX_DEVICE_ID = "22222222-3333-4444-5555-666666666666";

const fixture = loadInteropJson<InteropPublishedModuleFixture>(FIXTURE_FILE, SOURCE);

function vector(name: string): InteropPublishedVector {
  const v = fixture.vectors.find((x) => x.name === name);
  if (!v) throw new Error(`vector '${name}' missing in ${fixture.module}`);
  // Re-verify the per-vector sha256 + byteLength against payloadJson. The producer's
  // self-check pins these at generate time; we re-check on read so a hand-edit to one
  // of these files fails here, not as a green decode.
  verifyVectorIntegrity(v);
  return v;
}

function decode(v: InteropPublishedVector) {
  return deserializeMetaInfo(new TextEncoder().encode(v.payloadJson));
}

describe("desktop meta interop", () => {
  it("fixture schema sanity", () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.module).toBe(META_MODULE_ID);
    expect(fixture.producer).toBe(SOURCE);
    expect(fixture.vectors.map((v) => v.name)).toEqual([
      "full",
      "minimal",
      "unicode-label",
    ]);
  });

  it("'full' vector decodes to expected MetaInfo", () => {
    const info = decode(vector("full"));
    expect(info.deviceLabel).toBe("Test Desktop");
    expect(info.deviceId.id).toBe(FAUX_DEVICE_ID);
    expect(info.octiVersionName).toBe("0.0.0-test");
    expect(info.octiGitSha).toBe("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(info.deviceManufacturer).toBe("Eclipse Adoptium");
    expect(info.deviceName).toBe("octi-test-host");
    expect(info.deviceType).toBe("DESKTOP");
    // Desktop's MetaWriter calls ProcessHandle.startInstant() — emits a real ISO 8601
    // Instant on the wire, never null (unlike web).
    expect(info.deviceBootedAt).toBe("2026-05-01T10:00:00Z");
    expect(info.androidVersionName).toBeUndefined();
    expect(info.androidApiLevel).toBeUndefined();
    expect(info.androidSecurityPatch).toBeUndefined();
    expect(info.osType).toBe("Linux");
    expect(info.osVersionName).toBe("6.8.0");
  });

  it("'minimal' vector omits deviceBootedAt on the wire", () => {
    // Schema-shape vector. The pinned `minimal` payload omits `deviceBootedAt` entirely
    // (explicitNulls=false strips the field on the producer side). Real desktop writer
    // always emits a non-null Instant — this vector is forward-compat for the absence
    // rather than a production-output snapshot.
    const v = vector("minimal");
    expect(v.payloadJson.includes("deviceBootedAt")).toBe(false);

    const info = decode(v);
    expect(info.deviceLabel).toBeUndefined();
    expect(info.deviceId.id).toBe(FAUX_DEVICE_ID);
    expect(info.octiVersionName).toBe("0.0.0-test");
    expect(info.octiGitSha).toBe("desktop-dev");
    expect(info.deviceManufacturer).toBe("Eclipse Adoptium");
    expect(info.deviceName).toBe("octi-desktop");
    expect(info.deviceType).toBe("DESKTOP");
    expect(info.deviceBootedAt).toBeUndefined();
    expect(info.osType).toBeUndefined();
    expect(info.osVersionName).toBeUndefined();
  });

  it("'unicode-label' vector decodes every field including non-ASCII deviceLabel", () => {
    const info = decode(vector("unicode-label"));
    // Japanese katakana + emoji + Arabic — UTF-8 round-trip across the JSON-string
    // escape boundary.
    expect(info.deviceLabel).toBe("デスクトップ 🖥 العربية");
    expect(info.deviceId.id).toBe(FAUX_DEVICE_ID);
    expect(info.octiVersionName).toBe("0.0.0-test");
    expect(info.octiGitSha).toBe("desktop-dev");
    expect(info.deviceManufacturer).toBe("Eclipse Adoptium");
    expect(info.deviceName).toBe("octi-desktop");
    expect(info.deviceType).toBe("DESKTOP");
    expect(info.deviceBootedAt).toBe("2026-05-01T10:00:00Z");
    expect(info.osType).toBe("Linux");
    expect(info.osVersionName).toBeUndefined();
  });
});
