import { describe, expect, it } from "vitest";

import {
  deserializeMetaInfo,
  metaInfoLabel,
  serializeMetaInfo,
  type MetaInfo,
} from "./meta";

// Wire shape after null-stripping serialize: optional fields with no value are
// absent from the JSON, not present as null. Keeps Android's strict decoder
// happy for fields with non-nullable custom serializers (e.g. deviceBootedAt
// via InstantSerializer).
const sample: MetaInfo = {
  deviceLabel: "My Browser",
  deviceId: { id: "00000000-0000-0000-0000-000000000001" },
  octiVersionName: "1.0.0",
  octiGitSha: "dev",
  deviceManufacturer: "Mozilla",
  deviceName: "Firefox 134",
  deviceType: "BROWSER",
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

  it("uses BROWSER as deviceType", () => {
    // Android added BROWSER + a fallback DeviceTypeSerializer in a44fc7a, so
    // older clients fall back to UNKNOWN instead of strict-failing.
    expect(sample.deviceType).toBe("BROWSER");
  });

  it("drops null-valued fields on the wire (Android strict-decoder compat)", () => {
    const withNulls: MetaInfo = {
      ...sample,
      deviceBootedAt: null,
      androidVersionName: null,
      androidApiLevel: null,
    };
    const json = JSON.parse(new TextDecoder().decode(serializeMetaInfo(withNulls)));
    expect("deviceBootedAt" in json).toBe(false);
    expect("androidVersionName" in json).toBe(false);
    expect("androidApiLevel" in json).toBe(false);
    expect(json.osType).toBe("linux");
  });

  it("metaInfoLabel prefers user label, then deviceName, then fallback", () => {
    expect(metaInfoLabel(sample, "Fallback")).toBe("My Browser");
    expect(metaInfoLabel({ ...sample, deviceLabel: null }, "Fallback")).toBe("Firefox 134");
    expect(metaInfoLabel({ ...sample, deviceLabel: null, deviceName: "" }, "Fallback")).toBe("Fallback");
    expect(metaInfoLabel(null, "Fallback")).toBe("Fallback");
  });
});
