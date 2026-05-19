<script lang="ts">
  import { packagesByInstalledAtDesc, type AppsInfo, type Pkg } from "../../../modules/apps";
  import CopyButton from "../CopyButton.svelte";
  import Sheet from "../Sheet.svelte";

  let {
    info,
    error,
    deviceLabel,
    onClose,
  }: {
    info: AppsInfo | null;
    error: string | null;
    deviceLabel: string;
    onClose: () => void;
  } = $props();

  const SLICE_SIZE = 50;
  let query = $state("");
  const allSorted = $derived(info ? packagesByInstalledAtDesc(info) : ([] as Pkg[]));
  /**
   * Important: filter the FULL list before slicing. Slicing first would hide
   * any package after index 50 from the search, which is the most common
   * reason a user would open the search box.
   */
  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return allSorted;
    return allSorted.filter((p) => {
      if (p.packageName.toLowerCase().includes(q)) return true;
      if (p.label && p.label.toLowerCase().includes(q)) return true;
      return false;
    });
  });
  const visible = $derived(filtered.slice(0, SLICE_SIZE));
  const truncated = $derived(filtered.length > SLICE_SIZE);

  function formatInstalledAt(s: string): string {
    // "2026-05-18T14:00:00Z" → "2026-05-18"
    return s.length >= 10 ? s.slice(0, 10) : s;
  }
</script>

<Sheet title="Apps" subtitle={deviceLabel} {onClose}>
  {#if error}
    <div class="error">Decode failed: {error}</div>
  {:else if !info}
    <div class="empty">This device hasn't published AppsInfo yet.</div>
  {:else}
    <div class="meta">
      {info.installedPackages.length} installed
    </div>
    <input
      class="search"
      type="search"
      placeholder="Search by name or package"
      bind:value={query}
      aria-label="Search apps"
    />
    {#if filtered.length === 0}
      <div class="empty">No matches.</div>
    {:else}
      <ul class="list">
        {#each visible as p (p.packageName)}
          <li class="row">
            <div class="row-main">
              <div class="row-label">{p.label ?? p.packageName}</div>
              <div class="row-pkg">{p.packageName}</div>
              <div class="row-meta">
                v{p.versionName ?? p.versionCode} · installed {formatInstalledAt(p.installedAt)}
                {#if p.installerPkg}· via {p.installerPkg}{/if}
              </div>
            </div>
            <CopyButton value={p.packageName} compact ariaLabel={`Copy ${p.packageName}`} />
          </li>
        {/each}
      </ul>
      {#if truncated}
        <div class="truncated">
          Showing {SLICE_SIZE} of {filtered.length} matches — refine the search to see more.
        </div>
      {/if}
    {/if}
  {/if}
</Sheet>

<style>
  .meta {
    font-size: 0.85rem;
    color: var(--md-color-on-surface-variant);
    margin-bottom: 8px;
  }
  .search {
    width: 100%;
    margin-bottom: 12px;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    background: var(--md-color-surface-container-low);
    border-radius: 8px;
  }
  .row-main {
    flex: 1;
    min-width: 0;
  }
  .row-label {
    font-size: 0.92rem;
    color: var(--md-color-on-surface);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-pkg {
    font-family: "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.75rem;
    color: var(--md-color-on-surface-variant);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-meta {
    font-size: 0.72rem;
    color: var(--md-color-on-surface-variant);
    margin-top: 2px;
  }
  .truncated {
    margin-top: 10px;
    font-size: 0.78rem;
    color: var(--md-color-on-surface-variant);
    text-align: center;
  }
  .error {
    color: var(--md-color-error);
    font-size: 0.9rem;
  }
  .empty {
    color: var(--md-color-on-surface-variant);
    font-size: 0.9rem;
  }
</style>
