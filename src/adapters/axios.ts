import { toStringValue } from '../url.js';
import type { Adapter, AdapterRequest, AdapterResponse } from './types.js';

/**
 * Structural subset of an axios instance. Declared locally so axios is not a
 * dependency of this package; pass your real `axios` instance.
 */
export interface AxiosLike {
  request(config: Record<string, unknown>): Promise<{
    status: number;
    statusText?: string;
    headers?: unknown;
    data: unknown;
  }>;
}

/**
 * Adapter for axios. Route/call `options` are merged into the axios request config.
 *
 * @example
 * ```ts
 * import axios from 'axios';
 * createRepository({ baseUrl, adapter: axiosAdapter(axios.create()) })
 * ```
 */
export function axiosAdapter(instance: AxiosLike): Adapter {
  return {
    async request(request: AdapterRequest): Promise<AdapterResponse> {
      const response = await instance.request({
        ...request.options,
        url: request.url,
        method: request.method,
        headers: request.headers,
        data: request.body,
        signal: request.signal,
        responseType: toAxiosResponseType(request.responseType),
        // Let the repository decide what a failed status is.
        validateStatus: () => true,
      });

      return {
        status: response.status,
        statusText: response.statusText ?? '',
        headers: normaliseHeaders(response.headers),
        data: request.responseType === 'none' ? undefined : response.data,
      };
    },
  };
}

function toAxiosResponseType(type: AdapterRequest['responseType']): string {
  switch (type) {
    case 'arrayBuffer':
      return 'arraybuffer';
    case 'none':
      return 'text';
    case 'sse':
      return 'stream'; // Node only: browser axios cannot stream, use fetchAdapter there
    default:
      return type;
  }
}

function normaliseHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== 'object') return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    result[key.toLowerCase()] = Array.isArray(value)
      ? value.map(toStringValue).join(', ')
      : toStringValue(value);
  }
  return result;
}
