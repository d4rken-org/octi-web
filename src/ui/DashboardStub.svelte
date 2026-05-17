<script lang="ts">
  import { listDevices, OctiApiError } from "../protocol/octi-api";
  import type { DeviceMetadata } from "../protocol/models";
  import { credentialsRepo, type CredentialRecord } from "../storage/credentials-repo";
  import ShareCode from "./ShareCode.svelte";

  let { record, onSignOut }: { record: CredentialRecord; onSignOut: () => void } = $props();

  let devices = $state<DeviceMetadata[] | null>(null);
  let loadError = $state<string | null>(null);
  let loading = $state(false);
  let showShare = $state(false);

  async function refresh() {
    loading = true;
    loadError = null;
    try {
      devices = await listDevices({
        server: record.serverAddress,
        creds: {
          accountId: record.accountId,
          devicePassword: record.devicePassword,
          deviceId: record.ownDeviceId,
        },
      });
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
</script>

<section>
  <h1>Dashboard (M3 stub)</h1>
  <p style="opacity: 0.75; font-size: 0.9rem;">
    M4–M7 will fill this in with the device list, clipboard cards, file list, and
    upload UI. For now you can verify the account is reachable and mint share
    codes to add more devices.
  </p>

  <h2>This device</h2>
  <pre>{JSON.stringify(
      {
        accountId: record.accountId,
        ownDeviceId: record.ownDeviceId,
        deviceLabel: record.deviceLabel,
        serverAddress: record.serverAddress,
        encryptionKeyset: `<${record.encryptionKeyset.byteLength} bytes>`,
      },
      null,
      2,
    )}</pre>

  <div style="display: flex; gap: 0.5rem; margin: 1rem 0;">
    <button onclick={refresh} disabled={loading}>
      {loading ? "Loading…" : "Refresh device list"}
    </button>
    <button onclick={() => (showShare = !showShare)}>
      {showShare ? "Hide share code" : "Generate share code"}
    </button>
    <button onclick={signOut}>Sign out (wipe)</button>
  </div>

  {#if loadError}
    <p style="color: #ff8a8a;">{loadError}</p>
  {/if}

  {#if devices}
    <h2>Devices ({devices.length})</h2>
    <ul style="list-style: none; padding: 0;">
      {#each devices as d (d.id)}
        <li
          style="padding: 0.6rem 0.75rem; border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; margin-bottom: 0.4rem;"
        >
          <strong>{d.label ?? "(no label)"}</strong>
          {#if d.id === record.ownDeviceId}<span style="opacity: 0.6;"> · this device</span>{/if}
          <div style="opacity: 0.7; font-size: 0.85rem;">
            id: <code>{d.id}</code>
          </div>
          <div style="opacity: 0.7; font-size: 0.85rem;">
            platform: {d.platform ?? "?"} · version: {d.version ?? "?"} · last seen: {d.lastSeen ??
              "?"}
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  {#if showShare}
    <ShareCode />
  {/if}
</section>
