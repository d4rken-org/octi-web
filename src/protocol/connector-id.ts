import type { ServerAddress } from "./models";

/**
 * Build the connector-instance ID for an Octi sync-server credential. Format
 * matches Android's `ConnectorId.idString` for `ConnectorType.OCTISERVER`
 * (typeId `"kserver"`): `kserver-<domain>-<accountId>`.
 *
 * The format is wire-visible — it appears as a key inside
 * `FileShareInfo.connectorRefs` and `FileShareInfo.availableOn`, where Android
 * and web read each other's published values. Do not change without a
 * coordinated cross-repo PR.
 *
 * This module lives under `src/protocol/` (not `src/storage/`) so other code
 * paths can compute the id without pulling in IndexedDB types.
 */
export function octiServerConnectorId(server: ServerAddress, accountId: string): string {
  return `kserver-${server.domain}-${accountId}`;
}
