import { createConnectionProfile, getConnectionEndpoints, validateEndpointUrl } from './profile';
import { ConnectionError } from './types';
import type {
  CachedCatalogEntry,
  CachedCatalogError,
  ConnectionCatalogSnapshot,
  ConnectionCredentials,
  ConnectionProfile,
  DisclosureDecisionRecord,
  StoredCredentialRecord,
} from './types';

const PROFILE_REQUIRED_FIELDS = [
  'schemaVersion', 'id', 'name', 'provider', 'protocol', 'baseUrl', 'catalogPagination', 'auth', 'headers', 'configRevision',
];
const DISCLOSURE_FIELDS = ['profileId', 'configRevision', 'destinationUrl', 'decision', 'recordedAtMs'];
const CREDENTIAL_VALUES_FIELDS = ['apiKey', 'headers'];
const CATALOG_REQUIRED_FIELDS = ['profileId', 'configRevision', 'checkedAtMs', 'state', 'entries'];
const CONNECTION_ERROR_CODES = new Set([
  'invalid-profile', 'catalog-unavailable', 'unsafe-endpoint-url', 'invalid-header', 'invalid-model-id',
  'credential-required', 'credential-destination-mismatch', 'credential-store-unavailable', 'credential-write-failed',
  'credential-invalid', 'local-read-failed', 'local-write-failed', 'profile-not-found', 'http-authentication',
  'http-permission', 'http-quota', 'http-rate-limited', 'http-capacity', 'http-endpoint', 'http-failure',
  'malformed-catalog', 'request-failed', 'request-interrupted',
]);

export async function validatePersistableProfile(value: unknown): Promise<ConnectionProfile> {
  if (!isRecord(value)
    || !hasExactFields(value, PROFILE_REQUIRED_FIELDS, ['catalogUrl'])
    || value.schemaVersion !== 1
    || !nonEmptyString(value.id)
    || !nonEmptyString(value.name)
    || !nonEmptyString(value.configRevision)
    || (Object.hasOwn(value, 'catalogUrl') && typeof value.catalogUrl !== 'string')
    || !isRecord(value.auth)
    || !validAuthShape(value.auth)
    || !Array.isArray(value.headers)
    || !value.headers.every(validHeaderShape)) {
    throw new ConnectionError('invalid-profile', 'The saved connection profile is incompatible.');
  }

  const normalized = await createConnectionProfile({
    id: value.id as string,
    name: value.name as string,
    provider: value.provider,
    protocol: value.protocol,
    baseUrl: value.baseUrl as string,
    ...(Object.hasOwn(value, 'catalogUrl') ? { catalogUrl: value.catalogUrl as string } : {}),
    catalogPagination: value.catalogPagination,
    auth: value.auth as Parameters<typeof createConnectionProfile>[0]['auth'],
    headers: value.headers as Parameters<typeof createConnectionProfile>[0]['headers'],
  } as Parameters<typeof createConnectionProfile>[0]);

  if (!sameProfileData(value, normalized)) {
    throw new ConnectionError('invalid-profile', 'The saved connection profile is incompatible.');
  }
  return normalized;
}

export async function restoreProfile(value: unknown, expectedId?: string): Promise<ConnectionProfile> {
  try {
    const profile = await validatePersistableProfile(value);
    if (expectedId !== undefined && profile.id !== expectedId) throw new Error('Profile identity mismatch.');
    return profile;
  } catch {
    throw localReadError();
  }
}

