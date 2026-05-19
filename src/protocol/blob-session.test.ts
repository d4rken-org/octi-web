import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAddress } from "./models";
import {
  appendBlobSession as realAppend,
  createBlobSession as realCreate,
  finalizeBlobSession as realFinalize,
  uploadBlobBytes as realUpload,
  BLOB_PATCH_CHUNK_SIZE as REAL_CHUNK,
} from "./blob-session";

const server: ServerAddress = { domain: "sync.test", protocol: "https", port: 443 };
const creds = {
  accountId: "a",
  devicePassword: "p",
  deviceId: "self-dev",
};
const VERSION = "octi-web/test";

function patchResponse(newOffset: number | null): Response {
  return new Response(null, {
    status: 204,
    headers: newOffset == null ? {} : { "Upload-Offset": String(newOffset) },
  });
}

describe("blob-session", () => {
  // Replace globalThis.fetch with a vi.fn — see octi-api.test.ts for rationale.
  const originalFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("createBlobSession", () => {
    it("POSTs sizeBytes + optional hash to /v1/module/.../blob-sessions and returns parsed body", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            blobId: "blob-1",
            sessionId: "sess-1",
            offsetBytes: 0,
            expiresAt: "2099-01-01T00:00:00Z",
            state: "open",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      const session = await realCreate({
        server,
        creds,
        version: VERSION,
        targetDeviceId: "self-dev",
        moduleId: "mod.files",
        sizeBytes: 100,
        hashAlgorithm: "sha256",
        hashHex: "abc123",
      });
      expect(session.blobId).toBe("blob-1");
      expect(session.offsetBytes).toBe(0);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(
        "https://sync.test:443/v1/module/mod.files/blob-sessions?device-id=self-dev",
      );
      expect(init?.method).toBe("POST");
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({ sizeBytes: 100, hashAlgorithm: "sha256", hashHex: "abc123" });
    });
  });

  describe("appendBlobSession", () => {
    it("PATCHes with Upload-Offset and returns the server-reported new offset", async () => {
      fetchSpy.mockResolvedValueOnce(patchResponse(64));
      const next = await realAppend({
        server,
        creds,
        version: VERSION,
        targetDeviceId: "self-dev",
        moduleId: "mod.files",
        sessionId: "sess-1",
        offset: 0,
        chunk: new Uint8Array(64),
      });
      expect(next).toBe(64);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(
        "https://sync.test:443/v1/module/mod.files/blob-sessions/sess-1?device-id=self-dev",
      );
      expect(init?.method).toBe("PATCH");
      const headers = init?.headers as Record<string, string>;
      expect(headers["Upload-Offset"]).toBe("0");
    });

    it("throws when server returns no Upload-Offset header", async () => {
      fetchSpy.mockResolvedValueOnce(patchResponse(null));
      await expect(
        realAppend({
          server,
          creds,
          version: VERSION,
          targetDeviceId: "self-dev",
          moduleId: "mod.files",
          sessionId: "sess-1",
          offset: 0,
          chunk: new Uint8Array(64),
        }),
      ).rejects.toThrow(/did not return Upload-Offset/);
    });

    it("throws when Upload-Offset is unparseable", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(null, { status: 204, headers: { "Upload-Offset": "abc" } }),
      );
      await expect(
        realAppend({
          server,
          creds,
          version: VERSION,
          targetDeviceId: "self-dev",
          moduleId: "mod.files",
          sessionId: "sess-1",
          offset: 0,
          chunk: new Uint8Array(64),
        }),
      ).rejects.toThrow(/invalid Upload-Offset/);
    });
  });

  describe("uploadBlobBytes (full lifecycle)", () => {
    it("happy path single-chunk: create → patch → finalize → returns blobId", async () => {
      const ciphertext = new Uint8Array(500);
      // 1) create
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            blobId: "B",
            sessionId: "S",
            offsetBytes: 0,
            expiresAt: "x",
            state: "open",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      // 2) patch advancing to full ciphertext length
      fetchSpy.mockResolvedValueOnce(patchResponse(500));
      // 3) finalize
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ blobId: "B", sessionId: "S", sizeBytes: 500, state: "finalized" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      const blobId = await realUpload({
        server,
        creds,
        version: VERSION,
        targetDeviceId: "self-dev",
        moduleId: "mod.files",
        ciphertext,
      });
      expect(blobId).toBe("B");
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it("multi-chunk: 2 MiB ciphertext → 2 PATCH calls with monotonic offsets", async () => {
      const ciphertext = new Uint8Array(REAL_CHUNK * 2);
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ blobId: "B", sessionId: "S", offsetBytes: 0, expiresAt: "x", state: "open" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      fetchSpy.mockResolvedValueOnce(patchResponse(REAL_CHUNK));
      fetchSpy.mockResolvedValueOnce(patchResponse(REAL_CHUNK * 2));
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ blobId: "B", sessionId: "S", sizeBytes: REAL_CHUNK * 2, state: "finalized" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      await realUpload({
        server,
        creds,
        version: VERSION,
        targetDeviceId: "self-dev",
        moduleId: "mod.files",
        ciphertext,
      });
      // Inspect the Upload-Offset header on each PATCH.
      const patchCalls = fetchSpy.mock.calls.filter((c) => (c[1]?.method as string) === "PATCH");
      expect(patchCalls).toHaveLength(2);
      expect((patchCalls[0][1]!.headers as Record<string, string>)["Upload-Offset"]).toBe("0");
      expect((patchCalls[1][1]!.headers as Record<string, string>)["Upload-Offset"]).toBe(
        String(REAL_CHUNK),
      );
    });

    it("resumes from non-zero createBlobSession.offsetBytes (server already has a prefix)", async () => {
      const ciphertext = new Uint8Array(1000);
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            blobId: "B",
            sessionId: "S",
            offsetBytes: 400, // server already has bytes 0..399
            expiresAt: "x",
            state: "open",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      fetchSpy.mockResolvedValueOnce(patchResponse(1000));
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ blobId: "B", sessionId: "S", sizeBytes: 1000, state: "finalized" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      await realUpload({
        server,
        creds,
        version: VERSION,
        targetDeviceId: "self-dev",
        moduleId: "mod.files",
        ciphertext,
      });
      const patchCalls = fetchSpy.mock.calls.filter((c) => (c[1]?.method as string) === "PATCH");
      expect(patchCalls).toHaveLength(1);
      // First (only) PATCH must resume at the server-reported prefix length.
      expect((patchCalls[0][1]!.headers as Record<string, string>)["Upload-Offset"]).toBe("400");
    });

    it("rejects an initial offset past the ciphertext length", async () => {
      const ciphertext = new Uint8Array(100);
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            blobId: "B",
            sessionId: "S",
            offsetBytes: 200, // server thinks we already uploaded more bytes than we have
            expiresAt: "x",
            state: "open",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      // Abort on cleanup is best-effort and swallowed; just supply a response.
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(
        realUpload({
          server,
          creds,
          version: VERSION,
          targetDeviceId: "self-dev",
          moduleId: "mod.files",
          ciphertext,
        }),
      ).rejects.toThrow(/invalid initial offset/);
    });

    it("rejects when the server reports the same offset twice (would infinite-loop otherwise)", async () => {
      const ciphertext = new Uint8Array(1000);
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ blobId: "B", sessionId: "S", offsetBytes: 0, expiresAt: "x", state: "open" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      // First PATCH returns offset=0 again — no progress.
      fetchSpy.mockResolvedValueOnce(patchResponse(0));
      // Abort cleanup best-effort.
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(
        realUpload({
          server,
          creds,
          version: VERSION,
          targetDeviceId: "self-dev",
          moduleId: "mod.files",
          ciphertext,
        }),
      ).rejects.toThrow(/non-progressing offset/);
    });

    it("rejects when the server reports an offset past the ciphertext length", async () => {
      const ciphertext = new Uint8Array(1000);
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ blobId: "B", sessionId: "S", offsetBytes: 0, expiresAt: "x", state: "open" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      fetchSpy.mockResolvedValueOnce(patchResponse(1500));
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(
        realUpload({
          server,
          creds,
          version: VERSION,
          targetDeviceId: "self-dev",
          moduleId: "mod.files",
          ciphertext,
        }),
      ).rejects.toThrow(/past ciphertext length/);
    });
  });

  describe("finalizeBlobSession", () => {
    it("POSTs to /finalize and returns parsed FinalizeSessionResponse", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ blobId: "B", sessionId: "S", sizeBytes: 10, state: "finalized" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      const out = await realFinalize({
        server,
        creds,
        version: VERSION,
        targetDeviceId: "peer-1",
        moduleId: "mod.files",
        sessionId: "S",
        hashAlgorithm: "sha256",
        hashHex: "deadbeef",
      });
      expect(out.state).toBe("finalized");
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe(
        "https://sync.test:443/v1/module/mod.files/blob-sessions/S/finalize?device-id=peer-1",
      );
    });
  });
});
