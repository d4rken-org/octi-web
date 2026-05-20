<script lang="ts">
  import type { ConnectorRefreshState } from "../../sync/connector-manager.svelte";
  import type { OctiServerConnector } from "../../protocol/octi-server-connector";
  import Sheet from "./Sheet.svelte";

  /**
   * Raw per-connector device list — the unmerged view. The main dashboard
   * shows merged cards (one per `deviceId` across all connectors); this
   * sheet drills into a single connector and shows exactly what that
   * server reports.
   *
   * Mirrors Android's "View devices" entry on the connector card. Used to
   * diagnose mismatches between connectors (e.g. one server is missing a
   * device that the other has), or to identify the row to remove
   * server-side via another Octi app (octi-web v1 doesn't issue remove-
   * device requests itself; that's a punt called out in the plan).
   */
  let {
    connector,
    state,
    ownDeviceId,
    onClose,
  }: {
    connector: OctiServerConnector;
    state: ConnectorRefreshState | undefined;
    /** Used to mark the row that corresponds to this browser. */
    ownDeviceId: string;
    onClose: () => void;
  } = $props();

  // Sort: self first, then by lastSeen desc (most recently active up top).
  const devices = $derived.by(() => {
    if (!state) return [];
    return [...state.devices.values()].sort((a, b) => {
      const aSelf = a.raw.id === ownDeviceId ? 1 : 0;
      const bSelf = b.raw.id === ownDeviceId ? 1 : 0;
      if (aSelf !== bSelf) return bSelf - aSelf;
      const aLast = a.raw.lastSeen ? Date.parse(a.raw.lastSeen) : 0;
      const bLast = b.raw.lastSeen ? Date.parse(b.raw.lastSeen) : 0;
      return bLast - aLast;
    });
  });

  function fmtLastSeen(iso: string | null): string {
    if (!iso) return "never";
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return "—";
    const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (secs < 60) return `${secs} s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
    return `${Math.floor(secs / 86400)} d ago`;
  }
</script>

<Sheet
  title="Devices on this sync source"
  subtitle={connector.record.serverAddress.domain}
  wide
  {onClose}
>
  {#if !state}
    <p class="empty">No data yet — this connector hasn't completed a refresh.</p>
  {:else if devices.length === 0}
    <p class="empty">No devices reported by this server.</p>
  {:else}
    <ul class="list">
      {#each devices as d (d.raw.id)}
        {@const isSelf = d.raw.id === ownDeviceId}
        <li class="row" class:self={isSelf} data-testid="connector-device-row">
          <div class="row-main">
            <div class="row-title">
              {d.raw.label || "(no label)"}
              {#if isSelf}<span class="self-tag">this browser</span>{/if}
            </div>
            <div class="row-meta">
              <span class="platform">{d.raw.platform ?? "unknown"}</span>
              <span class="dot">·</span>
              <span class="last-seen">last seen {fmtLastSeen(d.raw.lastSeen)}</span>
              {#if d.raw.version}
                <span class="dot">·</span>
                <span class="version">{d.raw.version}</span>
              {/if}
            </div>
          </div>
          <code class="device-id" title={d.raw.id}>{d.raw.id.slice(0, 8)}…</code>
        </li>
      {/each}
    </ul>
    <p class="hint">
      To remove a device from this account, use another Octi device that's
      paired with this sync source. octi-web doesn't issue device-removal
      requests yet.
    </p>
  {/if}
</Sheet>

<style>
  .empty {
    text-align: center;
    color: var(--md-color-on-surface-variant);
    padding: 20px 0;
    font-size: 0.88rem;
  }
  .list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid var(--md-color-outline-variant);
    margin-bottom: 6px;
  }
  .row.self {
    border-color: color-mix(in srgb, var(--md-color-primary) 45%, transparent);
    background: color-mix(in srgb, var(--md-color-primary) 6%, transparent);
  }
  .row-main {
    flex: 1;
    min-width: 0;
  }
  .row-title {
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--md-color-on-surface);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .self-tag {
    font-size: 0.7rem;
    font-weight: 400;
    color: var(--md-color-primary);
    margin-left: 6px;
    padding: 1px 6px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--md-color-primary) 14%, transparent);
  }
  .row-meta {
    font-size: 0.76rem;
    color: var(--md-color-on-surface-variant);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot { margin: 0 4px; opacity: 0.6; }
  .device-id {
    font-family: "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.72rem;
    color: var(--md-color-on-surface-variant);
    flex-shrink: 0;
  }
  .hint {
    margin-top: 16px;
    font-size: 0.78rem;
    color: var(--md-color-on-surface-variant);
    line-height: 1.4;
  }
</style>
