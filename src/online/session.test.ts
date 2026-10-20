import { describe, expect, it, vi } from 'vitest';
import { OnlineAuthError, createGuestCredential } from './auth';
import { createParticipantSession } from './session';
import type { AccountIdentityPort } from './session';
import { createAccountSession } from '../accounts/clerk';

function identity(accountId: string, token = 'jwt'): AccountIdentityPort {
  return { accountId, token: async () => token };
}

function accountSessionStub(initial: AccountIdentityPort | null) {
  let identity = initial;
  const listeners = new Set<(next: AccountIdentityPort | null) => void>();
  return {
    get identity() { return identity; },
    subscribe(listener: (next: AccountIdentityPort | null) => void) {
      listeners.add(listener);
      listener(identity);
      return () => { listeners.delete(listener); };
    },
    emit(next: AccountIdentityPort | null) {
      identity = next;
      for (const listener of [...listeners]) listener(next);
    },
  };
}

describe('participant session', () => {
  it('uses the signed-in account as the participant credential', async () => {
    const accountSession = accountSessionStub(identity('user_2abcdefghijklmnop', 'jwt-a'));
    const session = createParticipantSession({ accountSession });
    expect(session.selection).toBe('account');
    expect(session.accountId).toBe('user_2abcdefghijklmnop');
    expect(session.credential?.kind).toBe('account');
    await expect(session.credential?.issue()).resolves.toBe('jwt-a');
    session.dispose();
  });

  it('fences the participant when the signed-in account changes', () => {
    const accountSession = accountSessionStub(identity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const before = session.generation;
    accountSession.emit(identity('user_3qrstuvwxyzabcdef'));
    expect(session.generation).toBe(before + 1);
    expect(session.credential?.kind).toBe('account');
    expect(session.credential?.kind === 'account' && session.credential.accountId).toBe('user_3qrstuvwxyzabcdef');
    expect(session.accountId).toBe('user_3qrstuvwxyzabcdef');
    session.dispose();
  });

  it('fences the participant when the same account is replaced by a new session', () => {
    const accountSession = accountSessionStub(identity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const first = session.credential;
    const before = session.generation;
    accountSession.emit(identity('user_2abcdefghijklmnop', 'jwt-new'));
    expect(session.generation).toBe(before + 1);
    expect(session.credential).not.toBe(first);
    expect(session.credential?.kind === 'account' && session.credential.accountId).toBe('user_2abcdefghijklmnop');
    session.dispose();
  });

  it('keeps the participant across a routine token refresh', () => {
    const accountSession = accountSessionStub(identity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const before = session.generation;
    const credential = session.credential;
    accountSession.emit(accountSession.identity);
    expect(session.generation).toBe(before);
    expect(session.credential).toBe(credential);
    session.dispose();
  });

  it('removes the account credential on sign-out', () => {
    const accountSession = accountSessionStub(identity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const before = session.generation;
    accountSession.emit(null);
    expect(session.generation).toBe(before + 1);
    expect(session.credential).toBeNull();
    expect(session.selection).toBe('none');
    expect(session.accountId).toBeNull();
    expect(session.hasParticipant).toBe(true);
    session.dispose();
  });

  it('never merges an explicitly selected guest seat into a signed-in account', () => {
    const accountSession = accountSessionStub(null);
    const session = createParticipantSession({ accountSession });
    const guest = createGuestCredential({ guestId: 'guest_1', matchId: 'match_alpha', seat: 'white', token: 'guest-secret-token' });
    session.selectGuest(guest);
    const generation = session.generation;
    accountSession.emit(identity('user_2abcdefghijklmnop'));
    expect(session.credential).toBe(guest);
    expect(session.generation).toBe(generation);
    expect(session.selection).toBe('guest');
    expect(session.accountId).toBe('user_2abcdefghijklmnop');
    session.dispose();
  });

  it('moves to the account seat only on an explicit selection', () => {
    const accountSession = accountSessionStub(identity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const guest = createGuestCredential({ guestId: 'guest_1', matchId: 'match_alpha', seat: 'white', token: 'guest-secret-token' });
    session.selectGuest(guest);
    expect(session.selection).toBe('guest');
    session.selectAccount();
    expect(session.selection).toBe('account');
    expect(session.credential?.kind).toBe('account');
    expect(session.credential).not.toBe(guest);
    session.dispose();
  });

  it('keeps the participant steady when the same account seat is selected again', () => {
    const accountSession = accountSessionStub(identity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const credential = session.credential;
    const generation = session.generation;
    session.selectAccount();
    expect(session.credential).toBe(credential);
    expect(session.generation).toBe(generation);
    session.dispose();
  });

  it('refuses an account selection without a signed-in identity', () => {
    const session = createParticipantSession({ accountSession: accountSessionStub(null) });
    expect(() => session.selectAccount()).toThrow(OnlineAuthError);
    expect(() => session.selectAccount()).toThrow(/Sign in/);
    session.dispose();
  });

  it('removes the participant credential and fences on an explicit clear', () => {
    const session = createParticipantSession({ accountSession: accountSessionStub(identity('user_2abcdefghijklmnop')) });
    const before = session.generation;
    const reasons: Array<string | null> = [];
    session.subscribe((state) => reasons.push(state.invalidates));
    session.clear();
    expect(session.generation).toBe(before + 1);
    expect(session.credential).toBeNull();
    expect(session.selection).toBe('none');
    expect(reasons).toContain('credential-cleared');
    session.dispose();
  });

  it('never restores an explicitly cleared participant on an account notification', () => {
    const accountSession = accountSessionStub(identity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    session.clear();
    const generation = session.generation;
    // A routine Clerk session refresh must not hand a removed seat a live
    // credential again.
    accountSession.emit(identity('user_2abcdefghijklmnop', 'jwt-new'));
    expect(session.selection).toBe('none');
    expect(session.credential).toBeNull();
    expect(session.generation).toBe(generation);
    session.dispose();
  });

  it('restores an explicitly cleared participant only on an explicit selection', () => {
    const accountSession = accountSessionStub(identity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    session.clear();
    accountSession.emit(identity('user_2abcdefghijklmnop', 'jwt-new'));
    expect(session.credential).toBeNull();
    session.selectAccount();
    expect(session.selection).toBe('account');
    expect(session.credential?.kind).toBe('account');
    session.dispose();
  });

  it('never restores a participant after disposal', () => {
    const accountSession = accountSessionStub(identity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    session.dispose();
    accountSession.emit(identity('user_3qrstuvwxyzabcdef'));
    expect(session.credential).toBeNull();
    expect(session.selection).toBe('none');
    expect(() => session.selectAccount()).toThrow(/disposed/);
    expect(() => session.clear()).not.toThrow();
    expect(session.credential).toBeNull();
  });

  it('fences and stops notifying on disposal', () => {
    const session = createParticipantSession({ accountSession: accountSessionStub(identity('user_2abcdefghijklmnop')) });
    const before = session.generation;
    const reasons: Array<string | null> = [];
    const unsubscribe = session.subscribe((state) => reasons.push(state.invalidates));
    session.dispose();
    expect(session.generation).toBe(before + 1);
    expect(session.credential).toBeNull();
    expect(reasons).toContain('disposed');
    unsubscribe();
    accountSessionStub(null);
  });

  it('composes with the Clerk account session and fences on an account switch', async () => {
    let notify = () => {};
    let user: { id: string } | null = { id: 'user_2abcdefghijklmnop' };
    let clerkSession: { id: string; getToken(): Promise<string | null> } | null = { id: 'sess_a', getToken: async () => 'jwt-a' };
    const accountSession = await createAccountSession({
      config: { publishableKey: 'pk_test_example' },
      sdk: {
        load: async () => ({
          get user() { return user; },
          get session() { return clerkSession; },
          signInWithGoogle: vi.fn(),
          signOut: vi.fn(),
          subscribe: (listener: () => void) => { notify = listener; return () => {}; },
        }),
      },
      credentials: { clearCredentialsForNamespace: vi.fn() },
      fence: { fencePendingRequests: () => {}, hidePrivateViews: () => {}, clearInMemoryIdentity: () => {} },
    });
    const session = createParticipantSession({ accountSession });
    expect(session.selection).toBe('account');
    await expect(session.credential?.issue()).resolves.toBe('jwt-a');
    const generation = session.generation;

    user = { id: 'user_3qrstuvwxyzabcdef' };
    clerkSession = { id: 'sess_b', getToken: async () => 'jwt-b' };
    notify();

    await vi.waitFor(() => expect(session.credential?.kind === 'account' && session.credential.accountId).toBe('user_3qrstuvwxyzabcdef'));
    expect(session.generation).toBeGreaterThan(generation);
    await expect(session.credential?.issue()).resolves.toBe('jwt-b');
    accountSession.dispose();
    session.dispose();
  });

  it('fences the participant when the Clerk account session is disposed', async () => {
    const accountSession = await createAccountSession({
      config: { publishableKey: 'pk_test_example' },
      sdk: {
        load: async () => ({
          user: { id: 'user_2abcdefghijklmnop' },
          session: { id: 'sess_a', getToken: async () => 'jwt-a' },
          signInWithGoogle: vi.fn(),
          signOut: vi.fn(),
          subscribe: () => () => {},
        }),
      },
      credentials: { clearCredentialsForNamespace: vi.fn() },
      fence: { fencePendingRequests: () => {}, hidePrivateViews: () => {}, clearInMemoryIdentity: () => {} },
    });
    const session = createParticipantSession({ accountSession });
    const generation = session.generation;
    expect(session.credential?.kind).toBe('account');

    // The account session is gone, so the participant credential that was
    // derived from it must be fenced instead of being kept alive.
    accountSession.dispose();
    expect(session.credential).toBeNull();
    expect(session.selection).toBe('none');
    expect(session.generation).toBe(generation + 1);
    session.dispose();
  });
});
