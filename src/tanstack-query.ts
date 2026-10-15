/**
 * TanStack Query v5 helpers. `@tanstack/react-query` is an optional peer dependency.
 *
 * ```ts
 * import { routeQuery, routeInfiniteQuery, routeKeyPrefix } from 'endpoint-kit/tanstack-query';
 *
 * useQuery(routeQuery(api.getUser, { params: { id } }));
 * useInfiniteQuery(routeInfiniteQuery(api.listRepos, { params: { username } }));
 * queryClient.invalidateQueries({ queryKey: routeKeyPrefix(api.listRepos) });
 * ```
 *
 * @packageDocumentation
 */
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';

import type { AnyPagination } from './pagination.js';
import type {
  AnyRoute,
  RouteArgs,
  RouteCaller,
  RouteFailure,
  RouteInput,
  RouteOutput,
} from './route.js';

/** Query key shape: `[method, path, { params, query, body }]`. */
export type RouteQueryKey = readonly [method: string, path: string, input: Record<string, unknown>];

/** The part of the input that identifies the data (params, query, body). Transport options are left out. */
export function routeKey<R extends AnyRoute>(
  caller: RouteCaller<R, unknown>,
  input?: RouteInput<R>,
): RouteQueryKey {
  return [caller.definition.method, caller.definition.path, identityOf(input)];
}

/** Key prefix matching every query of a route, for `invalidateQueries`. */
export function routeKeyPrefix<R extends AnyRoute>(
  caller: RouteCaller<R, unknown>,
): readonly [method: string, path: string] {
  return [caller.definition.method, caller.definition.path];
}

/**
 * `queryOptions` for a route: key from the route and input, `queryFn` that forwards TanStack's
 * abort signal and throws the typed error, generics set so `error` is this route's union.
 */
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- the exact queryOptions shape is what useQuery/useSuspenseQuery/prefetchQuery accept
export function routeQuery<R extends AnyRoute, E>(
  caller: RouteCaller<R, E>,
  ...args: RouteArgs<R>
) {
  const input = args[0];
  return queryOptions<RouteOutput<R>, RouteFailure<R, E>, RouteOutput<R>, RouteQueryKey>({
    queryKey: routeKey(caller, input),
    queryFn: ({ signal }) => caller.orThrow(...withSignal<R>(input, signal)),
  });
}

/** Query key shape for infinite queries: like {@link RouteQueryKey} with an `"infinite"` marker. */
export type RouteInfiniteQueryKey = readonly [
  method: string,
  path: string,
  input: Record<string, unknown>,
  marker: 'infinite',
];

/**
 * `infiniteQueryOptions` for a route wrapped with `paginate()`. The route's `next` decides
 * `getNextPageParam`; each page param is a full route input, starting from `input`.
 */
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- see routeQuery
export function routeInfiniteQuery<R extends AnyRoute & { paginate: AnyPagination }, E>(
  caller: RouteCaller<R, E>,
  ...args: RouteArgs<R>
) {
  const initial = (args[0] ?? {}) as RouteInput<R>;
  const next = caller.definition.paginate.next as (
    context: unknown,
  ) => RouteInput<R> | null | undefined;
  // status/headers of each page, keyed by the page object, for `next`.
  const meta = new WeakMap<object, { status: number; headers: Record<string, string> }>();

  return infiniteQueryOptions<
    RouteOutput<R>,
    RouteFailure<R, E>,
    { pages: RouteOutput<R>[]; pageParams: RouteInput<R>[] },
    RouteInfiniteQueryKey,
    RouteInput<R>
  >({
    queryKey: [...routeKey(caller, initial), 'infinite'],
    initialPageParam: initial,
    queryFn: async ({ pageParam, signal }) => {
      const result = await caller(...withSignal<R>(pageParam, signal));
      if (!result.ok) throw result.error as Error;
      if (typeof result.data === 'object' && result.data !== null) {
        meta.set(result.data, { status: result.status, headers: result.headers });
      }
      return result.data;
    },
    getNextPageParam: (lastPage, allPages, lastPageParam) => {
      const info = (typeof lastPage === 'object' && lastPage !== null
        ? meta.get(lastPage)
        : undefined) ?? { status: 200, headers: {} };
      return (
        next({
          data: lastPage,
          input: lastPageParam,
          page: allPages.length,
          status: info.status,
          headers: info.headers,
        }) ?? undefined
      );
    },
  });
}

function identityOf(input: unknown): Record<string, unknown> {
  const { params, query, body } = (input ?? {}) as {
    params?: unknown;
    query?: unknown;
    body?: unknown;
  };
  const identity: Record<string, unknown> = {};
  if (params !== undefined) identity['params'] = params;
  if (query !== undefined) identity['query'] = query;
  if (body !== undefined) identity['body'] = body;
  return identity;
}

function withSignal<R extends AnyRoute>(input: unknown, signal: AbortSignal): RouteArgs<R> {
  return [{ ...(input ?? {}), signal } as RouteInput<R>] as RouteArgs<R>;
}
