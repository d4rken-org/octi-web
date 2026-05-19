import { describe, expect, it } from "vitest";
import { connectionTypeLabel, decodeConnectivityInfo } from "./connectivity";

describe("ConnectivityInfo decoder", () => {
  it("decodes a full Wi-Fi connection", () => {
    const info = decodeConnectivityInfo({
      connectionType: "WIFI",
      publicIp: "203.0.113.42",
      localAddressIpv4: "192.168.1.100",
      localAddressIpv6: "2001:db8::1",
      gatewayIp: "192.168.1.1",
      dnsServers: ["8.8.8.8", "1.1.1.1"],
    });
    expect(info.connectionType).toBe("WIFI");
    expect(info.dnsServers).toEqual(["8.8.8.8", "1.1.1.1"]);
  });

  it("accepts a fully empty payload (peer reports nothing yet)", () => {
    const info = decodeConnectivityInfo({});
    expect(info.connectionType).toBeNull();
    expect(info.publicIp).toBeNull();
    expect(info.dnsServers).toBeNull();
  });

  it("rejects an unknown connectionType", () => {
    expect(() => decodeConnectivityInfo({ connectionType: "5G" })).toThrow(/connectionType invalid/);
  });

  it("rejects a non-array dnsServers", () => {
    expect(() => decodeConnectivityInfo({ dnsServers: "8.8.8.8" })).toThrow(/dnsServers is not an array/);
  });

  it("connectionTypeLabel maps each enum + handles null", () => {
    expect(connectionTypeLabel("WIFI")).toBe("WiFi");
    expect(connectionTypeLabel("CELLULAR")).toBe("Cellular");
    expect(connectionTypeLabel("ETHERNET")).toBe("Ethernet");
    expect(connectionTypeLabel("NONE")).toBe("None");
    expect(connectionTypeLabel(null)).toBe("Unknown");
  });
});
