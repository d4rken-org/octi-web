import { buildAssociatedData, type PayloadEncryption } from "../crypto/payload";
import { type AuthCreds, readModulePayloadWithEtag } from "../protocol/octi-api";
import type { ServerAddress } from "../protocol/models";

/**
 * Generic module-payload fetcher used by the registry-driven dashboard refresh.
 *
 * - Fetches the encrypted module payload via the existing octi-api wrapper.
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

export function cacheKey(deviceId: string, moduleId: string): string {
  return `${deviceId}:${moduleId}`;
}

export interface FetchPeerModuleResult<I> {
  /** Decoded payload, or `null` if peer hasn't published this module yet. */
  value: I | null;
  /** Server-supplied ETag, or `null` if the payload is empty. */
  etag: string | null;
  /** True when the result was reused from the in-memory cache (matched ETag). */
  cached: boolean;
}

export async function fetchPeerModule<I>(args: {
  server: ServerAddress;
  creds: AuthCreds;
  crypti: PayloadEncryption;
  peerDeviceId: string;
  moduleId: string;
  decode: (json: unknown) => I;
  cache?: EtagCache<I>;
}): Promise<FetchPeerModuleResult<I>> {
  const result = await readModulePayloadWithEtag({
    server: args.server,
    creds: args.creds,
    targetDeviceId: args.peerDeviceId,
    moduleId: args.moduleId,
  });
  if (!result) return { value: null, etag: null, cached: false };

  const { bytes, etag } = result;
  const key = cacheKey(args.peerDeviceId, args.moduleId);

  if (etag && args.cache) {
    const cached = args.cache.get(key);
    if (cached && cached.etag === etag) {
      return { value: cached.value, etag, cached: true };
    }
  }

  const ad = buildAssociatedData(args.peerDeviceId, args.moduleId);
  const plaintext = args.crypti.decrypt(bytes, ad);
  const json: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  const value = args.decode(json);

  if (etag && args.cache) {
    args.cache.set(key, { etag, value });
  }
  return { value, etag, cached: false };
}
