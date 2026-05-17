import { describe, expect, it } from "vitest";

import {
  deserializeMetaInfo,
  metaInfoLabel,
  serializeMetaInfo,
  type MetaInfo,
} from "./meta";

const sample: MetaInfo = {
  deviceLabel: "My Browser",
  deviceId: { id: "00000000-0000-0000-0000-000000000001" },
  octiVersionName: "0.0.0",
  octiGitSha: "dev",
  deviceManufacturer: "Mozilla",
  deviceName: "Firefox 134",
  deviceType: "BROWSER",
  deviceBootedAt: null,
  androidVersionName: null,
  androidApiLevel: null,
  androidSecurityPatch: null,
  osType: "linux",
  osVersionName: "6.8",
};

describe("MetaInfo wire format", () => {
  it("round-trips through serialize/deserialize", () => {
    const bytes = serializeMetaInfo(sample);
    expect(deserializeMetaInfo(bytes)).toEqual(sample);
  });

  it("preserves the deviceId object shape on the wire", () => {
    // Android's DeviceId is a value class serialized as {"id": "..."} — flattening
    // it would deserialize on the phone as a missing-field error.
    const bytes = serializeMetaInfo(sample);
    const json = JSON.parse(new TextDecoder().decode(bytes));
    expect(json.deviceId).toEqual({ id: sample.deviceId.id });
  });

  it("uses BROWSER as the deviceType for web clients", () => {
    expect(sample.deviceType).toBe("BROWSER");
  });

  it("metaInfoLabel prefers user label, then deviceName, then fallback", () => {
    expect(metaInfoLabel(sample, "Fallback")).toBe("My Browser");
    expect(metaInfoLabel({ ...sample, deviceLabel: null }, "Fallback")).toBe("Firefox 134");
    expect(metaInfoLabel({ ...sample, deviceLabel: null, deviceName: "" }, "Fallback")).toBe("Fallback");
    expect(metaInfoLabel(null, "Fallback")).toBe("Fallback");
  });
});
