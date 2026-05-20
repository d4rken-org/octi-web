<script lang="ts" module>
  /**
   * A single entry in an OverflowMenu.
   *
   * `separatorBefore` draws a thin divider above the item — useful to set
   * destructive items (Sign-out) apart from the action items above. The
   * separator is suppressed if the item is the first one rendered.
   */
  export interface MenuItem {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    destructive?: boolean;
    separatorBefore?: boolean;
    /** Optional stable selector for screenshot CI. */
    testId?: string;
  }
</script>

<script lang="ts">
  import { onDestroy } from "svelte";
  import Icon from "./Icon.svelte";

  /**
   * Generic three-dot overflow menu. Caller supplies the items list — keeps
   * the menu reusable across the per-device card overflow and the page nav
   * overflow without specialising either.
   */
  let {
    items,
    ariaLabel = "More options",
  }: {
    items: MenuItem[];
    ariaLabel?: string;
  } = $props();

  let open = $state(false);
  let containerEl = $state<HTMLDivElement | null>(null);

  function toggle() {
    open = !open;
  }

  function close() {
    open = false;
  }

  function onDocumentClick(e: MouseEvent) {
    if (!open) return;
    if (containerEl && e.target instanceof Node && !containerEl.contains(e.target)) {
      close();
    }
  }

  function onKey(e: KeyboardEvent) {
    if (open && e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  }

  $effect(() => {
    if (open) {
      document.addEventListener("click", onDocumentClick);
      document.addEventListener("keydown", onKey);
    } else {
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onKey);
    }
  });

  onDestroy(() => {
    document.removeEventListener("click", onDocumentClick);
    document.removeEventListener("keydown", onKey);
  });

  function handle(item: MenuItem) {
    if (item.disabled) return;
    close();
    item.onClick();
  }
</script>

<div bind:this={containerEl} class="container">
  <button
    type="button"
    class="trigger"
    aria-label={ariaLabel}
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={toggle}
    data-testid="overflow-menu"
  >
    <Icon name="more" size={18} />
  </button>
  {#if open}
    <div class="menu" role="menu">
      {#each items as item, i (i)}
        {#if item.separatorBefore && i > 0}
          <hr class="separator" />
        {/if}
        <button
          type="button"
          class="menu-item"
          class:destructive={item.destructive}
          role="menuitem"
          disabled={item.disabled}
          data-testid={item.testId}
          onclick={() => handle(item)}
        >{item.label}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .container {
    position: relative;
    display: inline-flex;
  }
  .trigger {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: none;
    background: transparent;
    color: var(--md-color-on-surface-variant);
    cursor: pointer;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .trigger:hover {
    background: color-mix(in srgb, var(--md-color-on-surface) 8%, transparent);
    color: var(--md-color-on-surface);
  }
  .menu {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    background: var(--md-color-surface-container-high);
    border: 1px solid var(--md-color-outline-variant);
    border-radius: 8px;
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.3);
    min-width: 200px;
    /* NavBar uses z-index: 100; the menu must stack above the nav AND above per-card menus (z: 50). */
    z-index: 110;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .menu-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 10px 14px;
    background: transparent;
    border: none;
    color: var(--md-color-on-surface);
    font-size: 0.9rem;
    cursor: pointer;
  }
  .menu-item:hover:not(:disabled) {
    background: color-mix(in srgb, var(--md-color-on-surface) 8%, transparent);
  }
  .menu-item:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .menu-item.destructive {
    color: var(--md-color-error);
  }
  .menu-item.destructive:hover:not(:disabled) {
    background: color-mix(in srgb, var(--md-color-error) 12%, transparent);
  }
  .separator {
    border: none;
    border-top: 1px solid var(--md-color-outline-variant);
    margin: 4px 0;
  }
</style>
