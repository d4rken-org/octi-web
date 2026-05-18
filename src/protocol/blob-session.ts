import { OctiApiError, OCTI_WEB_CAPABILITIES_HEADER, type AuthCreds } from "./octi-api";
import { type ServerAddress, serverBaseUrl } from "./models";

/**
 * Resumable blob-upload session API (server-side spec in
 * sync-server PLAN-BLOB-SUPPORT.md). Three calls per upload:
 *
 *   POST /v1/module/{moduleId}/blob-sessions?device-id={target}      (create)
 *   PATCH /v1/module/{moduleId}/blob-sessions/{sessionId}?device-id… (append; one or more)
 *   POST /v1/module/{moduleId}/blob-sessions/{sessionId}/finalize?…  (finalize)
 *
 * After finalize, the returned `blobId` is what gets stored in
 * `FileShareInfo.SharedFile.connectorRefs["octiserver"]`. The caller still has
 * to PUT the module document to actually publish the SharedFile entry.
 *
 * All bytes here are the already-encrypted streaming-AEAD wire bytes — never
 * raw plaintext. The hash declared on create/finalize is SHA-256 of the
 * CIPHERTEXT (matches Android's `streamEncryptAndUpload` digest).
 */

// Per server defaults; matches the Android client's MAX_CHUNK_BYTES. Keep below
// `maxBlobPatchBytes` (default 1 MiB) on the server side.
export const BLOB_PATCH_CHUNK_SIZE = 1024 * 1024;

const HEADER_UPLOAD_OFFSET = "Upload-Offset";

export interface CreateSessionResponse {
  blobId: string;
  sessionId: string;
  offsetBytes: number;
  expiresAt: string;
  state: string;
}

export interface FinalizeSessionResponse {
  blobId: string;
  sessionId: string;
  sizeBytes: number;
  state: string;
}

function moduleBlobSessionsUrl(server: ServerAddress, moduleId: string, targetDeviceId: string): string {
  return `${serverBaseUrl(server)}/v1/module/${encodeURIComponent(moduleId)}/blob-sessions?device-id=${encodeURIComponent(targetDeviceId)}`;
}

function moduleBlobSessionUrl(
  server: ServerAddress,
  moduleId: string,
  sessionId: string,
  targetDeviceId: string,
): string {
  return `${serverBaseUrl(server)}/v1/module/${encodeURIComponent(moduleId)}/blob-sessions/${encodeURIComponent(sessionId)}?device-id=${encodeURIComponent(targetDeviceId)}`;
}

function blobDownloadUrl(server: ServerAddress, moduleId: string, blobId: string, targetDeviceId: string): string {
  return `${serverBaseUrl(server)}/v1/module/${encodeURIComponent(moduleId)}/blobs/${encodeURIComponent(blobId)}?device-id=${encodeURIComponent(targetDeviceId)}`;
}

function authHeader(creds: AuthCreds): string {
  return `Basic ${btoa(`${creds.accountId}:${creds.devicePassword}`)}`;
}

function baseHeaders(creds: AuthCreds, version: string): HeadersInit {
  return {
    Authorization: authHeader(creds),
    "X-Device-ID": creds.deviceId,
    "Octi-Device-Platform": "web",
    "Octi-Device-Version": version,
    "Octi-Device-Capabilities": OCTI_WEB_CAPABILITIES_HEADER,
  };
}

export async function createBlobSession(args: {
  server: ServerAddress;
  creds: AuthCreds;
  version: string;
  targetDeviceId: string;
  moduleId: string;
  sizeBytes: number;
  hashAlgorithm?: "sha256";
  hashHex?: string;
}): Promise<CreateSessionResponse> {
  const url = moduleBlobSessionsUrl(args.server, args.moduleId, args.targetDeviceId);
  const body: Record<string, unknown> = { sizeBytes: args.sizeBytes };
  if (args.hashAlgorithm) body.hashAlgorithm = args.hashAlgorithm;
  if (args.hashHex) body.hashHex = args.hashHex;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...baseHeaders(args.creds, args.version), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new OctiApiError(res.status, `blob-sessions/create`, await res.text().catch(() => ""));
  }
  return (await res.json()) as CreateSessionResponse;
}

/**
 * Append `chunk` to the session at `offset`. Returns the server's new offset
 * (parsed from the `Upload-Offset` response header). Chunk size must be ≤
 * server's `maxBlobPatchBytes` (default 1 MiB).
 */
export async function appendBlobSession(args: {
  server: ServerAddress;
  creds: AuthCreds;
  version: string;
  targetDeviceId: string;
  moduleId: string;
  sessionId: string;
  offset: number;
  chunk: Uint8Array;
}): Promise<number> {
  const url = moduleBlobSessionUrl(args.server, args.moduleId, args.sessionId, args.targetDeviceId);
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      ...baseHeaders(args.creds, args.version),
      "Content-Type": "application/octet-stream",
      [HEADER_UPLOAD_OFFSET]: String(args.offset),
      "Content-Length": String(args.chunk.length),
    },
    body: args.chunk,
  });
  if (res.status !== 204 && !res.ok) {
    throw new OctiApiError(res.status, `blob-sessions/append`, await res.text().catch(() => ""));
  }
  const newOffsetHeader = res.headers.get(HEADER_UPLOAD_OFFSET);
  if (!newOffsetHeader) {
    throw new Error("blob-sessions/append: server did not return Upload-Offset");
  }
  const newOffset = Number.parseInt(newOffsetHeader, 10);
  if (!Number.isFinite(newOffset)) {
    throw new Error(`blob-sessions/append: invalid Upload-Offset header: ${newOffsetHeader}`);
  }
  return newOffset;
}

