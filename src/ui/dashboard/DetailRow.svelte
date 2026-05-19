<script lang="ts">
  import CopyButton from "./CopyButton.svelte";

  /**
   * A label + value row inside a detail sheet. Renders an optional copy
   * button (default on) when `copyValue` is supplied. The displayed value
   * may differ from the copied value (e.g. show "75%" but copy "75").
   */
  let {
    label,
    value,
    copyValue,
    mono = false,
  }: {
    label: string;
    value: string | null | undefined;
    copyValue?: string | null;
    mono?: boolean;
  } = $props();

  const display = value ?? "—";
  const canCopy = (copyValue ?? value ?? "").length > 0 && (value ?? "").length > 0;
</script>

<div class="row">
  <div class="label">{label}</div>
  <div class="value" class:mono>{display}</div>
  {#if canCopy}
    <CopyButton value={copyValue ?? value ?? ""} compact ariaLabel={`Copy ${label}`} />
  {/if}
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--md-color-outline-variant);
  }
  .row:last-child {
    border-bottom: none;
  }
  .label {
    font-size: 0.78rem;
    color: var(--md-color-on-surface-variant);
    flex: 0 0 38%;
    min-width: 0;
  }
  .value {
    flex: 1;
    color: var(--md-color-on-surface);
    word-break: break-word;
    font-size: 0.92rem;
  }
  .value.mono {
    font-family: "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.85rem;
  }
</style>
