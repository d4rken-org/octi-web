import { describe, expect, it } from "vitest";
import { decodeWifiInfo, receptionBars, receptionLabel } from "./wifi";

describe("WifiInfo decoder", () => {
  it("decodes a connected 5GHz network", () => {
    const info = decodeWifiInfo({
      currentWifi: { ssid: '"HomeNetwork"', reception: 0.75, freqType: "5GHZ" },
    });
    expect(info.currentWifi).toEqual({
      ssid: '"HomeNetwork"',
      reception: 0.75,
      freqType: "5GHZ",
    });
  });

  it("accepts the literal '2.4GHZ' enum value (dot, not underscore)", () => {
    const info = decodeWifiInfo({
      currentWifi: { ssid: '"Slow"', reception: 0.4, freqType: "2.4GHZ" },
    });
    expect(info.currentWifi?.freqType).toBe("2.4GHZ");
  });

  it("decodes a disconnected payload (currentWifi: null)", () => {
    const info = decodeWifiInfo({ currentWifi: null });
    expect(info.currentWifi).toBeNull();
  });

  it("rejects an unknown freqType", () => {
    expect(() =>
      decodeWifiInfo({ currentWifi: { ssid: "x", reception: 0.5, freqType: "6GHZ" } }),
    ).toThrow(/freqType invalid/);
  });

  it("receptionLabel buckets match Android tile text", () => {
    expect(receptionLabel(null)).toBe("N/A");
    expect(receptionLabel(0)).toBe("N/A");
    expect(receptionLabel(0.1)).toBe("Bad reception");
    expect(receptionLabel(0.5)).toBe("Okay reception");
    expect(receptionLabel(0.9)).toBe("Good reception");
  });

  it("receptionBars 0..4", () => {
    expect(receptionBars(null)).toBe(0);
    expect(receptionBars(0)).toBe(0);
    expect(receptionBars(0.1)).toBe(1);
    expect(receptionBars(0.3)).toBe(2);
    expect(receptionBars(0.6)).toBe(3);
    expect(receptionBars(0.8)).toBe(4);
  });
});
