<script lang="ts">
  import type { ConnectorManager, Issue } from "../../sync/connector-manager.svelte";
  import Sheet from "./Sheet.svelte";

  /**
   * Cross-connector issues panel — mirrors Android's `IssuesSummarySheet`.
   * Shows one entry per connector that has a non-null `lastError`. Tapping
   * an entry navigates to the Sync Sources screen via `onOpenSources` so
   * the user can investigate or disconnect.
   *
   * v1 only sources from `manager.mergedIssues` (per-connector
   * `lastError`). Future expansions (Android's clock-skew analyzer, blob-
   * rejection tracker, low-storage warning) plug into the same panel.
   */
  let {
    manager,
    onOpenSources,
    onClose,
  }: {
    manager: ConnectorManager;
    onOpenSources: (connectorId: string) => void;
    onClose: () => void;
  } = $props();

  const issues = $derived(manager.mergedIssues);

  function connectorLabel(issue: Issue): string {
    const c = manager.connectors.find((c) => c.connectorId === issue.connectorId);
    return c?.record.serverAddress.domain ?? issue.connectorId;
  }
</script>

<Sheet title="Issues" subtitle="{issues.length} active" {onClose}>
  {#if issues.length === 0}
    <p class="empty">All sync sources are healthy.</p>
  {:else}
    <ul class="list">
      {#each issues as issue (issue.connectorId)}
        <li class="row">
          <button
            type="button"
            class="row-btn"
            onclick={() => {
              onClose();
              onOpenSources(issue.connectorId);
            }}
          >
            <div class="row-main">
              <div class="row-title">{connectorLabel(issue)}</div>
              <div class="row-msg">{issue.message}</div>
            </div>
            <span class="row-arrow" aria-hidden="true">›</span>
          </button>
        </li>
      {/each}
    </ul>
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
  .row { margin-bottom: 8px; }
  .row:last-child { margin-bottom: 0; }
  .row-btn {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    text-align: left;
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, var(--md-color-error) 40%, transparent);
    background: color-mix(in srgb, var(--md-color-error) 8%, transparent);
    color: var(--md-color-on-surface);
    cursor: pointer;
    font: inherit;
  }
  .row-btn:hover {
    background: color-mix(in srgb, var(--md-color-error) 14%, transparent);
  }
  .row-main { flex: 1; min-width: 0; }
  .row-title {
    font-size: 0.92rem;
    font-weight: 600;
    color: var(--md-color-error);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-msg {
    font-size: 0.8rem;
    color: var(--md-color-on-surface-variant);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    white-space: normal;
    word-break: break-word;
  }
  .row-arrow {
    font-size: 1.3rem;
    color: var(--md-color-on-surface-variant);
    flex-shrink: 0;
  }
</style>
