/**
 * Verify octi-web's FileShareInfo decoder can consume what octi-desktop publishes.
 *
 * Wire-shape differences vs web's own fixtures: desktop emits plain UUID strings for
 * `SharedFile.blobKey` (via `UUID.randomUUID().toString()`) rather than the
 * `sha256:<hex>` form web/android use. The connector IDs are desktop-flavoured
 * (`kserver-prod...77777777-...`). Long size handling: same 8e9-byte `files-large`
 * vector as web's own producer, exceeds Int.MAX_VALUE — JS Number handles it exactly
 * through 2^53.
 */
import { describe, expect, it } from "vitest";

import {
  type InteropPublishedModuleFixture,
  type InteropPublishedVector,
  loadInteropJson,
  verifyVectorIntegrity,
} from "./fixture-loader";
import { deserializeFileShareInfo, FILES_MODULE_ID } from "../modules/files";

const SOURCE = "d4rken-org/octi-desktop";
const FIXTURE_FILE = "octi-desktop-files.json";

const PROD_CONNECTOR =
  "kserver-prod.kserver.octi.darken.eu-77777777-8888-9999-aaaa-bbbbbbbbbbbb";
const BETA_CONNECTOR =
  "kserver-beta.kserver.octi.darken.eu-cccccccc-1111-2222-3333-444444444444";

const fixture = loadInteropJson<InteropPublishedModuleFixture>(FIXTURE_FILE, SOURCE);

function vector(name: string): InteropPublishedVector {
  const v = fixture.vectors.find((x) => x.name === name);
  if (!v) throw new Error(`vector '${name}' missing in ${fixture.module}`);
  verifyVectorIntegrity(v);
  return v;
}

function decode(v: InteropPublishedVector) {
  return deserializeFileShareInfo(new TextEncoder().encode(v.payloadJson));
}

