<script lang="ts">
  import { onMount } from "svelte";

  import { listDevices, OctiApiError } from "../protocol/octi-api";
  import type { DeviceMetadata } from "../protocol/models";
  import { credentialsRepo, type CredentialRecord } from "../storage/credentials-repo";
  import { createPayloadEncryption } from "../crypto/payload";
  import {
    fetchPeerMetaInfo,
    metaInfoLabel,
    publishOwnMetaInfo,
    type MetaInfo,
  } from "../modules/meta";
  import ShareCode from "./ShareCode.svelte";

  let { record, onSignOut }: { record: CredentialRecord; onSignOut: () => void } = $props();

  interface EnrichedDevice {
    raw: DeviceMetadata;
    meta: MetaInfo | null;
    metaError: string | null;
  }

  let devices = $state<EnrichedDevice[] | null>(null);
  let loadError = $state<string | null>(null);
  let loading = $state(false);
  let publishStatus = $state<"idle" | "publishing" | "done" | "error">("idle");
  let publishError = $state<string | null>(null);
  let showShare = $state(false);

  const creds = {
    accountId: record.accountId,
    devicePassword: record.devicePassword,
    deviceId: record.ownDeviceId,
  };
  const crypti = createPayloadEncryption(record.encryptionKeyset);

  async function refresh() {
    loading = true;
    loadError = null;
    try {
      const list = await listDevices({ server: record.serverAddress, creds });
      // Fetch peer MetaInfo in parallel. Each call independently swallows its
      // own decrypt errors so one rotten device entry doesn't blank the list.
      const enriched = await Promise.all(
        list.map(async (raw) => {
          try {
            const meta = await fetchPeerMetaInfo({
              server: record.serverAddress,
              creds,
              crypti,
              peerDeviceId: raw.id,
            });
            return { raw, meta, metaError: null } satisfies EnrichedDevice;
          } catch (e) {
            return {
              raw,
              meta: null,
              metaError: e instanceof Error ? e.message : String(e),
            } satisfies EnrichedDevice;
          }
        }),
      );
      devices = enriched;
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
    // Publish our own MetaInfo first so we appear with a label in the list, then
    // load the device list. Failures of either step are non-fatal to the other.
    await publishOwn();
    await refresh();
  });
</script>

<section>
  <h1>Dashboard (M4 stub)</h1>
  <p style="opacity: 0.75; font-size: 0.9rem;">
    M5–M7 will fill this in with clipboard cards, file list, and upload UI. The
    device list below is enriched with each device's MetaModule payload so
    labels and platforms match what's shown on your phone.
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

  <div style="display: flex; gap: 0.5rem; margin: 1rem 0; flex-wrap: wrap;">
    <button onclick={refresh} disabled={loading}>
      {loading ? "Loading…" : "Refresh device list"}
    </button>
    <button onclick={publishOwn} disabled={publishStatus === "publishing"}>
      {publishStatus === "publishing" ? "Publishing…" : "Republish my MetaInfo"}
    </button>
    <button onclick={() => (showShare = !showShare)}>
      {showShare ? "Hide share code" : "Generate share code"}
    </button>
    <button onclick={signOut}>Sign out (wipe)</button>
  </div>

  {#if publishStatus === "error" && publishError}
    <p style="color: #ff8a8a;">MetaInfo publish failed: {publishError}</p>
  {/if}

  {#if loadError}
    <p style="color: #ff8a8a;">{loadError}</p>
  {/if}

  {#if devices}
    <h2>Devices ({devices.length})</h2>
    <ul style="list-style: none; padding: 0;">
      {#each devices as d (d.raw.id)}
        {@const isSelf = d.raw.id === record.ownDeviceId}
        {@const label = metaInfoLabel(d.meta, d.raw.label ?? "(no label)")}
        <li
          style="padding: 0.6rem 0.75rem; border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; margin-bottom: 0.4rem;"
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
        </li>
      {/each}
    </ul>
  {/if}

  {#if showShare}
    <ShareCode />
  {/if}
</section>
