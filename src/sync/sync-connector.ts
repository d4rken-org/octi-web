import type { DeviceTag } from "../protocol/octi-api";
import type { DeviceMetadata } from "../protocol/models";

/**
 * Application-level contract for a sync connector. {@link OctiServerConnector}
 * implements it today; a future GDrive (or other) connector type would too.
 *
 * Scope: the surface PR 2's merge engine and module helpers actually consume.
 * Everything connector-type-specific (Octi-server's `server`/`creds`/
 * `createShareCode`, GDrive's OAuth tokens, …) stays off this interface and
 * lives on the concrete implementation. Code that talks to one specific
 * connector type accepts the concrete class; the merge / module-helper layer
 * works through this interface and never sees those details.
 *
 * What's intentionally NOT on the interface:
 *   - Lifecycle (add / remove credential, sign out): the connector manager
 *     owns that. A connector is a transport facade over an existing
 *     credential — it doesn't manage its own existence.
 *   - Connector-type-specific credentials, share-code minting, OAuth refresh,
 *     etc.: each implementation handles those on its own concrete class.
 *
 * Implementations are expected to be cheap to construct (just hold a
 * reference to their credential record) and side-effect-free until a method
 * is called. The manager rebuilds them whenever the underlying record
 * changes.
 */
export interface SyncConnector {
  /**
   * Stable per-instance identifier. Format is connector-type specific:
   *   - Octi-server: `kserver-<domain>-<accountId>` (matches Android's
   *     `ConnectorId.idString` and the `connectorRefs` map keys on the wire).
   * The dashboard uses this for per-connector caching, ETag keys, and the
   * cross-connector merge's tiebreak.
   */
  readonly connectorId: string;

  /**
   * The own-device UUID this connector advertises to its server as
   * `X-Device-ID`. Shared across all connectors on the same browser install
   * (sourced from {@code IdentitySettings.getOwnDeviceId()}), so a peer that
   * reaches us via two connectors merges the cards on `deviceId`.
   */
  readonly ownDeviceId: string;

  // ─── Device list ─────────────────────────────────────────────
  listDevices(): Promise<DeviceMetadata[]>;

  // ─── Module payloads ─────────────────────────────────────────
  readModulePayload(args: { targetDeviceId: string; moduleId: string }): Promise<Uint8Array | null>;
  readModulePayloadWithEtag(args: {
    targetDeviceId: string;
    moduleId: string;
  }): Promise<{ bytes: Uint8Array; etag: string | null; modifiedAt: Date | null } | null>;
  writeModulePayload(args: {
    targetDeviceId: string;
    moduleId: string;
    ciphertext: Uint8Array;
    deviceTag?: DeviceTag;
  }): Promise<void>;
  commitModule(args: {
    targetDeviceId: string;
    moduleId: string;
    documentBytes: Uint8Array;
    blobIds: string[];
    ifMatch?: string;
    ifNoneMatchStar?: boolean;
  }): Promise<{ etag: string }>;

  // ─── Blob ops (high-level — append/finalize wrapped by uploadBlobBytes) ───
  uploadBlobBytes(args: {
    targetDeviceId: string;
    moduleId: string;
    ciphertext: Uint8Array;
    onProgress?: (bytes: number, total: number) => void;
  }): Promise<string>;
  downloadBlob(args: {
    targetDeviceId: string;
    moduleId: string;
    blobId: string;
  }): Promise<Uint8Array>;
}
