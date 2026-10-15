import type { AdapterRequest, AdapterResponse, HttpMethod } from '../adapters/types.js';
import type { Middleware } from './types.js';

/** What the cache stores for one key. */
export interface CacheEntry {
  response: AdapterResponse;
  /** Epoch milliseconds after which the entry is stale. */
  expiresAt: number;
  tags: readonly string[];
}

/** Pluggable backing store. Methods may be sync or async. */
export interface CacheStorage {
  get(key: string): CacheEntry | undefined | Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): void | Promise<void>;
  delete(key: string): void | Promise<void>;
  clear(): void | Promise<void>;
  /** Remove every entry carrying at least one of `tags`. */
  invalidateTags(tags: readonly string[]): void | Promise<void>;
}

/** In-memory `Map` based storage, the default. */
export class MemoryCacheStorage implements CacheStorage {
  readonly #entries = new Map<string, CacheEntry>();

  get(key: string): CacheEntry | undefined {
    const entry = this.#entries.get(key);
    if (entry && entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, entry: CacheEntry): void {
    this.#entries.set(key, entry);
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  invalidateTags(tags: readonly string[]): void {
    for (const [key, entry] of this.#entries) {
      if (entry.tags.some((tag) => tags.includes(tag))) this.#entries.delete(key);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** Cache configuration for a repository, a route or a single call. */
export interface CacheOptions {
  /** Time to live in ms. Nothing is cached when missing or `<= 0`. */
  ttl?: number;
  /** Tags used for invalidation, see `invalidates` on routes and `client.$cache.invalidate()`. */
  tags?: readonly string[];
  /** Methods eligible for caching. Defaults to `GET, HEAD`. */
  methods?: readonly HttpMethod[];
  /** Request header names whose values become part of the cache key. */
  vary?: readonly string[];
  /** Custom key builder, overrides `vary`. */
  key?: (request: AdapterRequest) => string;
}

/** Shared cache state of one client, exposed as `client.$cache`. */
export interface CacheController {
  readonly storage: CacheStorage;
  /** Requests currently in flight, keyed like the cache. Used to deduplicate. */
  readonly inflight: Map<string, Promise<AdapterResponse>>;
  /** Drop every entry tagged with any of `tags`. */
  invalidate(...tags: string[]): Promise<void>;
  /** Drop one entry by key. */
  delete(key: string): Promise<void>;
  /** Drop everything. */
  clear(): Promise<void>;
}

export function createCacheController(
  storage: CacheStorage = new MemoryCacheStorage(),
): CacheController {
  return {
    storage,
    inflight: new Map(),
    async invalidate(...tags) {
      if (tags.length > 0) await storage.invalidateTags(tags);
    },
    async delete(key) {
      await storage.delete(key);
    },
    async clear() {
      await storage.clear();
    },
  };
}

/** Default cache key: method, url and the values of `vary` headers. */
export function defaultCacheKey(request: AdapterRequest, vary: readonly string[] = []): string {
  const parts = [request.method, request.url];
  for (const name of vary) {
    const value = findHeader(request.headers, name);
    parts.push(`${name.toLowerCase()}=${value ?? ''}`);
  }
  return parts.join(' ');
}

const CACHE_DEFAULT_METHODS: readonly HttpMethod[] = ['GET', 'HEAD'];

/**
 * Serve successful responses from `controller.storage` for `ttl` ms and deduplicate
 * concurrent identical requests. Place it outside retry and timeout.
 */
export function cacheMiddleware(
  controller: CacheController,
  options: CacheOptions,
  isSuccess: (status: number) => boolean,
): Middleware {
  const ttl = options.ttl ?? 0;
  const methods = options.methods ?? CACHE_DEFAULT_METHODS;
  const tags = options.tags ?? [];
  const keyOf =
    options.key ?? ((request: AdapterRequest) => defaultCacheKey(request, options.vary));

  return async (request, next) => {
    if (ttl <= 0 || !methods.includes(request.method)) return next(request);
    // A stream can only be consumed once; never cache it.
    if (request.responseType === 'stream' || request.responseType === 'sse') return next(request);

    const key = keyOf(request);
    const hit = await controller.storage.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.response;

    const pending = controller.inflight.get(key);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const response = await next(request);
        if (isSuccess(response.status)) {
          await controller.storage.set(key, { response, expiresAt: Date.now() + ttl, tags });
        }
        return response;
      } finally {
        controller.inflight.delete(key);
      }
    })();
    controller.inflight.set(key, promise);
    return promise;
  };
}

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}
