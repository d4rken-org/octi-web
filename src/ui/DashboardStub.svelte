<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { OctiApiError } from "../protocol/octi-api";
  import { OctiServerConnector } from "../protocol/octi-server-connector";
  import { startPollLoop } from "../sync/poll-loop";
  import type { DeviceMetadata } from "../protocol/models";
  import { credentialsRepo, type CredentialRecord } from "../storage/credentials-repo";
  import { createPayloadEncryption } from "../crypto/payload";
  import {
    fetchPeerMetaInfo,
    publishOwnMetaInfo,
    type MetaInfo,
  } from "../modules/meta";
  import {
    fetchPeerClipboard,
    publishOwnClipboard,
    textClipboard,
    type ClipboardInfo,
  } from "../modules/clipboard";
  import {
    fetchPeerFileShareInfo,
    type FileShareInfo,
  } from "../modules/files";
  import { createBlobCipher, type BlobCipher } from "../crypto/blob-cipher";
  import {
    APPS_MODULE_ID,
    decodeAppsInfo,
    type AppsInfo,
  } from "../modules/apps";
  import {
    CONNECTIVITY_MODULE_ID,
    decodeConnectivityInfo,
    type ConnectivityInfo,
  } from "../modules/connectivity";
  import {
    POWER_MODULE_ID,
    decodePowerInfo,
    type PowerInfo,
  } from "../modules/power";
  import {
    WIFI_MODULE_ID,
    decodeWifiInfo,
    type WifiInfo,
  } from "../modules/wifi";
  import { createEtagCache, fetchPeerModule } from "../modules/fetch-module";
  import { tileLayoutRepo } from "../storage/tile-layout-repo";
  import type { TileLayout } from "../modules/module-registry";
  import {
    downloadSharedFile,
    uploadFile,
    type SharedFile,
  } from "../modules/files";
  import { OCTI_WEB_DISPLAY_VERSION } from "../version";
  import DeviceCard from "./dashboard/DeviceCard.svelte";
  import NavBar from "./dashboard/NavBar.svelte";
  import type { MenuItem } from "./dashboard/OverflowMenu.svelte";
  import { sortDevicesSelfFirst } from "./dashboard/order";
  import SettingsScreen from "./dashboard/SettingsScreen.svelte";
  import Sheet from "./dashboard/Sheet.svelte";
  import ShareCode from "./ShareCode.svelte";

  let {
    record,
    ownDeviceId,
    onSignOut,
  }: {
    record: CredentialRecord;
    /** Per-install own-device UUID resolved by App.svelte's bootstrap (see IdentitySettings). */
    ownDeviceId: string;
    onSignOut: () => void;
  } = $props();

  /**
   * Mutable copy of the credential record used everywhere downstream. The
   * `record` prop is the initial value; once Settings edits the device label
   * (or any other mutable field in the future), it calls `onRecordUpdated`
   * which updates this state. Nav subtitle, future `publishOwn()` calls, and
   * any downstream consumer must read `activeRecord`, NOT the prop, to see
   * the post-edit value.
   */
  let activeRecord = $state<CredentialRecord>(record);

  /**
   * Connector + crypti are both derived from `activeRecord` so a Settings
   * rename rebuilds them automatically. Previously these were `const` bound
   * to the immutable `record` prop — harmless today because rename only
   * mutates `deviceLabel`, but a latent bug for any future rename-mutable
   * field that fed into crypto / auth.
   */
  const connector = $derived(new OctiServerConnector(activeRecord, ownDeviceId));
  const crypti = $derived(createPayloadEncryption(activeRecord.encryptionKeyset));

  interface EnrichedDevice {
    raw: DeviceMetadata;
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

  let devices = $state<EnrichedDevice[] | null>(null);
  let blobCipher = $state<BlobCipher | null>(null);
  let loadError = $state<string | null>(null);
  let loading = $state(false);
  /** Most recent successful refresh. Used by the "last synced" hint. */
  let lastSyncedAt = $state<Date | null>(null);
  let publishStatus = $state<"idle" | "publishing" | "done" | "error">("idle");
  let publishError = $state<string | null>(null);
  let showShareSheet = $state(false);
  let showSettings = $state(false);
  let stopPollLoop: (() => void) | null = null;

  /**
   * Per-device tile layout, keyed by deviceId. Populated incrementally by
   * `ensureLayoutFor(deviceId, platform)` as devices appear in refresh()
   * results. DeviceCard's `onLayoutChange` mutation persists through the repo
   * and updates this map. A re-keyed update triggers Svelte's reactivity.
   */
  let tileLayouts = $state<Record<string, TileLayout>>({});

  /**
   * Open a hidden file input from anywhere — used by the own-device FilesTile
   * quick-action button (which doesn't have its own input element).
   */
  let hiddenFileInput = $state<HTMLInputElement | null>(null);
  let uploadStatus = $state<string | null>(null);

  function triggerHiddenFilePick() {
    hiddenFileInput?.click();
  }

  async function onHiddenFilePicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      await runUpload(file);
    } finally {
      input.value = "";
    }
  }

  async function runUpload(file: File, onProgress?: (done: number, total: number) => void) {
    if (!blobCipher) throw new Error("Blob cipher not ready");
    uploadStatus = `Uploading "${file.name}"…`;
    try {
      await uploadFile({
        connector,
        crypti,
        blobCipher,
        file,
        onProgress,
      });
      uploadStatus = `Shared "${file.name}".`;
      void refresh();
    } catch (e) {
      uploadStatus = `Upload failed: ${e instanceof Error ? e.message : String(e)}`;
      throw e;
    }
  }

  async function downloadFile(file: SharedFile, ownerDeviceId: string) {
    if (!blobCipher) throw new Error("Blob cipher not ready");
    const result = await downloadSharedFile({
      connector,
      blobCipher,
      ownerDeviceId,
      file,
    });
    const blob = new Blob([result.bytes], { type: result.mimeType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = result.name || "octi-download";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function publishClipboardText(text: string) {
    const info = textClipboard(text);
    await publishOwnClipboard({ connector, crypti, info });
    void refresh();
  }

  async function pasteOsAndPublishClipboard() {
    const text = await navigator.clipboard.readText();
    await publishClipboardText(text);
  }

  async function ensureLayoutFor(deviceId: string, platform: string | null) {
    if (tileLayouts[deviceId]) return;
    const layout = await tileLayoutRepo.getOrDefault({
      deviceId,
      platform: (platform ?? "unknown").toLowerCase(),
    });
    tileLayouts = { ...tileLayouts, [deviceId]: layout };
  }

  async function persistLayout(deviceId: string, next: TileLayout) {
    tileLayouts = { ...tileLayouts, [deviceId]: next };
    await tileLayoutRepo.save({ deviceId, layout: next });
  }

  /**
   * Module-payload ETag cache. Key = `${deviceId}:${moduleId}`. When the
   * server returns the same ETag a second time the cache short-circuits the
   * JSON.parse + decode work — this matters for AppsInfo where payloads can
   * exceed 100 KB. The cache is reset on sign-out via component teardown.
   */
  const etagCache = createEtagCache<unknown>();

  /**
   * Monotonic counter incremented per refresh() invocation. Each call captures
   * its own value; if the captured value is no longer the current seq when the
   * fetches resolve, the call's results are discarded. Prevents stale
   * completions (e.g. a slow poll tick + a fast manual refresh) from
   * overwriting newer state. Mirrors the pattern called out in the
   * implementation plan's S1.5.
   */
  let refreshSeq = 0;

  async function refresh() {
    const mySeq = ++refreshSeq;
    loading = true;
    loadError = null;
    try {
      const list = await connector.listDevices();
      // Per device, fetch all seven module payloads in parallel. Each subcall
      // isolates its own errors so a rotten payload on one module doesn't blank
      // the whole row. Power/Wifi/Connectivity/Apps go through the generic
      // fetchPeerModule helper so they benefit from the ETag cache; the three
      // existing modules keep their bespoke fetchers for now (they retain
      // module-specific behavior like clipboard's base64 ByteString decoding).
      const enriched = await Promise.all(
        list.map(async (raw) => {
          const peerId = raw.id;
          const [metaRes, clipRes, filesRes, powerRes, wifiRes, connRes, appsRes] =
            await Promise.all([
              // fetchPeer* now return `{ value, modifiedAt }` (or `{ info, modifiedAt }` for files).
              // We discard `modifiedAt` here in PR 1; the multi-connector merge in PR 2 will
              // consume it. Keeping the dashboard's per-tile shape unchanged.
              fetchPeerMetaInfo({ connector, crypti, peerDeviceId: peerId })
                .then((res) => ({ meta: res.value, metaError: null as string | null }))
                .catch((e) => ({
                  meta: null as MetaInfo | null,
                  metaError: e instanceof Error ? e.message : String(e),
                })),
              fetchPeerClipboard({ connector, crypti, peerDeviceId: peerId })
                .then((res) => ({ clipboard: res.value, clipboardError: null as string | null }))
                .catch((e) => ({
                  clipboard: null as ClipboardInfo | null,
                  clipboardError: e instanceof Error ? e.message : String(e),
                })),
              fetchPeerFileShareInfo({ connector, crypti, peerDeviceId: peerId })
                .then((res) => ({ fileShare: res.info, fileShareError: null as string | null }))
                .catch((e) => ({
                  fileShare: null as FileShareInfo | null,
                  fileShareError: e instanceof Error ? e.message : String(e),
                })),
              fetchPeerModule({
                connector,
                crypti,
                peerDeviceId: peerId,
                moduleId: POWER_MODULE_ID,
                decode: decodePowerInfo,
                cache: etagCache,
              })
                .then((res) => ({ power: res.value as PowerInfo | null, powerError: null as string | null }))
                .catch((e) => ({
                  power: null as PowerInfo | null,
                  powerError: e instanceof Error ? e.message : String(e),
                })),
              fetchPeerModule({
                connector,
                crypti,
                peerDeviceId: peerId,
                moduleId: WIFI_MODULE_ID,
                decode: decodeWifiInfo,
                cache: etagCache,
              })
                .then((res) => ({ wifi: res.value as WifiInfo | null, wifiError: null as string | null }))
                .catch((e) => ({
                  wifi: null as WifiInfo | null,
                  wifiError: e instanceof Error ? e.message : String(e),
                })),
              fetchPeerModule({
                connector,
                crypti,
                peerDeviceId: peerId,
                moduleId: CONNECTIVITY_MODULE_ID,
                decode: decodeConnectivityInfo,
                cache: etagCache,
              })
                .then((res) => ({
                  connectivity: res.value as ConnectivityInfo | null,
                  connectivityError: null as string | null,
                }))
                .catch((e) => ({
                  connectivity: null as ConnectivityInfo | null,
                  connectivityError: e instanceof Error ? e.message : String(e),
                })),
              fetchPeerModule({
                connector,
                crypti,
                peerDeviceId: peerId,
                moduleId: APPS_MODULE_ID,
                decode: decodeAppsInfo,
                cache: etagCache,
              })
                .then((res) => ({ apps: res.value as AppsInfo | null, appsError: null as string | null }))
                .catch((e) => ({
                  apps: null as AppsInfo | null,
                  appsError: e instanceof Error ? e.message : String(e),
                })),
            ]);
          return {
            raw,
            ...metaRes,
            ...clipRes,
            ...filesRes,
            ...powerRes,
            ...wifiRes,
            ...connRes,
            ...appsRes,
          } satisfies EnrichedDevice;
        }),
      );
      if (mySeq !== refreshSeq) return; // stale completion — newer refresh in flight
      // Pre-hydrate layouts BEFORE publishing `devices` to the UI so the grid
      // paints in its final order on first render. IndexedDB reads are fast
      // (<5ms locally) — awaiting them avoids the previous flicker where peers
      // appeared first and self shifted into position when its layout resolved.
      await Promise.all(enriched.map((d) => ensureLayoutFor(d.raw.id, d.raw.platform)));
      if (mySeq !== refreshSeq) return;
      devices = enriched;
      lastSyncedAt = new Date();
    } catch (e) {
      if (mySeq !== refreshSeq) return;
      if (e instanceof OctiApiError) {
        loadError = `${e.path} → ${e.status}: ${e.body.slice(0, 200)}`;
      } else {
        loadError = e instanceof Error ? e.message : String(e);
      }
    } finally {
      if (mySeq === refreshSeq) loading = false;
    }
  }

  async function publishOwn() {
    publishStatus = "publishing";
    publishError = null;
    try {
      // connector derives from activeRecord, so a Republish after Settings
      // rename publishes the new label.
      await publishOwnMetaInfo({ connector, crypti });
      publishStatus = "done";
    } catch (e) {
      publishStatus = "error";
      publishError = e instanceof Error ? e.message : String(e);
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
    // Wipe both DBs together — credentials + tile layouts. wipeAll() closes
    // the open connection in addition to clearing, so the next link/create
    // flow opens a fresh DB cleanly.
    await Promise.all([
      credentialsRepo.wipeAll().catch(() => undefined),
      tileLayoutRepo.wipeAll().catch(() => undefined),
    ]);
    onSignOut();
  }

  onMount(async () => {
    blobCipher = await createBlobCipher(activeRecord.encryptionKeyset);
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
  const lastSyncLabel = $derived((void now, timeAgo(lastSyncedAt)));

  // Self-first sort the device list for grid render. Layout-state lookup is
  // keyed by deviceId so the sort doesn't disturb hydration. We use the
  // IdentitySettings-sourced `ownDeviceId` (the prop) — NOT
  // `activeRecord.ownDeviceId` — so a future drift between the record's
  // legacy field and the connector's identity doesn't misplace the self card.
  const devicesOrdered = $derived(
    sortDevicesSelfFirst(devices ?? [], ownDeviceId),
  );

  // Screenshot-CI marker. Set once the first refresh has completed (devices
  // non-null, loading false) so Playwright can wait deterministically. Per-tile
  // decode errors surface as `.banner.err` / per-tile error markers — the
  // Playwright spec asserts those are absent before capturing, so the global
  // "dashboard ready" signal here just gates on the device list being present.
  $effect(() => {
    if (devices !== null && !loading) {
      document.documentElement.setAttribute("data-screenshot-ready", "dashboard");
    }
  });

  // Nav subtitle: signed-in label + bare server domain. Full URL lives in
  // Settings; the domain is enough at-a-glance to tell which sync-server is
  // active without cluttering the header.
  const accountSubtitle = $derived(
    `Signed in as ${activeRecord.deviceLabel || "Browser"} · ${activeRecord.serverAddress.domain}`,
  );

  function openSettings() {
    showSettings = true;
  }
  function closeSettings() {
    showSettings = false;
  }
  function openShareSheet() {
    showShareSheet = true;
  }
  function closeShareSheet() {
    showShareSheet = false;
  }

  function handleRecordUpdated(next: CredentialRecord) {
    // Bump refreshSeq + drop the ETag cache so any in-flight refresh tagged
    // with the old connector identity is discarded when it lands, and the
    // next tick re-fetches against the fresh connector. Today Settings only
    // changes `deviceLabel` (connector identity unchanged), but treat record
    // edits as connector-invalidating so future fields that ARE identity-
    // critical (server, account, key) don't reintroduce the bug.
    refreshSeq++;
    etagCache.clear();
    activeRecord = next;
  }

  const navMenuItems = $derived<MenuItem[]>([
    {
      label: publishStatus === "publishing" ? "Publishing…" : "Republish my MetaInfo",
      onClick: publishOwn,
      disabled: publishStatus === "publishing",
    },
    { label: "Add another device", onClick: openShareSheet },
    { label: "Sign out", onClick: signOut, destructive: true, separatorBefore: true },
  ]);
</script>

<section class="dashboard">
  <div class="header-cap">
    <NavBar
      {accountSubtitle}
      version={OCTI_WEB_DISPLAY_VERSION}
      {lastSyncLabel}
      {loading}
      onRefresh={refresh}
      onOpenSettings={openSettings}
      menuItems={navMenuItems}
    />

    {#if publishStatus === "error" && publishError}
      <p class="banner err">MetaInfo publish failed: {publishError}</p>
    {/if}
    {#if loadError}
      <p class="banner err">{loadError}</p>
    {/if}
    {#if uploadStatus}
      <p class="banner">{uploadStatus}</p>
    {/if}
  </div>

  {#if devicesOrdered.length > 0}
    <div class="device-grid">
      {#each devicesOrdered as d (d.raw.id)}
        {@const isSelf = d.raw.id === ownDeviceId}
        {@const layout = tileLayouts[d.raw.id]}
        {#if layout}
          <DeviceCard
            deviceId={d.raw.id}
            deviceLabel={d.raw.label ?? "(no label)"}
            devicePlatform={d.raw.platform ?? "unknown"}
            lastSeen={d.raw.lastSeen}
            {isSelf}
            {layout}
            data={d}
            ownConnectorId={connector.connectorId}
            onLayoutChange={(next) => void persistLayout(d.raw.id, next)}
            onClipboardPasteOs={isSelf ? pasteOsAndPublishClipboard : undefined}
            onClipboardPublishText={isSelf ? publishClipboardText : undefined}
            onFilesPickUpload={isSelf ? triggerHiddenFilePick : undefined}
            onFilesUploadCallback={isSelf ? runUpload : undefined}
            onDownloadFile={(f) => downloadFile(f, d.raw.id)}
          />
        {/if}
      {/each}
    </div>
  {/if}

  <!-- Hidden file input used by the own-device FilesTile quick-action button. -->
  <input
    bind:this={hiddenFileInput}
    type="file"
    onchange={onHiddenFilePicked}
    style="display: none;"
    aria-hidden="true"
  />
</section>

{#if showSettings}
  <SettingsScreen
    record={activeRecord}
    {ownDeviceId}
    onRecordUpdated={handleRecordUpdated}
    onSignOut={signOut}
    onClose={closeSettings}
  />
{/if}

{#if showShareSheet}
  <Sheet title="Add another device" subtitle="Share a one-time code or QR" wide onClose={closeShareSheet}>
    <ShareCode {connector} />
  </Sheet>
{/if}

<style>
  .device-grid {
    /*
     * Auto-flow grid that fills the entire viewport width — intentionally
     * NOT capped, so on an ultrawide / TV the user gets as many columns as
     * their screen affords (4 at ~1920px, 5 at ~2400px, 7 at ~3440px). The
     * min(100%, 440px) inner makes tracks shrink below 440px on phones
     * narrower than that, instead of overflowing horizontally.
     */
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 440px), 1fr));
    gap: 12px;
  }
  /*
   * Nav header + status banners stay capped at a readable width even on
   * ultrawide / TV — only the device grid below scales to fill the screen.
   */
  .header-cap {
    max-width: 1400px;
    margin: 0 auto;
  }
  /* min-width:0 on grid items so inner pair-rows can't force a column wider than the track. */
  .device-grid > :global(*) {
    min-width: 0;
  }
  .banner {
    margin: 0 0 12px;
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 0.85rem;
    background: color-mix(in srgb, var(--md-color-on-surface) 6%, transparent);
    color: var(--md-color-on-surface);
  }
  .banner.err {
    background: color-mix(in srgb, var(--md-color-error) 18%, transparent);
    color: var(--md-color-error);
  }
</style>
