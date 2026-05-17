import { buildAssociatedData, type PayloadEncryption } from "../crypto/payload";
import { type BlobCipher } from "../crypto/blob-cipher";
import {
  type AuthCreds,
  commitModule,
  readModulePayloadWithEtag,
} from "../protocol/octi-api";
import {
  downloadBlob,
  sha256Hex,
  uploadBlobBytes,
} from "../protocol/blob-session";
import type { ServerAddress } from "../protocol/models";
import type { CredentialRecord } from "../storage/credentials-repo";
import { OCTI_WEB_VERSION } from "../version";

/**
 * TS mirror of {@code eu.darken.octi.modules.files.core.FileShareInfo}. Wire
 * shape mirrors the Android `@Serializable` declarations exactly:
 *
 *   { "files": [SharedFile], "deleteRequests": [DeleteRequest] }
 *
 *   SharedFile = {
 *     "name", "mimeType", "size",
 *     "blobKey",                        // client-generated logical id, e.g. "sha256:<hex>"
 *     "checksum",                       // SHA-256 hex of PLAINTEXT bytes
 *     "sharedAt", "expiresAt",          // ISO 8601 Instant strings
 *     "availableOn": [connectorId-idString],
 *     "connectorRefs": { connectorId-idString: <opaque-server-blob-id> }
 *   }
 *
 * `RemoteBlobRef` is a `@JvmInline value class` over String on the Android side
 * — it serializes as the bare string, so the map value here is `string` not an
 * object.
 *
 * v1: we publish + consume `files` only. `deleteRequests` is read but not
 * issued / consumed (M6 acceptance only covers upload + list + download;
 * delete-flow stays for v2, see plan).
 */
export const FILES_MODULE_ID = "eu.darken.octi.module.core.files";

/** Connector ID format from Android's `ConnectorId.idString`: `"kserver-<domain>-<accountId>"`. */
export function connectorIdString(server: ServerAddress, accountId: string): string {
  return `kserver-${server.domain}-${accountId}`;
}

export interface SharedFile {
  name: string;
  mimeType: string;
  size: number;
  blobKey: string;
  checksum: string;
  sharedAt: string;
  expiresAt: string;
  availableOn: string[];
  connectorRefs: Record<string, string>;
}

export interface DeleteRequest {
  targetDeviceId: string;
  blobKey: string;
  requestedAt: string;
  retainUntil: string;
}

export interface FileShareInfo {
  files: SharedFile[];
  deleteRequests: DeleteRequest[];
}

/** Per-device flattened SharedFile for rendering. */
export interface FileRow {
  ownerDeviceId: string;
  ownerLabel: string;
  file: SharedFile;
}

const EMPTY_FILE_SHARE: FileShareInfo = { files: [], deleteRequests: [] };

export function serializeFileShareInfo(info: FileShareInfo): Uint8Array {
  // Same null-stripping rule as MetaInfo — Android's strict decoder rejects
  // null for fields with non-nullable custom serializers.
  return new TextEncoder().encode(
    JSON.stringify(info, (_k, v) => (v === null ? undefined : v)),
  );
}

export function deserializeFileShareInfo(bytes: Uint8Array): FileShareInfo {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<FileShareInfo>;
  return {
    files: parsed.files ?? [],
    deleteRequests: parsed.deleteRequests ?? [],
  };
}

/**
 * Fetch and decrypt one peer's FileShareInfo. Returns the empty shape (rather
 * than null) when the peer has no payload yet — simplifies the dashboard merge.
 */
export async function fetchPeerFileShareInfo(args: {
  server: ServerAddress;
  creds: AuthCreds;
  crypti: PayloadEncryption;
  peerDeviceId: string;
}): Promise<FileShareInfo> {
  const { info } = await fetchPeerFileShareInfoWithEtag(args);
  return info;
}

async function fetchPeerFileShareInfoWithEtag(args: {
  server: ServerAddress;
  creds: AuthCreds;
  crypti: PayloadEncryption;
  peerDeviceId: string;
}): Promise<{ info: FileShareInfo; etag: string | null }> {
  const result = await readModulePayloadWithEtag({
    server: args.server,
    creds: args.creds,
    targetDeviceId: args.peerDeviceId,
    moduleId: FILES_MODULE_ID,
  });
  if (!result) return { info: EMPTY_FILE_SHARE, etag: null };
  const ad = buildAssociatedData(args.peerDeviceId, FILES_MODULE_ID);
  const plaintext = args.crypti.decrypt(result.bytes, ad);
  return { info: deserializeFileShareInfo(plaintext), etag: result.etag };
}

/**
 * Collect every server blobId referenced by a FileShareInfo from this
 * server's connector. We need to pass the full set on every commit — the
 * server replaces (not merges) the link set, so omitting a previously-linked
 * blob orphans + GCs it.
 */
function collectBlobIdsOnServer(info: FileShareInfo, connectorIdStr: string): string[] {
  const out: string[] = [];
  for (const file of info.files) {
    const ref = file.connectorRefs[connectorIdStr];
    if (ref) out.push(ref);
  }
  return out;
}

export interface UploadResult {
  shared: SharedFile;
}

