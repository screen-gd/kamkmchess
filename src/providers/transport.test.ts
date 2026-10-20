import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchProvider } from './transport';

describe('browser provider transport', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['GET', 'https://ollama.com/v1/models', undefined],
    ['POST', 'https://ollama.com/v1/chat/completions', '{"model":"gpt-oss:20b","stream":true}'],
    ['POST', 'https://models.example/tenant/v1/responses?api-version=1', '{"model":"custom"}'],
  ])('relays %s requests to remote custom endpoints without a browser preflight', async (method, url, body) => {
    const response = new Response('data: [DONE]\n\n');
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => response);
    vi.stubGlobal('fetch', fetch);
    const abort = new AbortController();
    const result = await fetchProvider(url, {
      method, headers: { authorization: 'Bearer synthetic-key', accept: 'application/json' },
      ...(body === undefined ? {} : { body }), signal: abort.signal,
      credentials: 'omit', redirect: 'error',
    });
    expect(result).toBe(response);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/provider-relay', expect.objectContaining({
      method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: abort.signal,
    }));
    const init = fetch.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      url, method, headers: { authorization: 'Bearer synthetic-key', accept: 'application/json' },
      ...(body === undefined ? {} : { body }),
    });
  });

  it.each([
    'http://127.0.0.1:8317/v1/models',
    'https://localhost:8317/v1/models',
    'https://127.0.0.1/v1/models',
    'https://[::1]/v1/models',
    'https://192.168.1.2/v1/models',
    'https://proxy.local/v1/models',
    'https://models.example:8443/v1/models',
    'https://api.openai.com/v1/models',
    'https://openrouter.ai/api/v1/models',
    'https://api.anthropic.com/v1/models',
  ])('keeps an existing direct route for %s', async url => {
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const init = { method: 'GET', credentials: 'omit' } as const;
    await fetchProvider(url, init);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url, init);
  });
});
