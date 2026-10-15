# endpoint-kit

## 0.1.0

### Minor Changes

- First release.
  
  **Declare once, call anywhere**
  
  - `createRoute({...})` and `createRoute.get/post/put/patch/delete/head/options(path, {...})` with
    `params`, `query`, `body` and `response` schemas (Zod v4 or any Standard Schema library).
  - Path params inferred from `/users/:id`; `params` as a per-key map or a whole-object schema,
    both checked against the path at compile time.
  - `groupRoutes(prefix | options, routes)` to prefix and share settings; prefix params join the
    route params.
  - `createRepository({ baseUrl, adapter, headers, ... }).mergeAll(routes).build()`.
  
  **Calls that never throw**
  
  - Every call resolves with `{ ok, data, error, status, statusText, headers }`; `data` and
    `error` are mutually exclusive. `caller.orThrow()` rejects instead.
  - Tagged errors: `ApiError`, `ValidationError`, `TimeoutError`, `AbortError`, `NetworkError`,
    `UnknownError`, all extending `TaggedError`. `matchError` for exhaustive handling.
  - Custom errors per status on routes and repositories (`errors: { 404: ... }`), typed into the
    `error` union; `errorFromSchema` validates the error body first. Factories may be async.
  - Sensitive headers (`authorization`, `cookie`, anything with `token`/`secret`/`password`) are
    redacted in errors and in `onError`; configurable with `redactHeaders`.
  
  **Transport**
  
  - `fetchAdapter` (default), `endpoint-kit/axios`, `endpoint-kit/ofetch`, or a custom adapter.
  - Middleware pipeline (`middlewares` on repositories and routes) around the adapter.
  - Per-attempt `timeout`, `retry` with backoff and `Retry-After`, opt-in `cache` with TTL,
    in-flight dedupe, tags and invalidation. Each configurable per repository, route and call.
  - `querySerializer`: `arrayFormat` and `objectFormat` conventions or a custom function.
  - `bodyType: 'multipart' | 'form'`; `responseType: 'stream' | 'sse'` with per-event validation.
  - `paginate(route, { next, items })` adds `caller.pages()` and `caller.items()` iterators.
  - Hooks `onRequest`, `onResponse`, `onError` with attempt numbers.
  
  **Ecosystem**
  
  - `endpoint-kit/tanstack-query`: `routeQuery`, `routeInfiniteQuery`, `routeKey`, `routeKeyPrefix`.
  - `endpoint-kit/testing`: `mockAdapter` with pattern-matched handlers and recorded calls.
  - `endpoint-kit/server`: `createFetchHandler(routes, handlers)` and `registerHono` to serve the
    same declarations with validated, typed handlers on Bun, Deno, Workers, Next.js or Hono.
  - `endpoint-kit/openapi` and the `endpoint-kit openapi` CLI: generate routes, zod schemas and
    per-status error classes from an OpenAPI 3 document.

Managed by [Changesets](https://github.com/changesets/changesets). Entries are generated on release.
