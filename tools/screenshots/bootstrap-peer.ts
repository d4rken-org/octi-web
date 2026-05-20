/**
 * Bootstrap a fake "Pixel 7" Android peer on a live sync-server. Used by the
 * release-time E2E job (and `pnpm e2e:smoke` locally) to seed the account the
 * SPA links into for screenshot capture.
 *
 * The SPA's own protocol helpers (`src/protocol/octi-api.ts`) hardcode
 * `Octi-Device-Platform: web` and the web-only capability set, so they can't
 * pretend to be an Android peer. This script does its own REST calls but
 * reuses the cross-language-stable pieces — Tink keyset codec,
 * payload encrypt/decrypt, LinkingData encoder, module serializers — to keep
 * the wire shape byte-for-byte identical to a real Android peer.
 *
 * Inputs:
 *   SYNC_SERVER_URL    e.g. http://127.0.0.1:18080
 *   OUTPUT_PATH        file to write the result to (default: bootstrap-peer.json)
 *   SHARE_CODES_COUNT  how many share codes to mint (default: 4). Each Playwright
 *                      project that pastes a link consumes one — the share-route
 *                      one-time-uses each code, so multi-project runs need
 *                      multiple. Buffer a couple extra for re-runs.
 *
 * Output (JSON):
 *   linkingDataBlobs  array of base64 LinkingData strings — Playwright picks
 *                     one per project in `link-and-capture.spec.ts`
 *   serverAddress     the ServerAddress we used (so Playwright can sanity-check)
 *   accountId         server-assigned account UUID
 *   deviceId          our fake-phone X-Device-ID — Playwright asserts this
 *                     device is visible in the SPA's dashboard after linking
 *
 * Run via:
 *   SYNC_SERVER_URL=http://127.0.0.1:18080 pnpm bootstrap-peer
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildAssociatedData, createPayloadEncryption } from "../../src/crypto/payload";
import { generateAesGcmSivKeyset } from "../../src/crypto/tink-keyset";
import { encodeLinkingData } from "../../src/linking/linking-data";
import type { ServerAddress } from "../../src/protocol/models";

// Reuse the cross-language module serializers + module IDs verbatim so the
// emitted ciphertext is exactly what an Android peer would emit.
import { textClipboard, serializeClipboardInfo, CLIPBOARD_MODULE_ID } from "../../src/modules/clipboard";
import { serializeMetaInfo, META_MODULE_ID, type MetaInfo } from "../../src/modules/meta";
import { POWER_MODULE_ID, type PowerInfo } from "../../src/modules/power";
import { WIFI_MODULE_ID, type WifiInfo } from "../../src/modules/wifi";
import { CONNECTIVITY_MODULE_ID, type ConnectivityInfo } from "../../src/modules/connectivity";
import { APPS_MODULE_ID, type AppsInfo } from "../../src/modules/apps";

// =============================================================================
// Android-flavored device identity
// =============================================================================

const PHONE_LABEL = "Pixel 7";
const PHONE_VERSION = "1.0.5";
const PHONE_PLATFORM = "android";

/**
 * Capability tag set a real Android peer (post-octi#309) emits. Both
 * encryption modes plus the namespace marker. Canonical-sorted JSON-array per
 * the cross-platform contract.
 */
const PHONE_CAPABILITIES_HEADER = JSON.stringify(
  ["encryption:AES256_GCM_SIV", "encryption:AES256_SIV", "encryption:_reported"].sort(),
);

// =============================================================================
// Tiny REST client — Android-flavored headers
// =============================================================================

interface PeerCreds {
  accountId: string;
  devicePassword: string;
  deviceId: string;
}

function basicAuth(accountId: string, password: string): string {
  return `Basic ${Buffer.from(`${accountId}:${password}`).toString("base64")}`;
}

function androidHeaders(deviceId: string, includeLabel: boolean): Record<string, string> {
  const h: Record<string, string> = {
    "X-Device-ID": deviceId,
    "Octi-Device-Platform": PHONE_PLATFORM,
    "Octi-Device-Version": PHONE_VERSION,
    "Octi-Device-Capabilities": PHONE_CAPABILITIES_HEADER,
  };
  if (includeLabel) h["Octi-Device-Label"] = PHONE_LABEL;
  return h;
}

