import { describe, expect, it } from "vitest";

import {
  type FixtureLock,
  LOCK_SCHEMA_VERSION,
  parseLockJson,
  parseOverrides,
  resolveAll,
  resolveAllFromEnv,
  SOURCE_PATHS,
  validateLock,
} from "./sync-ref-resolver";

const VALID_SHA40 = "a".repeat(40);
const ALT_SHA40 = "b".repeat(40);
const VALID_SHA256 = "a".repeat(64);

const LOCKED_REF_A = "c".repeat(40);
const LOCKED_REF_B = "d".repeat(40);

function validLock(sources?: FixtureLock["sources"]): FixtureLock {
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    sources: sources ?? {
      "d4rken-org/octi": { ref: LOCKED_REF_A, manifest_sha256: VALID_SHA256 },
    },
  };
}

describe("parseLockJson", () => {
  it("accepts a well-formed v2 multi-source shape", () => {
    const json = JSON.stringify({
      schemaVersion: 2,
      sources: {
        "d4rken-org/octi": { ref: LOCKED_REF_A, manifest_sha256: VALID_SHA256 },
        "d4rken-org/octi-desktop": { ref: LOCKED_REF_B, manifest_sha256: VALID_SHA256 },
      },
    });
    const lock = parseLockJson(json);
    expect(lock.schemaVersion).toBe(2);
    expect(Object.keys(lock.sources).sort()).toEqual([
      "d4rken-org/octi",
      "d4rken-org/octi-desktop",
    ]);
    expect(lock.sources["d4rken-org/octi"].ref).toBe(LOCKED_REF_A);
    expect(lock.sources["d4rken-org/octi-desktop"].ref).toBe(LOCKED_REF_B);
  });

  it("accepts legacy v1 flat shape and normalizes to v2", () => {
    // Migration-window safety net: a future revert that hand-edits the lockfile back
    // to v1 still parses. Mirror of octi-desktop's TS-equivalent parser.
    const json = JSON.stringify({
      source: "d4rken-org/octi",
      ref: LOCKED_REF_A,
      manifest_sha256: VALID_SHA256,
    });
    const lock = parseLockJson(json);
    expect(lock.schemaVersion).toBe(LOCK_SCHEMA_VERSION);
    expect(lock.sources["d4rken-org/octi"]).toEqual({
      ref: LOCKED_REF_A,
      manifest_sha256: VALID_SHA256,
    });
  });

  it("rejects an unknown schemaVersion", () => {
    const json = JSON.stringify({ schemaVersion: 99, sources: {} });
    expect(() => parseLockJson(json)).toThrow(/schemaVersion 99 not supported/);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseLockJson("{not json")).toThrow(/not valid JSON/);
  });
});

