import express from 'express';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createRepository, createRoute, fetchAdapter, TaggedError } from '../src/index.js';
import { createFetchHandler, reply } from '../src/server/index.js';
import { createNodeHandler, toRequest } from '../src/server/node.js';

class NotFoundError extends TaggedError<'NotFoundError'> {
  readonly _tag = 'NotFoundError';
  readonly status = 404;
  constructor(readonly data: { id: number }) {
    super(`user ${String(data.id)} not found`);
  }
}

const routes = {
  getUser: createRoute.get('/users/:id', {
    params: { id: z.coerce.number() },
    response: z.object({ id: z.number() }),
    errors: { 404: (ctx) => new NotFoundError(ctx.data as { id: number }) },
  }),
  createUser: createRoute.post('/users', {
    body: z.object({ name: z.string() }),
    response: z.object({ id: z.number(), name: z.string() }),
  }),
  echoQuery: createRoute.get('/echo', { query: z.object({ n: z.string() }) }),
};

const handlers = {
  getUser: ({ params }: { params: { id: number } }) => {
    if (params.id === 404) throw new NotFoundError({ id: params.id });
    return { id: params.id };
  },
  createUser: ({ body }: { body: { name: string } }) => reply(201, { id: 1, name: body.name }),
  echoQuery: ({ query }: { query: { n: string } }) => ({ n: query.n }),
};

type Listener = (req: IncomingMessage, res: ServerResponse) => unknown;

async function listen(app: Listener): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    void app(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, close: () => server.close() };
}

describe('createNodeHandler with http.createServer', () => {
  let base: { url: string; close: () => void };
  beforeAll(async () => {
    base = await listen(createNodeHandler(routes, handlers, { basePath: '/api' }));
  });
  afterAll(() => {
    base.close();
  });

  it('serves GET with params and POST with a streamed JSON body', async () => {
    const got = await fetch(`${base.url}/api/users/7`);
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({ id: 7 });

    const created = await fetch(`${base.url}/api/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ann' }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: 1, name: 'Ann' });
  });

  it('turns a thrown TaggedError into its status and tag, and answers 404 without next()', async () => {
    const missing = await fetch(`${base.url}/api/users/404`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: 'NotFoundError',
      message: 'user 404 not found',
      data: { id: 404 },
    });

    expect((await fetch(`${base.url}/api/nothing`)).status).toBe(404);
  });

  it('round-trips through the endpoint-kit client with typed errors', async () => {
    const api = createRepository({
      baseUrl: `${base.url}/api`,
      adapter: fetchAdapter(),
      retry: false,
    })
      .mergeAll(routes)
      .build();

    expect((await api.getUser({ params: { id: 2 } })).data).toEqual({ id: 2 });
    const { error } = await api.getUser({ params: { id: 404 } });
    expect(error).toBeInstanceOf(NotFoundError);
  });
});

describe('createNodeHandler as Express middleware', () => {
  let base: { url: string; close: () => void };
  beforeAll(async () => {
    const app = express();
    app.use(createNodeHandler(routes, handlers));
    app.get('/other', (_req, res) => {
      res.json({ other: true });
    });
    base = await listen(app);
  });
  afterAll(() => {
    base.close();
  });

  it('answers matched routes and falls through to Express for the rest', async () => {
    expect(await (await fetch(`${base.url}/users/3`)).json()).toEqual({ id: 3 });
    expect(await (await fetch(`${base.url}/other`)).json()).toEqual({ other: true });
    expect((await fetch(`${base.url}/users`, { method: 'PATCH' })).status).toBe(405);
  });
});

describe('coerce option', () => {
  it('can be disabled so string schemas see raw strings only', async () => {
    const strict = createFetchHandler(
      { n: createRoute.get('/n', { query: z.object({ n: z.number() }) }) },
      { n: ({ query }) => ({ n: query.n }) },
      { coerce: false },
    );
    expect((await strict(new Request('https://x/n?n=1'))).status).toBe(400);

    const lenient = createFetchHandler(
      { n: createRoute.get('/n', { query: z.object({ n: z.number() }) }) },
      { n: ({ query }) => ({ n: query.n }) },
    );
    expect(await (await lenient(new Request('https://x/n?n=1'))).json()).toEqual({ n: 1 });
  });
});

describe('toRequest', () => {
  it('rebuilds the URL, honouring x-forwarded-* only with trustProxy', () => {
    const fake = {
      method: 'GET',
      url: '/p?q=1',
      headers: {
        host: 'internal:3000',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'public.example',
      },
      socket: {},
    } as never;
    expect(toRequest(fake).url).toBe('http://internal:3000/p?q=1');
    expect(toRequest(fake, true).url).toBe('https://public.example/p?q=1');
  });
});
