/**
 * Serve the same route declarations on the backend. One handler per route, typed from the
 * route's schemas; requests are validated on the way in and responses on the way out.
 *
 * ```ts
 * import { createFetchHandler, reply } from 'endpoint-kit/server';
 *
 * const handler = createFetchHandler(routes, {
 *   getUser: async ({ params }) => db.users.find(params.id) ?? reply(404, { message: 'no' }),
 *   createUser: async ({ body }) => reply(201, await db.users.create(body)),
 * });
 *
 * // Bun / Deno / Cloudflare Workers / Next.js route handlers
 * export default { fetch: handler };
 * // Hono
 * app.all('*', (c) => handler(c.req.raw));
 * ```
 *
 * When another router already matched the request (React Router, Hono's own routes...),
 * {@link handleRoute} validates and answers one route without matching again.
 *
 * @packageDocumentation
 */
import { TaggedError, ValidationError } from '../errors.js';
import type {
  AnyRoute,
  RouteBodyOutput,
  RouteHeadersOutput,
  RouteMap,
  RouteParamsOutput,
  RouteQueryOutput,
  RouteResponseInput,
} from '../route.js';
import type { AnySchema } from '../standard-schema.js';
import type { QuerySerializerOptions } from '../url.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What a handler receives: validated input plus the raw request. */
export interface HandlerContext<R extends AnyRoute> {
  params: RouteParamsOutput<R>;
  query: RouteQueryOutput<R>;
  body: RouteBodyOutput<R>;
  /** Validated headers (schema output) when the route has a header schema, else the raw `Headers`. */
  headers: RouteHeadersOutput<R>;
  request: Request;
  /** Route name, as registered. */
  route: string;
}

/**
 * Marks replies across copies of this module (ESM and CJS builds, or several bundles), where
 * `instanceof` would fail.
 */
const REPLY = Symbol.for('endpoint-kit.reply');

/** An explicit status/body/headers answer, see {@link reply}. */
export class HttpReply {
  /** @internal */
  readonly [REPLY] = true;

  constructor(
    readonly status: number,
    readonly body?: unknown,
    readonly headers: Record<string, string> = {},
  ) {}

  /** Whether `value` is a reply, even one created by another copy of `endpoint-kit/server`. */
  static is(value: unknown): value is HttpReply {
    return typeof value === 'object' && value !== null && REPLY in value;
  }

  /** The `Response` this reply stands for: JSON unless the body is a string, Blob, stream or buffer. */
  toResponse(): Response {
    const { status, body, headers } = this;
    if (body === undefined || body === null) return new Response(null, { status, headers });
    if (
      typeof body === 'string' ||
      body instanceof Blob ||
      body instanceof ReadableStream ||
      body instanceof ArrayBuffer
    ) {
      return new Response(body, { status, headers });
    }
    return json(status, body, headers);
  }
}

/** Answer with a specific status, optional body and headers. Throwing one works too. */
export function reply(status: number, body?: unknown, headers?: Record<string, string>): HttpReply {
  return new HttpReply(status, body, headers);
}

/** What a handler may return: the response body (validated), a {@link reply}, or a raw `Response`. */
export type HandlerReturn<R extends AnyRoute> = RouteResponseInput<R> | HttpReply | Response;

export type RouteHandler<R extends AnyRoute> = (
  context: HandlerContext<R>,
) => HandlerReturn<R> | Promise<HandlerReturn<R>>;

/** One handler per route. */
export type RouteHandlers<TRoutes extends RouteMap> = {
  [K in keyof TRoutes]: RouteHandler<TRoutes[K]>;
};

