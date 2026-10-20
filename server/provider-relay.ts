import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http';
import { request } from 'node:https';
import type { RequestOptions } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { validateEndpointUrl } from '../src/providers/connections/profile.js';

const MAX_REQUEST_BYTES = 2_000_000;
const TIMEOUT_MS = 300_000;
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

interface RelayEnvelope {
  url: URL;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

interface RelayOptions {
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
  request?: (options: RequestOptions, listener: (response: IncomingMessage) => void) => ClientRequest;
  timeoutMs?: number;
}

class RelayError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function reply(response: ServerResponse, status: number, message: string) {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: { message } }));
}

async function readEnvelope(request: IncomingMessage): Promise<RelayEnvelope> {
  // Vercel may parse the body before invoking the function; Vite passes a stream.
  const parsed = (request as IncomingMessage & { body?: unknown }).body;
  let raw: string;
  if (parsed !== undefined) raw = typeof parsed === 'string' ? parsed : Buffer.isBuffer(parsed) ? parsed.toString('utf8') : JSON.stringify(parsed);
  else {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_REQUEST_BYTES) throw new RelayError(413, 'Provider request is too large.');
      chunks.push(bytes);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) throw new RelayError(413, 'Provider request is too large.');
  const data: unknown = JSON.parse(raw);
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new RelayError(400, 'Invalid provider request.');
  const envelope = data as Record<string, unknown>;
  if (typeof envelope.url !== 'string') throw new RelayError(400, 'Invalid provider destination.');
  const url = new URL(validateEndpointUrl(envelope.url));
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443')
    || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || (isIP(hostname) && !isPublicAddress(hostname))) {
    throw new RelayError(400, 'The relay requires a public HTTPS provider on port 443. Use a direct connection for local providers.');
  }
  if (envelope.method !== 'GET' && envelope.method !== 'POST') throw new RelayError(400, 'Unsupported provider method.');
  if (envelope.body !== undefined && (typeof envelope.body !== 'string' || envelope.method !== 'POST')) throw new RelayError(400, 'Invalid provider body.');
  if (envelope.headers === null || typeof envelope.headers !== 'object' || Array.isArray(envelope.headers)) throw new RelayError(400, 'Invalid provider headers.');
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(envelope.headers)) {
    const lower = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(lower) || typeof value !== 'string' || /[\r\n]/.test(value)
      || /^(?:host|cookie|origin|referer|connection|content-length|transfer-encoding|upgrade|te|trailer|expect|forwarded|via|accept-encoding|proxy-.*|sec-.*|x-forwarded-.*|x-vercel-.*|x-real-ip)$/.test(lower)) {
      throw new RelayError(400, 'Invalid provider headers.');
    }
    headers[lower] = value;
  }
  return { url, method: envelope.method, headers, ...(typeof envelope.body === 'string' ? { body: envelope.body } : {}) };
}

/** Stateless HTTPS relay. Credentials stay in this request and are never logged. */
export function createProviderRelay(options: RelayOptions = {}) {
  const resolve = options.resolve ?? (hostname => lookup(hostname, { all: true, verbatim: true }));
  const startRequest = options.request ?? request;
  return async (incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> => {
    outgoing.setHeader('cache-control', 'no-store');
    if (incoming.method !== 'POST') { reply(outgoing, 405, 'Use POST for provider requests.'); return; }
    const origin = incoming.headers.origin;
    const site = incoming.headers['sec-fetch-site'];
    let sameOrigin = !origin;
    try { if (origin) sameOrigin = new URL(origin).host === incoming.headers.host; } catch { sameOrigin = false; }
    if (!sameOrigin || (site && site !== 'same-origin' && site !== 'none')) {
      reply(outgoing, 403, 'Cross-origin relay requests are not allowed.'); return;
    }
    if (!incoming.headers['content-type']?.startsWith('application/json')) { reply(outgoing, 415, 'Use a JSON provider request.'); return; }
    try {
      const envelope = await readEnvelope(incoming);
      const hostname = envelope.url.hostname.replace(/^\[|\]$/g, '');
      const addresses = await resolve(hostname);
      if (!addresses.length || addresses.some(address => !isPublicAddress(address.address))) throw new RelayError(400, 'The provider must resolve only to public addresses.');
      if (outgoing.destroyed) return;
      // Connect to the checked address itself, keeping TLS identity and Host tied
      // to the original hostname. A second DNS lookup cannot rebind the target.
      await new Promise<void>((done) => {
        const upstream = startRequest({
          hostname: addresses[0]!.address, family: addresses[0]!.family, port: 443,
          servername: isIP(hostname) ? undefined : hostname,
          method: envelope.method, path: `${envelope.url.pathname}${envelope.url.search}`,
          headers: { ...envelope.headers, host: envelope.url.host },
          agent: false,
        }, response => {
          const status = response.statusCode ?? 502;
          if (status >= 300 && status < 400) {
            response.destroy(); reply(outgoing, 502, 'Provider redirects are not allowed.'); return;
          }
          for (const header of ['content-type', 'retry-after', 'x-request-id', 'request-id']) {
            const value = response.headers[header];
            if (value !== undefined) outgoing.setHeader(header, value);
          }
          outgoing.setHeader('x-accel-buffering', 'no');
          outgoing.writeHead(status);
          outgoing.flushHeaders();
          response.on('error', () => outgoing.destroy());
          response.pipe(outgoing);
        });
        const timer = setTimeout(() => { reply(outgoing, 504, 'Provider request timed out.'); upstream.destroy(); }, options.timeoutMs ?? TIMEOUT_MS);
        const finish = () => { clearTimeout(timer); upstream.destroy(); done(); };
        outgoing.once('close', finish);
        outgoing.once('finish', finish);
        incoming.once('aborted', finish);
        upstream.once('error', () => reply(outgoing, 502, 'The provider could not be reached.'));
        upstream.end(envelope.body);
      });
    } catch (error) {
      reply(outgoing, error instanceof RelayError ? error.status : 400, error instanceof RelayError ? error.message : 'Invalid or unreachable provider destination.');
    }
  };
}
