/**
 * TypeScript mirrors of the wire shapes the Android client serialises to/from
 * the sync-server. Field names match the JSON keys produced by
 * `kotlinx.serialization` — preserve the `@SerialName` overrides exactly (esp.
 * the `serverAdress` typo, which is load-bearing in `Credentials` but spelled
 * correctly in `LinkingData`).
 */

/** {@code eu.darken.octi.syncs.octiserver.core.OctiServer.Address} */
export interface ServerAddress {
  domain: string;
  protocol: "http" | "https";
  port: number;
}

/** Reconstruct the base URL the server is reachable at. */
export function serverBaseUrl(address: ServerAddress): string {
  return `${address.protocol}://${address.domain}:${address.port}`;
}

/**
 * Official sync-server addresses, mirroring
 * {@code eu.darken.octi.syncs.octiserver.core.OctiServer.Official}.
 */
export const OFFICIAL_SERVERS: Record<"PROD" | "BETA", ServerAddress> = {
  PROD: { domain: "prod.kserver.octi.darken.eu", protocol: "https", port: 443 },
  BETA: { domain: "beta.kserver.octi.darken.eu", protocol: "https", port: 443 },
};

/** Response from {@code POST /v1/account}. */
export interface AccountCreateResponse {
  accountID: string;
  password: string;
}

/** Response from {@code POST /v1/account/share}. */
export interface ShareCodeResponse {
  code: string;
}

/** Single entry returned by {@code GET /v1/devices}. */
export interface DeviceMetadata {
  id: string;
  version: string | null;
  platform: string | null;
  label: string | null;
  /** ISO-8601 timestamp. */
  addedAt: string | null;
  /** ISO-8601 timestamp. */
  lastSeen: string | null;
}

export interface DeviceListResponse {
  devices: DeviceMetadata[];
}
