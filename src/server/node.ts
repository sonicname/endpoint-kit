/**
 * Node.js adapter for `endpoint-kit/server`: the same routes and handlers as a
 * `(req, res, next?)` function for `http.createServer`, Express, Connect or Fastify's
 * raw hooks.
 *
 * ```ts
 * import { createNodeHandler } from 'endpoint-kit/server/node';
 *
 * const handler = createNodeHandler(routes, handlers, { basePath: '/api' });
 * http.createServer(handler).listen(3000);   // plain Node
 * app.use(handler);                           // Express: unmatched paths fall through to next()
 * ```
 *
 * @packageDocumentation
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import type { RouteMap } from '../route.js';
import { createFetchHandler, matchRoute } from './index.js';
import type { RouteHandlers, ServerOptions } from './index.js';

export interface NodeServerOptions extends ServerOptions {
  /** Trust `x-forwarded-proto` / `x-forwarded-host` when rebuilding the request URL. */
  trustProxy?: boolean;
}

/** Express/Connect style `next` callback. */
export type NextFunction = (error?: unknown) => void;

/**
 * Build a Node request listener. When `next` is given and no route matches the path at all,
 * `next()` is called so other middleware can answer; otherwise the handler answers 404/405.
 */
export function createNodeHandler<TRoutes extends RouteMap>(
  routes: TRoutes,
  handlers: RouteHandlers<TRoutes>,
  options: NodeServerOptions = {},
): (req: IncomingMessage, res: ServerResponse, next?: NextFunction) => Promise<void> {
  const fetchHandler = createFetchHandler(routes, handlers, options);
  const basePath = options.basePath ?? '';

  return async (req, res, next) => {
    const request = toRequest(req, options.trustProxy === true);
    const pathname = new URL(request.url).pathname;

    if (next && !anyMethodMatches(routes, pathname, basePath)) {
      next();
      return;
    }

    try {
      const response = await fetchHandler(request);
      await writeResponse(response, res);
    } catch (error) {
      if (next) {
        next(error);
        return;
      }
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'InternalServerError' }));
    }
  };
}

/** Convert a Node request into a Fetch `Request`. Bodies are streamed, not buffered. */
export function toRequest(req: IncomingMessage, trustProxy = false): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  const forwardedProto = trustProxy
    ? headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
    : undefined;
  const forwardedHost = trustProxy
    ? headers.get('x-forwarded-host')?.split(',')[0]?.trim()
    : undefined;
  const encrypted = (req.socket as { encrypted?: boolean }).encrypted === true;
  const protocol = forwardedProto ?? (encrypted ? 'https' : 'http');
  const host = forwardedHost ?? headers.get('host') ?? 'localhost';
  const url = `${protocol}://${host}${req.url ?? '/'}`;

  const method = (req.method ?? 'GET').toUpperCase();
  const init: RequestInit & { duplex?: 'half' } = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

/** Write a Fetch `Response` to a Node response, streaming the body. */
export async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  const cookies = response.headers.getSetCookie();
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') headers[key] = value;
  });
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  res.writeHead(response.status, response.statusText, headers);

  if (!response.body) {
    res.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = Readable.fromWeb(response.body as unknown as NodeReadableStream);
    stream.on('error', reject);
    res.on('error', reject);
    res.on('finish', resolve);
    stream.pipe(res);
  });
}

function anyMethodMatches(routes: RouteMap, pathname: string, basePath: string): boolean {
  for (const route of Object.values(routes)) {
    if (matchRoute({ only: route }, route.method, pathname, basePath)) return true;
  }
  return false;
}
