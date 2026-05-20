<script lang="ts">
  import { onMount } from "svelte";
  import { publishOwnMetaInfo } from "../../modules/meta";
  import { createPayloadEncryption } from "../../crypto/payload";
  import { serverBaseUrl } from "../../protocol/models";
  import { OctiServerConnector } from "../../protocol/octi-server-connector";
  import { credentialsRepo, type CredentialRecord } from "../../storage/credentials-repo";
  import { OCTI_WEB_REPO_URL } from "../../version";
  import CopyButton from "./CopyButton.svelte";
  import DetailRow from "./DetailRow.svelte";
  import Sheet from "./Sheet.svelte";
  import { bytesToHex, formatFingerprint } from "./fingerprint";

  /**
   * Instance-scope configuration sheet. Mounts as a wider Sheet (560 px on
   * desktop) so the multi-section layout breathes without forcing the user
   * to scroll past every section every time.
   *
   * Owns:
   *  - Editable device label with Save & republish (writes to credentials DB,
   *    then publishes new MetaInfo so peers see the rename; also propagates
   *    `Octi-Device-Label` header so DeviceMetadata.label updates server-side).
   *  - Read-only diagnostics (server URL, account ID, own device ID,
   *    encryption keyset fingerprint — all copyable).
   *  - Sign-out shortcut mirroring the nav-overflow item.
   *
   * The fingerprint is a SHA-256 of the raw keyset bytes. It's safe to show
   * publicly: it lets a user verify two devices share the same key without
   * exposing the key material itself.
   */
  let {
    record,
    ownDeviceId,
    connectorCount = 1,
    onRecordUpdated,
    onOpenSyncSources,
    onSignOut,
    onClose,
  }: {
    record: CredentialRecord;
    /** Per-install own-device UUID, threaded from App.svelte → DashboardStub. */
    ownDeviceId: string;
    /** Number of linked sync sources. Drives the secondary line under the
     *  "Sync sources" row. Optional so the prop is back-compat with the
     *  single-connector entry point. */
    connectorCount?: number;
    onRecordUpdated: (next: CredentialRecord) => void;
    /** Opens the multi-connector Sync Sources screen. When omitted (e.g. in
     *  tests), the row is hidden. */
    onOpenSyncSources?: () => void;
    onSignOut: () => void;
    onClose: () => void;
  } = $props();

  let labelDraft = $state(record.deviceLabel);
  let saving = $state(false);
  let saveStatus = $state<"idle" | "ok" | "error">("idle");
  let saveError = $state<string | null>(null);

  const trimmed = $derived(labelDraft.trim());
  const canSave = $derived(
    trimmed.length > 0 && trimmed !== record.deviceLabel && !saving,
  );

  // Fingerprint resolution. computeFingerprint may reject (Web Crypto requires
  // a secure context; localhost qualifies but a misconfigured prod could
  // surface this). Render "Unavailable" in that case rather than blowing up.
  let fingerprintHex = $state<string | null>(null);
  let fingerprintError = $state<string | null>(null);

  // Screenshot-CI marker. Sync $effect — async onMount can't return a teardown.
  $effect(() => {
    document.documentElement.setAttribute("data-screenshot-ready", "settings");
    return () => {
      if (document.documentElement.getAttribute("data-screenshot-ready") === "settings") {
        document.documentElement.setAttribute("data-screenshot-ready", "dashboard");
      }
    };
  });

  onMount(async () => {
    try {
      // Pass the Uint8Array directly to subtle.digest — passing .buffer would
      // ignore byteOffset/byteLength and digest the wrong bytes for slices.
      const digest = await crypto.subtle.digest("SHA-256", record.encryptionKeyset);
      fingerprintHex = bytesToHex(new Uint8Array(digest));
    } catch (e) {
      fingerprintError = e instanceof Error ? e.message : String(e);
    }
  });

  async function save() {
    if (!canSave) return;
    saving = true;
    saveStatus = "idle";
    saveError = null;
    // $state.snapshot deep-unwraps Svelte 5's reactive proxies — required
    // before IndexedDB can structured-clone the record (proxies fail clone
    // with "could not be cloned"). The record's nested `serverAddress`
    // object is the one that trips this.
    const updated: CredentialRecord = {
      ...$state.snapshot(record),
      deviceLabel: trimmed,
    };
    try {
      // Local-first: persist the new label before the network attempt. If
      // publish fails, the credentials DB still reflects the user's intent
      // and the next sync tick reconciles peers.
      await credentialsRepo.save(updated);
      const crypti = createPayloadEncryption(updated.encryptionKeyset);
      const connector = new OctiServerConnector(updated, ownDeviceId);
      await publishOwnMetaInfo({ connector, crypti });
      saveStatus = "ok";
      onRecordUpdated(updated);
    } catch (e) {
      saveStatus = "error";
      saveError = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }
</script>

<Sheet title="Settings" subtitle="This browser instance" wide {onClose}>
  <section class="block">
    <h3 class="h3">Device label</h3>
    <p class="hint">The name other devices in this account see for this browser.</p>
    <input
      type="text"
      bind:value={labelDraft}
      placeholder="e.g. Firefox on work laptop"
      disabled={saving}
      aria-label="Device label"
    />
    <div class="row">
      <button type="button" onclick={save} disabled={!canSave}>
        {saving ? "Publishing…" : "Save & republish"}
      </button>
    </div>
    {#if saveStatus === "ok"}
      <div class="ok">Published. Other devices will see the new label on their next sync.</div>
    {/if}
    {#if saveStatus === "error" && saveError}
      <div class="err">{saveError}</div>
    {/if}
  </section>

  <section class="block">
    <h3 class="h3">Connection</h3>
    <DetailRow label="Server" value={serverBaseUrl(record.serverAddress)} mono />
    <DetailRow label="Account ID" value={record.accountId} mono />
    <!-- Display the IdentitySettings-sourced own device id rather than
         record.ownDeviceId — the record field is legacy and may drift; the
         prop is what we actually send as X-Device-ID. -->
    <DetailRow label="Device ID" value={ownDeviceId} mono />
  </section>

  <section class="block">
    <h3 class="h3">Encryption key fingerprint</h3>
    <p class="hint">
      SHA-256 of this account's shared encryption keyset. Compare across devices to
      verify they're using the same key (matching fingerprint = peers can decrypt
      each other).
    </p>
    {#if fingerprintError}
      <div class="err">Unavailable: {fingerprintError}</div>
    {:else if fingerprintHex == null}
      <div class="hint">Computing…</div>
    {:else}
      <div class="fingerprint">
        <code class="fp-display">{formatFingerprint(fingerprintHex)}</code>
        <CopyButton value={fingerprintHex} label="Copy" />
      </div>
    {/if}
  </section>

  {#if onOpenSyncSources}
    <section class="block">
      <h3 class="h3">Sync sources</h3>
      <p class="hint">
        Manage every Octi-server account this browser is linked to — add a new
        sync source, view per-connector devices, or disconnect one.
      </p>
      <div class="row">
        <button type="button" onclick={onOpenSyncSources} data-testid="settings-open-sources">
          {connectorCount} linked · Manage…
        </button>
      </div>
    </section>
  {/if}

  <section class="block">
    <h3 class="h3">About</h3>
    <p class="hint">
      Octi Web is open source. Report issues, browse the changelog, or contribute on
      <a href={OCTI_WEB_REPO_URL} target="_blank" rel="noopener noreferrer">GitHub</a>.
    </p>
  </section>

  <section class="block">
    <h3 class="h3">Sign out</h3>
    <p class="hint">
      Wipes credentials + tile layouts from this browser. The device record stays on
      the server until you remove it from another Octi device.
    </p>
    <div class="row">
      <button type="button" class="destructive" onclick={onSignOut}>Sign out</button>
    </div>
  </section>
</Sheet>

<style>
  .block {
    margin-bottom: 18px;
  }
  .block:last-child {
    margin-bottom: 0;
  }
  .h3 {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--md-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0 0 6px;
  }
  .hint {
    margin: 0 0 8px;
    font-size: 0.78rem;
    color: var(--md-color-on-surface-variant);
  }
  .row {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }
  .ok {
    margin-top: 8px;
    color: var(--md-color-primary);
    font-size: 0.82rem;
  }
  .err {
    margin-top: 8px;
    color: var(--md-color-error);
    font-size: 0.82rem;
  }
  .destructive {
    color: var(--md-color-error);
    border-color: color-mix(in srgb, var(--md-color-error) 50%, transparent);
  }
  .destructive:hover {
    background: color-mix(in srgb, var(--md-color-error) 12%, transparent);
  }
  .fingerprint {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .fp-display {
    flex: 1;
    min-width: 0;
    font-family: "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.78rem;
    color: var(--md-color-on-surface);
    background: var(--md-color-surface-container-low);
    padding: 8px 10px;
    border-radius: 6px;
    line-height: 1.4;
    word-break: break-all;
  }
</style>
