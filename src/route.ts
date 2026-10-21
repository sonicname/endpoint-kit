import type { HttpMethod, ResponseType } from './adapters/types.js';
import type { BodyType } from './body.js';
import { ValidationError } from './errors.js';
import type { RouteError, TaggedError } from './errors.js';
import type { CacheOptions } from './middleware/cache.js';
import type { RetryOptions } from './middleware/retry.js';
import type { Middleware } from './middleware/types.js';
import type { AnySchema, StandardSchemaV1 } from './standard-schema.js';
import type { AnyPagination, PaginateOptions } from './pagination.js';
import type { ServerSentEvent } from './sse.js';
import type { QuerySerializerSpec } from './url.js';

/** A schema slot: either a Standard Schema or nothing. */
export type SchemaOrUndefined = AnySchema | undefined;

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

/** Names of `:param` segments in a path literal. */
export type PathParamNames<TPath extends string> =
  TPath extends `${string}:${infer Param}/${infer Rest}`
    ? Param | PathParamNames<`/${Rest}`>
    : TPath extends `${string}:${infer Param}`
      ? Param
      : never;

/** Object type for the `:param` segments of a path, or `never` if it has none. */
export type PathParams<TPath extends string> = [PathParamNames<TPath>] extends [never]
  ? never
  : { [K in PathParamNames<TPath>]: string | number };

/**
 * One schema per path param. Keys are restricted to the `:param` names of the path,
 * so the IDE suggests them. A param without a schema accepts `string | number`.
 */
export type ParamsSchemaMap<TPath extends string> = {
  [K in PathParamNames<TPath>]?: AnySchema;
};

/** Everything the `params` field of a route accepts. */
export type ParamsSpec<TPath extends string> = AnySchema | ParamsSchemaMap<TPath> | undefined;

type MissingParamsError<TPath extends string, Missing extends PropertyKey> = {
  [
    K in `params: path "${TPath}" has param ":${Missing & string}" but the schema does not require it`
  ]: never;
};

type ExtraParamsError<TPath extends string, Extra extends PropertyKey> = {
  [K in `params: "${Extra & string}" is not a param of path "${TPath}"`]: never;
};

/**
 * Compile-time check that `params` matches the `:param` segments of `TPath`.
 *
 * - A whole-object schema must *require* every path param and declare nothing else.
 * - A per-key map may omit params but cannot name keys that are not in the path.
 *
 * Resolves to `TParams` when valid, or to an object type whose property name spells out
 * the problem, so the assignment error in the IDE is readable.
 */
export type ValidateParams<TPath extends string, TParams> = [TParams] extends [undefined]
  ? TParams
  : TParams extends AnySchema
    ? CheckParamKeys<
        TPath,
        RequiredKeys<StandardSchemaV1.InferInput<TParams>>,
        keyof StandardSchemaV1.InferInput<TParams>,
        TParams
      >
    : TParams extends object
      ? CheckParamKeys<TPath, PathParamNames<TPath>, keyof TParams, TParams>
      : never;

type CheckParamKeys<
  TPath extends string,
  Required extends PropertyKey,
  All extends PropertyKey,
  TParams,
> = [Exclude<PathParamNames<TPath>, Required>] extends [never]
  ? [Exclude<All, PathParamNames<TPath>>] extends [never]
    ? TParams
    : ExtraParamsError<TPath, Exclude<All, PathParamNames<TPath>>>
  : MissingParamsError<TPath, Exclude<PathParamNames<TPath>, Required>>;

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

/** What an error factory receives: the failed response plus the route name. */
export interface ErrorContext<TData = unknown> {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Parsed response body. */
  data: TData;
  route: string;
}

/** Builds a custom error for a status code. May be async. Must return a {@link TaggedError}. */
export type ErrorFactory<TError extends TaggedError = TaggedError> = (
  context: ErrorContext,
) => TError | Promise<TError>;

/**
 * An error factory whose `data` is validated against `schema` first, so `map` receives it
 * typed. A body that does not match yields a `ValidationError` with target `'error'`.
 *
 * @example
 * ```ts
 * errors: {
 *   404: errorFromSchema(z.object({ resource: z.string() }), (data) => new NotFoundError(data.resource)),
 * }
 * ```
 */
