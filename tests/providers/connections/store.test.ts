import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  createConnectionProfile,
  createConnectionStore,
  checkConnection,
  hasCurrentDisclosureConsent,
  prepareCatalogRequest,
  prepareGenerationRequest,
  reviseConnectionProfile,
  openConnectionStore,
  type ConnectionPersistence,
  type ConnectionProfile,
  type ConnectionCatalogSnapshot,
  type DisclosureDecisionRecord,
  type StoredCredentialRecord,
} from '../../../src/providers/connections';

class MemoryConnectionPersistence implements ConnectionPersistence {
  readonly profiles = new Map<string, ConnectionProfile>();
  readonly credentials = new Map<string, StoredCredentialRecord>();
  readonly disclosures = new Map<string, DisclosureDecisionRecord>();
  readonly catalogs = new Map<string, ConnectionCatalogSnapshot>();

  async getProfile(namespaceKey: string, profileId: string) {
    return this.profiles.get(`${namespaceKey}:${profileId}`);
  }

  async listProfiles(namespaceKey: string) {
    return [...this.profiles.entries()]
      .filter(([key]) => key.startsWith(`${namespaceKey}:`))
      .map(([, value]) => value);
  }

  async putProfile(namespaceKey: string, profile: ConnectionProfile) {
    const key = `${namespaceKey}:${profile.id}`;
    const previous = this.profiles.get(key);
    if (previous && previous.configRevision !== profile.configRevision) {
      this.credentials.delete(key);
      this.disclosures.delete(key);
      for (const catalogKey of this.catalogs.keys()) {
        if (catalogKey.startsWith(`${key}:`)) this.catalogs.delete(catalogKey);
      }
    }
    this.profiles.set(key, profile);
  }

  async deleteProfile(namespaceKey: string, profileId: string) {
    const key = `${namespaceKey}:${profileId}`;
    this.profiles.delete(key);
    this.credentials.delete(key);
    this.disclosures.delete(key);
    for (const catalogKey of this.catalogs.keys()) {
      if (catalogKey.startsWith(`${key}:`)) this.catalogs.delete(catalogKey);
    }
  }

  async getCredential(namespaceKey: string, profileId: string) {
    return this.credentials.get(`${namespaceKey}:${profileId}`);
  }

  async listCredentialRecords(namespaceKey?: string) {
    return [...this.credentials.entries()]
      .filter(([key]) => namespaceKey === undefined || key.startsWith(`${namespaceKey}:`))
      .map(([, record]) => record);
  }

  async putCredential(namespaceKey: string, record: StoredCredentialRecord) {
    this.credentials.set(`${namespaceKey}:${record.profileId}`, record);
  }

  async deleteCredential(namespaceKey: string, profileId: string) {
    this.credentials.delete(`${namespaceKey}:${profileId}`);
  }

  async clearCredentials(namespaceKey?: string) {
    for (const key of this.credentials.keys()) {
      if (namespaceKey === undefined || key.startsWith(`${namespaceKey}:`)) this.credentials.delete(key);
    }
  }

  async getDisclosure(namespaceKey: string, profileId: string) {
    return this.disclosures.get(`${namespaceKey}:${profileId}`);
  }

  async putDisclosure(namespaceKey: string, record: DisclosureDecisionRecord) {
    this.disclosures.set(`${namespaceKey}:${record.profileId}`, record);
  }

  async deleteDisclosure(namespaceKey: string, profileId: string) {
    this.disclosures.delete(`${namespaceKey}:${profileId}`);
  }

  async getCatalogSnapshot(namespaceKey: string, profileId: string, configRevision: string) {
    return this.catalogs.get(`${namespaceKey}:${profileId}:${configRevision}`);
  }

  async putCatalogSnapshot(namespaceKey: string, snapshot: ConnectionCatalogSnapshot) {
    const key = `${namespaceKey}:${snapshot.profileId}`;
    const profile = this.profiles.get(key);
    if (!profile || profile.configRevision !== snapshot.configRevision) throw new Error('stale configuration');
    this.catalogs.set(`${key}:${snapshot.configRevision}`, snapshot);
  }
}

class FailingCredentialPersistence extends MemoryConnectionPersistence {
  override async putCredential(namespaceKey: string, record: StoredCredentialRecord) {
    void namespaceKey;
    void record;
    throw new Error('quota failure for should-never-echo-this-secret');
  }
}

class ToggleFailingCredentialPersistence extends MemoryConnectionPersistence {
  failCredentialWrites = false;

  override async putCredential(namespaceKey: string, record: StoredCredentialRecord) {
    if (this.failCredentialWrites) throw new Error('synthetic storage quota failure');
    await super.putCredential(namespaceKey, record);
  }
}

class PausedCredentialReadPersistence extends MemoryConnectionPersistence {
  private nextRead: { captured: () => void; gate: Promise<void> } | undefined;