function serverBaseUrl(addr: ServerAddress): string {
  return `${addr.protocol}://${addr.domain}:${addr.port}`;
}

function parseServerUrl(raw: string): ServerAddress {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`SYNC_SERVER_URL must be http(s); got ${url.protocol}`);
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return {
    domain: url.hostname,
    protocol: url.protocol === "https:" ? "https" : "http",
    port,
  };
}

async function createAccount(addr: ServerAddress, deviceId: string): Promise<PeerCreds> {
  const url = `${serverBaseUrl(addr)}/v1/account`;
  const res = await fetch(url, {
    method: "POST",
    headers: androidHeaders(deviceId, true),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`POST /v1/account → ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { account: string; password: string };
  return {
    accountId: json.account,
    devicePassword: json.password,
    deviceId,
  };
}

async function writeModule(
  addr: ServerAddress,
  creds: PeerCreds,
  moduleId: string,
  ciphertext: Uint8Array,
): Promise<void> {
  const url = `${serverBaseUrl(addr)}/v1/module/${encodeURIComponent(moduleId)}?device-id=${encodeURIComponent(creds.deviceId)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...androidHeaders(creds.deviceId, false),
      Authorization: basicAuth(creds.accountId, creds.devicePassword),
      "Content-Type": "application/octet-stream",
    },
    // `BodyInit` accepts `Uint8Array`; Node's fetch typing is overly strict so cast.
    body: ciphertext as unknown as BodyInit,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `POST /v1/module/${moduleId} → ${res.status}: ${body.slice(0, 300)}`,
    );
  }
}

