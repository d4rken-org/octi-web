/**
 * Fetch cross-repo wire-format fixtures into a local cache.
 *
 * Driven by `fixture-lock.json` at the repo root, which pins one entry per upstream
 * source (`d4rken-org/octi`, `d4rken-org/octi-desktop`). Each entry has a 40-char
 * commit SHA + the SHA-256 of that commit's `manifest.json`. The manifest enumerates
 * each fixture file and its own sha256; this script verifies every byte against
 * those hashes before writing to `.cache/interop-fixtures/<owner>/<repo>/<sha>/`.
 *
 * **Override path.** Set `INTEROP_FIXTURE_OVERRIDES='{"<owner/repo>":"<sha40>"}'`
 * to force one source's fetch against an arbitrary commit. Used by the upstream-
 * gating CI workflows so a producer PR can test what its changes look like to web
 * before merge. The lockfile's `manifest_sha256` doesn't apply to arbitrary SHAs,
 * so we drop that check for overridden sources and rely on the manifest's per-file
 * sha256s (which we fetch fresh every run under override).
 *
 * Invoked both as a vitest globalSetup and as a CLI script (`pnpm fixtures:sync`).
 *
 * Idempotent in the non-override path: a populated, verifying cache skips network
 * access entirely.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type FixtureLock,
  type ResolvedSource,
  parseLockJson,
  resolveAllFromEnv,
  SOURCE_PATHS,
} from "../src/__interop__/sync-ref-resolver";

interface ManifestEntry {
  sha256: string;
  byteLength?: number;
}

interface Manifest {
  schemaVersion: number;
  source: string;
  generator?: string;
  files: Record<string, ManifestEntry>;
}

const SHA256_RE = /^[a-f0-9]{64}$/;
// Filenames: ASCII subset, must end in `.json`, no leading dot, no dot segments,
// no `..`. Subdirs allowed for forward-compat with future module-fixture layouts.
const FIXTURE_FILE_RE = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/;
const RESERVED_FILENAMES = new Set([".sha", "manifest.json"]);

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_RETRIES = 1;

/** Manifest size cap. 64 KiB is far above the realistic ceiling (~1 KiB today). */
const MAX_MANIFEST_BYTES = 64 * 1024;
/**
 * Per-file size cap. 2 MiB covers app-main's largest committed `streaming-vectors.json`
 * (~1.4 MiB — the two-segment streaming AEAD vector). Other producers' fixtures are all
 * <10 KiB so the cap is unconstrained there.
 */
const MAX_FIXTURE_BYTES = 2 * 1024 * 1024;
/** Cap on file count to bound iteration on a hostile manifest. */
const MAX_MANIFEST_FILES = 32;
/** Lockfile size cap. User-owned but bound it anyway. */
const MAX_LOCKFILE_BYTES = 16 * 1024;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const LOCK_PATH = resolve(REPO_ROOT, "fixture-lock.json");
const CACHE_BASE = resolve(REPO_ROOT, ".cache", "interop-fixtures");

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readLock(): FixtureLock {
  const stat = statSync(LOCK_PATH);
  if (stat.size > MAX_LOCKFILE_BYTES) {
    throw new Error(
      `fixture-lock.json is unexpectedly large (${stat.size} bytes); cap is ${MAX_LOCKFILE_BYTES}`,
    );
  }
  const raw = readFileSync(LOCK_PATH, "utf-8");
  // parseLockJson validates internally.
  return parseLockJson(raw);
}

function cacheDirFor(resolved: ResolvedSource): string {
  const [owner, repo] = resolved.source.split("/", 2);
  return resolve(CACHE_BASE, owner, repo, resolved.ref);
}

function rawBaseUrl(resolved: ResolvedSource): string {
  const path = SOURCE_PATHS[resolved.source];
  if (path === undefined) {
    throw new Error(`source "${resolved.source}" not in SOURCE_PATHS`);
  }
  return `https://raw.githubusercontent.com/${resolved.source}/${resolved.ref}/${path}`;
}

/**
 * Single source of truth for validating fixture bytes against the lockfile (or, under
 * override, against the manifest's self-claimed shape only). Used by BOTH the cold-
 * fetch path and the warm-cache check, so a stale cache can't pass weaker checks than
 * a fresh download.
 */
