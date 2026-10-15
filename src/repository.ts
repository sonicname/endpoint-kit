import { fetchAdapter } from './adapters/fetch.js';
import type { Adapter, AdapterRequest, AdapterResponse } from './adapters/types.js';
import { ApiError, toRouteError, ValidationError } from './errors.js';
import type { RouteError, TaggedError, ValidationTarget } from './errors.js';
import { cacheMiddleware, createCacheController } from './middleware/cache.js';
import type { CacheController, CacheOptions, CacheStorage } from './middleware/cache.js';
import { retryMiddleware } from './middleware/retry.js';
import type { RetryOptions } from './middleware/retry.js';
import { timeoutMiddleware } from './middleware/timeout.js';
import { composeMiddlewares } from './middleware/types.js';
import type { Middleware, MiddlewareContext } from './middleware/types.js';
import type { PaginateOptions } from './pagination.js';
import { resolvePolicy, resolveTimeout } from './policy.js';
import type {
  AnyRoute,
  ErrorFactory,
  ErrorsSpec,
  InferErrors,
  ParamsSpec,
  RouteArgs,
  RouteCaller,
  RouteFailure,
  RouteMap,
  RouteOutput,
  RouteResult,
  Simplify,
} from './route.js';
import type { AnySchema, StandardSchemaV1 } from './standard-schema.js';
import { encodeBody } from './body.js';
import { decodeServerSentEvents } from './sse.js';
import { buildUrl } from './url.js';
import type { QuerySerializerSpec } from './url.js';

/** Headers shared by every request: a static map or a (possibly async) factory, handy for auth tokens. */
export type HeadersProvider =
  Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);

/** Lifecycle hooks invoked around every request. */
export interface RepositoryHooks {
  /** Called right before the adapter is invoked, once per attempt. Mutating `request` is allowed. */
  onRequest?: (context: {
    route: string;
    request: AdapterRequest;
    attempt: number;
  }) => void | Promise<void>;
  /** Called after the adapter answers, once per attempt, before status and schema checks. */
  onResponse?: (context: {
    route: string;
    request: AdapterRequest;
    response: AdapterResponse;
    attempt: number;
  }) => void | Promise<void>;
  /** Called once when the call finally fails for any reason (network, status, validation). */
  onError?: (context: {
    route: string;
    request: AdapterRequest | undefined;
    error: TaggedError;
  }) => void | Promise<void>;
}

/** Repository-level cache options: the policy defaults plus the backing store. */
export interface RepositoryCacheOptions extends CacheOptions {
  /** Where entries live. Defaults to an in-memory `Map`. */
  storage?: CacheStorage;
}

/**
 * Configuration shared by all routes of a repository.
 *
 * @typeParam TErrors - Custom errors by status shared by every route. Their types join
 * the `error` union of every caller.
 */
export interface RepositoryConfig<TErrors extends ErrorsSpec = ErrorsSpec> {
  /** Base URL prepended to every route path. */
  baseUrl: string;
  /** Transport. Defaults to {@link fetchAdapter}. */
  adapter?: Adapter;
  /** Headers sent with every request. */
  headers?: HeadersProvider;
  /** Adapter specific options merged into every request. */
  options?: Record<string, unknown>;
  /**
   * How to serialise query strings: `{ arrayFormat, objectFormat }` or a custom function.
   * Routes can override it.
   */
  querySerializer?: QuerySerializerSpec;
  /** Validate response bodies against their `response` schema. Defaults to `true`. */
  validateResponse?: boolean;
  /** Decide whether a status code is a success. Defaults to `200 <= status < 300`. */
  isSuccess?: (status: number) => boolean;
  /**
   * Custom errors by HTTP status for every route, e.g.
   * `{ 401: () => new UnauthorizedError() }`. Route-level `errors` take precedence.
   */
  errors?: TErrors;
  hooks?: RepositoryHooks;
  /** Middlewares run around every request, outermost first. */
  middlewares?: readonly Middleware[];
  /** Default per-attempt timeout in ms. Routes and calls can override or disable it. */
  timeout?: number | false;
  /** Default retry policy or number of attempts. Routes and calls can override or disable it. */
  retry?: RetryOptions | number | false;
  /** Default cache policy or TTL in ms, plus the storage. Routes and calls can override or disable it. */
  cache?: RepositoryCacheOptions | number;
}

