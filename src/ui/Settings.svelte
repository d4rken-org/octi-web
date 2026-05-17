<script lang="ts">
  import { onMount } from "svelte";
  import {
    credentialsRepo,
    type CredentialRecord,
  } from "../storage/credentials-repo";

  let record = $state<CredentialRecord | undefined>(undefined);
  let loading = $state(true);
  let saving = $state(false);
  let message = $state<string | null>(null);

  // Editable form state (mirrors record fields). Bound to inputs.
  let accountId = $state("");
  let devicePassword = $state("");
  let ownDeviceId = $state("");
  let deviceLabel = $state("Browser");
  let domain = $state("");
  let protocol = $state<"http" | "https">("https");
  let port = $state(443);
  let keysetBase64 = $state("");

  onMount(async () => {
    const existing = await credentialsRepo.getActive();
    if (existing) {
      record = existing;
      populateForm(existing);
    }
    loading = false;
  });

  function populateForm(r: CredentialRecord) {
    accountId = r.accountId;
    devicePassword = r.devicePassword;
    ownDeviceId = r.ownDeviceId;
    deviceLabel = r.deviceLabel;
    domain = r.serverAddress.domain;
    protocol = r.serverAddress.protocol;
    port = r.serverAddress.port;
    keysetBase64 = bytesToBase64(r.encryptionKeyset);
  }

  async function save() {
    saving = true;
    message = null;
    try {
      const next: CredentialRecord = {
        accountId: accountId.trim(),
        devicePassword: devicePassword.trim(),
        ownDeviceId: ownDeviceId.trim(),
        deviceLabel: deviceLabel.trim() || "Browser",
        serverAddress: { domain: domain.trim(), protocol, port },
        encryptionKeyset: base64ToBytes(keysetBase64.trim()),
        createdAt: record?.createdAt ?? Date.now(),
      };
      await credentialsRepo.save(next);
      record = next;
      message = "Saved.";
    } catch (err) {
      message = `Save failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      saving = false;
    }
  }

  async function wipe() {
    if (!confirm("Wipe all stored credentials on this device?")) return;
    await credentialsRepo.wipe();
    record = undefined;
    accountId = devicePassword = ownDeviceId = domain = keysetBase64 = "";
    deviceLabel = "Browser";
    protocol = "https";
    port = 443;
    message = "Cleared.";
  }

  // Plain base64 helpers — no padding tricks, just standard btoa/atob over byte arrays.
  function bytesToBase64(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }
  function base64ToBytes(b64: string): Uint8Array {
    if (!b64) return new Uint8Array(0);
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
</script>

<section>
  <h1>octi-web — Settings (M1 scaffold)</h1>
  <p style="opacity: 0.75; font-size: 0.9rem;">
    This screen is here to validate the IndexedDB credentials repo end-to-end. Onboarding
    UI (account create / paste-link / QR / generate share code) replaces this in M3.
  </p>

  {#if loading}
    <p>Loading…</p>
  {:else}
    <label>
      <span>Account ID (UUID)</span>
      <input bind:value={accountId} placeholder="00000000-0000-0000-0000-000000000000" />
    </label>
    <label>
      <span>Device password</span>
      <input bind:value={devicePassword} type="password" />
    </label>
    <label>
      <span>Own device ID (UUID)</span>
      <input bind:value={ownDeviceId} placeholder="00000000-0000-0000-0000-000000000000" />
    </label>
    <label>
      <span>Device label</span>
      <input bind:value={deviceLabel} />
    </label>

    <h2>Server address</h2>
    <label>
      <span>Domain</span>
      <input bind:value={domain} placeholder="prod.kserver.octi.darken.eu" />
    </label>
    <div style="display: flex; gap: 0.75rem;">
      <label style="flex: 0 0 8rem;">
        <span>Protocol</span>
        <select bind:value={protocol}>
          <option value="https">https</option>
          <option value="http">http</option>
        </select>
      </label>
      <label style="flex: 1;">
        <span>Port</span>
        <input type="number" min="1" max="65535" bind:value={port} />
      </label>
    </div>

    <h2>Encryption keyset (base64)</h2>
    <p style="opacity: 0.75; font-size: 0.85rem;">
      Tink AES-GCM-SIV proto keyset bytes. M2 wires this up properly — for now you can
      paste the base64 of any byte sequence to confirm round-trip.
    </p>
    <label>
      <span>Keyset</span>
      <textarea rows="3" bind:value={keysetBase64}></textarea>
    </label>

    <div style="display: flex; gap: 0.5rem; margin-top: 1rem;">
      <button onclick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
      <button onclick={wipe} disabled={!record}>Sign out (wipe)</button>
    </div>

    {#if message}
      <p style="margin-top: 0.75rem; opacity: 0.9;">{message}</p>
    {/if}

    {#if record}
      <h2>Stored record (raw)</h2>
      <pre>{JSON.stringify(
          {
            ...record,
            encryptionKeyset: `<${record.encryptionKeyset.byteLength} bytes>`,
          },
          null,
          2,
        )}</pre>
    {/if}
  {/if}
</section>
