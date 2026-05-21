import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

import { createBlobCipher, type BlobCipher } from "../crypto/blob-cipher";
import { buildAssociatedData, createPayloadEncryption, type PayloadEncryption } from "../crypto/payload";
import { generateAesGcmSivKeyset } from "../crypto/tink-keyset";
import {
  CLIPBOARD_MODULE_ID,
  clipboardText,
  deserializeClipboardInfo,
  serializeClipboardInfo,
  textClipboard,
} from "../modules/clipboard";
import {
  FILES_MODULE_ID,
  deserializeFileShareInfo,
  downloadSharedFile,
  type FileShareInfo,
} from "../modules/files";
import {
  META_MODULE_ID,
  serializeMetaInfo,
  type MetaInfo,
} from "../modules/meta";
import {
  createOrJoinAccount,
  createShareCode,
  type AuthCreds,
} from "../protocol/octi-api";
import { octiServerConnectorId } from "../protocol/connector-id";
import type { ServerAddress } from "../protocol/models";
import { serverBaseUrl } from "../protocol/models";
import { OctiServerConnector } from "../protocol/octi-server-connector";
import type { OctiServerCredentialRecord } from "../storage/credentials-repo";
import { type ConnectorRefreshState, ConnectorManager } from "../sync/connector-manager.svelte";

const ANDROID_VERSION = "octi-android/smoke";
const ANDROID_CAPABILITIES_HEADER = JSON.stringify(
  ["encryption:AES256_GCM_SIV", "encryption:AES256_SIV", "encryption:_reported"].sort(),
);

describe("smoke: multi-connector manager against two sync-servers", () => {
  const urlA = process.env.SMOKE_SERVER_URL;
  const urlB = process.env.SMOKE_SERVER_B_URL;

  if (!urlA || !urlB) {
    it.skip("SMOKE_SERVER_URL and SMOKE_SERVER_B_URL are required for multi-connector smoke", () => {});
    return;
  }

  it("merges peer modules and fans out own clipboard/files across both servers", async () => {
    const serverA = parseServerUrl(urlA);
    const serverB = parseServerUrl(urlB);
    const ownDeviceId = crypto.randomUUID();
    const peerDeviceId = crypto.randomUUID();

    const ctxA = await createWebConnector({
      server: serverA,
      ownDeviceId,
      deviceLabel: "web-smoke-A",
      createdAt: 1,
    });
    const ctxB = await createWebConnector({
      server: serverB,
      ownDeviceId,
      deviceLabel: "web-smoke-B",
      createdAt: 2,
    });

    const peerA = await joinAndroidPeer({
      server: serverA,
      webCreds: ctxA.webCreds,
      peerDeviceId,
      label: "peer-from-A",
    });
    const peerB = await joinAndroidPeer({
      server: serverB,
      webCreds: ctxB.webCreds,
      peerDeviceId,
      label: "peer-from-B",
    });

    await publishAndroidModule({
      server: serverA,
      creds: peerA,
      crypti: ctxA.crypti,
      moduleId: META_MODULE_ID,
      plaintext: serializeMetaInfo(makePeerMeta(peerDeviceId, "peer-meta-A")),
    });
    await publishAndroidModule({
      server: serverA,
      creds: peerA,
      crypti: ctxA.crypti,
      moduleId: CLIPBOARD_MODULE_ID,
      plaintext: serializeClipboardInfo(textClipboard("clipboard-from-A")),
    });

    await sleep(1_100);

    await publishAndroidModule({
      server: serverB,
      creds: peerB,
      crypti: ctxB.crypti,
      moduleId: META_MODULE_ID,
      plaintext: serializeMetaInfo(makePeerMeta(peerDeviceId, "peer-meta-B")),
    });
    await publishAndroidModule({
      server: serverB,
      creds: peerB,
      crypti: ctxB.crypti,
      moduleId: CLIPBOARD_MODULE_ID,
      plaintext: serializeClipboardInfo(textClipboard("clipboard-from-B")),
    });

    const manager = new ConnectorManager();
    manager.__setConnectorsForTest({
      connectors: [ctxA.connector, ctxB.connector],
      crypti: new Map([
        [ctxA.connector.connectorId, ctxA.crypti],
        [ctxB.connector.connectorId, ctxB.crypti],
      ]),
      blobCipher: new Map([
        [ctxA.connector.connectorId, ctxA.blobCipher],
        [ctxB.connector.connectorId, ctxB.blobCipher],
      ]),
    });
    manager.perConnectorState = new Map([
      [ctxA.connector.connectorId, idleState()],
      [ctxB.connector.connectorId, idleState()],
    ]);

    await manager.refreshAll();

    const peerRows = manager.mergedDevices.filter((d) => d.raw.id === peerDeviceId);
    expect(peerRows).toHaveLength(1);
    const peer = peerRows[0];
    expect(peer.metadataOwnerConnectorId).toBe(ctxA.connector.connectorId);
    expect(peer.raw.label).toBe("peer-from-A");
    expect(peer.modulesByConnector.get(META_MODULE_ID)).toBe(ctxB.connector.connectorId);
    expect(peer.modulesByConnector.get(CLIPBOARD_MODULE_ID)).toBe(ctxB.connector.connectorId);
    expect(peer.meta?.deviceLabel).toBe("peer-meta-B");
    expect(peer.clipboard && clipboardText(peer.clipboard)).toBe("clipboard-from-B");
    expect(manager.mergedIssues).toEqual([]);

    await manager.publishOwnMetaInfo();
    await manager.publishOwnClipboard(textClipboard("own-clipboard"));

    await expect(readOwnClipboard(ctxA)).resolves.toBe("own-clipboard");
    await expect(readOwnClipboard(ctxB)).resolves.toBe("own-clipboard");

    const bytes = new TextEncoder().encode("hello multi connector");
    const file = new File([bytes], "multi.txt", { type: "text/plain" });
    const upload = await manager.uploadFile(file);

    expect([...upload.shared.availableOn].sort()).toEqual(
      [ctxA.connector.connectorId, ctxB.connector.connectorId].sort(),
    );
    expect(Object.keys(upload.shared.connectorRefs).sort()).toEqual(
      [ctxA.connector.connectorId, ctxB.connector.connectorId].sort(),
    );

    const fileInfoA = await readOwnFileShare(ctxA);
    const fileInfoB = await readOwnFileShare(ctxB);
    expect(findSharedFile(fileInfoA, upload.shared.blobKey)?.connectorRefs).toEqual(upload.shared.connectorRefs);
    expect(findSharedFile(fileInfoB, upload.shared.blobKey)?.connectorRefs).toEqual(upload.shared.connectorRefs);

    const downloadedByA = await downloadSharedFile({
      connector: ctxA.connector,
      blobCipher: ctxA.blobCipher,
      ownerDeviceId: ownDeviceId,
      file: upload.shared,
    });
    const downloadedByB = await downloadSharedFile({
      connector: ctxB.connector,
      blobCipher: ctxB.blobCipher,
      ownerDeviceId: ownDeviceId,
      file: upload.shared,
    });
    expect(new TextDecoder().decode(downloadedByA.bytes)).toBe("hello multi connector");
    expect(new TextDecoder().decode(downloadedByB.bytes)).toBe("hello multi connector");
  }, 60_000);
});

