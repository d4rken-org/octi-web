import type {
  AccountCreateResponse,
  DeviceListResponse,
  DeviceMetadata,
  ServerAddress,
  ShareCodeResponse,
} from "./models";
import { serverBaseUrl } from "./models";
import { OCTI_WEB_VERSION } from "../version";

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

/**
 * Per-device capability tags we declare to the server / peers. Format and rules
 * mirror `Capability` / `CapabilitiesCodec` in the Android client (octi#309) and
 * `parseCapabilitiesHeader` in the sync-server (octi-server#23): each tag is
 * `<namespace>:<value>`, the `<namespace>:_reported` marker says "this device
 * authoritatively reports its capabilities in this namespace" (a peer that
 * omits it falls back to the per-platform grace heuristic), and the array is
 * canonically sorted on the wire.
 *
 * For octi-web we only ship AES-256-GCM-SIV — everything else is unsupported
 * and we declare so explicitly. Once the server PR lands and Android peers see
 * our authoritative tag set, the "Incompatible encryption" / "Outdated version"
 * false positives on web peer cards stop firing regardless of app version.
 *
 * Forward compatibility: the header is silently dropped by servers that pre-date
 * octi-server#23, so it's safe to send unconditionally.
 */
export const OCTI_WEB_CAPABILITIES: readonly string[] = Object.freeze(
  ["encryption:AES256_GCM_SIV", "encryption:_reported"].sort(),
);

/** Serialized form sent in the `Octi-Device-Capabilities` HTTP header. */
export const OCTI_WEB_CAPABILITIES_HEADER = JSON.stringify(OCTI_WEB_CAPABILITIES);

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

/**
 * Headers sent on every Octi API call. Mirrors Android's `DeviceHeaderInterceptor`
 * + `BasicAuthInterceptor`: the server uses `Octi-Device-Version` (line ~110 of
 * HttpExtensions.kt) to refresh the stored device record on every authed touch,
 * so omitting it on routine calls leaves the server with a stale version and
 * trips the "Incompatible encryption" / "Outdated version" checks on peer
 * clients. Label is only sent when given (it's user-controlled, so we don't
 * want to clobber a server-side change on every routine read).
 */
