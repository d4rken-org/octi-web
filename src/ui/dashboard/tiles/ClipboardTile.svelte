<script lang="ts">
  import { clipboardText, type ClipboardInfo } from "../../../modules/clipboard";
  import CopyButton from "../CopyButton.svelte";
  import Icon from "../Icon.svelte";
  import Tile from "../Tile.svelte";

  let {
    info,
    error,
    isSelf,
    wide = false,
    onOpen,
    onPasteOsAndPublish,
  }: {
    info: ClipboardInfo | null;
    error: string | null;
    isSelf: boolean;
    wide?: boolean;
    onOpen: () => void;
    onPasteOsAndPublish?: () => void;
  } = $props();

  const state = $derived<"ok" | "empty" | "error">(error ? "error" : info ? "ok" : "empty");
  const text = $derived(info && info.type === "SIMPLE_TEXT" ? clipboardText(info) : "");
  const isEmpty = $derived(info != null && info.type === "EMPTY");
</script>

<Tile title="Clipboard" {state} {wide} {onOpen}>
  {#snippet icon()}
    <Icon name="clipboard" />
  {/snippet}
  {#snippet actions()}
    {#if isSelf && onPasteOsAndPublish}
      <button
        type="button"
        class="qa"
        title="Paste from OS and publish"
        aria-label="Paste from OS and publish"
        onclick={onPasteOsAndPublish}
      >
        <Icon name="paste" size={16} />
      </button>
    {/if}
    {#if text.length > 0}
      <CopyButton value={text} compact ariaLabel="Copy clipboard to OS" />
    {/if}
  {/snippet}
  {#snippet statusLine()}
    {#if error}
      Decode failed
    {:else if !info}
      Not published yet
    {:else if isEmpty}
      (empty)
    {:else if text.length === 0}
      (empty)
    {:else}
      "{text.length > 80 ? text.slice(0, 80) + "…" : text}"
    {/if}
  {/snippet}
</Tile>

<style>
  .qa {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: none;
    background: transparent;
    color: var(--md-color-on-surface-variant);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }
  .qa:hover {
    background: color-mix(in srgb, var(--md-color-on-surface) 8%, transparent);
    color: var(--md-color-on-surface);
  }
</style>
