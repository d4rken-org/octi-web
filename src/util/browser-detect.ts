/**
 * Tiny UA introspection used to fill in `MetaInfo.deviceManufacturer`,
 * `deviceName`, `osType`, and `osVersionName` when publishing this device's
 * MetaInfo. Deliberately small — anything fancier loses to whatever fresh UA
 * spoofing the browser ecosystem does next month.
 *
 * Uses {@code navigator.userAgentData} (Chromium-only, structured, accurate)
 * when present, falls back to a couple of regexes over {@code navigator.userAgent}.
 * Unknowns return undefined rather than fake placeholders so phone-side UI can
 * render them as "?".
 */

export interface BrowserInfo {
  /** Vendor of the browser ("Mozilla", "Apple", "Google", "Microsoft", "Other"). */
  manufacturer: string;
  /** Human name like "Firefox 134" or "Safari 18". */
  deviceName: string;
  /** Lowercased token matching MetaInfo conventions ("linux", "windows", "macos", "ios", "android", "chromeos", "other"). */
  osType: string;
  /** OS version when we can extract one (best-effort). */
  osVersionName: string | undefined;
}

interface UADataMaybe {
  brands?: { brand: string; version: string }[];
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{ platformVersion?: string }>;
}

export async function detectBrowserInfo(): Promise<BrowserInfo> {
  const ua = navigator.userAgent;
  const uad = (navigator as unknown as { userAgentData?: UADataMaybe }).userAgentData;

  const { name: browserName, version: browserVersion } = detectBrowser(ua, uad);
  const osType = detectOsType(ua, uad);
  const osVersionName = await detectOsVersion(ua, uad);

  return {
    manufacturer: manufacturerOf(browserName),
    deviceName: browserVersion ? `${browserName} ${browserVersion}` : browserName,
    osType,
    osVersionName,
  };
}

function detectBrowser(ua: string, uad: UADataMaybe | undefined): { name: string; version: string | undefined } {
  // userAgentData.brands is a list with intentional decoy entries to discourage
  // sniffing; the "real" brand is the one that isn't "Not"...A;Brand"-shaped.
  if (uad?.brands && uad.brands.length > 0) {
    const real = uad.brands.find((b) => !/Not.?A.?Brand|Brand/i.test(b.brand));
    if (real) return { name: real.brand, version: real.version };
  }
  // Firefox is unambiguous — its UA has "Firefox/<ver>" and nothing else claims it.
  const fx = /Firefox\/(\d+\.\d+)/.exec(ua);
  if (fx) return { name: "Firefox", version: fx[1] };
  // Edge identifies as Edg/ in Chromium-era UAs.
  const edge = /Edg\/(\d+\.\d+)/.exec(ua);
  if (edge) return { name: "Edge", version: edge[1] };
  // Chrome before Safari because Chrome UA also contains "Safari".
  const chrome = /Chrome\/(\d+\.\d+)/.exec(ua);
  if (chrome) return { name: "Chrome", version: chrome[1] };
  const safari = /Version\/(\d+\.\d+).*Safari/.exec(ua);
  if (safari) return { name: "Safari", version: safari[1] };
  return { name: "Browser", version: undefined };
}

function detectOsType(ua: string, uad: UADataMaybe | undefined): string {
  const p = uad?.platform?.toLowerCase();
  if (p) {
    if (p.includes("android")) return "android";
    if (p.includes("chrome os") || p.includes("chromeos")) return "chromeos";
    if (p.includes("ios")) return "ios";
    if (p === "macos" || p === "mac os") return "macos";
    if (p === "windows") return "windows";
    if (p === "linux") return "linux";
  }
  // Order matters: iPad/iPhone before macOS (recent iPads spoof Mac), Android
  // before Linux (Android UAs include "Linux"), ChromeOS before Linux.
  if (/Android/.test(ua)) return "android";
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/CrOS/.test(ua)) return "chromeos";
  if (/Mac OS X|Macintosh/.test(ua)) return "macos";
  if (/Windows NT/.test(ua)) return "windows";
  if (/Linux/.test(ua)) return "linux";
  return "other";
}

async function detectOsVersion(ua: string, uad: UADataMaybe | undefined): Promise<string | undefined> {
  if (uad?.getHighEntropyValues) {
    try {
      const hi = await uad.getHighEntropyValues(["platformVersion"]);
      if (hi.platformVersion) return hi.platformVersion;
    } catch {
      // Some browsers reject the call entirely; fall through to UA regex.
    }
  }
  const win = /Windows NT (\d+\.\d+)/.exec(ua);
  if (win) return win[1];
  const mac = /Mac OS X (\d+[._]\d+(?:[._]\d+)?)/.exec(ua);
  if (mac) return mac[1].replace(/_/g, ".");
  const android = /Android (\d+(?:\.\d+)*)/.exec(ua);
  if (android) return android[1];
  const ios = /OS (\d+[._]\d+(?:[._]\d+)?) like Mac OS X/.exec(ua);
  if (ios) return ios[1].replace(/_/g, ".");
  return undefined;
}

function manufacturerOf(browserName: string): string {
  switch (browserName) {
    case "Firefox":
      return "Mozilla";
    case "Safari":
      return "Apple";
    case "Chrome":
    case "Chromium":
      return "Google";
    case "Edge":
      return "Microsoft";
    default:
      return browserName;
  }
}
