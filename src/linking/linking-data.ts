import { gunzipSync, gzipSync } from "fflate";

import type { ServerAddress } from "../protocol/models";

/**
 * Web mirror of {@code eu.darken.octi.syncs.octiserver.core.LinkingData}.
 * Wire shape (JSON → gzip → base64):
 *
 *   {
 *     "serverAddress": { "domain": ..., "protocol": "https", "port": 443 },
 *     "shareCode":     { "code": "..." },
 *     "encryptionKeySet": { "type": "AES256_GCM_SIV", "key": "<base64-tink-keyset>" }
 *   }
 *
 * Note: in `LinkingData` the outer JSON key is the *correctly-spelled*
 * `serverAddress`, even though the Kotlin field is `serverAdress` (typo). The
 * `@SerialName` overrides the property name on the wire. The
 * `OctiServer.Credentials` type — a different struct, used for persistence —
 * uses the typo on the wire (see memory). Don't conflate them.
 */
export interface LinkingData {
  serverAddress: ServerAddress;
  shareCode: { code: string };
  encryptionKeySet: { type: "AES256_GCM_SIV" | "AES256_SIV"; key: Uint8Array };
}

interface LinkingDataJson {
  serverAddress: ServerAddress;
  shareCode: { code: string };
  encryptionKeySet: { type: string; key: string };
}

export function encodeLinkingData(data: LinkingData): string {
  const json: LinkingDataJson = {
    serverAddress: data.serverAddress,
    shareCode: data.shareCode,
    encryptionKeySet: {
      type: data.encryptionKeySet.type,
      key: bytesToBase64(data.encryptionKeySet.key),
    },
  };
  const text = JSON.stringify(json);
  const compressed = gzipSync(new TextEncoder().encode(text));
  return bytesToBase64(compressed);
}

export function decodeLinkingData(encoded: string): LinkingData {
  let compressed: Uint8Array;
  try {
    compressed = base64ToBytes(encoded.trim());
  } catch {
    throw new Error("Invalid link code: not valid base64");
  }
  let text: string;
  try {
    text = new TextDecoder().decode(gunzipSync(compressed));
  } catch {
    throw new Error("Invalid link code: not a valid gzip payload");
  }
  let parsed: LinkingDataJson;
  try {
    parsed = JSON.parse(text) as LinkingDataJson;
  } catch {
    throw new Error("Invalid link code: gunzipped body isn't JSON");
  }
  validateShape(parsed);
  return {
    serverAddress: parsed.serverAddress,
    shareCode: parsed.shareCode,
    encryptionKeySet: {
      type: parsed.encryptionKeySet.type as LinkingData["encryptionKeySet"]["type"],
      key: base64ToBytes(parsed.encryptionKeySet.key),
    },
  };
}

function validateShape(d: LinkingDataJson): void {
  // Fail loud on shape drift — we'd rather refuse a malformed link than persist
  // partial credentials and break later.
  if (!d.serverAddress?.domain || !d.serverAddress.protocol || !d.serverAddress.port) {
    throw new Error("Invalid link code: missing or malformed serverAddress");
  }
  if (d.serverAddress.protocol !== "http" && d.serverAddress.protocol !== "https") {
    throw new Error(`Invalid link code: unsupported protocol "${d.serverAddress.protocol}"`);
  }
  if (!d.shareCode?.code) {
    throw new Error("Invalid link code: missing shareCode.code");
  }
  if (!d.encryptionKeySet?.type || !d.encryptionKeySet.key) {
    throw new Error("Invalid link code: missing or malformed encryptionKeySet");
  }
  if (d.encryptionKeySet.type !== "AES256_GCM_SIV" && d.encryptionKeySet.type !== "AES256_SIV") {
    throw new Error(
      `Invalid link code: unknown encryption keyset type "${d.encryptionKeySet.type}"`,
    );
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