function deviceHeaders(deviceId: string, tag: DeviceTag | null): HeadersInit {
  const h: Record<string, string> = {
    "X-Device-ID": deviceId,
    "Octi-Device-Platform": PLATFORM,
    "Octi-Device-Version": tag?.version ?? OCTI_WEB_VERSION,
    "Octi-Device-Capabilities": OCTI_WEB_CAPABILITIES_HEADER,
  };
  if (tag?.label) {
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

function moduleUrl(server: ServerAddress, moduleId: string, targetDeviceId: string): string {
  return `${serverBaseUrl(server)}/v1/module/${encodeURIComponent(moduleId)}?device-id=${encodeURIComponent(targetDeviceId)}`;
}

/**
 * {@code GET /v1/module/{moduleId}?device-id={target}} (authed). Returns the
 * raw encrypted module payload bytes, or `null` if the server has no payload
 * yet for that target device + module pair (HTTP 204 / empty body).
 *
 * The caller is responsible for decrypting + gunzipping the bytes. See
 * {@link decryptModulePayload}.
 */
export async function readModulePayload(args: {
  server: ServerAddress;
  creds: AuthCreds;
  targetDeviceId: string;
  moduleId: string;
}): Promise<Uint8Array | null> {
  const result = await readModulePayloadWithEtag(args);
  return result?.bytes ?? null;
}

/**
 * As {@link readModulePayload} but also returns the strong ETag the server
 * advertised. Used by callers that intend to {@link commitModule} an updated
 * version of this module — they pass the etag back in `If-Match`.
 */
export async function readModulePayloadWithEtag(args: {
  server: ServerAddress;
  creds: AuthCreds;
  targetDeviceId: string;
  moduleId: string;
}): Promise<{ bytes: Uint8Array; etag: string | null } | null> {
  const url = moduleUrl(args.server, args.moduleId, args.targetDeviceId);
  const res = await fetch(url, {
    method: "GET",
    headers: {
      ...deviceHeaders(args.creds.deviceId, null),
      Authorization: basicAuthHeader(args.creds.accountId, args.creds.devicePassword),
    },
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    throw new OctiApiError(res.status, `module/${args.moduleId}`, await res.text().catch(() => ""));
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0) return null;
  return { bytes: new Uint8Array(buf), etag: res.headers.get("ETag") };
}

/**
 * {@code PUT /v1/module/{moduleId}?device-id={target}} (authed, blob-aware commit).
 *
 * This is the modern write path: the server atomically installs the encrypted
 * document AND links it to a list of finalized blobs (`blobRefs`). For modules
 * that reference uploaded blobs (FileShare), this is the only correct write —
 * the legacy `POST` doesn't link blobs, so referenced blobs age out after the
 * complete-state TTL (10 min default) and downloads return 404.
 *
 * Precondition headers:
 *   - First write for this module instance: pass `ifNoneMatchStar: true`
 *     → server sends `If-None-Match: *` semantics, rejects with 412 if a
 *       module already exists.
 *   - Updating an existing module: pass `ifMatch: <etag>` from the read
 *     response → server returns 412 if anyone else committed in the meantime.
 *
 * Returns the server's new ETag so the caller can stash it for subsequent
 * commits.
 */
export async function commitModule(args: {
  server: ServerAddress;
  creds: AuthCreds;
  targetDeviceId: string;
  moduleId: string;
  documentBytes: Uint8Array;
  blobIds: string[];
  ifMatch?: string;
  ifNoneMatchStar?: boolean;
}): Promise<{ etag: string }> {
  if ((args.ifMatch && args.ifNoneMatchStar) || (!args.ifMatch && !args.ifNoneMatchStar)) {
    throw new Error("commitModule: pass exactly one of ifMatch or ifNoneMatchStar");
  }
  const headers: Record<string, string> = {
    ...(deviceHeaders(args.creds.deviceId, null) as Record<string, string>),
    Authorization: basicAuthHeader(args.creds.accountId, args.creds.devicePassword),
    "Content-Type": "application/json",
  };
  if (args.ifMatch) {
    headers["If-Match"] = args.ifMatch;
  } else if (args.ifNoneMatchStar) {
    headers["If-None-Match"] = "*";
  }
  const body = JSON.stringify({
    documentBase64: bytesToBase64(args.documentBytes),
    blobRefs: args.blobIds.map((blobId) => ({ blobId })),
  });
  const res = await fetch(moduleUrl(args.server, args.moduleId, args.targetDeviceId), {
    method: "PUT",
    headers,
    body,
  });
  if (!res.ok) {
    throw new OctiApiError(res.status, `module/${args.moduleId} (PUT)`, await res.text().catch(() => ""));
  }
  const parsed = (await res.json()) as { etag: string };
  return { etag: parsed.etag };
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/**
 * {@code POST /v1/module/{moduleId}?device-id={target}} (authed, legacy write).
 * Body is the already-encrypted payload bytes. For our own writes,
 * `targetDeviceId === creds.deviceId`. Writing to another device's slot is
 * supported by the server but we never do it from the web client.
 *
 * This is the pre-blob legacy POST path — sufficient for small payloads
 * (MetaInfo, ClipboardInfo). The {@code PUT} commit + blob-session flow is
 * only needed for file shares (M6).
 */
export async function writeModulePayload(args: {
  server: ServerAddress;
  creds: AuthCreds;
  targetDeviceId: string;
  moduleId: string;
  ciphertext: Uint8Array;
  /**
   * Optional device meta tag forwarded as headers on this authed write. When
   * present, the server updates its stored {@link DeviceMetadata} (label +
   * version + lastSeen) alongside the encrypted module payload — without it,
   * a label change in {@link publishOwnMetaInfo} would only reach peers who
   * decrypt the new MetaInfo, while peers reading the device-list response
   * would still see the old label.
   */
  deviceTag?: DeviceTag;
}): Promise<void> {
  const url = moduleUrl(args.server, args.moduleId, args.targetDeviceId);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...deviceHeaders(args.creds.deviceId, args.deviceTag ?? null),
      Authorization: basicAuthHeader(args.creds.accountId, args.creds.devicePassword),
      "Content-Type": "application/octet-stream",
    },
    body: args.ciphertext,
  });
  if (!res.ok) {
    throw new OctiApiError(res.status, `module/${args.moduleId}`, await res.text().catch(() => ""));
  }
}
