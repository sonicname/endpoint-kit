import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildQueryString, createRepository, createRoute } from '../src/index.js';
import type { Adapter, AdapterRequest } from '../src/index.js';

const query = {
  tags: ['a', 'b'],
  filter: { status: 'open', labels: ['x', 'y'], range: { from: 1, to: 2 } },
  when: new Date('2026-01-02T03:04:05.000Z'),
  empty: [],
  skip: undefined,
};

describe('buildQueryString formats', () => {
  it('repeat + json (defaults)', () => {
    expect(decodeURIComponent(buildQueryString(query))).toBe(
      'tags=a&tags=b&filter={"status":"open","labels":["x","y"],"range":{"from":1,"to":2}}&when=2026-01-02T03:04:05.000Z',
    );
  });

  it('brackets + brackets (qs style)', () => {
    expect(
      decodeURIComponent(
        buildQueryString(query, { arrayFormat: 'brackets', objectFormat: 'brackets' }),
      ),
    ).toBe(
      'tags[]=a&tags[]=b&filter[status]=open&filter[labels][]=x&filter[labels][]=y&filter[range][from]=1&filter[range][to]=2&when=2026-01-02T03:04:05.000Z',
    );
  });

  it('indices + dots', () => {
    expect(
      decodeURIComponent(buildQueryString(query, { arrayFormat: 'indices', objectFormat: 'dots' })),
    ).toBe(
      'tags[0]=a&tags[1]=b&filter.status=open&filter.labels[0]=x&filter.labels[1]=y&filter.range.from=1&filter.range.to=2&when=2026-01-02T03:04:05.000Z',
    );
  });

  it('comma', () => {
    expect(
      decodeURIComponent(buildQueryString({ ids: [1, 2, 3], none: [] }, { arrayFormat: 'comma' })),
    ).toBe('ids=1,2,3');
  });

  it('custom date and custom function', () => {
    expect(buildQueryString({ when: new Date(0) }, { date: (d) => String(d.getTime()) })).toBe(
      'when=0',
    );
    expect(buildQueryString({ a: 1 }, () => '?custom=1')).toBe('custom=1');
  });
});

describe('querySerializer on repository and route', () => {
  function capture(): Adapter & { urls: string[] } {
    const urls: string[] = [];
    return {
      urls,
      request: (request: AdapterRequest) => {
        urls.push(request.url);
        return Promise.resolve({ status: 200, statusText: '', headers: {}, data: null });
      },
    };
  }

  it('applies the repository setting and lets a route override it', async () => {
    const adapter = capture();
    const api = createRepository({
      baseUrl: 'https://a.com',
      adapter,
      querySerializer: { arrayFormat: 'brackets' },
    })
      .mergeAll({
        a: createRoute.get('/a', { query: z.object({ tags: z.array(z.string()) }) }),
        b: createRoute.get('/b', {
          query: z.object({ tags: z.array(z.string()) }),
          querySerializer: { arrayFormat: 'comma' },
        }),
      })
      .build();

    await api.a({ query: { tags: ['x', 'y'] } });
    await api.b({ query: { tags: ['x', 'y'] } });

    expect(decodeURIComponent(adapter.urls[0]!)).toBe('https://a.com/a?tags[]=x&tags[]=y');
    expect(decodeURIComponent(adapter.urls[1]!)).toBe('https://a.com/b?tags=x,y');
  });
});
