import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createRepository, createRoute } from '../src/index.js';
import type { Adapter, AdapterRequest } from '../src/index.js';

function capture(): Adapter & { requests: AdapterRequest[] } {
  const requests: AdapterRequest[] = [];
  return {
    requests,
    request: (request) => {
      requests.push(request);
      return Promise.resolve({ status: 200, statusText: '', headers: {}, data: null });
    },
  };
}

describe('omitted query and body', () => {
  it('validates an omitted all-optional query as {} and applies defaults', async () => {
    const adapter = capture();
    const list = createRoute.get('/items', {
      query: z.object({ page: z.number().default(1), sort: z.string().optional() }),
    });
    const api = createRepository({ baseUrl: 'https://a.com', adapter }).mergeAll({ list }).build();

    const { error } = await api.list();

    expect(error).toBeNull();
    expect(adapter.requests[0]!.url).toBe('https://a.com/items?page=1');
  });

  it('validates an omitted all-optional body as {}', async () => {
    const adapter = capture();
    const touch = createRoute.post('/touch', {
      body: z.object({ note: z.string().optional(), force: z.boolean().default(false) }),
    });
    const api = createRepository({ baseUrl: 'https://a.com', adapter }).mergeAll({ touch }).build();

    const { error } = await api.touch();

    expect(error).toBeNull();
    expect(adapter.requests[0]!.body).toEqual({ force: false });
  });

  it('still reports missing required fields with the schema message', async () => {
    const api = createRepository({ baseUrl: 'https://a.com', adapter: capture() })
      .mergeAll({ create: createRoute.post('/x', { body: z.object({ name: z.string() }) }) })
      .build();

    const { error } = await api.create({ body: undefined as never });

    expect(error?._tag).toBe('ValidationError');
    expect(error?.message).toContain('name');
  });

  it('keeps undefined response bodies for none/204', async () => {
    const api = createRepository({ baseUrl: 'https://a.com', adapter: capture() })
      .mergeAll({ ping: createRoute.get('/ping', { responseType: 'none' }) })
      .build();

    const { data, error } = await api.ping();

    expect(error).toBeNull();
    expect(data).toBeUndefined();
  });
});
