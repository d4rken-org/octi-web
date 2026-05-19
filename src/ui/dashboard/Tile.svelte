<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * Base tile shell used by every per-module tile. Provides the Material-3
   * card chrome (radius, padding, surface coloring + the wide/narrow
   * background swap), the icon + title row, an optional right-edge `actions`
   * slot for quick-action buttons, and the click handler that opens the
   * module's detail sheet.
   *
   * The `state` prop selects chrome variants:
   * - `ok`      — normal data render (default)
   * - `empty`   — peer hasn't published this module yet; dimmed
   * - `error`   — payload exists but decode failed; error-tinted accent
   *
   * Per-module tiles project their compact content via the default snippet;
   * see the Android *ModuleTile.kt files for the visual layout each one is
   * mirroring.
   */
  let {
    title,
    state = "ok",
    wide = false,
    onOpen,
    icon,
    actions,
    statusLine,
    children,
  }: {
    title: string;
    state?: "ok" | "empty" | "error";
    wide?: boolean;
    onOpen?: () => void;
    icon?: Snippet;
    actions?: Snippet;
    statusLine?: Snippet;
    children?: Snippet;
  } = $props();

</script>

{#snippet inner()}
  <div class="tile-header">
    <div class="tile-icon" aria-hidden="true">
      {#if icon}{@render icon()}{/if}
    </div>
    <div class="tile-title">{title}</div>
    {#if actions}
      <div
        class="tile-actions"
        role="presentation"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.stopPropagation()}
      >
        {@render actions()}
      </div>
    {/if}
  </div>
  {#if statusLine}
    <div class="tile-status">{@render statusLine()}</div>
  {/if}
  {#if children}
    <div class="tile-body">{@render children()}</div>
  {/if}
{/snippet}

{#if onOpen}
  <button
    type="button"
    class="tile interactive"
    class:wide
    class:state-empty={state === "empty"}
    class:state-error={state === "error"}
    onclick={onOpen}
  >
    {@render inner()}
  </button>
{:else}
  <div
    class="tile"
    class:wide
    class:state-empty={state === "empty"}
    class:state-error={state === "error"}
  >
    {@render inner()}
  </div>
{/if}

<style>
  .tile {
    background: var(--md-color-surface-container-highest);
    border-radius: var(--octi-tile-radius);
    padding: var(--octi-tile-padding);
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-height: 88px;
    color: var(--md-color-on-surface);
    transition: background-color 120ms ease, opacity 120ms ease;
    font: inherit;
    text-align: left;
    width: 100%;
    min-width: 0;
    /* Clip any nowrap content (Clipboard preview, SSID, file name) at the tile boundary
       so it can't push the tile past its grid track. */
    overflow: hidden;
    border: none;
    box-sizing: border-box;
  }
  .tile.wide {
    background: color-mix(in srgb, var(--md-color-primary-container) 35%, transparent);
  }
  .tile.state-empty {
    opacity: 0.55;
  }
  .tile.state-error {
    background: color-mix(in srgb, var(--md-color-error-container) 55%, var(--md-color-surface-container-highest));
  }
  .tile.interactive {
    cursor: pointer;
    user-select: none;
  }
  .tile.interactive:hover {
    background: color-mix(in srgb, var(--md-color-primary) 8%, var(--md-color-surface-container-highest));
  }
  .tile.interactive.wide:hover {
    background: color-mix(in srgb, var(--md-color-primary-container) 55%, transparent);
  }
  .tile.interactive:focus-visible {
    outline: 2px solid var(--md-color-primary);
    outline-offset: 2px;
  }

  .tile-header {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .tile-icon {
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    color: var(--md-color-on-surface);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .tile-title {
    flex: 1;
    font-size: 1rem;
    font-weight: 600;
    line-height: 1.25;
    color: var(--md-color-on-surface);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tile-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .tile-status {
    font-size: 0.85rem;
    color: var(--md-color-on-surface-variant);
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    max-width: 100%;
  }
  .tile-body {
    font-size: 0.8rem;
    color: var(--md-color-on-surface-variant);
    line-height: 1.3;
    overflow: hidden;
    min-width: 0;
    max-width: 100%;
  }
</style>