export function validateCredentialValues(
  profile: ConnectionProfile,
  value: unknown,
): ConnectionCredentials {
  if (!isRecord(value) || !hasExactFields(value, [], CREDENTIAL_VALUES_FIELDS)) {
    throw new ConnectionError('credential-invalid', 'The assigned connection credential is invalid.');
  }

  if (Object.hasOwn(value, 'apiKey') && typeof value.apiKey !== 'string') {
    throw new ConnectionError('credential-invalid', 'Enter a valid API key.');
  }
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey : undefined;
  if (profile.auth.kind === 'none' && apiKey !== undefined) {
    throw new ConnectionError('credential-invalid', 'This profile has no API key authentication mode.');
  }
  if (profile.auth.kind !== 'none' && (typeof apiKey !== 'string' || apiKey.length === 0 || /\r|\n/.test(apiKey))) {
    throw new ConnectionError('credential-invalid', 'Enter a non-empty API key without line breaks.');
  }

  const configuredHeaders = new Map(
    profile.headers
      .filter((header) => header.source === 'credential')
      .map((header) => [header.name.toLowerCase(), header.name]),
  );
  const supplied = new Map<string, { name: string; value: string }>();
  const suppliedHeaders = Object.hasOwn(value, 'headers') ? value.headers : {};
  if (!isRecord(suppliedHeaders)) {
    throw new ConnectionError('credential-invalid', 'The assigned connection headers are invalid.');
  }
  for (const [name, headerValue] of Object.entries(suppliedHeaders)) {
    const normalized = name.toLowerCase();
    if (!configuredHeaders.has(normalized) || supplied.has(normalized)) {
      throw new ConnectionError('credential-invalid', 'An assigned header is not configured as a credential.');
    }
    if (typeof headerValue !== 'string' || !headerValue || /\r|\n/.test(headerValue)) {
      throw new ConnectionError('credential-invalid', 'An assigned header value is invalid.');
    }
    supplied.set(normalized, { name: configuredHeaders.get(normalized) ?? name, value: headerValue });
  }
  for (const [normalized] of configuredHeaders) {
    if (!supplied.has(normalized)) throw new ConnectionError('credential-invalid', 'A configured credential header is missing.');
  }

  const headers = Object.fromEntries([...supplied.values()].map(({ name, value: headerValue }) => [name, headerValue]));
  return {
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(Object.keys(headers).length === 0 ? {} : { headers: Object.freeze(headers) }),
  };
}

export function restoreCredentialRecord(profile: ConnectionProfile, value: unknown): StoredCredentialRecord {
  try {
    if (!isRecord(value)
      || !hasExactFields(value, ['profileId', 'configRevision', 'credentialRevision', 'generationUrl', 'values'], ['catalogUrl'])
      || value.profileId !== profile.id
      || value.configRevision !== profile.configRevision
      || !Number.isSafeInteger(value.credentialRevision)
      || (value.credentialRevision as number) < 1
      || typeof value.generationUrl !== 'string'
      || !isRecord(value.values)) {
      throw new Error('Credential identity or metadata is invalid.');
    }
    const endpoints = getConnectionEndpoints(profile);
    if (value.generationUrl !== endpoints.generationUrl
      || (Object.hasOwn(value, 'catalogUrl') ? value.catalogUrl !== endpoints.catalogUrl : endpoints.catalogUrl !== undefined)) {
      throw new Error('Credential destination is invalid.');
    }
    const credentials = validateCredentialValues(profile, value.values);
    if (!sameCredentialValues(value.values, credentials)) throw new Error('Credential values are not canonical.');
    return {
      profileId: profile.id,
      configRevision: profile.configRevision,
      credentialRevision: value.credentialRevision as number,
      generationUrl: endpoints.generationUrl,
      ...(endpoints.catalogUrl === undefined ? {} : { catalogUrl: endpoints.catalogUrl }),
      values: credentials,
    };
  } catch {
    throw localReadError();
  }
}

export function restoreDisclosureRecord(
  profile: ConnectionProfile,
  value: unknown,
): DisclosureDecisionRecord {
  try {
    if (!isRecord(value)
      || !hasExactFields(value, DISCLOSURE_FIELDS, ['transport'])
      || (value.transport !== undefined && value.transport !== 'site-relay')
      || value.profileId !== profile.id
      || value.configRevision !== profile.configRevision
      || value.destinationUrl !== getConnectionEndpoints(profile).generationUrl
      || (value.decision !== 'accepted' && value.decision !== 'declined')
      || !finiteNonNegative(value.recordedAtMs)) {
      throw new Error('Disclosure identity or fields are invalid.');
    }
    return {
      profileId: profile.id,
      configRevision: profile.configRevision,
      destinationUrl: getConnectionEndpoints(profile).generationUrl,
      decision: value.decision,
      recordedAtMs: value.recordedAtMs as number,
      ...(value.transport === 'site-relay' ? { transport: 'site-relay' as const } : {}),
    };
  } catch {
    throw localReadError();
  }
}