export interface ServerOptions {
  /** Prefix stripped from incoming paths before matching, e.g. `'/api'`. */
  basePath?: string;
  /** Validate handler return values against the route `response` schema. Defaults to `true`. */
  validateResponse?: boolean;
  /** How query strings were serialised by clients. Defaults to `repeat` arrays and JSON objects. */
  querySerializer?: QuerySerializerOptions;
  /**
   * Retry validation with `"12"` → `12` and `"true"` → `true` coerced when the first pass
   * fails, so query/params/form schemas shared with the client (`z.number()`) just work.
   * Defaults to `true`. Turn it off when a schema must distinguish `"12"` from `12`.
   */
  coerce?: boolean;
  /**
   * Status for a thrown `TaggedError` (the classes generated from OpenAPI, or your own route
   * `errors` classes). Defaults to the error's own `status` property, else 500.
   */
  errorStatus?: (error: TaggedError) => number | undefined;
  /**
   * Turn an unexpected error (not a `HttpReply`, not validation, not a `TaggedError`) into a
   * response. Defaults to a 500 with `{ error: 'InternalServerError' }`.
   */
  onError?: (
    error: unknown,
    context: { route: string; request: Request },
  ) => Response | Promise<Response>;
}

/** A matched route. */
export interface RouteMatch<TRoutes extends RouteMap> {
  name: keyof TRoutes & string;
  route: TRoutes[keyof TRoutes];
  params: Record<string, string>;
}

/** A request another router (React Router, Hono, ...) already matched to a route. */
export interface MatchedRequest {
  request: Request;
  /** Raw path params, as the router extracted them. */
  params: Readonly<Record<string, string | undefined>>;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

interface Compiled {
  name: string;
  route: AnyRoute;
  method: string;
  regex: RegExp;
  names: string[];
}

function compile(name: string, route: AnyRoute): Compiled {
  const names: string[] = [];
  const source = route.path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        names.push(segment.slice(1));
        return '([^/]+)';
      }
      if (segment === '*') return '.*';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { name, route, method: route.method, regex: new RegExp(`^${source}/?$`), names };
}

/** Find the route matching `method` and `pathname`. `undefined` when nothing matches. */
export function matchRoute<TRoutes extends RouteMap>(
  routes: TRoutes,
  method: string,
  pathname: string,
  basePath = '',
): RouteMatch<TRoutes> | undefined {
  const path = stripBase(pathname, basePath);
  for (const [name, route] of Object.entries(routes)) {
    const compiled = compile(name, route);
    if (compiled.method !== method.toUpperCase()) continue;
    const match = compiled.regex.exec(path);
    if (!match) continue;
    const params: Record<string, string> = {};
    compiled.names.forEach((param, index) => {
      params[param] = decodeURIComponent(match[index + 1] ?? '');
    });
    return { name: name, route: route as TRoutes[keyof TRoutes], params };
  }
  return undefined;
}

function stripBase(pathname: string, basePath: string): string {
  const base = basePath.replace(/\/+$/, '');
  if (base && pathname.startsWith(base)) return pathname.slice(base.length) || '/';
  return pathname;
}

// ---------------------------------------------------------------------------
// Fetch handler
// ---------------------------------------------------------------------------

/**
 * Build a `(request: Request) => Promise<Response>` from routes and handlers. Works anywhere the
 * Fetch API does: Bun, Deno, Cloudflare Workers, Next.js route handlers, Hono (`app.all('*', ...)`).
 */
export function createFetchHandler<TRoutes extends RouteMap>(
  routes: TRoutes,
  handlers: RouteHandlers<TRoutes>,
  options: ServerOptions = {},
): (request: Request) => Promise<Response> {
  const compiled = Object.entries(routes).map(([name, route]) => compile(name, route));
  const basePath = options.basePath ?? '';

  return async (request) => {
    const url = new URL(request.url);
    const path = stripBase(url.pathname, basePath);
    const method = request.method.toUpperCase();

    let matched: { entry: Compiled; params: Record<string, string> } | undefined;
    const allowed = new Set<string>();
    for (const entry of compiled) {
      const match = entry.regex.exec(path);
      if (!match) continue;
      allowed.add(entry.method);
      if (entry.method !== method || matched) continue;
      const params: Record<string, string> = {};
      entry.names.forEach((param, index) => {
        params[param] = decodeURIComponent(match[index + 1] ?? '');
      });
      matched = { entry, params };
    }

    if (!matched) {
      if (allowed.size > 0) {
        return json(405, { error: 'MethodNotAllowed' }, { allow: [...allowed].join(', ') });
      }
      return json(404, { error: 'NotFound' });
    }

    const { entry, params } = matched;
    const handler = handlers[entry.name as keyof TRoutes] as RouteHandler<AnyRoute>;
    return handleRoute(entry.name, entry.route, handler, { request, params }, options);
  };
}

