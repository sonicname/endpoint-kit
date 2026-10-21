# endpoint-kit

## 0.3.0

### Minor Changes

- **Server**
  
  - `handleRoute(name, route, handler, { request, params }, options)`: validate and answer one
    route whose request another router already matched (React Router loaders, Hono routes...).
    `createFetchHandler` is now route matching plus `handleRoute`.
  - `errorToResponse(error, { route, request }, options)`: the response for an error thrown while
    handling a route (thrown `reply`, `ValidationError`, `TaggedError`, `onError`), for code that
    wraps handlers.
  - `HttpReply#toResponse()` turns a `reply()` into a `Response`.
  - A handler for an `sse` route may return an async iterable: each event is validated against
    `response` and streamed as a `data:` line; a `ReadableStream` is still passed through.
  - Errors and replies are recognised across copies of endpoint-kit: a `TaggedError` subclass
    imported from `endpoint-kit` and thrown in a handler served by `endpoint-kit/server` (two
    separate bundles) now answers with its `status` instead of 500. `HttpReply.is(value)` does the
    same for replies.

## 0.2.0

### Minor Changes

- 2e841b4: **Routes**
  
  - `headers` on a route may now be a schema. The caller's `headers` are then typed and validated,
    and server handlers receive the validated object instead of raw `Headers`.
  - `errors` maps accept `'4XX'`, `'5XX'` and `'default'` keys besides exact statuses; lookup is
    exact status, then class, then default. `findErrorFactory` is exported.
  
  **Server**
  
  - `endpoint-kit/server/node`: `createNodeHandler(routes, handlers)` for `http.createServer`,
    Express and Connect, with streamed bodies, `set-cookie` support, `trustProxy`, and fall-through
    to `next()` for unmatched paths.
  - Thrown `TaggedError`s answer with their `status` (or `errorStatus`, else 500) and
    `{ error: _tag, message, data? }`, so client and server share one set of error classes.
  - `coerce: false` disables the string-to-number/boolean retry when validating params, query,
    headers and form bodies.
  - `registerHono` is tested against a real Hono app.
  
  **OpenAPI generator**
  
  - Header parameters become a `headers` schema on the route (previously a warning).
  - `4XX`, `5XX` and `default` responses generate `ClientError`, `ServerError` and
    `UnexpectedError` classes and the matching `errors` entries.
  
  **Housekeeping**
  
  - Repository moved to `sonicname/endpoint-kit`; pnpm settings moved from `.npmrc` to
    `pnpm-workspace.yaml`.

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