describe("validateLock", () => {
  it("accepts a well-formed v2 lock", () => {
    expect(() => validateLock(validLock())).not.toThrow();
  });

  it("accepts a multi-source v2 lock", () => {
    expect(() =>
      validateLock(
        validLock({
          "d4rken-org/octi": { ref: LOCKED_REF_A, manifest_sha256: VALID_SHA256 },
          "d4rken-org/octi-desktop": { ref: LOCKED_REF_B, manifest_sha256: VALID_SHA256 },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects an empty sources map", () => {
    expect(() => validateLock(validLock({}))).toThrow(/sources must not be empty/);
  });

  it("rejects an unsupported schemaVersion", () => {
    expect(() => validateLock({ ...validLock(), schemaVersion: 1 })).toThrow(/not supported/);
  });

  it("rejects malformed owner/repo", () => {
    expect(() =>
      validateLock(validLock({ "no-slash": { ref: LOCKED_REF_A, manifest_sha256: VALID_SHA256 } })),
    ).toThrow(/<owner>\/<repo>/);
  });

  it("rejects bad ref shape", () => {
    expect(() =>
      validateLock(validLock({ "d4rken-org/octi": { ref: "abc", manifest_sha256: VALID_SHA256 } })),
    ).toThrow(/40-char lowercase commit SHA/);
    expect(() =>
      validateLock(
        validLock({
          "d4rken-org/octi": { ref: VALID_SHA40.toUpperCase(), manifest_sha256: VALID_SHA256 },
        }),
      ),
    ).toThrow(/40-char lowercase commit SHA/);
  });

  it("rejects bad manifest_sha256 shape", () => {
    expect(() =>
      validateLock(
        validLock({ "d4rken-org/octi": { ref: LOCKED_REF_A, manifest_sha256: "abc" } }),
      ),
    ).toThrow(/64 lowercase hex chars/);
  });

  it("rejects source not in SOURCE_PATHS registry", () => {
    expect(() =>
      validateLock(
        validLock({ "some/other-repo": { ref: LOCKED_REF_A, manifest_sha256: VALID_SHA256 } }),
      ),
    ).toThrow(/SOURCE_PATHS registry/);
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

  it("parses a valid multi-source override", () => {
    const env = JSON.stringify({
      "d4rken-org/octi": VALID_SHA40,
      "d4rken-org/octi-desktop": ALT_SHA40,
    });
    expect(parseOverrides(env)).toEqual({
      "d4rken-org/octi": VALID_SHA40,
      "d4rken-org/octi-desktop": ALT_SHA40,
    });
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
});

describe("resolveAll", () => {
  it("with no overrides keeps locked ref + manifestSha256", () => {
    const resolved = resolveAll(validLock(), {});
    expect(resolved["d4rken-org/octi"]).toEqual({
      source: "d4rken-org/octi",
      ref: LOCKED_REF_A,
      manifestSha256: VALID_SHA256,
    });
  });

  it("applies an override and drops the manifestSha256 trust anchor", () => {
    const resolved = resolveAll(validLock(), { "d4rken-org/octi": ALT_SHA40 });
    expect(resolved["d4rken-org/octi"]).toEqual({
      source: "d4rken-org/octi",
      ref: ALT_SHA40,
      manifestSha256: null,
    });
  });

  it("resolves each source independently in a multi-source lock", () => {
    const lock = validLock({
      "d4rken-org/octi": { ref: LOCKED_REF_A, manifest_sha256: VALID_SHA256 },
      "d4rken-org/octi-desktop": { ref: LOCKED_REF_B, manifest_sha256: VALID_SHA256 },
    });
    const resolved = resolveAll(lock, { "d4rken-org/octi-desktop": ALT_SHA40 });
    expect(resolved["d4rken-org/octi"].ref).toBe(LOCKED_REF_A);
    expect(resolved["d4rken-org/octi"].manifestSha256).toBe(VALID_SHA256);
    expect(resolved["d4rken-org/octi-desktop"].ref).toBe(ALT_SHA40);
    expect(resolved["d4rken-org/octi-desktop"].manifestSha256).toBeNull();
  });

  it("throws when override targets a source not present in the lock", () => {
    // Workflow misconfiguration guard: an override for an allowlisted-but-not-yet-locked
    // source must fail loudly, not silently fall back.
    expect(() =>
      resolveAll(validLock(), { "d4rken-org/octi-desktop": ALT_SHA40 }),
    ).toThrow(/sources?\(s\)? not present in fixture-lock/);
  });
});

describe("resolveAllFromEnv", () => {
  it("returns the locked source when env is empty", () => {
    const resolved = resolveAllFromEnv(validLock(), {});
    expect(resolved["d4rken-org/octi"].ref).toBe(LOCKED_REF_A);
    expect(resolved["d4rken-org/octi"].manifestSha256).toBe(VALID_SHA256);
  });

  it("returns the override-resolved source when env has a matching override", () => {
    const env = {
      INTEROP_FIXTURE_OVERRIDES: JSON.stringify({ "d4rken-org/octi": ALT_SHA40 }),
    };
    const resolved = resolveAllFromEnv(validLock(), env);
    expect(resolved["d4rken-org/octi"].ref).toBe(ALT_SHA40);
    expect(resolved["d4rken-org/octi"].manifestSha256).toBeNull();
  });

  it("propagates parseOverrides failures (no silent fallback)", () => {
    expect(() =>
      resolveAllFromEnv(validLock(), { INTEROP_FIXTURE_OVERRIDES: "not json" }),
    ).toThrow(/not valid JSON/);
  });
});

describe("SOURCE_PATHS registry invariants", () => {
  it("contains both producer entries", () => {
    expect(SOURCE_PATHS).toHaveProperty("d4rken-org/octi");
    expect(SOURCE_PATHS).toHaveProperty("d4rken-org/octi-desktop");
  });

  it("every value is a relative path", () => {
    for (const [source, path] of Object.entries(SOURCE_PATHS)) {
      expect(path).not.toMatch(/^\//);
      expect(path).not.toMatch(/\.\./);
      expect(path.length).toBeGreaterThan(0);
      expect(source).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    }
  });
});
