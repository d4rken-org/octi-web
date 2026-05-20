import { defineConfig, loadEnv, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Vite config wires the per-channel build:
 *
 *   VITE_BASE=/         VITE_CHANNEL=stable  → web.octi.darken.eu/
 *   VITE_BASE=/canary/  VITE_CHANNEL=canary  → web.octi.darken.eu/canary/
 *
 * Build-time constants exposed via {@code import.meta.env}:
 *
 *   VITE_CHANNEL      — "stable" | "canary"
 *   VITE_COMMIT_SHA   — git SHA of the build (full)
 *   VITE_APP_VERSION  — semver, e.g. "0.1.0-rc1" or "0.1.0-canary.abc12345"
 *   VITE_BUILT_AT     — ISO8601 timestamp at build start
 *
 * Local dev (none of these set): channel="stable", commit="dev", version=package.json.
 *
 * The {@code channelManifest} plugin reads {@code manifest.template.json} and
 * emits {@code dist/manifest.webmanifest} with channel-correct {@code start_url}/
 * {@code scope}/icon paths. {@code public/manifest.webmanifest} is intentionally
 * absent — the channel-specific one is emitted by the plugin.
 */

/** Inject VITE_BUILT_AT before Vite reads the env, so import.meta.env picks it up. */
process.env.VITE_BUILT_AT = process.env.VITE_BUILT_AT || new Date().toISOString();

function channelManifest(base: string): Plugin {
  return {
    name: "octi-channel-manifest",
    apply: "build",
    // generateBundle runs BEFORE Vite writes the output to disk, so assets
    // emitted here land on disk. writeBundle would be too late.
    generateBundle() {
      const templatePath = resolve(__dirname, "manifest.template.json");
      if (!existsSync(templatePath)) {
        this.warn(`manifest.template.json missing; skipping channel-manifest emit`);
        return;
      }
      const tpl = readFileSync(templatePath, "utf8");
      const out = tpl.replace(/__BASE__/g, base);
      // Sanity check: emitted JSON must parse.
      JSON.parse(out);
      this.emitFile({
        type: "asset",
        fileName: "manifest.webmanifest",
        source: out,
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const base = env.VITE_BASE || "/";
  return {
    base,
    plugins: [svelte(), channelManifest(base)],
    build: {
      target: "es2022",
      sourcemap: true,
    },
    server: {
      port: 5173,
    },
  };
});
