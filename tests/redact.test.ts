import { describe, expect, it } from 'vitest';

import {
  ApiError,
  createRepository,
  createRoute,
  DEFAULT_REDACTED_HEADERS,
  REDACTED,
  redactHeaders,
  TaggedError,
} from '../src/index.js';
import { mockAdapter } from '../src/testing.js';

class Teapot extends TaggedError<'Teapot'> {
  readonly _tag = 'Teapot';
  constructor(readonly headers: Record<string, string>) {
    super('teapot');
  }
}

describe('redactHeaders', () => {
  it('masks the default names, case-insensitively, plus token/secret/password patterns', () => {
    const out = redactHeaders({
      Authorization: 'Bearer x',
      cookie: 'a=b',
      'X-Refresh-Token': 't',
      'x-client-secret': 's',
      accept: 'json',
    });
    expect(out).toEqual({
      Authorization: REDACTED,
      cookie: REDACTED,
      'X-Refresh-Token': REDACTED,
      'x-client-secret': REDACTED,
      accept: 'json',
    });
    expect(DEFAULT_REDACTED_HEADERS).toContain('authorization');
  });

  it('accepts a custom list', () => {
    expect(redactHeaders({ 'x-custom': '1', authorization: 'a' }, ['x-custom'])).toEqual({
      'x-custom': REDACTED,
      authorization: 'a',
    });
  });
});

describe('redaction inside a repository', () => {
  const adapter = mockAdapter({
    'GET /fail': () => ({ status: 500, headers: { authorization: 'leak', 'x-request-id': '1' } }),
    'GET /teapot': () => ({ status: 418, headers: { cookie: 'leak', via: 'proxy' } }),
  });
  const routes = {
    fail: createRoute.get('/fail'),
    teapot: createRoute.get('/teapot', { errors: { 418: (ctx) => new Teapot(ctx.headers) } }),
  };

  it('redacts ApiError headers, factory context headers and the onError request', async () => {
    const seen: Record<string, string>[] = [];
    const api = createRepository({
      baseUrl: 'https://api.test',
      adapter,
      retry: false,
      headers: { authorization: 'Bearer secret', accept: 'json' },
      hooks: {
        onError: ({ request }) => {
          if (request) seen.push(request.headers);
        },
      },
    })
      .mergeAll(routes)
      .build();

    const { error } = await api.fail();
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).headers).toEqual({ authorization: REDACTED, 'x-request-id': '1' });
    expect(seen[0]).toEqual({ authorization: REDACTED, accept: 'json' });

    const teapot = await api.teapot();
    expect((teapot.error as Teapot).headers).toEqual({ cookie: REDACTED, via: 'proxy' });

    // the real request was not touched
    expect(adapter.last?.headers['authorization']).toBe('Bearer secret');
  });

  it('can be disabled or narrowed', async () => {
    const off = createRepository({
      baseUrl: 'https://api.test',
      adapter,
      retry: false,
      redactHeaders: false,
    })
      .mergeAll(routes)
      .build();
    expect(((await off.fail()).error as ApiError).headers['authorization']).toBe('leak');

    const narrow = createRepository({
      baseUrl: 'https://api.test',
      adapter,
      retry: false,
      redactHeaders: ['x-request-id'],
    })
      .mergeAll(routes)
      .build();
    expect(((await narrow.fail()).error as ApiError).headers).toEqual({
      authorization: 'leak',
      'x-request-id': REDACTED,
    });
  });
});
