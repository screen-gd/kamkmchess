import { describe, expect, it } from 'vitest';
import {
  OnlineAuthError,
  accountScope,
  assertCredentialFresh,
  assertCredentialScope,
  createGuestCredential,
  credentialAllowsScope,
  describeCredential,
  matchSeatScope,
} from './auth';

interface MutableGuestInput {
  guestId: string;
  matchId: string;
  seat: 'white' | 'black';
  token: string;
  expiresAt?: number;
}

describe('participant credentials', () => {
  it('keeps a guest seat credential bound to one match and one seat', () => {
    const guest = createGuestCredential({ guestId: 'guest_1', matchId: 'match_alpha', seat: 'white', token: 'guest-secret-token' });
    expect(credentialAllowsScope(guest, matchSeatScope('match_alpha', 'white'))).toBe(true);
    expect(credentialAllowsScope(guest, matchSeatScope('match_alpha', 'black'))).toBe(false);
    expect(credentialAllowsScope(guest, matchSeatScope('match_beta', 'white'))).toBe(false);
    expect(credentialAllowsScope(guest, accountScope())).toBe(false);
    expect(() => assertCredentialScope(guest, matchSeatScope('match_beta', 'white'))).toThrow(OnlineAuthError);
    expect(() => assertCredentialScope(guest, accountScope())).toThrow(/account-scoped/);
  });

  it('refuses an empty or malformed guest credential', () => {
    expect(() => createGuestCredential({ guestId: '', matchId: 'match_alpha', seat: 'white', token: 'secret' })).toThrow(/guest identity/);
    expect(() => createGuestCredential({ guestId: 'guest_1', matchId: ' ', seat: 'white', token: 'secret' })).toThrow(/match scope/);
    expect(() => createGuestCredential({ guestId: 'guest_1', matchId: 'match_alpha', seat: 'white', token: '' })).toThrow(/empty/);
    expect(() => createGuestCredential({ guestId: 'guest_1', matchId: 'match_alpha', seat: 'white', token: 'secret\nX-Injected: 1' })).toThrow(/malformed/);
    expect(() => createGuestCredential({ guestId: 'guest_1', matchId: 'match_alpha', seat: 'white', token: ' secret ' })).toThrow(/malformed/);
  });

  it('refuses a guest credential with an unusable expiry', () => {
    expect(() => createGuestCredential({ guestId: 'guest_1', matchId: 'match_alpha', seat: 'white', token: 'secret', expiresAt: Number.NaN })).toThrow(/expiry is invalid/);
    expect(() => createGuestCredential({ guestId: 'guest_1', matchId: 'match_alpha', seat: 'white', token: 'secret', expiresAt: Number.POSITIVE_INFINITY })).toThrow(/expiry is invalid/);
    expect(() => assertCredentialFresh({ kind: 'guest', guestId: 'g', matchId: 'm', seat: 'white', expiresAt: Number.NaN, issue: async () => 'token' }, 1)).toThrow(/expiry is invalid/);
  });

  it('captures the guest token and expiry once, so a later mutation cannot change them', async () => {
    const input: MutableGuestInput = { guestId: 'guest_1', matchId: 'match_alpha', seat: 'white', token: 'first-token' };
    const guest = createGuestCredential(input);
    input.token = 'second-token';
    await expect(guest.issue()).resolves.toBe('first-token');
    const withExpiry = createGuestCredential({ guestId: 'guest_1', matchId: 'match_alpha', seat: 'white', token: 'first-token', expiresAt: 5_000 });
    await expect(withExpiry.issue()).resolves.toBe('first-token');
    expect(withExpiry.expiresAt).toBe(5_000);
  });

  it('lets an account credential act on any match seat but never loses its account identity', () => {
    const account = { kind: 'account', accountId: 'user_2abcdefghijklmnop', issue: async () => 'jwt' } as const;
    expect(credentialAllowsScope(account, matchSeatScope('match_alpha', 'white'))).toBe(true);
    expect(credentialAllowsScope(account, accountScope())).toBe(true);
  });

  it('refuses a credential whose own expiry has passed', () => {
    const guest = createGuestCredential({ guestId: 'guest_1', matchId: 'match_alpha', seat: 'white', token: 'secret', expiresAt: 1_000 });
    expect(() => assertCredentialFresh(guest, 999)).not.toThrow();
    expect(() => assertCredentialFresh(guest, 1_000)).toThrow(OnlineAuthError);
    try {
      assertCredentialFresh(guest, 2_000);
    } catch (error) {
      expect((error as OnlineAuthError).code).toBe('credential-expired');
    }
  });

  it('describes the participant locally without ever exposing a token', () => {
    const guest = createGuestCredential({ guestId: 'guest_1', matchId: 'match_alpha', seat: 'white', token: 'guest-secret-token' });
    const described = describeCredential(guest);
    expect(described).toEqual({ kind: 'guest', guestId: 'guest_1', matchId: 'match_alpha', seat: 'white' });
    expect(JSON.stringify(described)).not.toContain('guest-secret-token');
    // The descriptor carries private identifiers. It is local state: it is
    // never a shared snapshot, a URL, or a log line.
    expect(described?.kind === 'guest' && described.guestId).toBe('guest_1');
    expect(described?.kind === 'guest' && described.matchId).toBe('match_alpha');
    expect(describeCredential(null)).toBeNull();
    expect(describeCredential({ kind: 'account', accountId: 'user_1', issue: async () => 'jwt' })).toEqual({ kind: 'account', accountId: 'user_1' });
  });
});
