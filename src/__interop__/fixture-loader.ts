/**
 * Read-side of the cross-repo interop fixture cache. App-main owns the canonical Tink
 * + streaming crypto fixtures under `sync-core/src/test/resources/interop/`; octi-desktop
 * owns the canonical per-module JSON payloads under `src/test/resources/interop/published/`.
 * `tools/sync-fixtures.ts` fetches each source at the resolved SHA (lockfile, possibly
 * overridden by `INTEROP_FIXTURE_OVERRIDES`) and verifies sha256s. This module hands
 * tests the parsed bytes + reconstructed plaintexts.
 *
 * `vitest.config.ts` wires `tools/sync-fixtures.ts` as `globalSetup`, so by the time any
 * test imports from here the cache directories are guaranteed present.
 *
 * **Critical**: both this loader AND the sync go through `resolveAllFromEnv` so they
 * always agree on the effective cache directories. If only one side applied overrides,
 * the upstream-gating CI workflow would either fail (cache miss) or silently test stale
 * lockfile-pinned fixtures.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type FixtureLock,
  type ResolvedSource,
  parseLockJson,
  resolveAllFromEnv,
} from "./sync-ref-resolver";

/** Default source for the legacy single-arg loader. Keeps the crypto tests untouched. */
const DEFAULT_SOURCE = "d4rken-org/octi";

// Repo root is derived from this file's location, NOT process.cwd().
// process.cwd() would mismatch tools/sync-fixtures.ts (which derives root from its own
// location) if vitest is invoked from a subdirectory.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const LOCK_PATH = resolve(REPO_ROOT, "fixture-lock.json");

// parseLockJson validates internally.
const lock = parseLockJson(readFileSync(LOCK_PATH, "utf-8"));

const resolvedAll = resolveAllFromEnv(lock);

/**
 * Per-source effective fetch target. Read this when you need the exact SHA the cache
 * actually points at (e.g. asserting which app-main commit you're verifying against).
 * `manifestSha256` is null under override.
 */
export const INTEROP_RESOLVED_SOURCES: Readonly<Record<string, ResolvedSource>> = Object.freeze(
  resolvedAll,
);

/**
 * Frozen view of the parsed lockfile. Use `INTEROP_LOCK.sources["<owner>/<repo>"]` to
 * read per-source pin metadata.
 */
export const INTEROP_LOCK: Readonly<FixtureLock> = Object.freeze(lock);

function cacheDirFor(source: string): string {
  const [owner, repo] = source.split("/", 2);
  const resolved = resolvedAll[source];
  if (resolved === undefined) {
    throw new Error(
      `source "${source}" not present in fixture-lock.json (known: ${Object.keys(resolvedAll).join(", ")})`,
    );
  }
  return resolve(REPO_ROOT, ".cache", "interop-fixtures", owner, repo, resolved.ref);
}

/** Cache directory for the given source. Use this when you need a custom file read. */
export function interopCacheDir(source: string): string {
  return cacheDirFor(source);
}

/**
 * Load a fixture file from the verified cache as raw bytes. Defaults to the legacy
 * app-main source so the existing crypto tests don't need an explicit source argument.
 */
export function loadInteropBytes(name: string, source: string = DEFAULT_SOURCE): Uint8Array {
  return new Uint8Array(readFileSync(resolve(cacheDirFor(source), name)));
}

/**
 * Load a fixture file and parse it as JSON, with a light schema-drift guard.
 *
 * Asserts the parsed value is a JSON object with `schemaVersion === 1`. Full per-field
 * validation lives in the test files that consume the fixture (they cover semantics:
 * keysetType, vector counts, decrypt-success, etc.). The loader's job is to catch the
 * broadest drift — a v2 schema, a non-object, a truncated file — before the test's
 * first field access silently coerces `undefined` into an empty AAD or similar.
 */
export function loadInteropJson<T>(name: string, source: string = DEFAULT_SOURCE): T {
  const bytes = loadInteropBytes(name, source);
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
  generator?: string;
  files: Record<string, { sha256: string; byteLength?: number }>;
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

/** Per-module fixture file shape published by octi-web + octi-desktop. */
export interface InteropPublishedVector {
  name: string;
  payloadJson: string;
  sha256: string;
  byteLength: number;
}

export interface InteropPublishedModuleFixture {
  schemaVersion: number;
  module: string;
  producer: string;
  note: string;
  vectors: InteropPublishedVector[];
}

/**
 * Re-verify a [InteropPublishedVector]'s self-claimed `sha256` + `byteLength` against
 * the actual `payloadJson` bytes. The producer's self-check pins these at generate
 * time; we re-check on the consumer side so a hand-edit to one of these JSON files
 * (without bumping the producer's manifest) trips here, not silently as a green
 * decode.
 */
export function verifyVectorIntegrity(vector: InteropPublishedVector): void {
  const bytes = new TextEncoder().encode(vector.payloadJson);
  if (vector.byteLength !== bytes.byteLength) {
    throw new Error(
      `vector '${vector.name}': declared byteLength ${vector.byteLength} disagrees with payloadJson bytes ${bytes.byteLength}`,
    );
  }
  const actualSha = sha256Hex(bytes);
  if (vector.sha256 !== actualSha) {
    throw new Error(
      `vector '${vector.name}': declared sha256 ${vector.sha256} disagrees with payloadJson bytes (${actualSha})`,
    );
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