/** The object returned by `build()`: one caller per route plus a few `$`-prefixed extras. */
export type RepositoryClient<TRoutes extends RouteMap, TRepoErrors = never> = {
  readonly [K in keyof TRoutes]: RouteCaller<TRoutes[K], TRepoErrors>;
} & {
  /** Resolved configuration this client was built with. */
  readonly $config: Readonly<RepositoryConfig>;
  /** Route definitions keyed by name. */
  readonly $routes: Readonly<TRoutes>;
  /** Cache of this client: invalidate by tag, delete by key or clear. */
  readonly $cache: CacheController;
};

/** Fluent builder returned by {@link createRepository}. */
export class RepositoryBuilder<
  TRoutes extends RouteMap = Record<never, never>,
  TRepoErrors = never,
> {
  readonly #config: RepositoryConfig;
  readonly #routes: TRoutes;

  constructor(config: RepositoryConfig, routes: TRoutes) {
    this.#config = config;
    this.#routes = routes;
  }

  /** Register a single named route. */
  addRoute<TName extends string, TRoute extends AnyRoute>(
    name: TName,
    route: TRoute,
  ): RepositoryBuilder<Simplify<TRoutes & { [K in TName]: TRoute }>, TRepoErrors> {
    return new RepositoryBuilder(this.#config, {
      ...this.#routes,
      [name]: route,
    });
  }

  /** Register several routes at once, keyed by the object's property names. */
  mergeAll<TMore extends RouteMap>(
    routes: TMore,
  ): RepositoryBuilder<Simplify<TRoutes & TMore>, TRepoErrors> {
    return new RepositoryBuilder(this.#config, {
      ...this.#routes,
      ...routes,
    });
  }

  /** Produce the typed client. */
  build(): RepositoryClient<TRoutes, TRepoErrors> {
    const config: RepositoryConfig = {
      ...this.#config,
      adapter: this.#config.adapter ?? fetchAdapter(),
    };
    const routes = { ...this.#routes };
    const cacheStorage = typeof config.cache === 'object' ? config.cache.storage : undefined;
    const runtime: Runtime = {
      config,
      adapter: config.adapter ?? fetchAdapter(),
      cache: createCacheController(cacheStorage),
      isSuccess: config.isSuccess ?? defaultIsSuccess,
    };

    const client: Record<string, unknown> = {
      $config: Object.freeze(config),
      $routes: Object.freeze(routes),
      $cache: runtime.cache,
    };

    for (const [name, route] of Object.entries(routes)) {
      client[name] = createCaller(name, route, runtime);
    }

    return client as RepositoryClient<TRoutes, TRepoErrors>;
  }
}

/**
 * Start declaring a repository: a base URL, a transport and a set of routes.
 *
 * @example
 * ```ts
 * const github = createRepository({
 *   baseUrl: 'https://api.github.com',
 *   timeout: 10_000,
 *   retry: 3,
 *   errors: { 401: () => new UnauthorizedError() },
 * })
 *   .mergeAll({ getUser, listRepos })
 *   .build();
 *
 * const { data, error } = await github.getUser({ params: { username: 'octocat' } });
 * ```
 */
