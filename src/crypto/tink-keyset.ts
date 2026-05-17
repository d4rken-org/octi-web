/**
 * Hand-rolled reader for the subset of Tink's proto keyset wire format that Octi
 * actually uses: a `Keyset` containing one or more `AesGcmSivKey`s.
 *
 * Tink schema we walk (proto3 wire format):
 *
 *   message Keyset { uint32 primary_key_id = 1; repeated Key key = 2; }
 *   message Key { KeyData key_data = 1; KeyStatusType status = 2;
 *                 uint32 key_id = 3; OutputPrefixType output_prefix_type = 4; }
 *   message KeyData { string type_url = 1; bytes value = 2;
 *                     KeyMaterialType key_material_type = 3; }
 *   message AesGcmSivKey { uint32 version = 1; bytes key_value = 2; }
 *
 * We don't import a proto library — the schema is small, stable, and the parser
 * only needs to handle wire types 0 (varint) and 2 (length-delimited). Unknown
 * fields are skipped per proto3 convention.
 */

export type OutputPrefixType = "TINK" | "RAW" | "LEGACY" | "CRUNCHY" | "UNKNOWN";

export interface TinkKey {
  /** Tink key ID (uint32). Used in the 5-byte AEAD wire prefix and to locate the right key. */
  keyId: number;
  /** TINK = 5-byte 0x01||keyId prefix; RAW = no prefix; LEGACY/CRUNCHY = 0x00||keyId. */
  outputPrefix: OutputPrefixType;
  /** The raw 32-byte AES-256-GCM-SIV key material. */
  keyBytes: Uint8Array;
}

export interface TinkKeyset {
  primaryKeyId: number;
  keys: TinkKey[];
}

const AES_GCM_SIV_TYPE_URL = "type.googleapis.com/google.crypto.tink.AesGcmSivKey";
const TINK_AEAD_PREFIX_SIZE = 5;

class Reader {
  pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  done(): boolean {
    return this.pos >= this.bytes.length;
  }

  /** proto3 base-128 varint, up to 10 bytes (we only see uint32 in this schema, so cap at 5). */
  varint(): number {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.bytes.length) {
        throw new Error("tink-keyset: unexpected EOF reading varint");
      }
      const b = this.bytes[this.pos++];
      // Use logical OR with shift; JS bitwise ops are 32-bit signed, which is fine for our uint32 fields.
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0; // coerce to unsigned
      shift += 7;
    }
    throw new Error("tink-keyset: varint too long");
  }

  /** Read a length-prefixed byte run; returns a non-owning view. */
  lenDelim(): Uint8Array {
    const len = this.varint();
    if (this.pos + len > this.bytes.length) {
      throw new Error("tink-keyset: length-delimited field exceeds buffer");
    }
    const slice = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }

  /** Skip an unknown field per its wire type (proto3 forward-compat rule). */
  skip(wireType: number): void {
    switch (wireType) {
      case 0:
        this.varint();
        return;
      case 1:
        this.pos += 8;
        return;
      case 2:
        this.pos += this.varint();
        return;
      case 5:
        this.pos += 4;
        return;
      default:
        throw new Error(`tink-keyset: unsupported wire type ${wireType}`);
    }
  }
}

function decodeAesGcmSivKey(bytes: Uint8Array): Uint8Array {
  // The public Tink proto (google/tink, tink-crypto/tink-cc) declares
  // `bytes key_value = 2;` but tink-android 1.16.0 emits it at field 3 on the
  // wire. Rather than betting on a specific tag, accept the first length-delimited
  // field whose payload is exactly 32 bytes — AesGcmSivKey's only `bytes` field
  // either way, and any other length-delimited field would not be 32 bytes for
  // an AES-256 key.
  const r = new Reader(bytes);
  let keyValue: Uint8Array | null = null;
  while (!r.done()) {
    const tag = r.varint();
    const wireType = tag & 0x7;
    if (wireType === 2) {
      const candidate = r.lenDelim();
      if (candidate.length === 32 && keyValue === null) {
        keyValue = candidate;
      }
    } else {
      r.skip(wireType);
    }
  }
  if (!keyValue) {
    throw new Error("tink-keyset: AesGcmSivKey has no 32-byte length-delimited field (key_value)");
  }
  return keyValue;
}

function decodeKeyData(bytes: Uint8Array): Uint8Array {
  const r = new Reader(bytes);
  let typeUrl: string | null = null;
  let value: Uint8Array | null = null;
  while (!r.done()) {
    const tag = r.varint();
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;
    if (fieldNum === 1 && wireType === 2) {
      typeUrl = new TextDecoder().decode(r.lenDelim());
    } else if (fieldNum === 2 && wireType === 2) {
      value = r.lenDelim();
    } else {
      r.skip(wireType);
    }
  }
  if (typeUrl !== AES_GCM_SIV_TYPE_URL) {
    throw new Error(
      `tink-keyset: unsupported key type "${typeUrl}" (expected ${AES_GCM_SIV_TYPE_URL}; ` +
        `legacy AES-256-SIV accounts aren't supported by the web client in v1)`,
    );
  }
  if (!value) throw new Error("tink-keyset: KeyData.value missing");
  return decodeAesGcmSivKey(value);
}

