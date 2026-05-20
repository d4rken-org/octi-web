import { buildAssociatedData, type PayloadEncryption } from "../crypto/payload";
import { type BlobCipher } from "../crypto/blob-cipher";
import { sha256Hex } from "../protocol/blob-session";
import type { OctiServerConnector } from "../protocol/octi-server-connector";

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
 *
 * Connector-id format on the wire is `kserver-<domain>-<accountId>` — produced
 * once at credential creation time and stored on the record as
 * `OctiServerCredentialRecord.connectorId`. Read it via `connector.connectorId`.
 */
export const FILES_MODULE_ID = "eu.darken.octi.module.core.files";

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

export interface FetchPeerFileShareInfoResult {
  /** Decoded FileShareInfo (empty shape rather than null on no-payload — simplifies merge). */
  info: FileShareInfo;
  /** Server-side modification timestamp (parsed from `X-Modified-At`), or null on no-payload / missing header. */
  modifiedAt: Date | null;
}

/**
 * Fetch and decrypt one peer's FileShareInfo. Returns the empty shape (rather
 * than null) when the peer has no payload yet — simplifies the dashboard merge.
 */
export async function fetchPeerFileShareInfo(args: {
  connector: OctiServerConnector;
  crypti: PayloadEncryption;
  peerDeviceId: string;
}): Promise<FetchPeerFileShareInfoResult> {
  const { info, modifiedAt } = await fetchPeerFileShareInfoWithEtag(args);
  return { info, modifiedAt };
}

