import { describe, expect, it } from "vitest";

import {
  parseOverrides,
  resolveFromEnv,
  resolveSource,
  SOURCE_PATHS,
  validateLock,
  type FixtureLock,
} from "./sync-ref-resolver";

const VALID_SHA40 = "a".repeat(40);
const ALT_SHA40 = "b".repeat(40);
const VALID_SHA256 = "a".repeat(64);

const LOCKED_REF = "c".repeat(40);
const LOCK: FixtureLock = {
  source: "d4rken-org/octi",
  ref: LOCKED_REF,
  manifest_sha256: VALID_SHA256,
};

describe("validateLock", () => {
  it("accepts a well-formed lock", () => {
    expect(() => validateLock(LOCK)).not.toThrow();
  });

  it("rejects malformed owner/repo", () => {
    expect(() => validateLock({ ...LOCK, source: "no-slash" })).toThrow(/<owner>\/<repo>/);
  });

  it("rejects bad ref shape", () => {
    expect(() => validateLock({ ...LOCK, ref: "abc" })).toThrow(/40-character commit SHA/);
    expect(() => validateLock({ ...LOCK, ref: VALID_SHA40.toUpperCase() })).toThrow(/40-character commit SHA/);
  });

  it("rejects bad manifest_sha256 shape", () => {
    expect(() => validateLock({ ...LOCK, manifest_sha256: "abc" })).toThrow(/64 lowercase hex chars/);
  });

  it("rejects source not in SOURCE_PATHS registry", () => {
    expect(() => validateLock({ ...LOCK, source: "some/other-repo" })).toThrow(/SOURCE_PATHS registry/);
  });
});

describe("parseOverrides", () => {
  it("returns empty map for undefined env value", () => {
    expect(parseOverrides(undefined)).toEqual({});
  });

  it("returns empty map for empty / whitespace env value", () => {
    expect(parseOverrides("")).toEqual({});
    expect(parseOverrides("   ")).toEqual({});
  });

  it("parses a valid single-source override", () => {
    const env = JSON.stringify({ "d4rken-org/octi": VALID_SHA40 });
    expect(parseOverrides(env)).toEqual({ "d4rken-org/octi": VALID_SHA40 });
  });

  it("throws on non-JSON env value", () => {
    expect(() => parseOverrides("not json")).toThrow(/not valid JSON/);
  });

  it("throws on non-object JSON (array, null, primitive)", () => {
    expect(() => parseOverrides("[]")).toThrow(/must be a JSON object/);
    expect(() => parseOverrides("null")).toThrow(/must be a JSON object/);
    expect(() => parseOverrides('"string"')).toThrow(/must be a JSON object/);
  });

  it("throws on key not in SOURCE_PATHS registry", () => {
    const env = JSON.stringify({ "unknown/repo": VALID_SHA40 });
    expect(() => parseOverrides(env)).toThrow(/references unknown source/);
  });

  it("throws on key that doesn't match owner/repo shape", () => {
    const env = JSON.stringify({ "no-slash": VALID_SHA40 });
    expect(() => parseOverrides(env)).toThrow(/<owner>\/<repo>/);
  });

  it("throws on non-string value", () => {
    const env = JSON.stringify({ "d4rken-org/octi": 42 });
    expect(() => parseOverrides(env)).toThrow(/must be a string/);
  });

  it("throws on value that isn't a 40-char lowercase sha", () => {
    expect(() =>
      parseOverrides(JSON.stringify({ "d4rken-org/octi": "abc" })),
    ).toThrow(/40-char lowercase commit SHA/);
    expect(() =>
      parseOverrides(JSON.stringify({ "d4rken-org/octi": "A".repeat(40) })),
    ).toThrow(/40-char lowercase commit SHA/);
    expect(() =>
      parseOverrides(JSON.stringify({ "d4rken-org/octi": "z".repeat(40) })),
    ).toThrow(/40-char lowercase commit SHA/);
  });

  it("accepts any 40 lowercase hex chars (existence not checked here)", () => {
    expect(parseOverrides(JSON.stringify({ "d4rken-org/octi": "0".repeat(40) }))).toEqual({
      "d4rken-org/octi": "0".repeat(40),
    });
  });
});

describe("resolveSource", () => {
  it("falls through to the lockfile ref + sha when no override matches", () => {
    expect(resolveSource(LOCK, {})).toEqual({
      source: "d4rken-org/octi",
      ref: LOCKED_REF,
      manifestSha256: VALID_SHA256,
    });
  });

  it("applies override + drops manifestSha256 when source matches", () => {
    const overrides = { "d4rken-org/octi": ALT_SHA40 };
    expect(resolveSource(LOCK, overrides)).toEqual({
      source: "d4rken-org/octi",
      ref: ALT_SHA40,
      manifestSha256: null,
    });
  });

  it("ignores override keys that don't match the lock's source", () => {
    const overrides = { "some-other/repo": ALT_SHA40 };
    expect(resolveSource(LOCK, overrides)).toEqual({
      source: "d4rken-org/octi",
      ref: LOCKED_REF,
      manifestSha256: VALID_SHA256,
    });
  });
});

describe("resolveFromEnv", () => {
  it("returns the locked source when env is empty", () => {
    expect(resolveFromEnv(LOCK, {})).toEqual({
      source: "d4rken-org/octi",
      ref: LOCKED_REF,
      manifestSha256: VALID_SHA256,
    });
  });

  it("returns the override-resolved source when env has a matching override", () => {
    // This is the regression test Codex flagged — the cache dir derived from
    // this result MUST match the sync's write target so consumer reads find
    // the override-cached files instead of stale locked-ref files.
    const env = {
      INTEROP_FIXTURE_OVERRIDES: JSON.stringify({ "d4rken-org/octi": ALT_SHA40 }),
    };
    expect(resolveFromEnv(LOCK, env)).toEqual({
      source: "d4rken-org/octi",
      ref: ALT_SHA40,
      manifestSha256: null,
    });
  });

  it("propagates parseOverrides failures (no silent fallback)", () => {
    expect(() =>
      resolveFromEnv(LOCK, { INTEROP_FIXTURE_OVERRIDES: "not json" }),
    ).toThrow(/not valid JSON/);
  });
});

describe("SOURCE_PATHS registry invariants", () => {
  it("contains the current upstream", () => {
    expect(SOURCE_PATHS).toHaveProperty("d4rken-org/octi");
  });

  it("every value is a relative path containing 'interop'", () => {
    for (const [source, path] of Object.entries(SOURCE_PATHS)) {
      expect(path).not.toMatch(/^\//);
      expect(path).not.toMatch(/\.\./);
      expect(path.length).toBeGreaterThan(0);
      expect(path).toContain("interop");
      expect(source).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    }
  });
});
