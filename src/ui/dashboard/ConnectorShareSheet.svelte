<script lang="ts">
  import type { OctiServerConnector } from "../../protocol/octi-server-connector";
  import ShareCode from "../ShareCode.svelte";
  import Sheet from "./Sheet.svelte";

  /**
   * Per-connector share sheet. Opened from the ConnectorCard's Share action.
   * Wraps `<ShareCode>` with the connector identity in the sheet subtitle so
   * the user can verify which account they're about to mint a code for.
   *
   * The linking payload bundles that connector's encryption keyset — minting on
   * the wrong account exposes the wrong keyset to the joiner, so the identity
   * confirmation matters.
   */
  let {
    connector,
    onClose,
    onDeviceLinked,
  }: {
    connector: OctiServerConnector;
    onClose: () => void;
    onDeviceLinked?: () => void;
  } = $props();

  const record = $derived(connector.record);
  // Includes the short account-id tail so two accounts on the same server
  // with the same browser label are distinguishable. Matches the
  // disambiguation shown by ShareCode's full identity panel.
  const subtitle = $derived(
    `${record.serverAddress.domain} · ${record.deviceLabel || "Browser"} · …${record.accountId.slice(-6)}`,
  );
</script>

<Sheet title="Add another device" {subtitle} wide {onClose}>
  <!--
    `{#key}` is defensive: today's parent (`SyncSourcesScreen`) always closes
    this sheet between connector picks, so `connector` is effectively
    immutable. But if a future caller swaps `connector` on a live mount, an
    in-flight mint from the old connector could land its link/QR under the
    new identity — and the link bundles that connector's encryption keyset,
    so this would expose the wrong account's keyset. The key forces a fresh
    `ShareCode` instance whenever the target changes.
  -->
  {#key connector.connectorId}
    <ShareCode {connector} {onDeviceLinked} />
  {/key}
</Sheet>