/**
 * Upload `file` and publish a SharedFile entry on our own FileShareInfo. Steps:
 *
 *   1. Read file bytes
 *   2. SHA-256 of plaintext (used for blobKey + checksum + integrity verify on download)
 *   3. Encrypt with the streaming blob cipher (AAD includes blobKey)
 *   4. Upload encrypted bytes via blob-session API → server blobId
 *   5. Read our own current FileShareInfo
 *   6. Append a fresh SharedFile entry; encrypt + POST module payload
 *
 * Default expiry: 30 days (matches the Android convention).
 */
export async function uploadFile(args: {
  server: ServerAddress;
  creds: AuthCreds;
  crypti: PayloadEncryption;
  blobCipher: BlobCipher;
  record: CredentialRecord;
  file: File;
  onProgress?: (bytes: number, total: number) => void;
}): Promise<UploadResult> {
  const plaintextBytes = new Uint8Array(await args.file.arrayBuffer());
  const plaintextChecksum = await sha256Hex(plaintextBytes);
  const blobKey = `sha256:${plaintextChecksum}`;
  const ciphertext = await args.blobCipher.encrypt(
    plaintextBytes,
    args.record.ownDeviceId,
    FILES_MODULE_ID,
    blobKey,
  );
  const blobId = await uploadBlobBytes({
    server: args.server,
    creds: args.creds,
    version: OCTI_WEB_VERSION,
    targetDeviceId: args.record.ownDeviceId,
    moduleId: FILES_MODULE_ID,
    ciphertext,
    onProgress: args.onProgress,
  });

  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const connectorIdStr = connectorIdString(args.server, args.record.accountId);
  const shared: SharedFile = {
    name: args.file.name || "unnamed",
    mimeType: args.file.type || "application/octet-stream",
    size: plaintextBytes.length,
    blobKey,
    checksum: plaintextChecksum,
    sharedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    availableOn: [connectorIdStr],
    connectorRefs: { [connectorIdStr]: blobId },
  };

  // Read current FileShareInfo + ETag, merge, commit. The PUT path is required
  // here (not the legacy POST): for blob-backed modules the server only keeps
  // blobs alive that are referenced by the latest module commit, so a POST
  // would orphan our just-uploaded blob and the next GC tick would 404 it.
  const { info: current, etag } = await fetchPeerFileShareInfoWithEtag({
    server: args.server,
    creds: args.creds,
    crypti: args.crypti,
    peerDeviceId: args.record.ownDeviceId,
  });
  // De-dupe by blobKey: re-uploading the same content replaces the entry.
  const filtered = current.files.filter((f) => f.blobKey !== blobKey);
  const next: FileShareInfo = {
    files: [...filtered, shared],
    deleteRequests: current.deleteRequests,
  };
  const modulePayloadAad = buildAssociatedData(args.record.ownDeviceId, FILES_MODULE_ID);
  const documentBytes = args.crypti.encrypt(serializeFileShareInfo(next), modulePayloadAad);
  // blobRefs must include every blob the new document references — server
  // *replaces* (doesn't merge) the link set on each commit.
  const allBlobIds = collectBlobIdsOnServer(next, connectorIdStr);
  await commitModule({
    server: args.server,
    creds: args.creds,
    targetDeviceId: args.record.ownDeviceId,
    moduleId: FILES_MODULE_ID,
    documentBytes,
    blobIds: allBlobIds,
    ...(etag ? { ifMatch: etag } : { ifNoneMatchStar: true }),
  });
  return { shared };
}

export interface DownloadedFile {
  bytes: Uint8Array;
  name: string;
  mimeType: string;
}

/**
 * Download + decrypt + verify the SHA-256 of a SharedFile from a chosen
 * connector. Throws on AEAD failure or checksum mismatch — never returns
 * partial/corrupt bytes.
 */
export async function downloadSharedFile(args: {
  server: ServerAddress;
  creds: AuthCreds;
  blobCipher: BlobCipher;
  ownerDeviceId: string;
  file: SharedFile;
}): Promise<DownloadedFile> {
  const connectorIdStr = connectorIdString(args.server, args.creds.accountId);
  const blobId = args.file.connectorRefs[connectorIdStr];
  if (!blobId) {
    throw new Error(
      `File "${args.file.name}" isn't stored on this server (${connectorIdStr}); available on: ${Object.keys(args.file.connectorRefs).join(", ") || "(none)"}`,
    );
  }
  const ciphertext = await downloadBlob({
    server: args.server,
    creds: args.creds,
    version: OCTI_WEB_VERSION,
    targetDeviceId: args.ownerDeviceId,
    moduleId: FILES_MODULE_ID,
    blobId,
  });
  const plaintext = await args.blobCipher.decrypt(
    ciphertext,
    args.ownerDeviceId,
    FILES_MODULE_ID,
    args.file.blobKey,
  );
  const actualChecksum = await sha256Hex(plaintext);
  if (actualChecksum !== args.file.checksum) {
    throw new Error(
      `Checksum mismatch: expected ${args.file.checksum.slice(0, 16)}…, got ${actualChecksum.slice(0, 16)}…`,
    );
  }
  return { bytes: plaintext, name: args.file.name, mimeType: args.file.mimeType };
}
