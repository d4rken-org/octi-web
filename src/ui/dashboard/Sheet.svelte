<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import type { Snippet } from "svelte";

  /**
   * Modal detail sheet. Bottom-anchored slide-up on viewports < 640px (matches
   * Android's ModalBottomSheet); centered modal on desktop.
   *
   * Dismissed by:
   * - Close button
   * - Backdrop click
   * - Escape key
   *
   * Captures the document's prior `body.overflow` value on mount and restores
   * it on destroy, regardless of dismissal path — defensive against component
   * unmount mid-sheet (sign-out, parent re-render, etc.).
   */
  let {
    title,
    subtitle,
    onClose,
    wide = false,
    children,
  }: {
    title: string;
    subtitle?: string;
    onClose: () => void;
    /** Lift the desktop max-width from 480 → 560 px. Settings / Add-device use this. */
    wide?: boolean;
    children?: Snippet;
  } = $props();

  import { lockBodyScroll, pushEscapeHandler } from "./modal-stack";

  let dialogEl = $state<HTMLDivElement | null>(null);
  let releaseBodyLock: (() => void) | null = null;
  let releaseEscape: (() => void) | null = null;

  function onBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  onMount(async () => {
    // Refcounted body lock + topmost-only Escape routing. See modal-stack.ts.
    // Pushing during mount registers us as the topmost responder; nested
    // sheets / dialogs that mount after us push on top and take over until
    // they unmount.
    releaseBodyLock = lockBodyScroll();
    releaseEscape = pushEscapeHandler(onClose);
    await tick();
    dialogEl?.focus();

    // Screenshot-CI marker: set once the sheet has settled. Under
    // prefers-reduced-motion the slide-in animation is disabled (see CSS), so
    // a single tick is enough. Otherwise, wait for the animationend.
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const markReady = () => {
      document.documentElement.setAttribute("data-screenshot-ready", "tile-detail");
    };
    if (reduceMotion) {
      markReady();
    } else {
      dialogEl?.addEventListener("animationend", markReady, { once: true });
      // Fallback in case animationend doesn't fire (e.g. animation disabled at the OS level).
      setTimeout(markReady, 600);
    }
  });

  onDestroy(() => {
    releaseBodyLock?.();
    releaseBodyLock = null;
    releaseEscape?.();
    releaseEscape = null;
    if (document.documentElement.getAttribute("data-screenshot-ready") === "tile-detail") {
      document.documentElement.setAttribute("data-screenshot-ready", "dashboard");
    }
  });
</script>

<div class="backdrop" role="presentation" onclick={onBackdrop}>
  <div
    bind:this={dialogEl}
    class="sheet"
    class:wide
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
  >
    <header class="sheet-header">
      <div class="sheet-title-wrap">
        <h2 class="sheet-title">{title}</h2>
        {#if subtitle}<div class="sheet-subtitle">{subtitle}</div>{/if}
      </div>
      <button class="sheet-close" type="button" aria-label="Close" onclick={onClose}>×</button>
    </header>
    <div class="sheet-body">
      {#if children}{@render children()}{/if}
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: flex-end;
    justify-content: center;
    z-index: 1000;
    animation: backdrop-in 160ms ease-out;
  }
  @keyframes backdrop-in {
    from {
      background: rgba(0, 0, 0, 0);
    }
    to {
      background: rgba(0, 0, 0, 0.55);
    }
  }

  .sheet {
    background: var(--md-color-surface-container);
    color: var(--md-color-on-surface);
    width: 100%;
    max-width: 480px;
    max-height: 92vh;
    border-radius: 16px 16px 0 0;
    display: flex;
    flex-direction: column;
    box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.35);
    animation: sheet-in 220ms cubic-bezier(0.2, 0.7, 0.2, 1);
    outline: none;
  }
  @keyframes sheet-in {
    from {
      transform: translateY(100%);
    }
    to {
      transform: translateY(0);
    }
  }

  @media (min-width: 640px) {
    .backdrop {
      align-items: center;
    }
    .sheet {
      border-radius: 16px;
      max-height: 80vh;
      animation: sheet-in-desktop 180ms ease-out;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
    }
    .sheet.wide {
      max-width: 560px;
    }
    @keyframes sheet-in-desktop {
      from {
        opacity: 0;
        transform: translateY(16px) scale(0.98);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }
  }

  .sheet-header {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 16px 16px 8px 20px;
  }
  .sheet-title-wrap {
    flex: 1;
    min-width: 0;
  }
  .sheet-title {
    font-size: 1.05rem;
    font-weight: 600;
    margin: 0;
    line-height: 1.3;
  }
  .sheet-subtitle {
    font-size: 0.8rem;
    color: var(--md-color-on-surface-variant);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sheet-close {
    background: transparent;
    border: none;
    color: var(--md-color-on-surface-variant);
    font-size: 1.6rem;
    line-height: 1;
    cursor: pointer;
    padding: 0 8px;
    border-radius: 6px;
  }
  .sheet-close:hover {
    background: color-mix(in srgb, var(--md-color-on-surface) 8%, transparent);
    color: var(--md-color-on-surface);
  }

  .sheet-body {
    padding: 8px 20px 20px;
    overflow-y: auto;
    flex: 1;
  }

  /*
   * Honor the user's OS-level motion preference: disable the entrance
   * animations entirely so the sheet appears in its final position. Also
   * makes the screenshot-CI capture deterministic — no partial-animation
   * frames sneaking into the screenshot.
   */
  @media (prefers-reduced-motion: reduce) {
    .backdrop,
    .sheet {
      animation: none !important;
    }
  }
</style>
