import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createRepository, createRoute } from '../src/index.js';
import { mockAdapter, toResponse } from '../src/testing.js';

const routes = {
  getUser: createRoute.get('/users/:id', { response: z.object({ id: z.number() }) }),
  listUsers: createRoute.get('/users'),
  createUser: createRoute.post('/users', { body: z.object({ name: z.string() }) }),
  deep: createRoute.get('/files/:bucket/*'),
};

function build(adapter = mockAdapter()) {
  return {
    adapter,
    api: createRepository({ baseUrl: 'https://api.test', adapter, retry: false })
      .mergeAll(routes)
      .build(),
  };
}

describe('mockAdapter', () => {
  it('matches method + path, exposes params, defaults to 200', async () => {
    const { api, adapter } = build(
      mockAdapter({
        'GET /users/:id': (_request, { params }) => ({ id: Number(params['id']) }),
      }),
    );

    const { data, error } = await api.getUser({ params: { id: 7 } });

    expect(error).toBeNull();
    expect(data).toEqual({ id: 7 });
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.last?.url).toBe('https://api.test/users/7');
  });

  it('answers 404 for unknown routes and supports partial responses', async () => {
    const { api } = build(
      mockAdapter({
        'POST /users': () => ({
          status: 201,
          data: { created: true },
          headers: { location: '/users/1' },
        }),
      }),
    );

    const created = await api.createUser({ body: { name: 'x' } });
    expect(created.ok && created.status).toBe(201);
    expect(created.ok && created.headers['location']).toBe('/users/1');

    const missing = await api.listUsers();
    expect(missing.error?._tag).toBe('ApiError');
    expect(missing.error && 'status' in missing.error && missing.error.status).toBe(404);
  });

  it('supports wildcards, any-method keys, async handlers, use() and reset()', async () => {
    const adapter = mockAdapter({ '* /users': () => Promise.resolve([{ id: 1 }]) });
    const { api } = build(adapter);

    expect((await api.listUsers()).data).toEqual([{ id: 1 }]);

    adapter.use({ 'GET /files/:bucket/*': (_r, { params }) => params });
    expect((await api.deep({ params: { bucket: 'b' } })).data).toEqual({ bucket: 'b' });

    adapter.use({ '*': () => 'anything' });
    expect((await api.getUser({ params: { id: 1 } })).error?._tag).toBe('ValidationError');

    expect(adapter.calls).toHaveLength(3);
    adapter.reset();
    expect(adapter.calls).toHaveLength(0);
    expect(adapter.last).toBeUndefined();
  });

  it('toResponse treats arrays and primitives as bodies', () => {
    expect(toResponse([1, 2]).data).toEqual([1, 2]);
    expect(toResponse('text').data).toBe('text');
    expect(toResponse(null).data).toBeNull();
    expect(toResponse({ status: 500 })).toMatchObject({ status: 500, data: null });
  });
});
