<script lang="ts">
  import { clipboardText, type ClipboardInfo } from "../modules/clipboard";

  let {
    deviceLabel,
    info,
    fetchError,
  }: {
    deviceLabel: string;
    info: ClipboardInfo | null;
    fetchError: string | null;
  } = $props();

  let copied = $state(false);
  let copyError = $state<string | null>(null);

  const text = $derived(info ? clipboardText(info) : "");
  const isEmpty = $derived(!info || info.type === "EMPTY" || text.length === 0);

  async function copyToOwnClipboard() {
    copied = false;
    copyError = null;
    try {
      // navigator.clipboard requires a user gesture + secure context.
      // localhost qualifies; production must be served over HTTPS.
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch (e) {
      copyError = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<article
  style="padding: 0.75rem; border: 1px solid rgba(255,255,255,0.12); border-radius: 6px;"
>
  <div style="display: flex; gap: 0.5rem; align-items: baseline; justify-content: space-between;">
    <strong>{deviceLabel}</strong>
    {#if !isEmpty}
      <button onclick={copyToOwnClipboard}>{copied ? "Copied" : "Copy"}</button>
    {/if}
  </div>

  {#if fetchError}
    <p style="margin: 0.4rem 0 0; color: #ff8a8a; font-size: 0.85rem;">
      Couldn't read clipboard: {fetchError}
    </p>
  {:else if isEmpty}
    <p style="margin: 0.4rem 0 0; opacity: 0.6; font-style: italic;">No clipboard set.</p>
  {:else}
    <pre
      style="margin: 0.4rem 0 0; white-space: pre-wrap; word-break: break-word; max-height: 12rem; overflow-y: auto;"
    >{text}</pre>
  {/if}

  {#if copyError}
    <p style="margin: 0.4rem 0 0; color: #ff8a8a; font-size: 0.8rem;">
      Copy failed: {copyError}
    </p>
  {/if}
</article>
