<script lang="ts">
  import {
    connectorIdString,
    downloadSharedFile,
    uploadFile,
    type FileRow,
  } from "../modules/files";
  import type { BlobCipher } from "../crypto/blob-cipher";
  import type { PayloadEncryption } from "../crypto/payload";
  import type { AuthCreds } from "../protocol/octi-api";
  import type { CredentialRecord } from "../storage/credentials-repo";

  let {
    record,
    creds,
    crypti,
    blobCipher,
    rows,
    onAfterChange,
  }: {
    record: CredentialRecord;
    creds: AuthCreds;
    crypti: PayloadEncryption;
    blobCipher: BlobCipher;
    rows: FileRow[];
    onAfterChange: () => void;
  } = $props();

  let fileInput: HTMLInputElement | undefined = $state();
  let uploadStatus = $state<string | null>(null);
  let uploadProgress = $state<{ done: number; total: number } | null>(null);
  let downloading = $state<string | null>(null); // blobKey of in-flight download

  const ownConnectorId = $derived(connectorIdString(record.serverAddress, record.accountId));

  async function onPickFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    uploadStatus = `Uploading "${file.name}" (${formatBytes(file.size)})…`;
    uploadProgress = { done: 0, total: 0 };
    try {
      const result = await uploadFile({
        server: record.serverAddress,
        creds,
        crypti,
        blobCipher,
        record,
        file,
        onProgress: (done, total) => {
          uploadProgress = { done, total };
        },
      });
      uploadStatus = `Shared "${result.shared.name}". Other devices will see it on their next sync.`;
      uploadProgress = null;
      onAfterChange();
    } catch (e) {
      uploadStatus = `Upload failed: ${e instanceof Error ? e.message : String(e)}`;
      uploadProgress = null;
    } finally {
      // Reset input so the same file can be re-picked
      if (fileInput) fileInput.value = "";
    }
  }

  async function download(row: FileRow) {
    downloading = row.file.blobKey;
    try {
      const result = await downloadSharedFile({
        server: record.serverAddress,
        creds,
        blobCipher,
        ownerDeviceId: row.ownerDeviceId,
        file: row.file,
      });
      triggerBrowserSave(result.bytes, result.name, result.mimeType);
    } catch (e) {
      alert(`Download failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      downloading = null;
    }
  }

  function triggerBrowserSave(bytes: Uint8Array, name: string, mimeType: string) {
    // Standard pattern: object URL + anchor click + revoke. Browsers can't
    // open a Save-As dialog from JS otherwise without showOpenFilePicker (which
    // isn't universally supported and requires more user gesture choreography).
    const blob = new Blob([bytes], { type: mimeType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name || "octi-download";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  }

  const totalSorted = $derived(
    [...rows].sort((a, b) => b.file.sharedAt.localeCompare(a.file.sharedAt)),
  );
</script>

<section>
  <h2>Shared files</h2>

  <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
    <input
      bind:this={fileInput}
      type="file"
      onchange={onPickFile}
      style="flex: 1; min-width: 14rem;"
    />
  </div>
  {#if uploadStatus}
    <p style="margin: 0.5rem 0 0; font-size: 0.85rem; opacity: 0.85;">{uploadStatus}</p>
  {/if}
  {#if uploadProgress && uploadProgress.total > 0}
    <p style="margin: 0.25rem 0 0; font-size: 0.8rem; opacity: 0.7;">
      {formatBytes(uploadProgress.done)} / {formatBytes(uploadProgress.total)} ciphertext
      ({Math.round((100 * uploadProgress.done) / uploadProgress.total)}%)
    </p>
  {/if}

  {#if totalSorted.length === 0}
    <p style="margin-top: 0.75rem; opacity: 0.6;">No shared files yet.</p>
  {:else}
    <ul style="list-style: none; padding: 0; margin: 0.75rem 0 0; display: grid; gap: 0.4rem;">
      {#each totalSorted as row (row.ownerDeviceId + ":" + row.file.blobKey)}
        {@const onThisServer = row.file.availableOn.includes(ownConnectorId)}
        <li
          style="padding: 0.5rem 0.75rem; border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; display: flex; gap: 0.75rem; align-items: center; justify-content: space-between;"
        >
          <div style="min-width: 0; flex: 1;">
            <div style="overflow-wrap: anywhere;"><strong>{row.file.name}</strong></div>
            <div style="opacity: 0.7; font-size: 0.8rem;">
              {formatBytes(row.file.size)} · {row.file.mimeType} · shared by {row.ownerLabel} at
              {row.file.sharedAt}
            </div>
            {#if !onThisServer}
              <div style="opacity: 0.6; font-size: 0.75rem; color: #ffcc88;">
                Not stored on this server; can't download.
              </div>
            {/if}
          </div>
          <button
            onclick={() => download(row)}
            disabled={!onThisServer || downloading === row.file.blobKey}
          >
            {downloading === row.file.blobKey ? "Downloading…" : "Download"}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>
