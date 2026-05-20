import { buildAssociatedData, type PayloadEncryption } from "../crypto/payload";
import type { OctiServerConnector } from "../protocol/octi-server-connector";

/**
 * Generic module-payload fetcher used by the registry-driven dashboard refresh.
 *
 * - Fetches the encrypted module payload via the supplied connector.
 * - Decrypts with the per-account payload cipher and runs the supplied `decode`.
 * - Holds the last (etag, decoded) pair per (deviceId, moduleId) so polls that
 *   return the same etag can skip the JSON.parse + decode work. Bandwidth still
 *   crosses the wire because the sync-server's GET /v1/module/{id} doesn't
 *   honor `If-None-Match` (see ModuleRoute.readModule) — the win is CPU on
 *   large payloads like AppsInfo (~100 KB).
 *
 * The cache lives in the caller's `EtagCache` instance so a refresh's snapshot
 * of decoded values can be re-used between ticks while still being cleared on
 * sign-out / account switch by dropping the cache.
 */

export interface CacheEntry<I> {
  etag: string;
  value: I;
  /**
   * Server-side modification timestamp parsed from the {@code X-Modified-At}
   * header. Preserved through cache hits so the multi-connector merge can
   * still order ETag-cached results correctly. {@code null} when the server
   * didn't provide it (older sync-server).
   */
  modifiedAt: Date | null;
}

export interface EtagCache<I = unknown> {
  get(key: string): CacheEntry<I> | undefined;
  set(key: string, entry: CacheEntry<I>): void;
  clear(): void;
}

export function createEtagCache<I = unknown>(): EtagCache<I> {
  const m = new Map<string, CacheEntry<I>>();
  return {
    get: (k) => m.get(k),
    set: (k, v) => {
      m.set(k, v);
    },
    clear: () => m.clear(),
  };
}

/**
 * Cache key includes `connectorId` so a future multi-connector dashboard
 * doesn't reuse decoded data across connectors that happen to share a
 * `deviceId`. Cheap to do now while there's still only one connector.
 */
export function cacheKey(connectorId: string, deviceId: string, moduleId: string): string {
  return `${connectorId}:${deviceId}:${moduleId}`;
}

export interface FetchPeerModuleResult<I> {
  /** Decoded payload, or `null` if peer hasn't published this module yet. */
  value: I | null;
  /** Server-supplied ETag, or `null` if the payload is empty. */
  etag: string | null;
  /**
   * Server-side modification timestamp (parsed from `X-Modified-At`), or
   * `null` if the server didn't provide it. The cross-connector merge orders
   * by this value; absent → treat as oldest.
   */
  modifiedAt: Date | null;
  /** True when the result was reused from the in-memory cache (matched ETag). */
  cached: boolean;
}

export async function fetchPeerModule<I>(args: {
  connector: OctiServerConnector;
  crypti: PayloadEncryption;
  peerDeviceId: string;
  moduleId: string;
  decode: (json: unknown) => I;
  cache?: EtagCache<I>;
}): Promise<FetchPeerModuleResult<I>> {
  const result = await args.connector.readModulePayloadWithEtag({
    targetDeviceId: args.peerDeviceId,
    moduleId: args.moduleId,
  });
  if (!result) return { value: null, etag: null, modifiedAt: null, cached: false };

  const { bytes, etag, modifiedAt } = result;
  const key = cacheKey(args.connector.connectorId, args.peerDeviceId, args.moduleId);

  if (etag && args.cache) {
    const cached = args.cache.get(key);
    if (cached && cached.etag === etag) {
      // Use the *fresh* modifiedAt over the cached one. Servers may update the
      // X-Modified-At semantics (e.g. after a CORS expose-header fix) while
      // the ETag stays stable, and a cached `null` would otherwise stick
      // forever. Only fall back to cached when the fresh value is missing.
      const effectiveModifiedAt = modifiedAt ?? cached.modifiedAt;
      if (effectiveModifiedAt !== cached.modifiedAt) {
        args.cache.set(key, { etag, value: cached.value, modifiedAt: effectiveModifiedAt });
      }
      return { value: cached.value, etag, modifiedAt: effectiveModifiedAt, cached: true };
    }
  }

  const ad = buildAssociatedData(args.peerDeviceId, args.moduleId);
  const plaintext = args.crypti.decrypt(bytes, ad);
  const json: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  const value = args.decode(json);

  if (etag && args.cache) {
    args.cache.set(key, { etag, value, modifiedAt });
  }
  return { value, etag, modifiedAt, cached: false };
}