/**
 * Handle one request for a route that is already matched: validate params, query, body and
 * headers, run the handler, turn what it returns or throws into a `Response`.
 * {@link createFetchHandler} is route matching plus this; call it directly from a framework
 * that routes requests itself (React Router loaders, Hono handlers, ...).
 *
 * ```ts
 * export const loader = ({ request, params }) =>
 *   handleRoute('getUser', routes.getUser, ({ params }) => db.users.find(params.id), { request, params });
 * ```
 */
export async function handleRoute<R extends AnyRoute>(
  name: string,
  route: R,
  handler: RouteHandler<R>,
  { request, params }: MatchedRequest,
  options: ServerOptions = {},
): Promise<Response> {
  const coerce = options.coerce !== false;
  try {
    const context: HandlerContext<AnyRoute> = {
      params: await validateParams(name, route, params, coerce),
      query: (await validateLenient(
        'query',
        route.query,
        parseQuery(new URL(request.url).searchParams, options.querySerializer),
        name,
        coerce,
      )) as never,
      body: (await validateLenient(
        'body',
        route.body,
        await readBody(request),
        name,
        coerce,
      )) as never,
      headers: (isSchema(route.headers)
        ? await validateLenient(
            'headers',
            route.headers,
            Object.fromEntries(request.headers),
            name,
            coerce,
          )
        : request.headers) as never,
      request,
      route: name,
    };

    const result = await (handler as RouteHandler<AnyRoute>)(context);
    return await toResponse(result, name, route, options);
  } catch (error) {
    return errorToResponse(error, { route: name, request }, options);
  }
}

/**
 * The response for an error thrown while handling a route, as {@link createFetchHandler} sends
 * it: a thrown {@link reply} as is, a `ValidationError` as 400 (or 500 for the response), a
 * `TaggedError` with its status, anything else through `onError` or as a 500.
 */
export async function errorToResponse(
  error: unknown,
  context: { route: string; request: Request },
  options: ServerOptions = {},
): Promise<Response> {
  if (HttpReply.is(error)) return error.toResponse();
  if (isValidationError(error)) {
    const status = error.target === 'response' ? 500 : 400;
    return json(status, { error: 'ValidationError', target: error.target, issues: error.issues });
  }
  if (isTaggedError(error)) return taggedErrorResponse(error, options);
  if (options.onError) return options.onError(error, context);
  return json(500, { error: 'InternalServerError' });
}

// ---------------------------------------------------------------------------
// Hono
// ---------------------------------------------------------------------------

/** The part of a Hono app this module uses. */
export interface HonoLike {
  on(
    method: string,
    path: string,
    handler: (c: { req: { raw: Request } }) => Promise<Response>,
  ): unknown;
}

/**
 * Register one Hono route per endpoint-kit route, so Hono's router, middlewares and
 * `app.routes` see them. Equivalent to `app.all('*', (c) => handler(c.req.raw))` but explicit.
 */
