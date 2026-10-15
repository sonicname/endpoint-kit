import { describe, expect, it, vi } from 'vitest';

import { axiosAdapter } from '../src/adapters/axios.js';
import { ofetchAdapter } from '../src/adapters/ofetch.js';
import { fetchAdapter } from '../src/index.js';
import type { AdapterRequest } from '../src/index.js';

const baseRequest: AdapterRequest = {
  url: 'https://a.com/x',
  method: 'POST',
  headers: { 'x-a': '1' },
  responseType: 'json',
};

describe('fetchAdapter', () => {
  it('JSON-encodes plain objects and sets content-type', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'x-r': 'y' } })),
    );
    const adapter = fetchAdapter({ fetch: fetchMock as unknown as typeof fetch });

    const response = await adapter.request({ ...baseRequest, body: { a: 1 } });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(response).toMatchObject({ status: 200, statusText: '', data: { ok: true } });
    expect(response.headers['x-r']).toBe('y');
  });

  it('does not override an explicit content-type and passes FormData through', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    const adapter = fetchAdapter({ fetch: fetchMock as unknown as typeof fetch });
    const form = new FormData();

    const response = await adapter.request({
      ...baseRequest,
      headers: { 'Content-Type': 'text/plain' },
      body: form,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe(form);
    expect(init.headers).toEqual({ 'Content-Type': 'text/plain' });
    expect(response.data).toBeUndefined();
  });

  it('parses text, blob, arrayBuffer and none', async () => {
    const make = (body: string) =>
      fetchAdapter({ fetch: () => Promise.resolve(new Response(body, { status: 200 })) });

    expect((await make('hi').request({ ...baseRequest, responseType: 'text' })).data).toBe('hi');
    expect((await make('hi').request({ ...baseRequest, responseType: 'none' })).data).toBe(
      undefined,
    );
    expect(
      (await make('hi').request({ ...baseRequest, responseType: 'blob' })).data,
    ).toBeInstanceOf(Blob);
    expect(
      (await make('hi').request({ ...baseRequest, responseType: 'arrayBuffer' })).data,
    ).toBeInstanceOf(ArrayBuffer);
  });

  it('falls back to text when JSON parsing fails and undefined for empty bodies', async () => {
    const make = (body: string) =>
      fetchAdapter({ fetch: () => Promise.resolve(new Response(body, { status: 200 })) });

    expect((await make('not json').request(baseRequest)).data).toBe('not json');
    expect((await make('').request(baseRequest)).data).toBeUndefined();
  });

  it('merges default init and per-request options', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    const adapter = fetchAdapter({
      fetch: fetchMock as unknown as typeof fetch,
      init: { credentials: 'include', cache: 'no-store' },
    });

    await adapter.request({ ...baseRequest, options: { cache: 'reload' } });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe('include');
    expect(init.cache).toBe('reload');
  });

  it('throws when no fetch is available', () => {
    vi.stubGlobal('fetch', undefined);
    try {
      expect(() => fetchAdapter()).toThrow(TypeError);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('axiosAdapter', () => {
  it('maps the request and never throws on status', async () => {
    const request = vi.fn((config: Record<string, unknown>) =>
      Promise.resolve({
        status: 404,
        statusText: 'Not Found',
        headers: { 'X-Id': ['1', '2'], empty: null },
        data: { message: 'nope', echo: config },
      }),
    );
    const adapter = axiosAdapter({ request });

    const response = await adapter.request({
      ...baseRequest,
      body: { a: 1 },
      responseType: 'arrayBuffer',
      options: { timeout: 5 },
    });

    const config = request.mock.calls[0]![0];
    expect(config).toMatchObject({
      url: baseRequest.url,
      method: 'POST',
      headers: baseRequest.headers,
      data: { a: 1 },
      responseType: 'arraybuffer',
      timeout: 5,
    });
    expect((config['validateStatus'] as () => boolean)()).toBe(true);
    expect(response.status).toBe(404);
    expect(response.statusText).toBe('Not Found');
    expect(response.headers).toEqual({ 'x-id': '1, 2' });
  });

  it('returns undefined data for responseType none and tolerates missing headers', async () => {
    const adapter = axiosAdapter({
      request: () => Promise.resolve({ status: 200, data: 'ignored' }),
    });

    const response = await adapter.request({ ...baseRequest, responseType: 'none' });

    expect(response).toEqual({ status: 200, statusText: '', headers: {}, data: undefined });
  });
});

describe('ofetchAdapter', () => {
  it('maps the request through $fetch.raw', async () => {
    const raw = vi.fn((_url: string, _options: Record<string, unknown>) =>
      Promise.resolve({
        status: 201,
        statusText: 'Created',
        headers: new Headers({ 'x-r': '1' }),
        _data: { ok: true },
      }),
    );
    const adapter = ofetchAdapter({ raw });

    const response = await adapter.request({
      ...baseRequest,
      body: { a: 1 },
      options: { retry: 2 },
    });

    expect(raw).toHaveBeenCalledWith(baseRequest.url, {
      retry: 2,
      method: 'POST',
      headers: baseRequest.headers,
      body: { a: 1 },
      signal: undefined,
      responseType: 'json',
      ignoreResponseError: true,
    });
    expect(response).toEqual({
      status: 201,
      statusText: 'Created',
      headers: { 'x-r': '1' },
      data: { ok: true },
    });
  });

  it('uses text parsing and drops data for responseType none', async () => {
    const raw = vi.fn((_url: string, _options: Record<string, unknown>) =>
      Promise.resolve({ status: 200, statusText: 'OK', headers: new Headers(), _data: 'x' }),
    );
    const adapter = ofetchAdapter({ raw });

    const response = await adapter.request({ ...baseRequest, responseType: 'none' });

    expect(raw.mock.calls[0]![1]['responseType']).toBe('text');
    expect(response.data).toBeUndefined();
  });
});
