<script lang="ts">
  import type { WifiInfo } from "../../../modules/wifi";
  import DetailRow from "../DetailRow.svelte";
  import Sheet from "../Sheet.svelte";

  let {
    info,
    error,
    deviceLabel,
    onClose,
  }: {
    info: WifiInfo | null;
    error: string | null;
    deviceLabel: string;
    onClose: () => void;
  } = $props();

  function freqLabel(t: string | null | undefined): string {
    if (t === "5GHZ") return "5 GHz";
    if (t === "2.4GHZ") return "2.4 GHz";
    if (t === "UNKNOWN") return "Unknown";
    return "—";
  }

  function stripQuotes(s: string | null | undefined): string {
    if (!s) return "";
    if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
    return s;
  }
</script>

<Sheet title="Wi-Fi" subtitle={deviceLabel} {onClose}>
  {#if error}
    <div class="error">Decode failed: {error}</div>
  {:else if !info}
    <div class="empty">This device hasn't published WifiInfo yet.</div>
  {:else if !info.currentWifi}
    <div class="empty">No active Wi-Fi connection.</div>
  {:else}
    <DetailRow
      label="SSID"
      value={stripQuotes(info.currentWifi.ssid) || "—"}
      copyValue={stripQuotes(info.currentWifi.ssid)}
    />
    <DetailRow label="Frequency" value={freqLabel(info.currentWifi.freqType)} />
    {#if info.currentWifi.reception != null}
      <DetailRow
        label="Reception"
        value={`${Math.round(info.currentWifi.reception * 100)}%`}
        copyValue={String(info.currentWifi.reception)}
      />
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
