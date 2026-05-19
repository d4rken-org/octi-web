/**
 * End-to-end smoke test against a real `octi-server`. Verifies the protocol
 * layer the mocked tests can't: real route names, status codes, CORS handling
 * (when run from a browser context — not exercised by Node fetch), encrypted
 * module roundtrip on the wire.
 *
 * Skipped by default. To run locally:
 *
 *   docker run --rm -p 18080:8080 \
 *     -e OCTI_CORS_ALLOWED_ORIGINS=http://127.0.0.1 \
 *     ghcr.io/d4rken-org/octi-server:latest
 *   SMOKE_SERVER_URL=http://127.0.0.1:18080 pnpm test:smoke
 *
 * Excluded from the default `pnpm test` via `vitest.config.ts` (`__smoke__/**`
 * exclude pattern). The CI smoke job invokes it explicitly.
 */
import { describe, expect, it } from "vitest";
import { buildAssociatedData, createPayloadEncryption } from "../crypto/payload";
import { generateAesGcmSivKeyset } from "../crypto/tink-keyset";
import {
  createOrJoinAccount,
  listDevices,
  readModulePayload,
  writeModulePayload,
} from "../protocol/octi-api";
import type { ServerAddress } from "../protocol/models";

function parseServerUrl(raw: string): ServerAddress {
  const u = new URL(raw);
  return {
    domain: u.hostname,
    protocol: u.protocol.replace(":", "") as "http" | "https",
    port: u.port ? Number.parseInt(u.port, 10) : u.protocol === "https:" ? 443 : 80,
  };
}

const META_MODULE_ID = "eu.darken.octi.module.core.meta";

describe("smoke: protocol round-trip against a real sync-server", () => {
  const url = process.env.SMOKE_SERVER_URL;
  if (!url) {
    it.skip("SMOKE_SERVER_URL not set — skipping", () => {});
    return;
  }
  const server = parseServerUrl(url);
  const deviceId = crypto.randomUUID();
  const deviceTag = { version: "octi-web/smoke", label: "smoke-runner" };

  it("creates an account, publishes encrypted meta, lists devices, reads meta back", async () => {
    // 1. Create a fresh account.
    const acct = await createOrJoinAccount({ server, deviceId, deviceTag });
    expect(acct.account).toMatch(/^[0-9a-f-]{36}$/i);
    expect(acct.password.length).toBeGreaterThan(20);

    const creds = {
      accountId: acct.account,
      devicePassword: acct.password,
      deviceId,
    };

    // 2. List devices — should contain exactly ourselves.
    const devices = await listDevices({ server, creds });
    expect(devices).toHaveLength(1);
    expect(devices[0].id).toBe(deviceId);
    expect(devices[0].platform).toBe("web");
    expect(devices[0].label).toBe("smoke-runner");

    // 3. Generate a Tink keyset (the account-wide encryption key on a real
    //    install comes from the linking flow; for the smoke test we mint a
    //    standalone keyset).
    const { bytes: keysetBytes } = generateAesGcmSivKeyset();
    const crypti = createPayloadEncryption(keysetBytes);

    // 4. Encrypt a meta payload and publish it as ourselves.
    const ad = buildAssociatedData(deviceId, META_MODULE_ID);
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ deviceLabel: "smoke-runner", smoke: true }),
    );
    const ciphertext = crypti.encrypt(plaintext, ad);
    await writeModulePayload({
      server,
      creds,
      targetDeviceId: deviceId,
      moduleId: META_MODULE_ID,
      ciphertext,
    });

    // 5. Read it back and verify roundtrip via the same crypti instance.
    const back = await readModulePayload({
      server,
      creds,
      targetDeviceId: deviceId,
      moduleId: META_MODULE_ID,
    });
    expect(back).not.toBeNull();
    const decrypted = crypti.decrypt(back!, ad);
    expect(new TextDecoder().decode(decrypted)).toBe(new TextDecoder().decode(plaintext));
  });
});