function decodeOutputPrefixType(n: number): OutputPrefixType {
  // Tink OutputPrefixType enum values, per
  // https://github.com/tink-crypto/tink/blob/master/proto/tink.proto
  switch (n) {
    case 0:
      return "UNKNOWN";
    case 1:
      return "TINK";
    case 2:
      return "LEGACY";
    case 3:
      return "RAW";
    case 4:
      return "CRUNCHY";
    default:
      return "UNKNOWN";
  }
}

function decodeKey(bytes: Uint8Array): TinkKey {
  const r = new Reader(bytes);
  let keyBytes: Uint8Array | null = null;
  let keyId: number | null = null;
  let outputPrefix: OutputPrefixType = "UNKNOWN";
  while (!r.done()) {
    const tag = r.varint();
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;
    if (fieldNum === 1 && wireType === 2) {
      keyBytes = decodeKeyData(r.lenDelim());
    } else if (fieldNum === 3 && wireType === 0) {
      keyId = r.varint();
    } else if (fieldNum === 4 && wireType === 0) {
      outputPrefix = decodeOutputPrefixType(r.varint());
    } else {
      r.skip(wireType);
    }
  }
  if (!keyBytes) throw new Error("tink-keyset: Keyset.Key.key_data missing");
  if (keyId === null) throw new Error("tink-keyset: Keyset.Key.key_id missing");
  return { keyId, outputPrefix, keyBytes };
}

export function parseTinkKeyset(bytes: Uint8Array): TinkKeyset {
  const r = new Reader(bytes);
  let primaryKeyId: number | null = null;
  const keys: TinkKey[] = [];
  while (!r.done()) {
    const tag = r.varint();
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;
    if (fieldNum === 1 && wireType === 0) {
      primaryKeyId = r.varint();
    } else if (fieldNum === 2 && wireType === 2) {
      keys.push(decodeKey(r.lenDelim()));
    } else {
      r.skip(wireType);
    }
  }
  if (primaryKeyId === null) throw new Error("tink-keyset: Keyset.primary_key_id missing");
  if (keys.length === 0) throw new Error("tink-keyset: Keyset has no keys");
  return { primaryKeyId, keys };
}

/**
 * Returns the primary key from a parsed keyset. Throws if the primary is missing
 * or has an output prefix the AEAD layer can't reproduce.
 */
export function getPrimaryKey(keyset: TinkKeyset): TinkKey {
  const primary = keyset.keys.find((k) => k.keyId === keyset.primaryKeyId);
  if (!primary) {
    throw new Error(`tink-keyset: primary key ${keyset.primaryKeyId} not found in keyset`);
  }
  if (primary.outputPrefix !== "TINK") {
    // Tink AEAD output prefix governs the on-the-wire bytes; supporting RAW/LEGACY
    // means switching prefix handling per key. Android's AesGcmSivKeyManager.aes256GcmSivTemplate()
    // produces TINK-prefixed keys, so every Octi-generated account hits this path.
    throw new Error(
      `tink-keyset: unsupported output prefix "${primary.outputPrefix}" (only TINK is supported)`,
    );
  }
  return primary;
}

/**
 * Build the 5-byte Tink AEAD wire prefix: `0x01 || keyId(4 bytes big-endian)`.
 * The recipient uses this to locate the right key in a multi-key keyset.
 */
export function tinkAeadPrefix(keyId: number): Uint8Array {
  const out = new Uint8Array(TINK_AEAD_PREFIX_SIZE);
  out[0] = 0x01;
  out[1] = (keyId >>> 24) & 0xff;
  out[2] = (keyId >>> 16) & 0xff;
  out[3] = (keyId >>> 8) & 0xff;
  out[4] = keyId & 0xff;
  return out;
}

/**
 * Inverse of {@link tinkAeadPrefix}. Throws if the prefix byte isn't 0x01 or the
 * key ID doesn't match the supplied primary.
 */
export function readTinkAeadPrefix(bytes: Uint8Array, expectedKeyId: number): void {
  if (bytes.length < TINK_AEAD_PREFIX_SIZE) {
    throw new Error("tink-keyset: ciphertext shorter than Tink AEAD prefix");
  }
  if (bytes[0] !== 0x01) {
    throw new Error(`tink-keyset: expected TINK prefix byte 0x01, got 0x${bytes[0].toString(16)}`);
  }
  const keyId =
    ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) >>> 0;
  if (keyId !== expectedKeyId) {
    throw new Error(
      `tink-keyset: ciphertext key ID ${keyId} doesn't match primary ${expectedKeyId}`,
    );
  }
}

export const TINK_AEAD_PREFIX_LEN = TINK_AEAD_PREFIX_SIZE;

