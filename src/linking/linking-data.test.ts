import { describe, expect, it } from "vitest";
import { gzipSync } from "fflate";

import { decodeLinkingData, encodeLinkingData, type LinkingData } from "./linking-data";
import { generateAesGcmSivKeyset } from "../crypto/tink-keyset";

function sampleLinkingData(): LinkingData {
  const { bytes } = generateAesGcmSivKeyset();
  return {
    serverAddress: { domain: "prod.kserver.octi.darken.eu", protocol: "https", port: 443 },
    shareCode: { code: "ABC123" },
    encryptionKeySet: { type: "AES256_GCM_SIV", key: bytes },
  };
}

describe("LinkingData encode/decode", () => {
  it("round-trips a fresh keyset", () => {
    const original = sampleLinkingData();
    const encoded = encodeLinkingData(original);
    const decoded = decodeLinkingData(encoded);

    expect(decoded.serverAddress).toEqual(original.serverAddress);
    expect(decoded.shareCode.code).toBe(original.shareCode.code);
    expect(decoded.encryptionKeySet.type).toBe("AES256_GCM_SIV");
    expect(Array.from(decoded.encryptionKeySet.key)).toEqual(
      Array.from(original.encryptionKeySet.key),
    );
  });

  it("tolerates whitespace around the encoded string", () => {
    // Pasted link codes often pick up surrounding whitespace from copy/paste.
    const encoded = encodeLinkingData(sampleLinkingData());
    expect(() => decodeLinkingData(`  ${encoded}\n`)).not.toThrow();
  });

  it("rejects non-base64 input cleanly", () => {
    expect(() => decodeLinkingData("this is not base64 at all !!!")).toThrow(/base64|gzip|JSON/);
  });

  it("rejects valid base64 that isn't gzip", () => {
    expect(() => decodeLinkingData("aGVsbG8gd29ybGQ=")).toThrow(/gzip/);
  });

  it("rejects malformed JSON shape (missing serverAddress)", () => {
    const badJson = JSON.stringify({
      shareCode: { code: "x" },
      encryptionKeySet: { type: "AES256_GCM_SIV", key: "AAAA" },
    });
    const compressed = gzipSync(new TextEncoder().encode(badJson));
    let s = "";
    for (let i = 0; i < compressed.length; i++) s += String.fromCharCode(compressed[i]);
    const bad = btoa(s);
    expect(() => decodeLinkingData(bad)).toThrow(/serverAddress/);
  });

  it("rejects unknown keyset type", () => {
    const original = sampleLinkingData();
    const tampered: LinkingData = {
      ...original,
      // @ts-expect-error — deliberately invalid type for the negative test
      encryptionKeySet: { type: "BANANA", key: original.encryptionKeySet.key },
    };
    const bad = encodeLinkingData(tampered);
    expect(() => decodeLinkingData(bad)).toThrow(/unknown encryption keyset type/);
  });
});
