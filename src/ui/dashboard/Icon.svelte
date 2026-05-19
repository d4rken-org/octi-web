<script lang="ts">
  import type { IconName } from "./icons";
  /**
   * Tiny inline SVG icon set used by tiles + headers. Names roughly map to the
   * Material icons their Android counterparts use, but the SVGs are hand-rolled
   * so we don't pull a font / icon package into the bundle.
   *
   * Stroke / fill use `currentColor` so callers control color via CSS.
   */
  let {
    name,
    size = 20,
  }: {
    name: IconName;
    size?: number;
  } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {#if name === "battery-full"}
    <rect x="2" y="7" width="17" height="10" rx="2" />
    <line x1="22" y1="11" x2="22" y2="13" />
    <rect x="4" y="9" width="13" height="6" fill="currentColor" stroke="none" />
  {:else if name === "battery-mid"}
    <rect x="2" y="7" width="17" height="10" rx="2" />
    <line x1="22" y1="11" x2="22" y2="13" />
    <rect x="4" y="9" width="7" height="6" fill="currentColor" stroke="none" />
  {:else if name === "battery-low"}
    <rect x="2" y="7" width="17" height="10" rx="2" />
    <line x1="22" y1="11" x2="22" y2="13" />
    <rect x="4" y="9" width="3" height="6" fill="currentColor" stroke="none" />
  {:else if name === "wifi"}
    <path d="M2 8.5a16 16 0 0 1 20 0" />
    <path d="M5 12a11 11 0 0 1 14 0" />
    <path d="M8.5 15.5a6 6 0 0 1 7 0" />
    <circle cx="12" cy="19" r="1" fill="currentColor" />
  {:else if name === "wifi-off"}
    <path d="M2 8.5a16 16 0 0 1 20 0" opacity="0.4" />
    <path d="M5 12a11 11 0 0 1 14 0" opacity="0.4" />
    <line x1="3" y1="3" x2="21" y2="21" />
  {:else if name === "ethernet"}
    <rect x="3" y="9" width="18" height="11" rx="2" />
    <line x1="7" y1="9" x2="7" y2="5" />
    <line x1="17" y1="9" x2="17" y2="5" />
    <line x1="12" y1="9" x2="12" y2="3" />
  {:else if name === "cellular"}
    <rect x="3" y="14" width="3" height="6" fill="currentColor" stroke="none" />
    <rect x="8" y="10" width="3" height="10" fill="currentColor" stroke="none" />
    <rect x="13" y="6" width="3" height="14" fill="currentColor" stroke="none" />
    <rect x="18" y="2" width="3" height="18" fill="currentColor" stroke="none" />
  {:else if name === "clipboard"}
    <rect x="5" y="4" width="14" height="17" rx="2" />
    <rect x="9" y="2" width="6" height="4" rx="1" fill="currentColor" stroke="none" />
  {:else if name === "copy"}
    <rect x="8" y="8" width="12" height="13" rx="2" />
    <path d="M16 4H6a2 2 0 0 0-2 2v11" />
  {:else if name === "paste"}
    <rect x="5" y="4" width="14" height="17" rx="2" />
    <rect x="9" y="2" width="6" height="4" rx="1" fill="currentColor" stroke="none" />
    <path d="M9 14h6M9 17h4" />
  {:else if name === "file"}
    <path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <path d="M14 3v6h5" />
  {:else if name === "upload"}
    <path d="M12 4v12" />
    <path d="M7 9l5-5 5 5" />
    <path d="M5 20h14" />
  {:else if name === "download"}
    <path d="M12 4v12" />
    <path d="M7 11l5 5 5-5" />
    <path d="M5 20h14" />
  {:else if name === "apps"}
    <rect x="4" y="4" width="6" height="6" rx="1" />
    <rect x="14" y="4" width="6" height="6" rx="1" />
    <rect x="4" y="14" width="6" height="6" rx="1" />
    <rect x="14" y="14" width="6" height="6" rx="1" />
  {:else if name === "phone"}
    <rect x="6" y="2" width="12" height="20" rx="2" />
    <line x1="11" y1="18" x2="13" y2="18" />
  {:else if name === "tablet"}
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="11" y1="18" x2="13" y2="18" />
  {:else if name === "desktop"}
    <rect x="2" y="4" width="20" height="13" rx="2" />
    <line x1="8" y1="21" x2="16" y2="21" />
    <line x1="12" y1="17" x2="12" y2="21" />
  {:else if name === "browser"}
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="3" y1="9" x2="21" y2="9" />
    <circle cx="6.5" cy="6.5" r="0.6" fill="currentColor" />
    <circle cx="9" cy="6.5" r="0.6" fill="currentColor" />
  {:else if name === "watch"}
    <rect x="6" y="7" width="12" height="10" rx="2" />
    <path d="M9 7V4h6v3M9 17v3h6v-3" />
  {:else if name === "tv"}
    <rect x="3" y="5" width="18" height="13" rx="2" />
    <line x1="8" y1="21" x2="16" y2="21" />
  {:else if name === "car"}
    <path d="M5 13l2-5h10l2 5" />
    <rect x="3" y="13" width="18" height="6" rx="2" />
    <circle cx="7.5" cy="19" r="1.3" />
    <circle cx="16.5" cy="19" r="1.3" />
  {:else if name === "device-unknown"}
    <rect x="5" y="3" width="14" height="18" rx="2" />
    <text x="12" y="15" text-anchor="middle" fill="currentColor" stroke="none" font-size="9" font-family="sans-serif">?</text>
  {:else if name === "alert"}
    <path d="M12 4l10 17H2L12 4z" />
    <line x1="12" y1="10" x2="12" y2="14" />
    <circle cx="12" cy="17" r="0.8" fill="currentColor" />
  {:else if name === "check"}
    <polyline points="5 12 10 17 19 7" />
  {:else if name === "x"}
    <line x1="6" y1="6" x2="18" y2="18" />
    <line x1="18" y1="6" x2="6" y2="18" />
  {:else if name === "info"}
    <circle cx="12" cy="12" r="9" />
    <line x1="12" y1="11" x2="12" y2="16" />
    <circle cx="12" cy="8" r="0.8" fill="currentColor" />
  {:else if name === "edit"}
    <path d="M4 20h4l11-11-4-4L4 16v4z" />
  {:else if name === "chevron-up"}
    <polyline points="6 15 12 9 18 15" />
  {:else if name === "chevron-down"}
    <polyline points="6 9 12 15 18 9" />
  {:else if name === "chevron-left"}
    <polyline points="15 6 9 12 15 18" />
  {:else if name === "chevron-right"}
    <polyline points="9 6 15 12 9 18" />
  {:else if name === "globe"}
    <circle cx="12" cy="12" r="9" />
    <line x1="3" y1="12" x2="21" y2="12" />
    <path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  {:else if name === "refresh"}
    <path d="M4 12a8 8 0 0 1 14-5.3l2-2" />
    <path d="M20 4v5h-5" />
    <path d="M20 12a8 8 0 0 1-14 5.3l-2 2" />
    <path d="M4 20v-5h5" />
  {:else if name === "settings"}
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06A2 2 0 1 1 4.27 16.96l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 1 1 7.04 4.29l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  {:else if name === "more"}
    <circle cx="12" cy="6" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="18" r="1.4" fill="currentColor" stroke="none" />
  {:else if name === "sign-out"}
    <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
    <polyline points="10 17 5 12 10 7" />
    <line x1="5" y1="12" x2="15" y2="12" />
  {/if}
</svg>