export function createRepository<TErrors extends ErrorsSpec = ErrorsSpec>(
  config: RepositoryConfig<TErrors>,
): RepositoryBuilder<Record<never, never>, InferErrors<TErrors>> {
  return new RepositoryBuilder<Record<never, never>, InferErrors<TErrors>>(config, {});
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface Runtime {
  config: RepositoryConfig;
  adapter: Adapter;
  cache: CacheController;
  isSuccess: (status: number) => boolean;
}

interface Executed {
  data: unknown;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

function createCaller<R extends AnyRoute>(
  name: string,
  route: R,
  runtime: Runtime,
): RouteCaller<R> {
  const run = (args: RouteArgs<R>): Promise<Executed> =>
    execute(name, route, runtime, (args[0] ?? {}) as unknown as LooseInput);

  const caller = async (
    ...args: RouteArgs<R>
  ): Promise<RouteResult<RouteOutput<R>, RouteFailure<R>>> => {
    try {
      const { data, status, statusText, headers } = await run(args);
      return { ok: true, data: data as RouteOutput<R>, error: null, status, statusText, headers };
    } catch (error) {
      return { ok: false, data: null, error: error as RouteFailure<R> };
    }
  };

  const orThrow = (...args: RouteArgs<R>): Promise<RouteOutput<R>> =>
    run(args).then((response) => response.data as RouteOutput<R>);

  const extras: Record<string, unknown> = { orThrow, definition: route };
  const pagination = route.paginate;
  if (pagination) {
    const pages = async function* (
      input?: LooseInput,
      options?: PaginateOptions,
    ): AsyncGenerator<unknown, void, undefined> {
      let current: LooseInput = input ?? {};
      const max = options?.maxPages ?? Infinity;
      for (let page = 1; page <= max; page++) {
        const result = await execute(name, route, runtime, current);
        yield result.data;
        const next = (pagination.next as (context: unknown) => LooseInput | null | undefined)({
          data: result.data,
          input: current,
          page,
          status: result.status,
          headers: result.headers,
        });
        if (next === null || next === undefined) return;
        current = next;
      }
    };
    extras['pages'] = pages;
    if (pagination.items) {
      const extract = pagination.items as (data: unknown) => readonly unknown[];
      extras['items'] = async function* (
        input?: LooseInput,
        options?: PaginateOptions,
      ): AsyncGenerator<unknown, void, undefined> {
        for await (const page of pages(input, options)) yield* extract(page);
      };
    }
  }

  return Object.assign(caller, extras) as unknown as RouteCaller<R>;
}

interface LooseInput {
  params?: Record<string, unknown>;
  query?: unknown;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  options?: Record<string, unknown>;
  timeout?: number | false;
  retry?: RetryOptions | number | false;
  cache?: CacheOptions | number | false;
}

async function execute(
  name: string,
  route: AnyRoute,
  runtime: Runtime,
  input: LooseInput,
): Promise<Executed> {
  const { config } = runtime;
  const hooks = config.hooks ?? {};
  let request: AdapterRequest | undefined;

  try {
    const params = await validateParams(name, route.params, input.params);
    const query = await validate(name, 'query', route.query, input.query);
    const body = await validate(name, 'body', route.body, input.body);

    const baseHeaders =
      typeof config.headers === 'function' ? await config.headers() : config.headers;

    request = {
      url: buildUrl(
        config.baseUrl,
        route.path,
        params,
        query,
        route.querySerializer ?? config.querySerializer,
      ),
      method: route.method,
      headers: { ...baseHeaders, ...route.headers, ...input.headers },
      responseType: route.responseType ?? 'json',
      signal: input.signal,
      options: { ...config.options, ...route.options, ...input.options },
    };
    const encoded = encodeBody(
      body,
      route.bodyType,
      route.querySerializer ?? config.querySerializer,
    );
    if (encoded !== undefined) request.body = encoded;

    const response = await buildPipeline(name, route, runtime, input)(request);

    if (!runtime.isSuccess(response.status)) {
      throw await failureFor(name, route, config, response);
    }

    const data = await decodeResponse(name, route, config, response.data);

    if (route.invalidates?.length) await runtime.cache.invalidate(...route.invalidates);

    return {
      data,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    };
  } catch (raw) {
    const error = toRouteError(raw, name);
    await hooks.onError?.({ route: name, request, error });
    throw error;
  }
}

/** Validate or wrap the parsed body depending on the route's `responseType`. */
function decodeResponse(
  name: string,
  route: AnyRoute,
  config: RepositoryConfig,
  body: unknown,
): Promise<unknown> {
  switch (route.responseType) {
    case 'none':
      return Promise.resolve(undefined);
    case 'stream':
      return Promise.resolve(body);
    case 'sse':
      return Promise.resolve(
        decodeServerSentEvents(
          body as ReadableStream<Uint8Array>,
          config.validateResponse === false ? undefined : route.response,
          name,
        ),
      );
    default:
      return config.validateResponse === false
        ? Promise.resolve(body)
        : validate(name, 'response', route.response, body);
  }
}

/** A custom error from the route or repository `errors` map, or an {@link ApiError}. */
async function failureFor(
  name: string,
  route: AnyRoute,
  config: RepositoryConfig,
  response: AdapterResponse,
): Promise<TaggedError> {
  const factory: ErrorFactory | undefined =
    route.errors?.[response.status] ?? config.errors?.[response.status];
  if (factory) {
    return factory({
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      data: response.data,
      route: name,
    });
  }
  return new ApiError(response.status, response.data, name, response.headers, response.statusText);
}

/**
 * Chain for one call, outermost first:
 * repository middlewares → route middlewares → cache → retry → timeout → hooks → adapter.
 */
function buildPipeline(
  name: string,
  route: AnyRoute,
  runtime: Runtime,
  input: LooseInput,
): (request: AdapterRequest) => Promise<AdapterResponse> {
  const { config } = runtime;
  const chain: Middleware[] = [...(config.middlewares ?? []), ...(route.middlewares ?? [])];

  const cache = resolvePolicy<CacheOptions>('ttl', config.cache, route.cache, input.cache);
  if (cache) chain.push(cacheMiddleware(runtime.cache, cache, runtime.isSuccess));

  const retry = resolvePolicy<RetryOptions>('attempts', config.retry, route.retry, input.retry);
  if (retry) chain.push(retryMiddleware(retry));

  const timeout = resolveTimeout(config.timeout, route.timeout, input.timeout);
  if (timeout) chain.push(timeoutMiddleware(timeout));

  chain.push(hooksMiddleware(config.hooks ?? {}));

  const context: MiddlewareContext = { route: name, attempt: 1 };
  return composeMiddlewares(chain, (request) => runtime.adapter.request(request), context);
}

function hooksMiddleware(hooks: RepositoryHooks): Middleware {
  return async (request, next, context) => {
    await hooks.onRequest?.({ route: context.route, request, attempt: context.attempt });
    const response = await next(request);
    await hooks.onResponse?.({ route: context.route, request, response, attempt: context.attempt });
    return response;
  };
}

function defaultIsSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

async function validate(
  routeName: string,
  target: ValidationTarget,
  schema: AnySchema | undefined,
  value: unknown,
): Promise<unknown> {
  if (!schema) return value;
  // An omitted params/query/body is validated as `{}` so all-optional schemas pass and
  // defaults apply. Response bodies keep `undefined` (204, `responseType: 'none'`).
  const subject =
    value === undefined && (target === 'params' || target === 'query' || target === 'body')
      ? {}
      : value;
  const result = await schema['~standard'].validate(subject);
  if (result.issues) {
    throw new ValidationError(target, result.issues, routeName);
  }
  return result.value;
}

function isSchema(value: unknown): value is AnySchema {
  return typeof value === 'object' && value !== null && '~standard' in value;
}

/**
 * Validate path params against either a whole-object schema or a per-key map.
 * Params without a schema pass through untouched.
 */
async function validateParams(
  routeName: string,
  spec: ParamsSpec<string>,
  value: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (spec === undefined) return value;
  if (isSchema(spec)) {
    const parsed = await validate(routeName, 'params', spec, value);
    // Keep params the schema does not know about (added by a group prefix).
    return { ...value, ...(parsed as Record<string, unknown> | undefined) };
  }

  const result: Record<string, unknown> = { ...value };
  const map = spec as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    const schema = map[key];
    if (!isSchema(schema)) continue;
    const outcome = await schema['~standard'].validate(value?.[key]);
    if (outcome.issues) {
      const issues: StandardSchemaV1.Issue[] = outcome.issues.map((issue) => ({
        message: issue.message,
        path: [key, ...(issue.path ?? [])],
      }));
      throw new ValidationError('params', issues, routeName);
    }
    result[key] = outcome.value;
  }
  return result;
}

// Exported for documentation purposes: the error union a repository produces.
export type { RouteError };
