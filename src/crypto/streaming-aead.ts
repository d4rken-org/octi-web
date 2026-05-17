import { hkdfSha256 } from "./hkdf";

/**
 * TypeScript port of Tink's `AesGcmHkdfStreaming` with the parameters Octi pins
 * for blob encryption:
 *
 *   AesGcmHkdfStreaming(ikm, "HmacSha256", keySizeInBytes=32,
 *                       ciphertextSegmentSize=1 MiB, firstSegmentOffset=0)
 *
 * Wire layout (per Tink's streaming AEAD spec):
 *
 *   header := header_length(1) || salt(32) || nonce_prefix(7)        // 40 bytes
 *   for each plaintext segment p_i (i = 0, 1, ..., n-1):
 *     nonce_i := nonce_prefix || segment_counter_i(4 BE) || last_flag(1)
 *     c_i     := AES-GCM(enc_key, nonce_i, p_i)   // includes 16-byte auth tag
 *   wire := header || c_0 || c_1 || ... || c_{n-1}
 *
 * Plaintext segment sizes:
 *   |p_0|         = SEGMENT_SIZE - HEADER_SIZE - FIRST_SEGMENT_OFFSET - TAG_SIZE   = 1 048 520
 *   |p_i| (i > 0) = SEGMENT_SIZE - TAG_SIZE                                        = 1 048 560
 *
 * Per-encryption AES key derivation:
 *   enc_key = HKDF-SHA256(ikm, salt=salt_from_header, info=associated_data, len=32)
 *
 * The `associated_data` is consumed by HKDF, NOT by AES-GCM's additionalData.
 * Pin both sides to that contract or decryption silently authenticates the wrong
 * data.
 *
 * Wire compatibility with Android is pinned by `streaming-aead.test.ts` against
 * fixtures emitted by `StreamingCipherVectorsExportTest` (JVM Tink).
 */

const SEGMENT_SIZE = 1024 * 1024;
const KEY_SIZE = 32;
const NONCE_PREFIX_SIZE = 7;
const HEADER_SIZE = 1 + KEY_SIZE + NONCE_PREFIX_SIZE; // 40
const TAG_SIZE = 16;
const FIRST_SEGMENT_OFFSET = 0;

const PLAINTEXT_FIRST_SEGMENT = SEGMENT_SIZE - HEADER_SIZE - FIRST_SEGMENT_OFFSET - TAG_SIZE;
const PLAINTEXT_NEXT_SEGMENT = SEGMENT_SIZE - TAG_SIZE;
const CIPHERTEXT_FIRST_SEGMENT = SEGMENT_SIZE - HEADER_SIZE - FIRST_SEGMENT_OFFSET;
const CIPHERTEXT_NEXT_SEGMENT = SEGMENT_SIZE;

/** Returns the wire size of the ciphertext produced for `plaintextSize` bytes. */
export function expectedCiphertextSize(plaintextSize: number): number {
  if (plaintextSize < 0) throw new Error("plaintextSize must be non-negative");
  if (plaintextSize === 0) {
    // Even an empty plaintext gets a header + one segment containing just the GCM tag.
    return HEADER_SIZE + TAG_SIZE;
  }
  // Number of segments after the first one (each holding PLAINTEXT_NEXT_SEGMENT bytes).
  let remaining = plaintextSize - PLAINTEXT_FIRST_SEGMENT;
  if (remaining <= 0) {
    return HEADER_SIZE + plaintextSize + TAG_SIZE;
  }
  const tailSegments = Math.ceil(remaining / PLAINTEXT_NEXT_SEGMENT);
  return HEADER_SIZE + PLAINTEXT_FIRST_SEGMENT + TAG_SIZE + remaining + tailSegments * TAG_SIZE;
}

/**
 * Streaming AEAD encrypt. Returns the full wire-format ciphertext. For very
 * large inputs this is RAM-heavy; the Android side streams chunks through, but
 * the web client only needs files up to the server's `maxBlobBytes` cap (10 MiB
 * default), so an in-memory implementation is fine.
 */
export async function streamingAeadEncrypt(
  ikm: Uint8Array,
  plaintext: Uint8Array,
  associatedData: Uint8Array,
): Promise<Uint8Array> {
  const salt = randomBytes(KEY_SIZE);
  const noncePrefix = randomBytes(NONCE_PREFIX_SIZE);
  const encKey = await importAesGcmKey(await hkdfSha256(ikm, salt, associatedData, KEY_SIZE));

  const segments = chunkPlaintext(plaintext);
  const wire = new Uint8Array(expectedCiphertextSize(plaintext.length));
  let off = 0;
  // Header
  wire[off++] = HEADER_SIZE;
  wire.set(salt, off);
  off += KEY_SIZE;
  wire.set(noncePrefix, off);
  off += NONCE_PREFIX_SIZE;
  // Segments
  for (let i = 0; i < segments.length; i++) {
    const isLast = i === segments.length - 1;
    const nonce = buildNonce(noncePrefix, i, isLast);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: new Uint8Array(0) },
        encKey,
        segments[i],
      ),
    );
    wire.set(ct, off);
    off += ct.length;
  }
  if (off !== wire.length) {
    throw new Error(`streaming encrypt size mismatch: wrote ${off}, expected ${wire.length}`);
  }
  return wire;
}

