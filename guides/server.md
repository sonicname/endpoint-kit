# Serving the contract

The same route declarations that build the client can serve the API. One file holds the
contract, the server implements one handler per route, the client calls them, and the compiler
checks both ends. Full, type-checked source: [`examples/contract.ts`](../examples/contract.ts),
[`examples/server.ts`](../examples/server.ts), [`examples/client.ts`](../examples/client.ts).

## 1. The contract

Everything both sides need: schemas, routes, and the error classes they share.

```ts
export class TodoNotFoundError extends TaggedError<'TodoNotFoundError'> {
  readonly _tag = 'TodoNotFoundError';
  readonly status = 404; // the server answers with this; the client maps 404 back to the class
  constructor(readonly id: number) {
    super(`Todo ${String(id)} not found`);
  }
  get data() {
    return { id: this.id }; // becomes the `data` field of the error body
  }
}

/** Wire format of a thrown TodoNotFoundError: { error, message, data } */
const notFoundBody = z.object({ message: z.string(), data: z.object({ id: z.number() }) });

const apiKeyHeader = z.object({ 'x-api-key': z.string().min(1) });

export const routes = groupRoutes('/todos', {
  getTodo: createRoute.get('/:id', {
    headers: apiKeyHeader, // typed on the client, validated on the server
    params: { id: z.coerce.number().int() },
    response: todoSchema,
    errors: { 404: errorFromSchema(notFoundBody, (body) => new TodoNotFoundError(body.data.id)) },
  }),
  createTodo: createRoute.post('/', {
    headers: apiKeyHeader,
    body: newTodoSchema,
    response: todoSchema,
  }),
  // ...
});
```

## 2. Handlers

`RouteHandlers<typeof routes>` forces one handler per route and types its context from the
schemas. `params`, `query`, `body` and `headers` are the validated _outputs_: defaults applied,
coercions done.

```ts
import { createFetchHandler, reply } from 'endpoint-kit/server';
import type { RouteHandlers } from 'endpoint-kit/server';

export const handlers: RouteHandlers<typeof routes> = {
  getTodo: ({ headers, params }) => {
    authorize(headers); // headers: { 'x-api-key': string }
    return todos.get(params.id) ?? throwNotFound(params.id); // params.id: number
  },
  createTodo: ({ headers, body }) => {
    authorize(headers);
    const todo = insert(body.title, body.done); // body.done: boolean (default applied)
    return reply(201, todo, { location: `/todos/${String(todo.id)}` });
  },
  deleteTodo: ({ params }) => {
    remove(params.id);
    return undefined; // responseType: 'none' → 204
  },
};
```

A handler returns the response body (validated against `response`, invalid → 500), a
`reply(status, body?, headers?)`, or a raw `Response`. To fail, throw:

- a `reply(...)` for an ad-hoc status;
- one of the contract's `TaggedError` classes: its `status` becomes the HTTP status and the body
  is `{ error: _tag, message, data? }`, which the client's `errors` map turns back into the same
  class. Classes without `status` answer 500; `errorStatus` in the options overrides that.

Invalid input answers 400 with the schema issues, unknown paths 404, wrong methods 405 with an
`Allow` header. Query, params, headers and form values arrive as strings, so validation retries
with numbers and booleans coerced when the first pass fails (`coerce: false` disables it).

## 3. Deploy it three ways

```ts
// Fetch API runtimes: Bun, Deno, Cloudflare Workers, Next.js route handlers
export const fetchHandler = createFetchHandler(routes, handlers, { basePath: '/api' });
export default { fetch: fetchHandler }; // Bun
export const GET = fetchHandler,
  POST = fetchHandler; // Next.js

// Node.js, Express, Connect
import { createNodeHandler } from 'endpoint-kit/server/node';
const nodeHandler = createNodeHandler(routes, handlers, { basePath: '/api', trustProxy: true });
http.createServer(nodeHandler).listen(3000);
app.use(nodeHandler); // Express: unmatched paths fall through to next()

// Hono: one Hono route per declaration, so Hono middlewares and app.routes see them
import { registerHono } from 'endpoint-kit/server';
registerHono(app, routes, handlers, { basePath: '/api' });
```

The Node adapter streams request and response bodies, forwards every `set-cookie`, and
rebuilds the URL from `x-forwarded-proto` / `x-forwarded-host` only when `trustProxy` is set.

## 4. The client

```ts
const api = createRepository({ baseUrl: `${origin}/api`, errors: sharedErrors })
  .mergeAll(routes)
  .build();

const { data, error } = await api.getTodo({ headers: { 'x-api-key': key }, params: { id: 999 } });
//             ^? RouteError | TodoNotFoundError | UnauthorizedError | null
if (error?._tag === 'TodoNotFoundError') console.log(error.id); // 999, from the server's body
```

Pagination declared on the contract works on the client (`api.listTodos.items(...)`) while the
server only implements the single-page handler.

## 5. Test the server through the client

No port needed: point `fetchAdapter` at the handler.

```ts
const api = createRepository({
  baseUrl: 'https://test/api',
  adapter: fetchAdapter({ fetch: (input, init) => fetchHandler(new Request(input, init)) }),
})
  .mergeAll(routes)
  .build();

const { error } = await api.getTodo({ headers, params: { id: 999 } });
expect(error).toBeInstanceOf(TodoNotFoundError);
```

This exercises validation on both sides, the error mapping, and your handlers, in one call.

## What the server does not do

- Authentication, rate limiting, CORS: use the host framework's middleware (Hono, Express) or
  wrap `fetchHandler`. The example keeps `authorize()` inside handlers for brevity.
- Express/Connect is the only non-Fetch runtime; Fastify users can mount the Node handler on a
  raw route or use `createFetchHandler` with Fastify's Fetch-compatible layers.
- `transform`/envelopes: a handler returns exactly what `response` describes.
