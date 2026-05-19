<script lang="ts">
  import { CLIPBOARD_MAX_BYTES, clipboardText, type ClipboardInfo } from "../../../modules/clipboard";
  import CopyButton from "../CopyButton.svelte";
  import DetailRow from "../DetailRow.svelte";
  import Sheet from "../Sheet.svelte";

  let {
    info,
    error,
    deviceLabel,
    isSelf,
    onClose,
    onPublishText,
    onPasteOsAndPublish,
  }: {
    info: ClipboardInfo | null;
    error: string | null;
    deviceLabel: string;
    isSelf: boolean;
    onClose: () => void;
    /** Own-device only — publishes plain text. */
    onPublishText?: (text: string) => Promise<void>;
    /** Own-device only — reads OS clipboard and publishes. */
    onPasteOsAndPublish?: () => Promise<void>;
  } = $props();

  const text = $derived(info && info.type === "SIMPLE_TEXT" ? clipboardText(info) : "");

  let draft = $state("");
  let publishStatus = $state<"idle" | "publishing" | "done" | "error">("idle");
  let publishError = $state<string | null>(null);
  let osReadStatus = $state<string | null>(null);
  let bytesLen = $derived(new TextEncoder().encode(draft).byteLength);

  async function publish() {
    if (!onPublishText) return;
    publishStatus = "publishing";
    publishError = null;
    try {
      await onPublishText(draft);
      publishStatus = "done";
      draft = "";
    } catch (e) {
      publishStatus = "error";
      publishError = e instanceof Error ? e.message : String(e);
    }
  }

  async function pasteOs() {
    if (!onPasteOsAndPublish) return;
    osReadStatus = null;
    try {
      await onPasteOsAndPublish();
      osReadStatus = "Published from OS clipboard.";
    } catch (e) {
      osReadStatus = `Failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
</script>

<Sheet title="Clipboard" subtitle={deviceLabel} {onClose}>
  {#if error}
    <div class="error">Decode failed: {error}</div>
  {/if}

  <section class="current">
    <h3 class="h3">Current</h3>
    {#if !info || info.type === "EMPTY" || text.length === 0}
      <div class="empty">(empty)</div>
    {:else}
      <pre class="content">{text}</pre>
      <div class="row">
        <CopyButton value={text} label="Copy to OS clipboard" />
      </div>
    {/if}
    {#if info}
      <DetailRow label="Type" value={info.type} />
      <DetailRow label="Bytes" value={String(info.data.byteLength)} />
    {/if}
  </section>

  {#if isSelf}
    <section class="publish">
      <h3 class="h3">Publish from this device</h3>
      <p class="hint">Other devices in this account will see the new text on their next sync.</p>
      <textarea
        bind:value={draft}
        rows="4"
        placeholder="Type or paste text…"
        aria-label="Clipboard text to publish"
      ></textarea>
      <div class="meta">
        <span class:over={bytesLen > CLIPBOARD_MAX_BYTES}>{bytesLen} / {CLIPBOARD_MAX_BYTES} B</span>
      </div>
      <div class="row">
        <button
          type="button"
          onclick={publish}
          disabled={!onPublishText || publishStatus === "publishing" || draft.length === 0 || bytesLen > CLIPBOARD_MAX_BYTES}
        >
          {publishStatus === "publishing" ? "Publishing…" : "Publish"}
        </button>
        {#if onPasteOsAndPublish}
          <button type="button" class="secondary" onclick={pasteOs}>
            Paste from OS &amp; publish
          </button>
        {/if}
      </div>
      {#if publishStatus === "done"}
        <div class="ok">Published.</div>
      {/if}
      {#if publishStatus === "error" && publishError}
        <div class="error">{publishError}</div>
      {/if}
      {#if osReadStatus}
        <div class="hint">{osReadStatus}</div>
      {/if}
    </section>
  {/if}
</Sheet>

<style>
  .h3 {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--md-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: 16px 0 8px;
  }
  .h3:first-child {
    margin-top: 4px;
  }
  .content {
    background: var(--md-color-surface-container-low);
    color: var(--md-color-on-surface);
    padding: 10px;
    border-radius: 8px;
    max-height: 200px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.85rem;
    margin: 0 0 8px;
  }
  .empty {
    color: var(--md-color-on-surface-variant);
    font-size: 0.9rem;
    padding: 4px 0 8px;
  }
  .row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 8px;
  }
  .meta {
    text-align: right;
    font-size: 0.75rem;
    color: var(--md-color-on-surface-variant);
    margin-top: 4px;
  }
  .meta .over {
    color: var(--md-color-error);
  }
  .hint {
    font-size: 0.78rem;
    color: var(--md-color-on-surface-variant);
    margin: 4px 0 8px;
  }
  .ok {
    color: var(--md-color-primary);
    font-size: 0.85rem;
    margin-top: 6px;
  }
  .error {
    color: var(--md-color-error);
    font-size: 0.85rem;
    margin-top: 6px;
  }
  .secondary {
    background: transparent;
    border: 1px solid var(--md-color-outline-variant);
  }
</style>
