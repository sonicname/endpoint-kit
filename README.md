# endpoint-kit

[![CI](https://github.com/sonicname/api-repositories/actions/workflows/ci.yml/badge.svg)](https://github.com/sonicname/api-repositories/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/endpoint-kit.svg)](https://www.npmjs.com/package/endpoint-kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Declare your backend endpoints once, get a fully typed API client.

- **Schema driven**: `params`, `query`, `body` and `response` are described with Zod v4 (or any
  [Standard Schema](https://standardschema.dev) library such as Valibot or ArkType).
- **Full IDE inference**: path params are inferred from `"/users/:username"`, inputs come from the
  schema input types, the result is the response schema output type.
- **Organised**: `createRoute.get('/path', {...})` shorthands and `groupRoutes` to prefix and
  share settings across a set of routes.
- **OpenAPI in, routes out**: `npx endpoint-kit openapi spec.json -o routes.ts` generates the
  declarations and zod schemas from an existing spec.
- **Transport agnostic**: ships with adapters for `fetch` (default), axios and ofetch. Write your
  own in a few lines.
- **Validated at runtime**: bad inputs are rejected before the request is sent, unexpected
  responses throw a `ValidationError`, non-2xx statuses throw an `ApiError`.
- **No try/catch needed**: every call resolves with `{ data, error }`. `error` is a tagged
  union of the built-in errors plus the custom ones you declare per route or repository, so
  `matchError` can be exhaustive. `orThrow()` is there when you do want a rejection.
- **Resilient**: per-attempt timeout, retry with exponential backoff and `Retry-After`, and an
  opt-in cache with TTL, request deduplication and tag invalidation. All configurable per
  repository, per route and per call.
- **Extensible**: a middleware pipeline around the transport for logging, auth refresh, mocking...
- **Tiny**: no runtime dependencies, under 8 kB minified.

## Install

```bash
pnpm add endpoint-kit zod
```

Zod is optional. Any schema library implementing Standard Schema works.

## Quick start

```ts
import { createRepository, createRoute } from 'endpoint-kit';
import { z } from 'zod';

const getUser = createRoute({
  method: 'GET',
  path: '/users/:username',
  response: z.object({ id: z.number(), login: z.string() }),
});

const listRepos = createRoute({
  method: 'GET',
  path: '/users/:username/repos',
  query: z.object({
    page: z.number().int().positive().optional(),
    sort: z.enum(['created', 'updated']).optional(),
  }),
  response: z.array(z.object({ name: z.string(), stargazers_count: z.number() })),
});

const createIssue = createRoute({
  method: 'POST',
  path: '/repos/:owner/:repo/issues',
  params: { owner: z.string().min(1) }, // repo stays string | number
  body: z.object({ title: z.string().min(1), labels: z.array(z.string()).default([]) }),
  response: z.object({ number: z.number(), html_url: z.string() }),
});

const github = createRepository({
  baseUrl: 'https://api.github.com',
  headers: () => ({ authorization: `Bearer ${getToken()}` }),
})
  .mergeAll({ getUser, listRepos, createIssue })
  .build();

// Everything below is fully typed and autocompleted.
const { data: user, error } = await github.getUser({ params: { username: 'octocat' } });
if (error) {
  //  ^? RouteError (ApiError | ValidationError | TimeoutError | AbortError | NetworkError | UnknownError)
  console.error(error.message);
} else {
  user.login; // user: { id: number; login: string }
}

const repos = await github.listRepos.orThrow({
  params: { username: 'octocat' },
  query: { sort: 'updated' },
}); // rejects instead of returning { error }

const issue = await github.createIssue({
  params: { owner: 'octocat', repo: 'hello-world' },
  body: { title: 'Bug report' }, // labels is optional thanks to .default([])
});
```

## Routes

`createRoute` accepts:

| Field          | Description                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `method`       | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` or `OPTIONS`.                                                                                                                                                             |
| `path`         | Path relative to `baseUrl`. `:name` segments become path params.                                                                                                                                                          |
| `params`       | Path param validation: a per-key map `{ id: z.coerce.number() }` (keys are autocompleted from `path`) or a whole-object schema. Both are checked against the path at compile time. Params without a schema accept `string | number`. |
| `query`        | Schema for the query string. `undefined` values are skipped; arrays and nested objects follow `querySerializer` (`repeat`/`brackets`/`indices`/`comma`, `json`/`brackets`/`dots`).                                        |
| `body`         | Schema for the request body. Encoded per `bodyType`: `json` (default), `multipart` (`FormData`, for `File`/`Blob` fields) or `form` (`application/x-www-form-urlencoded`).                                                |
| `response`     | Schema for the response body. Its output type is what the caller resolves with.                                                                                                                                           |
| `responseType` | `json` (default), `text`, `blob`, `arrayBuffer`, `none`, `stream` (a `ReadableStream<Uint8Array>`) or `sse` (an `AsyncIterable` of server-sent events, validated per event when `response` is set).                       |
| `headers`      | Static headers for this route.                                                                                                                                                                                            |
| `options`      | Adapter specific options (axios config, ofetch options, `RequestInit`).                                                                                                                                                   |

A route can be reused across several repositories.

### Uploads, forms, streams and SSE

```ts
const upload = createRoute.post(/files, {
  bodyType: multipart, // body becomes FormData; File/Blob fields are appended as files
  body: z.object({ file: z.instanceof(Blob), title: z.string() }),
});

const login = createRoute.post(/login, {
  bodyType: form, // application/x-www-form-urlencoded, using querySerializer rules
  body: z.object({ user: z.string(), password: z.string() }),
});

const download = createRoute.get(/export, { responseType: stream });
const { data: stream } = await api.download(); // ReadableStream<Uint8Array>

const events = createRoute.get(/events, {
  responseType: sse,
  response: z.object({ type: z.string(), payload: z.unknown() }),
});
const { data } = await api.events();
for await (const event of data) {
  //            ^? { type: string; payload: unknown }, one per SSE message
}
```

Streams and SSE responses are never cached. Upload progress is not available with `fetch`;
pass `options: { onUploadProgress }` through the axios adapter if you need it.

### Pagination

Wrap a route with `paginate` to get `caller.pages()` and, with an `items` extractor,
`caller.items()`. Both are async iterables and reject with the typed error on failure.

```ts
import { paginate } from endpoint-kit;

const listRepos = paginate(
  createRoute.get(/users/:username/repos, {
    query: z.object({ page: z.number().int().positive().optional() }),
    response: z.array(repoSchema),
  }),
  {
    // Return the input for the next page, or null when done.
    next: ({ data, input, page }) =>
      data.length === 0 ? null : { ...input, query: { ...input.query, page: page + 1 } },
    items: (data) => data,
  },
);

for await (const repo of api.listRepos.items({ params: { username: octocat } })) {
  //             ^? Repo
}
for await (const page of api.listRepos.pages({ params: { username: octocat } }, { maxPages: 3 })) {
  //             ^? Repo[]
}
```

Cursor-based APIs work the same way: read the cursor from `data` and put it in the next
`query`. `next` also receives `status` and `headers`, for `Link` header pagination.

### Method helpers

`createRoute.get`, `.post`, `.put`, `.patch`, `.delete`, `.head` and `.options` take the path
first and the remaining fields second. Inference and the params check are identical.

```ts
const getUser = createRoute.get('/users/:username', { response: userSchema });
const createIssue = createRoute.post('/repos/:owner/:repo/issues', { body: issueSchema });
const ping = createRoute.get('/ping', { responseType: 'text' });
```

### Groups

`groupRoutes` prefixes a set of routes and can apply shared settings. Params in the prefix become
part of every route's params. The result is a plain route map, so groups nest and spread into
`mergeAll`.

```ts
import { groupRoutes } from 'endpoint-kit';

const admin = groupRoutes('/admin', {
  listUsers: createRoute.get('/users'),
  getUser: createRoute.get('/users/:id'), // path "/admin/users/:id"
});

const org = groupRoutes(
  { prefix: '/orgs/:org', headers: { 'x-scope': 'org' }, retry: 2, cache: 10_000 },
  {
    listRepos: createRoute.get('/repos'), // params: { org }
    getRepo: createRoute.get('/repos/:repo'), // params: { org, repo }
  },
);

const api = createRepository({ baseUrl })
  .mergeAll({ ...admin, ...org })
  .build();
await api.getRepo({ params: { org: 'acme', repo: 'web' } });
```

Group `headers` and `options` are merged under the route's own, group `middlewares` run outside
the route's own, and group `timeout`, `retry` and `cache` apply only to routes that do not set
them. Write the prefix without a trailing slash.

### Path params

Params are inferred from the `:name` segments of `path`. Add schemas only where you need them:

```ts
const getIssue = createRoute({
  method: 'GET',
  path: '/repos/:owner/:repo/issues/:number',
  params: {
    number: z.coerce.number().int().positive(), // keys are suggested by the IDE
  },
});

await api.getIssue({ params: { owner: 'octocat', repo: 'hello-world', number: '42' } });
```

A whole-object schema works too and must require exactly the path params:

```ts
params: z.object({ owner: z.string(), repo: z.string() });
```

Mismatches are compile errors with a readable message, for example
`params: "repo" is not a param of path "/users/:username"` or
`params: path "/repos/:owner/:repo" has param ":repo" but the schema does not require it`.

## Calling a route

Each route becomes a function on the built client. It takes a single object with `params`,
`query` and `body` (only the ones the route declares, required only when the schema has required
keys) plus:

```ts
await github.getUser({
  params: { username: 'octocat' },
  headers: { 'x-request-id': '123' }, // merged over repository and route headers
  signal: controller.signal,
  options: { cache: 'no-store' }, // merged over repository and route options
});
```

When nothing is required, the argument can be omitted entirely: `await api.ping()`.

Each call resolves with a result object and never rejects:

```ts
const result = await github.getUser({ params: { username: 'octocat' } });
// { ok: true,  data, error: null, status, statusText, headers }
// { ok: false, data: null, error }
```

`data` and `error` are mutually exclusive, so `if (error)` narrows `data` and `if (result.ok)`
narrows everything. Use `caller.orThrow(input)` to get the data directly and a rejection on
failure.

`client.$routes` holds the definitions and `client.$config` the resolved configuration.

## Repository options

```ts
createRepository({
  baseUrl: 'https://api.example.com',
  adapter: fetchAdapter({ init: { credentials: 'include' } }), // default: fetchAdapter()
  headers: async () => ({ authorization: `Bearer ${await getToken()}` }),
  options: {}, // adapter specific, merged into every request
  querySerializer: { arrayFormat: 'brackets', objectFormat: 'brackets' }, // qs style; routes can override
  validateResponse: true, // set false to skip response schema validation
  isSuccess: (status) => status < 400, // default: 200 <= status < 300
  hooks: {
    onRequest: ({ route, request, attempt }) => {},
    onResponse: ({ route, request, response, attempt }) => {},
    onError: ({ route, request, error }) => {},
  },
  middlewares: [], // see below
  timeout: 10_000, // per attempt, in ms
  retry: { attempts: 3 }, // or just a number
  cache: { ttl: 30_000 }, // or just a number; GET/HEAD only
});
```

Routes can be registered with `.mergeAll({ ... })` or one at a time with `.addRoute('name', route)`.

## Timeout, retry and cache

The three policies follow the same layering: repository defaults, overridden by the route,
overridden by the call. A number is a shorthand (`timeout` ms, retry `attempts`, cache `ttl`),
an object is shallow-merged over the level below, and `false` disables the policy.

```ts
const listRepos = createRoute({
  method: 'GET',
  path: '/users/:username/repos',
  retry: { attempts: 5 }, // merged over the repository retry options
  cache: { ttl: 60_000, tags: ['repos'] },
});

const createRepo = createRoute({
  method: 'POST',
  path: '/user/repos',
  retry: false, // never retry this one
  invalidates: ['repos'], // drop cached entries tagged "repos" after success
});

await github.listRepos({ params: { username: 'octocat' }, timeout: 2_000, cache: false });
```

### Timeout

Applies to each attempt. When it fires the call rejects with a `TimeoutError`. A caller
`signal` still works: whichever aborts first wins.

### Retry

Defaults: 3 attempts, idempotent methods only (`GET, HEAD, PUT, DELETE, OPTIONS`), on statuses
`408, 425, 429, 500, 502, 503, 504` or on thrown errors (network, timeout), exponential backoff
with jitter starting at 300 ms, and `Retry-After` honoured when present. Requests whose body is a
stream are never retried, and a caller abort stops everything.

```ts
retry: {
  attempts: 4,
  delay: ({ attempt }) => attempt * 500, // or a fixed number of ms
  methods: ['GET', 'POST'],
  statuses: [500, 503],
  respectRetryAfter: true,
  // Replace the decision entirely; call defaultShouldRetry to extend it instead.
  shouldRetry: (ctx) => defaultShouldRetry(ctx) || ctx.response?.status === 418,
}
```

### Cache

Opt-in through `ttl`. Only successful `GET`/`HEAD` responses are stored (override with
`methods`). Concurrent identical requests share one in-flight request. The default key is
`method + url`; add header names with `vary` or supply your own `key` function. The store is an
in-memory `Map` unless you pass `storage` (any object implementing `CacheStorage`, sync or async).

```ts
cache: { ttl: 30_000, vary: ['Authorization'], tags: ['user'] }

await github.$cache.invalidate('user', 'repos');
await github.$cache.delete('GET https://api.github.com/users/octocat');
await github.$cache.clear();
```

This is deliberately small. For stale-while-revalidate, background refetching or optimistic
updates, pair the client with TanStack Query or SWR and leave `cache` off.

## Middlewares

A middleware wraps the transport: `(request, next, context) => Promise<AdapterResponse>`. Call
`next` to continue, return a response to short-circuit, throw to fail. Repository middlewares run
outermost, then route middlewares, then the built-in cache, retry, timeout and hooks, then the
adapter.

```ts
import type { Middleware } from 'endpoint-kit';

const logging: Middleware = async (request, next, { route, attempt }) => {
  const started = Date.now();
  const response = await next(request);
  console.log(route, attempt, response.status, `${Date.now() - started}ms`);
  return response;
};

const refreshOn401: Middleware = async (request, next) => {
  const response = await next(request);
  if (response.status !== 401) return response;
  const token = await refreshToken();
  return next({ ...request, headers: { ...request.headers, authorization: `Bearer ${token}` } });
};

createRepository({ baseUrl, middlewares: [logging, refreshOn401] });
createRoute({ method: 'GET', path: '/x', middlewares: [mockInDev] });
```

## Adapters

```ts
import axios from 'axios';
import { ofetch } from 'ofetch';
import { fetchAdapter } from 'endpoint-kit';
import { axiosAdapter } from 'endpoint-kit/axios';
import { ofetchAdapter } from 'endpoint-kit/ofetch';

createRepository({ baseUrl, adapter: fetchAdapter() });
createRepository({ baseUrl, adapter: axiosAdapter(axios.create({ timeout: 5000 })) });
createRepository({ baseUrl, adapter: ofetchAdapter(ofetch.create({ retry: 2 })) });
```

The axios and ofetch adapters live on their own subpaths so the main entry stays fetch-only;
neither library is a dependency of this package. A custom adapter only needs a
`request(request: AdapterRequest): Promise<AdapterResponse>` method and must not throw on
non-2xx statuses; the repository decides what counts as a failure.

## Errors

`error` is always a `TaggedError`: an `Error` with a literal `_tag` to discriminate on. The
built-in ones form the `RouteError` union:

| Class             | `_tag`              | When                                                                                   |
| ----------------- | ------------------- | -------------------------------------------------------------------------------------- |
| `ApiError`        | `'ApiError'`        | Non-success status with no custom error declared. Has `status`, `data`, `headers`.     |
| `ValidationError` | `'ValidationError'` | Params, query, body, response or error body failed its schema. Has `target`, `issues`. |
| `TimeoutError`    | `'TimeoutError'`    | The per-attempt timeout fired. Has `timeout`.                                          |
| `AbortError`      | `'AbortError'`      | The caller's `signal` aborted. `cause` is the reason.                                  |
| `NetworkError`    | `'NetworkError'`    | The transport could not reach the server. `cause` is the raw error.                    |
| `UnknownError`    | `'UnknownError'`    | Anything else thrown (a middleware bug...). `cause` is the raw value.                  |

Every error carries `route`, the name of the route that was called.

### Custom errors

Declare your own errors by HTTP status on a route or on the repository. The factory receives the
failed response and the type it returns joins the `error` union of every affected caller.

```ts
import { TaggedError } from 'endpoint-kit';

class NotFoundError extends TaggedError<'NotFoundError'> {
  readonly _tag = 'NotFoundError';
  constructor(readonly resource: string) {
    super(`${resource} not found`);
  }
}

class UnauthorizedError extends TaggedError<'UnauthorizedError'> {
  readonly _tag = 'UnauthorizedError';
}

const getRepo = createRoute.get('/repos/:owner/:repo', {
  response: repoSchema,
  errors: { 404: (ctx) => new NotFoundError(`repo ${ctx.data.name}`) },
});

const github = createRepository({
  baseUrl,
  errors: { 401: () => new UnauthorizedError('Sign in first') }, // applies to every route
})
  .mergeAll({ getRepo })
  .build();

const { error } = await github.getRepo({ params: { owner: 'octocat', repo: 'x' } });
//      ^? RouteError | NotFoundError | UnauthorizedError | null
```

Route factories take precedence over repository ones. Any other failing status is an `ApiError`.
The factory context has `status`, `statusText`, `headers`, `data` (parsed body, `unknown`) and
`route`. Factories may be async. Tagged errors thrown from your own middlewares pass through
untouched as well.

To get a typed body, wrap the factory with `errorFromSchema`. The body is validated first and
`map` receives the schema output; a body that does not match yields a `ValidationError` with
`target: 'error'`.

```ts
import { errorFromSchema } from 'endpoint-kit';

const notFoundBody = z.object({ resource: z.string(), id: z.coerce.number() });

const getRepo = createRoute.get('/repos/:id', {
  errors: {
    404: errorFromSchema(notFoundBody, (data) => new NotFoundError(data.resource, data.id)),
    //                                   ^? { resource: string; id: number }
  },
});
```

### Handling errors

Narrow on `_tag` directly, or use `matchError` for an exhaustive switch. Handlers are typed per
tag and you must cover every tag or provide a `_` fallback.

```ts
import { matchError } from 'endpoint-kit';

const { data, error } = await github.getRepo({ params: { owner, repo } });
if (error) {
  if (error._tag === 'NotFoundError') return showEmptyState(error.resource);

  return showToast(
    matchError(error, {
      UnauthorizedError: () => 'Please sign in',
      ApiError: (e) => `Server said ${e.status}`,
      TimeoutError: () => 'Still loading, hang on',
      _: (e) => e.message,
    }),
  );
}
data.name;
```

`RouteFailure<typeof getRepo>` names the error union of a route, and `toRouteError(unknown, route)`
is the normaliser the library applies to everything thrown during a call.

## Type helpers

```ts
import type { RouteFailure, RouteInput, RouteOutput } from 'endpoint-kit';

type GetUserInput = RouteInput<typeof getUser>;
type GetUserOutput = RouteOutput<typeof getUser>;
type GetUserError = RouteFailure<typeof getUser>;
```

## Generate routes from OpenAPI

Already have a spec? Generate the route declarations and zod schemas instead of writing them:

```bash
npx endpoint-kit openapi ./openapi.json -o src/api/routes.generated.ts
# YAML specs work too once "yaml" is installed: npm i -D yaml
```

The output is plain endpoint-kit code you can read, commit and wrap:

```ts
// src/api/routes.generated.ts (excerpt)
export const Pet = z.object({ id: z.number().int(), name: z.string(), get parent() { return Pet.optional(); } });
export type Pet = z.infer<typeof Pet>;

export const routes = {
  /** List all pets */
  listPets: createRoute.get('/pets', { query: z.object({ limit: z.number().int().max(100).optional() }), response: Pets }),
  showPetById: createRoute.get('/pets/:petId', { params: { petId: z.number().int() }, response: Pet }),
  uploadPhoto: createRoute.post('/pets/:petId/photo', { bodyType: 'multipart', body: ..., responseType: 'text' }),
};
```

```ts
import { routes, servers } from './routes.generated';
const api = createRepository({ baseUrl: servers[0] }).mergeAll(routes).build();
```

What is covered: `components.schemas` (with recursion via zod getters and `$ref` ordering),
path and query parameters, JSON, multipart and form request bodies, the first 2xx response as
`json`, `text`, `blob`, `none` or `sse`, `summary`/`description`/`deprecated` as JSDoc,
`servers`. Header parameters and error response schemas are reported as warnings and left to
you (`headers` at call time, `errors` on the route). The generator is also available
programmatically from `endpoint-kit/openapi` as `generateFromOpenApi(document, options)`.

## Guides

Longer, type-checked walkthroughs live in [`guides/`](./guides/), with the full source of every
snippet under [`examples/`](./examples/):

- [TanStack Query](./guides/tanstack-query.md): `orThrow()` in `queryFn`, typed errors,
  mutations and invalidation, Suspense, SSR, and `endpoint-kit/tanstack-query` helpers
  including `useInfiniteQuery` from `paginate()`.
- [React without a data library](./guides/react.md): a `useRoute` hook with abort on unmount,
  mutations, server components.
- [Authentication and refresh tokens](./guides/auth-refresh-token.md): token store, `headers`
  provider, refresh-on-401 middleware with single-flight refresh.
- [Testing](./guides/testing.md): `mockAdapter` from `endpoint-kit/testing`, MSW, testing middlewares and timers.

## Development

| Script               | Description                                                |
| -------------------- | ---------------------------------------------------------- |
| `pnpm build`         | Build ESM, CJS and `.d.ts` into `dist/`                    |
| `pnpm dev`           | Build in watch mode                                        |
| `pnpm test`          | Run tests once                                             |
| `pnpm test:watch`    | Run tests in watch mode                                    |
| `pnpm test:coverage` | Run tests with coverage                                    |
| `pnpm typecheck`     | Type-check without emitting                                |
| `pnpm lint`          | Lint with ESLint                                           |
| `pnpm format`        | Format with Prettier                                       |
| `pnpm check:exports` | Validate `package.json` exports and types (attw + publint) |
| `pnpm size`          | Check bundle size against `.size-limit.json`               |
| `pnpm docs:api`      | Generate API docs into `docs/`                             |
| `pnpm check`         | Run everything CI runs                                     |
| `pnpm changeset`     | Add a changeset describing your change                     |

Releases are driven by [Changesets](https://github.com/changesets/changesets): run
`pnpm changeset`, merge to `main`, merge the generated "Version Packages" PR.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow.

## License

[MIT](./LICENSE) © Phạm Anh Đức
