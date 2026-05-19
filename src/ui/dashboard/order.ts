/**
 * Sort utilities for the device-card grid. Kept as a pure helper so the
 * ordering rules can be pinned via vitest without setting up a Svelte
 * component test harness.
 */

interface Sortable {
  raw: { id: string };
}

/**
 * Move the device whose id matches `ownDeviceId` to position 0, leaving every
 * other device in its original relative order. Idempotent — calling twice on
 * an already-sorted list returns an array with the same element order.
 *
 * Used by the dashboard so the current browser is always pinned to the top-
 * left grid cell, no matter what order the server returns devices in.
 */
export function sortDevicesSelfFirst<T extends Sortable>(devices: T[], ownDeviceId: string): T[] {
  let selfIdx = -1;
  for (let i = 0; i < devices.length; i++) {
    if (devices[i].raw.id === ownDeviceId) {
      selfIdx = i;
      break;
    }
  }
  if (selfIdx <= 0) return devices.slice();
  const out = devices.slice();
  const [self] = out.splice(selfIdx, 1);
  out.unshift(self);
  return out;
}