describe("desktop files interop", () => {
  it("fixture schema sanity", () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.module).toBe(FILES_MODULE_ID);
    expect(fixture.producer).toBe(SOURCE);
    expect(fixture.vectors.map((v) => v.name)).toEqual([
      "empty",
      "single-file",
      "with-multiple-files",
      "with-delete-requests",
      "multi-connector",
      "files-large",
    ]);
  });

  it("'empty' vector decodes to empty lists", () => {
    const info = decode(vector("empty"));
    expect(info.files).toEqual([]);
    expect(info.deleteRequests).toEqual([]);
  });

  it("'single-file' vector decodes one SharedFile with UUID blobKey", () => {
    const info = decode(vector("single-file"));
    expect(info.files.length).toBe(1);
    expect(info.deleteRequests).toEqual([]);

    const f = info.files[0];
    expect(f.name).toBe("notes.txt");
    expect(f.mimeType).toBe("text/plain");
    expect(f.size).toBe(1234);
    expect(f.blobKey).toBe("00000000-0000-0000-0000-000000000001");
    expect(f.checksum).toBe("11".repeat(32));
    expect(f.sharedAt).toBe("2026-05-01T12:00:00Z");
    expect(f.expiresAt).toBe("2026-05-31T12:00:00Z");
    expect(f.availableOn).toEqual([PROD_CONNECTOR]);
    expect(f.connectorRefs).toEqual({ [PROD_CONNECTOR]: "blob-id-aaaa" });
  });

  it("'with-multiple-files' vector decodes both entries field-by-field", () => {
    const info = decode(vector("with-multiple-files"));
    expect(info.files.length).toBe(2);
    expect(info.deleteRequests).toEqual([]);

    const alpha = info.files[0];
    expect(alpha.name).toBe("alpha.bin");
    expect(alpha.mimeType).toBe("application/octet-stream");
    expect(alpha.size).toBe(256);
    expect(alpha.blobKey).toBe("00000000-0000-0000-0000-000000000002");
    expect(alpha.checksum).toBe("22".repeat(32));
    expect(alpha.sharedAt).toBe("2026-05-01T12:00:00Z");
    expect(alpha.expiresAt).toBe("2026-05-31T12:00:00Z");
    expect(alpha.availableOn).toEqual([PROD_CONNECTOR]);
    expect(alpha.connectorRefs).toEqual({ [PROD_CONNECTOR]: "blob-id-bbbb" });

    const beta = info.files[1];
    expect(beta.name).toBe("beta.pdf");
    expect(beta.mimeType).toBe("application/pdf");
    expect(beta.size).toBe(4096);
    expect(beta.blobKey).toBe("00000000-0000-0000-0000-000000000003");
    expect(beta.checksum).toBe("33".repeat(32));
    expect(beta.sharedAt).toBe("2026-05-01T13:00:00Z");
    expect(beta.expiresAt).toBe("2026-05-31T13:00:00Z");
    expect(beta.availableOn).toEqual([PROD_CONNECTOR]);
    expect(beta.connectorRefs).toEqual({ [PROD_CONNECTOR]: "blob-id-cccc" });
  });

  it("'with-delete-requests' vector decodes the deleteRequests branch field-by-field", () => {
    const info = decode(vector("with-delete-requests"));
    expect(info.files.length).toBe(1);
    expect(info.deleteRequests.length).toBe(1);

    const f = info.files[0];
    expect(f.name).toBe("shared.txt");
    expect(f.mimeType).toBe("text/plain");
    expect(f.size).toBe(100);
    expect(f.blobKey).toBe("00000000-0000-0000-0000-000000000004");
    expect(f.checksum).toBe("44".repeat(32));
    expect(f.sharedAt).toBe("2026-05-01T12:00:00Z");
    expect(f.expiresAt).toBe("2026-05-31T12:00:00Z");
    expect(f.availableOn).toEqual([PROD_CONNECTOR]);
    expect(f.connectorRefs).toEqual({ [PROD_CONNECTOR]: "blob-id-dddd" });

    const req = info.deleteRequests[0];
    expect(req.targetDeviceId).toBe("99999999-8888-7777-6666-555555555555");
    expect(req.blobKey).toBe("00000000-0000-0000-0000-000000000005");
    expect(req.requestedAt).toBe("2026-05-10T00:00:00Z");
    expect(req.retainUntil).toBe("2026-05-17T00:00:00Z");
  });

  it("'multi-connector' vector decodes both connectorRefs entries field-by-field", () => {
    const info = decode(vector("multi-connector"));
    expect(info.files.length).toBe(1);
    expect(info.deleteRequests).toEqual([]);

    const f = info.files[0];
    expect(f.name).toBe("shared-across.bin");
    expect(f.mimeType).toBe("application/octet-stream");
    expect(f.size).toBe(512);
    expect(f.blobKey).toBe("00000000-0000-0000-0000-000000000007");
    expect(f.checksum).toBe("77".repeat(32));
    expect(f.sharedAt).toBe("2026-05-01T12:00:00Z");
    expect(f.expiresAt).toBe("2026-05-31T12:00:00Z");
    expect(new Set(f.availableOn)).toEqual(new Set([PROD_CONNECTOR, BETA_CONNECTOR]));
    expect(f.connectorRefs).toEqual({
      [PROD_CONNECTOR]: "blob-id-prod-7777",
      [BETA_CONNECTOR]: "blob-id-beta-7777",
    });
  });

  it("'files-large' vector decodes size larger than Int.MAX_VALUE", () => {
    // Pins large-number handling on the JS consumer. JS Number is double-precision so
    // 8e9 is exactly representable; the test still asserts equality to catch a
    // hypothetical type-erasure-to-string regression.
    const info = decode(vector("files-large"));
    expect(info.files.length).toBe(1);
    expect(info.deleteRequests).toEqual([]);

    const f = info.files[0];
    expect(f.name).toBe("big.iso");
    expect(f.mimeType).toBe("application/octet-stream");
    expect(f.size).toBe(8_000_000_000);
    expect(f.size).toBeGreaterThan(2 ** 31 - 1);
    expect(f.blobKey).toBe("00000000-0000-0000-0000-000000000006");
    expect(f.checksum).toBe("66".repeat(32));
    expect(f.sharedAt).toBe("2026-05-01T12:00:00Z");
    expect(f.expiresAt).toBe("2026-05-31T12:00:00Z");
    expect(f.availableOn).toEqual([PROD_CONNECTOR]);
    expect(f.connectorRefs).toEqual({ [PROD_CONNECTOR]: "blob-id-eeee" });
  });
});