function parseAndValidateManifest(bytes: Uint8Array, resolved: ResolvedSource): Manifest {
  if (resolved.manifestSha256 !== null && sha256Hex(bytes) !== resolved.manifestSha256) {
    throw new Error(
      `manifest sha256 mismatch for ${resolved.source} — expected ${resolved.manifestSha256}, got ${sha256Hex(bytes)}. ` +
        `Either the lockfile is stale or the upstream history was rewritten.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    throw new Error(`manifest.json is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("manifest.json is not a JSON object");
  }
  const m = parsed as Partial<Manifest>;
  if (m.schemaVersion !== 1) {
    throw new Error(`unsupported manifest schemaVersion ${String(m.schemaVersion)}; this client knows v1`);
  }
  if (m.source !== resolved.source) {
    throw new Error(
      `manifest source ${String(m.source)} disagrees with resolved source ${resolved.source}`,
    );
  }
  if (!m.files || typeof m.files !== "object" || Array.isArray(m.files)) {
    throw new Error("manifest.files must be an object");
  }
  const fileCount = Object.keys(m.files).length;
  if (fileCount > MAX_MANIFEST_FILES) {
    throw new Error(`manifest declares ${fileCount} files; cap is ${MAX_MANIFEST_FILES}`);
  }
  for (const [name, entry] of Object.entries(m.files)) {
    if (!FIXTURE_FILE_RE.test(name)) {
      throw new Error(`manifest contains invalid file name: ${name}`);
    }
    if (name.split("/").some((seg) => seg === "." || seg === "..")) {
      throw new Error(`manifest contains path-traversal file name: ${name}`);
    }
    if (RESERVED_FILENAMES.has(name)) {
      throw new Error(`manifest references reserved file name: ${name}`);
    }
    if (!entry || typeof entry !== "object" || !SHA256_RE.test((entry as ManifestEntry).sha256)) {
      throw new Error(`manifest entry for ${name} missing valid sha256`);
    }
    // byteLength is optional (app-main's manifest omits it; octi-web/octi-desktop set it).
    // When present, it must be a non-negative integer; we re-check against fetched bytes below.
    const declaredLen = (entry as ManifestEntry).byteLength;
    if (declaredLen !== undefined) {
      if (!Number.isInteger(declaredLen) || declaredLen < 0) {
        throw new Error(`manifest entry for ${name} has invalid byteLength: ${String(declaredLen)}`);
      }
    }
  }
  return m as Manifest;
}

/** Sentinel thrown for deterministic failures the retry loop must not paper over. */
class DeterministicFetchError extends Error {}

async function fetchBytes(url: string, maxBytes: number): Promise<Uint8Array> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      // 4xx is deterministic (bad ref / typo'd path / private repo). Don't retry —
      // surface the real cause.
      if (res.status >= 400 && res.status < 500) {
        throw new DeterministicFetchError(`GET ${url} → HTTP ${res.status} (4xx, not retried)`);
      }
      if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
      // Stream-bound the read so a hostile or mis-pinned upstream can't burn arbitrary
      // memory/network before we notice. fetch's arrayBuffer() would buffer the whole
      // response first.
      if (res.body === null) throw new Error(`GET ${url} returned no body`);
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          // Deterministic: same upstream bytes on retry would trip the same cap.
          throw new DeterministicFetchError(
            `response from ${url} exceeds ${maxBytes} bytes (read >= ${total} so far)`,
          );
        }
        chunks.push(value);
      }
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
      }
      return merged;
    } catch (e) {
      if (e instanceof DeterministicFetchError) throw e;
      lastErr = e;
      if (attempt < FETCH_RETRIES) {
        const reason = e instanceof Error ? e.message : String(e);
        console.warn(`  fetch failed (${reason}); retrying...`);
      }
    }
  }
  throw new Error(
    `GET ${url} failed after ${FETCH_RETRIES + 1} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

function cacheIsValid(cacheDir: string, resolved: ResolvedSource): boolean {
  // Only trust the cache if every file the manifest references is present AND
  // hashes correctly AND the manifest itself passes the same schema validation
  // a cold fetch would. Partial / poisoned caches must re-download.
  //
  // Under override the cache can't be trusted as the manifest source — we need
  // to refetch the manifest to know what to verify against. Callers must gate
  // this function on `resolved.manifestSha256 !== null`.
  const markerPath = resolve(cacheDir, ".sha");
  if (!existsSync(markerPath)) return false;
  if (statSync(markerPath).size > 128) return false;
  if (readFileSync(markerPath, "utf-8").trim() !== resolved.ref) return false;

  const manifestPath = resolve(cacheDir, "manifest.json");
  if (!existsSync(manifestPath)) return false;
  if (statSync(manifestPath).size > MAX_MANIFEST_BYTES) return false;
  const manifestBytes = new Uint8Array(readFileSync(manifestPath));

  let manifest: Manifest;
  try {
    manifest = parseAndValidateManifest(manifestBytes, resolved);
  } catch {
    return false;
  }

  for (const [name, entry] of Object.entries(manifest.files)) {
    const filePath = resolve(cacheDir, name);
    if (!existsSync(filePath)) return false;
    const stat = statSync(filePath);
    if (stat.size > MAX_FIXTURE_BYTES) return false;
    if (entry.byteLength !== undefined && entry.byteLength !== stat.size) return false;
    if (sha256Hex(new Uint8Array(readFileSync(filePath))) !== entry.sha256) return false;
  }
  return true;
}

async function syncOne(resolved: ResolvedSource): Promise<void> {
  const cacheDir = cacheDirFor(resolved);

  // Under override (no committed manifest sha to pin against), always re-fetch
  // the manifest. The cache may still have valid bytes, but the manifest must
  // come from the live upstream so it can't be a poisoned local copy.
  if (resolved.manifestSha256 !== null && cacheIsValid(cacheDir, resolved)) {
    console.log(`interop fixtures cache hit: ${resolved.source}@${resolved.ref}`);
    return;
  }

  console.log(`fetching interop fixtures from ${resolved.source}@${resolved.ref}...`);
  mkdirSync(cacheDir, { recursive: true });

  const manifestBytes = await fetchBytes(`${rawBaseUrl(resolved)}/manifest.json`, MAX_MANIFEST_BYTES);
  const manifest = parseAndValidateManifest(manifestBytes, resolved);

  writeFileSync(resolve(cacheDir, "manifest.json"), manifestBytes);

  for (const [name, entry] of Object.entries(manifest.files)) {
    // Under override, cached files for this ref may already be valid; skip
    // re-download to spare bandwidth on unchanged blobs.
    const dest = resolve(cacheDir, name);
    if (existsSync(dest) && statSync(dest).size <= MAX_FIXTURE_BYTES) {
      const cachedSha = sha256Hex(new Uint8Array(readFileSync(dest)));
      if (cachedSha === entry.sha256) {
        console.log(`  ${name} (cached, sha256 ok)`);
        continue;
      }
    }
    const bytes = await fetchBytes(`${rawBaseUrl(resolved)}/${name}`, MAX_FIXTURE_BYTES);
    const actual = sha256Hex(bytes);
    if (actual !== entry.sha256) {
      throw new Error(`${name} sha256 mismatch — expected ${entry.sha256}, got ${actual}`);
    }
    if (entry.byteLength !== undefined && entry.byteLength !== bytes.byteLength) {
      throw new Error(
        `${name} byteLength mismatch — manifest says ${entry.byteLength}, fetched ${bytes.byteLength}`,
      );
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
    console.log(`  ${name} (${bytes.length} bytes, sha256 ok)`);
  }

  // Marker written last so an interrupted run never produces a "valid" cache.
  writeFileSync(resolve(cacheDir, ".sha"), resolved.ref);
  console.log(`interop fixtures synced: ${cacheDir}`);
}

export async function syncFixtures(): Promise<void> {
  const lock = readLock();
  const resolved = resolveAllFromEnv(lock);
  for (const r of Object.values(resolved)) {
    if (r.manifestSha256 === null) {
      console.log(`using override for ${r.source}: ${r.ref}`);
    }
  }
  // Sync sources sequentially so logs are interleaved-free and rate-limit pressure is
  // bounded. Two HTTP fetches per source today, so the difference vs parallel is small.
  for (const r of Object.values(resolved)) {
    await syncOne(r);
  }
}

// vitest globalSetup contract.
export default async function setup() {
  await syncFixtures();
}

// CLI entrypoint when invoked via `tsx tools/sync-fixtures.ts`.
const invokedAsCli =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  syncFixtures().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
