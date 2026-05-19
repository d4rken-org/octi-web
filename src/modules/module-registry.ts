import type { ComponentType, SvelteComponent } from "svelte";
import { CLIPBOARD_MODULE_ID, deserializeClipboardInfo } from "./clipboard";
import { FILES_MODULE_ID, deserializeFileShareInfo } from "./files";
import { META_MODULE_ID, deserializeMetaInfo } from "./meta";
import { POWER_MODULE_ID, decodePowerInfo } from "./power";
import { WIFI_MODULE_ID, decodeWifiInfo } from "./wifi";
import { CONNECTIVITY_MODULE_ID, decodeConnectivityInfo } from "./connectivity";
import { APPS_MODULE_ID, decodeAppsInfo } from "./apps";

// Re-export module IDs from the registry so consumers (TileGrid, DeviceCard,
// dashboard refresh) can pull all of them from one place without each
// file-import knowing about the per-module file layout.
export {
  CLIPBOARD_MODULE_ID,
  FILES_MODULE_ID,
  META_MODULE_ID,
  POWER_MODULE_ID,
  WIFI_MODULE_ID,
  CONNECTIVITY_MODULE_ID,
  APPS_MODULE_ID,
};

/**
 * Single source of truth for the seven Octi modules the web dashboard knows
 * about. Drives default tile order, default-wide tiles, per-platform
 * availability filtering, dispatch from TileGrid to per-module Tile/Sheet
 * components, and decoder selection in the generic fetch-module helper.
 *
 * Decoders accept the parsed JSON object (after JSON.parse) and return the
 * typed model. They validate required fields + enum values; throw otherwise.
 *
 * Tile/Sheet component slots are nullable so this file can land before the
 * S3 per-module UI components exist. TileGrid renders a placeholder when a
 * slot is empty.
 */

export interface ModuleDef<I = unknown> {
  moduleId: string;
  /** Short human label used by TileEditor + tile/sheet headers. */
  label: string;
  /**
   * Stable ordering rank used when computing default layouts and when merging
   * a newly-discovered module into an existing saved layout. Lower = earlier.
   */
  defaultOrderIndex: number;
  /** Whether this tile starts in the `wide` set in fresh layouts. */
  defaultWide: boolean;
  /**
   * Which device platforms publish this module. Used for default-hiding tiles
   * on a device's card when that platform never produces the data (e.g. the
   * web device hides Power/Wifi/Connectivity/Apps by default).
   */
  publishedByPlatforms: ReadonlySet<string>;
  /** Decoder for the JSON payload. */
  decode: (raw: unknown) => I;
  /** Per-module compact tile. Null until the S3 component lands. */
  TileComponent: ComponentType<SvelteComponent> | null;
  /** Per-module detail sheet. Null until the S3 component lands. */
  SheetComponent: ComponentType<SvelteComponent> | null;
}

const PLATFORMS_FULL: ReadonlySet<string> = new Set(["android", "desktop", "web"]);
const PLATFORMS_ANDROID_DESKTOP: ReadonlySet<string> = new Set(["android", "desktop"]);
const PLATFORMS_ANDROID_ONLY: ReadonlySet<string> = new Set(["android"]);

export const MODULE_DEFS: ReadonlyArray<ModuleDef> = [
  {
    moduleId: POWER_MODULE_ID,
    label: "Power",
    defaultOrderIndex: 0,
    defaultWide: true,
    publishedByPlatforms: PLATFORMS_ANDROID_DESKTOP,
    decode: decodePowerInfo,
    TileComponent: null,
    SheetComponent: null,
  },
  {
    moduleId: WIFI_MODULE_ID,
    label: "Wi-Fi",
    defaultOrderIndex: 1,
    defaultWide: false,
    publishedByPlatforms: PLATFORMS_ANDROID_ONLY,
    decode: decodeWifiInfo,
    TileComponent: null,
    SheetComponent: null,
  },
  {
    moduleId: CONNECTIVITY_MODULE_ID,
    label: "Connectivity",
    defaultOrderIndex: 2,
    defaultWide: false,
    publishedByPlatforms: PLATFORMS_ANDROID_DESKTOP,
    decode: decodeConnectivityInfo,
    TileComponent: null,
    SheetComponent: null,
  },
  {
    moduleId: CLIPBOARD_MODULE_ID,
    label: "Clipboard",
    defaultOrderIndex: 3,
    defaultWide: false,
    publishedByPlatforms: PLATFORMS_FULL,
    decode: (raw) => {
      // clipboard's existing deserializer takes bytes, not parsed JSON. Wrap
      // so the registry signature stays uniform.
      const reencoded = new TextEncoder().encode(JSON.stringify(raw));
      return deserializeClipboardInfo(reencoded);
    },
    TileComponent: null,
    SheetComponent: null,
  },
  {
    moduleId: FILES_MODULE_ID,
    label: "Files",
    defaultOrderIndex: 4,
    defaultWide: false,
    publishedByPlatforms: PLATFORMS_FULL,
    decode: (raw) => {
      const reencoded = new TextEncoder().encode(JSON.stringify(raw));
      return deserializeFileShareInfo(reencoded);
    },
    TileComponent: null,
    SheetComponent: null,
  },
  {
    moduleId: APPS_MODULE_ID,
    label: "Apps",
    defaultOrderIndex: 5,
    defaultWide: false,
    publishedByPlatforms: PLATFORMS_ANDROID_ONLY,
    decode: decodeAppsInfo,
    TileComponent: null,
    SheetComponent: null,
  },
  {
    moduleId: META_MODULE_ID,
    label: "Device",
    defaultOrderIndex: 6,
    defaultWide: false,
    publishedByPlatforms: PLATFORMS_FULL,
    decode: (raw) => {
      const reencoded = new TextEncoder().encode(JSON.stringify(raw));
      return deserializeMetaInfo(reencoded);
    },
    TileComponent: null,
    SheetComponent: null,
  },
];

