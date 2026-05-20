import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAddress } from "./models";
import {
  OCTI_WEB_CAPABILITIES_HEADER,
  OctiApiError,
  commitModule,
  createOrJoinAccount,
  createShareCode,
  listDevices,
  readModulePayload,
  readModulePayloadWithEtag,
  writeModulePayload,
} from "./octi-api";

const server: ServerAddress = { domain: "sync.test", protocol: "https", port: 443 };
const creds = {
  accountId: "acct-123",
  devicePassword: "dpw-very-secret",
  deviceId: "dev-uuid-1",
};

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function expectedAuthHeader() {
  return `Basic ${btoa(`${creds.accountId}:${creds.devicePassword}`)}`;
}

describe("octi-api", () => {
  // Replace globalThis.fetch with a vi.fn so call args land in a properly-typed
  // mock context. vi.spyOn on a host function-typed property erases the call
  // signature in TypeScript, which would force casts on every `init?.method`
  // assertion.
  const originalFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(jsonResponse({}));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("createOrJoinAccount", () => {
    it("POSTs to /v1/account with platform + version + capabilities + label", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ account: "a", devicePassword: "p" }),
      );
      await createOrJoinAccount({
        server,
        deviceId: creds.deviceId,
        deviceTag: { version: "octi-web/1.2.3", label: "My Firefox" },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://sync.test:443/v1/account");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers["X-Device-ID"]).toBe(creds.deviceId);
      expect(headers["Octi-Device-Platform"]).toBe("web");
      expect(headers["Octi-Device-Version"]).toBe("octi-web/1.2.3");
      expect(headers["Octi-Device-Label"]).toBe("My Firefox");
      expect(headers["Octi-Device-Capabilities"]).toBe(OCTI_WEB_CAPABILITIES_HEADER);
    });

    it("appends share=<code> query when joining an existing account", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({}));
      await createOrJoinAccount({
        server,
        deviceId: creds.deviceId,
        deviceTag: { version: "v", label: "L" },
        shareCode: "code with space",
      });
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://sync.test:443/v1/account?share=code%20with%20space");
    });

    it("throws OctiApiError on non-2xx with status + body slice", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("server says no", { status: 503 }));
      await expect(
        createOrJoinAccount({
          server,
          deviceId: creds.deviceId,
          deviceTag: { version: "v", label: "L" },
        }),
      ).rejects.toMatchObject({
        name: "OctiApiError",
        status: 503,
      });
    });
  });

  describe("createShareCode", () => {
    it("POSTs to /v1/account/share with Basic auth and no label", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ shareCode: "sc-1" }));
      await createShareCode({ server, creds });
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://sync.test:443/v1/account/share");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(expectedAuthHeader());
      // No deviceTag → no label header.
      expect(headers["Octi-Device-Label"]).toBeUndefined();
    });
  });

  describe("listDevices", () => {
    it("GETs /v1/devices with auth and returns the devices array", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ devices: [{ deviceId: "a" }, { deviceId: "b" }] }),
      );
      const devs = await listDevices({ server, creds });
      expect(devs).toHaveLength(2);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://sync.test:443/v1/devices");
      expect(init?.method).toBe("GET");
    });
  });

  describe("readModulePayload", () => {
    it("returns null on HTTP 204 (no payload yet)", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
      const result = await readModulePayload({
        server,
        creds,
        targetDeviceId: "peer-1",
        moduleId: "mod.x",
      });
      expect(result).toBeNull();
    });

    it("returns null on empty body even with HTTP 200", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(new Uint8Array(), { status: 200 }));
      const result = await readModulePayload({
        server,
        creds,
        targetDeviceId: "peer-1",
        moduleId: "mod.x",
      });
      expect(result).toBeNull();
    });

    it("URL-encodes module id and target device id", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await readModulePayload({
        server,
        creds,
        targetDeviceId: "peer/1",
        moduleId: "mod.a/b",
      });
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe(
        "https://sync.test:443/v1/module/mod.a%2Fb?device-id=peer%2F1",
      );
    });

    it("propagates ETag and X-Modified-At via readModulePayloadWithEtag", async () => {
      const modifiedAtHeader = "Wed, 20 May 2026 19:00:00 GMT";
      fetchSpy.mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { ETag: '"abc-123"', "X-Modified-At": modifiedAtHeader },
        }),
      );
      const result = await readModulePayloadWithEtag({
        server,
        creds,
        targetDeviceId: "peer-1",
        moduleId: "mod.x",
      });
      expect(result?.bytes).toEqual(new Uint8Array([1, 2, 3]));
      expect(result?.etag).toBe('"abc-123"');
      expect(result?.modifiedAt).toEqual(new Date(modifiedAtHeader));
    });

    it("returns modifiedAt: null when X-Modified-At header is absent (older sync-server)", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(new Uint8Array([4, 5, 6]), {
          status: 200,
          headers: { ETag: '"e2"' },
        }),
      );
      const result = await readModulePayloadWithEtag({
        server,
        creds,
        targetDeviceId: "peer-1",
        moduleId: "mod.x",
      });
      expect(result?.modifiedAt).toBeNull();
    });

    it("returns modifiedAt: null when X-Modified-At is unparseable", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(new Uint8Array([7, 8]), {
          status: 200,
          headers: { ETag: '"e3"', "X-Modified-At": "not-a-date" },
        }),
      );
      const result = await readModulePayloadWithEtag({
        server,
        creds,
        targetDeviceId: "peer-1",
        moduleId: "mod.x",
      });
      expect(result?.modifiedAt).toBeNull();
    });

    it("throws OctiApiError on 404", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("nope", { status: 404 }));
      await expect(
        readModulePayload({
          server,
          creds,
          targetDeviceId: "peer-1",
          moduleId: "mod.x",
        }),
      ).rejects.toBeInstanceOf(OctiApiError);
    });
  });

  describe("commitModule", () => {
    it("rejects when neither ifMatch nor ifNoneMatchStar is provided", async () => {
      await expect(
        commitModule({
          server,
          creds,
          targetDeviceId: "self",
          moduleId: "mod.x",
          documentBytes: new Uint8Array([1]),
          blobIds: [],
        }),
      ).rejects.toThrow(/exactly one/);
    });

    it("rejects when both ifMatch and ifNoneMatchStar are provided", async () => {
      await expect(
        commitModule({
          server,
          creds,
          targetDeviceId: "self",
          moduleId: "mod.x",
          documentBytes: new Uint8Array([1]),
          blobIds: [],
          ifMatch: '"abc"',
          ifNoneMatchStar: true,
        }),
      ).rejects.toThrow(/exactly one/);
    });

    it("sends If-None-Match: * for first-write semantics", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ etag: '"new"' }));
      const out = await commitModule({
        server,
        creds,
        targetDeviceId: "self",
        moduleId: "mod.x",
        documentBytes: new Uint8Array([0xaa, 0xbb]),
        blobIds: ["blob-1"],
        ifNoneMatchStar: true,
      });
      expect(out.etag).toBe('"new"');
      const [url, init] = fetchSpy.mock.calls[0];
      expect(init?.method).toBe("PUT");
      expect((init?.headers as Record<string, string>)["If-None-Match"]).toBe("*");
      expect(url).toContain("/v1/module/mod.x?device-id=self");
      const body = JSON.parse(init!.body as string);
      expect(body.documentBase64).toBe("qrs="); // base64 of [0xaa, 0xbb]
      expect(body.blobRefs).toEqual([{ blobId: "blob-1" }]);
    });

    it("sends If-Match: <etag> for update semantics", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ etag: '"new"' }));
      await commitModule({
        server,
        creds,
        targetDeviceId: "self",
        moduleId: "mod.x",
        documentBytes: new Uint8Array(),
        blobIds: [],
        ifMatch: '"prev"',
      });
      const [, init] = fetchSpy.mock.calls[0];
      expect((init?.headers as Record<string, string>)["If-Match"]).toBe('"prev"');
    });
  });

  describe("writeModulePayload", () => {
    it("POSTs ciphertext with octet-stream content-type and no label header when deviceTag omitted", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
      await writeModulePayload({
        server,
        creds,
        targetDeviceId: creds.deviceId,
        moduleId: "mod.meta",
        ciphertext: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      });
      const [, init] = fetchSpy.mock.calls[0];
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/octet-stream");
      expect(headers["Octi-Device-Label"]).toBeUndefined();
      expect(init?.body).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    });

    it("forwards deviceTag.label as Octi-Device-Label header", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
      await writeModulePayload({
        server,
        creds,
        targetDeviceId: creds.deviceId,
        moduleId: "mod.meta",
        ciphertext: new Uint8Array(),
        deviceTag: { version: "octi-web/9.9.9", label: "Renamed Browser" },
      });
      const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers["Octi-Device-Label"]).toBe("Renamed Browser");
      expect(headers["Octi-Device-Version"]).toBe("octi-web/9.9.9");
    });
  });
});
