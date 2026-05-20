/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Channel this bundle was built for. "stable" ships to web.octi.darken.eu/,
   * "canary" ships to web.octi.darken.eu/canary/. Defaults to "stable" when
   * unset (local dev).
   */
  readonly VITE_CHANNEL?: "stable" | "canary";
  /** Full git SHA at build time. "dev" when unset (local dev). */
  readonly VITE_COMMIT_SHA?: string;
  /** Semver assembled by the release pipeline. Empty when unset (falls back to package.json#version). */
  readonly VITE_APP_VERSION?: string;
  /** ISO8601 timestamp captured at build start (auto-injected by vite.config.ts). */
  readonly VITE_BUILT_AT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