export function errorFromSchema<TSchema extends AnySchema, TError extends TaggedError>(
  schema: TSchema,
  map: (data: StandardSchemaV1.InferOutput<TSchema>, context: ErrorContext) => TError,
): ErrorFactory<TError> {
  return async (context) => {
    const result = await schema['~standard'].validate(context.data);
    if (result.issues) throw new ValidationError('error', result.issues, context.route);
    return map(result.value, context);
  };
}

/**
 * Keys of an `errors` map: an exact status, a class of statuses (`'4XX'`, `'5XX'`) or
 * `'default'`. Lookup order: exact status, then class, then default.
 */
export type ErrorStatusKey = number | '4XX' | '5XX' | 'default';

/** Custom errors keyed by status. The factory's return type becomes part of `error`'s type. */
export type ErrorFactories = Readonly<Partial<Record<ErrorStatusKey, ErrorFactory>>>;

/** Pick the factory for `status`: exact match, then `4XX`/`5XX`, then `default`. */
export function findErrorFactory(
  factories: ErrorFactories | undefined,
  status: number,
): ErrorFactory | undefined {
  if (!factories) return undefined;
  const range = status >= 500 ? '5XX' : status >= 400 ? '4XX' : undefined;
  return factories[status] ?? (range ? factories[range] : undefined) ?? factories.default;
}

/** Everything the `errors` field accepts. */
export type ErrorsSpec = ErrorFactories | undefined;

/**
 * Union of the errors produced by an {@link ErrorFactories} map, or `never` when the
 * slot is empty or unconstrained (the wide default a contextually typed route gets).
 */
export type InferErrors<E> = [NonNullable<E>] extends [never]
  ? never
  : ErrorFactories extends NonNullable<E>
    ? never
    : NonNullable<NonNullable<E>[keyof NonNullable<E>]> extends (...args: never[]) => infer R
      ? Extract<Awaited<R>, TaggedError>
      : never;

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

/**
 * Declaration of a single API endpoint.
 *
 * @typeParam TPath - Literal path, e.g. `"/users/:username"`. Path params are inferred from it.
 * @typeParam TParams - Path params: a whole-object schema, a per-key schema map, or nothing.
 * @typeParam TQuery - Schema for the query string.
 * @typeParam TBody - Schema for the request body.
 * @typeParam TResponse - Schema for the response body. Its output type is what the caller receives.
 * @typeParam TResponseType - How the adapter should parse the response body.
 * @typeParam TErrors - Custom errors by status. Their types join the `error` union.
 */
export interface RouteDefinition<
  TPath extends string = string,
  TParams extends ParamsSpec<TPath> = ParamsSpec<TPath>,
  TQuery extends SchemaOrUndefined = SchemaOrUndefined,
  TBody extends SchemaOrUndefined = SchemaOrUndefined,
  TResponse extends SchemaOrUndefined = SchemaOrUndefined,
  TResponseType extends ResponseType = ResponseType,
  TErrors extends ErrorsSpec = ErrorsSpec,
  THeaders extends SchemaOrUndefined = SchemaOrUndefined,
