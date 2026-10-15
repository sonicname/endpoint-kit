import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { createRepository, createRoute, paginate, TaggedError } from '../src/index.js';
import { routeInfiniteQuery, routeKey, routeKeyPrefix, routeQuery } from '../src/tanstack-query.js';
import { mockAdapter } from '../src/testing.js';

class NotFoundError extends TaggedError<'NotFoundError'> {
  readonly _tag = 'NotFoundError';
}

const item = z.object({ id: z.number() });
const routes = {
  getUser: createRoute.get('/users/:id', {
    response: item,
    errors: { 404: () => new NotFoundError('nope') },
  }),
  listItems: paginate(
    createRoute.get('/items', {
      query: z.object({ page: z.number().optional() }),
      response: z.array(item),
    }),
    {
      next: ({ data, input, page, headers }) =>
        data.length === 0 || headers['x-last'] === '1'
          ? null
          : { ...input, query: { ...input.query, page: page + 1 } },
    },
  ),
};

function build() {
  const adapter = mockAdapter({
    'GET /users/:id': (_r, { params }) =>
      params['id'] === '404' ? { status: 404, data: null } : { id: Number(params['id']) },
    'GET /items': (request) => {
      const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
      return page >= 3
        ? { data: [{ id: page }], headers: { 'x-last': '1' } }
        : { data: [{ id: page }] };
    },
  });
  return createRepository({ baseUrl: 'https://api.test', adapter, retry: false })
    .mergeAll(routes)
    .build();
}

describe('routeKey', () => {
  it('derives keys from the route and the data-identifying input', () => {
    const api = build();
    expect(routeKey(api.getUser, { params: { id: 1 }, headers: { a: 'b' } })).toEqual([
      'GET',
      '/users/:id',
      { params: { id: 1 } },
    ]);
    expect(routeKey(api.getUser)).toEqual(['GET', '/users/:id', {}]);
    expect(routeKeyPrefix(api.getUser)).toEqual(['GET', '/users/:id']);
  });
});

describe('routeQuery', () => {
  it('builds queryOptions whose queryFn resolves data and throws the typed error', async () => {
    const api = build();
    const options = routeQuery(api.getUser, { params: { id: 5 } });

    expect(options.queryKey).toEqual(['GET', '/users/:id', { params: { id: 5 } }]);
    const run = (id: number) =>
      routeQuery(api.getUser, { params: { id } }).queryFn!({
        queryKey: options.queryKey,
        signal: new AbortController().signal,
        meta: undefined,
        client: undefined as never,
      });

    await expect(run(5)).resolves.toEqual({ id: 5 });
    await expect(run(404)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('types data and error from the route', () => {
    const api = build();
    const options = routeQuery(api.getUser, { params: { id: 1 } });
    type Fn = NonNullable<typeof options.queryFn>;
    expectTypeOf<Awaited<ReturnType<Fn>>>().toEqualTypeOf<{ id: number }>();
    // The error generic is carried on the options object for useQuery to pick up.
    expectTypeOf(options).toHaveProperty('queryKey');
    expectTypeOf<Parameters<typeof routeQuery<typeof routes.getUser, never>>[1]>().toHaveProperty(
      'params',
    );
    type ErrorOf<T> = T extends { queryFn?: unknown; throwOnError?: infer X } ? X : never;
    expectTypeOf<ErrorOf<typeof options>>().not.toBeNever();
  });
});

describe('routeInfiniteQuery', () => {
  it('walks pages through getNextPageParam using the route pagination', async () => {
    const api = build();
    const options = routeInfiniteQuery(api.listItems);

    expect(options.queryKey).toEqual(['GET', '/items', {}, 'infinite']);
    expect(options.initialPageParam).toEqual({});

    type PageParam = typeof options.initialPageParam;
    const fetchPage = (pageParam: PageParam) =>
      options.queryFn!({
        pageParam,
        queryKey: options.queryKey,
        signal: new AbortController().signal,
        meta: undefined,
        direction: 'forward',
        client: undefined as never,
      });

    const pages: { id: number }[][] = [];
    const params: PageParam[] = [options.initialPageParam];
    for (;;) {
      const page = await fetchPage(params[params.length - 1]!);
      pages.push(page);
      const next = options.getNextPageParam(page, pages, params[params.length - 1]!, params);
      if (next === undefined || next === null) break;
      params.push(next);
    }

    expect(pages).toEqual([[{ id: 1 }], [{ id: 2 }], [{ id: 3 }]]);
    expect(params).toEqual([{}, { query: { page: 2 } }, { query: { page: 3 } }]);
  });

  it('rejects routes without pagination at the type level', () => {
    const api = build();
    const typeOnly = () => {
      // @ts-expect-error getUser is not paginated
      routeInfiniteQuery(api.getUser, { params: { id: 1 } });
    };
    expectTypeOf(typeOnly).toBeFunction();
  });
});
