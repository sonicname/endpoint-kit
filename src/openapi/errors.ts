import { literal } from './schema.js';

const STATUS_NAMES: Record<number, string> = {
  400: 'BadRequestError',
  401: 'UnauthorizedError',
  402: 'PaymentRequiredError',
  403: 'ForbiddenError',
  404: 'NotFoundError',
  405: 'MethodNotAllowedError',
  406: 'NotAcceptableError',
  408: 'RequestTimeoutError',
  409: 'ConflictError',
  410: 'GoneError',
  412: 'PreconditionFailedError',
  413: 'PayloadTooLargeError',
  415: 'UnsupportedMediaTypeError',
  422: 'UnprocessableEntityError',
  429: 'TooManyRequestsError',
  500: 'InternalServerError',
  501: 'NotImplementedError',
  502: 'BadGatewayError',
  503: 'ServiceUnavailableError',
  504: 'GatewayTimeoutError',
};

/** Keys an `errors` map accepts: a status, a status class or `default`. */
export type ErrorKey = number | '4XX' | '5XX' | 'default';

const RANGE_NAMES: Record<string, string> = {
  '4XX': 'ClientError',
  '5XX': 'ServerError',
  default: 'UnexpectedError',
};

/** Tracks one generated `TaggedError` subclass per HTTP status (or class) used by the spec. */
export class ErrorClasses {
  /** key → class name, in first-use order. */
  readonly used = new Map<ErrorKey, string>();
  readonly #taken: Set<string>;

  constructor(reserved: readonly string[]) {
    this.#taken = new Set(reserved);
  }

  /** Class name for `key`, creating it on first use. */
  for(key: ErrorKey): string {
    const existing = this.used.get(key);
    if (existing) return existing;
    const base =
      typeof key === 'number'
        ? (STATUS_NAMES[key] ?? `Http${String(key)}Error`)
        : (RANGE_NAMES[key] ?? 'UnexpectedError');
    let name = base;
    let counter = 2;
    while (this.#taken.has(name)) name = `${base}${String(counter++)}`;
    this.#taken.add(name);
    this.used.set(key, name);
    return name;
  }

  /** Source of every class, sorted by status. */
  declarations(): string[] {
    const rank = (key: ErrorKey): number =>
      typeof key === 'number' ? key : key === '4XX' ? 499.5 : key === '5XX' ? 599.5 : 1000;
    return [...this.used.entries()]
      .sort(([a], [b]) => rank(a) - rank(b))
      .map(([key, name]) => classSource(key, name));
  }
}

function classSource(key: ErrorKey, name: string): string {
  const tag = literal(name);
  const label =
    typeof key === 'number'
      ? `HTTP ${String(key)}`
      : key === 'default'
        ? 'Any other failing status'
        : `HTTP ${key}`;
  return [
    `/** ${label}. \`data\` is the response body, typed per route when the spec gives a schema. */`,
    `export class ${name}<TData = unknown> extends TaggedError<${tag}> {`,
    `  readonly _tag = ${tag};`,
    `  override readonly name = ${tag};`,
    '  readonly status: number;',
    '  readonly route: string;',
    '  readonly headers: Record<string, string>;',
    '  constructor(',
    '    readonly data: TData,',
    '    context: { status: number; statusText?: string; headers: Record<string, string>; route: string },',
    '  ) {',
    '    super(`Request to route "${context.route}" failed with status ${String(context.status)}`);',
    '    this.status = context.status;',
    '    this.route = context.route;',
    '    this.headers = context.headers;',
    '  }',
    '}',
  ].join('\n');
}