> {
  method: HttpMethod;
  /** Path relative to the repository `baseUrl`. Use `:name` segments for path params. */
  path: TPath;
  /**
   * Validation for path params. Either one schema per param
   * (`{ id: z.coerce.number() }`) or a whole-object schema. Params without a schema
   * accept `string | number`.
   */
  params?: TParams;
  /** Schema validating the query string. */
  query?: TQuery;
  /** Schema validating the request body. */
  body?: TBody;
  /**
   * How the body is encoded: `json` (default), `multipart` (`FormData`, for `File`/`Blob`
   * fields) or `form` (`application/x-www-form-urlencoded`).
   */
  bodyType?: BodyType;
  /** Schema validating (and typing) the response body. */
  response?: TResponse;
  /** Response parsing strategy, defaults to `"json"`. */
  responseType?: TResponseType;
  /**
   * Custom errors by HTTP status, e.g. `{ 404: (ctx) => new NotFoundError(ctx.data) }`.
   * A matching status produces that error instead of an `ApiError`. Route factories
   * take precedence over repository ones.
   */
  errors?: TErrors;
  /** How to serialise the query string. Overrides the repository setting. */
  querySerializer?: QuerySerializerSpec;
  /**
   * Either static headers sent with every call, or a schema validating (and typing) the
   * headers the caller must pass. Schema keys should be lower case.
   */
  headers?: Record<string, string> | THeaders;
  /** Adapter specific options (axios config, ofetch options, RequestInit...). */
  options?: Record<string, unknown>;
  /** Per-attempt timeout in ms. `false` disables a repository-level timeout. */
  timeout?: number | false;
  /** Retry policy, a number of attempts, or `false` to disable the repository-level policy. */
  retry?: RetryOptions | number | false;
  /** Cache policy, a TTL in ms, or `false` to disable the repository-level policy. */
  cache?: CacheOptions | number | false;
  /** Cache tags to invalidate after this route succeeds (typically on mutations). */
  invalidates?: readonly string[];
  /** Extra middlewares for this route, run inside the repository ones. */
  middlewares?: readonly Middleware[];
  /** Set by {@link paginate}: how to walk to the next page. Enables `caller.pages()` / `items()`. */
  paginate?: AnyPagination;
}

/** Any route, regardless of its generics. */
export type AnyRoute = RouteDefinition;

/** A named collection of routes. */
export type RouteMap = Record<string, AnyRoute>;

/**
 * Declare an endpoint. The returned object is the same you pass in, but with all
 * literal types preserved so the repository can infer inputs, outputs and errors.
 * `params` is checked against the `:param` segments of `path` at compile time.
 *
 * @example
 * ```ts
 * const getIssue = createRoute({
 *   method: 'GET',
 *   path: '/repos/:owner/:repo/issues/:number',
 *   params: { number: z.coerce.number().int() }, // owner and repo accept string | number
 *   response: z.object({ id: z.number(), title: z.string() }),
 *   errors: { 404: (ctx) => new IssueNotFound(ctx) },
 * });
 * ```
 */
export function createRoute<
  const TPath extends string,
  TParams extends ParamsSpec<TPath> = undefined,
  TQuery extends SchemaOrUndefined = undefined,
  TBody extends SchemaOrUndefined = undefined,
  TResponse extends SchemaOrUndefined = undefined,
  TResponseType extends ResponseType = 'json',
  // Defaults to the wide spec (not `undefined`) so factories get a contextual type for `ctx`
  // before TErrors is inferred; InferErrors treats the wide spec as "no custom errors".
  TErrors extends ErrorsSpec = ErrorsSpec,
  THeaders extends SchemaOrUndefined = undefined,
>(
  definition: RouteDefinition<
    TPath,
    TParams,
    TQuery,
    TBody,
    TResponse,
    TResponseType,
    TErrors,
    THeaders
  > & {
    params?: NoInfer<ValidateParams<TPath, TParams>>;
  },
): RouteDefinition<TPath, TParams, TQuery, TBody, TResponse, TResponseType, TErrors, THeaders> {
  return definition;
}

/** Everything a route accepts except `method` and `path`, for the method helpers. */
export type RouteOptions<
  TPath extends string,
  TParams extends ParamsSpec<TPath>,
  TQuery extends SchemaOrUndefined,
  TBody extends SchemaOrUndefined,
  TResponse extends SchemaOrUndefined,
  TResponseType extends ResponseType,
  TErrors extends ErrorsSpec,
  THeaders extends SchemaOrUndefined = undefined,
> = Omit<
  RouteDefinition<TPath, TParams, TQuery, TBody, TResponse, TResponseType, TErrors, THeaders>,
  'method' | 'path'
>;

/** Signature shared by `createRoute.get`, `createRoute.post`, ... */
export type MethodRouteFactory = <
  const TPath extends string,
  TParams extends ParamsSpec<TPath> = undefined,
  TQuery extends SchemaOrUndefined = undefined,
  TBody extends SchemaOrUndefined = undefined,
  TResponse extends SchemaOrUndefined = undefined,
  TResponseType extends ResponseType = 'json',
  // Defaults to the wide spec (not `undefined`) so factories get a contextual type for `ctx`
  // before TErrors is inferred; InferErrors treats the wide spec as "no custom errors".
  TErrors extends ErrorsSpec = ErrorsSpec,
  THeaders extends SchemaOrUndefined = undefined,