async function mintShareCode(addr: ServerAddress, creds: PeerCreds): Promise<string> {
  const url = `${serverBaseUrl(addr)}/v1/account/share`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...androidHeaders(creds.deviceId, false),
      Authorization: basicAuth(creds.accountId, creds.devicePassword),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`POST /v1/account/share → ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { code: string };
  return json.code;
}

// =============================================================================
// Realistic module payloads for the fake phone
// =============================================================================

function makeMeta(deviceId: string): MetaInfo {
  return {
    deviceLabel: PHONE_LABEL,
    deviceId: { id: deviceId },
    octiVersionName: PHONE_VERSION,
    octiGitSha: "demo",
    deviceManufacturer: "Google",
    deviceName: "Pixel 7",
    deviceType: "PHONE",
    deviceBootedAt: null,
    androidVersionName: "14",
    androidApiLevel: 34,
    androidSecurityPatch: "2026-04-05",
    osType: "Android",
    osVersionName: "14",
  };
}

function makePower(): PowerInfo {
  return {
    status: "DISCHARGING",
    battery: { level: 78, scale: 100, health: 2, temp: 31 },
    chargeIO: {
      currentNow: -450_000,
      currentAvg: -480_000,
      fullSince: null,
      fullAt: null,
      // ~3h 30m from "now" as the demo's estimate — Playwright freezes clock so
      // this is a deterministic offset.
      emptyAt: new Date("2026-05-20T18:00:00Z").toISOString(),
    },
  };
}

function makeWifi(): WifiInfo {
  return {
    currentWifi: {
      ssid: '"Home"', // Android wraps in quotes
      reception: 0.82,
      freqType: "5GHZ",
    },
  };
}

function makeConnectivity(): ConnectivityInfo {
  return {
    connectionType: "WIFI",
    publicIp: "203.0.113.42",
    localAddressIpv4: "192.168.1.103",
    localAddressIpv6: null,
    gatewayIp: "192.168.1.1",
    dnsServers: ["1.1.1.1", "1.0.0.1"],
  };
}

function makeApps(): AppsInfo {
  // Small representative app set. Real phones have hundreds; we don't need that
  // many for the screenshot — the tile shows a count, not a list.
  const pkgs = [
    ["com.google.android.gm", "Gmail"],
    ["com.spotify.music", "Spotify"],
    ["com.whatsapp", "WhatsApp"],
    ["org.thoughtcrime.securesms", "Signal"],
    ["com.duckduckgo.mobile.android", "DuckDuckGo"],
    ["com.discord", "Discord"],
    ["org.mozilla.firefox", "Firefox"],
  ] as const;
  return {
    installedPackages: pkgs.map(([packageName, label], i) => ({
      packageName,
      label,
      versionCode: 1000 + i,
      versionName: `1.${i}.0`,
      installedAt: "2026-01-15T12:34:56Z",
      installerPkg: "com.android.vending",
      updatedAt: "2026-05-01T08:00:00Z",
    })),
  };
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const syncServerUrl = process.env.SYNC_SERVER_URL;
  if (!syncServerUrl) throw new Error("SYNC_SERVER_URL not set");
  const outputPath = resolve(process.env.OUTPUT_PATH ?? "bootstrap-peer.json");

  const serverAddress = parseServerUrl(syncServerUrl);
  const deviceId = randomUUID();
  console.log(`[bootstrap-peer] using server ${serverBaseUrl(serverAddress)}`);
  console.log(`[bootstrap-peer] fake phone deviceId ${deviceId}`);

  // 1. Generate the shared Tink keyset. Both the bootstrap peer (here) and the
  //    SPA (after linking) use this same keyset to read each other's payloads.
  const { bytes: keysetBytes } = generateAesGcmSivKeyset();
  const crypti = createPayloadEncryption(keysetBytes);

  // 2. Create the account — server assigns accountId + devicePassword.
  const creds = await createAccount(serverAddress, deviceId);
  console.log(`[bootstrap-peer] created account ${creds.accountId}`);

  // 3. Publish module payloads as the fake phone.
  async function publish(moduleId: string, plaintext: Uint8Array): Promise<void> {
    const ad = buildAssociatedData(deviceId, moduleId);
    const ciphertext = crypti.encrypt(plaintext, ad);
    await writeModule(serverAddress, creds, moduleId, ciphertext);
    console.log(`[bootstrap-peer] published ${moduleId} (${ciphertext.length} B)`);
  }

  await publish(META_MODULE_ID, serializeMetaInfo(makeMeta(deviceId)));
  await publish(
    CLIPBOARD_MODULE_ID,
    serializeClipboardInfo(textClipboard("https://web.octi.darken.eu — neat hosted client")),
  );
  await publish(POWER_MODULE_ID, jsonBytes(makePower()));
  await publish(WIFI_MODULE_ID, jsonBytes(makeWifi()));
  await publish(CONNECTIVITY_MODULE_ID, jsonBytes(makeConnectivity()));
  await publish(APPS_MODULE_ID, jsonBytes(makeApps()));

  // 4. Mint N share codes — each is one-time-use, so multi-project Playwright
  //    runs need one per project (desktop + mobile = 2). Extra are buffer for
  //    re-runs and the SHARE_CODES_COUNT env knob can dial it up.
  const codeCount = Number(process.env.SHARE_CODES_COUNT ?? "4");
  if (!Number.isFinite(codeCount) || codeCount < 1) {
    throw new Error(`SHARE_CODES_COUNT must be a positive integer, got ${process.env.SHARE_CODES_COUNT}`);
  }
  const linkingDataBlobs: string[] = [];
  for (let i = 0; i < codeCount; i++) {
    const shareCode = await mintShareCode(serverAddress, creds);
    linkingDataBlobs.push(
      encodeLinkingData({
        serverAddress,
        shareCode: { code: shareCode },
        encryptionKeySet: { type: "AES256_GCM_SIV", key: keysetBytes },
      }),
    );
    console.log(`[bootstrap-peer] minted share code ${i + 1}/${codeCount}`);
  }

  // 5. Persist for Playwright to consume.
  const payload = {
    linkingDataBlobs,
    serverAddress,
    accountId: creds.accountId,
    deviceId,
  };
  writeFileSync(outputPath, JSON.stringify(payload, null, 2));
  console.log(`[bootstrap-peer] wrote ${outputPath} with ${codeCount} share code(s)`);
}

function jsonBytes(obj: unknown): Uint8Array {
  // Match the modules' own serializers: JSON.stringify with nulls retained for
  // typed decoders. Power/Wifi/Connectivity/Apps round-trip through their
  // decoders without a writer helper because the web client doesn't publish
  // them — but the wire shape is just JSON.stringify of the typed objects.
  return new TextEncoder().encode(JSON.stringify(obj));
}

main().catch((e) => {
  console.error(`[bootstrap-peer] FAILED:`, e);
  process.exit(1);
});
