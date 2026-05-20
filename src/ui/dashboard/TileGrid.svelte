<script lang="ts">
  import type { ClipboardInfo } from "../../modules/clipboard";
  import {
    APPS_MODULE_ID,
    CLIPBOARD_MODULE_ID,
    CONNECTIVITY_MODULE_ID,
    FILES_MODULE_ID,
    META_MODULE_ID,
    POWER_MODULE_ID,
    WIFI_MODULE_ID,
    moduleById,
    type TileLayout,
  } from "../../modules/module-registry";
  import type { AppsInfo } from "../../modules/apps";
  import type { ConnectivityInfo } from "../../modules/connectivity";
  import type { FileShareInfo } from "../../modules/files";
  import type { MetaInfo } from "../../modules/meta";
  import type { PowerInfo } from "../../modules/power";
  import type { WifiInfo } from "../../modules/wifi";
  import AppsTile from "./tiles/AppsTile.svelte";
  import ClipboardTile from "./tiles/ClipboardTile.svelte";
  import ConnectivityTile from "./tiles/ConnectivityTile.svelte";
  import FilesTile from "./tiles/FilesTile.svelte";
  import MetaTile from "./tiles/MetaTile.svelte";
  import PowerTile from "./tiles/PowerTile.svelte";
  import WifiTile from "./tiles/WifiTile.svelte";
  import { computeTileRows } from "./tile-rows";

  /**
   * Render the per-device tile grid. Pure presentation: takes the decoded
   * module payloads + the layout config, dispatches to per-module Tile
   * components, and emits `onOpenSheet(moduleId)` when a tile is tapped.
   *
   * Each module's data is read from the `data` bag. The data bag is the same
   * `EnrichedDevice`-shaped slice the parent already aggregates per refresh
   * tick. Quick actions (Clipboard paste, Files upload) are passed through as
   * optional callbacks; they fire only on the own-device card.
   */
  export interface TileData {
    meta: MetaInfo | null;
    metaError: string | null;
    clipboard: ClipboardInfo | null;
    clipboardError: string | null;
    fileShare: FileShareInfo | null;
    fileShareError: string | null;
    power: PowerInfo | null;
    powerError: string | null;
    wifi: WifiInfo | null;
    wifiError: string | null;
    connectivity: ConnectivityInfo | null;
    connectivityError: string | null;
    apps: AppsInfo | null;
    appsError: string | null;
  }

  let {
    layout,
    data,
    isSelf,
    ownConnectorIds,
    onOpenSheet,
    onClipboardPasteOs,
    onFilesPickUpload,
  }: {
    layout: TileLayout;
    data: TileData;
    isSelf: boolean;
    ownConnectorIds: readonly string[];
    onOpenSheet: (moduleId: string) => void;
    onClipboardPasteOs?: () => void;
    onFilesPickUpload?: () => void;
  } = $props();

  const rows = $derived(computeTileRows(layout));
</script>

{#snippet renderTile(moduleId: string, wide: boolean)}
  <!--
    Per-tile wrapper for screenshot CI selectors. `display: contents` makes the
    wrapper invisible to the grid layout — its child (the tile button) keeps
    occupying the grid cell directly. Playwright clicks land on the wrapper or
    the inner button identically.
  -->
  <div class="tile-wrapper" data-testid="tile" data-module-id={moduleId}>
    {#if moduleById(moduleId) == null}
      <div class="missing">Unknown module: {moduleId}</div>
    {:else if moduleId === POWER_MODULE_ID}
      <PowerTile
        info={data.power}
        error={data.powerError}
        {wide}
        onOpen={() => onOpenSheet(moduleId)}
      />
    {:else if moduleId === WIFI_MODULE_ID}
      <WifiTile
        info={data.wifi}
        error={data.wifiError}
        {wide}
        onOpen={() => onOpenSheet(moduleId)}
      />
    {:else if moduleId === CONNECTIVITY_MODULE_ID}
      <ConnectivityTile
        info={data.connectivity}
        error={data.connectivityError}
        {wide}
        onOpen={() => onOpenSheet(moduleId)}
      />
    {:else if moduleId === CLIPBOARD_MODULE_ID}
      <ClipboardTile
        info={data.clipboard}
        error={data.clipboardError}
        {isSelf}
        {wide}
        onOpen={() => onOpenSheet(moduleId)}
        onPasteOsAndPublish={isSelf ? onClipboardPasteOs : undefined}
      />
    {:else if moduleId === FILES_MODULE_ID}
      <FilesTile
        info={data.fileShare}
        error={data.fileShareError}
        {isSelf}
        {wide}
        {ownConnectorIds}
        onOpen={() => onOpenSheet(moduleId)}
        onPickUpload={isSelf ? onFilesPickUpload : undefined}
      />
    {:else if moduleId === APPS_MODULE_ID}
      <AppsTile
        info={data.apps}
        error={data.appsError}
        {wide}
        onOpen={() => onOpenSheet(moduleId)}
      />
    {:else if moduleId === META_MODULE_ID}
      <MetaTile
        info={data.meta}
        error={data.metaError}
        {wide}
        onOpen={() => onOpenSheet(moduleId)}
      />
    {/if}
  </div>
{/snippet}

<div class="grid">
  {#each rows as row, ri (ri)}
    {#if row.kind === "wide"}
      <div class="row wide">
        {@render renderTile(row.ids[0], true)}
      </div>
    {:else if row.kind === "pair"}
      <div class="row pair">
        {@render renderTile(row.ids[0], false)}
        {@render renderTile(row.ids[1], false)}
      </div>
    {:else}
      <div class="row single">
        {@render renderTile(row.ids[0], false)}
      </div>
    {/if}
  {/each}
  {#if rows.length === 0}
    <div class="empty">All tiles hidden. Open the menu → Edit tiles to bring some back.</div>
  {/if}
</div>

<style>
  .grid {
    display: flex;
    flex-direction: column;
    gap: var(--octi-tile-gap);
  }
  .row {
    display: grid;
    gap: var(--octi-tile-gap);
  }
  .row.wide,
  .row.single {
    grid-template-columns: 1fr;
  }
  .row.pair {
    grid-template-columns: 1fr 1fr;
  }
  /*
   * Per-tile wrapper for screenshot CI selectors. {@code display: contents}
   * makes the wrapper transparent to the row's grid layout, so the inner tile
   * button continues to be the grid item.
   */
  .tile-wrapper {
    display: contents;
  }
  .empty {
    padding: 24px;
    text-align: center;
    color: var(--md-color-on-surface-variant);
    font-size: 0.85rem;
    background: var(--md-color-surface-container-low);
    border-radius: var(--octi-tile-radius);
  }
  .missing {
    padding: 8px;
    font-size: 0.8rem;
    color: var(--md-color-on-surface-variant);
  }
</style>
