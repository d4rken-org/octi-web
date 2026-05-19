/**
 * Pure helpers for displaying the SHA-256 fingerprint of the per-account
 * encryption keyset in Settings. The grouped format is the display form
 * (4-char chunks separated by spaces, easy to compare across devices visually);
 * the canonical form is what the copy button writes to the clipboard.
 */

/**
 * Format a lowercase hex digest into 4-character groups separated by single
 * spaces. Mirrors how SSH key fingerprints used to be presented for visual
 * cross-device comparison.
 *
 * Throws if the input isn't valid lowercase hex of even length.
 */
export function formatFingerprint(hex: string): string {
  if (hex.length === 0) return "";
  if (hex.length % 2 !== 0) {
    throw new Error(`formatFingerprint: hex length is not even (${hex.length})`);
  }
  if (!/^[0-9a-f]+$/.test(hex)) {
    throw new Error("formatFingerprint: input is not lowercase hex");
  }
  const out: string[] = [];
  for (let i = 0; i < hex.length; i += 4) {
    out.push(hex.slice(i, i + 4));
  }
  return out.join(" ");
}

/** Hex-encode a byte array as lowercase, no separators. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}
