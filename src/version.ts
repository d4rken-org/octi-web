import pkg from "../package.json";

/**
 * The version string sent as `Octi-Device-Version` (HTTP header) and
 * `MetaInfo.octiVersionName` (encrypted module payload).
 *
 * Format: `octi-web/<semver>`. The `octi-web/` prefix marks our independent
 * release train so the Android peer doesn't apply its own version gates to
 * us (post d4rken-org/octi#308 they're scoped to `platform == "android"`).
 *
 * Bump by editing `package.json`'s `version` field — both Vite's prod build
 * and Vitest pick it up through TypeScript's resolveJsonModule.
 */
export const OCTI_WEB_VERSION: string = `octi-web/${pkg.version}`;

/** Bare semver without the `octi-web/` prefix — shown in nav UI pills etc. */
export const OCTI_WEB_DISPLAY_VERSION: string = pkg.version;

/** Placeholder until a real build pipeline injects a git SHA. */
export const OCTI_WEB_GIT_SHA = "dev";
