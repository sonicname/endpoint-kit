import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import {
  TaggedError,
  ValidationError,
  createRepository,
  createRoute,
  fetchAdapter,
  groupRoutes,
} from '../src/index.js';
import {
  HttpReply,
  coercePrimitives,
  createFetchHandler,
  errorToResponse,
  handleRoute,
  matchRoute,
  parseQuery,
  registerHono,
  reply,
} from '../src/server/index.js';
import type { HandlerContext } from '../src/server/index.js';

const user = z.object({ id: z.number(), name: z.string() });

const routes = {
  getUser: createRoute.get('/users/:id', {
    params: { id: z.coerce.number().int() },
    response: user,
  }),
  listUsers: createRoute.get('/users', {
    query: z.object({ limit: z.number().max(10).default(5), tags: z.array(z.string()).optional() }),
    response: z.array(user),
  }),
  createUser: createRoute.post('/users', {
    body: z.object({ name: z.string().min(1) }),
    response: user,
  }),
  deleteUser: createRoute.delete('/users/:id', { responseType: 'none' }),
  motd: createRoute.get('/motd', { responseType: 'text' }),
  upload: createRoute.post('/upload', {
    bodyType: 'multipart',
    body: z.object({ file: z.instanceof(File), title: z.string() }),
  }),
  ...groupRoutes('/orgs/:org', {
    listRepos: createRoute.get('/repos', { response: z.array(z.string()) }),
  }),
};

const db = new Map<number, { id: number; name: string }>([[1, { id: 1, name: 'Ann' }]]);

const handler = createFetchHandler(routes, {
  getUser: ({ params }) => {
    expectTypeOf(params).toEqualTypeOf<{ id: number }>();
    return db.get(params.id) ?? reply(404, { message: `user ${String(params.id)} not found` });
  },
  listUsers: ({ query }) => {
    expectTypeOf(query).toEqualTypeOf<{ limit: number; tags?: string[] | undefined }>();
    return [...db.values()].slice(0, query.limit);
  },
  createUser: ({ body }) => {
    expectTypeOf(body).toEqualTypeOf<{ name: string }>();
    const created = { id: db.size + 1, name: body.name };
    db.set(created.id, created);
    return reply(201, created, { location: `/users/${String(created.id)}` });
  },
  deleteUser: ({ params }) => {
    expectTypeOf(params).toEqualTypeOf<{ id: string }>();
    db.delete(Number(params.id));
    return undefined;
  },
  motd: () => 'hello',
  upload: ({ body }) => reply(200, { name: body.file.name, title: body.title }),
  listRepos: ({ params }) => {
    expectTypeOf(params).toEqualTypeOf<{ org: string }>();
    return [`${params.org}/web`];
  },
});

const req = (method: string, path: string, init: RequestInit = {}) =>
  handler(new Request(`https://api.test${path}`, { method, ...init }));
const jsonReq = (method: string, path: string, body: unknown) =>
  req(method, path, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

describe('createFetchHandler', () => {
  it('validates params (with coercion) and serialises the validated response', async () => {
    const res = await req('GET', '/users/1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ id: 1, name: 'Ann' });

    const missing = await req('GET', '/users/99');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: 'user 99 not found' });

    const bad = await req('GET', '/users/abc');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'ValidationError', target: 'params' });
  });

  it('parses and coerces the query, applying schema defaults', async () => {
    const res = await req('GET', '/users?tags=a&tags=b');
    expect(await res.json()).toEqual([{ id: 1, name: 'Ann' }]);

    const tooMany = await req('GET', '/users?limit=50');
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toMatchObject({ target: 'query' });
  });

  it('reads JSON bodies, supports reply() with status and headers', async () => {
    const res = await jsonReq('POST', '/users', { name: 'Bob' });
    expect(res.status).toBe(201);
    expect(res.headers.get('location')).toBe('/users/2');
    expect(await res.json()).toEqual({ id: 2, name: 'Bob' });

    const invalid = await jsonReq('POST', '/users', { name: '' });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ target: 'body' });
  });

  it('handles none, text and multipart routes', async () => {
    const gone = await req('DELETE', '/users/2');
    expect(gone.status).toBe(204);

    const text = await req('GET', '/motd');
    expect(text.headers.get('content-type')).toContain('text/plain');
    expect(await text.text()).toBe('hello');

    const form = new FormData();
    form.append('file', new File(['x'], 'a.txt'));
    form.append('title', 't');
    const uploaded = await req('POST', '/upload', { body: form });
    expect(await uploaded.json()).toEqual({ name: 'a.txt', title: 't' });
  });

  it('answers 404 / 405 and strips basePath; group prefixes carry params', async () => {
    expect((await req('GET', '/nope')).status).toBe(404);
    const wrongMethod = await req('PATCH', '/users');
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET, POST');

    const prefixed = createFetchHandler(routes, {} as never, { basePath: '/api' });
    expect((await prefixed(new Request('https://x/api/nope'))).status).toBe(404);

    const repos = await req('GET', '/orgs/acme/repos');
    expect(await repos.json()).toEqual(['acme/web']);
  });

  it('turns a bad handler response into 500 and routes unknown errors to onError', async () => {
    const broken = createFetchHandler(
      {
        motd: createRoute.get('/m', { response: z.object({ a: z.number() }) }),
        boom: createRoute.get('/b'),
      },
      { motd: () => ({ a: 'nope' }) as never, boom: () => Promise.reject(new Error('kaboom')) },
      { onError: (error) => new Response((error as Error).message, { status: 503 }) },
    );
    const res = await broken(new Request('https://x/m'));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'ValidationError', target: 'response' });

    const err = await broken(new Request('https://x/b'));
    expect(err.status).toBe(503);
    expect(await err.text()).toBe('kaboom');
  });

  it('works end to end with the client talking to the handler through fetch', async () => {
    const api = createRepository({
      baseUrl: 'https://api.test',
      adapter: fetchAdapter({ fetch: (input, init) => handler(new Request(input, init)) }),
    })
      .mergeAll(routes)
      .build();

    const { data, error } = await api.getUser({ params: { id: 1 } });
    expect(error).toBeNull();
    expect(data).toEqual({ id: 1, name: 'Ann' });

    const notFound = await api.getUser({ params: { id: 42 } });
    expect(notFound.error?._tag).toBe('ApiError');
  });

  it('exposes a typed context', () => {
    type Ctx = HandlerContext<typeof routes.createUser>;
    expectTypeOf<Ctx['body']>().toEqualTypeOf<{ name: string }>();
    expectTypeOf<Ctx['query']>().toEqualTypeOf<undefined>();
    expectTypeOf<Ctx['headers']>().toEqualTypeOf<Headers>();
  });
});

