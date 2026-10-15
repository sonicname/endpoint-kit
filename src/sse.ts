import { ValidationError } from './errors.js';
import type { AnySchema } from './standard-schema.js';

/** One event of a `text/event-stream` response. */
export interface ServerSentEvent {
  /** The `event:` field, `"message"` when absent. */
  event: string;
  /** All `data:` lines joined with `\n`. */
  data: string;
  /** The `id:` field, if any. */
  id?: string;
  /** The `retry:` field in ms, if any. */
  retry?: number;
}

/**
 * Parse a byte stream as Server-Sent Events. Comment lines are ignored, events are
 * dispatched on blank lines, and a trailing event without a final blank line is flushed
 * when the stream ends.
 */
export async function* parseServerSentEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let current = emptyEvent();

  const flush = (): ServerSentEvent | undefined => {
    if (current.data.length === 0 && current.event === 'message' && current.id === undefined) {
      current = emptyEvent();
      return undefined;
    }
    const event: ServerSentEvent = { event: current.event, data: current.data.join('\n') };
    if (current.id !== undefined) event.id = current.id;
    if (current.retry !== undefined) event.retry = current.retry;
    current = emptyEvent();
    return event;
  };

  const consumeLine = (line: string): ServerSentEvent | undefined => {
    if (line === '') return flush();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        current.event = value;
        break;
      case 'data':
        current.data.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) current.id = value;
        break;
      case 'retry': {
        const ms = Number(value);
        if (Number.isInteger(ms) && ms >= 0) current.retry = ms;
        break;
      }
      default:
        break;
    }
    return undefined;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = done ? '' : (lines.pop() ?? '');
      for (const line of lines) {
        const event = consumeLine(line);
        if (event) yield event;
      }
      if (done) {
        const last = flush();
        if (last) yield last;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse SSE and, when a schema is given, JSON-decode and validate each event's `data`,
 * yielding the schema output instead of the raw event.
 */
export async function* decodeServerSentEvents(
  stream: ReadableStream<Uint8Array>,
  schema: AnySchema | undefined,
  route: string,
): AsyncGenerator<unknown, void, undefined> {
  for await (const event of parseServerSentEvents(stream)) {
    if (!schema) {
      yield event;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      throw new ValidationError(
        'response',
        [{ message: `SSE event "${event.event}" is not valid JSON`, path: ['data'] }],
        route,
      );
    }
    const result = await schema['~standard'].validate(parsed);
    if (result.issues) throw new ValidationError('response', result.issues, route);
    yield result.value;
  }
}

function emptyEvent(): { event: string; data: string[]; id?: string; retry?: number } {
  return { event: 'message', data: [] };
}
