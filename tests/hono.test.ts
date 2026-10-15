import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createRepository, createRoute, fetchAdapter } from '../src/index.js';
import { createFetchHandler, registerHono, reply } from '../src/server/index.js';

const routes = {
  getUser: createRoute.get('/users/:id', {
    params: { id: z.coerce.number() },
    response: z.object({ id: z.number() }),
  }),
  createUser: createRoute.post('/users', {
    body: z.object({ name: z.string() }),
    response: z.object({ id: z.number(), name: z.string() }),
  }),
};

const handlers = {
  getUser: ({ params }: { params: { id: number } }) =>
    params.id === 404 ? reply(404, { message: 'nope' }) : { id: params.id },
  createUser: ({ body }: { body: { name: string } }) => reply(201, { id: 1, name: body.name }),
};

describe('Hono integration', () => {
  it('registerHono mounts each route on a real Hono app with a basePath', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      await next();
      c.res.headers.set('x-middleware', 'ran');
    });
    registerHono(app, routes, handlers, { basePath: '/api' });

    expect(app.routes.map((r) => `${r.method} ${r.path}`)).toContain('GET /api/users/:id');

    const ok = await app.request('/api/users/7');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-middleware')).toBe('ran');
    expect(await ok.json()).toEqual({ id: 7 });

    const created = await app.request('/api/users', {
      method: 'POST',
      body: JSON.stringify({ name: 'Ann' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: 1, name: 'Ann' });

    expect((await app.request('/api/users/404')).status).toBe(404);
    expect((await app.request('/api/nothing')).status).toBe(404); // Hono's own 404
  });

  it('app.all("*") with the fetch handler also works, and the client round-trips through it', async () => {
    const app = new Hono();
    const handler = createFetchHandler(routes, handlers);
    app.all('*', (c) => handler(c.req.raw));

    const api = createRepository({
      baseUrl: 'https://api.test',
      adapter: fetchAdapter({
        fetch: async (input, init) => app.request(new Request(input, init)),
      }),
    })
      .mergeAll(routes)
      .build();

    const { data, error } = await api.createUser({ body: { name: 'Bob' } });
    expect(error).toBeNull();
    expect(data).toEqual({ id: 1, name: 'Bob' });

    const missing = await api.getUser({ params: { id: 404 } });
    expect(missing.error?._tag).toBe('ApiError');
  });
});
