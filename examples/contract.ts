/**
 * The contract: route declarations shared by the server (`server.ts`) and the client
 * (`client.ts`). This is the only file both sides import, so a change here is a change
 * for everyone, checked by the compiler on both ends.
 */
import { z } from 'zod';

import { createRoute, errorFromSchema, groupRoutes, paginate, TaggedError } from '../src/index.js';

// --- Schemas ---------------------------------------------------------------

export const todoSchema = z.object({
  id: z.number().int(),
  title: z.string().min(1).max(200),
  done: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type Todo = z.infer<typeof todoSchema>;

export const newTodoSchema = todoSchema.pick({ title: true }).extend({
  done: z.boolean().default(false),
});

/** Wire format of a thrown `TodoNotFoundError`: `{ error, message, data }` as the server emits it. */
export const notFoundBody = z.object({ message: z.string(), data: z.object({ id: z.number() }) });

// --- Errors shared by both sides -------------------------------------------
//
// Each class carries `status`, so the server can `throw` it and answer with the right code,
// while the client maps that status back to the same class through `errors` below.

export class TodoNotFoundError extends TaggedError<'TodoNotFoundError'> {
  readonly _tag = 'TodoNotFoundError';
  readonly status = 404;
  constructor(readonly id: number) {
    super(`Todo ${String(id)} not found`);
  }
  /** Sent as the `data` field of the server's error body, so the client can rebuild `id`. */
  get data(): { id: number } {
    return { id: this.id };
  }
}

export class UnauthorizedError extends TaggedError<'UnauthorizedError'> {
  readonly _tag = 'UnauthorizedError';
  readonly status = 401;
  constructor() {
    super('Missing or invalid API key');
  }
}

// --- Routes ----------------------------------------------------------------

const apiKeyHeader = z.object({ 'x-api-key': z.string().min(1) });

export const routes = groupRoutes(
  {
    prefix: '/todos',
    // Every route requires the API key header: typed on the client, validated on the server.
    headers: {}, // (static headers are merged under each route's own; schemas below win)
  },
  {
    listTodos: paginate(
      createRoute.get('/', {
        headers: apiKeyHeader,
        query: z.object({
          page: z.number().int().positive().default(1),
          perPage: z.number().int().min(1).max(50).default(10),
          done: z.boolean().optional(),
        }),
        response: z.object({ items: z.array(todoSchema), total: z.number().int() }),
      }),
      {
        next: ({ data, input }) => {
          const page = input.query?.page ?? 1;
          const perPage = input.query?.perPage ?? 10;
          return page * perPage < data.total
            ? { ...input, query: { ...input.query, page: page + 1 } }
            : null;
        },
        items: (data) => data.items,
      },
    ),

    getTodo: createRoute.get('/:id', {
      headers: apiKeyHeader,
      params: { id: z.coerce.number().int() },
      response: todoSchema,
      errors: {
        404: errorFromSchema(notFoundBody, (body) => new TodoNotFoundError(body.data.id)),
      },
    }),

    createTodo: createRoute.post('/', {
      headers: apiKeyHeader,
      body: newTodoSchema,
      response: todoSchema,
    }),

    toggleTodo: createRoute.patch('/:id/toggle', {
      headers: apiKeyHeader,
      params: { id: z.coerce.number().int() },
      response: todoSchema,
      errors: {
        404: errorFromSchema(notFoundBody, (body) => new TodoNotFoundError(body.data.id)),
      },
    }),

    deleteTodo: createRoute.delete('/:id', {
      headers: apiKeyHeader,
      params: { id: z.coerce.number().int() },
      responseType: 'none',
      errors: {
        404: errorFromSchema(notFoundBody, (body) => new TodoNotFoundError(body.data.id)),
      },
    }),
  },
);

/** Errors every route can produce besides the built-ins, for the repository-level map. */
export const sharedErrors = {
  401: () => new UnauthorizedError(),
};