export function registerHono<TRoutes extends RouteMap>(
  app: HonoLike,
  routes: TRoutes,
  handlers: RouteHandlers<TRoutes>,
  options: ServerOptions = {},
): void {
  const handler = createFetchHandler(routes, handlers, options);
  const base = (options.basePath ?? '').replace(/\/+$/, '');
  for (const route of Object.values(routes)) {
    app.on(route.method, `${base}${route.path}`, (c) => handler(c.req.raw));
  }
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

/** Parse a query string back into an object: repeated keys and `[]` become arrays, `a[b]`/`a.b` nest. */
export function parseQuery(
  search: URLSearchParams,
  options: QuerySerializerOptions = {},
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const assign = (path: string[], value: string): void => {
    let target: Record<string, unknown> = result;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i] ?? '';
      const existing = target[key];
      if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
        target[key] = {};
      }
      target = target[key] as Record<string, unknown>;
    }
    const last = path[path.length - 1] ?? '';
    const current = target[last];
    if (current === undefined) target[last] = value;
    else if (Array.isArray(current)) current.push(value);
    else target[last] = [current, value];
  };

  for (const [rawKey, value] of search) {
    let key = rawKey;
    let isArray = false;
    if (key.endsWith('[]')) {
      key = key.slice(0, -2);
      isArray = true;
    }
    const indexed = /^(.*)\[(\d+)\]$/.exec(key);
    if (indexed) {
      key = indexed[1] ?? key;
      isArray = true;
    }
    const path =
      options.objectFormat === 'dots'
        ? key.split('.')
        : key.split(/\[([^\]]*)\]/).filter((part) => part !== '');
    assign(path, value);
    if (isArray) {
      // make sure single values still end up as arrays
      let target: Record<string, unknown> = result;
      for (const part of path.slice(0, -1)) target = target[part] as Record<string, unknown>;
      const last = path[path.length - 1] ?? '';
      if (!Array.isArray(target[last])) target[last] = [target[last]];
    }
  }

  if (options.arrayFormat === 'comma') {
    for (const [key, value] of Object.entries(result)) {
      if (typeof value === 'string' && value.includes(',')) result[key] = value.split(',');
    }
  }
  return result;
}

async function readBody(request: Request): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const type = request.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    const text = await request.text();
    return text === '' ? undefined : (JSON.parse(text) as unknown);
  }
  if (type.includes('multipart/form-data') || type.includes('application/x-www-form-urlencoded')) {
    const form = await request.formData();
    const body: Record<string, unknown> = {};
    for (const [key, value] of form) {
      const current = body[key];
      if (current === undefined) body[key] = value;
      else if (Array.isArray(current)) current.push(value);
      else body[key] = [current, value];
    }
    return body;
  }
  if (type.startsWith('text/')) return request.text();
  const buffer = await request.arrayBuffer();
  return buffer.byteLength === 0 ? undefined : buffer;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

async function validateParams(
  name: string,
  route: AnyRoute,
  raw: MatchedRequest['params'],
  coerce: boolean,
): Promise<Record<string, unknown>> {
  const spec = route.params;
  if (spec === undefined) return raw;
  if (isSchema(spec)) {
    const parsed = await validateLenient('params', spec, raw, name, coerce);
    return { ...raw, ...(parsed as Record<string, unknown>) };
  }
  const result: Record<string, unknown> = { ...raw };
  for (const [key, schema] of Object.entries(spec)) {
    if (!isSchema(schema)) continue;
    result[key] = await validateLenient('params', schema, raw[key], name, coerce, key);
  }
  return result;
}

/**
 * Validate `value`; if that fails and the value came from strings (params, query, form
 * bodies), retry with numbers/booleans coerced so shared `z.number()` schemas work.
 */
async function validateLenient(
  target: 'params' | 'query' | 'body' | 'headers',
  schema: AnySchema | undefined,
  value: unknown,
  route: string,
  coerce = true,
  prefix?: string,
): Promise<unknown> {
  if (!schema) return value;
  const subject = value === undefined ? {} : value;
  const first = await schema['~standard'].validate(subject);
  if (!first.issues) return first.value;
  const coerced = coerce ? coercePrimitives(subject) : subject;
  if (coerced !== subject) {
    const second = await schema['~standard'].validate(coerced);
    if (!second.issues) return second.value;
  }
  const issues = prefix
    ? first.issues.map((issue) => ({
        message: issue.message,
        path: [prefix, ...(issue.path ?? [])],
      }))
    : first.issues;
  throw new ValidationError(target, issues, route);
}

