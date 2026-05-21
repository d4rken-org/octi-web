import type { DeviceMetadata } from "../protocol/models";

export interface DeviceLinkMonitorOptions {
  /** Connector-scoped device listing. */
  listDevices: () => Promise<readonly DeviceMetadata[]>;
  /**
   * Device IDs known before the share code was minted. If omitted, the first
   * successful poll establishes the baseline instead.
   */
  baselineIds?: Iterable<string> | null;
  /** Default cadence matches Android's link-host screen. */
  intervalMs?: number;
  onLinked: (device: DeviceMetadata) => void;
  onError?: (error: unknown) => void;
}

/**
 * Watch an account's device list for a newly linked peer.
 *
 * Android closes its link-host screen when the connector's device metadata
 * grows. Web polls the same server device list directly while the share sheet
 * is open, which avoids waiting for the dashboard's slower background refresh.
 */
export function startDeviceLinkMonitor(opts: DeviceLinkMonitorOptions): () => void {
  const intervalMs = opts.intervalMs ?? 3_000;
  let baseline = opts.baselineIds ? new Set(opts.baselineIds) : null;
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer() {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule() {
    if (stopped) return;
    clearTimer();
    timer = setTimeout(runOnce, intervalMs);
  }

  async function runOnce() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const devices = await opts.listDevices();
      if (stopped) return;

      const knownIds = baseline;
      if (!knownIds) {
        baseline = new Set(devices.map((d) => d.id));
        return;
      }

      const linked = devices.find((d) => !knownIds.has(d.id));
      if (!linked) return;

      stopped = true;
      clearTimer();
      opts.onLinked(linked);
    } catch (e) {
      opts.onError?.(e);
    } finally {
      inFlight = false;
      if (!stopped) schedule();
    }
  }

  schedule();

  return () => {
    stopped = true;
    clearTimer();
  };
}
