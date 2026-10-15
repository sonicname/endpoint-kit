import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createRepository, createRoute, toFormData, toFormUrlEncoded } from '../src/index.js';
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

describe('toFormData', () => {
  it('appends files, arrays, dates, objects and skips empties', () => {
    const file = new File(['hi'], 'hello.txt', { type: 'text/plain' });
    const blob = new Blob(['x']);
    const form = toFormData({
      file,
      blob,
      tags: ['a', 'b'],
      meta: { nested: true },
      when: new Date('2026-01-01T00:00:00.000Z'),
      count: 2,
      nothing: null,
      missing: undefined,
    });

    expect(form.get('file')).toBeInstanceOf(File);
    expect((form.get('file') as File).name).toBe('hello.txt');
    expect(form.get('blob')).toBeInstanceOf(Blob);
    expect(form.getAll('tags')).toEqual(['a', 'b']);
    expect(form.get('meta')).toBe('{"nested":true}');
    expect(form.get('when')).toBe('2026-01-01T00:00:00.000Z');
    expect(form.get('count')).toBe('2');
    expect(form.has('nothing')).toBe(false);
    expect(form.has('missing')).toBe(false);
  });

  it('passes an existing FormData through and ignores non-objects', () => {
    const existing = new FormData();
    expect(toFormData(existing)).toBe(existing);
    expect([...toFormData('nope').keys()]).toEqual([]);
  });
});

describe('toFormUrlEncoded', () => {
  it('encodes with the query serializer', () => {
    expect(toFormUrlEncoded({ a: [1, 2], b: 'x' }, { arrayFormat: 'comma' }).toString()).toBe(
      'a=1%2C2&b=x',
    );
    const existing = new URLSearchParams('q=1');
    expect(toFormUrlEncoded(existing)).toBe(existing);
  });
});

describe('bodyType on routes', () => {
  it('sends multipart bodies as FormData with the schema applied first', async () => {
    const adapter = capture();
    const upload = createRoute.post('/upload', {
      bodyType: 'multipart',
      body: z.object({
        file: z.instanceof(Blob),
        title: z.string().trim(),
      }),
    });
    const api = createRepository({ baseUrl: 'https://a.com', adapter })
      .mergeAll({ upload })
      .build();

    const { error } = await api.upload({ body: { file: new Blob(['x']), title: '  hi ' } });

    expect(error).toBeNull();
    const body = adapter.requests[0]!.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('title')).toBe('hi');
    expect(body.get('file')).toBeInstanceOf(Blob);
  });

  it('sends form bodies as URLSearchParams', async () => {
    const adapter = capture();
    const login = createRoute.post('/login', {
      bodyType: 'form',
      body: z.object({ user: z.string(), scopes: z.array(z.string()) }),
    });
    const api = createRepository({
      baseUrl: 'https://a.com',
      adapter,
      querySerializer: { arrayFormat: 'brackets' },
    })
      .mergeAll({ login })
      .build();

    await api.login({ body: { user: 'me', scopes: ['a', 'b'] } });

    const body = adapter.requests[0]!.body as URLSearchParams;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect(decodeURIComponent(body.toString())).toBe('user=me&scopes[]=a&scopes[]=b');
  });

  it('leaves json bodies untouched for the adapter', async () => {
    const adapter = capture();
    const api = createRepository({ baseUrl: 'https://a.com', adapter })
      .mergeAll({ create: createRoute.post('/x', { body: z.object({ a: z.number() }) }) })
      .build();

    await api.create({ body: { a: 1 } });

    expect(adapter.requests[0]!.body).toEqual({ a: 1 });
  });
});
