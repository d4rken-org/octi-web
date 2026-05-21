// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import type { SharedFile } from "../modules/files";
import {
  fileShareRetryQueue,
  MAX_ATTEMPTS,
  PENDING_TTL_MS,
  QUEUE_CAP,
} from "./fileshare-retry-queue";

/**
 * Pin the storage contract of the file-share retry queue. The orchestrator
 * (ConnectorManager) treats the queue as a pure persistence layer; these
 * tests exercise only the IDB roundtrip + cap / pruning rules — drain logic
 * has its own tests under `connector-manager.test.ts`.
 */

function makeSharedFile(overrides: Partial<SharedFile> = {}): SharedFile {
  const now = new Date();
  return {
    name: "x.bin",
    mimeType: "application/octet-stream",
    size: 3,
    blobKey: "sha256:abc",
    checksum: "abc",
    sharedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
    availableOn: ["connA", "connB"],
    connectorRefs: { connA: "blobA", connB: "blobB" },
    ...overrides,
  };
}

describe("FileShareRetryQueue", () => {
  beforeEach(async () => {
    await fileShareRetryQueue.wipeAll();
  });

  it("enqueue → list roundtrips the entry shape", async () => {
    const shared = makeSharedFile();
    const { entry, evicted } = await fileShareRetryQueue.enqueue({
      shared,
      pendingConnectorIds: ["connB"],
    });
    expect(evicted).toEqual([]);
    expect(entry.id).toMatch(/[a-f0-9-]{36}/); // UUID v4-ish
    expect(entry.attempts).toBe(0);
    expect(entry.lastAttemptAt).toBeNull();
    expect(entry.pendingConnectorIds).toEqual(["connB"]);
    expect(entry.shared.blobKey).toBe(shared.blobKey);

    const list = await fileShareRetryQueue.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(entry.id);
  });

  it("update writes back the modified entry", async () => {
    const { entry } = await fileShareRetryQueue.enqueue({
      shared: makeSharedFile(),
      pendingConnectorIds: ["connB", "connC"],
    });
    await fileShareRetryQueue.update({
      ...entry,
      attempts: 2,
      lastAttemptAt: Date.now(),
      pendingConnectorIds: ["connC"],
    });
    const [reloaded] = await fileShareRetryQueue.list();
    expect(reloaded.attempts).toBe(2);
    expect(reloaded.pendingConnectorIds).toEqual(["connC"]);
    expect(reloaded.lastAttemptAt).not.toBeNull();
  });

  it("delete removes the entry; list() reflects it", async () => {
    const { entry } = await fileShareRetryQueue.enqueue({
      shared: makeSharedFile(),
      pendingConnectorIds: ["connB"],
    });
    await fileShareRetryQueue.delete(entry.id);
    expect(await fileShareRetryQueue.list()).toEqual([]);
  });

  describe("pruneConnector", () => {
    it("strips connectorId from each entry's pendingConnectorIds; deletes entries that go empty", async () => {
      // Entry A: pendingConnectorIds=[B,C] — pruning B leaves [C], should update
      const { entry: aEntry } = await fileShareRetryQueue.enqueue({
        shared: makeSharedFile({ blobKey: "sha256:A" }),
        pendingConnectorIds: ["connB", "connC"],
      });
      // Entry B: pendingConnectorIds=[B] — pruning B leaves [], should delete
      await fileShareRetryQueue.enqueue({
        shared: makeSharedFile({ blobKey: "sha256:B" }),
        pendingConnectorIds: ["connB"],
      });
      // Entry C: pendingConnectorIds=[D] — pruning B is a no-op
      const { entry: cEntry } = await fileShareRetryQueue.enqueue({
        shared: makeSharedFile({ blobKey: "sha256:C" }),
        pendingConnectorIds: ["connD"],
      });

      const result = await fileShareRetryQueue.pruneConnector("connB");
      expect(result).toEqual({ deleted: 1, updated: 1 });

      const remaining = await fileShareRetryQueue.list();
      expect(remaining).toHaveLength(2);
      const byKey = new Map(remaining.map((r) => [r.shared.blobKey, r]));
      expect(byKey.get("sha256:A")?.pendingConnectorIds).toEqual(["connC"]);
      expect(byKey.get("sha256:C")?.pendingConnectorIds).toEqual(["connD"]);
      // Entry B was deleted entirely.
      expect(byKey.has("sha256:B")).toBe(false);
      // Ids unchanged for survivors.
      expect(byKey.get("sha256:A")?.id).toBe(aEntry.id);
      expect(byKey.get("sha256:C")?.id).toBe(cEntry.id);
    });

    it("is a no-op when the connectorId isn't referenced anywhere", async () => {
      await fileShareRetryQueue.enqueue({
        shared: makeSharedFile(),
        pendingConnectorIds: ["connB"],
      });
      const result = await fileShareRetryQueue.pruneConnector("connNOPE");
      expect(result).toEqual({ deleted: 0, updated: 0 });
      expect(await fileShareRetryQueue.list()).toHaveLength(1);
    });
  });

  describe("cap overflow", () => {
    it("evicts the oldest entries (by createdAt) when enqueue would exceed QUEUE_CAP", async () => {
      // Fill to cap. We tweak createdAt directly via `update()` to control
      // ordering since enqueue uses Date.now() which can collide at fine
      // resolution.
      const ids: string[] = [];
      for (let i = 0; i < QUEUE_CAP; i++) {
        const { entry } = await fileShareRetryQueue.enqueue({
          shared: makeSharedFile({ blobKey: `sha256:cap-${i}` }),
          pendingConnectorIds: ["connB"],
        });
        await fileShareRetryQueue.update({ ...entry, createdAt: 1000 + i });
        ids.push(entry.id);
      }

      // Sanity: at cap.
      expect((await fileShareRetryQueue.list()).length).toBe(QUEUE_CAP);

      // Adding one more must evict the oldest (id=ids[0], createdAt=1000).
      const { evicted } = await fileShareRetryQueue.enqueue({
        shared: makeSharedFile({ blobKey: "sha256:newest" }),
        pendingConnectorIds: ["connB"],
      });
      expect(evicted).toHaveLength(1);
      expect(evicted[0].id).toBe(ids[0]);

      const survivors = await fileShareRetryQueue.list();
      expect(survivors.length).toBe(QUEUE_CAP);
      // The evicted id is gone.
      expect(survivors.some((s) => s.id === ids[0])).toBe(false);
      // The newest is present.
      expect(survivors.some((s) => s.shared.blobKey === "sha256:newest")).toBe(true);
    });
  });

  it("wipeAll empties the store", async () => {
    await fileShareRetryQueue.enqueue({
      shared: makeSharedFile(),
      pendingConnectorIds: ["connB"],
    });
    await fileShareRetryQueue.wipeAll();
    expect(await fileShareRetryQueue.list()).toEqual([]);
  });

  it("exports the documented constants", () => {
    // Pinned so any future tuning is a deliberate, reviewable change.
    expect(PENDING_TTL_MS).toBe(8 * 60_000);
    expect(MAX_ATTEMPTS).toBe(5);
    expect(QUEUE_CAP).toBe(100);
  });
});
