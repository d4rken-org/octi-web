import { describe, expect, it } from "vitest";
import { batteryPercent, decodePowerInfo } from "./power";

describe("PowerInfo decoder", () => {
  it("decodes the full happy-path payload", () => {
    const wire = {
      status: "CHARGING",
      battery: { level: 75, scale: 100, health: 2, temp: 28.5 },
      chargeIO: {
        currentNow: 1500000,
        currentAvg: 1200000,
        fullAt: "2026-05-18T14:00:00Z",
      },
    };
    const info = decodePowerInfo(wire);
    expect(info.status).toBe("CHARGING");
    expect(info.battery).toEqual({ level: 75, scale: 100, health: 2, temp: 28.5 });
    expect(info.chargeIO.currentNow).toBe(1500000);
    expect(info.chargeIO.currentAvg).toBe(1200000);
    expect(info.chargeIO.fullAt).toBe("2026-05-18T14:00:00Z");
    expect(info.chargeIO.fullSince).toBeNull();
    expect(info.chargeIO.emptyAt).toBeNull();
  });

  it("accepts missing optional battery + chargeIO fields", () => {
    const info = decodePowerInfo({
      status: "DISCHARGING",
      battery: { level: 42, scale: 100 },
      chargeIO: {},
    });
    expect(info.battery.health).toBeNull();
    expect(info.battery.temp).toBeNull();
    expect(info.chargeIO.currentNow).toBeNull();
  });

  it("ignores unknown extra keys (forward-compat with new Android fields)", () => {
    const info = decodePowerInfo({
      status: "FULL",
      battery: { level: 100, scale: 100, futureKey: "x" },
      chargeIO: { somethingNew: 42 },
      topLevelExtra: true,
    });
    expect(info.status).toBe("FULL");
    expect(info.battery.level).toBe(100);
  });

  it("rejects an unknown status enum value", () => {
    expect(() =>
      decodePowerInfo({
        status: "BANANA",
        battery: { level: 50, scale: 100 },
        chargeIO: {},
      }),
    ).toThrow(/status invalid/);
  });

  it("rejects missing required fields", () => {
    expect(() => decodePowerInfo({ status: "FULL", chargeIO: {} })).toThrow();
    expect(() => decodePowerInfo({ status: "FULL", battery: {}, chargeIO: {} })).toThrow();
  });

  it("batteryPercent guards scale<=0 (Android -1 fallback)", () => {
    expect(batteryPercent({ level: 50, scale: 100 })).toBe(50);
    expect(batteryPercent({ level: 50, scale: 0 })).toBeNull();
    expect(batteryPercent({ level: 50, scale: -1 })).toBeNull();
    expect(batteryPercent({ level: 0, scale: 100 })).toBe(0);
  });
});