interface ConnectorSmokeContext {
  connector: OctiServerConnector;
  crypti: PayloadEncryption;
  blobCipher: BlobCipher;
  webCreds: AuthCreds;
}

function parseServerUrl(raw: string): ServerAddress {
  const u = new URL(raw);
  return {
    domain: u.hostname,
    protocol: u.protocol.replace(":", "") as "http" | "https",
    port: u.port ? Number.parseInt(u.port, 10) : u.protocol === "https:" ? 443 : 80,
  };
}

async function createWebConnector(args: {
  server: ServerAddress;
  ownDeviceId: string;
  deviceLabel: string;
  createdAt: number;
}): Promise<ConnectorSmokeContext> {
  const account = await createOrJoinAccount({
    server: args.server,
    deviceId: args.ownDeviceId,
    deviceTag: { version: "octi-web/multi-smoke", label: args.deviceLabel },
  });
  const { bytes: keysetBytes } = generateAesGcmSivKeyset();
  const record: OctiServerCredentialRecord = {
    connectorId: octiServerConnectorId(args.server, account.account),
    connectorType: "kserver",
    accountId: account.account,
    devicePassword: account.password,
    ownDeviceId: args.ownDeviceId,
    deviceLabel: args.deviceLabel,
    serverAddress: args.server,
    encryptionKeyset: keysetBytes,
    createdAt: args.createdAt,
    updatedAt: args.createdAt,
  };
  return {
    connector: new OctiServerConnector(record, args.ownDeviceId),
    crypti: createPayloadEncryption(keysetBytes),
    blobCipher: await createBlobCipher(keysetBytes),
    webCreds: {
      accountId: account.account,
      devicePassword: account.password,
      deviceId: args.ownDeviceId,
    },
  };
}

