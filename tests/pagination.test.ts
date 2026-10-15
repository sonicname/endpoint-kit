import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { ApiError, createRepository, createRoute, groupRoutes, paginate } from '../src/index.js';
import type { Adapter, AdapterRequest } from '../src/index.js';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

/** Answers page-number requests with 3 items per page over `total` items. */
function pagedAdapter(total: number): Adapter & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    request: (request: AdapterRequest) => {
      urls.push(request.url);
      const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
      const start = (page - 1) * 3;
      const items = Array.from({ length: Math.max(0, Math.min(3, total - start)) }, (_, i) => ({
        id: start + i + 1,
      }));
      return Promise.resolve({ status: 200, statusText: '', headers: {}, data: items });
    },
  };
}

const item = z.object({ id: z.number() });

describe('paginate', () => {
  const listItems = paginate(
    createRoute.get('/items', {
      query: z.object({ page: z.number().int().positive().optional() }),
      response: z.array(item),
    }),
    {
      next: ({ data, input, page }) =>
        data.length < 3 ? null : { ...input, query: { ...input.query, page: page + 1 } },
      items: (data) => data,
    },
  );

  it('types the pagination callbacks from the route', () => {
    expectTypeOf(listItems.paginate.next)
      .parameter(0)
      .toHaveProperty('data')
      .toEqualTypeOf<{ id: number }[]>();
    expectTypeOf<NonNullable<typeof listItems.paginate.items>>().returns.toEqualTypeOf<
      readonly { id: number }[]
    >();
  });

  it('walks pages until next() returns null', async () => {
    const adapter = pagedAdapter(7);
    const api = createRepository({ baseUrl: 'https://a.com', adapter })
      .mergeAll({ listItems })
      .build();

    const pages = await collect(api.listItems.pages());
    expect(pages.map((p) => p.length)).toEqual([3, 3, 1]);
    expect(adapter.urls).toEqual([
      'https://a.com/items',
      'https://a.com/items?page=2',
      'https://a.com/items?page=3',
    ]);
    expectTypeOf(api.listItems.pages).returns.toEqualTypeOf<AsyncIterable<{ id: number }[]>>();
  });

  it('flattens through items() and respects maxPages', async () => {
    const api = createRepository({ baseUrl: 'https://a.com', adapter: pagedAdapter(7) })
      .mergeAll({ listItems })
      .build();

    const all = await collect(api.listItems.items());
    expect(all.map((i) => i.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expectTypeOf(api.listItems.items).returns.toEqualTypeOf<AsyncIterable<{ id: number }>>();

    const firstTwo = await collect(api.listItems.items(undefined, { maxPages: 2 }));
    expect(firstTwo).toHaveLength(6);
  });

  it('rejects mid-iteration with the typed error', async () => {
    let calls = 0;
    const adapter: Adapter = {
      request: () => {
        calls++;
        return Promise.resolve(
          calls === 2
            ? { status: 500, statusText: '', headers: {}, data: null }
            : { status: 200, statusText: '', headers: {}, data: [{ id: 1 }, { id: 2 }, { id: 3 }] },
        );
      },
    };
    const api = createRepository({ baseUrl: 'https://a.com', adapter })
      .mergeAll({ listItems })
      .build();

    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const entry of api.listItems.items()) seen.push(entry.id);
      })(),
    ).rejects.toBeInstanceOf(ApiError);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('supports cursor pagination and stays available through groupRoutes', async () => {
    const pageSchema = z.object({ items: z.array(item), nextCursor: z.string().nullable() });
    const cursors: Record<string, z.infer<typeof pageSchema>> = {
      '': { items: [{ id: 1 }], nextCursor: 'c2' },
      c2: { items: [{ id: 2 }], nextCursor: null },
    };
    const adapter: Adapter = {
      request: (request) => {
        const cursor = new URL(request.url).searchParams.get('cursor') ?? '';
        return Promise.resolve({ status: 200, statusText: '', headers: {}, data: cursors[cursor] });
      },
    };
    const routes = groupRoutes('/v1', {
      listEvents: paginate(
        createRoute.get('/events', {
          query: z.object({ cursor: z.string().optional() }),
          response: pageSchema,
        }),
        {
          next: ({ data, input }) =>
            data.nextCursor ? { ...input, query: { cursor: data.nextCursor } } : null,
          items: (data) => data.items,
        },
      ),
    });
    const api = createRepository({ baseUrl: 'https://a.com', adapter }).mergeAll(routes).build();

    expect(await collect(api.listEvents.items())).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('does not expose pages() on routes without pagination, nor items() without an extractor', () => {
    const plain = createRoute.get('/plain');
    const pagesOnly = paginate(createRoute.get('/p', { response: z.array(item) }), {
      next: () => null,
    });
    const api = createRepository({ baseUrl: 'https://a.com' })
      .mergeAll({ plain, pagesOnly })
      .build();

    expectTypeOf(api.plain).not.toHaveProperty('pages');
    expectTypeOf(api.pagesOnly).toHaveProperty('pages');
    expectTypeOf(api.pagesOnly).not.toHaveProperty('items');
    expect('pages' in api.plain).toBe(false);
    expect('items' in api.pagesOnly).toBe(false);
  });
});
