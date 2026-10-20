import { classifyEndpointRoute } from './connections/route-scope';

const DIRECT_ORIGINS = new Set(['https://api.openai.com', 'https://openrouter.ai', 'https://api.anthropic.com']);

export function usesProviderRelay(url: string): boolean {
  const destination = new URL(url);
  // Keep local destinations in the browser, where the user's proxy is reachable.
  const route = classifyEndpointRoute(url);
  return route.kind === 'public-https' && destination.port === '' && !DIRECT_ORIGINS.has(destination.origin);
}

/** Browser transport shared by catalog checks, diagnostics and game turns. */
export function fetchProvider(url: string, init: RequestInit): Promise<Response> {
  if (!usesProviderRelay(url)) return globalThis.fetch(url, init);
  if (init.body !== undefined && typeof init.body !== 'string') throw new TypeError('Provider requests must contain JSON text.');
  return globalThis.fetch('/api/provider-relay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url, method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers)),
      ...(init.body === undefined ? {} : { body: init.body }),
    }),
    credentials: 'omit', redirect: 'error', cache: 'no-store',
    ...(init.signal === undefined ? {} : { signal: init.signal }),
  });
}
