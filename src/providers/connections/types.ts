export type ConnectionProvider = 'openai' | 'openrouter' | 'anthropic' | 'cliproxy' | 'custom';
export type ConnectionProtocol = 'chat-completions' | 'responses' | 'messages';
export type CatalogPagination = 'none' | 'after' | 'after_id';

export type ConnectionAuth =
  | { kind: 'bearer' }
  | { kind: 'api-key-header'; headerName: string }
  | { kind: 'none' };

export type ConnectionHeader =
  | { name: string; source: 'literal'; value: string }
  | { name: string; source: 'credential' };

export interface ConnectionProfile {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly provider: ConnectionProvider;
  readonly protocol: ConnectionProtocol;
  readonly baseUrl: string;
  readonly catalogUrl?: string;
  readonly catalogPagination: CatalogPagination;
  readonly auth: ConnectionAuth;
  readonly headers: readonly ConnectionHeader[];
  readonly configRevision: string;
}

export interface ConnectionCredentials {
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface BoundConnectionCredentials {
  readonly profileId: string;
  readonly configRevision: string;
  readonly credentialRevision: number;
  readonly generationUrl: string;
  readonly catalogUrl?: string;
}

export interface StoredCredentialRecord {
  readonly profileId: string;
  readonly configRevision: string;
  readonly credentialRevision: number;
  readonly generationUrl: string;
  readonly catalogUrl?: string;
  readonly values: ConnectionCredentials;
}

export type DisclosureDecision = 'accepted' | 'declined';

export interface DisclosureDecisionRecord {
  readonly profileId: string;
  readonly configRevision: string;
  readonly destinationUrl: string;
  readonly decision: DisclosureDecision;
  readonly recordedAtMs: number;
  readonly transport?: 'site-relay';
}

export type CachedCatalogEntryState = 'advertised' | 'not-advertised' | 'stale';
export type CachedCatalogState = 'complete' | 'partial' | 'stale' | 'unavailable';

export interface CachedCatalogEntry {
  readonly id: string;
  readonly displayName?: string;
  readonly ownedBy?: string;
  readonly state: CachedCatalogEntryState;
  readonly lastAdvertisedAtMs: number;
}

export interface CachedCatalogError {
  readonly code: ConnectionErrorCode;
  readonly message: string;
  readonly status?: number;
  readonly providerCode?: string;
  readonly retryAfterMs?: number;
}

export interface ConnectionCatalogSnapshot {
  readonly profileId: string;
  readonly configRevision: string;
  readonly requestedUrl?: string;
  readonly checkedAtMs: number;
  readonly lastSuccessfulAtMs?: number;
  readonly state: CachedCatalogState;
  readonly entries: readonly CachedCatalogEntry[];
  readonly nextUrl?: string;
  readonly error?: CachedCatalogError;
}

export type CredentialResolution =
  | { readonly status: 'bound'; readonly credentials: BoundConnectionCredentials }
  | { readonly status: 'missing' }
  | { readonly status: 'destination-changed' }
  | { readonly status: 'profile-not-found' };

export interface ConnectionPersistence {
  getProfile(namespaceKey: string, profileId: string): Promise<ConnectionProfile | undefined>;
  listProfiles(namespaceKey: string): Promise<readonly ConnectionProfile[]>;
  putProfile(namespaceKey: string, profile: ConnectionProfile): Promise<void>;
  deleteProfile(namespaceKey: string, profileId: string): Promise<void>;
  getCredential(namespaceKey: string, profileId: string): Promise<StoredCredentialRecord | undefined>;
  listCredentialRecords(namespaceKey?: string): Promise<readonly StoredCredentialRecord[]>;
  putCredential(namespaceKey: string, record: StoredCredentialRecord): Promise<void>;
  deleteCredential(namespaceKey: string, profileId: string): Promise<void>;
  clearCredentials(namespaceKey?: string): Promise<void>;
  getDisclosure(namespaceKey: string, profileId: string): Promise<DisclosureDecisionRecord | undefined>;
  putDisclosure(namespaceKey: string, record: DisclosureDecisionRecord): Promise<void>;
  deleteDisclosure(namespaceKey: string, profileId: string): Promise<void>;
  getCatalogSnapshot(namespaceKey: string, profileId: string, configRevision: string): Promise<ConnectionCatalogSnapshot | undefined>;
  putCatalogSnapshot(namespaceKey: string, snapshot: ConnectionCatalogSnapshot): Promise<void>;
}

export type ConnectionNamespace =
  | { readonly kind: 'guest' }
  | { readonly kind: 'account'; readonly accountId: string };

export interface ConnectionEndpoints {
  readonly generationUrl: string;
  readonly catalogUrl?: string;
}

export type ConnectionErrorCode =
  | 'invalid-profile'
  | 'catalog-unavailable'
  | 'unsafe-endpoint-url'
  | 'invalid-header'
  | 'invalid-model-id'
  | 'credential-required'
  | 'credential-destination-mismatch'
  | 'unsupported-cache-option'
  | 'invalid-request-body'
  | 'credential-store-unavailable'
  | 'credential-write-failed'
  | 'credential-invalid'
  | 'local-read-failed'
  | 'local-write-failed'
  | 'profile-not-found'
  | 'http-authentication'
  | 'http-permission'
  | 'http-quota'
  | 'http-rate-limited'
  | 'http-capacity'
  | 'http-endpoint'
  | 'http-failure'
  | 'malformed-catalog'
  | 'request-failed'
  | 'request-interrupted';

export class ConnectionError extends Error {
  constructor(
    readonly code: ConnectionErrorCode,
    message: string,
    readonly status?: number,
    readonly providerCode?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ConnectionError';
  }
}
