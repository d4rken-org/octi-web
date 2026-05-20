/**
 * Shared between the fetch side (`tools/sync-fixtures.ts`) and the read side
 * (`fixture-loader.ts`). Both need to agree on the effective ref AND the
 * effective cache directory after applying `INTEROP_FIXTURE_OVERRIDES`, or the
 * sync writes one place and the loader reads another.
 */
const SHA40_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const REPO_OWNER_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Code-owned allowlist of upstream sources. Adding a fourth source requires a
 * code change here — cross-repo trust is not a runtime config. The string
 * value is the path under the source repo root that hosts `manifest.json` and
 * the fixture files.
 */
export const SOURCE_PATHS: Readonly<Record<string, string>> = Object.freeze({
  "d4rken-org/octi": "sync-core/src/test/resources/interop",
});

export interface FixtureLock {
  source: string;
  ref: string;
  manifest_sha256: string;
}

/**
 * Resolved fetch target after override merge. `manifestSha256` is null when
 * an override is in effect — there's no committed SHA we could pin against
 * an arbitrary upstream commit, so the manifest's per-file sha256s become
 * the sole trust anchor for that run.
 */
export interface ResolvedSource {
  source: string;
  ref: string;
  manifestSha256: string | null;
}

/**
 * Validate the parsed `FixtureLock` shape. Exposed for `readLock` in
 * `tools/sync-fixtures.ts` and for the loader's module-init read.
 */
export function validateLock(lock: FixtureLock): void {
  if (!REPO_OWNER_RE.test(lock.source)) {
    throw new Error(`fixture-lock.json source must be "<owner>/<repo>", got: ${lock.source}`);
  }
  if (!SHA40_RE.test(lock.ref)) {
    throw new Error(
      `fixture-lock.json ref must be a 40-character commit SHA (no tags / branches accepted), got: ${lock.ref}`,
    );
  }
  if (!SHA256_RE.test(lock.manifest_sha256)) {
    throw new Error(`fixture-lock.json manifest_sha256 must be 64 lowercase hex chars`);
  }
  if (!(lock.source in SOURCE_PATHS)) {
    throw new Error(
      `fixture-lock.json source "${lock.source}" not in code-owned SOURCE_PATHS registry; ` +
        `add it to src/__interop__/sync-ref-resolver.ts if this is a new trusted upstream.`,
    );
  }
}

/**
 * Parse and validate `INTEROP_FIXTURE_OVERRIDES`. Empty/unset → empty map.
 * Every value validation throws — loud failure when the workflow sends a
 * malformed override, not silent fallback to the locked SHA.
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
 * Apply override (if any) on top of the locked ref.
 */
export function resolveSource(
  lock: FixtureLock,
  overrides: Record<string, string>,
): ResolvedSource {
  const overrideRef = overrides[lock.source];
  if (overrideRef !== undefined) {
    return { source: lock.source, ref: overrideRef, manifestSha256: null };
  }
  return { source: lock.source, ref: lock.ref, manifestSha256: lock.manifest_sha256 };
}

/**
 * One-shot: parse env, merge with lock, return resolved source. Both sync
 * (write) and loader (read) call this so they always agree on the effective
 * cache dir.
 */
export function resolveFromEnv(
  lock: FixtureLock,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSource {
  return resolveSource(lock, parseOverrides(env["INTEROP_FIXTURE_OVERRIDES"]));
}
