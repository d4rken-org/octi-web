/**
 * HKDF-SHA256 (RFC 5869) via WebCrypto. Used in two places by the blob crypto stack:
 *
 *  1. `deriveBlobIkm` — derives the 32-byte IKM that drives the streaming cipher
 *     from the account's Tink keyset proto bytes (mirrors Android's
 *     {@link StreamingPayloadCipher} `salt="octi-blob"` / `info="octi-blob-stream-v1"`).
 *  2. Per-message key derivation inside `streaming-aead.ts` — derives the AES-GCM
 *     encryption key for one upload from the message's random salt + the AAD.
 */
export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** Octi-specific outer derivation matching the Android StreamingPayloadCipher constructor. */
export async function deriveBlobIkm(keysetBytes: Uint8Array): Promise<Uint8Array> {
  return hkdfSha256(
    keysetBytes,
    new TextEncoder().encode("octi-blob"),
    new TextEncoder().encode("octi-blob-stream-v1"),
    32,
  );
}
