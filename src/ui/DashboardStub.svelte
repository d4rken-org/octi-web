<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { textClipboard } from "../modules/clipboard";
  import type { SharedFile } from "../modules/files";
  import type { TileLayout } from "../modules/module-registry";
  import type { ConnectorManager } from "../sync/connector-manager.svelte";
  import { startPollLoop } from "../sync/poll-loop";
  import { credentialsRepo, type CredentialRecord } from "../storage/credentials-repo";
  import { tileLayoutRepo } from "../storage/tile-layout-repo";
  import { OCTI_WEB_DISPLAY_VERSION } from "../version";
  import DeviceCard from "./dashboard/DeviceCard.svelte";
  import IssuesSummarySheet from "./dashboard/IssuesSummarySheet.svelte";
  import NavBar from "./dashboard/NavBar.svelte";
  import type { MenuItem } from "./dashboard/OverflowMenu.svelte";
  import { sortDevicesSelfFirst } from "./dashboard/order";
  import SettingsScreen from "./dashboard/SettingsScreen.svelte";
  import Sheet from "./dashboard/Sheet.svelte";
  import SyncSourcesScreen from "./dashboard/SyncSourcesScreen.svelte";
  import Onboarding from "./Onboarding.svelte";
  import ShareCode from "./ShareCode.svelte";

  let {
    manager,
    onSignOut,
  }: {
    /**
     * Singleton manager owned by App.svelte. All refresh / publish / upload /
     * download orchestration flows through this; the dashboard is pure presentation
     * over its derived state.
     */
    manager: ConnectorManager;
    onSignOut: () => void;
  } = $props();

  // ─── Primary connector ──────────────────────────────────────
  /**
   * Some entry points (Settings rename, "Add another device" share sheet)
   * operate on a single connector. PR 2 picks the user's "primary" —
   * `connectors[0]`, which is the earliest-created credential. PR 3's Sync
   * Sources screen will add per-connector entry points and this primary
   * shortcut goes away.
   */
  const primaryConnector = $derived(manager.connectors[0]);
  const primaryRecord = $derived<CredentialRecord | null>(
    primaryConnector?.record ?? null,
  );
  const ownDeviceId = $derived(primaryConnector?.ownDeviceId ?? "");

  // ─── Reactive view of manager state ─────────────────────────
  const devices = $derived(manager.mergedDevices);
  const loading = $derived(manager.loading);
  const lastSyncedAt = $derived(manager.lastSuccessAt);
  const issues = $derived(manager.mergedIssues);

  // ─── Local UI state ─────────────────────────────────────────
  let publishStatus = $state<"idle" | "publishing" | "done" | "error">("idle");
  let publishError = $state<string | null>(null);
  let showShareSheet = $state(false);
  let showSettings = $state(false);
  let showSyncSources = $state(false);
  let showIssues = $state(false);
  let showAddSource = $state(false);
  let stopPollLoop: (() => void) | null = null;
  let uploadStatus = $state<string | null>(null);

  /**
   * Per-device tile layout, keyed by deviceId. Populated incrementally by
   * `ensureLayoutFor(deviceId, platform)` as devices appear in `manager.mergedDevices`.
   * DeviceCard's `onLayoutChange` mutation persists through the repo and
   * updates this map.
   */
  let tileLayouts = $state<Record<string, TileLayout>>({});

  /**
   * Open a hidden file input from anywhere — used by the own-device FilesTile
   * quick-action button (which doesn't have its own input element).
   */
  let hiddenFileInput = $state<HTMLInputElement | null>(null);

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
    uploadStatus = `Uploading "${file.name}"…`;
    try {
      await manager.uploadFile(file, onProgress);
      uploadStatus = `Shared "${file.name}".`;
      void manager.refreshAll();
    } catch (e) {
      uploadStatus = `Upload failed: ${e instanceof Error ? e.message : String(e)}`;
      throw e;
    }
  }

  async function downloadFile(file: SharedFile, ownerDeviceId: string) {
    const result = await manager.downloadFile(file, ownerDeviceId);
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
    await manager.publishOwnClipboard(textClipboard(text));
    void manager.refreshAll();
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

  // Pre-hydrate layouts whenever the merged device list changes. IndexedDB
  // reads are fast (<5ms locally); racing them against first paint causes the
  // grid to reflow as layouts resolve.
  $effect(() => {
    for (const d of devices) {
      void ensureLayoutFor(d.raw.id, d.raw.platform);
    }
  });

  async function publishOwn() {
    publishStatus = "publishing";
    publishError = null;
    try {
      await manager.publishOwnMetaInfo();
      publishStatus = "done";
    } catch (e) {
      publishStatus = "error";
      publishError = e instanceof Error ? e.message : String(e);
    }
  }

  async function signOut() {
    if (
      !confirm(
        `Sign this browser out of ${manager.connectors.length} sync source${
          manager.connectors.length === 1 ? "" : "s"
        }? Device records stay on the servers until you remove them from another Octi device.`,
      )
    ) {
      return;
    }
    // Wipe credentials + tile layouts in parallel. IdentitySettings stays —
    // matching Android's `SyncSettings.deviceId`, which persists across
    // `removeAll`. Otherwise re-linking creates another "device" identity
    // on the server, leaving stale records behind.
    await Promise.all([
      credentialsRepo.wipeAll().catch(() => undefined),
      tileLayoutRepo.wipeAll().catch(() => undefined),
    ]);
    onSignOut();
  }

  onMount(async () => {
    await publishOwn();
    // Poll loop drives manager.refreshAll(); the manager itself fans out per
    // connector. `refreshOnStart: true` (default) fires an immediate refresh.
    stopPollLoop = startPollLoop(() => manager.refreshAll());
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
  // between polls.
  let now = $state(Date.now());
  $effect(() => {
    const i = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(i);
  });
  const lastSyncLabel = $derived((void now, timeAgo(lastSyncedAt)));

  // Self-first sort. Uses the IdentitySettings-sourced `ownDeviceId` — same
  // across all connectors thanks to the per-install identity invariant.
  const devicesOrdered = $derived(sortDevicesSelfFirst(devices, ownDeviceId));

  // Screenshot-CI marker. Set once the first refresh has completed
  // (devices non-empty / non-loading) so Playwright can wait deterministically.
  $effect(() => {
    if (devices.length > 0 && !loading) {
      document.documentElement.setAttribute("data-screenshot-ready", "dashboard");
    }
  });

  // Nav subtitle:
  //   - one connector: "X · domain"
  //   - multiple: "X · N sync sources"
  // PR 3 will add a Sync Sources screen that lists each connector separately;
  // the nav subtitle becomes a click target into that screen.
  const accountSubtitle = $derived(
    primaryRecord
      ? manager.connectors.length === 1
        ? `Signed in as ${primaryRecord.deviceLabel || "Browser"} · ${primaryRecord.serverAddress.domain}`
        : `Signed in as ${primaryRecord.deviceLabel || "Browser"} · ${manager.connectors.length} sync sources`
      : "",
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
  function openSyncSources() {
    showSyncSources = true;
  }
  function closeSyncSources() {
    showSyncSources = false;
  }
  function openIssues() {
    showIssues = true;
  }
  function closeIssues() {
    showIssues = false;
  }
  function openAddSource() {
    showAddSource = true;
  }
  function closeAddSource() {
    showAddSource = false;
  }

  /**
   * Settings rename: persist the new record, then sync the manager so its
   * connector list reflects the updated label / publish path.
   */
  async function handleRecordUpdated(next: CredentialRecord) {
    await credentialsRepo.save(next);
    await manager.bootstrap();
    void manager.refreshAll();
  }

  /**
   * Onboarding (CreateAccount / LinkPaste / LinkScan) completed inside the
   * Add Source sheet — the new credential is already persisted. Pull it into
   * the manager and trigger a refresh; the SyncSources screen behind us
   * picks up the new card reactively.
   */
  async function handleAddSourceDone() {
    showAddSource = false;
    await manager.bootstrap();
    void manager.refreshAll();
  }

  const navMenuItems = $derived<MenuItem[]>([
    {
      label: publishStatus === "publishing" ? "Publishing…" : "Republish my MetaInfo",
      onClick: publishOwn,
      disabled: publishStatus === "publishing",
    },
    { label: "Add another device", onClick: openShareSheet },
    {
      label: `Sync sources (${manager.connectors.length})`,
      onClick: openSyncSources,
      separatorBefore: true,
    },
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
      issuesCount={issues.length}
      onRefresh={() => manager.refreshAll()}
      onOpenIssues={openIssues}
      onOpenSettings={openSettings}
      menuItems={navMenuItems}
    />

    {#if publishStatus === "error" && publishError}
      <p class="banner err">MetaInfo publish failed: {publishError}</p>
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
        {#if layout && primaryConnector}
          <DeviceCard
            deviceId={d.raw.id}
            deviceLabel={d.raw.label ?? "(no label)"}
            devicePlatform={d.raw.platform ?? "unknown"}
            lastSeen={d.raw.lastSeen}
            {isSelf}
            {layout}
            data={d}
            ownConnectorIds={manager.connectors.map((c) => c.connectorId)}
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

{#if showSettings && primaryRecord}
  <SettingsScreen
    record={primaryRecord}
    {ownDeviceId}
    connectorCount={manager.connectors.length}
    onRecordUpdated={handleRecordUpdated}
    onOpenSyncSources={openSyncSources}
    onSignOut={signOut}
    onClose={closeSettings}
  />
{/if}

{#if showShareSheet && primaryConnector}
  <Sheet title="Add another device" subtitle="Share a one-time code or QR" wide onClose={closeShareSheet}>
    <ShareCode connector={primaryConnector} />
  </Sheet>
{/if}

{#if showSyncSources}
  <SyncSourcesScreen
    {manager}
    {ownDeviceId}
    onAddSource={openAddSource}
    onClose={closeSyncSources}
  />
{/if}

{#if showIssues}
  <IssuesSummarySheet
    {manager}
    onOpenSources={() => {
      closeIssues();
      openSyncSources();
    }}
    onClose={closeIssues}
  />
{/if}

{#if showAddSource}
  <Sheet title="Add a sync source" subtitle="Link this browser to another Octi server" wide onClose={closeAddSource}>
    <!-- manageScreenshotMarker=false: this Onboarding is nested inside a
         Sheet on top of the dashboard, so the outer screenshot marker
         stays in charge. Without this the marker would flip to "onboarding"
         on open and ping-pong back to "dashboard" on close. -->
    <Onboarding onDone={handleAddSourceDone} manageScreenshotMarker={false} />
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
