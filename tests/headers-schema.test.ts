import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { createRepository, createRoute, groupRoutes } from '../src/index.js';
import type { RouteInput } from '../src/index.js';
import { createFetchHandler } from '../src/server/index.js';
import { mockAdapter } from '../src/testing.js';

const withSchema = createRoute.get('/tenant', {
  headers: z.object({ 'x-tenant': z.string().min(1), 'x-trace': z.string().optional() }),
});
const withStatic = createRoute.get('/static', { headers: { 'x-static': '1' } });
const plain = createRoute.get('/plain');

describe('header schemas on routes', () => {
  it('types the headers field from the schema, keeps free-form headers otherwise', () => {
    expectTypeOf<RouteInput<typeof withSchema>['headers']>().toEqualTypeOf<{
      'x-tenant': string;
      'x-trace'?: string | undefined;
    }>();
    expectTypeOf<RouteInput<typeof withStatic>['headers']>().toEqualTypeOf<
      Record<string, string> | undefined
    >();
    expectTypeOf<RouteInput<typeof plain>['headers']>().toEqualTypeOf<
      Record<string, string> | undefined
    >();

    const api = createRepository({ baseUrl: 'https://x' }).mergeAll({ withSchema, plain }).build();
    const typeOnly = () => {
      // @ts-expect-error x-tenant is required
      void api.withSchema();
      // @ts-expect-error unknown header key is rejected by the schema type
      void api.withSchema({ headers: { 'x-tenant': 'a', nope: '1' } });
    };
    expectTypeOf(typeOnly).toBeFunction();
  });

  it('validates headers before sending and merges them over static ones', async () => {
    const adapter = mockAdapter({ '*': () => null });
    const api = createRepository({
      baseUrl: 'https://api.test',
      adapter,
      retry: false,
      headers: { 'x-repo': 'r' },
    })
      .mergeAll({ withSchema, withStatic })
      .build();

    const ok = await api.withSchema({ headers: { 'x-tenant': 'acme' } });
    expect(ok.error).toBeNull();
    expect(adapter.last?.headers).toEqual({ 'x-repo': 'r', 'x-tenant': 'acme' });

    const invalid = await api.withSchema({ headers: { 'x-tenant': '' } });
    expect(invalid.error?._tag).toBe('ValidationError');
    expect(invalid.error).toMatchObject({ target: 'headers' });

    await api.withStatic({ headers: { 'x-call': 'c' } });
    expect(adapter.last?.headers).toEqual({ 'x-repo': 'r', 'x-static': '1', 'x-call': 'c' });
  });

  it('stringifies non-string header outputs and applies defaults', async () => {
    const adapter = mockAdapter({ '*': () => null });
    const route = createRoute.get('/n', {
      headers: z.object({ 'x-count': z.number(), 'x-flag': z.boolean().default(true) }),
    });
    const api = createRepository({ baseUrl: 'https://api.test', adapter, retry: false })
      .mergeAll({ route })
      .build();

    await api.route({ headers: { 'x-count': 3 } });

    expect(adapter.last?.headers).toEqual({ 'x-count': '3', 'x-flag': 'true' });
  });

  it('groupRoutes leaves header schemas alone but merges static headers', () => {
    const grouped = groupRoutes({ headers: { 'x-group': 'g' } }, { withSchema, withStatic });
    expect(grouped.withSchema.headers).toBe(withSchema.headers);
    expect(grouped.withStatic.headers).toEqual({ 'x-group': 'g', 'x-static': '1' });
  });

  it('server validates incoming headers and types the context', async () => {
    const handler = createFetchHandler(
      { withSchema, plain },
      {
        withSchema: ({ headers }) => {
          expectTypeOf(headers).toEqualTypeOf<{
            'x-tenant': string;
            'x-trace'?: string | undefined;
          }>();
          return { tenant: headers['x-tenant'] };
        },
        plain: ({ headers }) => {
          expectTypeOf(headers).toEqualTypeOf<Headers>();
          return { ua: headers.get('user-agent') };
        },
      },
    );

    const ok = await handler(new Request('https://s/tenant', { headers: { 'X-Tenant': 'acme' } }));
    expect(await ok.json()).toEqual({ tenant: 'acme' });

    const missing = await handler(new Request('https://s/tenant'));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ target: 'headers' });
  });
});
