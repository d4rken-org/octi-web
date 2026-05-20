/**
 * Generate thumbnail PNGs for every `screenshots/full-*.png`. Run after a
 * Playwright capture pass so README + Pages stay in sync with the latest
 * screenshots.
 *
 * Source-of-truth strategy:
 *   - For every `full-*.png` → emit `thumb-*.png` at width 600.
 *   - For every `thumb-*.png` whose matching `full-*.png` is missing, delete
 *     the orphan. Prevents stale thumbs from sticking around after a rename.
 *
 * Pure Node ESM — invoked via `node scripts/generate-thumbs.mjs`, no tsx
 * needed. Sharp does the resize. PNG → PNG, no quality knob (sharp picks
 * sensible defaults for lossless PNG output).
 */

import { mkdir, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";

const SCREENSHOTS_DIR = resolve(process.cwd(), "screenshots");
const THUMB_WIDTH = 600;

async function main() {
  if (!existsSync(SCREENSHOTS_DIR)) {
    await mkdir(SCREENSHOTS_DIR, { recursive: true });
    console.log(`[thumbs] no screenshots/ dir; created empty one — nothing to thumbnail`);
    return;
  }

  const files = await readdir(SCREENSHOTS_DIR);
  const fulls = files.filter((f) => f.startsWith("full-") && f.endsWith(".png"));
  const thumbs = files.filter((f) => f.startsWith("thumb-") && f.endsWith(".png"));

  // Prune orphan thumbs (full was renamed/removed).
  for (const t of thumbs) {
    const expectedFull = t.replace(/^thumb-/, "full-");
    if (!fulls.includes(expectedFull)) {
      const path = resolve(SCREENSHOTS_DIR, t);
      await unlink(path);
      console.log(`[thumbs] pruned orphan ${t}`);
    }
  }

  if (fulls.length === 0) {
    console.log("[thumbs] no full-*.png found; nothing to do");
    return;
  }

  for (const f of fulls) {
    const out = f.replace(/^full-/, "thumb-");
    const fullPath = resolve(SCREENSHOTS_DIR, f);
    const thumbPath = resolve(SCREENSHOTS_DIR, out);
    await sharp(fullPath).resize({ width: THUMB_WIDTH }).toFile(thumbPath);
    console.log(`[thumbs] ${f} → ${out}`);
  }

  console.log(`[thumbs] generated ${fulls.length} thumbnails (width ${THUMB_WIDTH})`);
}

main().catch((e) => {
  console.error("[thumbs] FAILED:", e);
  process.exit(1);
});
