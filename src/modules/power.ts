/**
 * TS mirror of {@code eu.darken.octi.modules.power.core.PowerInfo}. Wire shape
 * is kotlinx.serialization JSON.
 *
 * Field-name caveats verified against PowerInfo.kt + the cross-repo
 * `feedback_wire_field_names` memory:
 * - `ChargeIO.currentAvg` (wire) ↔ Kotlin property `currenAvg` (typo). The
 *   wire name carries `@SerialName("currentAvg")`, so the wire is correct;
 *   only the JVM property name is misspelled. Web uses the wire form.
 * - `Battery.scale` can be `-1` from Android fallbacks. UI rendering must
 *   guard divide-by-zero — see {@link batteryPercent}.
 *
 * Web does not publish PowerInfo (browsers have no reliable battery / charge
 * APIs across vendors). Decoder is read-only for Android/desktop peers.
 */
export const POWER_MODULE_ID = "eu.darken.octi.module.core.power";

export type PowerStatus = "FULL" | "CHARGING" | "DISCHARGING" | "UNKNOWN";
const POWER_STATUSES: ReadonlySet<PowerStatus> = new Set([
  "FULL",
  "CHARGING",
  "DISCHARGING",
  "UNKNOWN",
]);

export interface Battery {
  level: number;
  scale: number;
  health?: number | null;
  /** Temperature in °C as reported by the device sensor. */
  temp?: number | null;
}

export interface ChargeIO {
  /** Instantaneous current in µA (Android units); positive = charging in. */
  currentNow?: number | null;
  /** Moving average of `currentNow`. Same units. */
  currentAvg?: number | null;
  /** ISO-8601 instant since which the battery has reported FULL. */
  fullSince?: string | null;
  /** ISO-8601 instant at which the device estimates a full charge. */
  fullAt?: string | null;
  /** ISO-8601 instant at which the device estimates depletion. */
  emptyAt?: string | null;
}

export interface PowerInfo {
  status: PowerStatus;
  battery: Battery;
  chargeIO: ChargeIO;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function decodeBattery(raw: unknown): Battery {
  if (!isRecord(raw)) throw new Error("PowerInfo.battery is not an object");
  const level = raw.level;
  const scale = raw.scale;
  if (typeof level !== "number") throw new Error("PowerInfo.battery.level not a number");
  if (typeof scale !== "number") throw new Error("PowerInfo.battery.scale not a number");
  return {
    level,
    scale,
    health: raw.health == null ? null : Number(raw.health),
    temp: raw.temp == null ? null : Number(raw.temp),
  };
}

function decodeChargeIO(raw: unknown): ChargeIO {
  if (!isRecord(raw)) throw new Error("PowerInfo.chargeIO is not an object");
  return {
    currentNow: raw.currentNow == null ? null : Number(raw.currentNow),
    currentAvg: raw.currentAvg == null ? null : Number(raw.currentAvg),
    fullSince: raw.fullSince == null ? null : String(raw.fullSince),
    fullAt: raw.fullAt == null ? null : String(raw.fullAt),
    emptyAt: raw.emptyAt == null ? null : String(raw.emptyAt),
  };
}

export function decodePowerInfo(raw: unknown): PowerInfo {
  if (!isRecord(raw)) throw new Error("PowerInfo root is not an object");
  const status = raw.status;
  if (typeof status !== "string" || !POWER_STATUSES.has(status as PowerStatus)) {
    throw new Error(`PowerInfo.status invalid: ${String(status)}`);
  }
  return {
    status: status as PowerStatus,
    battery: decodeBattery(raw.battery),
    chargeIO: decodeChargeIO(raw.chargeIO),
  };
}

/**
 * Percent of full charge as 0..100, rounded. Returns null if `scale <= 0`
 * (Android falls back to `-1` when the OS doesn't report a valid scale).
 */
export function batteryPercent(b: Battery): number | null {
  if (!Number.isFinite(b.level) || !Number.isFinite(b.scale) || b.scale <= 0) return null;
  return Math.round((b.level / b.scale) * 100);
}
