/**
 * TS mirror of {@code eu.darken.octi.modules.apps.core.AppsInfo}. Wire shape
 * is kotlinx.serialization JSON; web is read-only.
 *
 * `versionCode` is Kotlin Long on the wire. TS decodes to `number`; the
 * decoder warns (but does not throw) if a value exceeds `MAX_SAFE_INTEGER`,
 * since play-store version codes are tiny in practice (≤ 7 digits typically).
 *
 * Payloads can be large — Android peers with 200+ installed packages emit
 * 50–150 KB of JSON. The dashboard pairs this decoder with an ETag cache
 * (see fetch-module.ts) to skip the parse on unchanged ticks.
 */
export const APPS_MODULE_ID = "eu.darken.octi.module.core.apps";

export interface Pkg {
  packageName: string;
  label?: string | null;
  versionCode: number;
  versionName?: string | null;
  /** ISO-8601 instant when the package was first installed. */
  installedAt: string;
  installerPkg?: string | null;
  /** ISO-8601 instant of last update, or null if never updated. */
  updatedAt?: string | null;
}

export interface AppsInfo {
  installedPackages: Pkg[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function decodePkg(raw: unknown, idx: number): Pkg {
  if (!isRecord(raw)) throw new Error(`AppsInfo.installedPackages[${idx}] not an object`);
  const packageName = raw.packageName;
  if (typeof packageName !== "string" || packageName.length === 0) {
    throw new Error(`AppsInfo.installedPackages[${idx}].packageName missing`);
  }
  const versionCodeRaw = raw.versionCode;
  if (typeof versionCodeRaw !== "number") {
    throw new Error(`AppsInfo.installedPackages[${idx}].versionCode not a number`);
  }
  if (versionCodeRaw > Number.MAX_SAFE_INTEGER) {
    console.warn(
      `AppsInfo.installedPackages[${idx}].versionCode (${versionCodeRaw}) exceeds MAX_SAFE_INTEGER for ${packageName}`,
    );
  }
  const installedAt = raw.installedAt;
  if (typeof installedAt !== "string") {
    throw new Error(`AppsInfo.installedPackages[${idx}].installedAt missing`);
  }
  return {
    packageName,
    label: raw.label == null ? null : String(raw.label),
    versionCode: versionCodeRaw,
    versionName: raw.versionName == null ? null : String(raw.versionName),
    installedAt,
    installerPkg: raw.installerPkg == null ? null : String(raw.installerPkg),
    updatedAt: raw.updatedAt == null ? null : String(raw.updatedAt),
  };
}

export function decodeAppsInfo(raw: unknown): AppsInfo {
  if (!isRecord(raw)) throw new Error("AppsInfo root is not an object");
  const arr = raw.installedPackages;
  if (!Array.isArray(arr)) {
    throw new Error("AppsInfo.installedPackages is not an array");
  }
  return { installedPackages: arr.map((p, i) => decodePkg(p, i)) };
}

/** Sort a copy of the package list by `installedAt` descending. */
export function packagesByInstalledAtDesc(info: AppsInfo): Pkg[] {
  return [...info.installedPackages].sort((a, b) => (a.installedAt < b.installedAt ? 1 : -1));
}
