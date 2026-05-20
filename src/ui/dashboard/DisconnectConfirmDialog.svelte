<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { lockBodyScroll, pushEscapeHandler } from "./modal-stack";

  /**
   * Small confirmation dialog for destructive single-connector disconnects.
   * Mirrors Android's `AlertDialog` with the red "Disconnect" + a cancel
   * action: the user can't tap through accidentally because the primary
   * action requires an explicit click, and Escape / backdrop / cancel all
   * route back to {@link onCancel}.
   *
   * Why not reuse {@link Sheet}: this is a top-of-everything modal that
   * blocks interaction with whatever opened it (typically the
   * {@link SyncSourcesScreen} sheet underneath). Layering a Sheet on top of
   * a Sheet works visually but the body scroll-lock dance gets confusing;
   * a flat centered modal is the cleaner UI primitive for "are you sure?".
   */
  let {
    title,
    body,
    confirmLabel = "Disconnect",
    cancelLabel = "Cancel",
    busy = false,
    onConfirm,
    onCancel,
  }: {
    title: string;
    body: string;
    confirmLabel?: string;
    cancelLabel?: string;
    /** When true, both buttons are disabled while the action is in flight. */
    busy?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  } = $props();

  let dialogEl = $state<HTMLDivElement | null>(null);
  let releaseBodyLock: (() => void) | null = null;
  let releaseEscape: (() => void) | null = null;

  function onBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget && !busy) onCancel();
  }

  function onEscape() {
    // Suppress Escape entirely while the action is in flight — the user
    // shouldn't be able to abandon a half-completed disconnect by tapping
    // through the modal stack. Doing nothing keeps the dialog as the topmost
    // Escape responder; sheets underneath stay open until we resolve.
    if (busy) return;
    onCancel();
  }

  onMount(async () => {
    releaseBodyLock = lockBodyScroll();
    releaseEscape = pushEscapeHandler(onEscape);
    await tick();
    dialogEl?.focus();
  });

  onDestroy(() => {
    releaseBodyLock?.();
    releaseBodyLock = null;
    releaseEscape?.();
    releaseEscape = null;
  });
</script>

<div class="backdrop" role="presentation" onclick={onBackdrop}>
  <div
    bind:this={dialogEl}
    class="dialog"
    role="alertdialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
  >
    <h2 class="title">{title}</h2>
    <p class="body">{body}</p>
    <div class="actions">
      <button type="button" class="cancel" onclick={onCancel} disabled={busy}>{cancelLabel}</button>
      <button
        type="button"
        class="confirm"
        onclick={onConfirm}
        disabled={busy}
        data-testid="disconnect-confirm"
      >
        {busy ? "…" : confirmLabel}
      </button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1100; /* Above Sheet (z: 1000) — confirm sits on top of the sources sheet. */
    animation: backdrop-in 120ms ease-out;
  }
  @keyframes backdrop-in {
    from { background: rgba(0, 0, 0, 0); }
    to { background: rgba(0, 0, 0, 0.55); }
  }
  .dialog {
    background: var(--md-color-surface-container-high);
    color: var(--md-color-on-surface);
    width: calc(100% - 32px);
    max-width: 380px;
    border-radius: 14px;
    padding: 20px;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
    outline: none;
  }
  .title {
    font-size: 1.05rem;
    font-weight: 600;
    margin: 0 0 8px;
    color: var(--md-color-on-surface);
  }
  .body {
    font-size: 0.88rem;
    line-height: 1.4;
    color: var(--md-color-on-surface-variant);
    margin: 0 0 18px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .cancel,
  .confirm {
    padding: 8px 14px;
    border-radius: 18px;
    font-size: 0.85rem;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .cancel {
    background: transparent;
    color: var(--md-color-on-surface);
    border-color: var(--md-color-outline-variant);
  }
  .cancel:hover:not(:disabled) {
    background: color-mix(in srgb, var(--md-color-on-surface) 8%, transparent);
  }
  .confirm {
    background: var(--md-color-error);
    color: var(--md-color-on-error, white);
  }
  .confirm:hover:not(:disabled) {
    filter: brightness(1.05);
  }
  .cancel:disabled,
  .confirm:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  @media (prefers-reduced-motion: reduce) {
    .backdrop { animation: none !important; }
  }
</style>
