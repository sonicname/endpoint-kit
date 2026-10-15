import type { Adapter, AdapterRequest, AdapterResponse } from './types.js';
import { isJsonBody } from './types.js';

/** Options for {@link fetchAdapter}. */
export interface FetchAdapterOptions {
  /** Custom fetch implementation, defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Default `RequestInit` merged into every request (e.g. `credentials: 'include'`). */
  init?: Omit<RequestInit, 'method' | 'headers' | 'body' | 'signal'>;
}

/**
 * Adapter built on the Fetch API. This is the default adapter of a repository.
 * Route/call `options` are merged into `RequestInit`.
 */
export function fetchAdapter(adapterOptions: FetchAdapterOptions = {}): Adapter {
  const doFetch = adapterOptions.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new TypeError('fetchAdapter: no fetch implementation available');
  }

  return {
    async request(request: AdapterRequest): Promise<AdapterResponse> {
      const headers = { ...request.headers };
      let body: BodyInit | undefined;

      if (request.body !== undefined && request.body !== null) {
        if (isJsonBody(request.body)) {
          body = JSON.stringify(request.body);
          if (!hasHeader(headers, 'content-type')) {
            headers['content-type'] = 'application/json';
          }
        } else {
          body = request.body as BodyInit;
        }
      }

      const init: RequestInit = {
        ...adapterOptions.init,
        ...(request.options as RequestInit | undefined),
        method: request.method,
        headers,
        signal: request.signal ?? null,
      };
      if (body !== undefined) init.body = body;

      const response = await doFetch(request.url, init);

      return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        data: await parseBody(response, request.responseType),
      };
    },
  };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

async function parseBody(
  response: Response,
  responseType: AdapterRequest['responseType'],
): Promise<unknown> {
  if (responseType === 'none' || response.status === 204) return undefined;
  switch (responseType) {
    case 'text':
      return response.text();
    case 'blob':
      return response.blob();
    case 'arrayBuffer':
      return response.arrayBuffer();
    case 'stream':
    case 'sse':
      return (
        response.body ??
        new ReadableStream<Uint8Array>({
          start: (c) => {
            c.close();
          },
        })
      );
    case 'json': {
      const text = await response.text();
      if (text === '') return undefined;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    }
  }
}
