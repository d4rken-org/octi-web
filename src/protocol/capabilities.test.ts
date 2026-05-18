import { describe, expect, it } from "vitest";

import { OCTI_WEB_CAPABILITIES, OCTI_WEB_CAPABILITIES_HEADER } from "./octi-api";

/**
 * Pin the `Octi-Device-Capabilities` header value. Format and rules mirror
 * the Android client's `Capability`/`CapabilitiesCodec` (octi#309) and the
 * sync-server's `parseCapabilitiesHeader` (octi-server#23). If either of
 * those changes its validation, these assertions are how we notice.
 */
describe("Octi-Device-Capabilities", () => {
  // Mirrors CAPABILITY_TAG_REGEX in HttpExtensions.kt and the client codec.
  const TAG_REGEX = /^[a-z][a-z0-9]*:[A-Za-z0-9._\-]+$/;
  const MAX_TAGS = 64;
  const MAX_TAG_LENGTH = 128;
  const MAX_HEADER_LENGTH = 4096;

  it("declares AES-256-GCM-SIV + the _reported authority marker", () => {
    expect(OCTI_WEB_CAPABILITIES).toContain("encryption:AES256_GCM_SIV");
    expect(OCTI_WEB_CAPABILITIES).toContain("encryption:_reported");
  });

  it("every tag satisfies the server-side regex", () => {
    for (const tag of OCTI_WEB_CAPABILITIES) {
      expect(tag).toMatch(TAG_REGEX);
      expect(tag.length).toBeLessThanOrEqual(MAX_TAG_LENGTH);
    }
  });

  it("is sorted canonically (matches Android CapabilitiesCodec.encode)", () => {
    const sorted = [...OCTI_WEB_CAPABILITIES].sort();
    expect([...OCTI_WEB_CAPABILITIES]).toEqual(sorted);
  });

  it("header is a JSON array of strings within size limits", () => {
    const parsed: unknown = JSON.parse(OCTI_WEB_CAPABILITIES_HEADER);
    expect(Array.isArray(parsed)).toBe(true);
    const arr = parsed as unknown[];
    expect(arr.length).toBeLessThanOrEqual(MAX_TAGS);
    for (const v of arr) expect(typeof v).toBe("string");
    expect(OCTI_WEB_CAPABILITIES_HEADER.length).toBeLessThanOrEqual(MAX_HEADER_LENGTH);
  });
});
