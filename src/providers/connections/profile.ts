import { ConnectionError } from './types.js';
import type {
  ConnectionAuth,
  CatalogPagination,
  ConnectionEndpoints,
  ConnectionHeader,
  ConnectionProfile,
  ConnectionProtocol,
  ConnectionProvider,
} from './types.js';

const DEFAULT_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  anthropic: 'https://api.anthropic.com/v1',
  cliproxy: 'http://127.0.0.1:8317/v1',
} as const;

const DEFAULT_PROTOCOLS = {
  openai: 'responses',
  openrouter: 'chat-completions',
  anthropic: 'messages',
  cliproxy: 'chat-completions',
} as const satisfies Record<Exclude<ConnectionProvider, 'custom'>, ConnectionProtocol>;

const DEFAULT_AUTH = {
  openai: { kind: 'bearer' },
  openrouter: { kind: 'bearer' },
  anthropic: { kind: 'api-key-header', headerName: 'x-api-key' },
  cliproxy: { kind: 'bearer' },
} as const satisfies Record<Exclude<ConnectionProvider, 'custom'>, ConnectionAuth>;

const DEFAULT_CATALOG_PAGINATION = {
  openai: 'after',
  openrouter: 'none',
  anthropic: 'after_id',
  cliproxy: 'none',
} as const satisfies Record<Exclude<ConnectionProvider, 'custom'>, CatalogPagination>;

const ROUTES: Record<ConnectionProtocol, string> = {
  'chat-completions': '/chat/completions',
  responses: '/responses',
  messages: '/messages',
};

const CREDENTIAL_NAME_WORDS = new Set([
  'accesstoken',
  'apikey',
  'auth',
  'authentication',
  'authorization',
  'credential',
  'key',
  'password',
  'secret',
  'signature',
  'token',
  'bearer',
]);
const CREDENTIAL_NAME_FRAGMENTS = [
  'accesstoken',
  'accesskey',
  'apikey',
  'authbearer',
  'authcode',
  'authcredential',
  'authentication',
  'authorization',
  'authid',
  'authkey',
  'authpassword',
  'authsecret',
  'authsignature',
  'authtoken',
  'bearer',
  'clientkey',
  'credential',
  'credentialkey',
  'encryptionkey',
  'keyid',
  'licensekey',
  'password',
  'privatekey',
  'secret',
  'secretkey',
  'servicekey',
  'signature',
  'signingkey',
  'subscriptionkey',
  'token',
];

const RESERVED_HEADER_NAMES = new Set([
  'accept',
  'authorization',
  'content-length',
  'content-type',
  'cookie',
  'host',
  'origin',
  'proxy-authorization',
]);

export interface PresetConnectionInput {
  readonly id: string;
  readonly name: string;
  readonly provider: Exclude<ConnectionProvider, 'custom'>;
  readonly protocol?: ConnectionProtocol;
  readonly baseUrl?: string;
  readonly catalogUrl?: string | null;
  readonly catalogPagination?: CatalogPagination;
  readonly auth?: ConnectionAuth;
  readonly headers?: readonly ConnectionHeader[];
}

export interface CustomConnectionInput {
  readonly id: string;
  readonly name: string;
  readonly provider: 'custom';
  readonly protocol: ConnectionProtocol;
  readonly baseUrl: string;
  readonly catalogUrl?: string;
  readonly catalogPagination?: CatalogPagination;
  readonly auth: ConnectionAuth;
  readonly headers?: readonly ConnectionHeader[];
}

export type CreateConnectionProfileInput = PresetConnectionInput | CustomConnectionInput;