>(
  path: TPath,
  options?: RouteOptions<
    TPath,
    TParams,
    TQuery,
    TBody,
    TResponse,
    TResponseType,
    TErrors,
    THeaders
  > & {
    params?: NoInfer<ValidateParams<TPath, TParams>>;
  },
) => RouteDefinition<TPath, TParams, TQuery, TBody, TResponse, TResponseType, TErrors, THeaders>;

function methodFactory(method: HttpMethod): MethodRouteFactory {
  return (path, options) => ({ ...options, method, path });
}

/** `createRoute.get('/users/:id', { response })` is `createRoute({ method: 'GET', path: '/users/:id', response })`. */
createRoute.get = methodFactory('GET');
createRoute.post = methodFactory('POST');
createRoute.put = methodFactory('PUT');
createRoute.patch = methodFactory('PATCH');
createRoute.delete = methodFactory('DELETE');
createRoute.head = methodFactory('HEAD');
createRoute.options = methodFactory('OPTIONS');

// ---------------------------------------------------------------------------
// Type inference helpers
// ---------------------------------------------------------------------------

/** Flattens intersections so hover tooltips are readable. */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * The schema in a slot, or `undefined` when the slot is empty. A slot typed as the
 * unconstrained `AnySchema` (which happens when TypeScript infers a route from the
 * contextual `AnyRoute` type, e.g. `createRoute(...)` written inline inside
 * `mergeAll({ ... })`) is treated as empty too.
 */
type SchemaOf<S> = [NonNullable<S>] extends [never]
  ? undefined
  : NonNullable<S> extends AnySchema
    ? AnySchema extends NonNullable<S>
      ? undefined
      : NonNullable<S>
    : undefined;

type InputOf<S, Fallback = never> =
  SchemaOf<S> extends AnySchema ? StandardSchemaV1.InferInput<SchemaOf<S>> : Fallback;

type OutputOf<S, Fallback = never> =
  SchemaOf<S> extends AnySchema ? StandardSchemaV1.InferOutput<SchemaOf<S>> : Fallback;

/** Keys of `T` that are not optional. */
export type RequiredKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K;
}[keyof T];

/**
 * Builds `{ [K]: T }`, `{ [K]?: T }` or `{}` depending on whether `T` is `never`,
 * has required keys, or only optional keys.
 */
type Field<K extends string, T> = [T] extends [never]
  ? Record<never, never>
  : T extends object
    ? [RequiredKeys<T>] extends [never]
      ? { [P in K]?: T }
      : { [P in K]: T }
    : { [P in K]: T };

/** Input type of a per-key params map: schema input where given, `string | number` elsewhere. */
type MappedParams<TPath extends string, TMap> = [PathParamNames<TPath>] extends [never]
  ? never
  : {
      [K in PathParamNames<TPath>]: K extends keyof TMap
        ? NonNullable<TMap[K]> extends AnySchema
          ? StandardSchemaV1.InferInput<NonNullable<TMap[K]>>
          : string | number
        : string | number;
    };

/** Path params accepted by a route: schema input, per-key map input, or inferred from the path. */
export type RouteParams<R extends AnyRoute> = [NonNullable<R['params']>] extends [never]
  ? PathParams<R['path']>
  : NonNullable<R['params']> extends AnySchema
    ? Simplify<
        StandardSchemaV1.InferInput<NonNullable<R['params']>> &
          ExtraPathParams<R['path'], keyof StandardSchemaV1.InferInput<NonNullable<R['params']>>>
      >
    : MappedParams<R['path'], NonNullable<R['params']>>;

/**
 * Path params not covered by a whole-object schema. Empty for routes created with
 * `createRoute` (the schema must cover the path), non-empty after `groupRoutes` added a
 * prefix with its own params.
 */
type ExtraPathParams<TPath extends string, Known extends PropertyKey> = {
  [K in Exclude<PathParamNames<TPath>, Known>]: string | number;
};

