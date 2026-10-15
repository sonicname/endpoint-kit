import type { AnyRoute, RouteInput, RouteOutput } from './route.js';

/** What `next` receives after each page. */
export interface PaginationContext<TData, TInput> {
  /** The page that was just fetched. */
  data: TData;
  /** The input used to fetch it. */
  input: TInput;
  /** 1-based page counter. */
  page: number;
  status: number;
  headers: Record<string, string>;
}

/**
 * How to walk from one page to the next.
 *
 * @typeParam TData - Output of the route (one page).
 * @typeParam TInput - Input of the route.
 * @typeParam TItem - Element type produced by `items`, enabling `caller.items()`.
 */
export interface Pagination<TData, TInput, TItem = never> {
  /** Return the input for the next page, or `null`/`undefined` when there is none. */
  next: (context: PaginationContext<TData, TInput>) => TInput | null | undefined;
  /** Extract the items of a page, for `caller.items()`. */
  items?: (data: TData) => readonly TItem[];
}

/**
 * The widest pagination a route can carry, used by the repository at runtime. Parameters
 * are `never` and returns `unknown`, so any concrete `Pagination<...>` is assignable.
 */
export interface AnyPagination {
  next: (context: never) => unknown;
  items?: (data: never) => readonly unknown[];
}

/** Options accepted by `caller.pages()` and `caller.items()`. */
export interface PaginateOptions {
  /** Stop after this many pages. Defaults to unlimited. */
  maxPages?: number;
}

/**
 * Attach pagination to a route. `next` and `items` are typed from the route, so the
 * route must be created first (or inline as the first argument).
 *
 * @example
 * ```ts
 * // page numbers
 * const listRepos = paginate(
 *   createRoute.get('/users/:username/repos', { query: pageQuery, response: z.array(repo) }),
 *   {
 *     next: ({ data, input }) =>
 *       data.length === 0 ? null : { ...input, query: { ...input.query, page: (input.query?.page ?? 1) + 1 } },
 *     items: (data) => data,
 *   },
 * );
 *
 * // cursors
 * const listEvents = paginate(createRoute.get('/events', { query: cursorQuery, response: pageSchema }), {
 *   next: ({ data, input }) => (data.nextCursor ? { ...input, query: { cursor: data.nextCursor } } : null),
 *   items: (data) => data.items,
 * });
 *
 * for await (const repo of api.listRepos.items({ params: { username: 'octocat' } })) { ... }
 * ```
 */
export function paginate<R extends AnyRoute, TItem = never>(
  route: R,
  pagination: Pagination<RouteOutput<R>, RouteInput<R>, TItem>,
): Omit<R, 'paginate'> & { paginate: Pagination<RouteOutput<R>, RouteInput<R>, TItem> } {
  return { ...route, paginate: pagination };
}