const BY_ID: ReadonlyMap<string, ModuleDef> = new Map(MODULE_DEFS.map((d) => [d.moduleId, d]));

export function moduleById(id: string): ModuleDef | null {
  return BY_ID.get(id) ?? null;
}

/** Module IDs ordered by `defaultOrderIndex`. Cached. */
export const DEFAULT_ORDER: ReadonlyArray<string> = MODULE_DEFS.slice()
  .sort((a, b) => a.defaultOrderIndex - b.defaultOrderIndex)
  .map((d) => d.moduleId);

/** Tile layout — what TileGrid reads from. */
export interface TileLayout {
  /** Module IDs in display order. May include hidden entries. */
  order: string[];
  /** Module IDs to render full-width. */
  wide: string[];
  /** Module IDs to skip from rendering (kept in `order` for editor recall). */
  hidden: string[];
}

/**
 * Normalise a wire platform string ({@code DeviceMetadata.platform}) to one of
 * the canonical names used by {@link ModuleDef.publishedByPlatforms}. The
 * sync-server propagates the raw string the producing device sent in its
 * {@code Octi-Device-Platform} header — which is "android" on phones,
 * "desktop-linux"/"desktop-windows"/"desktop-macos" on octi-desktop, and "web"
 * on us. Without normalisation, "desktop-linux" wouldn't match the
 * "desktop"-keyed availability sets and every tile would be hidden by default.
 */
export function normalizePlatform(raw: string | null | undefined): string {
  if (!raw) return "unknown";
  const lower = raw.toLowerCase();
  // Take the first segment before the dash — "desktop-linux" → "desktop".
  const dash = lower.indexOf("-");
  return dash > 0 ? lower.slice(0, dash) : lower;
}

/**
 * Compute the default tile layout for a device on the given platform.
 * Tiles whose `publishedByPlatforms` excludes this platform are placed in
 * `hidden` by default — they can be un-hidden via the tile editor.
 */
export function defaultLayoutForPlatform(platform: string): TileLayout {
  const norm = normalizePlatform(platform);
  const order: string[] = [];
  const wide: string[] = [];
  const hidden: string[] = [];
  for (const def of MODULE_DEFS.slice().sort((a, b) => a.defaultOrderIndex - b.defaultOrderIndex)) {
    order.push(def.moduleId);
    if (def.defaultWide) wide.push(def.moduleId);
    if (!def.publishedByPlatforms.has(norm)) hidden.push(def.moduleId);
  }
  return { order, wide, hidden };
}

/**
 * Merge a saved layout against the current registry. Any module that exists in
 * the registry but isn't in `saved.order` is inserted at its registry-position
 * (relative to siblings already in `order`), and hidden by default if the
 * platform doesn't publish it. Unknown IDs in the saved layout are kept where
 * they are (in case a feature flag re-introduces the module later); they
 * simply don't render.
 */
export function mergeLayoutWithRegistry(saved: TileLayout, platform: string): TileLayout {
  const norm = normalizePlatform(platform);
  const known = new Set(MODULE_DEFS.map((d) => d.moduleId));
  const presentInSaved = new Set(saved.order);
  const missing = MODULE_DEFS.filter((d) => known.has(d.moduleId) && !presentInSaved.has(d.moduleId)).sort(
    (a, b) => a.defaultOrderIndex - b.defaultOrderIndex,
  );
  if (missing.length === 0) return saved;

  const order = saved.order.slice();
  const hidden = saved.hidden.slice();
  for (const def of missing) {
    // Insert at the position right after the highest-index registry sibling
    // already present in `order`, or at the start if there's no such sibling.
    let insertAt = 0;
    for (let i = 0; i < def.defaultOrderIndex; i++) {
      const siblingId = DEFAULT_ORDER[i];
      const idx = order.indexOf(siblingId);
      if (idx >= 0 && idx + 1 > insertAt) insertAt = idx + 1;
    }
    order.splice(insertAt, 0, def.moduleId);
    if (!def.publishedByPlatforms.has(norm)) hidden.push(def.moduleId);
  }
  return { order, wide: saved.wide.slice(), hidden };
}
