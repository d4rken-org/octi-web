import type { OctiServerCredentialRecord } from "../storage/credentials-repo";
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
 * One connector instance is bound to one `OctiServerCredentialRecord` — server
 * address, auth creds, and own-device-id all come from the record so callers
 * never thread `{server, creds}` pairs manually.
 *
 * This is the seam where a future `SyncConnector` interface lands when web
 * grows multi-connector support. Today there's only one variant (`kserver`);
 * a GDrive sibling would implement the same surface and the UI would consume
 * either through the interface.
 *
 * Free protocol functions remain exported for the smoke / protocol-layer
 * tests; this class is the *application-side* entry point.
 *
 * Only the methods modules actually consume are exposed. Low-level blob-session
 * primitives (create/append/finalize/abort) are intentionally NOT on the class
 * — `uploadBlobBytes` already wraps them.
 */
export class OctiServerConnector {
  constructor(public readonly record: OctiServerCredentialRecord) {}

  get connectorId(): string {
    return this.record.connectorId;
  }

  get ownDeviceId(): string {
    return this.record.ownDeviceId;
  }

  get server(): ServerAddress {
    return this.record.serverAddress;
  }

  get creds(): AuthCreds {
    return {
      accountId: this.record.accountId,
      devicePassword: this.record.devicePassword,
      deviceId: this.record.ownDeviceId,
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
  }): Promise<{ bytes: Uint8Array; etag: string | null } | null> {
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
