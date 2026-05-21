<script lang="ts">
  import type { OctiServerConnector } from "../protocol/octi-server-connector";
  import { encodeLinkingData } from "../linking/linking-data";
  import { renderQrPng } from "../linking/qr";

  let {
    connector,
    compact = false,
  }: {
    connector: OctiServerConnector;
    /**
     * When true, hide the header / intro paragraph / target-identity block.
     * Used when the caller has already provided that context (e.g. the
     * multi-connector picker in `DashboardStub` shows the connector
     * identity in the row head). The mint button itself + the generated
     * QR/link still render as normal.
     */
    compact?: boolean;
  } = $props();

  let linkText = $state<string | null>(null);
  let qrDataUrl = $state<string | null>(null);
  let minting = $state(false);
  let error = $state<string | null>(null);
  let copied = $state(false);

  const record = $derived(connector.record);

  async function mint() {
    error = null;
    copied = false;
    minting = true;
    try {
      const r = connector.record;
      const shareCode = await connector.createShareCode();
      const encoded = encodeLinkingData({
        serverAddress: r.serverAddress,
        shareCode: { code: shareCode.code },
        encryptionKeySet: { type: "AES256_GCM_SIV", key: r.encryptionKeyset },
      });
      linkText = encoded;
      qrDataUrl = await renderQrPng(encoded);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      minting = false;
    }
  }

  async function copy() {
    if (!linkText) return;
    try {
      await navigator.clipboard.writeText(linkText);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch (e) {
      error = `Copy failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
</script>

<section>
  {#if !compact}
    <h1>Share with another device</h1>
    <p style="opacity: 0.75; font-size: 0.9rem;">
      Generate a one-time link that another Octi device can paste or scan to join
      this account. The code expires in ~60 minutes; both halves of the
      transmitted payload (server address + encryption keyset) are required for
      the other device to actually sync.
    </p>

    <!--
      Target identity confirmation. The encoded link includes this connector's
      encryption keyset; minting on the wrong account exposes it to the joiner.
      Render the destination next to the mint button so the user can verify.
      Suppressed in compact mode where the surrounding context (e.g. the
      multi-connector picker row head) already shows the identity.
    -->
    <div class="target" data-testid="share-target">
      <div class="target-label">Will pair into:</div>
      <div class="target-value">
        <span class="target-domain">{record.serverAddress.domain}</span>
        <span class="target-sep">·</span>
        <span class="target-device">{record.deviceLabel || "Browser"}</span>
      </div>
      <!--
        Two accounts on the same server with the same browser label would
        otherwise be indistinguishable in this picker, and mis-targeting
        leaks the wrong account's encryption keyset to the joiner. The
        last 6 chars of `accountId` (a server-issued UUID) disambiguate
        without exposing the full id.
      -->
      <div class="target-id" data-testid="share-target-id">
        Account …{record.accountId.slice(-6)}
      </div>
    </div>
  {/if}

  <div style="display: flex; gap: 0.5rem; margin-top: {compact ? '0.5rem' : '1rem'};">
    <button onclick={mint} disabled={minting}>
      {minting ? "Minting…" : linkText ? "Mint another code" : "Mint share code"}
    </button>
  </div>

  {#if linkText}
    {#if qrDataUrl}
      <h2>Scan</h2>
      <img
        src={qrDataUrl}
        alt="QR code containing the link data"
        style="width: 100%; max-width: 320px; border-radius: 6px;"
      />
    {/if}

    <h2>Or paste this text</h2>
    <pre style="white-space: pre-wrap; word-break: break-all;">{linkText}</pre>
    <button onclick={copy}>{copied ? "Copied" : "Copy to clipboard"}</button>
  {/if}

  {#if error}
    <p style="margin-top: 0.75rem; color: #ff8a8a;">{error}</p>
  {/if}
</section>

<style>
  .target {
    margin-top: 1rem;
    padding: 10px 12px;
    border: 1px solid var(--md-color-outline-variant);
    border-radius: 8px;
    background: color-mix(in srgb, var(--md-color-on-surface) 4%, transparent);
  }
  .target-label {
    font-size: 0.72rem;
    color: var(--md-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .target-value {
    margin-top: 2px;
    font-size: 0.9rem;
    color: var(--md-color-on-surface);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .target-domain {
    font-weight: 600;
  }
  .target-sep {
    color: var(--md-color-on-surface-variant);
    margin: 0 0.4em;
  }
  .target-device {
    color: var(--md-color-on-surface-variant);
  }
  .target-id {
    margin-top: 4px;
    font-size: 0.72rem;
    color: var(--md-color-on-surface-variant);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
</style>
