import pkg from "../package.json";

/**
 * Build-time constants wired through {@code vite.config.ts}. The release
 * pipeline sets {@code VITE_APP_VERSION} + {@code VITE_COMMIT_SHA}; local dev
 * runs without them and gets the {@code package.json}#version + a "dev" sha.
 *
 * The {@code octi-web/} prefix on {@link OCTI_WEB_VERSION} marks our independent
 * release train so the Android peer doesn't apply its own version gates to us
 * (post d4rken-org/octi#308 they're scoped to {@code platform == "android"}).
 *
 * NB: {@code import.meta.env} is populated by Vite at build time. The
 * bootstrap-peer (Node + tsx, no Vite) imports this file too, where
 * {@code import.meta.env} is undefined — hence the {@code as never} cast +
 * optional chain. Result: under Vite we get the injected values; under tsx we
 * get the package.json fallback, which is what bootstrap-peer needs.
 */

const env = ((import.meta as { env?: ImportMetaEnv }).env ?? {}) as Partial<ImportMetaEnv>;

/** Bare semver. Either {@code VITE_APP_VERSION} or {@code package.json#version}. */
export const OCTI_WEB_DISPLAY_VERSION: string =
  env.VITE_APP_VERSION || pkg.version;

/** Wire form sent as {@code Octi-Device-Version} and stored in {@code MetaInfo}. */
export const OCTI_WEB_VERSION: string = `octi-web/${OCTI_WEB_DISPLAY_VERSION}`;

/** Full git SHA at build time. {@code "dev"} when unset locally. */
export const OCTI_WEB_GIT_SHA: string = env.VITE_COMMIT_SHA || "dev";

/**
 * Release channel this bundle was built for.
 *
 *   "stable" → web.octi.darken.eu/        (built from latest tagged release)
 *   "canary" → web.octi.darken.eu/canary/ (built from main HEAD, bleeding edge)
 *
 * Naming follows the cross-vendor convention (Chrome Canary, GitHub canary
 * deploys). Used by {@link credentialsRepo} for storage namespacing and by
 * {@code CanaryBanner.svelte} to render the bleeding-edge callout.
 */
export const OCTI_WEB_CHANNEL: "stable" | "canary" =
  env.VITE_CHANNEL === "canary" ? "canary" : "stable";

/** ISO8601 timestamp captured at build start. Used in build-info diagnostics. */
export const OCTI_WEB_BUILT_AT: string = env.VITE_BUILT_AT || "";

/** Public source repository. Used by UI links (nav version pill, about, canary banner). */
export const OCTI_WEB_REPO_URL: string = "https://github.com/d4rken-org/octi-web";