export async function finalizeBlobSession(args: {
  server: ServerAddress;
  creds: AuthCreds;
  version: string;
  targetDeviceId: string;
  moduleId: string;
  sessionId: string;
  hashAlgorithm?: "sha256";
  hashHex?: string;
}): Promise<FinalizeSessionResponse> {
  const url = `${moduleBlobSessionUrl(args.server, args.moduleId, args.sessionId, args.targetDeviceId)}`.replace(
    "/blob-sessions/",
    "/blob-sessions/",
  );
  const finalizeUrl = `${serverBaseUrl(args.server)}/v1/module/${encodeURIComponent(args.moduleId)}/blob-sessions/${encodeURIComponent(args.sessionId)}/finalize?device-id=${encodeURIComponent(args.targetDeviceId)}`;
  void url;
  const body: Record<string, unknown> = {};
  if (args.hashAlgorithm) body.hashAlgorithm = args.hashAlgorithm;
  if (args.hashHex) body.hashHex = args.hashHex;
  const res = await fetch(finalizeUrl, {
    method: "POST",
    headers: { ...baseHeaders(args.creds, args.version), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new OctiApiError(res.status, `blob-sessions/finalize`, await res.text().catch(() => ""));
  }
  return (await res.json()) as FinalizeSessionResponse;
}

export async function abortBlobSession(args: {
  server: ServerAddress;
  creds: AuthCreds;
  version: string;
  targetDeviceId: string;
  moduleId: string;
  sessionId: string;
}): Promise<void> {
  const url = moduleBlobSessionUrl(args.server, args.moduleId, args.sessionId, args.targetDeviceId);
  await fetch(url, { method: "DELETE", headers: baseHeaders(args.creds, args.version) }).catch(() => {
    // Best-effort cleanup; if it fails the session ages out via idle TTL.
  });
}

/** Download an already-finalized blob's ciphertext bytes. */
export async function downloadBlob(args: {
  server: ServerAddress;
  creds: AuthCreds;
  version: string;
  targetDeviceId: string;
  moduleId: string;
  blobId: string;
}): Promise<Uint8Array> {
  const url = blobDownloadUrl(args.server, args.moduleId, args.blobId, args.targetDeviceId);
  const res = await fetch(url, { method: "GET", headers: baseHeaders(args.creds, args.version) });
  if (!res.ok) {
    throw new OctiApiError(res.status, `blobs/${args.blobId}`, await res.text().catch(() => ""));
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/** SHA-256 hex digest helper (used to satisfy server's optional checksum and our own plaintext-hash). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Convenience: upload a complete (already-encrypted) ciphertext as one or more
 * 1 MiB chunks. Returns the server-assigned `blobId` (this becomes
 * `RemoteBlobRef` in `FileShareInfo.connectorRefs["octiserver"]`).
 */
export async function uploadBlobBytes(args: {
  server: ServerAddress;
  creds: AuthCreds;
  version: string;
  targetDeviceId: string;
  moduleId: string;
  ciphertext: Uint8Array;
  onProgress?: (bytes: number, total: number) => void;
}): Promise<string> {
  const ciphertextHash = await sha256Hex(args.ciphertext);
  const session = await createBlobSession({
    server: args.server,
    creds: args.creds,
    version: args.version,
    targetDeviceId: args.targetDeviceId,
    moduleId: args.moduleId,
    sizeBytes: args.ciphertext.length,
    hashAlgorithm: "sha256",
    hashHex: ciphertextHash,
  });
  let offset = session.offsetBytes;
  try {
    while (offset < args.ciphertext.length) {
      const end = Math.min(offset + BLOB_PATCH_CHUNK_SIZE, args.ciphertext.length);
      const chunk = args.ciphertext.subarray(offset, end);
      offset = await appendBlobSession({
        server: args.server,
        creds: args.creds,
        version: args.version,
        targetDeviceId: args.targetDeviceId,
        moduleId: args.moduleId,
        sessionId: session.sessionId,
        offset,
        chunk,
      });
      args.onProgress?.(offset, args.ciphertext.length);
    }
    const finalized = await finalizeBlobSession({
      server: args.server,
      creds: args.creds,
      version: args.version,
      targetDeviceId: args.targetDeviceId,
      moduleId: args.moduleId,
      sessionId: session.sessionId,
      hashAlgorithm: "sha256",
      hashHex: ciphertextHash,
    });
    return finalized.blobId;
  } catch (e) {
    await abortBlobSession({
      server: args.server,
      creds: args.creds,
      version: args.version,
      targetDeviceId: args.targetDeviceId,
      moduleId: args.moduleId,
      sessionId: session.sessionId,
    });
    throw e;
  }
}