/** Query accepted by a route, or `never` when it has no query schema. */
export type RouteQuery<R extends AnyRoute> = InputOf<R['query']>;

/** Body accepted by a route, or `never` when it has no body schema. */
export type RouteBody<R extends AnyRoute> = InputOf<R['body']>;

/** The header schema of a route, or `never` when `headers` is static or absent. */
export type HeaderSchemaOf<R extends AnyRoute> =
  Extract<NonNullable<R['headers']>, AnySchema> extends infer S
    ? [S] extends [never]
      ? never
      : AnySchema extends S
        ? never
        : S
    : never;

/** Headers the caller must pass when the route has a header schema, else `never`. */
export type RouteHeaders<R extends AnyRoute> = [HeaderSchemaOf<R>] extends [never]
  ? never
  : StandardSchemaV1.InferInput<HeaderSchemaOf<R>>;

/** Validated headers on the server: schema output, or the raw `Headers` without a schema. */
export type RouteHeadersOutput<R extends AnyRoute> = [HeaderSchemaOf<R>] extends [never]
  ? Headers
  : StandardSchemaV1.InferOutput<HeaderSchemaOf<R>>;

// --- Output (server side) types -------------------------------------------

/** Path params after validation: schema outputs, or strings for params without a schema. */
export type RouteParamsOutput<R extends AnyRoute> = [NonNullable<R['params']>] extends [never]
  ? { [K in PathParamNames<R['path']>]: string }
  : NonNullable<R['params']> extends AnySchema
    ? Simplify<
        StandardSchemaV1.InferOutput<NonNullable<R['params']>> & {
          [
            K in Exclude<
              PathParamNames<R['path']>,
              keyof StandardSchemaV1.InferOutput<NonNullable<R['params']>>
            >
          ]: string;
        }
      >
    : {
        [K in PathParamNames<R['path']>]: K extends keyof NonNullable<R['params']>
          ? NonNullable<NonNullable<R['params']>[K]> extends AnySchema
            ? StandardSchemaV1.InferOutput<NonNullable<NonNullable<R['params']>[K]>>
            : string
          : string;
      };

/** Query after validation, `undefined` when the route has no query schema. */
export type RouteQueryOutput<R extends AnyRoute> = OutputOf<R['query'], undefined>;

/** Body after validation, `undefined` when the route has no body schema. */
export type RouteBodyOutput<R extends AnyRoute> = OutputOf<R['body'], undefined>;

/**
 * What a server handler must return: the response schema *input*, or `unknown` without one.
 * For `responseType: 'sse'` it is an async iterable of events (each one a schema input), or a
 * ready-made `ReadableStream`.
 */
export type RouteResponseInput<R extends AnyRoute> =
  NonNullable<R['responseType']> extends 'sse'
    ? AsyncIterable<InputOf<R['response'], unknown>> | ReadableStream<Uint8Array>
    : InputOf<R['response'], unknown>;

/** Options every call accepts in addition to params/query/body/headers. */
export interface CallOptionsBase {
  /** Abort the request. */
  signal?: AbortSignal;
  /** Adapter specific options merged over repository and route options. */
  options?: Record<string, unknown>;
  /** Per-attempt timeout in ms for this call, `false` to disable. */
  timeout?: number | false;
  /** Retry policy for this call, `false` to disable. */
  retry?: RetryOptions | number | false;
  /** Cache policy for this call, `false` to bypass the cache. */
  cache?: CacheOptions | number | false;
}

/** Options every call accepts, with free-form headers (routes without a header schema). */
export interface CallOptions extends CallOptionsBase {
  /** Extra headers merged over repository and route headers. */
  headers?: Record<string, string>;
}

/** `headers` field of the input: typed by the schema when there is one, free-form otherwise. */
type HeadersField<R extends AnyRoute> = [RouteHeaders<R>] extends [never]
  ? { headers?: Record<string, string> }
  : Field<'headers', RouteHeaders<R>>;

/** The single argument a route caller accepts. */
export type RouteInput<R extends AnyRoute> = Simplify<
  Field<'params', RouteParams<R>> &
    Field<'query', RouteQuery<R>> &
    Field<'body', RouteBody<R>> &
    HeadersField<R> &
    CallOptionsBase
