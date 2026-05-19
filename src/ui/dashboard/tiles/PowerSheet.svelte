<script lang="ts">
  import { batteryPercent, type PowerInfo } from "../../../modules/power";
  import DetailRow from "../DetailRow.svelte";
  import Sheet from "../Sheet.svelte";

  let {
    info,
    error,
    deviceLabel,
    onClose,
  }: {
    info: PowerInfo | null;
    error: string | null;
    deviceLabel: string;
    onClose: () => void;
  } = $props();

  const pct = $derived(info ? batteryPercent(info.battery) : null);

  function healthLabel(h: number | null | undefined): string | null {
    if (h == null) return null;
    // Mirrors Android BatteryManager constants.
    switch (h) {
      case 2:
        return "Good";
      case 3:
        return "Overheat";
      case 4:
        return "Dead";
      case 5:
        return "Over voltage";
      case 6:
        return "Unspecified failure";
      case 7:
        return "Cold";
      default:
        return `Unknown (${h})`;
    }
  }
</script>

<Sheet title="Power" subtitle={deviceLabel} {onClose}>
  {#if error}
    <div class="error">Decode failed: {error}</div>
  {:else if !info}
    <div class="empty">This device hasn't published PowerInfo yet.</div>
  {:else}
    <DetailRow label="Battery level" value={pct != null ? `${pct}%` : "—"} copyValue={pct != null ? String(pct) : ""} />
    <DetailRow label="Raw level" value={`${info.battery.level} / ${info.battery.scale}`} />
    <DetailRow label="Status" value={info.status} />
    {#if info.battery.temp != null}
      <DetailRow label="Temperature" value={`${info.battery.temp.toFixed(1)} °C`} copyValue={String(info.battery.temp)} />
    {/if}
    {#if healthLabel(info.battery.health)}
      <DetailRow label="Health" value={healthLabel(info.battery.health)} />
    {/if}
    {#if info.chargeIO.currentNow != null}
      <DetailRow label="Current (now)" value={`${info.chargeIO.currentNow} µA`} copyValue={String(info.chargeIO.currentNow)} />
    {/if}
    {#if info.chargeIO.currentAvg != null}
      <DetailRow label="Current (avg)" value={`${info.chargeIO.currentAvg} µA`} copyValue={String(info.chargeIO.currentAvg)} />
    {/if}
    {#if info.chargeIO.fullSince}
      <DetailRow label="Full since" value={info.chargeIO.fullSince} mono />
    {/if}
    {#if info.chargeIO.fullAt}
      <DetailRow label="Full at" value={info.chargeIO.fullAt} mono />
    {/if}
    {#if info.chargeIO.emptyAt}
      <DetailRow label="Empty at" value={info.chargeIO.emptyAt} mono />
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
