# Testing

Two strategies, both without touching the network.

## 1. Swap the adapter

The adapter is the only thing that talks HTTP. `mockAdapter` from `endpoint-kit/testing`
answers from a lookup table and records every request, so validation, params, middlewares and
custom errors run exactly as in production.

```ts
import { mockAdapter } from 'endpoint-kit/testing';

const adapter = mockAdapter({
  'GET /users/:id': (_request, { params }) => ({ id: Number(params.id), login: 'octocat' }),
  'GET /users/nobody': () => ({ status: 404, data: { message: 'Not Found' } }),
  'POST /users': async (request) => ({ status: 201, data: request.body }),
});

const api = createRepository({ baseUrl: 'https://api.test', adapter, retry: false, timeout: false })
  .mergeAll(routes)
  .build();

it('maps 404 to NotFoundError', async () => {
  const { error } = await api.getUser({ params: { username: 'nobody' } });
  expect(error?._tag).toBe('NotFoundError');
});

it('sends the auth header', async () => {
  await api.getUser({ params: { username: 'octocat' } });
  expect(adapter.last?.headers.authorization).toMatch(/^Bearer /);
});
```

Keys are `"METHOD /path"`; paths accept `:param` segments and a trailing `*`, `"* /path"`
matches any method and `"*"` matches everything. A handler returns the body, or an object with
`status`/`data`/`headers`. `adapter.calls`, `adapter.last`, `adapter.reset()` and
`adapter.use({...})` cover the rest. Turn retries and timeouts off so tests stay deterministic.

## 2. Mock the network

If you prefer tests to go through real `fetch`, keep `fetchAdapter()` and intercept at the
network layer:

- **MSW** works unchanged, in Node and in the browser. Handlers answer with JSON; endpoint-kit
  validates and maps errors as usual.
- **`vi.stubGlobal('fetch', ...)`** for quick one-offs. endpoint-kit reads `globalThis.fetch`
  when `fetchAdapter()` is created, so stub it before building the client, or pass the stub
  explicitly: `fetchAdapter({ fetch: myStub })`.

This repository's own tests use the second approach; see [`tests/repository.test.ts`](../tests/repository.test.ts).

## Testing custom middlewares

A middleware is a function of `(request, next, context)`. Call it directly with a fake `next`:

```ts
it('refreshes once and replays', async () => {
  const next = vi
    .fn()
    .mockResolvedValueOnce({ status: 401, statusText: '', headers: {}, data: null })
    .mockResolvedValueOnce({ status: 200, statusText: '', headers: {}, data: 'ok' });
  const refresh = vi.fn().mockResolvedValue('new-token');

  const mw = refreshOn401({ getToken: () => 'old-token', refresh });
  const response = await mw(request, next, { route: 'getUser', attempt: 1 });

  expect(response.status).toBe(200);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(next.mock.calls[1]?.[0].headers.authorization).toBe('Bearer new-token');
});
```

## Timers

Timeout and retry delays use `setTimeout`. With Vitest, `vi.useFakeTimers()` plus
`await vi.advanceTimersByTimeAsync(ms)` drives them deterministically; see
[`tests/retry.test.ts`](../tests/retry.test.ts) for the pattern.
