<script lang="ts">
  import type { SharedFile } from "../../modules/files";
  import {
    APPS_MODULE_ID,
    CLIPBOARD_MODULE_ID,
    CONNECTIVITY_MODULE_ID,
    FILES_MODULE_ID,
    META_MODULE_ID,
    POWER_MODULE_ID,
    WIFI_MODULE_ID,
    type TileLayout,
  } from "../../modules/module-registry";
  import { metaInfoLabel } from "../../modules/meta";
  import AppsSheet from "./tiles/AppsSheet.svelte";
  import ClipboardSheet from "./tiles/ClipboardSheet.svelte";
  import ConnectivitySheet from "./tiles/ConnectivitySheet.svelte";
  import FilesSheet from "./tiles/FilesSheet.svelte";
  import MetaSheet from "./tiles/MetaSheet.svelte";
  import PowerSheet from "./tiles/PowerSheet.svelte";
  import WifiSheet from "./tiles/WifiSheet.svelte";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons";
  import OverflowMenu from "./OverflowMenu.svelte";
  import TileEditor from "./TileEditor.svelte";
  import TileGrid, { type TileData } from "./TileGrid.svelte";

  /**
   * One device's card: header (icon + label + last-seen + overflow) plus
   * either the tile grid or the tile editor. Sheet rendering is owned here so
   * the open/close state is tied to a single device's interaction.
   */
  let {
    deviceId,
    deviceLabel,
    devicePlatform,
    lastSeen,
    isSelf,
    layout,
    data,
    ownConnectorIds,
    onLayoutChange,
    onClipboardPasteOs,
    onClipboardPublishText,
    onFilesPickUpload,
    onDownloadFile,
    onFilesUploadCallback,
  }: {
    /** Server-side device id. Surfaced on the card root for screenshot CI selectors. */
    deviceId: string;
    deviceLabel: string;
    devicePlatform: string;
    lastSeen: string | null;
    isSelf: boolean;
    layout: TileLayout;
    data: TileData;
    /** Every active connector's id. FilesTile / FilesSheet check `f.availableOn`
     *  intersects this set to decide if a file is downloadable. */
    ownConnectorIds: readonly string[];
    onLayoutChange: (next: TileLayout) => void;
    /** Own-device only — quick-action handler from the tile. */
    onClipboardPasteOs?: () => Promise<void>;
    /** Own-device only — manual text publish from the clipboard sheet. */
    onClipboardPublishText?: (text: string) => Promise<void>;
    /** Own-device only — opens the OS file picker. */
    onFilesPickUpload?: () => void;
    /** Per-card — downloads a peer's (or own) shared file. */
    onDownloadFile: (file: SharedFile) => Promise<void>;
    /**
     * Own-device only — invoked from the FilesSheet's upload picker. The
     * tile-quick-action `onFilesPickUpload` is a separate channel (it just
     * triggers the parent's hidden file input). The sheet has its own input.
     */
    onFilesUploadCallback?: (
      file: File,
      onProgress?: (done: number, total: number) => void,
    ) => Promise<void>;
  } = $props();

  let openSheet = $state<string | null>(null);
  let editing = $state(false);

  function deviceIcon(platform: string | undefined, info: TileData["meta"]): IconName {
    const t = info?.deviceType ?? platform?.toUpperCase();
    switch (t) {
      case "PHONE":
        return "phone";
      case "TABLET":
        return "tablet";
      case "DESKTOP":
        return "desktop";
      case "BROWSER":
      case "WEB":
        return "browser";
      case "WATCH":
        return "watch";
      case "TV":
        return "tv";
      case "AUTO":
        return "car";
      case "ANDROID":
        return "phone";
      default:
        return "device-unknown";
    }
  }

  function formatLastSeen(s: string | null): string {
    if (!s) return "never";
    const d = Date.parse(s);
    if (!Number.isFinite(d)) return s;
    const ago = Math.max(0, Math.floor((Date.now() - d) / 1000));
    if (ago < 30) return "just now";
    if (ago < 60) return `${ago} s ago`;
    if (ago < 3600) return `${Math.floor(ago / 60)} min ago`;
    if (ago < 86400) return `${Math.floor(ago / 3600)} h ago`;
    return `${Math.floor(ago / 86400)} d ago`;
  }

  function closeSheet() {
    openSheet = null;
  }

  function applyLayout(next: TileLayout) {
    onLayoutChange(next);
  }

  function startEdit() {
    editing = true;
  }

  function endEdit() {
    editing = false;
  }
