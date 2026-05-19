import { describe, expect, it, vi } from "vitest";
import { decodeAppsInfo, packagesByInstalledAtDesc } from "./apps";

describe("AppsInfo decoder", () => {
  it("decodes a single-package payload", () => {
    const info = decodeAppsInfo({
      installedPackages: [
        {
          packageName: "com.example.app",
          label: "Example",
          versionCode: 42,
          versionName: "1.2.3",
          installedAt: "2026-01-15T10:30:00Z",
          installerPkg: "com.android.vending",
          updatedAt: "2026-05-01T14:00:00Z",
        },
      ],
    });
    expect(info.installedPackages).toHaveLength(1);
    expect(info.installedPackages[0]).toMatchObject({
      packageName: "com.example.app",
      versionCode: 42,
    });
  });

  it("accepts an empty package list", () => {
    expect(decodeAppsInfo({ installedPackages: [] }).installedPackages).toEqual([]);
  });

  it("rejects missing required packageName / installedAt / versionCode", () => {
    expect(() =>
      decodeAppsInfo({ installedPackages: [{ versionCode: 1, installedAt: "x" }] }),
    ).toThrow(/packageName/);
    expect(() =>
      decodeAppsInfo({ installedPackages: [{ packageName: "x", versionCode: 1 }] }),
    ).toThrow(/installedAt/);
    expect(() =>
      decodeAppsInfo({ installedPackages: [{ packageName: "x", installedAt: "x" }] }),
    ).toThrow(/versionCode/);
  });

  it("warns (but does not throw) on a versionCode above MAX_SAFE_INTEGER", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const info = decodeAppsInfo({
        installedPackages: [
          {
            packageName: "com.big",
            versionCode: Number.MAX_SAFE_INTEGER + 100,
            installedAt: "2026-01-01T00:00:00Z",
          },
        ],
      });
      expect(info.installedPackages[0].packageName).toBe("com.big");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("ignores unknown extra keys on a package", () => {
    const info = decodeAppsInfo({
      installedPackages: [
        {
          packageName: "com.a",
          versionCode: 1,
          installedAt: "2026-01-01T00:00:00Z",
          mysteryFutureField: { foo: "bar" },
        },
      ],
      otherTopLevel: 99,
    });
    expect(info.installedPackages[0].packageName).toBe("com.a");
  });

  it("packagesByInstalledAtDesc sorts newest first without mutating input", () => {
    const info = decodeAppsInfo({
      installedPackages: [
        { packageName: "old", versionCode: 1, installedAt: "2024-01-01T00:00:00Z" },
        { packageName: "new", versionCode: 1, installedAt: "2026-05-01T00:00:00Z" },
        { packageName: "mid", versionCode: 1, installedAt: "2025-06-01T00:00:00Z" },
      ],
    });
    const sorted = packagesByInstalledAtDesc(info);
    expect(sorted.map((p) => p.packageName)).toEqual(["new", "mid", "old"]);
    expect(info.installedPackages[0].packageName).toBe("old");
  });
});
