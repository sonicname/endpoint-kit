/**
 * React components on TanStack Query.
 *
 * `UserCard` and `NewIssueButton` use TanStack directly: `orThrow()` inside `queryFn` /
 * `mutationFn` and nothing else. `RepoList` shows the optional `routeQuery` helper from
 * `tanstack-query.ts`, which derives the key and types the error per route.
 */
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { Suspense } from 'react';
import type { ReactElement } from 'react';

import { matchError } from '../src/index.js';

import { github } from './api.js';
import { routeKeyPrefix, routeQuery } from '../src/tanstack-query.js';

import './query-client.js';

// --- Query client ----------------------------------------------------------

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // endpoint-kit already retried transport errors; let TanStack retry only 5xx.
      retry: (count, error) => count < 2 && error._tag === 'ApiError' && error.status >= 500,
    },
  },
});

// --- Plain usage -----------------------------------------------------------

export function UserCard({ username }: { username: string }): ReactElement {
  const { data, error, isPending } = useQuery({
    queryKey: ['user', username],
    queryFn: ({ signal }) => github.getUser.orThrow({ params: { username }, signal }),
  });

  if (isPending) return <p>Loading…</p>;

  if (error) {
    // error: AppError (see tanstack-query.ts), narrow on _tag or use matchError
    return (
      <p role="alert">
        {matchError(error, {
          NotFoundError: () => `No user named ${username}`,
          UnauthorizedError: () => 'Please sign in to see profiles',
          ApiError: (e) => `GitHub answered ${String(e.status)}`,
          _: (e) => e.message,
        })}
      </p>
    );
  }

  return <h2>{data.name ?? data.login}</h2>;
}

export function NewIssueButton({ owner, repo }: { owner: string; repo: string }): ReactElement {
  const client = useQueryClient();
  const createIssue = useMutation({
    mutationFn: (title: string) =>
      github.createIssue.orThrow({ params: { owner, repo }, body: { title } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['repos', owner] }),
  });

  return (
    <button
      disabled={createIssue.isPending}
      onClick={() => {
        createIssue.mutate('Found a bug');
      }}
    >
      {createIssue.isPending ? 'Creating…' : 'New issue'}
      {createIssue.error && <span> ({createIssue.error.message})</span>}
    </button>
  );
}

// --- Optional helper -------------------------------------------------------

export function RepoList({ username }: { username: string }): ReactElement {
  // routeQuery builds the key from the route and input, forwards the signal, and types
  // the error as exactly this route's union. Suspense variant: data is never undefined.
  const { data } = useSuspenseQuery(
    routeQuery(github.listRepos, {
      params: { username },
      query: { sort: 'updated', per_page: 10 },
    }),
  );

  return (
    <ul>
      {data.map((repo) => (
        <li key={repo.id}>
          {repo.name} ★ {repo.stargazers_count}
        </li>
      ))}
    </ul>
  );
}

export function RefreshReposButton(): ReactElement {
  const client = useQueryClient();
  return (
    <button
      onClick={() => void client.invalidateQueries({ queryKey: routeKeyPrefix(github.listRepos) })}
    >
      Refresh
    </button>
  );
}

// --- App -------------------------------------------------------------------

export function App(): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <UserCard username="octocat" />
      <Suspense fallback={<p>Loading repos…</p>}>
        <RepoList username="octocat" />
      </Suspense>
      <NewIssueButton owner="octocat" repo="hello-world" />
      <RefreshReposButton />
    </QueryClientProvider>
  );
}
