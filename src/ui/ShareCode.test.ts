// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OctiServerConnector } from "../protocol/octi-server-connector";
import type { DeviceMetadata } from "../protocol/models";
import ShareCode from "./ShareCode.svelte";

vi.mock("../linking/qr", () => ({
  renderQrPng: vi.fn(async () => "data:image/png;base64,qr"),
}));

function device(id: string): DeviceMetadata {
  return {
    id,
    version: null,
    platform: null,
    label: null,
    addedAt: null,
    lastSeen: null,
  };
}

function fakeConnector(args: {
  listDevices: () => Promise<DeviceMetadata[]>;
  createShareCode: () => Promise<{ code: string }>;
}): OctiServerConnector {
  return {
    connectorId: "kserver-sync.test-acct-1",
    ownDeviceId: "own",
    record: {
      connectorId: "kserver-sync.test-acct-1",
      connectorType: "kserver",
      accountId: "acct-1",
      devicePassword: "pwd-1",
      ownDeviceId: "own",
      deviceLabel: "Browser",
      serverAddress: { domain: "sync.test", protocol: "https", port: 443 },
      encryptionKeyset: new Uint8Array([1, 2, 3]),
      createdAt: 0,
      updatedAt: 0,
    },
    createShareCode: args.createShareCode,
    listDevices: args.listDevices,
  } as unknown as OctiServerConnector;
}

function buttonByText(target: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(target.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button "${text}" not found`);
  }
  return button;
}

async function flushSvelteWork(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await tick();
  }
}

describe("ShareCode", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("calls onDeviceLinked after a minted code is consumed by another device", async () => {
    vi.useFakeTimers();
    const target = document.createElement("div");
    document.body.appendChild(target);

    const listDevices = vi
      .fn<() => Promise<DeviceMetadata[]>>()
      .mockResolvedValueOnce([device("own")])
      .mockResolvedValueOnce([device("own"), device("peer")]);
    const createShareCode = vi.fn(async () => ({ code: "share-code" }));
    const onDeviceLinked = vi.fn();
    const connector = fakeConnector({ listDevices, createShareCode });

    const component = mount(ShareCode, {
      target,
      props: {
        connector,
        onDeviceLinked,
      },
    });

    try {
      buttonByText(target, "Mint share code").click();
      await flushSvelteWork();

      expect(createShareCode).toHaveBeenCalledTimes(1);
      expect(listDevices).toHaveBeenCalledTimes(1);
      expect(target.textContent).toContain("Copy to clipboard");
      expect(onDeviceLinked).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3_000);
      await tick();

      expect(listDevices).toHaveBeenCalledTimes(2);
      expect(onDeviceLinked).toHaveBeenCalledTimes(1);
    } finally {
      unmount(component);
    }
  });
});
