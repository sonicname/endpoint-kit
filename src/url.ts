/** Replace `:name` segments in `path` with URL-encoded values from `params`. */
export function interpolatePath(path: string, params: Record<string, unknown> | undefined): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = params?.[name];
    if (value === undefined || value === null) {
      throw new TypeError(`Missing value for path param ":${name}" in "${path}"`);
    }
    return encodeURIComponent(toStringValue(value));
  });
}

/** How arrays and nested objects become query string pairs. */
export interface QuerySerializerOptions {
  /**
   * - `repeat` (default): `tags=a&tags=b`
   * - `brackets`: `tags[]=a&tags[]=b`
   * - `indices`: `tags[0]=a&tags[1]=b`
   * - `comma`: `tags=a,b`
   */
  arrayFormat?: 'repeat' | 'brackets' | 'indices' | 'comma';
  /**
   * - `json` (default): `filter={"a":1}`
   * - `brackets`: `filter[a]=1` (nested keys, qs style)
   * - `dots`: `filter.a=1`
   */
  objectFormat?: 'json' | 'brackets' | 'dots';
  /** Serialise `Date` values. Defaults to `toISOString()`. */
  date?: (date: Date) => string;
}

/** A custom query serializer: receives the validated query, returns the string after `?`. */
export type QuerySerializer = (query: unknown) => string;

/** Everything `querySerializer` accepts on a repository or route. */
export type QuerySerializerSpec = QuerySerializerOptions | QuerySerializer;

/** Serialise a query object into a query string (without the leading `?`). */
export function buildQueryString(query: unknown, options: QuerySerializerSpec = {}): string {
  if (typeof options === 'function') return options(query).replace(/^\?/, '');
  if (query === undefined || query === null) return '';
  if (typeof query === 'string') return query.replace(/^\?/, '');
  if (query instanceof URLSearchParams) return query.toString();
  if (typeof query !== 'object') return '';

  const search = new URLSearchParams();
  const serialise = (value: unknown): string =>
    value instanceof Date ? (options.date ?? isoDate)(value) : toStringValue(value);

  const append = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      appendArray(key, value);
    } else if (isPlainObject(value) && options.objectFormat && options.objectFormat !== 'json') {
      for (const [childKey, childValue] of Object.entries(value)) {
        append(nestedKey(key, childKey, options.objectFormat), childValue);
      }
    } else {
      search.append(key, serialise(value));
    }
  };

  const appendArray = (key: string, values: unknown[]): void => {
    const items = values.filter((item) => item !== undefined && item !== null);
    switch (options.arrayFormat ?? 'repeat') {
      case 'comma':
        if (items.length > 0) search.append(key, items.map(serialise).join(','));
        return;
      case 'brackets':
        for (const item of items) append(`${key}[]`, item);
        return;
      case 'indices':
        items.forEach((item, index) => {
          append(`${key}[${String(index)}]`, item);
        });
        return;
      case 'repeat':
        for (const item of items) append(key, item);
        return;
    }
  };

  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    append(key, value);
  }
  return search.toString();
}

function nestedKey(parent: string, child: string, format: 'brackets' | 'dots'): string {
  return format === 'dots' ? `${parent}.${child}` : `${parent}[${child}]`;
}

function isoDate(date: Date): string {
  return date.toISOString();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || value instanceof Date) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Stringify a primitive, or JSON-encode anything else. */
export function toStringValue(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'object':
      return JSON.stringify(value);
    default:
      return '';
  }
}

/** Join `baseUrl` and `path` with exactly one slash between them. Absolute paths are kept as is. */
export function joinUrl(baseUrl: string, path: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
  const base = baseUrl.replace(/\/+$/, '');
  const rest = path.replace(/^\/+/, '');
  return rest ? `${base}/${rest}` : base;
}

/** Build the final request URL from base, path, path params and query. */
export function buildUrl(
  baseUrl: string,
  path: string,
  params: Record<string, unknown> | undefined,
  query: unknown,
  serializer?: QuerySerializerSpec,
): string {
  const url = joinUrl(baseUrl, interpolatePath(path, params));
  const search = buildQueryString(query, serializer);
  if (!search) return url;
  return url.includes('?') ? `${url}&${search}` : `${url}?${search}`;
}