async function fetchPeerFileShareInfoWithEtag(args: {
  connector: OctiServerConnector;
  crypti: PayloadEncryption;
  peerDeviceId: string;
}): Promise<{ info: FileShareInfo; etag: string | null; modifiedAt: Date | null }> {
  const result = await args.connector.readModulePayloadWithEtag({
    targetDeviceId: args.peerDeviceId,
    moduleId: FILES_MODULE_ID,
  });
  if (!result) return { info: EMPTY_FILE_SHARE, etag: null, modifiedAt: null };
  const ad = buildAssociatedData(args.peerDeviceId, FILES_MODULE_ID);
  const plaintext = args.crypti.decrypt(result.bytes, ad);
  return {
    info: deserializeFileShareInfo(plaintext),
    etag: result.etag,
    modifiedAt: result.modifiedAt,
  };
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
 * Read `file` to bytes, hash, and encrypt + upload its blob to ONE connector.
 * The blobKey is the SHA-256 of the plaintext (`sha256:<hex>`) and is shared
 * across connectors — peer downloaders use it as the AAD for the streaming
 * AEAD verify so the bytes can be authenticated regardless of which connector
 * served them.
 *
 * Returns the connector-issued blob id. The manager calls this in parallel
 * for every active connector, then assembles a single multi-ref SharedFile
 * via {@link buildSharedFile} and publishes it via
 * {@link publishSharedFileEntry} once per connector.
 */
export async function uploadFileBlobToConnector(args: {
  connector: OctiServerConnector;
  blobCipher: BlobCipher;
  plaintextBytes: Uint8Array;
  blobKey: string;
  onProgress?: (bytes: number, total: number) => void;
}): Promise<{ blobId: string }> {
  const ownDeviceId = args.connector.ownDeviceId;
  const ciphertext = await args.blobCipher.encrypt(
    args.plaintextBytes,
    ownDeviceId,
    FILES_MODULE_ID,
    args.blobKey,
  );
  const blobId = await args.connector.uploadBlobBytes({
    targetDeviceId: ownDeviceId,
    moduleId: FILES_MODULE_ID,
    ciphertext,
    onProgress: args.onProgress,
  });
  return { blobId };
}

/**
 * Build a {@link SharedFile} entry whose `availableOn` and `connectorRefs`
 * span every connector the blob was successfully uploaded to. Pure /
 * side-effect-free — the actual per-connector publish happens via
 * {@link publishSharedFileEntry}.
 */
export function buildSharedFile(args: {
  file: File;
  plaintextSize: number;
  blobKey: string;
  plaintextChecksum: string;
  uploads: ReadonlyArray<{ connectorId: string; blobId: string }>;
}): SharedFile {
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const connectorRefs: Record<string, string> = {};
  for (const u of args.uploads) connectorRefs[u.connectorId] = u.blobId;
  return {
    name: args.file.name || "unnamed",
    mimeType: args.file.type || "application/octet-stream",
    size: args.plaintextSize,
    blobKey: args.blobKey,
    checksum: args.plaintextChecksum,
    sharedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    availableOn: args.uploads.map((u) => u.connectorId),
    connectorRefs,
  };
}

/**
 * Read THIS connector's current own-device FileShareInfo, splice in `shared`
 * (de-duping by `blobKey`), and commit the merged document back.
 *
 * The `blobIds` precondition on the commit is the union of blob ids ON THIS
 * connector — the server replaces (doesn't merge) its blob link set on each
 * commit, so any blob we don't list gets GC'd.
 *
 * The PUT commit path (not legacy POST) is mandatory for blob-backed modules:
 * POST doesn't link blobs, so referenced blobs age out after the complete-
 * state TTL and downloads return 404.
 */
export async function publishSharedFileEntry(args: {
  connector: OctiServerConnector;
  crypti: PayloadEncryption;
  shared: SharedFile;
}): Promise<void> {
  const ownDeviceId = args.connector.ownDeviceId;
  const connectorIdStr = args.connector.connectorId;
  const { info: current, etag } = await fetchPeerFileShareInfoWithEtag({
    connector: args.connector,
    crypti: args.crypti,
    peerDeviceId: ownDeviceId,
  });
  // De-dupe by blobKey: re-uploading the same content replaces the entry.
  const filtered = current.files.filter((f) => f.blobKey !== args.shared.blobKey);
  const next: FileShareInfo = {
    files: [...filtered, args.shared],
    deleteRequests: current.deleteRequests,
  };
  const modulePayloadAad = buildAssociatedData(ownDeviceId, FILES_MODULE_ID);
  const documentBytes = args.crypti.encrypt(serializeFileShareInfo(next), modulePayloadAad);
  const allBlobIds = collectBlobIdsOnServer(next, connectorIdStr);
  await args.connector.commitModule({
    targetDeviceId: ownDeviceId,
    moduleId: FILES_MODULE_ID,
    documentBytes,
    blobIds: allBlobIds,
    ...(etag ? { ifMatch: etag } : { ifNoneMatchStar: true }),
  });
}

/**
 * Single-connector convenience wrapper (the pre-multi-connector entry point)
 * — preserves the existing `uploadFile({connector, crypti, blobCipher, file})`
 * call shape so tests + any straggling callers keep working. The dashboard +
 * `ConnectorManager.uploadFile` use the two-phase
 * {@link uploadFileBlobToConnector} + {@link publishSharedFileEntry} pair
 * directly for fan-out.
 */
export async function uploadFile(args: {
  connector: OctiServerConnector;
  crypti: PayloadEncryption;
  blobCipher: BlobCipher;
  file: File;
  onProgress?: (bytes: number, total: number) => void;
}): Promise<UploadResult> {
  const plaintextBytes = new Uint8Array(await args.file.arrayBuffer());
  const plaintextChecksum = await sha256Hex(plaintextBytes);
  const blobKey = `sha256:${plaintextChecksum}`;
  const { blobId } = await uploadFileBlobToConnector({
    connector: args.connector,
    blobCipher: args.blobCipher,
    plaintextBytes,
    blobKey,
    onProgress: args.onProgress,
  });
  const shared = buildSharedFile({
    file: args.file,
    plaintextSize: plaintextBytes.length,
    blobKey,
    plaintextChecksum,
    uploads: [{ connectorId: args.connector.connectorId, blobId }],
  });
  await publishSharedFileEntry({ connector: args.connector, crypti: args.crypti, shared });
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
  connector: OctiServerConnector;
  blobCipher: BlobCipher;
  ownerDeviceId: string;
  file: SharedFile;
}): Promise<DownloadedFile> {
  const connectorIdStr = args.connector.connectorId;
  const blobId = args.file.connectorRefs[connectorIdStr];
  if (!blobId) {
    throw new Error(
      `File "${args.file.name}" isn't stored on this server (${connectorIdStr}); available on: ${Object.keys(args.file.connectorRefs).join(", ") || "(none)"}`,
    );
  }
  const ciphertext = await args.connector.downloadBlob({
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
