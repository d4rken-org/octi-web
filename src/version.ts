/**
 * The version string sent as `Octi-Device-Version` (HTTP header) and
 * `MetaInfo.octiVersionName` (encrypted module payload).
 *
 * Must be a plain `major.minor.patch` semver — Android's
 * {@link eu.darken.octi.sync.core.VersionCompat} parses by stripping at the
 * first `-`, splitting on `.`, and parsing each segment as an int. Anything
 * non-numeric (`octi-web/x`, build metadata, etc.) collapses to `[]` and is
 * treated as version 0.0.0, which trips the "Incompatible encryption" issue
 * because Android requires ≥ 1.0.0 for AES-GCM-SIV accounts.
 *
 * Bump this when octi-web has its own release cadence; until then, "1.0.0"
 * accurately signals "we implement the modern crypto contract".
 */
export const OCTI_WEB_VERSION = "1.0.0";

/** Free-form git SHA placeholder until a real build pipeline injects one. */
export const OCTI_WEB_GIT_SHA = "dev";
