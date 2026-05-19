/**
 * TS mirror of {@code eu.darken.octi.modules.connectivity.core.ConnectivityInfo}.
 * Wire shape is kotlinx.serialization JSON; web is read-only.
 */
export const CONNECTIVITY_MODULE_ID = "eu.darken.octi.module.core.connectivity";

export type ConnectionType = "WIFI" | "CELLULAR" | "ETHERNET" | "NONE";
const CONNECTION_TYPES: ReadonlySet<ConnectionType> = new Set([
  "WIFI",
  "CELLULAR",
  "ETHERNET",
  "NONE",
]);

export interface ConnectivityInfo {
  connectionType?: ConnectionType | null;
  publicIp?: string | null;
  localAddressIpv4?: string | null;
  localAddressIpv6?: string | null;
  gatewayIp?: string | null;
  dnsServers?: string[] | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function decodeConnectivityInfo(raw: unknown): ConnectivityInfo {
  if (!isRecord(raw)) throw new Error("ConnectivityInfo root is not an object");
  let connectionType: ConnectionType | null = null;
  if (raw.connectionType != null) {
    const v = String(raw.connectionType);
    if (!CONNECTION_TYPES.has(v as ConnectionType)) {
      throw new Error(`ConnectivityInfo.connectionType invalid: ${v}`);
    }
    connectionType = v as ConnectionType;
  }
  let dnsServers: string[] | null = null;
  if (raw.dnsServers != null) {
    if (!Array.isArray(raw.dnsServers)) {
      throw new Error("ConnectivityInfo.dnsServers is not an array");
    }
    dnsServers = raw.dnsServers.map((v) => String(v));
  }
  return {
    connectionType,
    publicIp: raw.publicIp == null ? null : String(raw.publicIp),
    localAddressIpv4: raw.localAddressIpv4 == null ? null : String(raw.localAddressIpv4),
    localAddressIpv6: raw.localAddressIpv6 == null ? null : String(raw.localAddressIpv6),
    gatewayIp: raw.gatewayIp == null ? null : String(raw.gatewayIp),
    dnsServers,
  };
}

export function connectionTypeLabel(t: ConnectionType | null | undefined): string {
  switch (t) {
    case "WIFI":
      return "WiFi";
    case "CELLULAR":
      return "Cellular";
    case "ETHERNET":
      return "Ethernet";
    case "NONE":
      return "None";
    default:
      return "Unknown";
  }
}
