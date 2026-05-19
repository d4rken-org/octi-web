<script lang="ts">
  import { receptionBars, receptionLabel, type WifiInfo } from "../../../modules/wifi";
  import Icon from "../Icon.svelte";
  import Tile from "../Tile.svelte";

  let {
    info,
    error,
    wide = false,
    onOpen,
  }: {
    info: WifiInfo | null;
    error: string | null;
    wide?: boolean;
    onOpen: () => void;
  } = $props();

  const state = $derived<"ok" | "empty" | "error">(error ? "error" : info ? "ok" : "empty");
  const connected = $derived(info?.currentWifi != null);
  const bars = $derived(connected ? receptionBars(info!.currentWifi!.reception) : 0);

  function freqLabel(): string {
    const t = info?.currentWifi?.freqType;
    if (t === "5GHZ") return "5 GHz";
    if (t === "2.4GHZ") return "2.4 GHz";
    if (t === "UNKNOWN") return "Wi-Fi";
    return "Wi-Fi";
  }

  function stripQuotes(s: string | null | undefined): string {
    if (!s) return "";
    if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
    return s;
  }
</script>

<Tile
  title={connected ? freqLabel() : "Wi-Fi"}
  {state}
  {wide}
  {onOpen}
>
  {#snippet icon()}
    <Icon name={connected ? "wifi" : "wifi-off"} />
  {/snippet}
  {#snippet statusLine()}
    {#if error}
      Decode failed
    {:else if !info}
      Not published yet
    {:else if connected}
      <span class="bars" aria-hidden="true">
        {#each [1, 2, 3, 4] as i (i)}
          <span class="bar" class:on={i <= bars} style="height: {i * 3 + 2}px"></span>
        {/each}
      </span>
      <span>{receptionLabel(info.currentWifi!.reception)}</span>
    {:else}
      Not connected
    {/if}
  {/snippet}
  {#if connected && info?.currentWifi?.ssid}
    <span class="ssid">{stripQuotes(info.currentWifi.ssid)}</span>
  {/if}
</Tile>

<style>
  .bars {
    display: inline-flex;
    align-items: flex-end;
    gap: 2px;
    margin-right: 6px;
    vertical-align: middle;
    height: 14px;
  }
  .bar {
    display: inline-block;
    width: 3px;
    border-radius: 1px;
    background: var(--md-color-outline-variant);
  }
  .bar.on {
    background: var(--md-color-primary);
  }
  .ssid {
    color: var(--md-color-on-surface);
    font-size: 0.78rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: block;
  }
</style>