// =============================================================================
// Writer (serializer) — emits the same wire shape we read, so a freshly-minted
// keyset round-trips through parseTinkKeyset and is interoperable with Android.
// =============================================================================

class Writer {
  private chunks: number[] = [];

  varint(n: number): void {
    let v = n >>> 0;
    while (v > 0x7f) {
      this.chunks.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    this.chunks.push(v & 0x7f);
  }

  tag(fieldNum: number, wireType: number): void {
    this.varint((fieldNum << 3) | wireType);
  }

  lenDelim(bytes: Uint8Array): void {
    this.varint(bytes.length);
    for (let i = 0; i < bytes.length; i++) this.chunks.push(bytes[i]);
  }

  toBytes(): Uint8Array {
    return new Uint8Array(this.chunks);
  }
}

function encodeAesGcmSivKey(key32: Uint8Array): Uint8Array {
  if (key32.length !== 32) throw new Error("encodeAesGcmSivKey: key must be 32 bytes");
  // Field number for key_value is 3 in the tink-android 1.16.0 wire (see decodeAesGcmSivKey
  // comment for the upstream-mismatch note). Stay consistent with the reader.
  const w = new Writer();
  w.tag(3, 2);
  w.lenDelim(key32);
  return w.toBytes();
}

function encodeKeyData(key32: Uint8Array): Uint8Array {
  const w = new Writer();
  // field 1: type_url
  w.tag(1, 2);
  w.lenDelim(new TextEncoder().encode(AES_GCM_SIV_TYPE_URL));
  // field 2: value (serialized AesGcmSivKey)
  w.tag(2, 2);
  w.lenDelim(encodeAesGcmSivKey(key32));
  // field 3: key_material_type = SYMMETRIC (1)
  w.tag(3, 0);
  w.varint(1);
  return w.toBytes();
}

function encodeKey(keyId: number, key32: Uint8Array): Uint8Array {
  const w = new Writer();
  // field 1: key_data
  w.tag(1, 2);
  w.lenDelim(encodeKeyData(key32));
  // field 2: status = ENABLED (1)
  w.tag(2, 0);
  w.varint(1);
  // field 3: key_id
  w.tag(3, 0);
  w.varint(keyId);
  // field 4: output_prefix_type = TINK (1)
  w.tag(4, 0);
  w.varint(1);
  return w.toBytes();
}

/**
 * Serialize a `TinkKeyset` back to the proto bytes the Android client expects
 * (same shape `TinkProtoKeysetFormat.serializeKeyset` emits). Used both for
 * freshly-generated keysets and to round-trip parsed ones.
 *
 * Restriction: only single-key, AES-256-GCM-SIV, TINK-prefix keysets are
 * supported — the only shape the web client mints and the only shape it accepts
 * from a linked Android device.
 */
export function serializeTinkKeyset(keyset: TinkKeyset): Uint8Array {
  if (keyset.keys.length !== 1) {
    throw new Error("serializeTinkKeyset: only single-key keysets are supported");
  }
  const key = keyset.keys[0];
  if (key.outputPrefix !== "TINK") {
    throw new Error(`serializeTinkKeyset: unsupported output prefix "${key.outputPrefix}"`);
  }
  if (key.keyBytes.length !== 32) {
    throw new Error(`serializeTinkKeyset: AES-256 key must be 32 bytes, got ${key.keyBytes.length}`);
  }
  if (key.keyId !== keyset.primaryKeyId) {
    throw new Error(
      `serializeTinkKeyset: single-key keyset's key_id (${key.keyId}) must equal primary_key_id (${keyset.primaryKeyId})`,
    );
  }
  const w = new Writer();
  // field 1: primary_key_id
  w.tag(1, 0);
  w.varint(keyset.primaryKeyId);
  // field 2: Key
  w.tag(2, 2);
  w.lenDelim(encodeKey(key.keyId, key.keyBytes));
  return w.toBytes();
}

/**
 * Generate a fresh AES-256-GCM-SIV keyset for a brand-new account. Returns both
 * the in-memory parsed form (handy for immediate use) and the wire bytes
 * (which is what goes into LinkingData / persistence).
 */
export function generateAesGcmSivKeyset(): { keyset: TinkKeyset; bytes: Uint8Array } {
  const key32 = new Uint8Array(32);
  crypto.getRandomValues(key32);
  // Tink uses random non-zero uint32 key IDs. Generate 4 random bytes and
  // resample until non-zero (vanishingly unlikely loop but defensive).
  let keyId = 0;
  const idBuf = new Uint8Array(4);
  while (keyId === 0) {
    crypto.getRandomValues(idBuf);
    keyId = ((idBuf[0] << 24) | (idBuf[1] << 16) | (idBuf[2] << 8) | idBuf[3]) >>> 0;
  }
  const keyset: TinkKeyset = {
    primaryKeyId: keyId,
    keys: [{ keyId, outputPrefix: "TINK", keyBytes: key32 }],
  };
  return { keyset, bytes: serializeTinkKeyset(keyset) };
}
