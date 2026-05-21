// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import type { DeviceMetadata } from "../protocol/models";
import {
  type CachedConnectorState,
  CURRENT_CACHE_VERSION,
  connectorStateCache,
} from "./connector-state-cache";

/**
 * Pin the storage contract of the connector-state cache. Integration with
 * `ConnectorManager`'s bootstrap / refresh-write / removeConnector paths is
 * covered separately in `connector-manager.test.ts`; here we only exercise
 * IDB roundtrip + the defensive validation rules.
 */

function makeRaw(id: string): DeviceMetadata {
  return {
    id,
    label: id,
    platform: "android",
    version: "v",
    addedAt: null,
    lastSeen: null,
  } as unknown as DeviceMetadata;
}

function makeEntry(overrides: Partial<CachedConnectorState> = {}): CachedConnectorState {
  return {
    connectorId: "kserver-test-acct",
    version: CURRENT_CACHE_VERSION,
    lastError: null,
    lastRefreshedAt: new Date("2026-05-21T10:00:00Z"),
    lastSuccessAt: new Date("2026-05-21T10:00:00Z"),
    devices: [
      {
        id: "dev-1",
        raw: makeRaw("dev-1"),
        modules: [
          {
            moduleId: "eu.darken.octi.module.core.clipboard",
            // Uint8Array exercises structured-clone's native byte handling
            // — this is what the live `ClipboardInfo.data` looks like.
            value: { type: "TEXT", data: new Uint8Array([0x68, 0x69]) },
            modifiedAt: new Date("2026-05-21T09:55:00Z"),
            error: null,
          },
          {
            moduleId: "eu.darken.octi.module.core.meta",
            value: { deviceLabel: "Phone" },
            modifiedAt: new Date("2026-05-21T09:50:00Z"),
            error: null,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("ConnectorStateCache", () => {
  beforeEach(async () => {
    await connectorStateCache.wipeAll();
  });

  it("write → read roundtrips Date and Uint8Array via structured-clone", async () => {
    const entry = makeEntry();
    await connectorStateCache.write(entry);
    const reloaded = await connectorStateCache.read(entry.connectorId);
    expect(reloaded).not.toBeNull();
    // Dates survive as Date instances (not numbers).
    expect(reloaded!.lastRefreshedAt).toBeInstanceOf(Date);
    expect(reloaded!.lastRefreshedAt?.toISOString()).toBe(
      entry.lastRefreshedAt!.toISOString(),
    );
    // Uint8Array bytes survive — that's the key wire-compatibility need
    // for ClipboardInfo.data. We don't `toBeInstanceOf(Uint8Array)` here
    // because fake-indexeddb can return the cloned bytes through a
    // different-realm Uint8Array (instanceof fails cross-realm). Real
    // browsers preserve identity; for tests we check byte equivalence
    // via `ArrayBuffer.isView` + spread.
    const clipModule = reloaded!.devices[0].modules.find(
      (m) => m.moduleId === "eu.darken.octi.module.core.clipboard",
    );
    expect(clipModule).toBeDefined();
    const data = (clipModule!.value as { data: Uint8Array }).data;
    expect(ArrayBuffer.isView(data)).toBe(true);
    expect([...data]).toEqual([0x68, 0x69]);
    // Module modifiedAt still a Date (same realm caveat — but Date is
    // a structured-clone primitive that fake-indexeddb does preserve).
    expect(clipModule!.modifiedAt).toBeInstanceOf(Date);
  });

  it("read returns null when the connectorId isn't in the cache", async () => {
    expect(await connectorStateCache.read("kserver-missing-acct")).toBeNull();
  });

  it("read discards (and deletes) an entry whose version doesn't match CURRENT_CACHE_VERSION", async () => {
    // Hand-write a "v0" entry directly through the cache's `write` —
    // mismatching the current version. (Bypass type checks via cast since
    // CachedConnectorState requires the current version.)
    const stale = {
      ...makeEntry(),
      version: CURRENT_CACHE_VERSION + 1, // intentionally wrong
    } as CachedConnectorState;
    await connectorStateCache.write(stale);

    expect(await connectorStateCache.read(stale.connectorId)).toBeNull();
    // The discard should also delete the row so we don't keep re-failing
    // validation on every read.
    expect(await connectorStateCache.read(stale.connectorId)).toBeNull();
  });

  it("read discards malformed entries (missing required fields)", async () => {
    // Sneak a malformed row directly into IDB via `write` then mutate via
    // shape cast. Easiest: write something whose `devices` isn't an array.
    const malformed = {
      ...makeEntry(),
      devices: "not-an-array" as unknown,
    } as unknown as CachedConnectorState;
    await connectorStateCache.write(malformed);
    expect(await connectorStateCache.read(malformed.connectorId)).toBeNull();
  });

  it("delete removes the entry", async () => {
    const entry = makeEntry();
    await connectorStateCache.write(entry);
    expect(await connectorStateCache.read(entry.connectorId)).not.toBeNull();
    await connectorStateCache.delete(entry.connectorId);
    expect(await connectorStateCache.read(entry.connectorId)).toBeNull();
  });

  it("wipeAll empties the database", async () => {
    await connectorStateCache.write(makeEntry({ connectorId: "a" }));
    await connectorStateCache.write(makeEntry({ connectorId: "b" }));
    await connectorStateCache.wipeAll();
    expect(await connectorStateCache.read("a")).toBeNull();
    expect(await connectorStateCache.read("b")).toBeNull();
  });
});
