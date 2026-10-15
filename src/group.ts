import type { CacheOptions } from './middleware/cache.js';
import type { RetryOptions } from './middleware/retry.js';
import type { Middleware } from './middleware/types.js';
import type { AnyRoute, RouteMap, Simplify } from './route.js';

/** Shared settings applied to every route of a group. */
export interface GroupOptions {
  /**
   * Prepended verbatim to each route path, so write it without a trailing slash:
   * `'/admin'` + `'/users'` = `'/admin/users'`. May contain params: `'/orgs/:org'`.
   */
  prefix?: string;
  /** Merged under each route's own headers. */
  headers?: Record<string, string>;
  /** Merged under each route's own adapter options. */
  options?: Record<string, unknown>;
  /** Run before (outside) each route's own middlewares. */
  middlewares?: readonly Middleware[];
  /** Used when the route does not set its own `timeout`. */
  timeout?: number | false;
  /** Used when the route does not set its own `retry`. */
  retry?: RetryOptions | number | false;
  /** Used when the route does not set its own `cache`. */
  cache?: CacheOptions | number | false;
}

/** `R` with `prefix` prepended to its path. Params in the prefix become part of the route's params. */
export type PrefixedRoute<TPrefix extends string, R extends AnyRoute> = Simplify<
  Omit<R, 'path'> & { path: `${TPrefix}${R['path']}` }
>;

/** A route map after {@link groupRoutes}. */
export type GroupedRoutes<TPrefix extends string, TRoutes extends RouteMap> = {
  [K in keyof TRoutes]: PrefixedRoute<TPrefix, TRoutes[K]>;
};

/**
 * Apply a path prefix and shared settings to a set of routes. Groups nest naturally
 * because the result is a plain route map.
 *
 * @example
 * ```ts
 * const admin = groupRoutes('/admin', {
 *   listUsers: createRoute.get('/users'),
 *   getUser: createRoute.get('/users/:id'),
 * });
 *
 * const org = groupRoutes(
 *   { prefix: '/orgs/:org', headers: { 'x-scope': 'org' }, retry: 2 },
 *   { listRepos: createRoute.get('/repos') }, // path "/orgs/:org/repos", params { org }
 * );
 *
 * createRepository({ baseUrl }).mergeAll({ ...admin, ...org }).build();
 * ```
 */
export function groupRoutes<const TPrefix extends string = '', TRoutes extends RouteMap = RouteMap>(
  options: TPrefix | (GroupOptions & { prefix?: TPrefix }),
  routes: TRoutes,
): GroupedRoutes<TPrefix, TRoutes> {
  const group: GroupOptions = typeof options === 'string' ? { prefix: options } : options;
  const prefix = group.prefix ?? '';
  const result: Record<string, AnyRoute> = {};

  for (const [name, route] of Object.entries(routes)) {
    const merged: AnyRoute = { ...route, path: `${prefix}${route.path}` };

    if (group.headers && !isSchema(route.headers)) {
      merged.headers = { ...group.headers, ...route.headers };
    }
    if (group.options) merged.options = { ...group.options, ...route.options };
    if (group.middlewares) {
      merged.middlewares = [...group.middlewares, ...(route.middlewares ?? [])];
    }
    if (group.timeout !== undefined && route.timeout === undefined) merged.timeout = group.timeout;
    if (group.retry !== undefined && route.retry === undefined) merged.retry = group.retry;
    if (group.cache !== undefined && route.cache === undefined) merged.cache = group.cache;

    result[name] = merged;
  }

  return result as GroupedRoutes<TPrefix, TRoutes>;
}

function isSchema(value: unknown): boolean {
  return typeof value === 'object' && value !== null && '~standard' in value;
}
