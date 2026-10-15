import type { Adapter, AdapterRequest, AdapterResponse } from './types.js';

/**
 * Structural subset of ofetch's `$fetch.raw`. Declared locally so ofetch is not a
 * dependency of this package; pass `ofetch` or an instance from `ofetch.create()`.
 */
export interface OfetchLike {
  raw(
    url: string,
    options: Record<string, unknown>,
  ): Promise<{
    status: number;
    statusText: string;
    headers: { entries(): Iterable<[string, string]> };
    _data?: unknown;
  }>;
}

/**
 * Adapter for ofetch. Route/call `options` are merged into the ofetch options.
 *
 * @example
 * ```ts
 * import { ofetch } from 'ofetch';
 * createRepository({ baseUrl, adapter: ofetchAdapter(ofetch) })
 * ```
 */
export function ofetchAdapter(instance: OfetchLike): Adapter {
  return {
    async request(request: AdapterRequest): Promise<AdapterResponse> {
      const response = await instance.raw(request.url, {
        ...request.options,
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: request.signal,
        responseType:
          request.responseType === 'none'
            ? 'text'
            : request.responseType === 'sse'
              ? 'stream'
              : request.responseType,
        ignoreResponseError: true,
      });

      return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        data: request.responseType === 'none' ? undefined : response._data,
      };
    },
  };
}
