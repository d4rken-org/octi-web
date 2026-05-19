<script lang="ts">
  import {
    MODULE_DEFS,
    defaultLayoutForPlatform,
    moduleById,
    type TileLayout,
  } from "../../modules/module-registry";
  import Icon from "./Icon.svelte";

  /**
   * Per-device tile editor. Up/down arrows reorder the visible section;
   * toggle buttons control visibility + wide-vs-narrow. Hidden tiles get a
   * dedicated section (with an "unhide" toggle) at the bottom so the user
   * can see what's available but currently suppressed.
   *
   * v1 uses arrow-button reorder, matching Android's button-driven editor.
   * True HTML5 drag-and-drop is a planned follow-up.
   *
   * `onSave` returns the edited layout to the parent (DeviceCard) which
   * persists it through the layout repo.
   */
  let {
    layout,
    platform = "android",
    onSave,
    onCancel,
  }: {
    layout: TileLayout;
    /** Device platform — used by Reset-to-default to compute the seed layout. */
    platform?: string;
    onSave: (next: TileLayout) => void;
    onCancel: () => void;
  } = $props();

  let draft = $state<TileLayout>(cloneLayout(layout));

  function cloneLayout(l: TileLayout): TileLayout {
    return {
      order: l.order.slice(),
      wide: l.wide.slice(),
      hidden: l.hidden.slice(),
    };
  }

  const visible = $derived(draft.order.filter((id) => !draft.hidden.includes(id)));
  const hidden = $derived(draft.order.filter((id) => draft.hidden.includes(id)));

  function labelFor(id: string): string {
    return moduleById(id)?.label ?? id;
  }

  function moveVisible(id: string, direction: -1 | 1) {
    const order = draft.order.slice();
    const visibleNow = order.filter((x) => !draft.hidden.includes(x));
    const visIdx = visibleNow.indexOf(id);
    const swapWith = visIdx + direction;
    if (swapWith < 0 || swapWith >= visibleNow.length) return;
    const targetId = visibleNow[swapWith];
    const a = order.indexOf(id);
    const b = order.indexOf(targetId);
    order[a] = targetId;
    order[b] = id;
    draft = { ...draft, order };
  }

  function toggleWide(id: string) {
    const wide = draft.wide.includes(id)
      ? draft.wide.filter((x) => x !== id)
      : [...draft.wide, id];
    draft = { ...draft, wide };
  }

  function setHidden(id: string, hide: boolean) {
    const hiddenList = hide
      ? [...new Set([...draft.hidden, id])]
      : draft.hidden.filter((x) => x !== id);
    draft = { ...draft, hidden: hiddenList };
  }

  function resetToDefault() {
    draft = defaultLayoutForPlatform(platform);
  }

  function save() {
    onSave(cloneLayout(draft));
  }
</script>

<div class="editor">
  <header>
    <h3>Edit tiles</h3>
    <p class="hint">
      Up/down: reorder. Width: toggle wide hero. Eye: hide. Changes are local to this device's
      card and persist on this browser only.
    </p>
  </header>

  <section>
    <div class="section-label">Visible</div>
    {#if visible.length === 0}
      <div class="muted">All tiles are hidden.</div>
    {:else}
      <ul class="list">
        {#each visible as id, i (id)}
          <li class="row">
            <span class="row-label">{labelFor(id)}</span>
            <span class="row-actions">
              <button
                type="button"
                aria-label="Move up"
                title="Move up"
                disabled={i === 0}
                onclick={() => moveVisible(id, -1)}
              ><Icon name="chevron-up" size={16} /></button>
              <button
                type="button"
                aria-label="Move down"
                title="Move down"
                disabled={i === visible.length - 1}
                onclick={() => moveVisible(id, 1)}
              ><Icon name="chevron-down" size={16} /></button>
              <button
                type="button"
                class:active={draft.wide.includes(id)}
                aria-label="Toggle wide"
                title="Toggle wide"
                onclick={() => toggleWide(id)}
              >W</button>
              <button
                type="button"
                aria-label="Hide"
                title="Hide"
                onclick={() => setHidden(id, true)}
              ><Icon name="x" size={16} /></button>
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if hidden.length > 0}
    <section>
      <div class="section-label">Hidden</div>
      <ul class="list">
        {#each hidden as id (id)}
          <li class="row hidden-row">
            <span class="row-label">{labelFor(id)}</span>
            <span class="row-actions">
              <button
                type="button"
                aria-label="Show"
                title="Show"
                onclick={() => setHidden(id, false)}
              >Show</button>
            </span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if MODULE_DEFS.length > 0}
    <!-- Just to satisfy svelte-check that MODULE_DEFS is "used" alongside its import. -->
  {/if}

  <footer>
    <button type="button" class="secondary" onclick={resetToDefault}>Reset to default</button>
    <span class="spacer"></span>
    <button type="button" class="secondary" onclick={onCancel}>Cancel</button>
    <button type="button" onclick={save}>Save</button>
  </footer>
</div>

<style>
  .editor {
    background: var(--md-color-surface-container-low);
    border-radius: var(--octi-tile-radius);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  header h3 {
    margin: 0 0 4px;
    font-size: 0.95rem;
  }
  .hint {
    margin: 0;
    font-size: 0.78rem;
    color: var(--md-color-on-surface-variant);
  }
  .section-label {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--md-color-on-surface-variant);
    margin-bottom: 6px;
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
    background: var(--md-color-surface-container);
    border-radius: 8px;
  }
  .row.hidden-row {
    opacity: 0.7;
  }
  .row-label {
    flex: 1;
    color: var(--md-color-on-surface);
  }
  .row-actions {
    display: inline-flex;
    gap: 4px;
  }
  .row-actions button {
    width: 32px;
    height: 32px;
    padding: 0;
    border-radius: 6px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--md-color-on-surface-variant);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.8rem;
  }
  .row-actions button[title]:not(:disabled):hover {
    background: color-mix(in srgb, var(--md-color-on-surface) 8%, transparent);
    color: var(--md-color-on-surface);
  }
  .row-actions button.active {
    background: var(--md-color-primary-container);
    color: var(--md-color-on-primary-container);
    border-color: var(--md-color-primary);
  }
  .row-actions button:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }
  .muted {
    color: var(--md-color-on-surface-variant);
    font-size: 0.85rem;
  }
  footer {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  footer .spacer {
    flex: 1;
  }
  .secondary {
    background: transparent;
    border: 1px solid var(--md-color-outline-variant);
  }
</style>
