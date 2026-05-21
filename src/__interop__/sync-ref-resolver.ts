/**
 * Shared between the fetch side (`tools/sync-fixtures.ts`) and the read side
 * (`fixture-loader.ts`). Both need to agree on the effective refs AND the
 * effective cache directories per source after applying `INTEROP_FIXTURE_OVERRIDES`,
 * or the sync writes one place and the loader reads another.
 *
 * Mirror of:
 *  - app-common-test/.../testhelpers/interop/SyncRefResolver.kt (app-main side)
 *  - src/test/kotlin/.../interop/SyncRefResolver.kt (octi-desktop side)
 *
 * `SOURCE_PATHS` is subset-based per repo — each consumer lists only the producers
 * it actually consumes. The cross-repo invariant: for any shared source, the path
 * string must agree byte-for-byte across every consumer's map.
 */
export const LOCK_SCHEMA_VERSION = 2;

const SHA40_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const REPO_OWNER_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Code-owned allowlist of upstream sources THIS REPO consumes. Adding a new source
 * requires a coordinated rollout: producer commits + ships its fixtures, then each
 * consumer adds it here. Cross-repo trust is never a runtime config.
 *
 * Value is the path under the source repo root that hosts `manifest.json` + fixture files.
 */
export const SOURCE_PATHS: Readonly<Record<string, string>> = Object.freeze({
  "d4rken-org/octi": "sync-core/src/test/resources/interop",
  "d4rken-org/octi-desktop": "src/test/resources/interop/published",
});

/** Per-source entry in the multi-source v2 lockfile. */
export interface LockedSource {
  ref: string;
  manifest_sha256: string;
}

/** v2 multi-source lockfile shape. */
export interface FixtureLock {
  schemaVersion: number;
  sources: Record<string, LockedSource>;
}

/** Legacy v1 single-source shape — accepted by [parseLockJson] for migration window. */
interface FixtureLockV1 {
  source: string;
  ref: string;
  manifest_sha256: string;
}

/**
 * Resolved fetch target for one source after override merge. `manifestSha256` is
 * null when an override is in effect — there's no committed SHA we could pin
 * against an arbitrary upstream commit, so the manifest's per-file sha256s become
 * the sole trust anchor for that run.
 */
export interface ResolvedSource {
  source: string;
  ref: string;
  manifestSha256: string | null;
}

/**
 * Parse `fixture-lock.json`. Accepts both the v1 single-source flat shape and the
 * v2 multi-source shape; normalizes to v2 internally and runs [validateLock] before
 * returning, so callers never see an unvalidated FixtureLock. The migration window
 * per the plan is "one full PR cycle per consumer" — octi-web migrates to v2 with
 * this PR, but the dual-shape parser tolerates a future revert that hand-edits the
 * lockfile back to v1.
 */
export function parseLockJson(text: string): FixtureLock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `fixture-lock.json is not valid JSON: ${e instanceof Error ? e.message : e}`,
    );
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("fixture-lock.json must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  let normalized: FixtureLock;
  if (!("schemaVersion" in obj)) {
    // Legacy v1: flat fields, no schemaVersion.
    const v1 = obj as Partial<FixtureLockV1>;
    if (
      typeof v1.source !== "string" ||
      typeof v1.ref !== "string" ||
      typeof v1.manifest_sha256 !== "string"
    ) {
      throw new Error("fixture-lock.json (v1 shape) missing required fields");
    }
    normalized = {
      schemaVersion: LOCK_SCHEMA_VERSION,
      sources: { [v1.source]: { ref: v1.ref, manifest_sha256: v1.manifest_sha256 } },
    };
  } else {
    if (obj.schemaVersion !== LOCK_SCHEMA_VERSION) {
      throw new Error(
        `fixture-lock.json schemaVersion ${String(obj.schemaVersion)} not supported; ` +
          `this client knows v${LOCK_SCHEMA_VERSION} (and the legacy v1 unversioned shape)`,
      );
    }
    if (obj.sources == null || typeof obj.sources !== "object" || Array.isArray(obj.sources)) {
      throw new Error("fixture-lock.json sources must be a JSON object");
    }
    // Build a strict FixtureLock instead of casting an opaque object through `unknown`.
    // [validateLock] catches missing/malformed inner fields below.
    const sources: Record<string, LockedSource> = {};
    for (const [name, raw] of Object.entries(obj.sources as Record<string, unknown>)) {
      if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`fixture-lock.json sources["${name}"] must be an object`);
      }
      const entry = raw as Partial<LockedSource>;
      if (typeof entry.ref !== "string" || typeof entry.manifest_sha256 !== "string") {
        throw new Error(`fixture-lock.json sources["${name}"] missing ref / manifest_sha256`);
      }
      sources[name] = { ref: entry.ref, manifest_sha256: entry.manifest_sha256 };
    }
    normalized = { schemaVersion: LOCK_SCHEMA_VERSION, sources };
  }
  validateLock(normalized);
  return normalized;
}

