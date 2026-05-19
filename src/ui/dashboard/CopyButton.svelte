<script lang="ts">
  /**
   * Small "copy to OS clipboard" button. Tries `navigator.clipboard.writeText`
   * first, then falls back to the legacy `document.execCommand("copy")` trick
   * with a hidden textarea (works in insecure contexts where the modern API
   * throws). If both fail, the button flashes a "Failed" state for 1.5 s —
   * never silently reports success.
   *
   * Buttons can be sized as `compact` (icon-only square) or default
   * (icon + label). Default label is "Copy".
   */
  let {
    value,
    label = "Copy",
    compact = false,
    ariaLabel,
  }: {
    value: string;
    label?: string;
    compact?: boolean;
    ariaLabel?: string;
  } = $props();

  let status = $state<"idle" | "copied" | "failed">("idle");
  let resetTimer: ReturnType<typeof setTimeout> | null = null;

  function flash(next: "copied" | "failed") {
    status = next;
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      status = "idle";
      resetTimer = null;
    }, 1500);
  }

  async function copy() {
    if (await tryClipboardApi()) {
      flash("copied");
      return;
    }
    if (tryExecCommand()) {
      flash("copied");
      return;
    }
    flash("failed");
  }

  async function tryClipboardApi(): Promise<boolean> {
    if (!navigator.clipboard?.writeText) return false;
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      return false;
    }
  }

  function tryExecCommand(): boolean {
    if (typeof document === "undefined") return false;
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }
</script>

<button
  type="button"
  class="copy"
  class:compact
  class:copied={status === "copied"}
  class:failed={status === "failed"}
  aria-label={ariaLabel ?? label}
  onclick={copy}
>
  <span class="icon" aria-hidden="true">
    {#if status === "copied"}✓{:else if status === "failed"}!{:else}⧉{/if}
  </span>
  {#if !compact}
    <span class="label">
      {status === "copied" ? "Copied" : status === "failed" ? "Failed" : label}
    </span>
  {/if}
</button>

<style>
  .copy {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 18px;
    border: 1px solid var(--md-color-outline-variant);
    background: transparent;
    color: var(--md-color-on-surface-variant);
    font-size: 0.78rem;
    line-height: 1;
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
  }
  .copy:hover {
    background: color-mix(in srgb, var(--md-color-on-surface) 8%, transparent);
    color: var(--md-color-on-surface);
  }
  .copy.compact {
    padding: 0;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    justify-content: center;
  }
  .copy.copied {
    color: var(--md-color-primary);
    border-color: var(--md-color-primary);
  }
  .copy.failed {
    color: var(--md-color-error);
    border-color: var(--md-color-error);
  }
  .icon {
    font-size: 0.95rem;
    line-height: 1;
  }
</style>
