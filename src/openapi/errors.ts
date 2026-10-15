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

/** Tracks one generated `TaggedError` subclass per HTTP status used by the spec. */
export class ErrorClasses {
  /** status → class name, in first-use order. */
  readonly used = new Map<number, string>();
  readonly #taken: Set<string>;

  constructor(reserved: readonly string[]) {
    this.#taken = new Set(reserved);
  }

  /** Class name for `status`, creating it on first use. */
  for(status: number): string {
    const existing = this.used.get(status);
    if (existing) return existing;
    let name = STATUS_NAMES[status] ?? `Http${String(status)}Error`;
    let counter = 2;
    while (this.#taken.has(name))
      name = `${STATUS_NAMES[status] ?? `Http${String(status)}Error`}${String(counter++)}`;
    this.#taken.add(name);
    this.used.set(status, name);
    return name;
  }

  /** Source of every class, sorted by status. */
  declarations(): string[] {
    return [...this.used.entries()]
      .sort(([a], [b]) => a - b)
      .map(([status, name]) => classSource(status, name));
  }
}

function classSource(status: number, name: string): string {
  const tag = literal(name);
  return [
    `/** HTTP ${String(status)}. \`data\` is the response body, typed per route when the spec gives a schema. */`,
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
