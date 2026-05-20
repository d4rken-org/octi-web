// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import { CredentialsRepo, type CredentialRecord } from "./credentials-repo";
import {
  __setOwnDeviceIdForTest,
  getOwnDeviceId,
  wipeOwnDeviceId,
} from "./identity-settings";
import { OCTI_WEB_CHANNEL } from "../version";

const STORAGE_KEY = `octi-web.${OCTI_WEB_CHANNEL}.own-device-id`;

function makeRecord(overrides: Partial<CredentialRecord> = {}): CredentialRecord {
  const accountId = overrides.accountId ?? "acct-1";
  const serverAddress = overrides.serverAddress ?? {
    domain: "sync.test",
    protocol: "https" as const,
    port: 443,
  };
  return {
    connectorId: `kserver-${serverAddress.domain}-${accountId}`,
    connectorType: "kserver",
    accountId,
    devicePassword: "pwd",
    ownDeviceId: "legacy-uuid-from-record",
    deviceLabel: "Browser",
    serverAddress,
    encryptionKeyset: new Uint8Array([1, 2, 3]),
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("IdentitySettings.getOwnDeviceId", () => {
  beforeEach(async () => {
    __setOwnDeviceIdForTest(null);
    localStorage.clear();
    await new CredentialsRepo().wipeAll();
  });

  it("returns the localStorage value when one is already set", async () => {
    localStorage.setItem(STORAGE_KEY, "preset-uuid");
    const id = await getOwnDeviceId();
    expect(id).toBe("preset-uuid");
  });

  it("memoizes after the first read", async () => {
    localStorage.setItem(STORAGE_KEY, "first-read");
    const a = await getOwnDeviceId();
    // Mutate localStorage out-of-band; in-module cache should still win.
    localStorage.setItem(STORAGE_KEY, "mutated-out-of-band");
    const b = await getOwnDeviceId();
    expect(b).toBe(a);
  });

  it("seeds from the earliest existing credential's ownDeviceId", async () => {
    const repo = new CredentialsRepo();
    await repo.save(
      makeRecord({ accountId: "newer", ownDeviceId: "newer-uuid", createdAt: 2_000 }),
    );
    await repo.save(
      makeRecord({ accountId: "older", ownDeviceId: "older-uuid", createdAt: 1_000 }),
    );
    const id = await getOwnDeviceId();
    expect(id).toBe("older-uuid");
    // And persisted to localStorage so subsequent reads short-circuit.
    expect(localStorage.getItem(STORAGE_KEY)).toBe("older-uuid");
  });

  it("generates a fresh UUID when no credentials exist", async () => {
    const id = await getOwnDeviceId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(id);
  });

  it("does NOT re-seed if localStorage is already set, even when credentials exist", async () => {
    // Pre-set localStorage to one value AND seed an existing credential with a
    // different ownDeviceId. The localStorage value must win — seeding only
    // happens when localStorage is empty.
    localStorage.setItem(STORAGE_KEY, "wins-because-already-set");
    const repo = new CredentialsRepo();
    await repo.save(makeRecord({ ownDeviceId: "would-have-been-seeded" }));
    const id = await getOwnDeviceId();
    expect(id).toBe("wins-because-already-set");
  });

  it("concurrent cold callers resolve to the same UUID (single-flight)", async () => {
    // Two parallel awaits with no prior init must both see the same value
    // — otherwise a fresh install with two tabs racing could end up with
    // different ownDeviceIds in localStorage on each tab.
    const [a, b, c] = await Promise.all([
      getOwnDeviceId(),
      getOwnDeviceId(),
      getOwnDeviceId(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(a);
  });

  it("wipeOwnDeviceId clears localStorage and the cache, allowing re-init", async () => {
    localStorage.setItem(STORAGE_KEY, "old");
    const first = await getOwnDeviceId();
    expect(first).toBe("old");

    wipeOwnDeviceId();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    // Next read generates a fresh UUID (no credentials, no localStorage).
    const second = await getOwnDeviceId();
    expect(second).not.toBe("old");
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
  });
});
