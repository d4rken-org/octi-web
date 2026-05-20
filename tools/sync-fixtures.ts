/**
 * Fetch cross-repo wire-format fixtures into a local cache.
 *
 * Driven by `fixture-lock.json` at the repo root, which pins a full 40-char
 * commit SHA on the upstream source plus the SHA-256 of that commit's
 * `manifest.json`. The manifest then enumerates each fixture file and its own
 * sha256; this script verifies every byte against those hashes before writing
 * to `.cache/interop-fixtures/<sha>/`.
 *
 * **Override path.** Set `INTEROP_FIXTURE_OVERRIDES='{"<owner/repo>":"<sha40>"}'`
 * to force the fetch against an arbitrary commit. Used by the upstream-gating
 * CI workflow so an app-main PR can test what its changes look like to web
 * before merge. The lockfile's `manifest_sha256` doesn't apply to arbitrary
 * SHAs, so we drop that check and rely on the manifest's per-file sha256s
 * (which we fetch fresh every run under override).
 *
 * Invoked both as a vitest globalSetup and as a CLI script (`pnpm fixtures:sync`).
 *
 * Idempotent in the non-override path: a populated, verifying cache skips
 * network access entirely.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type FixtureLock,
  type ResolvedSource,
  resolveFromEnv,
  SOURCE_PATHS,
  validateLock,
} from "../src/__interop__/sync-ref-resolver";

interface ManifestEntry {
  sha256: string;
}

interface Manifest {
  schemaVersion: number;
  source: string;
  generator: string;
  files: Record<string, ManifestEntry>;
}

const SHA256_RE = /^[a-f0-9]{64}$/;
// Filenames: ASCII subset, must end in `.json`, no leading dot, no dot segments,
// no `..`. Subdirs allowed for forward-compat with future module-fixture layouts.
const FIXTURE_FILE_RE = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/;
const RESERVED_FILENAMES = new Set([".sha", "manifest.json"]);

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_RETRIES = 1;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const LOCK_PATH = resolve(REPO_ROOT, "fixture-lock.json");
const CACHE_BASE = resolve(REPO_ROOT, ".cache", "interop-fixtures");

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readLock(): FixtureLock {
  const raw = readFileSync(LOCK_PATH, "utf-8");
  const lock = JSON.parse(raw) as FixtureLock;
  validateLock(lock);
  return lock;
}

function rawBaseUrl(resolved: ResolvedSource): string {
  const path = SOURCE_PATHS[resolved.source];
  if (path === undefined) {
    throw new Error(`source "${resolved.source}" not in SOURCE_PATHS`);
  }
  return `https://raw.githubusercontent.com/${resolved.source}/${resolved.ref}/${path}`;
}

/**
 * Single point of truth for validating fixture bytes against the lockfile (or,
 * under override, against the manifest's self-claimed shape only).
 * Used by BOTH the cold-fetch path and the warm-cache check, so a stale cache
 * can't pass weaker checks than a fresh download.
 */
function parseAndValidateManifest(bytes: Uint8Array, resolved: ResolvedSource): Manifest {
  if (resolved.manifestSha256 !== null && sha256Hex(bytes) !== resolved.manifestSha256) {
    throw new Error(
      `manifest sha256 mismatch — expected ${resolved.manifestSha256}, got ${sha256Hex(bytes)}. ` +
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
  }
  return m as Manifest;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    } catch (e) {
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
  // Under override the cache can't be trusted as the manifest source — we
  // need to refetch the manifest to know what to verify against. Callers must
  // gate this function on `resolved.manifestSha256 !== null`.
  const markerPath = resolve(cacheDir, ".sha");
  if (!existsSync(markerPath)) return false;
  if (readFileSync(markerPath, "utf-8").trim() !== resolved.ref) return false;

  const manifestPath = resolve(cacheDir, "manifest.json");
  if (!existsSync(manifestPath)) return false;
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
    if (sha256Hex(new Uint8Array(readFileSync(filePath))) !== entry.sha256) return false;
  }
  return true;
}

export async function syncFixtures(): Promise<void> {
  const lock = readLock();
  const resolved = resolveFromEnv(lock);
  if (resolved.manifestSha256 === null) {
    console.log(`using override for ${resolved.source}: ${resolved.ref}`);
  }
  const cacheDir = resolve(CACHE_BASE, resolved.ref);

  // Under override (no committed manifest sha to pin against), always re-fetch
  // the manifest. The cache may still have valid bytes, but the manifest must
  // come from the live upstream so it can't be a poisoned local copy.
  if (resolved.manifestSha256 !== null && cacheIsValid(cacheDir, resolved)) {
    console.log(`interop fixtures cache hit: ${resolved.source}@${resolved.ref}`);
    return;
  }

  console.log(`fetching interop fixtures from ${resolved.source}@${resolved.ref}...`);
  mkdirSync(cacheDir, { recursive: true });

  const manifestBytes = await fetchBytes(`${rawBaseUrl(resolved)}/manifest.json`);
  const manifest = parseAndValidateManifest(manifestBytes, resolved);

  writeFileSync(resolve(cacheDir, "manifest.json"), manifestBytes);

  for (const [name, entry] of Object.entries(manifest.files)) {
    // Under override, cached files for this ref may already be valid; skip
    // re-download in that case to spare bandwidth for unchanged blobs.
    const dest = resolve(cacheDir, name);
    if (existsSync(dest)) {
      const cachedSha = sha256Hex(new Uint8Array(readFileSync(dest)));
      if (cachedSha === entry.sha256) {
        console.log(`  ${name} (cached, sha256 ok)`);
        continue;
      }
    }
    const bytes = await fetchBytes(`${rawBaseUrl(resolved)}/${name}`);
    const actual = sha256Hex(bytes);
    if (actual !== entry.sha256) {
      throw new Error(`${name} sha256 mismatch — expected ${entry.sha256}, got ${actual}`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
    console.log(`  ${name} (${bytes.length} bytes, sha256 ok)`);
  }

  // Marker written last so an interrupted run never produces a "valid" cache.
  writeFileSync(resolve(cacheDir, ".sha"), resolved.ref);
  console.log(`interop fixtures synced: ${cacheDir}`);
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