async function joinAndroidPeer(args: {
  server: ServerAddress;
  webCreds: AuthCreds;
  peerDeviceId: string;
  label: string;
}): Promise<AuthCreds> {
  const share = await createShareCode({ server: args.server, creds: args.webCreds });
  const res = await fetch(`${serverBaseUrl(args.server)}/v1/account?share=${encodeURIComponent(share.code)}`, {
    method: "POST",
    headers: androidHeaders(args.peerDeviceId, args.label),
  });
  if (!res.ok) {
    throw new Error(`join Android peer on ${serverBaseUrl(args.server)} -> ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { account: string; password: string };
  return {
    accountId: body.account,
    devicePassword: body.password,
    deviceId: args.peerDeviceId,
  };
}

async function publishAndroidModule(args: {
  server: ServerAddress;
  creds: AuthCreds;
  crypti: PayloadEncryption;
  moduleId: string;
  plaintext: Uint8Array;
}): Promise<void> {
  const ad = buildAssociatedData(args.creds.deviceId, args.moduleId);
  const ciphertext = args.crypti.encrypt(args.plaintext, ad);
  const res = await fetch(
    `${serverBaseUrl(args.server)}/v1/module/${encodeURIComponent(args.moduleId)}?device-id=${encodeURIComponent(args.creds.deviceId)}`,
    {
      method: "POST",
      headers: {
        ...androidHeaders(args.creds.deviceId, null),
        Authorization: basicAuth(args.creds),
        "Content-Type": "application/octet-stream",
      },
      body: ciphertext,
    },
  );
  if (!res.ok) {
    throw new Error(`publish ${args.moduleId} on ${serverBaseUrl(args.server)} -> ${res.status}: ${await res.text()}`);
  }
}

function androidHeaders(deviceId: string, label: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Device-ID": deviceId,
    "Octi-Device-Platform": "android",
    "Octi-Device-Version": ANDROID_VERSION,
    "Octi-Device-Capabilities": ANDROID_CAPABILITIES_HEADER,
  };
  if (label) headers["Octi-Device-Label"] = label;
  return headers;
}

function basicAuth(creds: AuthCreds): string {
  return `Basic ${btoa(`${creds.accountId}:${creds.devicePassword}`)}`;
}

function makePeerMeta(deviceId: string, label: string): MetaInfo {
  return {
    deviceLabel: label,
    deviceId: { id: deviceId },
    octiVersionName: "1.0.5",
    octiGitSha: "smoke",
    deviceManufacturer: "Google",
    deviceName: "Pixel Smoke",
    deviceType: "PHONE",
    deviceBootedAt: null,
    androidVersionName: "14",
    androidApiLevel: 34,
    androidSecurityPatch: "2026-04-05",
    osType: "Android",
    osVersionName: "14",
  };
}

async function readOwnClipboard(ctx: ConnectorSmokeContext): Promise<string> {
  const result = await ctx.connector.readModulePayloadWithEtag({
    targetDeviceId: ctx.connector.ownDeviceId,
    moduleId: CLIPBOARD_MODULE_ID,
  });
  if (!result) throw new Error(`No clipboard payload on ${ctx.connector.connectorId}`);
  const plaintext = ctx.crypti.decrypt(
    result.bytes,
    buildAssociatedData(ctx.connector.ownDeviceId, CLIPBOARD_MODULE_ID),
  );
  return clipboardText(deserializeClipboardInfo(plaintext));
}

async function readOwnFileShare(ctx: ConnectorSmokeContext): Promise<FileShareInfo> {
  const result = await ctx.connector.readModulePayloadWithEtag({
    targetDeviceId: ctx.connector.ownDeviceId,
    moduleId: FILES_MODULE_ID,
  });
  if (!result) throw new Error(`No FileShareInfo payload on ${ctx.connector.connectorId}`);
  const plaintext = ctx.crypti.decrypt(
    result.bytes,
    buildAssociatedData(ctx.connector.ownDeviceId, FILES_MODULE_ID),
  );
  return deserializeFileShareInfo(plaintext);
}

function findSharedFile(info: FileShareInfo, blobKey: string) {
  return info.files.find((f) => f.blobKey === blobKey);
}

function idleState(): ConnectorRefreshState {
  return {
    devices: new Map(),
    lastError: null,
    lastRefreshedAt: null,
    lastSuccessAt: null,
    refreshing: false,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
