/**
 * Foreground polling helper. Runs `refresh` every `intervalMs` while the page
 * is visible; pauses when hidden; runs an extra refresh on `visibilitychange`
 * to visible and on `focus` so a returning user always sees fresh state.
 *
 * Re-entrancy: skips overlapping ticks if a previous `refresh()` is still
 * pending. Errors from `refresh()` are swallowed (logged) so a single failed
 * cycle doesn't stop the loop — the caller is expected to surface them
 * separately.
 *
 * Returns a cleanup function; call it on component destroy.
 */
export interface PollLoopOptions {
  /** Default 30 s — long enough to be polite to the server, short enough to feel live. */
  intervalMs?: number;
  /** Run an immediate refresh on start. Default true. */
  refreshOnStart?: boolean;
}

export function startPollLoop(
  refresh: () => Promise<void>,
  opts: PollLoopOptions = {},
): () => void {
  const intervalMs = opts.intervalMs ?? 30_000;
  const refreshOnStart = opts.refreshOnStart ?? true;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let stopped = false;

  async function runOnce() {
    if (stopped || inFlight) return;
    if (document.visibilityState !== "visible") return;
    inFlight = true;
    try {
      await refresh();
    } catch (e) {
      // The caller renders its own error UI; just log so this doesn't go
      // entirely silent in devtools.
      console.warn("poll-loop: refresh failed", e);
    } finally {
      inFlight = false;
    }
  }

  function schedule() {
    if (stopped) return;
    if (timer != null) clearTimeout(timer);
    if (document.visibilityState !== "visible") return;
    timer = setTimeout(async () => {
      await runOnce();
      schedule();
    }, intervalMs);
  }

  function onVisibility() {
    if (document.visibilityState === "visible") {
      // Catch up immediately, then resume cadence.
      void runOnce().then(schedule);
    } else if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function onFocus() {
    // Some browsers don't fire visibilitychange on window-level focus alone;
    // listen for both. runOnce dedups via inFlight.
    void runOnce();
  }

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onFocus);

  if (refreshOnStart) {
    void runOnce().then(schedule);
  } else {
    schedule();
  }

  return () => {
    stopped = true;
    if (timer != null) clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", onFocus);
  };
}
