import type {
  AccountCreateResponse,
  DeviceListResponse,
  DeviceMetadata,
  ServerAddress,
  ShareCodeResponse,
} from "./models";
import { serverBaseUrl } from "./models";

/**
 * Thin typed wrappers over the sync-server REST API. Header conventions match
 * the Android client's {@code OctiServerApi} / interceptors:
 *
 * - {@code Authorization: Basic base64(accountId:devicePassword)}
 * - {@code X-Device-ID: <uuid>}
 * - {@code Octi-Device-Version}, {@code Octi-Device-Platform},
 *   {@code Octi-Device-Label} for device meta tagging at registration
 */

const PLATFORM = "web";

export interface DeviceTag {
  /** App version string. Used for `Octi-Device-Version` header. */
  version: string;
  /** User-supplied device label. Used for `Octi-Device-Label`. */
  label: string;
}

export interface AuthCreds {
  accountId: string;
  devicePassword: string;
  deviceId: string;
}

export class OctiApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`Octi API ${path} → ${status}: ${body.slice(0, 200)}`);
    this.name = "OctiApiError";
  }
}

function deviceHeaders(deviceId: string, tag: DeviceTag | null): HeadersInit {
  const h: Record<string, string> = {
    "X-Device-ID": deviceId,
    "Octi-Device-Platform": PLATFORM,
  };
  if (tag) {
    h["Octi-Device-Version"] = tag.version;
    h["Octi-Device-Label"] = tag.label;
  }
  return h;
}

function basicAuthHeader(accountId: string, devicePassword: string): string {
  return `Basic ${btoa(`${accountId}:${devicePassword}`)}`;
}

async function postJson<T>(
  server: ServerAddress,
  path: string,
  headers: HeadersInit,
  body?: BodyInit | null,
): Promise<T> {
  const url = `${serverBaseUrl(server)}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: body ?? null,
  });
  if (!res.ok) {
    throw new OctiApiError(res.status, path, await res.text().catch(() => ""));
  }
  // Account/share endpoints always return JSON; the body is small.
  return (await res.json()) as T;
}

/**
 * {@code POST /v1/account} (no auth). Server assigns the accountID + password
 * and binds them to the supplied X-Device-ID. Optional `shareCode` joins an
 * existing account instead of creating a new one.
 */
export async function createOrJoinAccount(args: {
  server: ServerAddress;
  deviceId: string;
  deviceTag: DeviceTag;
  shareCode?: string;
}): Promise<AccountCreateResponse> {
  const query = args.shareCode ? `?share=${encodeURIComponent(args.shareCode)}` : "";
  return postJson<AccountCreateResponse>(
    args.server,
    `/v1/account${query}`,
    deviceHeaders(args.deviceId, args.deviceTag),
  );
}

/**
 * {@code POST /v1/account/share} (authed). Mints a short-lived (~60 min)
 * share code another device can pass to {@link createOrJoinAccount} to join.
 */
export async function createShareCode(args: {
  server: ServerAddress;
  creds: AuthCreds;
}): Promise<ShareCodeResponse> {
  return postJson<ShareCodeResponse>(args.server, "/v1/account/share", {
    ...deviceHeaders(args.creds.deviceId, null),
    Authorization: basicAuthHeader(args.creds.accountId, args.creds.devicePassword),
  });
}

/**
 * {@code GET /v1/devices} (authed). Returns every device on the account
 * — including the caller. Use the caller's own deviceId to filter.
 */
export async function listDevices(args: {
  server: ServerAddress;
  creds: AuthCreds;
}): Promise<DeviceMetadata[]> {
  const url = `${serverBaseUrl(args.server)}/v1/devices`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      ...deviceHeaders(args.creds.deviceId, null),
      Authorization: basicAuthHeader(args.creds.accountId, args.creds.devicePassword),
    },
  });
  if (!res.ok) {
    throw new OctiApiError(res.status, "/v1/devices", await res.text().catch(() => ""));
  }
  const body = (await res.json()) as DeviceListResponse;
  return body.devices;
}
