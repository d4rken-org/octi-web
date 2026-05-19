<script lang="ts">
  import { batteryPercent, type PowerInfo } from "../../../modules/power";
  import Icon from "../Icon.svelte";
  import type { IconName } from "../icons";
  import Tile from "../Tile.svelte";

  let {
    info,
    error,
    wide = false,
    onOpen,
  }: {
    info: PowerInfo | null;
    error: string | null;
    wide?: boolean;
    onOpen: () => void;
  } = $props();

  const state = $derived<"ok" | "empty" | "error">(error ? "error" : info ? "ok" : "empty");
  const pct = $derived(info ? batteryPercent(info.battery) : null);

  function statusText(i: PowerInfo): string {
    switch (i.status) {
      case "CHARGING":
        return "Charging";
      case "DISCHARGING":
        return "Discharging";
      case "FULL":
        return "Full";
      default:
        return "Unknown";
    }
  }

  function tertiaryText(i: PowerInfo): string {
    const parts: string[] = [];
    if (i.battery.temp != null) parts.push(`${i.battery.temp.toFixed(1)} °C`);
    if (i.status === "CHARGING" && i.chargeIO.fullAt) {
      parts.push(`full at ${shortIso(i.chargeIO.fullAt)}`);
    } else if (i.status === "DISCHARGING" && i.chargeIO.emptyAt) {
      parts.push(`empty at ${shortIso(i.chargeIO.emptyAt)}`);
    }
    return parts.join(" · ");
  }

  function shortIso(s: string): string {
    // "2026-05-18T14:00:00Z" → "14:00"
    const t = s.match(/T(\d{2}:\d{2})/);
    return t ? t[1] : s;
  }

  function iconName(): IconName {
    if (!info || pct == null) return "battery-mid";
    if (pct < 20) return "battery-low";
    if (pct > 75) return "battery-full";
    return "battery-mid";
  }

  function barColor(): string {
    if (!info || pct == null) return "var(--md-color-on-surface-variant)";
    if (info.status === "CHARGING") return "var(--md-color-primary)";
    if (pct < 20) return "var(--md-color-error)";
    if (pct < 40) return "var(--md-color-tertiary)";
    return "var(--md-color-primary)";
  }

  const isLowAlert = $derived(info != null && pct != null && pct < 20 && info.status !== "CHARGING");
</script>

<Tile
  title={info ? (pct != null ? `${pct}%` : "—") : "Power"}
  {state}
  {wide}
  {onOpen}
>
  {#snippet icon()}
    <Icon name={iconName()} />
  {/snippet}
  {#snippet statusLine()}
    {#if error}
      Decode failed
    {:else if info}
      {statusText(info)}
    {:else}
      Not published yet
    {/if}
  {/snippet}

  {#if info}
    <div
      class="bar"
      class:low={isLowAlert}
      role="meter"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={pct ?? 0}
    >
      <div class="bar-fill" style="width: {pct ?? 0}%; background: {barColor()};"></div>
    </div>
    {#if tertiaryText(info)}
      <div class="tertiary">{tertiaryText(info)}</div>
    {/if}
  {/if}
</Tile>

<style>
  .bar {
    margin-top: 6px;
    height: 4px;
    border-radius: 2px;
    background: var(--md-color-outline-variant);
    overflow: hidden;
  }
  .bar.low {
    background: color-mix(in srgb, var(--md-color-error) 18%, transparent);
  }
  .bar-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 200ms ease;
  }
  .tertiary {
    margin-top: 4px;
    font-size: 0.78rem;
    color: var(--md-color-on-surface-variant);
  }
</style>
