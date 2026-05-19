<script lang="ts">
  import type { FileShareInfo, SharedFile } from "../../../modules/files";
  import Icon from "../Icon.svelte";
  import Tile from "../Tile.svelte";

  let {
    info,
    error,
    isSelf,
    wide = false,
    onOpen,
    onPickUpload,
    ownConnectorId,
  }: {
    info: FileShareInfo | null;
    error: string | null;
    isSelf: boolean;
    wide?: boolean;
    onOpen: () => void;
    /** Own-device only — opens the OS file picker and uploads on confirm. */
    onPickUpload?: () => void;
    /** Server-side connector ID for the current account; used to filter downloadable files. */
    ownConnectorId: string;
  } = $props();

  const state = $derived<"ok" | "empty" | "error">(error ? "error" : info ? "ok" : "empty");

  function isDownloadable(f: SharedFile, now: number): boolean {
    if (!f.availableOn.includes(ownConnectorId)) return false;
    const expiresAt = Date.parse(f.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt < now) return false;
    return true;
  }

  const activeFiles = $derived.by(() => {
    if (!info) return [] as SharedFile[];
    const now = Date.now();
    return info.files
      .filter((f) => isDownloadable(f, now))
      .slice()
      .sort((a, b) => (b.sharedAt > a.sharedAt ? 1 : -1));
  });

  const latest = $derived(activeFiles[0] ?? null);
</script>

<Tile title="Files" {state} {wide} {onOpen}>
  {#snippet icon()}
    <Icon name="file" />
  {/snippet}
  {#snippet actions()}
    {#if isSelf && onPickUpload}
      <button
        type="button"
        class="qa"
        title="Upload a file"
        aria-label="Upload a file"
        onclick={onPickUpload}
      >
        <Icon name="upload" size={16} />
      </button>
    {/if}
  {/snippet}
  {#snippet statusLine()}
    {#if error}
      Decode failed
    {:else if !info}
      Not published yet
    {:else if activeFiles.length === 0}
      No active shares
    {:else}
      {activeFiles.length} {activeFiles.length === 1 ? "file" : "files"}
    {/if}
  {/snippet}
  {#if latest}
    <span class="latest">{latest.name}</span>
  {/if}
</Tile>

<style>
  .qa {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: none;
    background: transparent;
    color: var(--md-color-on-surface-variant);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }
  .qa:hover {
    background: color-mix(in srgb, var(--md-color-on-surface) 8%, transparent);
    color: var(--md-color-on-surface);
  }
  .latest {
    font-size: 0.78rem;
    color: var(--md-color-on-surface);
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
