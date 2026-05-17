import { buildAssociatedData, type PayloadEncryption } from "../crypto/payload";
import {
  type AuthCreds,
  readModulePayload,
  writeModulePayload,
} from "../protocol/octi-api";
import type { ServerAddress } from "../protocol/models";
import { base64ToBytes, bytesToBase64 } from "../util/base64";

/**
 * TS mirror of {@code eu.darken.octi.modules.clipboard.ClipboardInfo}. Wire shape
 * is kotlinx.serialization JSON:
 *
 *   { "type": "EMPTY" | "SIMPLE_TEXT", "data": "<base64-utf8-bytes>" }
 *
 * The Android side enforces a 32 KiB cap on the raw bytes — we mirror it pre-encrypt
 * so a misbehaving caller fails locally rather than via an opaque server / decrypt
 * error on a peer. ByteString serialization is base64 (per
 * eu.darken.octi.common.serialization.serializer.ByteStringSerializer).
 */
export const CLIPBOARD_MODULE_ID = "eu.darken.octi.module.core.clipboard";

export const CLIPBOARD_MAX_BYTES = 32 * 1024;

export type ClipboardType = "EMPTY" | "SIMPLE_TEXT";

export interface ClipboardInfo {
  type: ClipboardType;
  /** UTF-8 bytes of the clipboard text. Empty for `EMPTY` type. */
  data: Uint8Array;
}

interface ClipboardInfoJson {
  type: ClipboardType;
  data: string; // base64
}

export function emptyClipboard(): ClipboardInfo {
  return { type: "EMPTY", data: new Uint8Array(0) };
}

export function textClipboard(text: string): ClipboardInfo {
  const data = new TextEncoder().encode(text);
  if (data.byteLength > CLIPBOARD_MAX_BYTES) {
    throw new Error(
      `Clipboard payload too large: ${data.byteLength} bytes (max ${CLIPBOARD_MAX_BYTES})`,
    );
  }
  return { type: "SIMPLE_TEXT", data };
}

/** Convenience: decode SIMPLE_TEXT clipboard bytes back to a string. */
export function clipboardText(info: ClipboardInfo): string {
  if (info.type !== "SIMPLE_TEXT") return "";
  return new TextDecoder().decode(info.data);
}

export function serializeClipboardInfo(info: ClipboardInfo): Uint8Array {
  if (info.data.byteLength > CLIPBOARD_MAX_BYTES) {
    throw new Error(
      `Clipboard payload too large: ${info.data.byteLength} bytes (max ${CLIPBOARD_MAX_BYTES})`,
    );
  }
  const json: ClipboardInfoJson = {
    type: info.type,
    data: bytesToBase64(info.data),
  };
  return new TextEncoder().encode(JSON.stringify(json));
}

export function deserializeClipboardInfo(bytes: Uint8Array): ClipboardInfo {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as ClipboardInfoJson;
  if (parsed.type !== "EMPTY" && parsed.type !== "SIMPLE_TEXT") {
    throw new Error(`Unknown ClipboardInfo.type: ${parsed.type}`);
  }
  return {
    type: parsed.type,
    data: parsed.data ? base64ToBytes(parsed.data) : new Uint8Array(0),
  };
}

export async function publishOwnClipboard(args: {
  server: ServerAddress;
  creds: AuthCreds;
  crypti: PayloadEncryption;
  ownDeviceId: string;
  info: ClipboardInfo;
}): Promise<void> {
  const plaintext = serializeClipboardInfo(args.info);
  const ad = buildAssociatedData(args.ownDeviceId, CLIPBOARD_MODULE_ID);
  const ciphertext = args.crypti.encrypt(plaintext, ad);
  await writeModulePayload({
    server: args.server,
    creds: args.creds,
    targetDeviceId: args.ownDeviceId,
    moduleId: CLIPBOARD_MODULE_ID,
    ciphertext,
  });
}

export async function fetchPeerClipboard(args: {
  server: ServerAddress;
  creds: AuthCreds;
  crypti: PayloadEncryption;
  peerDeviceId: string;
}): Promise<ClipboardInfo | null> {
  const ciphertext = await readModulePayload({
    server: args.server,
    creds: args.creds,
    targetDeviceId: args.peerDeviceId,
    moduleId: CLIPBOARD_MODULE_ID,
  });
  if (!ciphertext) return null;
  const ad = buildAssociatedData(args.peerDeviceId, CLIPBOARD_MODULE_ID);
  const plaintext = args.crypti.decrypt(ciphertext, ad);
  return deserializeClipboardInfo(plaintext);
}
