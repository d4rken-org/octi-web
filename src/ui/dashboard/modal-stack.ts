/**
 * Shared modal stack for {@link Sheet} and {@link DisconnectConfirmDialog}.
 *
 * Two coordinated concerns:
 *
 *   1. **Escape routing.** Before this module, every Sheet attached its own
 *      `<svelte:window onkeydown>` listener and called `onClose()` on
 *      Escape. With nested modals (Settings → Sync Sources → confirm
 *      dialog), one Escape press fired every listener and collapsed the
 *      entire stack — `stopPropagation()` on a window-level event doesn't
 *      help because all window-level listeners run regardless. Now exactly
 *      one global listener routes Escape to the topmost modal only.
 *
 *   2. **Body scroll lock.** Each modal previously captured
 *      `document.body.style.overflow` on mount and restored it on destroy.
 *      With overlapping mount/unmount orderings (Issues → Sync Sources
 *      transitions through both states in the same tick), the wrong layer
 *      could restore the body to "auto" while another modal stayed open.
 *      Reference-counted lock: first mount captures + locks, last unmount
 *      restores. Arbitrary mount/unmount interleaving stays correct.
 */

type EscapeHandler = () => void;

const escapeStack: EscapeHandler[] = [];

let lockCount = 0;
let savedBodyOverflow: string | null = null;

let listenerAttached = false;

function onWindowKeydown(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  const top = escapeStack[escapeStack.length - 1];
  if (top) top();
}

function ensureWindowListener(): void {
  if (listenerAttached) return;
  if (typeof window === "undefined") return; // SSR / Node tests guard
  window.addEventListener("keydown", onWindowKeydown);
  listenerAttached = true;
}

/**
 * Register `handler` as the topmost Escape responder. Returns a cleanup
 * function that removes this entry from the stack — call it on component
 * destroy. Subsequent Escape presses while this is the top of the stack
 * invoke `handler` exclusively.
 */
export function pushEscapeHandler(handler: EscapeHandler): () => void {
  ensureWindowListener();
  escapeStack.push(handler);
  return () => {
    const i = escapeStack.lastIndexOf(handler);
    if (i >= 0) escapeStack.splice(i, 1);
  };
}

/**
 * Acquire a body-scroll lock. The first caller captures the current
 * `body.style.overflow` and sets it to `"hidden"`. Subsequent callers
 * increment a refcount only. Returns a release function — when the refcount
 * drops to zero, the original overflow is restored. Safe to call across
 * arbitrarily-ordered mount/unmount lifecycles.
 */
export function lockBodyScroll(): () => void {
  if (typeof document === "undefined") return () => undefined; // SSR / Node guard
  if (lockCount === 0) {
    savedBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  lockCount++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockCount--;
    if (lockCount === 0 && savedBodyOverflow !== null) {
      document.body.style.overflow = savedBodyOverflow;
      savedBodyOverflow = null;
    }
  };
}