describe('matchRoute / parseQuery / coercePrimitives', () => {
  it('matches routes', () => {
    expect(matchRoute(routes, 'get', '/users/7')).toMatchObject({
      name: 'getUser',
      params: { id: '7' },
    });
    expect(matchRoute(routes, 'GET', '/api/users/7', '/api')?.name).toBe('getUser');
    expect(matchRoute(routes, 'POST', '/users/7')).toBeUndefined();
  });

  it('parses repeat, brackets, indices, nested and comma formats', () => {
    expect(parseQuery(new URLSearchParams('a=1&a=2&b=x'))).toEqual({ a: ['1', '2'], b: 'x' });
    expect(parseQuery(new URLSearchParams('a[]=1&b[c]=2&b[d][]=3'))).toEqual({
      a: ['1'],
      b: { c: '2', d: ['3'] },
    });
    expect(parseQuery(new URLSearchParams('a[0]=x&a[1]=y'))).toEqual({ a: ['x', 'y'] });
    expect(parseQuery(new URLSearchParams('a.b=1'), { objectFormat: 'dots' })).toEqual({
      a: { b: '1' },
    });
    expect(parseQuery(new URLSearchParams('ids=1,2'), { arrayFormat: 'comma' })).toEqual({
      ids: ['1', '2'],
    });
  });

  it('coerces numbers and booleans, leaving everything else untouched', () => {
    const input = { a: '1', b: ['true', 'x'], c: { d: '2.5' }, e: 'abc', f: null };
    expect(coercePrimitives(input)).toEqual({
      a: 1,
      b: [true, 'x'],
      c: { d: 2.5 },
      e: 'abc',
      f: null,
    });
    const same = { e: 'abc' };
    expect(coercePrimitives(same)).toBe(same);
  });
});

describe('registerHono', () => {
  it('registers one route per declaration with method and prefixed path', async () => {
    const registered: { method: string; path: string }[] = [];
    const app = {
      on: (
        method: string,
        path: string,
        fn: (c: { req: { raw: Request } }) => Promise<Response>,
      ) => {
        registered.push({ method, path });
        return fn;
      },
    };
    registerHono(
      app,
      { getUser: routes.getUser },
      { getUser: ({ params }) => ({ id: params.id, name: 'x' }) },
      {
        basePath: '/api',
      },
    );
    expect(registered).toEqual([{ method: 'GET', path: '/api/users/:id' }]);

    const fn = app.on('GET', '/api/users/:id', (c) => handler(c.req.raw));
    const res = await fn({ req: { raw: new Request('https://x/users/1') } });
    expect(res.status).toBe(200);
  });
});

