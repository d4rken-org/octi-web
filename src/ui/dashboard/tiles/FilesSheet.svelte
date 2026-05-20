<script lang="ts">
  import type { FileShareInfo, SharedFile } from "../../../modules/files";
  import Icon from "../Icon.svelte";
  import Sheet from "../Sheet.svelte";

  let {
    info,
    error,
    deviceLabel,
    isSelf,
    ownConnectorIds,
    onClose,
    onUploadFile,
    onDownloadFile,
  }: {
    info: FileShareInfo | null;
    error: string | null;
    deviceLabel: string;
    isSelf: boolean;
    /** Every active connector's id. A file is downloadable if any of these
     *  ids appears in `f.availableOn`. */
    ownConnectorIds: readonly string[];
    onClose: () => void;
    onUploadFile?: (file: File, onProgress?: (done: number, total: number) => void) => Promise<void>;
    onDownloadFile: (file: SharedFile) => Promise<void>;
  } = $props();

  let fileInputEl = $state<HTMLInputElement | null>(null);
  let uploadStatus = $state<string | null>(null);
  let uploadError = $state<string | null>(null);
  let uploading = $state(false);
  let uploadProgress = $state<{ done: number; total: number } | null>(null);
  let downloading = $state<string | null>(null);

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  }

  const allFiles = $derived(info?.files ?? []);
  const now = $derived(Date.now());

  function isExpired(f: SharedFile): boolean {
    const e = Date.parse(f.expiresAt);
    return Number.isFinite(e) && e < now;
  }

  function isDownloadable(f: SharedFile): boolean {
    if (isExpired(f)) return false;
    return f.availableOn.some((id) => ownConnectorIds.includes(id));
  }

  const sortedFiles = $derived(
    [...allFiles].sort((a, b) => (b.sharedAt > a.sharedAt ? 1 : -1)),
  );

  async function onPickFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !onUploadFile) return;
    uploading = true;
    uploadStatus = `Uploading "${file.name}" (${formatBytes(file.size)})…`;
    uploadError = null;
    uploadProgress = null;
    try {
      await onUploadFile(file, (done, total) => {
        uploadProgress = { done, total };
      });
      uploadStatus = `Shared "${file.name}". Other devices will see it on their next sync.`;
    } catch (err) {
      uploadStatus = null;
      uploadError = err instanceof Error ? err.message : String(err);
    } finally {
      uploading = false;
      uploadProgress = null;
      if (fileInputEl) fileInputEl.value = "";
    }
  }

  async function download(f: SharedFile) {
    downloading = f.blobKey;
    try {
      await onDownloadFile(f);
    } catch (err) {
      alert(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      downloading = null;
    }
  }
</script>

<Sheet title="Files" subtitle={deviceLabel} {onClose}>
  {#if error}
    <div class="error">Decode failed: {error}</div>
  {/if}

  {#if isSelf}
    <section class="upload">
      <h3 class="h3">Upload a file</h3>
      <input
        bind:this={fileInputEl}
        type="file"
        onchange={onPickFile}
        disabled={uploading}
        aria-label="Choose a file to upload"
      />
      {#if uploadStatus}
        <div class="hint">{uploadStatus}</div>
      {/if}
      {#if uploadProgress && uploadProgress.total > 0}
        <div class="hint">
          {formatBytes(uploadProgress.done)} / {formatBytes(uploadProgress.total)} ciphertext
          ({Math.round((100 * uploadProgress.done) / uploadProgress.total)}%)
        </div>
      {/if}
      {#if uploadError}
        <div class="err">{uploadError}</div>
      {/if}
    </section>
  {/if}

  <section>
    <h3 class="h3">Shared by this device</h3>
    {#if !info || sortedFiles.length === 0}
      <div class="empty">No shared files.</div>
    {:else}
      <ul class="list">
        {#each sortedFiles as f (f.blobKey)}
          {@const downloadable = isDownloadable(f)}
          {@const expired = isExpired(f)}
          <li class="file" class:expired>
            <div class="file-main">
              <div class="file-name">{f.name}</div>
              <div class="file-meta">
                {formatBytes(f.size)} · {f.mimeType} · shared {f.sharedAt}
              </div>
              {#if expired}
                <div class="warn">Expired ({f.expiresAt}).</div>
              {:else if !downloadable}
                <div class="warn">Not stored on this server.</div>
              {/if}
            </div>
            <button
              type="button"
              class="dl"
              aria-label={`Download ${f.name}`}
              title="Download"
              disabled={!downloadable || downloading === f.blobKey}
              onclick={() => download(f)}
            >
              <Icon name="download" size={16} />
              {downloading === f.blobKey ? "…" : ""}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</Sheet>

<style>
  .h3 {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--md-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: 16px 0 8px;
  }
  .h3:first-child {
    margin-top: 4px;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .file {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    background: var(--md-color-surface-container-low);
    border-radius: 8px;
  }
  .file.expired {
    opacity: 0.6;
  }
  .file-main {
    flex: 1;
    min-width: 0;
  }
  .file-name {
    color: var(--md-color-on-surface);
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .file-meta {
    font-size: 0.75rem;
    color: var(--md-color-on-surface-variant);
    margin-top: 2px;
  }
  .warn {
    margin-top: 4px;
    font-size: 0.75rem;
    color: var(--md-color-tertiary);
  }
  .dl {
    flex-shrink: 0;
    display: inline-flex;
    gap: 4px;
    align-items: center;
    padding: 6px 10px;
    background: transparent;
    border: 1px solid var(--md-color-outline-variant);
    border-radius: 6px;
    cursor: pointer;
    color: var(--md-color-on-surface);
  }
  .dl:hover:not(:disabled) {
    background: color-mix(in srgb, var(--md-color-on-surface) 8%, transparent);
  }
  .empty {
    color: var(--md-color-on-surface-variant);
    font-size: 0.9rem;
  }
  .error,
  .err {
    color: var(--md-color-error);
    font-size: 0.85rem;
    margin-top: 6px;
  }
  .hint {
    margin-top: 4px;
    font-size: 0.78rem;
    color: var(--md-color-on-surface-variant);
  }
</style>
