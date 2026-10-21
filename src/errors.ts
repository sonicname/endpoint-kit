import type { StandardSchemaV1 } from './standard-schema.js';

/**
 * Base class of every error this library produces. The `_tag` discriminant makes
 * narrowing trivial: `if (error._tag === 'ApiError')` or `matchError(error, {...})`.
 *
 * Extend it for custom errors declared in `errors` maps or thrown from middlewares.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- Tag is the discriminant subclasses pin down
export abstract class TaggedError<Tag extends string = string> extends Error {
  abstract readonly _tag: Tag;
}

/** Where a validation failure happened. */
export type ValidationTarget = 'params' | 'query' | 'body' | 'headers' | 'response' | 'error';

/** Thrown when request input or the response body does not match its schema. */
export class ValidationError extends TaggedError<'ValidationError'> {
  readonly _tag = 'ValidationError';
  override readonly name = 'ValidationError';

  constructor(
    /** Which part of the request/response failed validation. */
    readonly target: ValidationTarget,
    /** Issues reported by the schema library. */
    readonly issues: readonly StandardSchemaV1.Issue[],
    /** Name of the route that was being called. */
    readonly route: string,
  ) {
    super(`Validation failed for ${target} of route "${route}": ${formatIssues(issues)}`);
  }
}

/** Thrown when the server answers with a non-successful status code. */
export class ApiError<TData = unknown> extends TaggedError<'ApiError'> {
  readonly _tag = 'ApiError';
  override readonly name = 'ApiError';

  constructor(
    readonly status: number,
    /** Parsed response body, if any. */
    readonly data: TData,
    /** Name of the route that was being called. */
    readonly route: string,
    readonly headers: Record<string, string> = {},
    readonly statusText = '',
  ) {
    super(
      `Request to route "${route}" failed with status ${String(status)}${statusText ? ` ${statusText}` : ''}`,
    );
  }
}

/** Thrown when an attempt exceeds the configured timeout. */
export class TimeoutError extends TaggedError<'TimeoutError'> {
  readonly _tag = 'TimeoutError';
  override readonly name = 'TimeoutError';

  constructor(
    /** Name of the route that was being called. */
    readonly route: string,
    /** The timeout that was exceeded, in ms. */
    readonly timeout: number,
  ) {
    super(`Request to route "${route}" timed out after ${String(timeout)}ms`);
  }
}

/** Thrown when the caller aborted the request through its `signal`. */
export class AbortError extends TaggedError<'AbortError'> {
  readonly _tag = 'AbortError';
  override readonly name = 'AbortError';

  constructor(
    /** Name of the route that was being called. */
    readonly route: string,
    /** The original abort reason. */
    override readonly cause?: unknown,
  ) {
    super(`Request to route "${route}" was aborted`, { cause });
  }
}

/** Thrown when the transport could not reach the server (DNS, connection, CORS...). */
export class NetworkError extends TaggedError<'NetworkError'> {
  readonly _tag = 'NetworkError';
  override readonly name = 'NetworkError';

  constructor(
    /** Name of the route that was being called. */
    readonly route: string,
    /** The error thrown by the adapter. */
    override readonly cause: unknown,
  ) {
    super(`Request to route "${route}" failed: ${messageOf(cause)}`, { cause });
  }
}

/** Wraps anything else thrown during a call (a middleware bug, a URL building error...). */
export class UnknownError extends TaggedError<'UnknownError'> {
  readonly _tag = 'UnknownError';
  override readonly name = 'UnknownError';

  constructor(
    /** Name of the route that was being called. */
    readonly route: string,
    /** The original value that was thrown. */
    override readonly cause: unknown,
  ) {
    super(messageOf(cause), { cause });
  }
}

/** The built-in errors a route call can produce. Custom ones are added per route or repository. */
export type RouteError =
  ApiError | ValidationError | TimeoutError | AbortError | NetworkError | UnknownError;

/**
 * Normalise anything thrown during a route call into a {@link TaggedError}.
 * Tagged errors (built-in or custom) pass through, aborts become {@link AbortError},
 * transport failures become {@link NetworkError}, everything else {@link UnknownError}.
 */
export function toRouteError(error: unknown, route: string): TaggedError {
  if (isTaggedError(error)) return error;
  if (isAbort(error)) return new AbortError(route, error);
  if (isNetworkFailure(error)) return new NetworkError(route, error);
  return new UnknownError(route, error);
}

