/**
 * TS mirror of {@code eu.darken.octi.modules.wifi.core.WifiInfo}. Wire shape
 * is kotlinx.serialization JSON; web is read-only (browsers don't surface
 * Wi-Fi signal info).
 *
 * `freqType` wire values verified against WifiInfo.kt: the literal strings
 * include a dot — `"2.4GHZ"` (NOT `"2_4GHZ"`). The Kotlin enum constant is
 * `TWO_POINT_FOUR_GHZ` but the `@SerialName` is `"2.4GHZ"`.
 */
export const WIFI_MODULE_ID = "eu.darken.octi.module.core.wifi";

export type WifiFreqType = "UNKNOWN" | "5GHZ" | "2.4GHZ";
const WIFI_FREQ_TYPES: ReadonlySet<WifiFreqType> = new Set([
  "UNKNOWN",
  "5GHZ",
  "2.4GHZ",
]);

export interface CurrentWifi {
  /** SSID as Android reports it. Android wraps in double quotes; we keep them. */
  ssid?: string | null;
  /** Normalised 0..1 reception strength (NOT dBm). */
  reception?: number | null;
  freqType?: WifiFreqType | null;
}

export interface WifiInfo {
  currentWifi: CurrentWifi | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function decodeCurrentWifi(raw: unknown): CurrentWifi {
  if (!isRecord(raw)) throw new Error("WifiInfo.currentWifi is not an object");
  let freqType: WifiFreqType | null = null;
  if (raw.freqType != null) {
    const v = String(raw.freqType);
    if (!WIFI_FREQ_TYPES.has(v as WifiFreqType)) {
      throw new Error(`WifiInfo.currentWifi.freqType invalid: ${v}`);
    }
    freqType = v as WifiFreqType;
  }
  return {
    ssid: raw.ssid == null ? null : String(raw.ssid),
    reception: raw.reception == null ? null : Number(raw.reception),
    freqType,
  };
}

export function decodeWifiInfo(raw: unknown): WifiInfo {
  if (!isRecord(raw)) throw new Error("WifiInfo root is not an object");
  return {
    currentWifi: raw.currentWifi == null ? null : decodeCurrentWifi(raw.currentWifi),
  };
}

/** Human label for reception 0..1. Mirrors Android's tile text bucketing. */
export function receptionLabel(reception: number | null | undefined): string {
  if (reception == null || !Number.isFinite(reception) || reception <= 0) return "N/A";
  if (reception > 0.65) return "Good reception";
  if (reception > 0.3) return "Okay reception";
  return "Bad reception";
}

/** 0..4 bar count from a 0..1 reception value. */
export function receptionBars(reception: number | null | undefined): number {
  if (reception == null || !Number.isFinite(reception) || reception <= 0) return 0;
  if (reception > 0.75) return 4;
  if (reception > 0.5) return 3;
  if (reception > 0.25) return 2;
  return 1;
}