/** `"12"` → `12`, `"true"` → `true`, recursively. Returns the same reference when nothing changed. */
export function coercePrimitives(value: unknown): unknown {
  if (typeof value === 'string') {
    if (/^-?\d+(\.\d+)?$/.test(value) && Number.isFinite(Number(value))) return Number(value);
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }
  if (Array.isArray(value)) {
    const mapped = value.map(coercePrimitives);
    return mapped.some((item, index) => item !== value[index]) ? mapped : value;
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const next = coercePrimitives(item);
      if (next !== item) changed = true;
      out[key] = next;
    }
    return changed ? out : value;
  }
  return value;
}

function isSchema(value: unknown): value is AnySchema {
  return typeof value === 'object' && value !== null && '~standard' in value;
}

/**
 * Duck-typed on purpose: the error may come from another copy of endpoint-kit (the main entry
 * next to this one, or the ESM build next to the CJS one), where `instanceof` fails.
 */
function isTaggedError(value: unknown): value is TaggedError {
  return (
    value instanceof TaggedError ||
    (value instanceof Error && typeof (value as { _tag?: unknown })._tag === 'string')
  );
}

function isValidationError(value: unknown): value is ValidationError {
  return (
    value instanceof ValidationError ||
    (isTaggedError(value) && value._tag === 'ValidationError' && 'issues' in value)
  );
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

async function toResponse(
  result: unknown,
  name: string,
  route: AnyRoute,
  options: ServerOptions,
): Promise<Response> {
  if (result instanceof Response) return result;
  if (HttpReply.is(result)) return result.toResponse();

  const schema = options.validateResponse !== false ? route.response : undefined;
  if (route.responseType === 'sse') {
    // A ready-made event stream goes out as is; an async iterable (a generator) of events is
    // encoded as SSE, each event validated on its way out.
    if (result instanceof ReadableStream)
      return new Response(result, { status: 200, headers: SSE_HEADERS });
    if (isAsyncIterable(result)) return serverSentEventsResponse(result, schema, name);
  }

  const body = await validateResponse(schema, result, name);
  switch (route.responseType) {
    case 'none':
      return new Response(null, { status: 204 });
    case 'text':
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    case 'blob':
    case 'arrayBuffer':
    case 'stream':
    case 'sse':
      return new Response(body as BodyInit, { status: 200 });
    default:
      return body === undefined ? new Response(null, { status: 204 }) : json(200, body);
  }
}

/**
 * A thrown `TaggedError` becomes `{ error: _tag, message, data? }` with its `status`
 * (or 500), so a server can throw the same error classes its clients declare in `errors`.
 */
function taggedErrorResponse(error: TaggedError, options: ServerOptions): Response {
  const own = (error as { status?: unknown }).status;
  const status = options.errorStatus?.(error) ?? (typeof own === 'number' ? own : 500);
  const data = (error as { data?: unknown }).data;
  const body: Record<string, unknown> = { error: error._tag, message: error.message };
  if (data !== undefined) body['data'] = data;
  return json(status, body);
}

async function validateResponse(
  schema: AnySchema | undefined,
  value: unknown,
  route: string,
): Promise<unknown> {
  if (!schema) return value;
  const outcome = await schema['~standard'].validate(value);
  if (outcome.issues) throw new ValidationError('response', outcome.issues, route);
  return outcome.value;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

/**
 * Stream what `events` yields as server-sent events, one JSON `data:` line per event. An
 * invalid event aborts the stream, so the client's iteration fails instead of ending quietly.
 */
function serverSentEventsResponse(
  events: AsyncIterable<unknown>,
  schema: AnySchema | undefined,
  route: string,
): Response {
  const iterator = events[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        const data = await validateResponse(schema, next.value, route);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data ?? null)}\n\n`));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
