<script lang="ts">
  import { connectionTypeLabel, type ConnectivityInfo } from "../../../modules/connectivity";
  import DetailRow from "../DetailRow.svelte";
  import Sheet from "../Sheet.svelte";

  let {
    info,
    error,
    deviceLabel,
    onClose,
  }: {
    info: ConnectivityInfo | null;
    error: string | null;
    deviceLabel: string;
    onClose: () => void;
  } = $props();
</script>

<Sheet title="Connectivity" subtitle={deviceLabel} {onClose}>
  {#if error}
    <div class="error">Decode failed: {error}</div>
  {:else if !info}
    <div class="empty">This device hasn't published ConnectivityInfo yet.</div>
  {:else}
    <DetailRow label="Type" value={connectionTypeLabel(info.connectionType)} />
    {#if info.publicIp}
      <DetailRow label="Public IP" value={info.publicIp} mono />
    {/if}
    {#if info.localAddressIpv4}
      <DetailRow label="Local IPv4" value={info.localAddressIpv4} mono />
    {/if}
    {#if info.localAddressIpv6}
      <DetailRow label="Local IPv6" value={info.localAddressIpv6} mono />
    {/if}
    {#if info.gatewayIp}
      <DetailRow label="Gateway" value={info.gatewayIp} mono />
    {/if}
    {#if info.dnsServers && info.dnsServers.length > 0}
      {#each info.dnsServers as dns, i (i)}
        <DetailRow label={`DNS ${i + 1}`} value={dns} mono />
      {/each}
    {/if}
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
