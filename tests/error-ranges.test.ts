import { describe, expect, expectTypeOf, it } from 'vitest';

import { createRepository, createRoute, findErrorFactory, TaggedError } from '../src/index.js';
import type { RouteError } from '../src/index.js';
import { mockAdapter } from '../src/testing.js';

class ClientError extends TaggedError<'ClientError'> {
  readonly _tag = 'ClientError';
  constructor(readonly status: number) {
    super(`client ${String(status)}`);
  }
}
class ServerError extends TaggedError<'ServerError'> {
  readonly _tag = 'ServerError';
}
class NotFoundError extends TaggedError<'NotFoundError'> {
  readonly _tag = 'NotFoundError';
}
class Fallback extends TaggedError<'Fallback'> {
  readonly _tag = 'Fallback';
}

describe('findErrorFactory', () => {
  const f = {
    404: () => new NotFoundError('a'),
    '4XX': (c: { status: number }) => new ClientError(c.status),
    default: () => new Fallback('x'),
  };
  it('prefers exact, then range, then default', () => {
    expect(
      findErrorFactory(
        f,
        404,
      )?.({ status: 404, statusText: '', headers: {}, data: null, route: 'r' }),
    ).toBeInstanceOf(NotFoundError);
    expect(
      findErrorFactory(
        f,
        409,
      )?.({ status: 409, statusText: '', headers: {}, data: null, route: 'r' }),
    ).toBeInstanceOf(ClientError);
    expect(
      findErrorFactory(
        f,
        503,
      )?.({ status: 503, statusText: '', headers: {}, data: null, route: 'r' }),
    ).toBeInstanceOf(Fallback);
    expect(findErrorFactory(undefined, 500)).toBeUndefined();
    expect(findErrorFactory({ '5XX': () => new ServerError('s') }, 418)).toBeUndefined();
  });
});

describe('range keys on routes and repositories', () => {
  const route = createRoute.get('/x', {
    errors: { '4XX': (ctx) => new ClientError(ctx.status), 404: () => new NotFoundError('nf') },
  });
  const build = (status: number) =>
    createRepository({
      baseUrl: 'https://api.test',
      adapter: mockAdapter({ 'GET /x': () => ({ status }) }),
      retry: false,
      errors: { '5XX': () => new ServerError('boom'), default: () => new Fallback('fb') },
    })
      .mergeAll({ route })
      .build();

  it('types the union with every factory', () => {
    expectTypeOf(build(200).route)
      .returns.resolves.toHaveProperty('error')
      .toEqualTypeOf<RouteError | ClientError | NotFoundError | ServerError | Fallback | null>();
  });

  it('resolves at runtime in the documented order', async () => {
    expect((await build(404).route()).error).toBeInstanceOf(NotFoundError);
    expect((await build(418).route()).error).toBeInstanceOf(ClientError);
    expect((await build(502).route()).error).toBeInstanceOf(ServerError);
    expect((await build(302).route()).error).toBeInstanceOf(Fallback); // repo default, 3xx is not a success
  });
});
