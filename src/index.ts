/**
 * Declare backend endpoints once, get a fully typed client.
 *
 * @packageDocumentation
 */

export { createRoute, errorFromSchema } from './route.js';
export type {
  AnyRoute,
  CallOptions,
  ErrorContext,
  ErrorFactories,
  ErrorFactory,
  ErrorsSpec,
  InferErrors,
  MethodRouteFactory,
  ParamsSchemaMap,
  ParamsSpec,
  PathParamNames,
  PathParams,
  RouteArgs,
  RouteBody,
  RouteBodyOutput,
  RouteCaller,
  RouteDefinition,
  RouteErrors,
  RouteFailure,
  RouteInput,
  RouteMap,
  RouteOptions,
  RouteOutput,
  RouteParams,
  RouteParamsOutput,
  RouteQuery,
  RouteQueryOutput,
  RouteResponseInput,
  RouteResult,
  SchemaOrUndefined,
  ValidateParams,
} from './route.js';

export { createRepository, RepositoryBuilder } from './repository.js';
export type {
  HeadersProvider,
  RepositoryCacheOptions,
  RepositoryClient,
  RepositoryConfig,
  RepositoryHooks,
} from './repository.js';

export { paginate } from './pagination.js';
export type {
  AnyPagination,
  PaginateOptions,
  Pagination,
  PaginationContext,
} from './pagination.js';
export { groupRoutes } from './group.js';
export type { GroupOptions, GroupedRoutes, PrefixedRoute } from './group.js';

export {
  AbortError,
  ApiError,
  NetworkError,
  TaggedError,
  TimeoutError,
  UnknownError,
  ValidationError,
  matchError,
  toRouteError,
} from './errors.js';
export type { ErrorHandlers, HandlerResult, RouteError, ValidationTarget } from './errors.js';

export { fetchAdapter } from './adapters/fetch.js';
export type { FetchAdapterOptions } from './adapters/fetch.js';
// axiosAdapter and ofetchAdapter are published as `endpoint-kit/axios` and `endpoint-kit/ofetch`.
export type {
  Adapter,
  AdapterRequest,
  AdapterResponse,
  HttpMethod,
  ResponseType,
} from './adapters/types.js';

export { composeMiddlewares } from './middleware/types.js';
export type { Middleware, MiddlewareContext, NextFunction } from './middleware/types.js';
export { timeoutMiddleware } from './middleware/timeout.js';
export {
  RETRY_DEFAULTS,
  defaultShouldRetry,
  parseRetryAfter,
  retryMiddleware,
} from './middleware/retry.js';
export type { RetryContext, RetryOptions } from './middleware/retry.js';
export {
  MemoryCacheStorage,
  cacheMiddleware,
  createCacheController,
  defaultCacheKey,
} from './middleware/cache.js';
export type {
  CacheController,
  CacheEntry,
  CacheOptions,
  CacheStorage,
} from './middleware/cache.js';
export { resolvePolicy, resolveTimeout } from './policy.js';
export type { PolicyInput } from './policy.js';

export type { AnySchema, StandardSchemaV1 } from './standard-schema.js';
export { buildQueryString, buildUrl, interpolatePath, joinUrl, toStringValue } from './url.js';
export type { QuerySerializer, QuerySerializerOptions, QuerySerializerSpec } from './url.js';
export { encodeBody, toFormData, toFormUrlEncoded } from './body.js';
export type { BodyType } from './body.js';
export { decodeServerSentEvents, parseServerSentEvents } from './sse.js';
export type { ServerSentEvent } from './sse.js';
