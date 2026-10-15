/**
 * The server side of `contract.ts`: one handler per route, typed from the schemas, and the
 * same handlers served three ways (Fetch API runtimes, Node/Express, Hono).
 */
import { Hono } from 'hono';
import { createServer } from 'node:http';

import { createFetchHandler, registerHono, reply } from '../src/server/index.js';
import type { RouteHandlers } from '../src/server/index.js';
import { createNodeHandler } from '../src/server/node.js';

import { routes, TodoNotFoundError, UnauthorizedError } from './contract.js';
import type { Todo } from './contract.js';

// --- A tiny in-memory store ------------------------------------------------

const todos = new Map<number, Todo>();
let nextId = 1;

export function resetStore(seed: Pick<Todo, 'title' | 'done'>[] = []): void {
  todos.clear();
  nextId = 1;
  for (const item of seed) insert(item.title, item.done);
}

function insert(title: string, done: boolean): Todo {
  const todo: Todo = { id: nextId++, title, done, createdAt: new Date().toISOString() };
  todos.set(todo.id, todo);
  return todo;
}

function find(id: number): Todo {
  const todo = todos.get(id);
  // Throwing the shared error class answers 404 with { error, message, data } and the
  // client turns it back into a TodoNotFoundError.
  if (!todo) throw new TodoNotFoundError(id);
  return todo;
}

// --- Handlers --------------------------------------------------------------
//
// `headers`, `params`, `query` and `body` are the validated schema *outputs*: `query.page`
// is a number with its default applied, `params.id` is already coerced.

const API_KEY = process.env['API_KEY'] ?? 'dev-key';

function authorize(headers: { 'x-api-key': string }): void {
  if (headers['x-api-key'] !== API_KEY) throw new UnauthorizedError();
}

export const handlers: RouteHandlers<typeof routes> = {
  listTodos: ({ headers, query }) => {
    authorize(headers);
    const all = [...todos.values()].filter(
      (t) => query.done === undefined || t.done === query.done,
    );
    const start = (query.page - 1) * query.perPage;
    return { items: all.slice(start, start + query.perPage), total: all.length };
  },

  getTodo: ({ headers, params }) => {
    authorize(headers);
    return find(params.id);
  },

  createTodo: ({ headers, body }) => {
    authorize(headers);
    const todo = insert(body.title, body.done);
    // reply() when the status or headers matter; the body is still validated against `response`.
    return reply(201, todo, { location: `/todos/${String(todo.id)}` });
  },

  toggleTodo: ({ headers, params }) => {
    authorize(headers);
    const todo = find(params.id);
    todo.done = !todo.done;
    return todo;
  },

  deleteTodo: ({ headers, params }) => {
    authorize(headers);
    find(params.id);
    todos.delete(params.id);
    return undefined; // responseType: 'none' → 204
  },
};

// --- 1. Fetch API runtimes: Bun, Deno, Cloudflare Workers, Next.js --------

export const fetchHandler = createFetchHandler(routes, handlers, {
  basePath: '/api',
  // Unexpected errors: log and hide details.
  onError: (error, { route }) => {
    console.error(`[${route}]`, error);
    return new Response(JSON.stringify({ error: 'InternalServerError' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  },
});

// Bun:                 export default { fetch: fetchHandler };
// Next.js app router:  export const GET = fetchHandler; export const POST = fetchHandler; ...

// --- 2. Node.js / Express ----------------------------------------------------

export const nodeHandler = createNodeHandler(routes, handlers, { basePath: '/api' });

/** Start a plain Node server on `port` (0 = random). Resolves with the base URL. */
export function startNodeServer(port = 0): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    void nodeHandler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({ url: `http://127.0.0.1:${String(actualPort)}`, close: () => server.close() });
    });
  });
}

// Express: app.use(nodeHandler) — paths that match no route fall through to the next middleware.

// --- 3. Hono ----------------------------------------------------------------

export function createHonoApp(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('x-powered-by', 'endpoint-kit');
  });
  registerHono(app, routes, handlers, { basePath: '/api' });
  return app;
}