/** Throws on shape drift. */
export function validateLock(lock: FixtureLock): void {
  if (lock.schemaVersion !== LOCK_SCHEMA_VERSION) {
    throw new Error(
      `fixture-lock.json schemaVersion ${lock.schemaVersion} not supported; expected ${LOCK_SCHEMA_VERSION}`,
    );
  }
  const sourceNames = Object.keys(lock.sources);
  if (sourceNames.length === 0) {
    throw new Error("fixture-lock.json sources must not be empty");
  }
  for (const source of sourceNames) {
    const locked = lock.sources[source];
    if (!REPO_OWNER_RE.test(source)) {
      throw new Error(`fixture-lock.json sources key must be "<owner>/<repo>", got: ${source}`);
    }
    if (!(source in SOURCE_PATHS)) {
      throw new Error(
        `fixture-lock.json source "${source}" not in code-owned SOURCE_PATHS registry; ` +
          `add it to sync-ref-resolver.ts if this is a new trusted upstream.`,
      );
    }
    if (!locked || typeof locked !== "object") {
      throw new Error(`fixture-lock.json sources["${source}"] must be an object`);
    }
    if (!SHA40_RE.test(locked.ref)) {
      throw new Error(
        `fixture-lock.json sources["${source}"].ref must be a 40-char lowercase commit SHA, got: ${locked.ref}`,
      );
    }
    if (!SHA256_RE.test(locked.manifest_sha256)) {
      throw new Error(
        `fixture-lock.json sources["${source}"].manifest_sha256 must be 64 lowercase hex chars`,
      );
    }
  }
}

/**
 * Parse and validate `INTEROP_FIXTURE_OVERRIDES`. Empty/unset → empty map.
 * Every value validation throws — loud failure when a workflow sends a malformed
 * override, not silent fallback to the locked SHAs.
 */
export function parseOverrides(envValue: string | undefined): Record<string, string> {
  if (envValue === undefined || envValue.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(envValue);
  } catch (e) {
    throw new Error(
      `INTEROP_FIXTURE_OVERRIDES is not valid JSON: ${e instanceof Error ? e.message : e}`,
    );
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("INTEROP_FIXTURE_OVERRIDES must be a JSON object");
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!REPO_OWNER_RE.test(key)) {
      throw new Error(`INTEROP_FIXTURE_OVERRIDES key must be "<owner>/<repo>", got: ${key}`);
    }
    if (!(key in SOURCE_PATHS)) {
      throw new Error(
        `INTEROP_FIXTURE_OVERRIDES references unknown source "${key}"; ` +
          `must be one of: ${Object.keys(SOURCE_PATHS).join(", ")}`,
      );
    }
    if (typeof value !== "string") {
      throw new Error(
        `INTEROP_FIXTURE_OVERRIDES value for "${key}" must be a string, got ${typeof value}`,
      );
    }
    if (!SHA40_RE.test(value)) {
      throw new Error(
        `INTEROP_FIXTURE_OVERRIDES value for "${key}" must be a 40-char lowercase commit SHA, got: ${value}`,
      );
    }
    out[key] = value;
  }
  return out;
}

/**
 * Apply overrides on top of locked refs. Returns one [ResolvedSource] per lock entry.
 *
 * Throws if an override targets a source allowlisted but not present in this repo's
 * lock — that's a workflow misconfiguration we want to surface loudly. Silent drop
 * would let a cross-repo gate pass green against a lock that doesn't yet know about
 * that source.
 */
export function resolveAll(
  lock: FixtureLock,
  overrides: Record<string, string>,
): Record<string, ResolvedSource> {
  const lockSources = new Set(Object.keys(lock.sources));
  const unknown = Object.keys(overrides).filter((s) => !lockSources.has(s));
  if (unknown.length > 0) {
    throw new Error(
      `INTEROP_FIXTURE_OVERRIDES targets source(s) not present in fixture-lock.json: ` +
        `${unknown.join(", ")}. Known: ${Object.keys(lock.sources).join(", ")}`,
    );
  }
  const out: Record<string, ResolvedSource> = {};
  for (const [source, locked] of Object.entries(lock.sources)) {
    const overrideRef = overrides[source];
    out[source] =
      overrideRef !== undefined
        ? { source, ref: overrideRef, manifestSha256: null }
        : { source, ref: locked.ref, manifestSha256: locked.manifest_sha256 };
  }
  return out;
}

/**
 * One-shot: parse env, merge with lock, return one resolved entry per source. Both
 * sync (write) and loader (read) call this so they always agree on effective cache
 * dirs.
 */
export function resolveAllFromEnv(
  lock: FixtureLock,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, ResolvedSource> {
  return resolveAll(lock, parseOverrides(env["INTEROP_FIXTURE_OVERRIDES"]));
}
