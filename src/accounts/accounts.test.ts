import { describe, expect, it, vi } from 'vitest';
import { createAccountSession, readClerkRuntimeConfig } from './clerk';
import { importGuestGames, previewGuestImport } from './guest-import';

describe('optional accounts and explicit guest import', () => {
  it('keeps accounts disabled unless an allowlisted public key and SDK loader are supplied', async () => {
    const load = vi.fn();
    const config = readClerkRuntimeConfig({ clerk: { publishableKey: 'pk_test_example', secretKey: 'must-not-read' }, extra: 'ignored' });
    expect(config).toEqual({ publishableKey: 'pk_test_example' });
    const session = await createAccountSession({ config: {}, sdk: { load }, credentials: { clearCredentialsForNamespace: vi.fn() }, fence: fence() });
    expect(session.enabled).toBe(false);
    await expect(session.signInWithGoogle()).rejects.toThrow(/guest play remains available/);
    expect(load).not.toHaveBeenCalled();
  });

  it('rejects a Clerk post-sign-in callback outside the app origin', async () => {
    const session = await createAccountSession({
      config: { publishableKey: 'pk_test_example', afterSignInUrl: 'https://attacker.example/callback' },
      sdk: { load: async () => ({ user: null, session: null, signInWithGoogle: vi.fn(), signOut: vi.fn(), subscribe: () => () => {} }) },
      credentials: { clearCredentialsForNamespace: vi.fn() }, fence: fence(), currentUrl: () => 'https://app.example/settings',
    });
    await expect(session.signInWithGoogle()).rejects.toThrow(/must stay on this application origin/);
  });

  it('fences first, clears only the departing account keys, and hides private state on sign-out', async () => {
    const calls: string[] = [];
    const session = await createAccountSession({
      config: { publishableKey: 'pk_live_example' },
      sdk: { load: async () => ({ user: { id: 'account-a' }, session: { getToken: async () => 'jwt' }, signInWithGoogle: async () => {}, signOut: async () => { calls.push('clerk-signout'); }, subscribe: () => () => {} }) },
      credentials: { clearCredentialsForNamespace: async ({ accountId }) => { calls.push(`clear:${accountId}`); } },
      fence: { fencePendingRequests: () => { calls.push('fence'); }, hidePrivateViews: () => { calls.push('hide'); }, clearInMemoryIdentity: () => { calls.push('identity-clear'); } },
    });
    expect(await session.identity?.token()).toBe('jwt');
    await session.signOut();
    expect(calls).toEqual(['fence', 'clear:account-a', 'identity-clear', 'hide', 'clerk-signout']);
  });

  it('hides private state and signs out even when local credential removal fails', async () => {
    const calls: string[] = [];
    const session = await createAccountSession({
      config: { publishableKey: 'pk_live_example' },
      sdk: { load: async () => ({ user: { id: 'account-a' }, session: { getToken: async () => 'jwt' }, signInWithGoogle: async () => {}, signOut: async () => { calls.push('clerk-signout'); }, subscribe: () => () => {} }) },
      credentials: { clearCredentialsForNamespace: async () => { throw new Error('storage unavailable'); } },
      fence: { fencePendingRequests: () => { calls.push('fence'); }, hidePrivateViews: () => { calls.push('hide'); }, clearInMemoryIdentity: () => { calls.push('identity-clear'); } },
    });
    await expect(session.signOut()).rejects.toThrow(/storage unavailable/);
    expect(calls).toEqual(['fence', 'identity-clear', 'hide', 'clerk-signout']);
    expect(session.identity).toBeNull();
  });

  it('disposes the Clerk identity listener and invalidates captured tokens', async () => {
    let onChange = () => {};
    const unsubscribe = vi.fn();
    const session = await createAccountSession({
      config: { publishableKey: 'pk_live_example' },
      sdk: { load: async () => ({ user: { id: 'user_2abcdefghijklmnop' }, session: { getToken: async () => 'jwt' }, signInWithGoogle: vi.fn(), signOut: vi.fn(), subscribe: (listener) => { onChange = listener; return unsubscribe; } }) },
      credentials: { clearCredentialsForNamespace: vi.fn() }, fence: fence(),
    });
    const captured = session.identity;
    session.dispose();
    session.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(session.identity).toBeNull();
    await expect(captured?.token()).rejects.toThrow(/account changed/);
    onChange();
    expect(session.identity).toBeNull();
  });

  it('does not invalidate an identity on a same-session token refresh', async () => {
    const user: { id: string } | null = { id: 'user_2abcdefghijklmnop' };
    let clerkSession: { id: string; getToken(): Promise<string | null> } | null;
    let notify = () => {};
    let resolveToken!: (token: string | null) => void;
    clerkSession = { id: 'sess_same', getToken: () => new Promise((resolve) => { resolveToken = resolve; }) };
    const session = await createAccountSession({
      config: { publishableKey: 'pk_live_example' },
      sdk: { load: async () => ({ get user() { return user; }, get session() { return clerkSession; }, signInWithGoogle: vi.fn(), signOut: vi.fn(), subscribe: (listener) => { notify = listener; return () => {}; } }) },
      credentials: { clearCredentialsForNamespace: vi.fn() }, fence: fence(),
    });
    const observed: Array<string | null> = [];
    session.subscribe((identity) => observed.push(identity?.accountId ?? null));
    const tokenPromise = session.identity!.token();
    clerkSession = { id: 'sess_same', getToken: async () => 'refreshed-token' };
    notify();
    resolveToken('old-token');
    await expect(tokenPromise).resolves.toBe('old-token');
    expect(session.identity?.accountId).toBe('user_2abcdefghijklmnop');
    expect(observed).toEqual(['user_2abcdefghijklmnop']);
    session.dispose();
  });

  it('invalidates a captured token when the account or session changes', async () => {
    let user: { id: string } | null = { id: 'user_2abcdefghijklmnop' };
    let clerkSession: { id: string; getToken(): Promise<string | null> } | null = { id: 'sess_a', getToken: async () => 'token' };
    let notify = () => {};
    const session = await createAccountSession({
      config: { publishableKey: 'pk_live_example' },
      sdk: { load: async () => ({ get user() { return user; }, get session() { return clerkSession; }, signInWithGoogle: vi.fn(), signOut: vi.fn(), subscribe: (listener) => { notify = listener; return () => {}; } }) },
      credentials: { clearCredentialsForNamespace: vi.fn() }, fence: fence(),
    });
    const priorIdentity = session.identity!;
    user = { id: 'user_3qrstuvwxyzabcdef' };
    clerkSession = { id: 'sess_b', getToken: async () => 'new-token' };
    notify();
    await expect(priorIdentity.token()).rejects.toThrow(/account changed/);
    expect(session.identity?.accountId).toBe('user_3qrstuvwxyzabcdef');
    session.dispose();
  });

  it('fences a natural account switch and clears the departing account before releasing the new identity', async () => {
    let user: { id: string } | null = { id: 'user_2abcdefghijklmnop' };
    let clerkSession: { id: string; getToken(): Promise<string | null> } | null = { id: 'sess_a', getToken: async () => 'token-a' };
    let notify = () => {};
    const calls: string[] = [];
    let finishClear!: () => void;
    const clearFinished = new Promise<void>((resolve) => { finishClear = resolve; });
    const session = await createAccountSession({
      config: { publishableKey: 'pk_live_example' },
      sdk: { load: async () => ({ get user() { return user; }, get session() { return clerkSession; }, signInWithGoogle: vi.fn(), signOut: vi.fn(), subscribe: (listener) => { notify = listener; return () => {}; } }) },
      credentials: { clearCredentialsForNamespace: async ({ accountId }) => { calls.push(`clear:${accountId}`); finishClear(); } },
      fence: { fencePendingRequests: async () => { calls.push('fence'); }, clearInMemoryIdentity: () => { calls.push('identity-clear'); }, hidePrivateViews: () => { calls.push('hide'); } },
    });
    const seen: Array<string | null> = [];
    session.subscribe((identity) => { calls.push(`identity:${identity?.accountId ?? 'guest'}`); seen.push(identity?.accountId ?? null); });
    user = { id: 'user_3qrstuvwxyzabcdef' };
    clerkSession = { id: 'sess_b', getToken: async () => 'token-b' };
    notify();
    await clearFinished;
    await vi.waitFor(() => expect(session.identity?.accountId).toBe('user_3qrstuvwxyzabcdef'));
    expect(seen).toEqual(['user_2abcdefghijklmnop', null, 'user_3qrstuvwxyzabcdef']);
    expect(calls.indexOf('identity-clear')).toBeLessThan(calls.indexOf('identity:user_3qrstuvwxyzabcdef'));
    expect(calls.indexOf('hide')).toBeLessThan(calls.indexOf('identity:user_3qrstuvwxyzabcdef'));
    expect(calls.indexOf('clear:user_2abcdefghijklmnop')).toBeLessThan(calls.indexOf('identity:user_3qrstuvwxyzabcdef'));
    session.dispose();
  });

  it('notifies subscribers with exactly one final null when the account session is disposed', async () => {
    const session = await createAccountSession({
      config: { publishableKey: 'pk_live_example' },
      sdk: { load: async () => ({ user: { id: 'user_2abcdefghijklmnop' }, session: { getToken: async () => 'jwt' }, signInWithGoogle: vi.fn(), signOut: vi.fn(), subscribe: () => () => {} }) },
      credentials: { clearCredentialsForNamespace: vi.fn() }, fence: fence(),
    });
    const observed: Array<string | null> = [];
    session.subscribe((identity) => observed.push(identity?.accountId ?? null));

    session.dispose();
    session.dispose();
    // A subscriber that is still holding an account credential must learn
    // that the account session is gone, exactly once.
    expect(observed).toEqual(['user_2abcdefghijklmnop', null]);
    expect(session.identity).toBeNull();
  });

  it('previews complete guest references and imports only explicitly selected IDs', async () => {
    const imported: string[] = [];
    const port = {
      listGuestGames: async () => [{ gameId: 'game-1', updatedAtMs: 2, revision: 4, result: 'unresolved', hasDiscardedLines: true, practice: true, unsynced: true }],
      importGuestGame: async (gameId: string, accountId: string) => { imported.push(`${accountId}:${gameId}`); },
    };
    const preview = await previewGuestImport(port, 'account-a');
    expect(preview.games[0]).toMatchObject({ gameId: 'game-1', hasDiscardedLines: true, practice: true, unsynced: true });
    expect(preview.warning).toMatch(/credentials are never imported or synced/);
    await importGuestGames(port, preview, []);
    expect(imported).toEqual([]);
    await importGuestGames(port, preview, ['game-1']);
    expect(imported).toEqual(['account-a:game-1']);
    await expect(importGuestGames(port, preview, ['unknown'])).rejects.toThrow(/list changed/);
  });
});

function fence() { return { fencePendingRequests: () => {}, hidePrivateViews: () => {}, clearInMemoryIdentity: () => {} }; }
