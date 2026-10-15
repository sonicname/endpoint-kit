import { buildQueryString, toStringValue } from './url.js';
import type { QuerySerializerSpec } from './url.js';

/** How a route's body is encoded on the wire. */
export type BodyType = 'json' | 'multipart' | 'form';

/**
 * Build a `FormData` from a plain object. `Blob`/`File` values are appended as files,
 * arrays append one entry per item, nested objects are JSON-encoded, `undefined` and
 * `null` are skipped.
 */
export function toFormData(value: unknown): FormData {
  const form = new FormData();
  if (value instanceof FormData) return value;
  if (typeof value !== 'object' || value === null) return form;

  const appendOne = (key: string, item: unknown): void => {
    if (item === undefined || item === null) return;
    if (typeof Blob !== 'undefined' && item instanceof Blob) {
      const name = typeof File !== 'undefined' && item instanceof File ? item.name : undefined;
      if (name === undefined) form.append(key, item);
      else form.append(key, item, name);
      return;
    }
    form.append(key, item instanceof Date ? item.toISOString() : toStringValue(item));
  };

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(item)) {
      for (const entry of item) appendOne(key, entry);
    } else {
      appendOne(key, item);
    }
  }
  return form;
}

/** Build `URLSearchParams` (application/x-www-form-urlencoded) from a plain object. */
export function toFormUrlEncoded(
  value: unknown,
  serializer?: QuerySerializerSpec,
): URLSearchParams {
  if (value instanceof URLSearchParams) return value;
  return new URLSearchParams(buildQueryString(value, serializer));
}

/** Encode a validated body according to the route's `bodyType`. */
export function encodeBody(
  body: unknown,
  bodyType: BodyType | undefined,
  serializer?: QuerySerializerSpec,
): unknown {
  if (body === undefined) return undefined;
  switch (bodyType) {
    case 'multipart':
      return toFormData(body);
    case 'form':
      return toFormUrlEncoded(body, serializer);
    default:
      return body;
  }
}
