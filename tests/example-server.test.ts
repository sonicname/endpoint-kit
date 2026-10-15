import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createClient } from '../examples/client.js';
import { routes, TodoNotFoundError } from '../examples/contract.js';
import { createHonoApp, fetchHandler, resetStore, startNodeServer } from '../examples/server.js';
import { createRepository, fetchAdapter } from '../src/index.js';

const headers = { 'x-api-key': 'dev-key' };

describe('examples/server + examples/client', () => {
  let server: { url: string; close: () => void };
  beforeAll(async () => {
    resetStore([
      { title: 'a', done: true },
      { title: 'b', done: false },
      { title: 'c', done: false },
    ]);
    server = await startNodeServer();
  });
  afterAll(() => {
    server.close();
  });

  it('round-trips through the Node server: create, paginate, errors, delete', async () => {
    const api = createClient(server.url);

    const created = await api.createTodo({ headers, body: { title: 'd' } });
    expect(created.ok && created.status).toBe(201);
    expect(created.ok && created.headers['location']).toBe('/todos/4');

    const titles: string[] = [];
    for await (const todo of api.listTodos.items({ headers, query: { perPage: 2 } })) {
      titles.push(todo.title);
    }
    expect(titles).toEqual(['a', 'b', 'c', 'd']);

    const pending = await api.listTodos({ headers, query: { done: false } });
    expect(pending.data?.total).toBe(3);

    const missing = await api.getTodo({ headers, params: { id: 999 } });
    expect(missing.error).toBeInstanceOf(TodoNotFoundError);
    expect((missing.error as TodoNotFoundError).id).toBe(999);

    const denied = await api.getTodo({ headers: { 'x-api-key': 'nope' }, params: { id: 1 } });
    expect(denied.error?._tag).toBe('UnauthorizedError');

    const invalid = await api.createTodo({ headers, body: { title: '' } });
    expect(invalid.error?._tag).toBe('ValidationError');

    const toggled = await api.toggleTodo({ headers, params: { id: 2 } });
    expect(toggled.data?.done).toBe(true);

    const gone = await api.deleteTodo({ headers, params: { id: 4 } });
    expect(gone.ok && gone.status).toBe(204);
  });

  it('serves the same handlers through the fetch handler and Hono', async () => {
    const direct = createRepository({
      baseUrl: 'https://test/api',
      adapter: fetchAdapter({ fetch: (input, init) => fetchHandler(new Request(input, init)) }),
    })
      .mergeAll(routes)
      .build();
    expect((await direct.getTodo({ headers, params: { id: 1 } })).data?.title).toBe('a');

    const hono = createHonoApp();
    const res = await hono.request('/api/todos/1', { headers });
    expect(res.headers.get('x-powered-by')).toBe('endpoint-kit');
    const body = (await res.json()) as { title: string };
    expect(body.title).toBe('a');
  });
});