describe('handleRoute', () => {
  const ticks = createRoute.get('/ticks', {
    query: z.object({ count: z.number().int() }),
    response: z.object({ n: z.number() }),
    responseType: 'sse',
  });
  const call = (request: Request, params: Record<string, string | undefined> = {}) =>
    handleRoute('getUser', routes.getUser, ({ params }) => db.get(params.id) ?? reply(404), {
      request,
      params,
    });

  it('validates an already matched request and answers like createFetchHandler', async () => {
    const ok = await call(new Request('https://x/anything'), { id: '1' });
    expect(await ok.json()).toEqual({ id: 1, name: 'Ann' });
    expect((await call(new Request('https://x/anything'), { id: '99' })).status).toBe(404);
    const bad = await call(new Request('https://x/anything'), { id: 'abc' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'ValidationError', target: 'params' });
    expect((await call(new Request('https://x/anything'))).status).toBe(400);
  });

  it('names the route in validation errors and onError', async () => {
    const res = await handleRoute(
      'boom',
      routes.motd,
      () => {
        throw new Error('x');
      },
      { request: new Request('https://x/motd'), params: {} },
      { onError: (_error, context) => new Response(context.route, { status: 503 }) },
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('boom');
  });

  it('encodes an async iterable as server-sent events, validating each event', async () => {
    const res = await handleRoute(
      'ticks',
      ticks,
      async function* ({ query }) {
        for (let n = 1; n <= query.count; n++) yield { n };
        yield { n: 'x' } as never;
      },
      { request: new Request('https://x/ticks?count=2'), params: {} },
    );
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toBe('data: {"n":1}\n\n');
    expect(decoder.decode((await reader.read()).value)).toBe('data: {"n":2}\n\n');
    await expect(reader.read()).rejects.toBeInstanceOf(ValidationError);
  });

  it('closes the generator when the client cancels and passes streams through', async () => {
    let finished = false;
    const res = await handleRoute(
      'ticks',
      ticks,
      async function* () {
        try {
          yield { n: 1 };
          yield { n: 2 };
        } finally {
          finished = true;
        }
      },
      { request: new Request('https://x/ticks?count=1'), params: {} },
      { validateResponse: false },
    );
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(finished).toBe(true);

    const raw = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: 1\n\n'));
        controller.close();
      },
    });
    const passthrough = await handleRoute('ticks', ticks, () => raw as never, {
      request: new Request('https://x/ticks?count=1'),
      params: {},
    });
    expect(await passthrough.text()).toBe('data: 1\n\n');
  });
});

describe('errorToResponse and HttpReply.toResponse', () => {
  class Teapot extends TaggedError<'Teapot'> {
    readonly _tag = 'Teapot';
    readonly status = 418;
  }
  const context = { route: 'r', request: new Request('https://x/') };

  it('maps replies, validation errors, tagged errors and the rest', async () => {
    expect((await errorToResponse(reply(401, { m: 1 }), context)).status).toBe(401);
    const invalid = await errorToResponse(new ValidationError('response', [], 'r'), context);
    expect(invalid.status).toBe(500);
    const tagged = await errorToResponse(new Teapot('short'), context);
    expect(tagged.status).toBe(418);
    expect(await tagged.json()).toEqual({ error: 'Teapot', message: 'short' });
    expect((await errorToResponse(new Error('x'), context)).status).toBe(500);
    const custom = await errorToResponse(new Error('x'), context, {
      onError: () => new Response(null, { status: 599 }),
    });
    expect(custom.status).toBe(599);
  });

  it('turns a reply into a Response by body type', async () => {
    expect(new HttpReply(204).toResponse().status).toBe(204);
    const text = new HttpReply(200, 'hi', { 'x-a': '1' }).toResponse();
    expect(await text.text()).toBe('hi');
    expect(text.headers.get('x-a')).toBe('1');
    const json = new HttpReply(201, { a: 1 }).toResponse();
    expect(json.headers.get('content-type')).toContain('application/json');
    expect(await json.json()).toEqual({ a: 1 });
    expect(await new HttpReply(200, new Blob(['b'])).toResponse().text()).toBe('b');
  });
});

describe('errors and replies from another copy of endpoint-kit', () => {
  // The main entry and the server entry are separate bundles, so a route error class imported
  // from 'endpoint-kit' is not `instanceof` the server's TaggedError. Detection is duck-typed.
  class Foreign extends Error {
    readonly _tag = 'Foreign';
    readonly status = 402;
  }
  class ForeignValidation extends Error {
    readonly _tag = 'ValidationError';
    readonly target = 'body';
    readonly issues = [{ message: 'nope' }];
  }
  const REPLY_BRAND = Symbol.for('endpoint-kit.reply');
  class ForeignReply {
    readonly [REPLY_BRAND] = true;
    constructor(readonly status: number) {}
    toResponse(): Response {
      return new Response(null, { status: this.status });
    }
  }
  const context = { route: 'r', request: new Request('https://x/') };

  it('are recognised by errorToResponse and handlers', async () => {
    expect((await errorToResponse(new Foreign('pay'), context)).status).toBe(402);
    const invalid = await errorToResponse(new ForeignValidation('bad'), context);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: 'ValidationError', target: 'body' });
    expect((await errorToResponse(new ForeignReply(418), context)).status).toBe(418);
    expect(HttpReply.is(new ForeignReply(1))).toBe(true);
    expect(HttpReply.is({ status: 1 })).toBe(false);

    const returned = await handleRoute('motd', routes.motd, () => new ForeignReply(417) as never, {
      request: new Request('https://x/motd'),
      params: {},
    });
    expect(returned.status).toBe(417);
  });
});
