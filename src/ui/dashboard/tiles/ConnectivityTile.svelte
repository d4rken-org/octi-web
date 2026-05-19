<script lang="ts">
  import { connectionTypeLabel, type ConnectivityInfo } from "../../../modules/connectivity";
  import Icon from "../Icon.svelte";
  import type { IconName } from "../icons";
  import Tile from "../Tile.svelte";

  let {
    info,
    error,
    wide = false,
    onOpen,
  }: {
    info: ConnectivityInfo | null;
    error: string | null;
    wide?: boolean;
    onOpen: () => void;
  } = $props();

  const state = $derived<"ok" | "empty" | "error">(error ? "error" : info ? "ok" : "empty");
  const isConnected = $derived(info != null && info.connectionType != null && info.connectionType !== "NONE");

  function iconName(): IconName {
    switch (info?.connectionType) {
      case "WIFI":
        return "wifi";
      case "CELLULAR":
        return "cellular";
      case "ETHERNET":
        return "ethernet";
      case "NONE":
        return "wifi-off";
      default:
        return "globe";
    }
  }
</script>

<Tile
  title={info ? connectionTypeLabel(info.connectionType) : "Connectivity"}
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
    {:else if !info}
      Not published yet
    {:else}
      <span class="status" class:on={isConnected} aria-hidden="true"></span>
      {isConnected ? "Connected" : "Disconnected"}
    {/if}
  {/snippet}
  {#if info?.localAddressIpv4}
    <span class="ip">{info.localAddressIpv4}</span>
  {/if}
</Tile>

<style>
  .status {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--md-color-error);
    margin-right: 6px;
    vertical-align: middle;
  }
  .status.on {
    background: var(--md-color-primary);
  }
  .ip {
    font-family: "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.78rem;
    color: var(--md-color-on-surface);
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