</script>

<article class="card" class:self={isSelf} data-testid="device-card" data-device-id={deviceId}>
  <header class="header">
    <span class="device-icon" aria-hidden="true">
      <Icon name={deviceIcon(devicePlatform, data.meta)} size={22} />
    </span>
    <div class="title-wrap">
      <div class="label">
        {metaInfoLabel(data.meta, deviceLabel)}
        {#if isSelf}<span class="badge">this device</span>{/if}
      </div>
      <div class="meta-line">
        {devicePlatform} · last seen {formatLastSeen(lastSeen)}
      </div>
    </div>
    <OverflowMenu items={[{ label: "Edit tiles", onClick: startEdit, testId: "edit-tiles-button" }]} />
  </header>

  <div class="body">
    {#if editing}
      <TileEditor
        {layout}
        onSave={(next) => {
          applyLayout(next);
          endEdit();
        }}
        onCancel={endEdit}
      />
    {:else}
      <TileGrid
        {layout}
        {data}
        {isSelf}
        {ownConnectorIds}
        onOpenSheet={(id) => (openSheet = id)}
        onClipboardPasteOs={onClipboardPasteOs && (() => {
          void onClipboardPasteOs!();
        })}
        onFilesPickUpload={onFilesPickUpload}
      />
    {/if}
  </div>
</article>

{#if openSheet === POWER_MODULE_ID}
  <PowerSheet
    info={data.power}
    error={data.powerError}
    deviceLabel={metaInfoLabel(data.meta, deviceLabel)}
    onClose={closeSheet}
  />
{:else if openSheet === WIFI_MODULE_ID}
  <WifiSheet
    info={data.wifi}
    error={data.wifiError}
    deviceLabel={metaInfoLabel(data.meta, deviceLabel)}
    onClose={closeSheet}
  />
{:else if openSheet === CONNECTIVITY_MODULE_ID}
  <ConnectivitySheet
    info={data.connectivity}
    error={data.connectivityError}
    deviceLabel={metaInfoLabel(data.meta, deviceLabel)}
    onClose={closeSheet}
  />
{:else if openSheet === CLIPBOARD_MODULE_ID}
  <ClipboardSheet
    info={data.clipboard}
    error={data.clipboardError}
    deviceLabel={metaInfoLabel(data.meta, deviceLabel)}
    {isSelf}
    onClose={closeSheet}
    onPublishText={isSelf ? onClipboardPublishText : undefined}
    onPasteOsAndPublish={isSelf ? onClipboardPasteOs : undefined}
  />
{:else if openSheet === APPS_MODULE_ID}
  <AppsSheet
    info={data.apps}
    error={data.appsError}
    deviceLabel={metaInfoLabel(data.meta, deviceLabel)}
    onClose={closeSheet}
  />
{:else if openSheet === FILES_MODULE_ID}
  <FilesSheet
    info={data.fileShare}
    error={data.fileShareError}
    deviceLabel={metaInfoLabel(data.meta, deviceLabel)}
    {isSelf}
    {ownConnectorIds}
    onClose={closeSheet}
    onUploadFile={isSelf ? onFilesUploadCallback : undefined}
    onDownloadFile={onDownloadFile}
  />
{:else if openSheet === META_MODULE_ID}
  <MetaSheet
    info={data.meta}
    error={data.metaError}
    deviceLabel={metaInfoLabel(data.meta, deviceLabel)}
    onClose={closeSheet}
  />
{/if}

<style>
  .card {
    background: var(--md-color-surface-container);
    border-radius: var(--octi-card-radius);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
  }
  .card.self {
    box-shadow:
      0 1px 3px rgba(0, 0, 0, 0.18),
      inset 0 0 0 1px color-mix(in srgb, var(--md-color-primary) 35%, transparent);
  }
  .header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 6px 0;
  }
  .device-icon {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--md-color-on-surface) 6%, transparent);
    color: var(--md-color-on-surface);
    flex-shrink: 0;
  }
  .title-wrap {
    flex: 1;
    min-width: 0;
  }
  .label {
    font-size: 1rem;
    font-weight: 600;
    color: var(--md-color-on-surface);
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .badge {
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 2px 6px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--md-color-primary) 22%, transparent);
    color: var(--md-color-primary);
  }
  .meta-line {
    font-size: 0.75rem;
    color: var(--md-color-on-surface-variant);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .body {
    padding: 0 2px;
  }
</style>