/**
 * Streaming AEAD decrypt. Throws on any segment that fails AES-GCM
 * authentication. Returns the full plaintext.
 */
export async function streamingAeadDecrypt(
  ikm: Uint8Array,
  wire: Uint8Array,
  associatedData: Uint8Array,
): Promise<Uint8Array> {
  if (wire.length < HEADER_SIZE + TAG_SIZE) {
    throw new Error(`ciphertext too short: ${wire.length} bytes (min ${HEADER_SIZE + TAG_SIZE})`);
  }
  const headerLength = wire[0];
  if (headerLength !== HEADER_SIZE) {
    throw new Error(`unexpected header length: ${headerLength} (expected ${HEADER_SIZE})`);
  }
  const salt = wire.subarray(1, 1 + KEY_SIZE);
  const noncePrefix = wire.subarray(1 + KEY_SIZE, HEADER_SIZE);
  const encKey = await importAesGcmKey(await hkdfSha256(ikm, salt, associatedData, KEY_SIZE));

  const body = wire.subarray(HEADER_SIZE);
  // Walk segments: the first one is shorter (header + offset eats into its space).
  const segments: Uint8Array[] = [];
  let pos = 0;
  // First segment ciphertext is CIPHERTEXT_FIRST_SEGMENT bytes, or all of body if shorter.
  const firstSegLen = Math.min(CIPHERTEXT_FIRST_SEGMENT, body.length);
  segments.push(body.subarray(pos, pos + firstSegLen));
  pos += firstSegLen;
  while (pos < body.length) {
    const len = Math.min(CIPHERTEXT_NEXT_SEGMENT, body.length - pos);
    segments.push(body.subarray(pos, pos + len));
    pos += len;
  }

  const plaintext = new Uint8Array(plaintextSizeFromCiphertext(body.length));
  let outOff = 0;
  for (let i = 0; i < segments.length; i++) {
    const isLast = i === segments.length - 1;
    const nonce = buildNonce(noncePrefix, i, isLast);
    let segPt: Uint8Array;
    try {
      segPt = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: nonce, additionalData: new Uint8Array(0) },
          encKey,
          segments[i],
        ),
      );
    } catch (e) {
      throw new Error(`segment ${i} failed AEAD authentication: ${e instanceof Error ? e.message : String(e)}`);
    }
    plaintext.set(segPt, outOff);
    outOff += segPt.length;
  }
  return plaintext.subarray(0, outOff);
}

function plaintextSizeFromCiphertext(bodyLen: number): number {
  // Cap the allocation; we resize via subarray at the end. Conservative upper bound.
  return bodyLen;
}

function chunkPlaintext(plaintext: Uint8Array): Uint8Array[] {
  if (plaintext.length === 0) {
    return [new Uint8Array(0)];
  }
  const out: Uint8Array[] = [];
  let pos = 0;
  const first = Math.min(PLAINTEXT_FIRST_SEGMENT, plaintext.length);
  out.push(plaintext.subarray(pos, pos + first));
  pos += first;
  while (pos < plaintext.length) {
    const next = Math.min(PLAINTEXT_NEXT_SEGMENT, plaintext.length - pos);
    out.push(plaintext.subarray(pos, pos + next));
    pos += next;
  }
  return out;
}

function buildNonce(prefix: Uint8Array, segmentIndex: number, isLast: boolean): Uint8Array {
  if (prefix.length !== NONCE_PREFIX_SIZE) {
    throw new Error(`nonce prefix must be ${NONCE_PREFIX_SIZE} bytes`);
  }
  if (segmentIndex < 0 || segmentIndex > 0xffffffff) {
    throw new Error(`segment index out of uint32 range: ${segmentIndex}`);
  }
  const out = new Uint8Array(12);
  out.set(prefix, 0);
  // segment counter: 4 bytes big-endian
  out[7] = (segmentIndex >>> 24) & 0xff;
  out[8] = (segmentIndex >>> 16) & 0xff;
  out[9] = (segmentIndex >>> 8) & 0xff;
  out[10] = segmentIndex & 0xff;
  out[11] = isLast ? 0x01 : 0x00;
  return out;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

async function importAesGcmKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// Re-export the layout constants for tests/diagnostics.
export const STREAMING_AEAD = {
  SEGMENT_SIZE,
  KEY_SIZE,
  NONCE_PREFIX_SIZE,
  HEADER_SIZE,
  TAG_SIZE,
  PLAINTEXT_FIRST_SEGMENT,
  PLAINTEXT_NEXT_SEGMENT,
} as const;
