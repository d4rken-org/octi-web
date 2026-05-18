<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { listDevices, OctiApiError } from "../protocol/octi-api";
  import { startPollLoop } from "../sync/poll-loop";
  import type { DeviceMetadata } from "../protocol/models";
  import { credentialsRepo, type CredentialRecord } from "../storage/credentials-repo";
  import { createPayloadEncryption } from "../crypto/payload";
  import {
    fetchPeerMetaInfo,
    metaInfoLabel,
    publishOwnMetaInfo,
    type MetaInfo,
  } from "../modules/meta";
  import {
    CLIPBOARD_MAX_BYTES,
    fetchPeerClipboard,
    publishOwnClipboard,
    textClipboard,
    type ClipboardInfo,
  } from "../modules/clipboard";
  import {
    fetchPeerFileShareInfo,
    type FileRow,
    type FileShareInfo,
  } from "../modules/files";
  import { createBlobCipher, type BlobCipher } from "../crypto/blob-cipher";
  import ClipboardCard from "./ClipboardCard.svelte";
  import Files from "./Files.svelte";
  import ShareCode from "./ShareCode.svelte";

  let { record, onSignOut }: { record: CredentialRecord; onSignOut: () => void } = $props();

  interface EnrichedDevice {
    raw: DeviceMetadata;
    meta: MetaInfo | null;
    metaError: string | null;
    clipboard: ClipboardInfo | null;
    clipboardError: string | null;
    fileShare: FileShareInfo | null;
    fileShareError: string | null;
  }

  let devices = $state<EnrichedDevice[] | null>(null);
  let blobCipher = $state<BlobCipher | null>(null);
  let loadError = $state<string | null>(null);
  let loading = $state(false);
  /** Most recent successful refresh. Used by the "last synced" hint. */
  let lastSyncedAt = $state<Date | null>(null);
  let publishStatus = $state<"idle" | "publishing" | "done" | "error">("idle");
  let publishError = $state<string | null>(null);
  let showShare = $state(false);
  let stopPollLoop: (() => void) | null = null;

  let clipboardDraft = $state("");
  let pushingClipboard = $state(false);
  let clipboardPushStatus = $state<string | null>(null);

  const creds = {
    accountId: record.accountId,
    devicePassword: record.devicePassword,
    deviceId: record.ownDeviceId,
  };
  const crypti = createPayloadEncryption(record.encryptionKeyset);

  const fileRows = $derived(
    (devices ?? []).flatMap((d) => {
      if (!d.fileShare) return [] as FileRow[];
      const ownerLabel = metaInfoLabel(d.meta, d.raw.label ?? "(no label)");
      return d.fileShare.files.map((file) => ({
        ownerDeviceId: d.raw.id,
        ownerLabel,
        file,
      }) satisfies FileRow);
    }),
  );

  async function refresh() {
    loading = true;
    loadError = null;
    try {
      const list = await listDevices({ server: record.serverAddress, creds });
      // Fetch peer MetaInfo + Clipboard in parallel per device. Each subcall isolates
      // its own errors so one rotten payload doesn't blank the whole row.
      const enriched = await Promise.all(
        list.map(async (raw) => {
          const [metaRes, clipRes, filesRes] = await Promise.all([
            fetchPeerMetaInfo({ server: record.serverAddress, creds, crypti, peerDeviceId: raw.id })
              .then((meta) => ({ meta, metaError: null as string | null }))
              .catch((e) => ({
                meta: null as MetaInfo | null,
                metaError: e instanceof Error ? e.message : String(e),
              })),
            fetchPeerClipboard({ server: record.serverAddress, creds, crypti, peerDeviceId: raw.id })
              .then((clipboard) => ({ clipboard, clipboardError: null as string | null }))
              .catch((e) => ({
                clipboard: null as ClipboardInfo | null,
                clipboardError: e instanceof Error ? e.message : String(e),
              })),
            fetchPeerFileShareInfo({ server: record.serverAddress, creds, crypti, peerDeviceId: raw.id })
              .then((fileShare) => ({ fileShare, fileShareError: null as string | null }))
              .catch((e) => ({
                fileShare: null as FileShareInfo | null,
                fileShareError: e instanceof Error ? e.message : String(e),
              })),
          ]);
          return { raw, ...metaRes, ...clipRes, ...filesRes } satisfies EnrichedDevice;
        }),
      );
      devices = enriched;
      lastSyncedAt = new Date();
    } catch (e) {
      if (e instanceof OctiApiError) {
        loadError = `${e.path} → ${e.status}: ${e.body.slice(0, 200)}`;
      } else {
        loadError = e instanceof Error ? e.message : String(e);
      }
    } finally {
      loading = false;
    }
  }

  async function publishOwn() {
    publishStatus = "publishing";
    publishError = null;
    try {
      await publishOwnMetaInfo({ server: record.serverAddress, creds, crypti, record });
      publishStatus = "done";
    } catch (e) {
      publishStatus = "error";
      publishError = e instanceof Error ? e.message : String(e);
    }
  }

  async function shareClipboard() {
    clipboardPushStatus = null;
    pushingClipboard = true;
    try {
      const info = textClipboard(clipboardDraft);
      await publishOwnClipboard({
        server: record.serverAddress,
        creds,
        crypti,
        ownDeviceId: record.ownDeviceId,
        info,
      });
      clipboardPushStatus = "Shared. Other devices will see it on their next sync.";
      // Soft refresh so this device's clipboard card updates too.
      void refresh();
    } catch (e) {
      clipboardPushStatus = `Failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      pushingClipboard = false;
    }
  }

  async function pasteFromOsClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      clipboardDraft = text;
    } catch (e) {
      clipboardPushStatus = `Read failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function signOut() {
    if (
      !confirm(
        "Sign this browser out? The device record stays on the server until you " +
          "remove it from another Octi device.",
      )
    ) {
      return;
    }
    await credentialsRepo.wipe();
    onSignOut();
  }

  onMount(async () => {
    blobCipher = await createBlobCipher(record.encryptionKeyset);
    await publishOwn();
    // Poll loop drives refresh; refreshOnStart fires it immediately.
    stopPollLoop = startPollLoop(refresh);
  });

  onDestroy(() => {
    stopPollLoop?.();
    stopPollLoop = null;
  });

  /** "5 s", "12 min", "2 h", etc. — coarse, human-friendly. */
  function timeAgo(d: Date | null): string {
    if (!d) return "never";
    const secs = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (secs < 5) return "just now";
    if (secs < 60) return `${secs} s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
    return `${Math.floor(secs / 86400)} d ago`;
  }

  // Re-render the "last synced" hint on a 1 s interval so it stays accurate
  // between polls. Just bumps a state var — cheap.
  let now = $state(Date.now());
  $effect(() => {
    const i = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(i);
  });
  // Touch `now` so the derived label re-evaluates.
  const lastSyncedLabel = $derived((void now, timeAgo(lastSyncedAt)));
</script>

<section>
  <header style="display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap;">
    <h1 style="margin: 0;">Octi web</h1>
    <span style="opacity: 0.65; font-size: 0.85rem;">
      Signed in as {record.deviceLabel || "Browser"} ·
      {record.serverAddress.protocol}://{record.serverAddress.domain}:{record.serverAddress.port}
    </span>
    <span style="margin-left: auto; opacity: 0.7; font-size: 0.85rem;">
      {loading ? "Syncing…" : `Last sync: ${lastSyncedLabel}`}
    </span>
  </header>

  <div style="display: flex; gap: 0.5rem; margin: 0.75rem 0 1rem; flex-wrap: wrap;">
    <button onclick={refresh} disabled={loading}>
      {loading ? "Refreshing…" : "Refresh now"}
    </button>
    <button onclick={publishOwn} disabled={publishStatus === "publishing"}>
      {publishStatus === "publishing" ? "Publishing…" : "Republish my MetaInfo"}
    </button>
    <button onclick={() => (showShare = !showShare)}>
      {showShare ? "Hide share code" : "Add another device"}
    </button>
    <button onclick={signOut} style="margin-left: auto;">Sign out</button>
  </div>

  {#if publishStatus === "error" && publishError}
    <p style="color: #ff8a8a;">MetaInfo publish failed: {publishError}</p>
  {/if}

  {#if loadError}
    <p style="color: #ff8a8a;">{loadError}</p>
  {/if}

  <h2>Share my clipboard</h2>
  <p style="opacity: 0.7; font-size: 0.85rem; margin-top: 0;">
    Manual share — type or paste, then hit "Share". Max {CLIPBOARD_MAX_BYTES / 1024} KiB.
  </p>
  <textarea
    bind:value={clipboardDraft}
    rows="3"
    placeholder="Paste or type here…"
  ></textarea>
  <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem;">
    <button onclick={shareClipboard} disabled={pushingClipboard || clipboardDraft.length === 0}>
      {pushingClipboard ? "Sharing…" : "Share"}
    </button>
    <button onclick={pasteFromOsClipboard}>Paste from OS clipboard</button>
  </div>
  {#if clipboardPushStatus}
    <p style="opacity: 0.85; font-size: 0.85rem;">{clipboardPushStatus}</p>
  {/if}

  {#if devices}
    <h2>Devices ({devices.length})</h2>
    <ul style="list-style: none; padding: 0; display: grid; gap: 0.5rem;">
      {#each devices as d (d.raw.id)}
        {@const isSelf = d.raw.id === record.ownDeviceId}
        {@const label = metaInfoLabel(d.meta, d.raw.label ?? "(no label)")}
        <li
          style="padding: 0.6rem 0.75rem; border: 1px solid rgba(255,255,255,0.12); border-radius: 6px;"
        >
          <strong>{label}</strong>
          {#if isSelf}<span style="opacity: 0.6;"> · this device</span>{/if}
          {#if d.meta}
            <div style="opacity: 0.7; font-size: 0.85rem;">
              {d.meta.deviceManufacturer} {d.meta.deviceName} · {d.meta.deviceType.toLowerCase()}
              {#if d.meta.osType}· {d.meta.osType}{d.meta.osVersionName ? ` ${d.meta.osVersionName}` : ""}{/if}
              · octi {d.meta.octiVersionName}
            </div>
          {:else if d.metaError}
            <div style="opacity: 0.6; font-size: 0.8rem; color: #ffcc88;">
              MetaInfo unavailable: {d.metaError}
            </div>
          {:else}
            <div style="opacity: 0.6; font-size: 0.8rem;">No MetaInfo published yet</div>
          {/if}
          <div style="opacity: 0.5; font-size: 0.8rem;">
            id: <code>{d.raw.id}</code> · last seen: {d.raw.lastSeen ?? "?"}
          </div>
          <div style="margin-top: 0.5rem;">
            <ClipboardCard deviceLabel={label} info={d.clipboard} fetchError={d.clipboardError} />
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  {#if blobCipher}
    <Files
      {record}
      {creds}
      {crypti}
      blobCipher={blobCipher}
      rows={fileRows}
      onAfterChange={refresh}
    />
  {/if}

  {#if showShare}
    <ShareCode />
  {/if}
</section>