>;

/** Argument tuple for a route caller: the input becomes optional when nothing in it is required. */
export type RouteArgs<R extends AnyRoute> = [RequiredKeys<RouteInput<R>>] extends [never]
  ? [input?: RouteInput<R>]
  : [input: RouteInput<R>];

type ParsedBody<R extends AnyRoute> =
  NonNullable<R['responseType']> extends 'text'
    ? string
    : NonNullable<R['responseType']> extends 'blob'
      ? Blob
      : NonNullable<R['responseType']> extends 'arrayBuffer'
        ? ArrayBuffer
        : NonNullable<R['responseType']> extends 'none'
          ? undefined
          : NonNullable<R['responseType']> extends 'stream'
            ? ReadableStream<Uint8Array>
            : unknown;

/**
 * What a successful call resolves with: the response schema output, or the raw parsed body.
 * For `responseType: 'sse'` it is an async iterable of events, or of schema outputs when a
 * `response` schema is given (each event's `data` is JSON-decoded and validated).
 */
export type RouteOutput<R extends AnyRoute> =
  NonNullable<R['responseType']> extends 'sse'
    ? AsyncIterable<OutputOf<R['response'], ServerSentEvent>>
    : OutputOf<R['response'], ParsedBody<R>>;

/** Custom errors declared on the route itself. */
export type RouteErrors<R extends AnyRoute> = InferErrors<R['errors']>;

/**
 * Everything a call of `R` can fail with: the built-in {@link RouteError}s, the route's
 * own custom errors and the repository's (`TRepoErrors`).
 */
export type RouteFailure<R extends AnyRoute, TRepoErrors = never> =
  RouteError | RouteErrors<R> | TRepoErrors;

/**
 * What a route call resolves with. Exactly one of `data` and `error` is `null`, so
 * `if (error)` narrows `data` and vice versa. `ok` is there for `if (result.ok)`.
 */
export type RouteResult<TData, TError> =
  | {
      readonly ok: true;
      readonly data: TData;
      readonly error: null;
      readonly status: number;
      readonly statusText: string;
      readonly headers: Record<string, string>;
    }
  | {
      readonly ok: false;
      readonly data: null;
      readonly error: TError;
    };

/** Callable produced for each route of a built repository. */
export type RouteCaller<R extends AnyRoute, TRepoErrors = never> = RouteCallerBase<R, TRepoErrors> &
  PaginationMethods<R>;

interface RouteCallerBase<R extends AnyRoute, TRepoErrors> {
  /**
   * Perform the request. Never rejects: resolves with `{ data, error }` where `error`
   * is typed with every failure this route can produce.
   */
  (...args: RouteArgs<R>): Promise<RouteResult<RouteOutput<R>, RouteFailure<R, TRepoErrors>>>;
  /** Perform the request and resolve with the data, rejecting with the error instead. */
  orThrow(...args: RouteArgs<R>): Promise<RouteOutput<R>>;
  /** The route definition this caller was built from. */
  readonly definition: R;
}

/** `pages()` and `items()`, present only on routes wrapped with `paginate()`. */
type PaginationMethods<R extends AnyRoute> = R extends { paginate: AnyPagination }
  ? {
      /** Fetch page after page until `next` returns `null`. Rejects with the typed error on failure. */
      pages(...args: PaginatedArgs<R>): AsyncIterable<RouteOutput<R>>;
    } & ([PaginatedItem<R>] extends [never]
      ? Record<never, never>
      : {
          /** Like `pages()`, flattened through the `items` extractor. */
          items(...args: PaginatedArgs<R>): AsyncIterable<PaginatedItem<R>>;
        })
  : Record<never, never>;

/** Element type of the `items` extractor, or `never` when the route has none. */
type PaginatedItem<R> = R extends { paginate: { items?: infer F } }
  ? NonNullable<F> extends (data: never) => readonly (infer TItem)[]
    ? TItem
    : never
  : never;

type PaginatedArgs<R extends AnyRoute> = [RequiredKeys<RouteInput<R>>] extends [never]
  ? [input?: RouteInput<R>, options?: PaginateOptions]
  : [input: RouteInput<R>, options?: PaginateOptions];
