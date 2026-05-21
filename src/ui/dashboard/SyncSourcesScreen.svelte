<script lang="ts">
  import type { ConnectorManager } from "../../sync/connector-manager.svelte";
  import ConnectorCard from "./ConnectorCard.svelte";
  import ConnectorDevicesScreen from "./ConnectorDevicesScreen.svelte";
  import ConnectorShareSheet from "./ConnectorShareSheet.svelte";
  import DisconnectConfirmDialog from "./DisconnectConfirmDialog.svelte";
  import Sheet from "./Sheet.svelte";

  /**
   * Top-level list of all linked sync sources, reachable from the Settings
   * sheet. Mirrors Android's `SyncListScreen`.
   *
   * Per card actions:
   *   - Refresh: trigger a refresh of THIS connector only via
   *     `manager.refreshOne(connectorId)`. Other connectors are untouched.
   *   - Share: mint a share code for THIS connector's account so another
   *     device can join it. (Wire calls are per-connector — see ShareCode.svelte.)
   *   - View devices: drill into the per-connector device list.
   *   - Disconnect: confirm + remove the credential. Other connectors
   *     stay active.
   *
   * "Add another sync source" routes back to `Onboarding` via the parent's
   * `onAdd` callback — Onboarding's mode-switcher (Create / LinkPaste /
   * LinkScan) is already multi-credential-aware after PR 2.
   */
  let {
    manager,
    ownDeviceId,
    onAddSource,
    onClose,
  }: {
    manager: ConnectorManager;
    ownDeviceId: string;
    onAddSource: () => void;
    onClose: () => void;
  } = $props();

  /** Sub-sheet state. Only one of these is open at a time. */
  let devicesForConnectorId = $state<string | null>(null);
  let shareForConnectorId = $state<string | null>(null);
  let confirmDisconnectId = $state<string | null>(null);
  let disconnecting = $state(false);

  const devicesForConnector = $derived(
    devicesForConnectorId
      ? manager.connectors.find((c) => c.connectorId === devicesForConnectorId) ?? null
      : null,
  );
  const shareForConnector = $derived(
    shareForConnectorId
      ? manager.connectors.find((c) => c.connectorId === shareForConnectorId) ?? null
      : null,
  );
  const confirmDisconnectConnector = $derived(
    confirmDisconnectId
      ? manager.connectors.find((c) => c.connectorId === confirmDisconnectId) ?? null
      : null,
  );

  async function confirmDisconnect() {
    if (!confirmDisconnectId) return;
    disconnecting = true;
    try {
      await manager.removeConnector(confirmDisconnectId);
    } finally {
      disconnecting = false;
      confirmDisconnectId = null;
    }
  }

  function handleShareDeviceLinked(connectorId: string) {
    shareForConnectorId = null;
    void manager.refreshOne(connectorId);
  }
</script>

<Sheet
  title="Sync sources"
  subtitle="{manager.connectors.length} linked"
  wide
  {onClose}
>
  {#if manager.connectors.length === 0}
    <p class="empty">No sync sources linked. Tap "Add another" to get started.</p>
  {:else}
    {#each manager.connectors as connector (connector.connectorId)}
      <ConnectorCard
        {connector}
        state={manager.perConnectorState.get(connector.connectorId)}
        onRefresh={() => void manager.refreshOne(connector.connectorId)}
        onShare={() => (shareForConnectorId = connector.connectorId)}
        onViewDevices={() => (devicesForConnectorId = connector.connectorId)}
        onDisconnect={() => (confirmDisconnectId = connector.connectorId)}
      />
    {/each}
  {/if}

  <div class="add-row">
    <button type="button" class="add-btn" onclick={onAddSource} data-testid="add-sync-source">
      + Add another sync source
    </button>
  </div>
</Sheet>

{#if devicesForConnector}
  <ConnectorDevicesScreen
    connector={devicesForConnector}
    state={manager.perConnectorState.get(devicesForConnector.connectorId)}
    {ownDeviceId}
    onClose={() => (devicesForConnectorId = null)}
  />
{/if}

{#if shareForConnector}
  <ConnectorShareSheet
    connector={shareForConnector}
    onClose={() => (shareForConnectorId = null)}
    onDeviceLinked={() => handleShareDeviceLinked(shareForConnector.connectorId)}
  />
{/if}

{#if confirmDisconnectConnector}
  <DisconnectConfirmDialog
    title="Disconnect this sync source?"
    body={`Remove ${confirmDisconnectConnector.record.serverAddress.domain} from this browser. Your device record stays on that server until you remove it from another Octi device. Other linked sync sources keep working.`}
    busy={disconnecting}
    onConfirm={confirmDisconnect}
    onCancel={() => (confirmDisconnectId = null)}
  />
{/if}

<style>
  .empty {
    text-align: center;
    color: var(--md-color-on-surface-variant);
    padding: 20px 0;
    font-size: 0.88rem;
  }
  .add-row {
    margin-top: 12px;
    display: flex;
    justify-content: center;
  }
  .add-btn {
    padding: 10px 18px;
    border-radius: 22px;
    border: 1px dashed var(--md-color-outline);
    background: transparent;
    color: var(--md-color-on-surface);
    font-size: 0.88rem;
    cursor: pointer;
  }
  .add-btn:hover {
    background: color-mix(in srgb, var(--md-color-on-surface) 8%, transparent);
    border-style: solid;
  }
</style>
