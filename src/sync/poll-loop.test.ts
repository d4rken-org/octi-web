// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPollLoop } from "./poll-loop";

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => state !== "visible",
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("startPollLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the refresh immediately on start", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const stop = startPollLoop(refresh, { intervalMs: 1000 });
    // Drain the initial runOnce microtask + its .then(schedule).
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });

  it("re-fires at the configured interval while visible", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const stop = startPollLoop(refresh, { intervalMs: 1000, refreshOnStart: false });
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it("skips ticks while document is hidden", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    setVisibility("hidden");
    const stop = startPollLoop(refresh, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).not.toHaveBeenCalled();
    stop();
  });

  it("fires an immediate refresh when visibility flips back to visible", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    setVisibility("hidden");
    const stop = startPollLoop(refresh, { intervalMs: 10_000, refreshOnStart: false });
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });

  it("survives an error thrown by the refresh callback", async () => {
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = startPollLoop(refresh, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(consoleWarn).toHaveBeenCalled();
    stop();
  });

  it("dedups overlapping ticks via the inFlight guard", async () => {
    let resolveFirst!: () => void;
    const inFlight = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const refresh = vi
      .fn()
      .mockImplementationOnce(() => inFlight)
      .mockResolvedValue(undefined);
    const stop = startPollLoop(refresh, { intervalMs: 100 });
    // First tick is hanging; advance past several intervals.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    // We started one refresh and additional schedule attempts skipped because
    // the first never resolved. Visibility focus events also dedup via inFlight.
    expect(refresh).toHaveBeenCalledTimes(1);
    resolveFirst();
    await vi.advanceTimersByTimeAsync(0);
    stop();
  });

  it("stop() cancels pending timers and unbinds listeners", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const stop = startPollLoop(refresh, { intervalMs: 500, refreshOnStart: false });
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
