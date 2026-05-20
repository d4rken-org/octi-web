import type { OctiServerCredentialRecord } from "../storage/credentials-repo";
import type { SyncConnector } from "../sync/sync-connector";
import { OCTI_WEB_VERSION } from "../version";
import {
  type AuthCreds,
  type DeviceTag,
  commitModule,
  createShareCode,
  listDevices,
  readModulePayload,
  readModulePayloadWithEtag,
  writeModulePayload,
} from "./octi-api";
import {
  downloadBlob,
  uploadBlobBytes,
} from "./blob-session";
import type { DeviceMetadata, ServerAddress, ShareCodeResponse } from "./models";

/**
 * Application-side facade over the Octi sync-server REST + blob-session APIs.
 * Implements {@link SyncConnector} — the application-level contract a future
 * GDrive (or other) connector would also satisfy.
 *
 * One connector instance is bound to one `OctiServerCredentialRecord` plus
 * the per-install own-device-id (passed at construction so the connector is
 * synchronous to use — the dashboard resolves `getOwnDeviceId()` once at
 * bootstrap, not on every fetch).
 *
 * Free protocol functions remain exported for the smoke / protocol-layer
 * tests; this class is the *application-side* entry point. Only methods
 * modules actually consume are exposed (low-level blob-session create / append
 * / finalize / abort live on the protocol layer; `uploadBlobBytes` wraps them).
 */
export class OctiServerConnector implements SyncConnector {
  constructor(
    public readonly record: OctiServerCredentialRecord,
    /**
     * Per-install own-device UUID, sourced from
     * {@code IdentitySettings.getOwnDeviceId()}. Shared across all connectors
     * on this browser so a peer reaching us via multiple connectors dedups on
     * the same `deviceId`. Passed in (not pulled lazily inside the class) so
     * connector methods stay synchronous and side-effect-free.
     */
    private readonly _ownDeviceId: string,
  ) {}

  get connectorId(): string {
    return this.record.connectorId;
  }

  get ownDeviceId(): string {
    return this._ownDeviceId;
  }

  get server(): ServerAddress {
    return this.record.serverAddress;
  }

  get creds(): AuthCreds {
    return {
      accountId: this.record.accountId,
      devicePassword: this.record.devicePassword,
      deviceId: this._ownDeviceId,
    };
  }

  // Account ops
  createShareCode(): Promise<ShareCodeResponse> {
    return createShareCode({ server: this.server, creds: this.creds });
  }

  // Devices
  listDevices(): Promise<DeviceMetadata[]> {
    return listDevices({ server: this.server, creds: this.creds });
  }

  // Module payloads
  readModulePayload(args: {
    targetDeviceId: string;
    moduleId: string;
  }): Promise<Uint8Array | null> {
    return readModulePayload({
      server: this.server,
      creds: this.creds,
      targetDeviceId: args.targetDeviceId,
      moduleId: args.moduleId,
    });
  }

  readModulePayloadWithEtag(args: {
    targetDeviceId: string;
    moduleId: string;
  }): Promise<{ bytes: Uint8Array; etag: string | null; modifiedAt: Date | null } | null> {
    return readModulePayloadWithEtag({
      server: this.server,
      creds: this.creds,
      targetDeviceId: args.targetDeviceId,
      moduleId: args.moduleId,
    });
  }

  writeModulePayload(args: {
    targetDeviceId: string;
    moduleId: string;
    ciphertext: Uint8Array;
    deviceTag?: DeviceTag;
  }): Promise<void> {
    return writeModulePayload({
      server: this.server,
      creds: this.creds,
      targetDeviceId: args.targetDeviceId,
      moduleId: args.moduleId,
      ciphertext: args.ciphertext,
      deviceTag: args.deviceTag,
    });
  }

  commitModule(args: {
    targetDeviceId: string;
    moduleId: string;
    documentBytes: Uint8Array;
    blobIds: string[];
    ifMatch?: string;
    ifNoneMatchStar?: boolean;
  }): Promise<{ etag: string }> {
    return commitModule({
      server: this.server,
      creds: this.creds,
      targetDeviceId: args.targetDeviceId,
      moduleId: args.moduleId,
      documentBytes: args.documentBytes,
      blobIds: args.blobIds,
      ifMatch: args.ifMatch,
      ifNoneMatchStar: args.ifNoneMatchStar,
    });
  }

  // Blob ops (high-level only — uploadBlobBytes already wraps create/append/finalize)
  uploadBlobBytes(args: {
    targetDeviceId: string;
    moduleId: string;
    ciphertext: Uint8Array;
    onProgress?: (bytes: number, total: number) => void;
  }): Promise<string> {
    return uploadBlobBytes({
      server: this.server,
      creds: this.creds,
      version: OCTI_WEB_VERSION,
      targetDeviceId: args.targetDeviceId,
      moduleId: args.moduleId,
      ciphertext: args.ciphertext,
      onProgress: args.onProgress,
    });
  }

  downloadBlob(args: {
    targetDeviceId: string;
    moduleId: string;
    blobId: string;
  }): Promise<Uint8Array> {
    return downloadBlob({
      server: this.server,
      creds: this.creds,
      version: OCTI_WEB_VERSION,
      targetDeviceId: args.targetDeviceId,
      moduleId: args.moduleId,
      blobId: args.blobId,
    });
  }
}
