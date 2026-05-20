/**
 * Read-side of the cross-repo interop fixture cache. App-main owns the canonical
 * JSON under `sync-core/src/test/resources/interop/`; `tools/sync-fixtures.ts`
 * fetches it at the resolved SHA (lockfile, possibly overridden by
 * `INTEROP_FIXTURE_OVERRIDES`) and verifies sha256s. This module hands tests
 * the parsed bytes + reconstructed plaintexts.
 *
 * `vitest.config.ts` wires `tools/sync-fixtures.ts` as `globalSetup`, so by the
 * time any test imports from here the cache directory is guaranteed present.
 *
 * **Critical**: both this loader AND the sync go through `resolveFromEnv` so
 * they always agree on the effective cache directory. If only one side applied
 * overrides, the upstream-gating CI workflow would either fail (cache miss) or
 * silently test stale lockfile-pinned fixtures.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type FixtureLock,
  type ResolvedSource,
  resolveFromEnv,
  validateLock,
} from "./sync-ref-resolver";

// Repo root is derived from this file's location, NOT process.cwd().
// process.cwd() would mismatch tools/sync-fixtures.ts (which derives root from
// its own location) if vitest is invoked from a subdirectory.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const LOCK_PATH = resolve(REPO_ROOT, "fixture-lock.json");

const lock = JSON.parse(readFileSync(LOCK_PATH, "utf-8")) as FixtureLock;
validateLock(lock);

const resolved = resolveFromEnv(lock);

export const INTEROP_CACHE_DIR = resolve(REPO_ROOT, ".cache", "interop-fixtures", resolved.ref);
export const INTEROP_LOCK: Readonly<FixtureLock> = Object.freeze(lock);
/**
 * The effective source for this run — lockfile ref, or the override from
 * `INTEROP_FIXTURE_OVERRIDES` if one was active. Read `INTEROP_RESOLVED_SOURCE.ref`
 * rather than `INTEROP_LOCK.ref` if you want the SHA that the cache actually
 * points at. `manifestSha256` is null under override.
 */
export const INTEROP_RESOLVED_SOURCE: Readonly<ResolvedSource> = Object.freeze(resolved);

/** Load a fixture file from the verified cache as raw bytes. */
export function loadInteropBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(INTEROP_CACHE_DIR, name)));
}

/**
 * Load a fixture file and parse it as JSON, with a light schema-drift guard.
 *
 * Asserts the parsed value is a JSON object with `schemaVersion === 1`. Full
 * per-field validation lives in the test files that consume the fixture (they
 * cover semantics: keysetType, vector counts, decrypt-success, etc.). The
 * loader's job is to catch the broadest drift — a v2 schema, a non-object, a
 * truncated file — before the test's first field access silently coerces
 * `undefined` into an empty AAD or similar.
 */
export function loadInteropJson<T>(name: string): T {
  const bytes = loadInteropBytes(name);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    throw new Error(`fixture ${name} is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`fixture ${name} is not a JSON object`);
  }
  const schemaVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion !== 1) {
    throw new Error(
      `fixture ${name} schemaVersion ${String(schemaVersion)} not supported (this client knows v1)`,
    );
  }
  return parsed as T;
}

/**
 * Reconstruct the plaintext of a streaming vector that uses a `plaintextPattern`
 * reference instead of inline base64. Mirror of app-main's
 * `InteropFixtures.materializePattern` — if a new `kind` is added there, mirror it
 * here AND in octi-desktop's port, or the cross-repo pin fails.
 */
export function materializeStreamingPlaintext(pattern: {
  kind: string;
  size: number;
}): Uint8Array {
  switch (pattern.kind) {
    case "sequential":
      return Uint8Array.from({ length: pattern.size }, (_, i) => i & 0xff);
    default:
      throw new Error(`unknown plaintextPattern.kind=${pattern.kind}`);
  }
}

/* ──────────────── Typed views of the committed JSON schemas ──────────────── */

export interface InteropManifest {
  schemaVersion: number;
  source: string;
  generator: string;
  files: Record<string, { sha256: string }>;
}

export interface InteropPayloadVector {
  name: string;
  plaintextBase64: string;
  /** UTF-8 string. Empty for legacy SIV by construction. */
  aad: string;
  ciphertextBase64: string;
}

export interface InteropKeysetBlock {
  keysetType: string;
  keysetBase64: string;
  vectors: InteropPayloadVector[];
}

export interface InteropTinkVectors {
  schemaVersion: number;
  note: string;
  gcmsiv: InteropKeysetBlock;
  siv: InteropKeysetBlock;
}

export interface InteropStreamingPattern {
  kind: string;
  size: number;
}

export interface InteropStreamingVector {
  name: string;
  aad: string;
  /** Set for small vectors. Mutually exclusive with [plaintextPattern]. */
  plaintextBase64?: string;
  /** Set for large vectors. Mutually exclusive with [plaintextBase64]. */
  plaintextPattern?: InteropStreamingPattern;
  plaintextSize: number;
  ciphertextBase64: string;
  ciphertextSize: number;
}

export interface InteropStreamingVectors {
  schemaVersion: number;
  note: string;
  keysetType: string;
  keysetBase64: string;
  vectors: InteropStreamingVector[];
}
