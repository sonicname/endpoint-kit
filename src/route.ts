import type { HttpMethod, ResponseType } from './adapters/types.js';
import { ValidationError } from './errors.js';
import type { RouteError, TaggedError } from './errors.js';
import type { CacheOptions } from './middleware/cache.js';
import type { RetryOptions } from './middleware/retry.js';
import type { Middleware } from './middleware/types.js';
import type { AnySchema, StandardSchemaV1 } from './standard-schema.js';
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

/** Custom errors keyed by HTTP status. The factory's return type becomes part of `error`'s type. */
export type ErrorFactories = Readonly<Record<number, ErrorFactory>>;

/** Everything the `errors` field accepts. */
export type ErrorsSpec = ErrorFactories | undefined;

/**
 * Union of the errors produced by an {@link ErrorFactories} map, or `never` when the
 * slot is empty or unconstrained (see {@link SchemaOf} for why the latter matters).
 */
export type InferErrors<E> = [NonNullable<E>] extends [never]
  ? never
  : ErrorFactories extends NonNullable<E>
    ? never
    : NonNullable<E>[keyof NonNullable<E>] extends (...args: never[]) => infer R
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
  /** Static headers sent with every call of this route. */
  headers?: Record<string, string>;
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
>(
  definition: RouteDefinition<TPath, TParams, TQuery, TBody, TResponse, TResponseType, TErrors> & {
    params?: NoInfer<ValidateParams<TPath, TParams>>;
  },
): RouteDefinition<TPath, TParams, TQuery, TBody, TResponse, TResponseType, TErrors> {
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
> = Omit<
  RouteDefinition<TPath, TParams, TQuery, TBody, TResponse, TResponseType, TErrors>,
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
>(
  path: TPath,
  options?: RouteOptions<TPath, TParams, TQuery, TBody, TResponse, TResponseType, TErrors> & {
    params?: NoInfer<ValidateParams<TPath, TParams>>;
  },
) => RouteDefinition<TPath, TParams, TQuery, TBody, TResponse, TResponseType, TErrors>;

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

/** Options every call accepts in addition to params/query/body. */
export interface CallOptions {
  /** Extra headers merged over repository and route headers. */
  headers?: Record<string, string>;
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

/** The single argument a route caller accepts. */
export type RouteInput<R extends AnyRoute> = Simplify<
  Field<'params', RouteParams<R>> &
    Field<'query', RouteQuery<R>> &
    Field<'body', RouteBody<R>> &
    CallOptions
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
          : unknown;

/** What a successful call resolves with: the response schema output, or the raw parsed body. */
export type RouteOutput<R extends AnyRoute> = OutputOf<R['response'], ParsedBody<R>>;

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
export interface RouteCaller<R extends AnyRoute, TRepoErrors = never> {
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
