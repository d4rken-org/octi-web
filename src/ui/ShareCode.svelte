<script lang="ts">
  import { createShareCode } from "../protocol/octi-api";
  import { encodeLinkingData } from "../linking/linking-data";
  import { renderQrPng } from "../linking/qr";
  import { credentialsRepo, type CredentialRecord } from "../storage/credentials-repo";

  let record = $state<CredentialRecord | null>(null);
  let linkText = $state<string | null>(null);
  let qrDataUrl = $state<string | null>(null);
  let minting = $state(false);
  let error = $state<string | null>(null);
  let copied = $state(false);

  async function mint() {
    error = null;
    copied = false;
    minting = true;
    try {
      record = (await credentialsRepo.getActive()) ?? null;
      if (!record) throw new Error("No active account — sign in first.");
      const r = record;
      const shareCode = await createShareCode({
        server: r.serverAddress,
        creds: {
          accountId: r.accountId,
          devicePassword: r.devicePassword,
          deviceId: r.ownDeviceId,
        },
      });
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
  <h1>Share with another device</h1>
  <p style="opacity: 0.75; font-size: 0.9rem;">
    Generate a one-time link that another Octi device can paste or scan to join
    this account. The code expires in ~60 minutes; both halves of the
    transmitted payload (server address + encryption keyset) are required for
    the other device to actually sync.
  </p>

  <div style="display: flex; gap: 0.5rem; margin-top: 1rem;">
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
