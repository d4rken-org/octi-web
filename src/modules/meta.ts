import { buildAssociatedData, type PayloadEncryption } from "../crypto/payload";
import {
  type AuthCreds,
  readModulePayload,
  writeModulePayload,
} from "../protocol/octi-api";
import type { ServerAddress } from "../protocol/models";
import type { CredentialRecord } from "../storage/credentials-repo";
import { detectBrowserInfo } from "../util/browser-detect";
import { OCTI_WEB_GIT_SHA, OCTI_WEB_VERSION } from "../version";

/**
 * TS mirror of {@code eu.darken.octi.modules.meta.core.MetaInfo}. Wire shape is
 * kotlinx.serialization JSON — preserve every {@code @SerialName}. The wrapped
 * `deviceId` object matches Android's {@code DeviceId} value class ({@code {"id": "..."}}).
 *
 * Module ID and DeviceType enum constants come from {@code MetaModule.MODULE_ID}
 * and {@code MetaInfo.DeviceType} respectively. {@code BROWSER} was added in
 * d4rken-org/octi#306 specifically for us.
 */
export const META_MODULE_ID = "eu.darken.octi.module.core.meta";

export type DeviceType = "PHONE" | "TABLET" | "DESKTOP" | "BROWSER" | "UNKNOWN";

export interface MetaInfo {
  deviceLabel: string | null;
  deviceId: { id: string };
  octiVersionName: string;
  octiGitSha: string;
  deviceManufacturer: string;
  deviceName: string;
  deviceType: DeviceType;
  deviceBootedAt?: string | null; // ISO 8601 instant
  androidVersionName?: string | null;
  androidApiLevel?: number | null;
  androidSecurityPatch?: string | null;
  osType?: string | null;
  osVersionName?: string | null;
}

export function serializeMetaInfo(info: MetaInfo): Uint8Array {
  // Drop null-valued fields so they're absent on the wire. Android's
  // kotlinx.serialization config doesn't set `coerceInputValues = true`, so
  // explicit nulls trip the strict decoder for fields with non-nullable custom
  // serializers (notably `deviceBootedAt: Instant?` via InstantSerializer).
  // Absent → uses the Kotlin-side default (null), which is what we want.
  return new TextEncoder().encode(
    JSON.stringify(info, (_key, val) => (val === null ? undefined : val)),
  );
}

export function deserializeMetaInfo(bytes: Uint8Array): MetaInfo {
  return JSON.parse(new TextDecoder().decode(bytes)) as MetaInfo;
}

/**
 * Assemble the MetaInfo blob this browser publishes about itself.
 * Anything Android-specific stays null — the Android `MetaInfoFormatting` UI
 * already special-cases nullable fields, and {@code DeviceType.BROWSER} is
 * the disambiguator.
 */
export async function buildOwnMetaInfo(record: CredentialRecord): Promise<MetaInfo> {
  const browser = await detectBrowserInfo();
  return {
    deviceLabel: record.deviceLabel.length > 0 ? record.deviceLabel : null,
    deviceId: { id: record.ownDeviceId },
    octiVersionName: OCTI_WEB_VERSION,
    octiGitSha: OCTI_WEB_GIT_SHA,
    deviceManufacturer: browser.manufacturer,
    deviceName: browser.deviceName,
    deviceType: "BROWSER",
    deviceBootedAt: null,
    androidVersionName: null,
    androidApiLevel: null,
    androidSecurityPatch: null,
    osType: browser.osType,
    osVersionName: browser.osVersionName ?? null,
  };
}

export async function publishOwnMetaInfo(args: {
  server: ServerAddress;
  creds: AuthCreds;
  crypti: PayloadEncryption;
  record: CredentialRecord;
}): Promise<void> {
  const info = await buildOwnMetaInfo(args.record);
  const plaintext = serializeMetaInfo(info);
  const ad = buildAssociatedData(args.record.ownDeviceId, META_MODULE_ID);
  const ciphertext = args.crypti.encrypt(plaintext, ad);
  // Pass label + version so the server updates DeviceMetadata.label on this
  // authed write. Without the label header, peers fetching /v1/devices would
  // still see the previous label until they happened to decode the new
  // (encrypted) MetaInfo payload.
  await writeModulePayload({
    server: args.server,
    creds: args.creds,
    targetDeviceId: args.record.ownDeviceId,
    moduleId: META_MODULE_ID,
    ciphertext,
    deviceTag: {
      version: OCTI_WEB_VERSION,
      label: args.record.deviceLabel,
    },
  });
}

export async function fetchPeerMetaInfo(args: {
  server: ServerAddress;
  creds: AuthCreds;
  crypti: PayloadEncryption;
  peerDeviceId: string;
}): Promise<MetaInfo | null> {
  const ciphertext = await readModulePayload({
    server: args.server,
    creds: args.creds,
    targetDeviceId: args.peerDeviceId,
    moduleId: META_MODULE_ID,
  });
  if (!ciphertext) return null;
  const ad = buildAssociatedData(args.peerDeviceId, META_MODULE_ID);
  const plaintext = args.crypti.decrypt(ciphertext, ad);
  return deserializeMetaInfo(plaintext);
}

/** Pretty label for UI: prefer the user-set `deviceLabel`, then `deviceName`, else fallback. */
export function metaInfoLabel(info: MetaInfo | null, fallback: string): string {
  if (!info) return fallback;
  if (info.deviceLabel && info.deviceLabel.length > 0) return info.deviceLabel;
  if (info.deviceName) return info.deviceName;
  return fallback;
}
