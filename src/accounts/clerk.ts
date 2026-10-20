/** Optional, injected Clerk browser boundary. No Clerk package is required for guest play. */
export interface ClerkSessionPort {
  readonly id?: string;
  getToken(): Promise<string | null>;
}

export interface ClerkUserPort {
  readonly id: string;
  readonly fullName?: string | null;
  readonly username?: string | null;
  readonly primaryEmailAddress?: { readonly emailAddress: string } | null;
  readonly imageUrl?: string;
}

export interface ClerkBrowserPort {
  readonly user: ClerkUserPort | null;
  readonly session: ClerkSessionPort | null;
  signInWithGoogle(returnUrl: string): Promise<void>;
  openUserProfile?(): void;
  signOut(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export interface ClerkRuntimeConfig {
  readonly publishableKey?: string;
  readonly signInUrl?: string;
  readonly afterSignInUrl?: string;
}

export interface ClerkSdkLoader {
  load(publishableKey: string): Promise<ClerkBrowserPort>;
}

export interface AccountIdentity {
  readonly accountId: string;
  readonly token: () => Promise<string>;
}

export interface IdentityFence {
  fencePendingRequests(): void | Promise<void>;
  hidePrivateViews(): void;
  clearInMemoryIdentity(): void;
}

export interface AccountCredentialStore {
  clearCredentialsForNamespace(namespace: { kind: 'account'; accountId: string }): Promise<void>;
}

export interface AccountSession {
  readonly enabled: boolean;
  readonly identity: AccountIdentity | null;
  readonly client: ClerkBrowserPort | null;
  signInWithGoogle(): Promise<void>;
  signOut(): Promise<void>;
  subscribe(listener: (identity: AccountIdentity | null) => void): () => void;
  dispose(): void;
}

const ALLOWED_CONFIG_KEYS = new Set(['publishableKey', 'afterSignInUrl']);

/** Reads only the documented public keys from an untrusted runtime config object. */
export function readClerkRuntimeConfig(value: unknown): ClerkRuntimeConfig {
  if (!isRecord(value)) return {};
  const source = isRecord(value.clerk) ? value.clerk : value;
  const result: { publishableKey?: string; signInUrl?: string; afterSignInUrl?: string } = {};
  for (const key of ALLOWED_CONFIG_KEYS) {
    const item = source[key];
    if (typeof item === 'string' && item.trim() === item && item.length > 0) {
      result[key as keyof ClerkRuntimeConfig] = item;
    }
  }
  return result;
}

export async function createAccountSession(options: {
  config: ClerkRuntimeConfig;
  sdk?: ClerkSdkLoader;
  credentials: AccountCredentialStore;
  fence: IdentityFence;
  currentUrl?: () => string;
}): Promise<AccountSession> {
  const { config, sdk, credentials, fence } = options;
  if (!config.publishableKey) return disabledSession();
  const client = await (sdk ?? officialClerkSdk).load(config.publishableKey);
  let disposed = false;
  let explicitSignOutInFlight = false;
  let generation = 0;
  let observed = observeClientIdentity(client);
  let currentIdentity = makeIdentity(client, () => generation, observed);
  const listeners = new Set<(identity: AccountIdentity | null) => void>();
  const unsubscribeClient = client.subscribe(() => {
    if (disposed) return;
    const next = observeClientIdentity(client);
    if (explicitSignOutInFlight && next.accountId === null) { observed = next; return; }
    if (sameClientIdentity(observed, next)) return;
    const departing = observed;
    observed = next;
    generation += 1;
    const transitionGeneration = generation;
    currentIdentity = null;
    let fenceWork: Promise<void>;
    try { fenceWork = Promise.resolve(fence.fencePendingRequests()); }
    catch (error) { fenceWork = Promise.reject(error); }
    fence.clearInMemoryIdentity();
    fence.hidePrivateViews();
    for (const listener of listeners) listener(null);
    void (async () => {
      try {
        await fenceWork;
        if (departing.accountId && departing.accountId !== next.accountId) {
          await credentials.clearCredentialsForNamespace({ kind: 'account', accountId: departing.accountId });
        }
      } catch {
        return;
      }
      if (disposed || generation !== transitionGeneration || !sameClientIdentity(observed, observeClientIdentity(client))) return;
      currentIdentity = makeIdentity(client, () => generation, observed);
      for (const listener of listeners) listener(currentIdentity);
    })();
  });
  return {
    enabled: true,
    client,
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      currentIdentity = null;
      unsubscribeClient();
      // Subscribers learn that the account session is gone. A participant
      // session that still holds an account credential must fence it, instead
      // of waiting for a notification that will never come.
      for (const listener of [...listeners]) {
        try { listener(null); } catch { /* one subscriber must not block the rest */ }
      }
      listeners.clear();
    },
    get identity() { return currentIdentity; },
    subscribe(listener) {
      if (disposed) { listener(null); return () => {}; }
      listeners.add(listener);
      listener(currentIdentity);
      return () => listeners.delete(listener);
    },
    async signInWithGoogle() {
      const current = options.currentUrl?.() ?? (typeof location === 'undefined' ? 'http://localhost/' : location.href);
      const currentUrl = new URL(current, typeof location === 'undefined' ? 'http://localhost/' : location.origin);
      const callback = new URL(config.afterSignInUrl ?? currentUrl.href, currentUrl.origin);
      if (callback.origin !== currentUrl.origin || callback.username || callback.password) {
        throw new Error('The Clerk callback must stay on this application origin.');
      }
      await client.signInWithGoogle(callback.href);
    },
    async signOut() {
      const departing = client.user?.id;
      if (!departing) return;
      let failure: unknown;
      try { await fence.fencePendingRequests(); } catch (error) { failure = error; }
      try { await credentials.clearCredentialsForNamespace({ kind: 'account', accountId: departing }); }
      catch (error) { failure ??= error; }
      finally {
        generation += 1;
        currentIdentity = null;
        fence.clearInMemoryIdentity();
        fence.hidePrivateViews();
      }
      explicitSignOutInFlight = true;
      try { await client.signOut(); } catch (error) { failure ??= error; }
      finally { explicitSignOutInFlight = false; }
      for (const listener of listeners) listener(null);
      if (failure) throw failure;
    },
  };
}

function disabledSession(): AccountSession {
  return {
    enabled: false,
    identity: null,
    client: null,
    dispose() {},
    async signInWithGoogle() { throw new Error('Accounts are not configured; guest play remains available.'); },
    async signOut() {},
    subscribe(listener) { listener(null); return () => {}; },
  };
}

interface OfficialClerkClient {
  user: ClerkUserPort | null;
  session: { getToken(): Promise<string | null> } | null;
  load(options?: { ui: unknown }): Promise<void>;
  addListener(listener: () => void): () => void;
  openSignIn(options?: Record<string, unknown>): Promise<void>;
  openUserProfile(): void;
  signOut(): Promise<void>;
}

/** The package is a runtime dependency only when account config is explicitly present. */
export const officialClerkSdk: ClerkSdkLoader = {
  async load(publishableKey) {
    const existing = officialClientLoads.get(publishableKey);
    if (existing) return existing;
    const loading = loadOfficialClerkClient(publishableKey);
    officialClientLoads.set(publishableKey, loading);
    try { return await loading; }
    catch (error) { officialClientLoads.delete(publishableKey); throw error; }
  },
};

const officialClientLoads = new Map<string, Promise<ClerkBrowserPort>>();

async function loadOfficialClerkClient(publishableKey: string): Promise<ClerkBrowserPort> {
    const [sdk, { ui }] = await Promise.all([import('@clerk/clerk-js'), import('@clerk/ui')]);
    const clerk = new sdk.Clerk(publishableKey) as unknown as OfficialClerkClient;
    await clerk.load({ ui });
    return {
      get user() { return clerk.user; },
      get session() { return clerk.session; },
      async signInWithGoogle(returnUrl) {
        await clerk.openSignIn({ forceRedirectUrl: returnUrl });
      },
      openUserProfile() { clerk.openUserProfile(); },
      async signOut() { await clerk.signOut(); },
      subscribe(listener) { return clerk.addListener(listener); },
    };
}

interface ObservedClientIdentity {
  readonly accountId: string | null;
  readonly sessionKey: string | object | null;
}

function observeClientIdentity(client: ClerkBrowserPort): ObservedClientIdentity {
  const accountId = client.user?.id ?? null;
  const session = client.session;
  const sessionKey = session ? typeof session.id === 'string' && session.id.length > 0 ? `session:${session.id}` : session : null;
  return { accountId, sessionKey };
}

function sameClientIdentity(left: ObservedClientIdentity, right: ObservedClientIdentity): boolean {
  return left.accountId === right.accountId && left.sessionKey === right.sessionKey;
}

function makeIdentity(client: ClerkBrowserPort, generation: () => number, captured: ObservedClientIdentity): AccountIdentity | null {
  const capturedAccountId = captured.accountId;
  const capturedGeneration = generation();
  if (!capturedAccountId || captured.sessionKey === null) return null;
  return {
    accountId: capturedAccountId,
    async token() {
      if (!sameClientIdentity(captured, observeClientIdentity(client)) || generation() !== capturedGeneration) {
        throw new Error('The signed-in account changed. Refresh the account session before sending this request.');
      }
      const session = client.session;
      if (!session) throw new Error('The signed-in account changed. Refresh the account session before sending this request.');
      const token = await session.getToken();
      if (!sameClientIdentity(captured, observeClientIdentity(client)) || generation() !== capturedGeneration) {
        throw new Error('The signed-in account changed while authorizing this request.');
      }
      if (!token) throw new Error('The Clerk session has no API token.');
      return token;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