export async function createConnectionProfile(
  input: CreateConnectionProfileInput,
): Promise<ConnectionProfile> {
  if (!isRecord(input) || typeof input.id !== 'string' || typeof input.name !== 'string'
    || !isProvider(input.provider)) {
    throw new ConnectionError('invalid-profile', 'The connection profile has invalid identity or provider fields.');
  }
  const id = input.id.trim();
  const name = input.name.trim();
  if (!id || !name) throw new ConnectionError('invalid-profile', 'A connection needs an ID and a name.');

  if (input.protocol !== undefined && !isProtocol(input.protocol)) {
    throw new ConnectionError('invalid-profile', 'Select Chat Completions, Responses, or Messages for this connection.');
  }
  if (input.auth !== undefined && !isAuth(input.auth)) {
    throw new ConnectionError('invalid-profile', 'Select bearer, API key header, or no authentication for this connection.');
  }
  if (input.catalogPagination !== undefined && !['none', 'after', 'after_id'].includes(input.catalogPagination)) {
    throw new ConnectionError('invalid-profile', 'The catalog pagination method is invalid.');
  }
  if (input.headers !== undefined && !Array.isArray(input.headers)) {
    throw new ConnectionError('invalid-profile', 'Connection headers must be a list.');
  }
  if (input.provider === 'custom' && (!input.protocol || !input.auth || !input.baseUrl)) {
    throw new ConnectionError('invalid-profile', 'Custom connections require an explicit protocol and authentication mode.');
  }

  let protocol: ConnectionProtocol;
  let auth: ConnectionAuth;
  let baseUrlInput: string;
  if (input.provider === 'custom') {
    protocol = input.protocol;
    auth = input.auth;
    baseUrlInput = input.baseUrl;
  } else {
    protocol = input.protocol ?? DEFAULT_PROTOCOLS[input.provider];
    auth = input.auth ?? DEFAULT_AUTH[input.provider];
    baseUrlInput = input.provider === 'cliproxy'
      ? normalizeCliProxyBaseUrl(input.baseUrl ?? DEFAULT_BASE_URLS.cliproxy)
      : input.baseUrl ?? DEFAULT_BASE_URLS[input.provider];
  }
  auth = normalizeAuth(auth);
  const baseUrl = validateEndpointUrl(baseUrlInput);
  const catalogUrl = input.catalogUrl == null ? undefined : validateEndpointUrl(input.catalogUrl);
  const catalogPagination = input.catalogPagination
    ?? (input.provider === 'custom' ? 'none' : DEFAULT_CATALOG_PAGINATION[input.provider]);
  const headers = validateHeaders(input.headers ?? [], auth, input.provider, protocol);
  const configRevision = await createConfigRevision({
    id,
    provider: input.provider,
    protocol,
    baseUrl,
    ...(catalogUrl === undefined ? {} : { catalogUrl }),
    catalogPagination,
    auth,
    headers,
  });

  return {
    schemaVersion: 1,
    id,
    name,
    provider: input.provider,
    protocol,
    baseUrl,
    ...(catalogUrl === undefined ? {} : { catalogUrl }),
    catalogPagination,
    auth,
    headers,
    configRevision,
  };
}

export type ConnectionProfileChanges = Partial<Pick<
  ConnectionProfile,
  'name' | 'provider' | 'protocol' | 'baseUrl' | 'catalogPagination' | 'auth' | 'headers'
>> & { readonly catalogUrl?: string | null };

export async function reviseConnectionProfile(
  current: ConnectionProfile,
  changes: ConnectionProfileChanges,
): Promise<ConnectionProfile> {
  const nextCatalogUrl = Object.hasOwn(changes, 'catalogUrl')
    ? changes.catalogUrl ?? undefined
    : current.catalogUrl;
  const nextProtocol = changes.protocol ?? current.protocol;
  const nextBaseUrl = changes.baseUrl
    ?? (nextProtocol === current.protocol ? current.baseUrl : rootUrl(current.baseUrl, current.protocol).toString());
  const replacement = await createConnectionProfile({
    id: current.id,
    name: changes.name ?? current.name,
    provider: changes.provider ?? current.provider,
    protocol: nextProtocol,
    baseUrl: nextBaseUrl,
    ...(nextCatalogUrl === undefined ? {} : { catalogUrl: nextCatalogUrl }),
    catalogPagination: changes.catalogPagination ?? current.catalogPagination,
    auth: changes.auth ?? current.auth,
    headers: changes.headers ?? current.headers,
  } as CreateConnectionProfileInput);

  if (sameNetworkConfiguration(current, replacement)) {
    return { ...replacement, configRevision: current.configRevision };
  }
  return replacement;
}

