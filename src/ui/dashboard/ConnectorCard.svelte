<script lang="ts">
  import type { ConnectorRefreshState } from "../../sync/connector-manager.svelte";
  import type { OctiServerConnector } from "../../protocol/octi-server-connector";
  import Icon from "./Icon.svelte";

  /**
   * One row in the Sync Sources list. Shows the connector's identity (server
   * domain + this-browser's label on that account), the most recent refresh
   * outcome, and a peer count. Tapping the row opens an actions menu in the
   * parent (Sheet body has limited room for inline action buttons on mobile);
   * the parent decides what to do — wiring an OverflowMenu directly inside
   * the row stacks badly with Sheet's scroll container.
   *
   * Mirrors Android's `ConnectorCard` (sync-core/ui/list).
   */
  let {
    connector,
    state,
    onRefresh,
    onShare,
    onViewDevices,
    onDisconnect,
  }: {
    connector: OctiServerConnector;
    /** May be undefined if the manager hasn't seeded state yet (shouldn't happen post-bootstrap). */
    state: ConnectorRefreshState | undefined;
    onRefresh: () => void;
    onShare: () => void;
    onViewDevices: () => void;
    onDisconnect: () => void;
  } = $props();

  const record = $derived(connector.record);
  const deviceCount = $derived(state?.devices.size ?? 0);
  const lastError = $derived(state?.lastError ?? null);
  const lastRefreshedAt = $derived(state?.lastRefreshedAt ?? null);

  // Coarse "x min ago" for the status row. Doesn't need second-level
  // precision because this card is rendered inside a Sheet that's only
  // visible while the user is reading it — sub-minute drift is invisible.
  function timeAgo(d: Date | null): string {
    if (!d) return "never";
    const secs = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (secs < 5) return "just now";
    if (secs < 60) return `${secs} s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
    return `${Math.floor(secs / 86400)} d ago`;
  }
</script>

<article class="card" data-testid="connector-card" data-connector-id={connector.connectorId}>
  <header class="card-header">
    <div class="ident">
      <Icon name="settings" size={20} />
      <div class="ident-text">
        <div class="title">{record.deviceLabel || "Browser"}</div>
        <div class="subtitle">{record.serverAddress.domain}</div>
      </div>
    </div>
    <div class="badge" class:err={lastError !== null}>
      {deviceCount} device{deviceCount === 1 ? "" : "s"}
    </div>
  </header>

  <div class="status">
    {#if lastError}
      <span class="status-err" title={lastError}>Last sync failed: {lastError}</span>
    {:else}
      <span class="status-ok">Last sync: {timeAgo(lastRefreshedAt)}</span>
    {/if}
  </div>

  <div class="actions">
    <!--
      "Refresh all" because today the ConnectorManager only exposes a
      global `refreshAll()` — there's no per-connector refresh yet. Naming
      it "Refresh" on a per-row button would be misleading. Per-connector
      refresh is a follow-up (manager.refreshOne(connectorId)).
    -->
    <button type="button" class="action" onclick={onRefresh}>Refresh all</button>
    <button
      type="button"
      class="action"
      onclick={onShare}
      data-testid="connector-share"
    >
      Share
    </button>
    <button type="button" class="action" onclick={onViewDevices}>View devices</button>
    <button
      type="button"
      class="action destructive"
      onclick={onDisconnect}
      data-testid="connector-disconnect"
    >
      Disconnect
    </button>
  </div>
</article>

<style>
  .card {
    background: var(--md-color-surface-container-low);
    border: 1px solid var(--md-color-outline-variant);
    border-radius: 12px;
    padding: 12px 14px;
    margin-bottom: 12px;
  }
  .card:last-child { margin-bottom: 0; }
  .card-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }
  .ident {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .ident-text { min-width: 0; }
  .title {
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--md-color-on-surface);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .subtitle {
    font-size: 0.76rem;
    color: var(--md-color-on-surface-variant);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    font-size: 0.72rem;
    color: var(--md-color-on-surface-variant);
    background: color-mix(in srgb, var(--md-color-on-surface) 8%, transparent);
    padding: 3px 8px;
    border-radius: 999px;
    white-space: nowrap;
  }
  .badge.err {
    color: var(--md-color-error);
    background: color-mix(in srgb, var(--md-color-error) 14%, transparent);
  }
  .status {
    font-size: 0.78rem;
    margin-bottom: 10px;
  }
  .status-ok { color: var(--md-color-on-surface-variant); }
  .status-err {
    color: var(--md-color-error);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: inline-block;
    max-width: 100%;
  }
  .actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .action {
    padding: 6px 12px;
    border-radius: 16px;
    border: 1px solid var(--md-color-outline-variant);
    background: transparent;
    color: var(--md-color-on-surface);
    font-size: 0.82rem;
    cursor: pointer;
  }
  .action:hover {
    background: color-mix(in srgb, var(--md-color-on-surface) 8%, transparent);
  }
  .action.destructive {
    color: var(--md-color-error);
    border-color: color-mix(in srgb, var(--md-color-error) 50%, transparent);
  }
  .action.destructive:hover {
    background: color-mix(in srgb, var(--md-color-error) 12%, transparent);
  }
</style>