export function restoreCatalogSnapshot(
  profile: ConnectionProfile,
  value: unknown,
): ConnectionCatalogSnapshot {
  try {
    if (!isRecord(value)
      || !hasExactFields(value, CATALOG_REQUIRED_FIELDS, ['requestedUrl', 'lastSuccessfulAtMs', 'nextUrl', 'error'])
      || value.profileId !== profile.id
      || value.configRevision !== profile.configRevision
      || !finiteNonNegative(value.checkedAtMs)
      || !['complete', 'partial', 'stale', 'unavailable'].includes(value.state as string)
      || !Array.isArray(value.entries)) {
      throw new Error('Catalog identity or fields are invalid.');
    }

    const endpoints = getConnectionEndpoints(profile);
    const unavailable = value.state === 'unavailable';
    if (endpoints.catalogUrl === undefined) {
      if (!unavailable || Object.hasOwn(value, 'requestedUrl')) throw new Error('Catalog destination is invalid.');
    } else if (unavailable || value.requestedUrl !== endpoints.catalogUrl) {
      throw new Error('Catalog destination is invalid.');
    }
    if (Object.hasOwn(value, 'requestedUrl') && typeof value.requestedUrl !== 'string') {
      throw new Error('Catalog URL is invalid.');
    }
    if (Object.hasOwn(value, 'lastSuccessfulAtMs') && !finiteNonNegative(value.lastSuccessfulAtMs)) {
      throw new Error('Catalog timestamp is invalid.');
    }

    const entries = value.entries.map(restoreCatalogEntry);
    const entryIds = new Set(entries.map((entry) => entry.id));
    if (entryIds.size !== entries.length) throw new Error('Catalog entries are duplicated.');

    let nextUrl: string | undefined;
    if (Object.hasOwn(value, 'nextUrl')) {
      if (value.state !== 'partial' || typeof value.nextUrl !== 'string') throw new Error('Catalog pagination state is invalid.');
      nextUrl = validateCatalogNextUrl(profile, endpoints.catalogUrl, value.nextUrl);
    }

    let error: CachedCatalogError | undefined;
    if (Object.hasOwn(value, 'error')) error = restoreCatalogError(value.error);
    if ((value.state === 'complete' && (error !== undefined || nextUrl !== undefined
        || value.lastSuccessfulAtMs !== value.checkedAtMs))
      || ((value.state === 'stale' || value.state === 'unavailable') && error === undefined)
      || (value.state === 'unavailable' && endpoints.catalogUrl !== undefined)
      || (value.state !== 'unavailable' && endpoints.catalogUrl === undefined)) {
      throw new Error('Catalog state is inconsistent.');
    }

    return {
      profileId: profile.id,
      configRevision: profile.configRevision,
      ...(Object.hasOwn(value, 'requestedUrl') ? { requestedUrl: value.requestedUrl as string } : {}),
      checkedAtMs: value.checkedAtMs as number,
      ...(Object.hasOwn(value, 'lastSuccessfulAtMs') ? { lastSuccessfulAtMs: value.lastSuccessfulAtMs as number } : {}),
      state: value.state as ConnectionCatalogSnapshot['state'],
      entries,
      ...(nextUrl === undefined ? {} : { nextUrl }),
      ...(error === undefined ? {} : { error }),
    };
  } catch {
    throw catalogReadError();
  }
}

export function localReadError(): ConnectionError {
  return new ConnectionError('local-read-failed', 'Local connection storage could not be read.');
}

export function catalogReadError(): ConnectionError {
  return new ConnectionError('local-read-failed', 'The saved model catalog could not be read.');
}

function restoreCatalogEntry(value: unknown): CachedCatalogEntry {
  if (!isRecord(value)
    || !hasExactFields(value, ['id', 'state', 'lastAdvertisedAtMs'], ['displayName', 'ownedBy'])
    || !nonEmptyString(value.id)
    || !['advertised', 'not-advertised', 'stale'].includes(value.state as string)
    || !finiteNonNegative(value.lastAdvertisedAtMs)
    || (Object.hasOwn(value, 'displayName') && !nonEmptyString(value.displayName))
    || (Object.hasOwn(value, 'ownedBy') && !nonEmptyString(value.ownedBy))) {
    throw new Error('Catalog entry is invalid.');
  }
  return {
    id: value.id as string,
    ...(Object.hasOwn(value, 'displayName') ? { displayName: value.displayName as string } : {}),
    ...(Object.hasOwn(value, 'ownedBy') ? { ownedBy: value.ownedBy as string } : {}),
    state: value.state as CachedCatalogEntry['state'],
    lastAdvertisedAtMs: value.lastAdvertisedAtMs as number,
  };
}

