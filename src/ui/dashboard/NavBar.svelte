<script lang="ts">
  import Icon from "./Icon.svelte";
  import OverflowMenu, { type MenuItem } from "./OverflowMenu.svelte";

  /**
   * Sticky dashboard nav. Hosts:
   * - Page title + identity subtitle (signed-in label + server domain).
   * - Version pill + last-sync pill (passive at-a-glance state).
   * - Permanent Refresh button.
   * - Settings cog (opens the SettingsScreen sheet).
   * - Overflow menu (Republish / Add device / Sign-out).
   *
   * Stays above device cards (z: 100) and renders its dropdown above
   * per-card menus (z: 110 inside OverflowMenu).
   */
  let {
    accountSubtitle,
    version,
    lastSyncLabel,
    loading,
    onRefresh,
    onOpenSettings,
    menuItems,
  }: {
    accountSubtitle: string;
    version: string;
    lastSyncLabel: string;
    loading: boolean;
    onRefresh: () => void;
    onOpenSettings: () => void;
    menuItems: MenuItem[];
  } = $props();
</script>

<header class="nav">
  <div class="identity">
    <h1 class="title">Octi web</h1>
    <div class="subtitle">{accountSubtitle}</div>
  </div>
  <div class="pills">
    <span class="pill" title="octi-web version">v{version}</span>
    <span class="pill last-sync" title="Last successful sync">
      {loading ? "Syncing…" : `Sync: ${lastSyncLabel}`}
    </span>
  </div>
  <div class="actions">
    <button
      type="button"
      class="refresh"
      aria-label="Refresh now"
      onclick={onRefresh}
      disabled={loading}
    >
      <Icon name="refresh" size={16} />
      <span class="refresh-label">Refresh</span>
    </button>
    <button
      type="button"
      class="icon-btn"
      aria-label="Settings"
      onclick={onOpenSettings}
    >
      <Icon name="settings" size={18} />
    </button>
    <OverflowMenu items={menuItems} ariaLabel="Account actions" />
  </div>
</header>

<style>
  .nav {
    display: grid;
    /* mobile-first: stack identity over pills/actions */
    grid-template-columns: 1fr auto;
    grid-template-areas:
      "identity actions"
      "pills    pills";
    gap: 8px 12px;
    align-items: center;
    padding: 12px 16px;
    margin-bottom: 16px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--md-color-surface-container) 92%, transparent);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid var(--md-color-outline-variant);
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .identity {
    grid-area: identity;
    min-width: 0;
  }
  .title {
    font-size: 1.3rem;
    font-weight: 600;
    margin: 0;
    line-height: 1.15;
    color: var(--md-color-on-surface);
  }
  .subtitle {
    font-size: 0.78rem;
    color: var(--md-color-on-surface-variant);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pills {
    grid-area: pills;
    display: inline-flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .pill {
    font-size: 0.72rem;
    color: var(--md-color-on-surface-variant);
    background: color-mix(in srgb, var(--md-color-on-surface) 6%, transparent);
    padding: 3px 8px;
    border-radius: 999px;
    line-height: 1.2;
    white-space: nowrap;
  }

  .actions {
    grid-area: actions;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .refresh {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: 18px;
    border: 1px solid var(--md-color-outline-variant);
    background: transparent;
    color: var(--md-color-on-surface);
    font-size: 0.82rem;
    cursor: pointer;
  }
  .refresh:hover:not(:disabled) {
    background: color-mix(in srgb, var(--md-color-on-surface) 8%, transparent);
  }
  .refresh:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .refresh-label {
    /* Hidden on narrow viewports — icon stays. */
    display: none;
  }
  .icon-btn {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: none;
    background: transparent;
    color: var(--md-color-on-surface-variant);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }
  .icon-btn:hover {
    background: color-mix(in srgb, var(--md-color-on-surface) 8%, transparent);
    color: var(--md-color-on-surface);
  }

  /* Wider viewports: identity + pills inline, actions on the right */
  @media (min-width: 720px) {
    .nav {
      grid-template-columns: 1fr auto auto;
      grid-template-areas: "identity pills actions";
    }
    .refresh-label {
      display: inline;
    }
  }
</style>
