<script lang="ts">
  import type { MetaInfo } from "../../../modules/meta";
  import DetailRow from "../DetailRow.svelte";
  import Sheet from "../Sheet.svelte";

  let {
    info,
    error,
    deviceLabel,
    onClose,
  }: {
    info: MetaInfo | null;
    error: string | null;
    deviceLabel: string;
    onClose: () => void;
  } = $props();
</script>

<Sheet title="Device" subtitle={deviceLabel} {onClose}>
  {#if error}
    <div class="error">Decode failed: {error}</div>
  {:else if !info}
    <div class="empty">This device hasn't published MetaInfo yet.</div>
  {:else}
    <DetailRow label="Label" value={info.deviceLabel ?? ""} />
    <DetailRow label="Manufacturer" value={info.deviceManufacturer} />
    <DetailRow label="Model" value={info.deviceName} />
    <DetailRow label="Device type" value={info.deviceType} />
    {#if info.osType || info.osVersionName}
      <DetailRow label="OS" value={[info.osType, info.osVersionName].filter(Boolean).join(" ")} />
    {/if}
    {#if info.androidVersionName}
      <DetailRow label="Android version" value={info.androidVersionName} />
    {/if}
    {#if info.androidApiLevel != null}
      <DetailRow label="Android API" value={String(info.androidApiLevel)} />
    {/if}
    {#if info.androidSecurityPatch}
      <DetailRow label="Security patch" value={info.androidSecurityPatch} />
    {/if}
    {#if info.deviceBootedAt}
      <DetailRow label="Booted at" value={info.deviceBootedAt} mono />
    {/if}
    <DetailRow label="Octi version" value={info.octiVersionName} />
    <DetailRow label="Git SHA" value={info.octiGitSha} mono />
    <DetailRow label="Device ID" value={info.deviceId.id} mono />
  {/if}
</Sheet>

<style>
  .error {
    color: var(--md-color-error);
    font-size: 0.9rem;
  }
  .empty {
    color: var(--md-color-on-surface-variant);
    font-size: 0.9rem;
  }
</style>