  pauseNextCredentialRead() {
    let captured!: () => void;
    let release!: () => void;
    const readCaptured = new Promise<void>((resolve) => { captured = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.nextRead = { captured, gate };
    return { readCaptured, release };
  }

  override async getCredential(namespaceKey: string, profileId: string) {
    const record = await super.getCredential(namespaceKey, profileId);
    const nextRead = this.nextRead;
    if (nextRead) {
      this.nextRead = undefined;
      nextRead.captured();
      await nextRead.gate;
    }
    return record;
  }
}

describe('device-local connection store', () => {
  it('rejects restored profiles with incompatible versions, missing fields, or extra secret fields', async () => {
    const persistence = new MemoryConnectionPersistence();
    const store = createConnectionStore(persistence);
    const namespace = { kind: 'guest' } as const;
    const valid = await createConnectionProfile({ id: 'restored', name: 'Restored', provider: 'openai' });
    const invalidRows = [
      { schemaVersion: 99, id: valid.id, name: 'incompatible' },
      { ...valid, baseUrl: undefined },
      { ...valid, auth: { kind: 'bearer', apiKey: 'stored-secret-canary' } },
      { ...valid, unexpectedSecret: 'stored-secret-canary' },
    ];

    for (const invalid of invalidRows) {
      persistence.profiles.set(`guest:${valid.id}`, invalid as unknown as ConnectionProfile);
      const retained = structuredClone(invalid);
      await expect(store.getProfile(namespace, valid.id)).rejects.toMatchObject({
        code: 'local-read-failed',
        message: 'Local connection storage could not be read.',
      });
      await expect(store.listProfiles(namespace)).rejects.toMatchObject({
        code: 'local-read-failed',
        message: 'Local connection storage could not be read.',
      });
      expect(persistence.profiles.get(`guest:${valid.id}`)).toEqual(retained);
    }
  });

  it('validates every restored profile used by credential, disclosure and catalog operations', async () => {
    const persistence = new MemoryConnectionPersistence();
    const store = createConnectionStore(persistence);
    const namespace = { kind: 'guest' } as const;
    const profile = await createConnectionProfile({ id: 'restored-internal', name: 'Restored', provider: 'openai' });
    const invalid = { ...profile, schemaVersion: 2 } as unknown as ConnectionProfile;
    persistence.profiles.set(`guest:${profile.id}`, invalid);

    await expect(store.assignCredential(namespace, profile.id, { apiKey: 'new-key-canary' })).rejects.toMatchObject({ code: 'local-read-failed' });
    await expect(store.resolveCredentials(namespace, profile)).rejects.toMatchObject({ code: 'local-read-failed' });
    await expect(store.recordDisclosureChoice(namespace, profile, { decision: 'accepted', recordedAtMs: 5 })).rejects.toMatchObject({ code: 'local-read-failed' });
    await expect(store.getDisclosureChoice(namespace, profile)).rejects.toMatchObject({ code: 'local-read-failed' });
    await expect(store.getCatalogSnapshot(namespace, profile)).rejects.toMatchObject({ code: 'local-read-failed' });
    await expect(store.recordCatalogCheck(namespace, profile, {
      status: 'success',
      requestedUrl: 'https://api.openai.com/v1/models',
      checkedAtMs: 5,
      models: [],
    })).rejects.toMatchObject({ code: 'local-read-failed' });
  });

  it('rejects catalog snapshots with invalid state, timestamp, identity or pagination URL and retains them', async () => {
    const persistence = new MemoryConnectionPersistence();
    const store = createConnectionStore(persistence);
    const namespace = { kind: 'guest' } as const;
    const profile = await createConnectionProfile({ id: 'catalog-restore', name: 'Catalog', provider: 'openai' });
    await store.saveProfile(namespace, profile);
    const valid = {
      profileId: profile.id,
      configRevision: profile.configRevision,
      requestedUrl: 'https://api.openai.com/v1/models',
      checkedAtMs: 10,
      lastSuccessfulAtMs: 9,
      state: 'complete',
      entries: [{ id: 'fixture/model', state: 'advertised', lastAdvertisedAtMs: 9 }],
    };
    const invalidRows = [
      { ...valid, state: 'unknown' },
      { ...valid, checkedAtMs: Number.NaN },
      { ...valid, configRevision: 'wrong-revision' },
      { ...valid, nextUrl: 'https://attacker.example.test/models?after=cursor' },
      { ...valid, entries: [{ id: 'fixture/model', state: 'advertised', lastAdvertisedAtMs: Number.POSITIVE_INFINITY }] },
      { ...valid, error: { code: 'request-failed', message: 'bad error', status: 99 } },
    ];

    for (const invalid of invalidRows) {
      persistence.catalogs.set(`guest:${profile.id}:${profile.configRevision}`, invalid as unknown as ConnectionCatalogSnapshot);
      const retained = structuredClone(invalid);
      await expect(store.getCatalogSnapshot(namespace, profile)).rejects.toMatchObject({
        code: 'local-read-failed',
        message: 'The saved model catalog could not be read.',
      });
      expect(persistence.catalogs.get(`guest:${profile.id}:${profile.configRevision}`)).toEqual(retained);
    }
  });

  it('rejects invalid disclosure records without returning or rewriting them', async () => {
    const persistence = new MemoryConnectionPersistence();
    const store = createConnectionStore(persistence);
    const namespace = { kind: 'guest' } as const;
    const profile = await createConnectionProfile({ id: 'disclosure-restore', name: 'Disclosure', provider: 'openai' });
    await store.saveProfile(namespace, profile);
    const valid = {
      profileId: profile.id,
      configRevision: profile.configRevision,
      destinationUrl: 'https://api.openai.com/v1/responses',
      decision: 'accepted',
      recordedAtMs: 10,
    };
    const invalidRows = [
      { ...valid, profileId: 'another-profile' },
      { ...valid, destinationUrl: 'https://attacker.example.test/v1/responses' },
      { ...valid, decision: 'maybe' },
      { ...valid, recordedAtMs: Number.NaN },
      { ...valid, unexpectedSecret: 'stored-secret-canary' },
    ];

    for (const invalid of invalidRows) {
      persistence.disclosures.set(`guest:${profile.id}`, invalid as unknown as DisclosureDecisionRecord);
      const retained = structuredClone(invalid);
      await expect(store.getDisclosureChoice(namespace, profile)).rejects.toMatchObject({
        code: 'local-read-failed',
        message: 'Local connection storage could not be read.',
      });
      expect(persistence.disclosures.get(`guest:${profile.id}`)).toEqual(retained);
    }
  });

  it('does not replace an incompatible catalog while saving a moved profile', async () => {
    const persistence = new MemoryConnectionPersistence();
    const store = createConnectionStore(persistence);
    const namespace = { kind: 'guest' } as const;
    const profile = await createConnectionProfile({ id: 'catalog-preserve', name: 'Catalog', provider: 'openai' });
    await store.saveProfile(namespace, profile);
    const corrupt = {
      profileId: profile.id,
      configRevision: profile.configRevision,
      requestedUrl: 'https://api.openai.com/v1/models',
      checkedAtMs: 10,
      state: 'unsupported-state',
      entries: [],
    } as unknown as ConnectionCatalogSnapshot;
    const catalogKey = `guest:${profile.id}:${profile.configRevision}`;
    persistence.catalogs.set(catalogKey, corrupt);
    const retained = structuredClone(corrupt);
    const moved = await reviseConnectionProfile(profile, { baseUrl: 'https://proxy.example.test/v1' });

    await expect(store.saveProfile(namespace, moved)).rejects.toMatchObject({
      code: 'local-read-failed',
      message: 'The saved model catalog could not be read.',
    });
    expect(persistence.profiles.get(`guest:${profile.id}`)).toEqual(profile);
    expect(persistence.catalogs.get(catalogKey)).toEqual(retained);
  });

  it('fails closed on corrupt credential metadata during binding and known-key enumeration', async () => {
    const persistence = new MemoryConnectionPersistence();
    const store = createConnectionStore(persistence);
    const namespace = { kind: 'guest' } as const;
    const profile = await createConnectionProfile({ id: 'credential-restore', name: 'Credential', provider: 'openai' });
    await store.saveProfile(namespace, profile);
    await store.assignCredential(namespace, profile.id, { apiKey: 'retained-key-canary' });
    const good = persistence.credentials.get(`guest:${profile.id}`);
    if (!good) throw new Error('Expected a stored fixture credential.');
    const invalidRows = [
      { ...good, profileId: 'another-profile' },
      { ...good, generationUrl: 'https://attacker.example.test/responses' },
      { ...good, credentialRevision: Number.NaN },
      { ...good, values: { apiKey: 'retained-key-canary', unexpectedSecret: 'second-secret-canary' } },
      { ...good, values: { apiKey: 7 } },
    ];

    for (const invalid of invalidRows) {
      persistence.credentials.set(`guest:${profile.id}`, invalid as unknown as StoredCredentialRecord);
      const retained = structuredClone(invalid);
      await expect(store.resolveCredentials(namespace, profile)).rejects.toMatchObject({
        code: 'local-read-failed',
        message: 'Local connection storage could not be read.',
      });
      await expect(store.assignCredential(namespace, profile.id, { apiKey: 'replacement-key-canary' })).rejects.toMatchObject({
        code: 'local-read-failed',
        message: 'Local connection storage could not be read.',
      });
      await expect(store.snapshotKnownCredentials(namespace)).rejects.toMatchObject({
        code: 'local-read-failed',
        message: 'Local connection storage could not be read.',
      });
      const readError = await store.resolveCredentials(namespace, profile).catch((error: unknown) => error);
      expect(String(readError)).not.toContain('retained-key-canary');
      expect(String(readError)).not.toContain('attacker.example.test');
      expect(persistence.credentials.get(`guest:${profile.id}`)).toEqual(retained);
    }
  });

  it('round-trips valid restored V1 profiles, catalog, disclosure and credentials without fetching', async () => {
    const persistence = new MemoryConnectionPersistence();
    const store = createConnectionStore(persistence);
    const namespace = { kind: 'guest' } as const;
    const profile = await createConnectionProfile({ id: 'valid-restore', name: 'Valid', provider: 'openai' });
    await store.saveProfile(namespace, profile);
    await store.assignCredential(namespace, profile.id, { apiKey: 'valid-restore-key' });
    await store.recordDisclosureChoice(namespace, profile, { decision: 'accepted', recordedAtMs: 10 });
    await store.recordCatalogCheck(namespace, profile, {
      status: 'success',
      requestedUrl: 'https://api.openai.com/v1/models',
      checkedAtMs: 11,
      models: [{ id: 'fixture/model' }],
    });
    const restored = createConnectionStore(persistence);

    expect(await restored.getProfile(namespace, profile.id)).toEqual(profile);
    expect(await restored.listProfiles(namespace)).toEqual([profile]);
    expect((await restored.resolveCredentials(namespace, profile)).status).toBe('bound');
    expect(await restored.getDisclosureChoice(namespace, profile)).toMatchObject({ decision: 'accepted', recordedAtMs: 10 });
    expect(await restored.getCatalogSnapshot(namespace, profile)).toMatchObject({ state: 'complete', entries: [{ id: 'fixture/model' }] });
    expect(await restored.snapshotKnownCredentials(namespace)).toEqual(['valid-restore-key']);
  });

  it('revokes old public bindings after replacement, forget, namespace clear and clear-all', async () => {
    const store = createConnectionStore(new MemoryConnectionPersistence());
    const guest = { kind: 'guest' } as const;
    const account = { kind: 'account', accountId: '9f2a1d48-7be1-4a6b-9d8e-6bafc34d1207' } as const;
    const profile = await createConnectionProfile({ id: 'binding-revocation', name: 'Revocation', provider: 'openai' });
    await store.saveProfile(guest, profile);
    await store.saveProfile(account, profile);

    const assignAndResolve = async (namespace: typeof guest | typeof account, apiKey: string) => {
      await store.assignCredential(namespace, profile.id, { apiKey });
      const result = await store.resolveCredentials(namespace, profile);
      if (result.status !== 'bound') throw new Error(`Expected a local ${namespace.kind} binding.`);
      return result.credentials;
    };

    const guestA = await assignAndResolve(guest, 'guest-key-A-canary');
    const accountA = await assignAndResolve(account, 'account-key-A-canary');
    expect(new Headers(prepareGenerationRequest(profile, guestA, '{}').init.headers).get('authorization'))
      .toBe('Bearer guest-key-A-canary');

    const guestB = await assignAndResolve(guest, 'guest-key-B-canary');
    expect(() => prepareGenerationRequest(profile, guestA, '{}')).toThrowError(
      expect.objectContaining({ code: 'credential-destination-mismatch' }),
    );
    expect(new Headers(prepareGenerationRequest(profile, guestB, '{}').init.headers).get('authorization'))
      .toBe('Bearer guest-key-B-canary');
    expect(new Headers(prepareGenerationRequest(profile, accountA, '{}').init.headers).get('authorization'))
      .toBe('Bearer account-key-A-canary');

    await store.forgetCredential(guest, profile.id);
    expect(() => prepareGenerationRequest(profile, guestB, '{}')).toThrowError(
      expect.objectContaining({ code: 'credential-destination-mismatch' }),
    );
    const guestC = await assignAndResolve(guest, 'guest-key-C-canary');
    await store.clearCredentialsForNamespace(guest);
    expect(() => prepareGenerationRequest(profile, guestC, '{}')).toThrowError(
      expect.objectContaining({ code: 'credential-destination-mismatch' }),
    );
    expect(new Headers(prepareGenerationRequest(profile, accountA, '{}').init.headers).get('authorization'))
      .toBe('Bearer account-key-A-canary');

    const guestD = await assignAndResolve(guest, 'guest-key-D-canary');
    await store.clearAllLocalCredentials();
    for (const binding of [guestD, accountA]) {
      expect(() => prepareGenerationRequest(profile, binding, '{}')).toThrowError(
        expect.objectContaining({ code: 'credential-destination-mismatch' }),
      );
    }
    for (const stale of [guestA, guestB, guestC]) {
      expect(() => prepareGenerationRequest(profile, stale, '{}')).toThrowError(
        expect.objectContaining({ code: 'credential-destination-mismatch' }),
      );
    }
  });

  it('shares revocation across wrappers for one persistence owner and isolates separate stores', async () => {
    const persistence = new MemoryConnectionPersistence();
    const store = createConnectionStore(persistence);
    const secondWrapper = createConnectionStore(persistence);
    const isolatedStore = createConnectionStore(new MemoryConnectionPersistence());
    const guest = { kind: 'guest' } as const;
    const account = { kind: 'account', accountId: '9f2a1d48-7be1-4a6b-9d8e-6bafc34d1207' } as const;
    const profile = await createConnectionProfile({ id: 'owner-scope', name: 'Owner scope', provider: 'openai' });
    for (const target of [store, isolatedStore]) {
      await target.saveProfile(guest, profile);
    }
    await store.saveProfile(account, profile);
    await store.assignCredential(guest, profile.id, { apiKey: 'shared-store-old-canary' });
    await store.assignCredential(account, profile.id, { apiKey: 'independent-account-canary' });
    await isolatedStore.assignCredential(guest, profile.id, { apiKey: 'isolated-store-canary' });
    const guestBinding = await store.resolveCredentials(guest, profile);
    const accountBinding = await store.resolveCredentials(account, profile);
    const isolatedBinding = await isolatedStore.resolveCredentials(guest, profile);
    if (guestBinding.status !== 'bound' || accountBinding.status !== 'bound' || isolatedBinding.status !== 'bound') {
      throw new Error('Expected deliberate bindings in both persistence stores.');
    }

    await secondWrapper.assignCredential(guest, profile.id, { apiKey: 'shared-store-new-canary' });
    expect(() => prepareGenerationRequest(profile, guestBinding.credentials, '{}')).toThrowError(
      expect.objectContaining({ code: 'credential-destination-mismatch' }),
    );
    expect(new Headers(prepareGenerationRequest(profile, accountBinding.credentials, '{}').init.headers).get('authorization'))
      .toBe('Bearer independent-account-canary');
    expect(new Headers(prepareGenerationRequest(profile, isolatedBinding.credentials, '{}').init.headers).get('authorization'))
      .toBe('Bearer isolated-store-canary');

    const rebound = await secondWrapper.resolveCredentials(guest, profile);
    if (rebound.status !== 'bound') throw new Error('Expected a new binding after replacement.');
    await secondWrapper.forgetProfile(guest, profile.id);
    expect(() => prepareGenerationRequest(profile, rebound.credentials, '{}')).toThrowError(
      expect.objectContaining({ code: 'credential-destination-mismatch' }),
    );
    expect(new Headers(prepareGenerationRequest(profile, accountBinding.credentials, '{}').init.headers).get('authorization'))
      .toBe('Bearer independent-account-canary');
  });

  it('revokes configured secret headers for generation and catalog after credential removal', async () => {
    const store = createConnectionStore(new MemoryConnectionPersistence());
    const namespace = { kind: 'guest' } as const;
    const profile = await createConnectionProfile({
      id: 'header-revocation',
      name: 'Configured header',
      provider: 'custom',
      protocol: 'chat-completions',
      baseUrl: 'https://custom.example.test/team/v1',
      catalogUrl: 'https://custom.example.test/team/v1/models',
      auth: { kind: 'none' },
      headers: [{ name: 'x-tenant-token', source: 'credential' }],
    });
    await store.saveProfile(namespace, profile);
    await store.assignCredential(namespace, profile.id, { headers: { 'x-tenant-token': 'header-key-canary' } });
    const result = await store.resolveCredentials(namespace, profile);
    if (result.status !== 'bound') throw new Error('Expected a local binding for the configured header.');
    const binding = result.credentials;
    expect(new Headers(prepareGenerationRequest(profile, binding, '{}').init.headers).get('x-tenant-token'))
      .toBe('header-key-canary');
    await store.forgetCredential(namespace, profile.id);

    for (const prepare of [
      () => prepareGenerationRequest(profile, binding, '{}'),
      () => prepareCatalogRequest(profile, binding),
    ]) {
      expect(prepare).toThrowError(expect.objectContaining({
        code: 'credential-destination-mismatch',
        message: 'The local credential binding is no longer available. Assign this connection on this device.',
      }));
    }
  });

  it('keeps an active binding usable when replacement persistence fails', async () => {
    const persistence = new ToggleFailingCredentialPersistence();
    const store = createConnectionStore(persistence);
    const namespace = { kind: 'guest' } as const;
    const profile = await createConnectionProfile({ id: 'failed-replacement', name: 'Failed replacement', provider: 'openai' });
    await store.saveProfile(namespace, profile);
    await store.assignCredential(namespace, profile.id, { apiKey: 'still-saved-key-canary' });
    const result = await store.resolveCredentials(namespace, profile);
    if (result.status !== 'bound') throw new Error('Expected a local binding before failed replacement.');
    persistence.failCredentialWrites = true;

    await expect(store.assignCredential(namespace, profile.id, { apiKey: 'failed-new-key-canary' })).rejects.toMatchObject({
      code: 'local-write-failed',
      message: 'The credential was not saved in this browser.',
    });
    expect(new Headers(prepareGenerationRequest(profile, result.credentials, '{}').init.headers).get('authorization'))
      .toBe('Bearer still-saved-key-canary');
  });

  it('does not bind a stale credential read that finishes after replacement', async () => {
    const persistence = new PausedCredentialReadPersistence();
    const store = createConnectionStore(persistence);
    const namespace = { kind: 'guest' } as const;
    const profile = await createConnectionProfile({ id: 'pending-replacement', name: 'Pending replacement', provider: 'openai' });
    await store.saveProfile(namespace, profile);
    await store.assignCredential(namespace, profile.id, { apiKey: 'pending-old-key-canary' });

    const pausedRead = persistence.pauseNextCredentialRead();
    const staleResolution = store.resolveCredentials(namespace, profile);
    await pausedRead.readCaptured;
    await store.assignCredential(namespace, profile.id, { apiKey: 'pending-new-key-canary' });
    pausedRead.release();

    await expect(staleResolution).rejects.toMatchObject({ code: 'credential-destination-mismatch' });
    const currentResolution = await store.resolveCredentials(namespace, profile);
    if (currentResolution.status !== 'bound') throw new Error('Expected a binding for the replacement credential.');
    expect(new Headers(prepareGenerationRequest(profile, currentResolution.credentials, '{}').init.headers).get('authorization'))
      .toBe('Bearer pending-new-key-canary');
  });

  it('revokes an old binding when its profile configuration is saved again', async () => {
    const store = createConnectionStore(new MemoryConnectionPersistence());
    const namespace = { kind: 'guest' } as const;
    const original = await createConnectionProfile({ id: 'profile-revocation', name: 'Before', provider: 'openai' });
    await store.saveProfile(namespace, original);
    await store.assignCredential(namespace, original.id, { apiKey: 'old-profile-key-canary' });
    const result = await store.resolveCredentials(namespace, original);
    if (result.status !== 'bound') throw new Error('Expected a local binding before profile edit.');
    const moved = await reviseConnectionProfile(original, { baseUrl: 'https://proxy.example.test/v2' });
    await store.saveProfile(namespace, moved);

    expect(() => prepareGenerationRequest(original, result.credentials, '{}')).toThrowError(
      expect.objectContaining({ code: 'credential-destination-mismatch' }),
    );
  });

  it('CON-04/DAT-03 keeps guest and account credentials in separate UUID namespaces', async () => {
    const persistence = new MemoryConnectionPersistence();
    const store = createConnectionStore(persistence);
    const profile = await createConnectionProfile({ id: 'work', name: 'Work', provider: 'openai' });
    const guest = { kind: 'guest' } as const;
    const account = { kind: 'account', accountId: '9f2a1d48-7be1-4a6b-9d8e-6bafc34d1207' } as const;
    const otherAccount = { kind: 'account', accountId: 'b84dc347-6f42-4e2c-8588-eaf8e25bf6da' } as const;

    await store.saveProfile(guest, profile);
    await store.assignCredential(guest, profile.id, { apiKey: 'guest-key-canary' });
    await store.saveProfile(account, profile);
    await store.saveProfile(otherAccount, profile);

    expect(await store.resolveCredentials(account, profile)).toEqual({ status: 'missing' });
    expect(await store.resolveCredentials(otherAccount, profile)).toEqual({ status: 'missing' });
    const guestBinding = await store.resolveCredentials(guest, profile);
    expect(guestBinding.status).toBe('bound');
    if (guestBinding.status === 'bound') {
      expect(guestBinding.credentials.profileId).toBe(profile.id);
      expect(guestBinding.credentials.configRevision).toBe(profile.configRevision);
      expect(guestBinding.credentials.generationUrl).toBe('https://api.openai.com/v1/responses');
      expect(JSON.stringify(guestBinding.credentials)).not.toContain('guest-key-canary');
      const request = prepareGenerationRequest(profile, guestBinding.credentials, '{}');
      expect(request.init.headers.authorization).toBe('Bearer guest-key-canary');
    }
    expect(JSON.stringify(profile)).not.toContain('guest-key-canary');
  });

  it('persists relay consent across an IndexedDB reopen', async () => {
    const factory = new IDBFactory();
    const options = { databaseName: 'relay-consent-fixture', factory };
    const store = await openConnectionStore(options);
    const guest = { kind: 'guest' } as const;
    const profile = await createConnectionProfile({
      id: 'ollama', name: 'Ollama', provider: 'custom', protocol: 'chat-completions',
      baseUrl: 'https://ollama.com/v1', auth: { kind: 'bearer' },
    });
    await store.saveProfile(guest, profile);
    await store.recordDisclosureChoice(guest, profile, { decision: 'accepted', recordedAtMs: 10 });
    const reopened = await openConnectionStore(options);
    const consent = await reopened.getDisclosureChoice(guest, profile);
    expect(consent?.transport).toBe('site-relay');
    expect(hasCurrentDisclosureConsent(profile, consent)).toBe(true);
  });

  it('CON-04/DAT-08 persists profiles and local canaries in separate IndexedDB stores', async () => {
    const factory = new IDBFactory();
    const store = await openConnectionStore({ databaseName: 'kha34-idb-fixture', factory });
    const guest = { kind: 'guest' } as const;
    const account = { kind: 'account', accountId: '9f2a1d48-7be1-4a6b-9d8e-6bafc34d1207' } as const;
    const profile = await createConnectionProfile({ id: 'openai', name: 'OpenAI', provider: 'openai' });
    await store.saveProfile(guest, profile);
    await store.assignCredential(guest, profile.id, { apiKey: 'persisted-key-canary' });
    await store.saveProfile(account, profile);
    const resolved = await store.resolveCredentials(guest, profile);
    if (resolved.status !== 'bound') throw new Error('Expected the guest credential binding.');
    const catalog = await checkConnection(profile, resolved.credentials, {
      fetch: async () => new Response(JSON.stringify({ data: [{ id: 'indexed-model' }], has_more: false }), { status: 200 }),
      now: () => 70,
    });
    await store.recordCatalogCheck(guest, profile, catalog);

    const reloadedStore = await openConnectionStore({ databaseName: 'kha34-idb-fixture', factory });
    const guestCredentials = await reloadedStore.resolveCredentials(guest, profile);
    expect(guestCredentials.status).toBe('bound');
    if (guestCredentials.status === 'bound') {
      expect(JSON.stringify(guestCredentials.credentials)).not.toContain('persisted-key-canary');
      const request = prepareGenerationRequest(profile, guestCredentials.credentials, '{}');
      expect(request.init.headers.authorization).toBe('Bearer persisted-key-canary');
    }
    expect(await reloadedStore.resolveCredentials(account, profile)).toEqual({ status: 'missing' });
    expect((await reloadedStore.getCatalogSnapshot(guest, profile))?.entries).toMatchObject([
      { id: 'indexed-model', state: 'advertised' },
    ]);
    expect(await reloadedStore.getCatalogSnapshot(account, profile)).toBeUndefined();
    expect(JSON.stringify(await reloadedStore.listProfiles(guest))).not.toContain('persisted-key-canary');
    expect(await reloadedStore.snapshotKnownCredentials(guest)).toEqual(['persisted-key-canary']);

    const otherDevice = await openConnectionStore({ databaseName: 'kha34-idb-fixture', factory: new IDBFactory() });
    expect(await otherDevice.resolveCredentials(guest, profile)).toEqual({ status: 'profile-not-found' });

    await reloadedStore.forgetProfile(guest, profile.id);
    expect(await reloadedStore.resolveCredentials(guest, profile)).toEqual({ status: 'profile-not-found' });
    expect(await reloadedStore.snapshotKnownCredentials(guest)).toEqual([]);
  });

  it('CON-03 clears a saved key and disclosure record when an IndexedDB destination changes', async () => {
    const factory = new IDBFactory();
    const store = await openConnectionStore({ databaseName: 'kha34-invalidation-fixture', factory });
    const guest = { kind: 'guest' } as const;
    const original = await createConnectionProfile({ id: 'openai', name: 'OpenAI', provider: 'openai' });
    await store.saveProfile(guest, original);
    await store.assignCredential(guest, original.id, { apiKey: 'idb-old-destination-canary' });
    await store.recordDisclosureChoice(guest, original, { decision: 'accepted', recordedAtMs: 3 });
    const bound = await store.resolveCredentials(guest, original);
    if (bound.status !== 'bound') throw new Error('Expected the saved OpenAI key.');
    const result = await checkConnection(original, bound.credentials, {
      fetch: async () => new Response(JSON.stringify({ data: [{ id: 'old-catalog-model' }], has_more: false }), { status: 200 }),
      now: () => 4,
    });
    await store.recordCatalogCheck(guest, original, result);

    const moved = await reviseConnectionProfile(original, { baseUrl: 'https://proxy.example.test/v1' });
    await store.saveProfile(guest, moved);
    const restored = await reviseConnectionProfile(moved, { baseUrl: 'https://api.openai.com/v1' });
    await store.saveProfile(guest, restored);

    expect(await store.resolveCredentials(guest, restored)).toEqual({ status: 'missing' });
    expect(await store.getDisclosureChoice(guest, restored)).toBeUndefined();
    expect(await store.getCatalogSnapshot(guest, restored)).toBeUndefined();
  });

  it('CON-03 refuses a saved key after a destination change until the player assigns it again', async () => {
    const store = createConnectionStore(new MemoryConnectionPersistence());
    const namespace = { kind: 'guest' } as const;
    const profile = await createConnectionProfile({ id: 'work', name: 'Work', provider: 'openai' });
    await store.saveProfile(namespace, profile);
    expect(await store.assignCredential(namespace, profile.id, { apiKey: 'old-destination-canary' })).toBe(1);

    const changed = await reviseConnectionProfile(profile, { baseUrl: 'https://proxy.example.test/team/v1' });
    await store.saveProfile(namespace, changed);

    expect(await store.resolveCredentials(namespace, profile)).toEqual({ status: 'destination-changed' });
    expect(await store.resolveCredentials(namespace, changed)).toEqual({ status: 'missing' });
    expect(await store.assignCredential(namespace, changed.id, { apiKey: 'new-destination-canary' })).toBe(1);
    const rebound = await store.resolveCredentials(namespace, changed);
    expect(rebound.status).toBe('bound');
    if (rebound.status === 'bound') {
      expect(rebound.credentials.credentialRevision).toBe(1);
      const request = prepareGenerationRequest(changed, rebound.credentials, '{}');
      expect(request.init.headers.authorization).toBe('Bearer new-destination-canary');
    }
  });

  it('CON-03 removes the old key binding when a profile destination changes', async () => {
    const store = createConnectionStore(new MemoryConnectionPersistence());
    const namespace = { kind: 'guest' } as const;
    const original = await createConnectionProfile({ id: 'work', name: 'Work', provider: 'openai' });
    await store.saveProfile(namespace, original);
    await store.assignCredential(namespace, original.id, { apiKey: 'original-destination-canary' });

    const moved = await reviseConnectionProfile(original, { baseUrl: 'https://proxy.example.test/v1' });
    await store.saveProfile(namespace, moved);
    const restored = await reviseConnectionProfile(moved, { baseUrl: 'https://api.openai.com/v1' });
    await store.saveProfile(namespace, restored);

    expect(await store.resolveCredentials(namespace, restored)).toEqual({ status: 'missing' });
  });

  it('CON-02 stores current, partial, failed and no-longer-advertised catalog entries per configuration', async () => {
    const store = createConnectionStore(new MemoryConnectionPersistence());
    const namespace = { kind: 'guest' } as const;
    const profile = await createConnectionProfile({ id: 'openai', name: 'OpenAI', provider: 'openai' });
    await store.saveProfile(namespace, profile);
    await store.assignCredential(namespace, profile.id, { apiKey: 'catalog-cache-canary' });
    const credentials = await store.resolveCredentials(namespace, profile);
    if (credentials.status !== 'bound') throw new Error('Expected credentials bound to OpenAI.');

    const success = await checkConnection(profile, credentials.credentials, {
      fetch: async () => new Response(JSON.stringify({
        data: [{ id: 'model-one' }, { id: 'model-two' }],
        has_more: false,
      }), { status: 200 }),
      now: () => 10,
    });
    const current = await store.recordCatalogCheck(namespace, profile, success);
    expect(current.state).toBe('complete');
    expect(current.entries.map((entry) => [entry.id, entry.state])).toEqual([
      ['model-one', 'advertised'],
      ['model-two', 'advertised'],
    ]);

    const partial = await store.recordCatalogCheck(namespace, profile, {
      status: 'partial',
      requestedUrl: 'https://api.openai.com/v1/models',
      checkedAtMs: 20,
      models: [{ id: 'model-one' }, { id: 'model-three' }],
      nextUrl: 'https://api.openai.com/v1/models?after=model-three',
    });
    expect(partial.state).toBe('partial');
    expect(partial.entries.map((entry) => [entry.id, entry.state])).toEqual([
      ['model-one', 'advertised'],
      ['model-two', 'stale'],
      ['model-three', 'advertised'],
    ]);
    expect(partial.lastSuccessfulAtMs).toBe(10);

    const failed = await checkConnection(profile, credentials.credentials, {
      fetch: async () => new Response('{"error":{"message":"temporary catalog failure"}}', { status: 503 }),
      now: () => 30,
    });
    const stale = await store.recordCatalogCheck(namespace, profile, failed);
    expect(stale.state).toBe('stale');
    expect(stale.entries.every((entry) => entry.state === 'stale')).toBe(true);
    expect(stale.lastSuccessfulAtMs).toBe(10);

    const refreshed = await store.recordCatalogCheck(namespace, profile, {
      status: 'success',
      requestedUrl: 'https://api.openai.com/v1/models',
      checkedAtMs: 40,
      models: [{ id: 'model-one' }],
    });
    expect(refreshed.entries.map((entry) => [entry.id, entry.state])).toEqual([
      ['model-one', 'advertised'],
      ['model-two', 'not-advertised'],
      ['model-three', 'not-advertised'],
    ]);

    const moved = await reviseConnectionProfile(profile, { baseUrl: 'https://proxy.example.test/v1' });
    await store.saveProfile(namespace, moved);
    expect(await store.getCatalogSnapshot(namespace, moved)).toBeUndefined();
    const restored = await reviseConnectionProfile(moved, { baseUrl: 'https://api.openai.com/v1' });
    await store.saveProfile(namespace, restored);
    expect(await store.getCatalogSnapshot(namespace, restored)).toBeUndefined();
  });

  it('CON-04 reports a failed credential write without claiming it was saved or echoing the key', async () => {
    const store = createConnectionStore(new FailingCredentialPersistence());
    const namespace = { kind: 'guest' } as const;
    const profile = await createConnectionProfile({ id: 'work', name: 'Work', provider: 'openai' });
    await store.saveProfile(namespace, profile);

    await expect(store.assignCredential(namespace, profile.id, {
      apiKey: 'should-never-echo-this-secret',
    })).rejects.toMatchObject({
      code: 'local-write-failed',
      message: 'The credential was not saved in this browser.',
    });
  });

  it('CON-03 refuses credential fields inside a saved profile record', async () => {
    const store = createConnectionStore(new MemoryConnectionPersistence());
    const profile = await createConnectionProfile({ id: 'work', name: 'Work', provider: 'openai' });
    const unsafe = { ...profile, apiKey: 'profile-field-canary' } as ConnectionProfile;

    await expect(store.saveProfile({ kind: 'guest' }, unsafe)).rejects.toMatchObject({ code: 'invalid-profile' });
    expect(await store.getProfile({ kind: 'guest' }, profile.id)).toBeUndefined();
  });

  it('CON-07 stores only a caller-recorded choice and invalidates it when the route changes', async () => {
    const store = createConnectionStore(new MemoryConnectionPersistence());
    const namespace = { kind: 'guest' } as const;
    const profile = await createConnectionProfile({ id: 'work', name: 'Work', provider: 'openai' });
    await store.saveProfile(namespace, profile);
    expect(await store.getDisclosureChoice(namespace, profile)).toBeUndefined();

    const accepted = await store.recordDisclosureChoice(namespace, profile, {
      decision: 'accepted',
      recordedAtMs: 1234,
    });
    expect(hasCurrentDisclosureConsent(profile, accepted)).toBe(true);

    const renamed = await reviseConnectionProfile(profile, { name: 'Work API' });
    expect(renamed.configRevision).toBe(profile.configRevision);
    expect(hasCurrentDisclosureConsent(renamed, await store.getDisclosureChoice(namespace, renamed))).toBe(true);

    const changed = await reviseConnectionProfile(profile, { baseUrl: 'https://proxy.example.test/v1' });
    await store.saveProfile(namespace, changed);
    expect(await store.getDisclosureChoice(namespace, changed)).toBeUndefined();
    expect(hasCurrentDisclosureConsent(changed, accepted)).toBe(false);
  });

  it('CON-04/DAT-08 replaces, forgets and clears only local credentials in the requested scope', async () => {
    const store = createConnectionStore(new MemoryConnectionPersistence());
    const guest = { kind: 'guest' } as const;
    const account = { kind: 'account', accountId: '9f2a1d48-7be1-4a6b-9d8e-6bafc34d1207' } as const;
    const guestProfile = await createConnectionProfile({ id: 'same', name: 'Guest route', provider: 'openai' });
    const accountProfile = await createConnectionProfile({
      id: 'same',
      name: 'Account route',
      provider: 'custom',
      protocol: 'messages',
      baseUrl: 'https://account.example.test/v1',
      auth: { kind: 'none' },
      headers: [{ name: 'x-tenant-secret', source: 'credential' }],
    });
    await store.saveProfile(guest, guestProfile);
    await store.saveProfile(account, accountProfile);
    await store.assignCredential(guest, guestProfile.id, { apiKey: 'guest-secret-canary' });
    await store.assignCredential(account, accountProfile.id, { headers: { 'x-tenant-secret': 'account-header-canary' } });
    expect(await store.assignCredential(guest, guestProfile.id, { apiKey: 'replacement-key-canary' })).toBe(2);

    expect(await store.snapshotKnownCredentials(guest)).toEqual(['replacement-key-canary']);
    expect(await store.snapshotKnownCredentials(account)).toEqual(['account-header-canary']);

    await store.clearCredentialsForNamespace(account);
    expect(await store.snapshotKnownCredentials(account)).toEqual([]);
    expect(await store.snapshotKnownCredentials(guest)).toEqual(['replacement-key-canary']);

    await store.forgetCredential(guest, guestProfile.id);
    expect(await store.snapshotKnownCredentials(guest)).toEqual([]);
    await store.assignCredential(guest, guestProfile.id, { apiKey: 'clear-all-canary' });
    await store.clearAllLocalCredentials();
    expect(await store.snapshotKnownCredentials(guest)).toEqual([]);
  });
});
