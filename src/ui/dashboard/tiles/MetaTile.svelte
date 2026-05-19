<script lang="ts">
  import type { MetaInfo } from "../../../modules/meta";
  import Icon from "../Icon.svelte";
  import type { IconName } from "../icons";
  import Tile from "../Tile.svelte";

  let {
    info,
    error,
    wide = false,
    onOpen,
  }: {
    info: MetaInfo | null;
    error: string | null;
    wide?: boolean;
    onOpen: () => void;
  } = $props();

  const state = $derived<"ok" | "empty" | "error">(error ? "error" : info ? "ok" : "empty");

  function deviceIcon(t: string | undefined): IconName {
    switch (t) {
      case "PHONE":
        return "phone";
      case "TABLET":
        return "tablet";
      case "DESKTOP":
        return "desktop";
      case "BROWSER":
        return "browser";
      case "WATCH":
        return "watch";
      case "TV":
        return "tv";
      case "AUTO":
        return "car";
      default:
        return "device-unknown";
    }
  }

  function osLine(i: MetaInfo): string {
    if (i.androidVersionName) return `Android ${i.androidVersionName}`;
    if (i.osType && i.osVersionName) return `${i.osType} ${i.osVersionName}`;
    if (i.osType) return i.osType;
    return "";
  }

  function modelLine(i: MetaInfo): string {
    const parts: string[] = [];
    if (i.deviceManufacturer) parts.push(i.deviceManufacturer);
    if (i.deviceName) parts.push(i.deviceName);
    return parts.join(" ");
  }
</script>

<Tile title={info?.deviceName || "Device"} {state} {wide} {onOpen}>
  {#snippet icon()}
    <Icon name={deviceIcon(info?.deviceType)} />
  {/snippet}
  {#snippet statusLine()}
    {#if error}
      Decode failed
    {:else if info}
      {osLine(info) || modelLine(info)}
    {:else}
      Not published yet
    {/if}
  {/snippet}
  {#if info?.octiVersionName}
    {info.octiVersionName}
  {/if}
</Tile>