// ---------------------------------------------------------------------------
// Header redaction
// ---------------------------------------------------------------------------

/** Header names (lower case) whose values are masked in errors and hooks by default. */
export const DEFAULT_REDACTED_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
];

/** Placeholder written in place of a redacted value. */
export const REDACTED = '[redacted]';

/**
 * Copy `headers` with sensitive values replaced by {@link REDACTED}. Names are matched case
 * insensitively; besides `names`, anything containing `token`, `secret` or `password` is masked.
 */
export function redactHeaders(
  headers: Record<string, string>,
  names: readonly string[] = DEFAULT_REDACTED_HEADERS,
): Record<string, string> {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    out[key] = wanted.has(lower) || /token|secret|password/.test(lower) ? REDACTED : value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// matchError
// ---------------------------------------------------------------------------

type TagOf<E> = E extends { readonly _tag: infer Tag extends string } ? Tag : never;
type ByTag<E, Tag extends string> = Extract<E, { readonly _tag: Tag }>;

/** One optional handler per tag, plus an optional `_` fallback. */
export type ErrorHandlers<E extends TaggedError> = {
  readonly [Tag in TagOf<E>]?: (error: ByTag<E, Tag>) => unknown;
} & {
  readonly _?: (error: E) => unknown;
};

/** Resolves to `unknown` when `H` is exhaustive, otherwise names the handlers that are missing. */
type MissingHandlers<E extends TaggedError, H> = '_' extends keyof H
  ? unknown
  : [Exclude<TagOf<E>, keyof H>] extends [never]
    ? unknown
    : {
        readonly [Tag in Exclude<TagOf<E>, keyof H>]: (error: ByTag<E, Tag>) => unknown;
      };

/** Union of the return types of the handlers in `H`. */
export type HandlerResult<H> = {
  [K in keyof H]: H[K] extends (...args: never[]) => infer R ? R : never;
}[keyof H];

/**
 * Dispatch on `error._tag`. Either handle every tag of `E` or provide a `_` fallback;
 * forgetting one is a compile error. Returns whatever the chosen handler returns.
 *
 * @example
 * ```ts
 * const { error } = await api.getUser({ params: { id } });
 * if (error) {
 *   return matchError(error, {
 *     ApiError: (e) => (e.status === 404 ? 'Not found' : `Server said ${e.status}`),
 *     NotFoundError: (e) => `No user ${e.id}`, // a custom error declared on the route
 *     _: (e) => e.message,
 *   });
 * }
 * ```
 */
export function matchError<E extends TaggedError, const H extends ErrorHandlers<E>>(
  error: E,
  handlers: H & NoInfer<MissingHandlers<E, H>>,
): HandlerResult<H> {
  const table = handlers as Record<string, ((error: E) => unknown) | undefined>;
  const handler = table[error._tag] ?? table['_'];
  if (!handler) {
    throw error;
  }
  return handler(error) as HandlerResult<H>;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Duck-typed: the error may come from another copy of this module (another entry or build). */
function isTaggedError(value: unknown): value is TaggedError {
  return (
    value instanceof TaggedError ||
    (value instanceof Error && typeof (value as { _tag?: unknown })._tag === 'string')
  );
}

function isAbort(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return name === 'AbortError' || name === 'CanceledError' || code === 'ERR_CANCELED';
}

const NETWORK_CODES = new Set([
  'ERR_NETWORK',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const NETWORK_MESSAGES =
  /fetch failed|failed to fetch|networkerror|network request failed|load failed/i;

function isNetworkFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, code, message, cause } = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
  if (name === 'TypeError' && typeof message === 'string' && NETWORK_MESSAGES.test(message)) {
    return true;
  }
  // undici wraps the socket error in `cause`
  return cause !== undefined && cause !== error && isNetworkFailure(cause);
}

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value) as string | undefined;
    return json ?? 'undefined';
  } catch {
    return 'Unknown error';
  }
}

function formatIssues(issues: readonly StandardSchemaV1.Issue[]): string {
  return issues
    .map((issue) => {
      const path = (issue.path ?? [])
        .map((segment) => (typeof segment === 'object' ? String(segment.key) : String(segment)))
        .join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}
