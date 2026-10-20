import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RequestOptions } from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderRelay, isPublicAddress } from '../../server/provider-relay';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  })));
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void, addresses = ['8.8.8.8'], timeoutMs = 2_000) {
  const upstream = new URL(await listen(handler));
  const resolve = vi.fn(async () => addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 })));
  const request = vi.fn((options: RequestOptions, listener: (response: IncomingMessage) => void) => httpRequest({
    hostname: upstream.hostname, port: upstream.port,
    method: options.method, path: options.path, headers: options.headers,
  }, listener));
  const url = await listen(createProviderRelay({ resolve, request, timeoutMs }));
  return { url, resolve, request };
}

const envelope = {
  url: 'https://ollama.com/v1/models', method: 'GET',
  headers: { authorization: 'Bearer synthetic-key', accept: 'application/json' },
};
function call(url: string, body: unknown = envelope, headers: Record<string, string> = {}) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

describe('provider relay', () => {
  it('forwards authenticated catalogs to the checked IP with the original TLS identity and no browser cookies', async () => {
    const f = await fixture((req, res) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe('/v1/models');
      expect(req.headers.authorization).toBe('Bearer synthetic-key');
      expect(req.headers.host).toBe('ollama.com');
      expect(req.headers.cookie).toBeUndefined();
      expect(req.headers.origin).toBeUndefined();
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'private=upstream' });
      res.end('{"data":[{"id":"gpt-oss:20b"}]}');
    });
    const response = await call(f.url, envelope, { cookie: 'site=private', origin: f.url });
    expect(await response.json()).toEqual({ data: [{ id: 'gpt-oss:20b' }] });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith('ollama.com');
    expect(f.request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      hostname: '8.8.8.8', family: 4, servername: 'ollama.com', port: 443, agent: false,
    }), expect.any(Function));
  });

  it('streams generation bytes before completion and preserves the request body and query', async () => {
    let finish: (() => void) | undefined;
    const f = await fixture((req, res) => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/team/v1/chat/completions?version=1');
      let body = '';
      req.on('data', bytes => { body += String(bytes); });
      req.on('end', () => {
        expect(body).toBe('{"model":"gpt-oss:20b","stream":true}');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: first\n\n');
        finish = () => res.end('data: [DONE]\n\n');
      });
    });
    const response = await call(f.url, {
      ...envelope, url: 'https://ollama.com/team/v1/chat/completions?version=1', method: 'POST',
      headers: { ...envelope.headers, 'content-type': 'application/json' }, body: '{"model":"gpt-oss:20b","stream":true}',
    });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n');
    finish!();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: [DONE]\n\n');
    expect((await reader.read()).done).toBe(true);
  });

  it('preserves provider error status and diagnostic headers', async () => {
    const f = await fixture((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30', 'x-request-id': 'request-1' });
      res.end('{"error":{"message":"Rate limited"}}');
    });
    const response = await call(f.url);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
    expect(response.headers.get('x-request-id')).toBe('request-1');
    expect(await response.json()).toEqual({ error: { message: 'Rate limited' } });
  });

  it('refuses redirects without forwarding credentials to the redirect target', async () => {
    let calls = 0;
    const f = await fixture((_req, res) => {
      calls++;
      res.writeHead(302, { location: 'http://127.0.0.1/private' }); res.end();
    });
    const response = await call(f.url);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('redirects are not allowed');
    expect(calls).toBe(1);
  });

  it.each([
    'http://ollama.com/v1/models', 'https://localhost/v1/models', 'https://127.1/v1/models',
    'https://[::1]/v1/models', 'https://[::ffff:127.0.0.1]/v1/models', 'https://10.0.0.1/v1/models',
    'https://ollama.com:8443/v1/models', 'https://key@ollama.com/v1/models',
    'https://ollama.com/v1/models?api_key=synthetic-key',
  ])('blocks unsafe destination %s before DNS or HTTP', async url => {
    const f = await fixture((_req, res) => res.end());
    const response = await call(f.url, { ...envelope, url });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('synthetic-key');
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each([['127.0.0.1'], ['8.8.8.8', '169.254.169.254'], ['::ffff:10.0.0.1']])('rejects private or mixed DNS answers %j', async (...addresses) => {
    const f = await fixture((_req, res) => res.end(), addresses);
    expect((await call(f.url)).status).toBe(400);
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(['cookie', 'host', 'origin', 'content-length', 'connection', 'x-forwarded-for', 'accept-encoding', 'proxy-authorization', 'x-vercel-id'])('rejects unsafe forwarded header %s', async name => {
    const f = await fixture((_req, res) => res.end());
    expect((await call(f.url, { ...envelope, headers: { [name]: 'synthetic-key' } })).status).toBe(400);
    expect(f.request).not.toHaveBeenCalled();
  });

  it('rejects cross-origin and malformed-origin callers', async () => {
    const f = await fixture((_req, res) => res.end());
    for (const origin of ['https://other.example', 'null', 'invalid']) {
      expect((await call(f.url, envelope, { origin })).status).toBe(403);
    }
    expect((await call(f.url, envelope, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect(f.request).not.toHaveBeenCalled();
  });

  it('bounds request size and upstream wait time', async () => {
    const f = await fixture(() => {}, ['8.8.8.8'], 50);
    expect((await call(f.url, { ...envelope, body: 'x'.repeat(2_000_001) })).status).toBe(413);
    const response = await call(f.url);
    expect(response.status).toBe(504);
    expect(await response.text()).not.toContain('synthetic-key');
  });

  it('closes the upstream stream when the browser cancels', async () => {
    let closed: (() => void) | undefined;
    const upstreamClosed = new Promise<void>(resolve => { closed = resolve; });
    const f = await fixture((_req, res) => {
      res.on('close', () => closed!());
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n');
    });
    const abort = new AbortController();
    const response = await fetch(f.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope), signal: abort.signal });
    const reader = response.body!.getReader();
    await reader.read();
    abort.abort();
    await upstreamClosed;
    expect((await reader.read().catch(error => error)).name).toBe('AbortError');
  });
});

describe('public relay addresses', () => {
  it.each(['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1', '2002:7f00:1::'])('rejects %s', address => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('accepts %s', address => {
    expect(isPublicAddress(address)).toBe(true);
  });
});
