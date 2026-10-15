/** HTTP methods supported by routes. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/**
 * How the response body should be parsed. `stream` hands back a `ReadableStream<Uint8Array>`,
 * `sse` parses `text/event-stream` into an async iterable of events.
 */
export type ResponseType = 'json' | 'text' | 'blob' | 'arrayBuffer' | 'none' | 'stream' | 'sse';

/** Normalised request handed to an adapter. */
export interface AdapterRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  /** Already serialised body (string, FormData, Blob, ...) or a plain object to JSON-encode. */
  body?: unknown;
  responseType: ResponseType;
  signal?: AbortSignal | undefined;
  /** Adapter specific options forwarded verbatim (axios config, ofetch options, RequestInit...). */
  options?: Record<string, unknown> | undefined;
}

/** Normalised response returned by an adapter. Adapters must not throw on non-2xx status. */
export interface AdapterResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: unknown;
}

/** Transport used by a repository to perform HTTP requests. */
export interface Adapter {
  request(request: AdapterRequest): Promise<AdapterResponse>;
}

/** Returns `true` for plain objects and arrays that should be JSON encoded. */
export function isJsonBody(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false;
  if (Array.isArray(body)) return true;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return false;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return false;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return false;
  if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return false;
  if (ArrayBuffer.isView(body)) return false;
  const proto: unknown = Object.getPrototypeOf(body);
  return proto === Object.prototype || proto === null;
}
