/**
 * The client side of `contract.ts`, and a small end-to-end run against `server.ts`:
 * start the Node server on a random port, talk to it through the typed client, stop it.
 */
import { createRepository, matchError } from '../src/index.js';

import { routes, sharedErrors, TodoNotFoundError } from './contract.js';
import { resetStore, startNodeServer } from './server.js';

export function createClient(baseUrl: string) {
  return createRepository({
    baseUrl: `${baseUrl}/api`,
    errors: sharedErrors,
    retry: false,
  })
    .mergeAll(routes)
    .build();
}

export async function main(): Promise<void> {
  resetStore([
    { title: 'Write the contract', done: true },
    { title: 'Serve it', done: false },
  ]);
  const server = await startNodeServer();
  const api = createClient(server.url);
  const headers = { 'x-api-key': 'dev-key' };

  try {
    // Create: `body` is typed from newTodoSchema, `done` is optional thanks to .default(false)
    const created = await api.createTodo({ headers, body: { title: 'Call it' } });
    if (created.error) throw created.error;
    console.log('created', created.status, created.headers['location'], created.data);

    // Pagination from the contract: items() walks every page
    for await (const todo of api.listTodos.items({ headers, query: { perPage: 2 } })) {
      console.log('todo', todo.id, todo.title, todo.done ? '✓' : '·');
    }

    // Errors round-trip as the shared classes
    const missing = await api.getTodo({ headers, params: { id: 999 } });
    if (missing.error) {
      console.log(
        'error:',
        matchError(missing.error, {
          TodoNotFoundError: (e) => `no todo ${String(e.id)}`,
          UnauthorizedError: () => 'check the API key',
          _: (e) => e.message,
        }),
      );
      console.log('is TodoNotFoundError:', missing.error instanceof TodoNotFoundError);
    }

    const denied = await api.getTodo({
      headers: { 'x-api-key': 'wrong' },
      params: { id: 1 },
    });
    console.log('denied:', denied.error?._tag);

    // Validation happens before the request leaves: this never reaches the server
    const invalid = await api.createTodo({ headers, body: { title: '' } });
    console.log('invalid:', invalid.error?._tag);

    const gone = await api.deleteTodo({ headers, params: { id: created.data.id } });
    console.log('deleted:', gone.ok && gone.status);
  } finally {
    server.close();
  }
}

// Run with: node --experimental-strip-types examples/client.ts (after building, or via tsx)
if (process.argv[1]?.endsWith('client.ts')) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
