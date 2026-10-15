import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import {
  createRepository,
  createRoute,
  fetchAdapter,
  parseServerSentEvents,
  ValidationError,
} from '../src/index.js';
import type { ServerSentEvent } from '../src/index.js';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('parseServerSentEvents', () => {
  it('parses fields, multi-line data, comments, ids and retry across chunk boundaries', async () => {
    const events = await collect(
      parseServerSentEvents(
        streamOf([
          ': comment\n',
          'event: tick\ndata: {"n":',
          '1}\nid: 7\n\n',
          'data: line one\ndata: line two\nretry: 1500\n\n',
          'data:no-space\r\n\r\n',
          'event: trailing\ndata: last', // no final blank line
        ]),
      ),
    );

    expect(events).toEqual([
      { event: 'tick', data: '{"n":1}', id: '7' },
      { event: 'message', data: 'line one\nline two', retry: 1500 },
      { event: 'message', data: 'no-space' },
      { event: 'trailing', data: 'last' },
    ]);
  });

  it('ignores blank events and invalid retry values', async () => {
    const events = await collect(
      parseServerSentEvents(streamOf(['\n\n', 'retry: x\ndata: a\n\n'])),
    );
    expect(events).toEqual([{ event: 'message', data: 'a' }]);
  });
});

describe('responseType sse and stream on routes', () => {
  const sseResponse = (body: string) =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

  it('yields validated schema outputs per event', async () => {
    const adapter = fetchAdapter({
      fetch: () => Promise.resolve(sseResponse('data: {"n":1}\n\ndata: {"n":2}\n\n')),
    });
    const ticks = createRoute.get('/ticks', {
      responseType: 'sse',
      response: z.object({ n: z.number() }),
    });
    const api = createRepository({ baseUrl: 'https://a.com', adapter }).mergeAll({ ticks }).build();

    const { data, error } = await api.ticks();
    expect(error).toBeNull();
    expectTypeOf(data).toEqualTypeOf<AsyncIterable<{ n: number }> | null>();

    expect(await collect(data!)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('yields raw events without a schema and rejects bad JSON with one', async () => {
    const adapter = fetchAdapter({ fetch: () => Promise.resolve(sseResponse('data: hi\n\n')) });
    const raw = createRoute.get('/raw', { responseType: 'sse' });
    const typed = createRoute.get('/typed', { responseType: 'sse', response: z.object({}) });
    const api = createRepository({ baseUrl: 'https://a.com', adapter })
      .mergeAll({ raw, typed })
      .build();

    const rawResult = await api.raw();
    expectTypeOf(rawResult.data).toEqualTypeOf<AsyncIterable<ServerSentEvent> | null>();
    expect(await collect(rawResult.data!)).toEqual([{ event: 'message', data: 'hi' }]);

    const typedResult = await api.typed();
    await expect(collect(typedResult.data!)).rejects.toBeInstanceOf(ValidationError);
  });

  it('hands back the raw stream for responseType stream', async () => {
    const adapter = fetchAdapter({
      fetch: () => Promise.resolve(new Response('bytes', { status: 200 })),
    });
    const download = createRoute.get('/file', { responseType: 'stream' });
    const api = createRepository({ baseUrl: 'https://a.com', adapter, cache: 1000 })
      .mergeAll({ download })
      .build();

    const { data } = await api.download();
    expectTypeOf(data).toEqualTypeOf<ReadableStream<Uint8Array> | null>();
    expect(data).toBeInstanceOf(ReadableStream);
    expect(await new Response(data).text()).toBe('bytes');

    // not cached: a second call gets a fresh stream
    const second = await api.download();
    expect(await new Response(second.data).text()).toBe('bytes');
  });
});
