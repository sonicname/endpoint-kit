# TanStack Query

TanStack Query owns caching, deduplication, refetching and Suspense. endpoint-kit owns
validation, typing, errors, timeout, retry and auth. Wiring them together is one method call.
Type-checked source for everything below: [`examples/tanstack-react.tsx`](../examples/tanstack-react.tsx)
and [`examples/tanstack-query.ts`](../examples/tanstack-query.ts).

## Queries

Call `orThrow()` inside `queryFn`. TanStack expects the function to throw on failure, and
`orThrow` throws the same typed error that a plain call would return as `{ error }`.

```tsx
import { useQuery } from '@tanstack/react-query';

function UserCard({ username }: { username: string }) {
  const { data, error, isPending } = useQuery({
    queryKey: ['user', username],
    queryFn: ({ signal }) => github.getUser.orThrow({ params: { username }, signal }),
  });

  if (isPending) return <p>Loading…</p>;
  if (error) return <p role="alert">{error.message}</p>;
  return <h2>{data.name ?? data.login}</h2>;
}
```

Passing `signal` is optional. With it, TanStack cancels the request when the component unmounts
or the key changes.

## Typed errors

By default TanStack types `error` as `Error`. Tell it once, for the whole app, what your routes
can produce:

```ts
import type { RouteError } from 'endpoint-kit';
import type { NotFoundError, UnauthorizedError, RateLimitedError } from './api';

export type AppError = RouteError | NotFoundError | UnauthorizedError | RateLimitedError;

declare module '@tanstack/react-query' {
  interface Register {
    defaultError: AppError;
  }
}
```

From then on every `useQuery(...).error` and `useMutation(...).error` is `AppError | null`, and
`_tag` narrows:

```tsx
if (error) {
  return (
    <p role="alert">
      {matchError(error, {
        NotFoundError: () => `No user named ${username}`,
        UnauthorizedError: () => 'Please sign in',
        ApiError: (e) => `GitHub answered ${String(e.status)}`,
        _: (e) => e.message,
      })}
    </p>
  );
}
```

## Mutations

Same idea: `orThrow()` in `mutationFn`, then invalidate the queries that are now stale.

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';

function NewIssueButton({ owner, repo }: { owner: string; repo: string }) {
  const client = useQueryClient();
  const createIssue = useMutation({
    mutationFn: (title: string) =>
      github.createIssue.orThrow({ params: { owner, repo }, body: { title } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['repos', owner] }),
  });

  return (
    <button disabled={createIssue.isPending} onClick={() => createIssue.mutate('Found a bug')}>
      New issue
    </button>
  );
}
```

If a route also uses endpoint-kit's own `cache`, declare `invalidates: ['repos']` on the mutation
route so both caches are cleared. For routes used through TanStack, leaving endpoint-kit `cache`
off is simpler.

## Suspense

```tsx
import { useSuspenseQuery } from '@tanstack/react-query';

function RepoList({ username }: { username: string }) {
  const { data } = useSuspenseQuery({
    queryKey: ['repos', username],
    queryFn: () => github.listRepos.orThrow({ params: { username }, query: { sort: 'updated' } }),
  });
  return (
    <ul>
      {data.map((repo) => (
        <li key={repo.id}>{repo.name}</li>
      ))}
    </ul>
  );
}
```

`data` is never `undefined`; errors go to the nearest error boundary with their `_tag` intact.

## Retry: once is enough

endpoint-kit's `retry` policy already retries transport errors and 5xx with backoff. Either turn
TanStack's retry off or keep it narrow:

```ts
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, error) => count < 2 && error._tag === 'ApiError' && error.status >= 500,
    },
  },
});
```

## Server components

Outside the client there is no hook. Await the caller and branch on the result:

```tsx
export default async function Page({ params }: { params: { username: string } }) {
  const { data, error } = await github.getUser({ params });
  if (error?._tag === 'NotFoundError') notFound();
  if (error) throw error;
  return <h1>{data.login}</h1>;
}
```

## Optional: `routeQuery` and `routeInfiniteQuery`

If you would rather not hand-write keys, `endpoint-kit/tanstack-query` derives them from the
route and types the error per route instead of app-wide. `@tanstack/react-query` is an optional
peer dependency.

```ts
import {
  routeQuery,
  routeInfiniteQuery,
  routeKey,
  routeKeyPrefix,
} from 'endpoint-kit/tanstack-query';
```

```tsx
const { data } = useSuspenseQuery(
  routeQuery(github.listRepos, { params: { username }, query: { sort: 'updated', per_page: 10 } }),
);
// key: ['GET', '/users/:username/repos', { params: {...}, query: {...} }]
// error: RouteError | NotFoundError | UnauthorizedError | RateLimitedError (this route only)

client.invalidateQueries({ queryKey: routeKeyPrefix(github.listRepos) }); // every listRepos query
```

The helper returns `queryOptions`, so it also works with `prefetchQuery`, `getQueryData` and
`setQueryData`, with the data type attached to the key.

Routes wrapped with `paginate()` get `useInfiniteQuery` for free: the route's `next` becomes
`getNextPageParam`, and every page param is a full route input.

```tsx
const repos = useInfiniteQuery(routeInfiniteQuery(github.listRepos, { params: { username } }));
// repos.data.pages: Repo[][]   repos.fetchNextPage()   repos.hasNextPage
```

## `exactOptionalPropertyTypes`

TanStack Query's option types do not compile cleanly under this flag. The examples here are
checked with it off (see [`examples/tsconfig.json`](../examples/tsconfig.json)); endpoint-kit
itself works either way.