function restoreCatalogError(value: unknown): CachedCatalogError {
  if (!isRecord(value)
    || !hasExactFields(value, ['code', 'message'], ['status', 'providerCode', 'retryAfterMs'])
    || typeof value.code !== 'string'
    || !CONNECTION_ERROR_CODES.has(value.code)
    || !nonEmptyString(value.message)
    || (Object.hasOwn(value, 'status') && (!Number.isInteger(value.status) || (value.status as number) < 100 || (value.status as number) > 599))
    || (Object.hasOwn(value, 'providerCode') && !nonEmptyString(value.providerCode))
    || (Object.hasOwn(value, 'retryAfterMs') && !finiteNonNegative(value.retryAfterMs))) {
    throw new Error('Catalog error is invalid.');
  }
  return {
    code: value.code as CachedCatalogError['code'],
    message: value.message as string,
    ...(Object.hasOwn(value, 'status') ? { status: value.status as number } : {}),
    ...(Object.hasOwn(value, 'providerCode') ? { providerCode: value.providerCode as string } : {}),
    ...(Object.hasOwn(value, 'retryAfterMs') ? { retryAfterMs: value.retryAfterMs as number } : {}),
  };
}

function validateCatalogNextUrl(profile: ConnectionProfile, catalogUrl: string | undefined, value: string): string {
  if (!catalogUrl || profile.catalogPagination === 'none') throw new Error('Catalog pagination is unavailable.');
  const expected = new URL(catalogUrl);
  const canonical = validateEndpointUrl(value);
  if (canonical !== value) throw new Error('Catalog pagination URL is not canonical.');
  const next = new URL(canonical);
  const parameter = profile.catalogPagination;
  if (next.origin !== expected.origin || next.pathname !== expected.pathname || next.hash
    || next.searchParams.getAll(parameter).length !== 1 || !next.searchParams.get(parameter)) {
    throw new Error('Catalog pagination destination is invalid.');
  }
  expected.searchParams.delete(parameter);
  next.searchParams.delete(parameter);
  if (expected.searchParams.toString() !== next.searchParams.toString()) {
    throw new Error('Catalog pagination query is invalid.');
  }
  return value;
}

function sameProfileData(value: Record<string, unknown>, normalized: ConnectionProfile): boolean {
  return value.schemaVersion === normalized.schemaVersion
    && value.id === normalized.id
    && value.name === normalized.name
    && value.provider === normalized.provider
    && value.protocol === normalized.protocol
    && value.baseUrl === normalized.baseUrl
    && value.catalogUrl === normalized.catalogUrl
    && Object.hasOwn(value, 'catalogUrl') === Object.hasOwn(normalized, 'catalogUrl')
    && value.catalogPagination === normalized.catalogPagination
    && sameAuth(value.auth, normalized.auth)
    && sameHeaders(value.headers, normalized.headers)
    && value.configRevision === normalized.configRevision;
}

function sameAuth(value: unknown, normalized: ConnectionProfile['auth']): boolean {
  if (!isRecord(value) || value.kind !== normalized.kind) return false;
  return normalized.kind === 'api-key-header'
    ? value.headerName === normalized.headerName
    : Object.keys(value).length === 1;
}

function sameHeaders(value: unknown, normalized: ConnectionProfile['headers']): boolean {
  return Array.isArray(value) && value.length === normalized.length && value.every((header, index) => {
    const expected = normalized[index];
    if (!isRecord(header) || !expected || header.name !== expected.name || header.source !== expected.source) return false;
    return expected.source === 'literal' ? header.value === expected.value : true;
  });
}

function sameCredentialValues(value: Record<string, unknown>, normalized: ConnectionCredentials): boolean {
  if (Object.hasOwn(value, 'apiKey') !== Object.hasOwn(normalized, 'apiKey')
    || value.apiKey !== normalized.apiKey
    || Object.hasOwn(value, 'headers') !== Object.hasOwn(normalized, 'headers')) return false;
  if (!Object.hasOwn(value, 'headers')) return true;
  const valueHeaders = value.headers;
  const normalizedHeaders = normalized.headers;
  if (!isRecord(valueHeaders) || !normalizedHeaders) return false;
  const names = Object.keys(valueHeaders);
  return names.length === Object.keys(normalizedHeaders).length
    && names.every((name) => Object.hasOwn(normalizedHeaders, name) && valueHeaders[name] === normalizedHeaders[name]);
}

function validAuthShape(value: Record<string, unknown>): boolean {
  if (value.kind === 'bearer' || value.kind === 'none') return hasExactFields(value, ['kind'], []);
  return value.kind === 'api-key-header'
    && hasExactFields(value, ['kind', 'headerName'], [])
    && nonEmptyString(value.headerName);
}

function validHeaderShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.source === 'credential') {
    return hasExactFields(value, ['name', 'source'], []) && nonEmptyString(value.name);
  }
  return value.source === 'literal'
    && hasExactFields(value, ['name', 'source', 'value'], [])
    && nonEmptyString(value.name)
    && typeof value.value === 'string';
}

function hasExactFields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