export function getConnectionEndpoints(profile: ConnectionProfile): ConnectionEndpoints {
  const root = rootUrl(profile.baseUrl, profile.protocol);
  const generationUrl = appendPath(root, ROUTES[profile.protocol]);
  const catalogUrl = profile.catalogUrl
    ?? (profile.provider === 'custom' ? undefined : appendPath(root, '/models'));
  return { generationUrl, ...(catalogUrl === undefined ? {} : { catalogUrl }) };
}

export function validateEndpointUrl(input: string): string {
  if (typeof input !== 'string') {
    throw new ConnectionError('unsafe-endpoint-url', 'Enter a valid HTTP or HTTPS endpoint URL.');
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ConnectionError('unsafe-endpoint-url', 'Enter a valid HTTP or HTTPS endpoint URL.');
  }

  const authority = input.match(/^[a-zA-Z][a-zA-Z\d+.-]*:\/\/([^/?#]*)/)?.[1] ?? '';
  if (!['http:', 'https:'].includes(url.protocol) || authority.includes('@') || url.username || url.password || url.hash) {
    throw new ConnectionError('unsafe-endpoint-url', 'Endpoint URLs cannot contain credentials or fragments and must use HTTP or HTTPS.');
  }
  for (const key of url.searchParams.keys()) {
    if (isCredentialLikeName(key)) {
      throw new ConnectionError('unsafe-endpoint-url', 'Put authentication in the credential fields, not in endpoint URL query parameters.');
    }
  }
  const normalizedPath = url.pathname.replace(/\/+$/, '');
  url.pathname = normalizedPath || '/';
  return url.toString();
}

function validateHeaders(
  headers: readonly ConnectionHeader[],
  auth: ConnectionAuth,
  provider: ConnectionProvider,
  protocol: ConnectionProtocol,
): readonly ConnectionHeader[] {
  const seen = new Set<string>();
  const result = headers.map((header) => {
    if (!isRecord(header) || typeof header.name !== 'string'
      || (header.source !== 'literal' && header.source !== 'credential')) {
      throw new ConnectionError('invalid-header', 'Each connection header needs a name and an explicit literal or credential mode.');
    }
    const name = header.name.trim();
    const lowerName = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || RESERVED_HEADER_NAMES.has(lowerName)) {
      throw new ConnectionError('invalid-header', `The header name "${name}" cannot be used here.`);
    }
    if (lowerName === 'x-api-key' && !(auth.kind === 'api-key-header' && auth.headerName.toLowerCase() === lowerName)) {
      throw new ConnectionError('invalid-header', 'Choose API key authentication instead of adding an untracked x-api-key header.');
    }
    if (seen.has(lowerName) || isProtocolHeader(provider, protocol, lowerName)) {
      throw new ConnectionError('invalid-header', `The header "${name}" is duplicated or reserved by the selected protocol.`);
    }
    seen.add(lowerName);
    if (header.source === 'literal') {
      if (typeof header.value !== 'string') {
        throw new ConnectionError('invalid-header', `The value for "${name}" must be text.`);
      }
      if (looksLikeSecretHeader(lowerName)) {
        throw new ConnectionError('invalid-header', `The "${name}" header must be stored as a credential, not as profile text.`);
      }
      if (/\r|\n/.test(header.value)) throw new ConnectionError('invalid-header', 'Header values cannot contain line breaks.');
      return { name, source: 'literal', value: header.value } as const;
    }
    if (header.source === 'credential') return { name, source: 'credential' } as const;
    throw new ConnectionError('invalid-header', 'Each extra header must be marked as literal or credential-backed.');
  });

  if (auth.kind === 'api-key-header') {
    const name = auth.headerName.trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || RESERVED_HEADER_NAMES.has(name.toLowerCase())) {
      throw new ConnectionError('invalid-header', 'The API key header name is invalid.');
    }
    if (seen.has(name.toLowerCase()) || isProtocolHeader(provider, protocol, name.toLowerCase())) {
      throw new ConnectionError('invalid-header', 'The API key header duplicates a configured or protocol header.');
    }
  }
  return result;
}

function isProtocolHeader(provider: ConnectionProvider, protocol: ConnectionProtocol, lowerName: string): boolean {
  return provider === 'anthropic' && protocol === 'messages'
    && ['anthropic-version', 'anthropic-dangerous-direct-browser-access'].includes(lowerName);
}

function looksLikeSecretHeader(lowerName: string): boolean {
  return isCredentialLikeName(lowerName);
}

function isCredentialLikeName(input: string): boolean {
  const lower = input.toLowerCase();
  const normalized = lower.replace(/[^a-z0-9]/g, '');
  const words = lower.match(/[a-z0-9]+/g) ?? [];
  return words.some((word) => CREDENTIAL_NAME_WORDS.has(word))
    || CREDENTIAL_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function isProvider(value: unknown): value is ConnectionProvider {
  return value === 'openai' || value === 'openrouter' || value === 'anthropic' || value === 'cliproxy' || value === 'custom';
}

function normalizeCliProxyBaseUrl(input: string): string {
  try {
    const url = new URL(input);
    if (url.pathname === '/' || url.pathname === '') url.pathname = '/v1';
    return url.toString();
  } catch {
    return input;
  }
}

function isProtocol(value: unknown): value is ConnectionProtocol {
  return value === 'chat-completions' || value === 'responses' || value === 'messages';
}

function isAuth(value: unknown): value is ConnectionAuth {
  if (!isRecord(value)) return false;
  if (value.kind === 'bearer' || value.kind === 'none') return true;
  return value.kind === 'api-key-header' && typeof value.headerName === 'string';
}

function normalizeAuth(auth: ConnectionAuth): ConnectionAuth {
  if (auth.kind === 'bearer') return { kind: 'bearer' };
  if (auth.kind === 'none') return { kind: 'none' };
  return { kind: 'api-key-header', headerName: auth.headerName.trim() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rootUrl(baseUrl: string, protocol: ConnectionProtocol): URL {
  const url = new URL(baseUrl);
  const path = stripTrailingSlashes(url.pathname);
  const route = ROUTES[protocol];
  if (path === route || path.endsWith(route)) {
    url.pathname = path.slice(0, -route.length) || '/';
  }
  return url;
}

function appendPath(root: URL, suffix: string): string {
  const url = new URL(root.href);
  const prefix = stripTrailingSlashes(url.pathname);
  const path = prefix === '/' ? suffix : `${prefix}${suffix}`;
  url.pathname = path;
  return url.toString();
}

function stripTrailingSlashes(path: string): string {
  const stripped = path.replace(/\/+$/, '');
  return stripped || '/';
}

function sameNetworkConfiguration(a: ConnectionProfile, b: ConnectionProfile): boolean {
  return a.provider === b.provider
    && a.protocol === b.protocol
    && a.baseUrl === b.baseUrl
    && a.catalogUrl === b.catalogUrl
    && a.catalogPagination === b.catalogPagination
    && JSON.stringify(a.auth) === JSON.stringify(b.auth)
    && JSON.stringify(a.headers) === JSON.stringify(b.headers);
}

async function createConfigRevision(config: {
  id: string;
  provider: ConnectionProvider;
  protocol: ConnectionProtocol;
  baseUrl: string;
  catalogUrl?: string;
  catalogPagination: CatalogPagination;
  auth: ConnectionAuth;
  headers: readonly ConnectionHeader[];
}): Promise<string> {
  const stable = JSON.stringify({
    id: config.id,
    provider: config.provider,
    protocol: config.protocol,
    baseUrl: config.baseUrl,
    catalogUrl: config.catalogUrl ?? null,
    catalogPagination: config.catalogPagination,
    auth: config.auth,
    headers: config.headers,
  });
  const bytes = new TextEncoder().encode(stable);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
