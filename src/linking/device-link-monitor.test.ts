import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceMetadata } from "../protocol/models";
import { startDeviceLinkMonitor } from "./device-link-monitor";

function device(id: string): DeviceMetadata {
  return {
    id,
    version: null,
    platform: null,
    label: null,
    addedAt: null,
    lastSeen: null,
  };
}

describe("startDeviceLinkMonitor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits once when a device outside the baseline appears", async () => {
    vi.useFakeTimers();
    const listDevices = vi
      .fn<() => Promise<DeviceMetadata[]>>()
      .mockResolvedValueOnce([device("own")])
      .mockResolvedValueOnce([device("own"), device("peer")]);
    const onLinked = vi.fn();

    const stop = startDeviceLinkMonitor({
      baselineIds: ["own"],
      intervalMs: 100,
      listDevices,
      onLinked,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(onLinked).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(onLinked).toHaveBeenCalledTimes(1);
    expect(onLinked).toHaveBeenCalledWith(expect.objectContaining({ id: "peer" }));

    await vi.advanceTimersByTimeAsync(500);
    expect(listDevices).toHaveBeenCalledTimes(2);
    stop();
  });

  it("uses the first successful poll as baseline when no baseline is supplied", async () => {
    vi.useFakeTimers();
    const listDevices = vi
      .fn<() => Promise<DeviceMetadata[]>>()
      .mockResolvedValueOnce([device("own"), device("existing")])
      .mockResolvedValueOnce([device("own"), device("existing"), device("peer")]);
    const onLinked = vi.fn();

    const stop = startDeviceLinkMonitor({
      baselineIds: null,
      intervalMs: 100,
      listDevices,
      onLinked,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(onLinked).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(onLinked).toHaveBeenCalledTimes(1);
    expect(onLinked).toHaveBeenCalledWith(expect.objectContaining({ id: "peer" }));
    stop();
  });

  it("keeps polling after a transient list failure", async () => {
    vi.useFakeTimers();
    const error = new Error("temporary");
    const listDevices = vi
      .fn<() => Promise<DeviceMetadata[]>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce([device("own"), device("peer")]);
    const onLinked = vi.fn();
    const onError = vi.fn();

    const stop = startDeviceLinkMonitor({
      baselineIds: ["own"],
      intervalMs: 100,
      listDevices,
      onLinked,
      onError,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(onError).toHaveBeenCalledWith(error);
    expect(onLinked).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(onLinked).toHaveBeenCalledTimes(1);
    stop();
  });
});
