<script lang="ts">
  import { packagesByInstalledAtDesc, type AppsInfo } from "../../../modules/apps";
  import Icon from "../Icon.svelte";
  import Tile from "../Tile.svelte";

  let {
    info,
    error,
    wide = false,
    onOpen,
  }: {
    info: AppsInfo | null;
    error: string | null;
    wide?: boolean;
    onOpen: () => void;
  } = $props();

  const state = $derived<"ok" | "empty" | "error">(error ? "error" : info ? "ok" : "empty");
  const count = $derived(info?.installedPackages.length ?? 0);
  const latest = $derived(info && count > 0 ? packagesByInstalledAtDesc(info)[0] : null);
</script>

<Tile
  title={info ? `${count} ${count === 1 ? "app" : "apps"}` : "Apps"}
  {state}
  {wide}
  {onOpen}
>
  {#snippet icon()}
    <Icon name="apps" />
  {/snippet}
  {#snippet statusLine()}
    {#if error}
      Decode failed
    {:else if !info}
      Not published yet
    {:else if latest}
      Last installed
    {:else}
      No installed packages
    {/if}
  {/snippet}
  {#if latest}
    <span class="latest">{latest.label ?? latest.packageName}</span>
  {/if}
</Tile>

<style>
  .latest {
    font-size: 0.8rem;
    color: var(--md-color-on-surface);
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
