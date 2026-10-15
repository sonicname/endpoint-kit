/**
 * Test helpers: a scripted adapter so tests exercise validation, params, middlewares and
 * custom errors without touching the network.
 *
 * ```ts
 * import { mockAdapter } from 'endpoint-kit/testing';
 *
 * const adapter = mockAdapter({
 *   'GET /users/octocat': () => ({ id: 1, login: 'octocat' }),
 *   'GET /users/nobody': () => ({ status: 404, data: { message: 'Not Found' } }),
 * });
 * const api = createRepository({ baseUrl: 'https://api.test', adapter, retry: false }).mergeAll(routes).build();
 * ```
 *
 * @packageDocumentation
 */
import type { Adapter, AdapterRequest, AdapterResponse } from './adapters/types.js';

/**
 * What a handler returns: a response object (any subset of `status`, `statusText`, `headers`,
 * `data`, with `status` defaulting to 200) or just the body.
 */
export type MockReply = unknown;

/** Answers one request. May be async. */
export type MockHandler = (request: AdapterRequest, match: MockMatch) => MockReply;

/** What matched: the pattern and the values of its `:param` segments. */
export interface MockMatch {
  pattern: string;
  params: Record<string, string>;
}

/**
 * Handlers keyed by `"METHOD /path"`. Paths may contain `:param` segments and a trailing
 * `*` wildcard; `"* /path"` matches any method and `"*"` matches everything.
 */
export type MockHandlers = Record<string, MockHandler>;

export interface MockAdapter extends Adapter {
  /** Every request received, in order. */
  readonly calls: AdapterRequest[];
  /** The last request received, if any. */
  readonly last: AdapterRequest | undefined;
  /** Forget recorded calls. */
  reset(): void;
  /** Add or replace handlers after creation. */
  use(handlers: MockHandlers): void;
}

/** Create an adapter that answers from `handlers` and records what it was asked. */
export function mockAdapter(handlers: MockHandlers = {}): MockAdapter {
  const table = new Map<string, { method: string; matcher: PathMatcher; handler: MockHandler }>();
  const calls: AdapterRequest[] = [];

  const use = (more: MockHandlers): void => {
    for (const [key, handler] of Object.entries(more)) {
      const [method, pattern] = splitKey(key);
      table.set(key, { method, matcher: compilePath(pattern), handler });
    }
  };
  use(handlers);

  return {
    calls,
    get last() {
      return calls[calls.length - 1];
    },
    reset() {
      calls.length = 0;
    },
    use,
    async request(request) {
      calls.push(request);
      const pathname = new URL(request.url).pathname;
      for (const [pattern, entry] of table) {
        if (entry.method !== '*' && entry.method !== request.method) continue;
        const params = entry.matcher(pathname);
        if (!params) continue;
        return toResponse(await entry.handler(request, { pattern, params }));
      }
      return { status: 404, statusText: 'Not Found', headers: {}, data: null };
    },
  };
}

/** Normalise a handler's return value into an adapter response. */
export function toResponse(reply: MockReply): AdapterResponse {
  const defaults: AdapterResponse = { status: 200, statusText: '', headers: {}, data: null };
  if (isResponseShape(reply)) return { ...defaults, ...reply };
  return { ...defaults, data: reply };
}

const RESPONSE_KEYS = new Set(['status', 'statusText', 'headers', 'data']);

/** A plain object whose keys are all response fields is a response, not a body. */
function isResponseShape(reply: unknown): reply is Partial<AdapterResponse> {
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) return false;
  const keys = Object.keys(reply);
  return keys.length > 0 && keys.every((key) => RESPONSE_KEYS.has(key));
}

type PathMatcher = (pathname: string) => Record<string, string> | undefined;

function splitKey(key: string): [method: string, pattern: string] {
  if (key === '*') return ['*', '*'];
  const space = key.indexOf(' ');
  if (space === -1) return ['*', key];
  return [key.slice(0, space).toUpperCase(), key.slice(space + 1).trim()];
}

function compilePath(pattern: string): PathMatcher {
  if (pattern === '*') return () => ({});
  const names: string[] = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment === '*') return '.*';
      if (segment.startsWith(':')) {
        names.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  const regex = new RegExp(`^${source}/?$`);
  return (pathname) => {
    const match = regex.exec(pathname);
    if (!match) return undefined;
    const params: Record<string, string> = {};
    names.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1] ?? '');
    });
    return params;
  };
}
