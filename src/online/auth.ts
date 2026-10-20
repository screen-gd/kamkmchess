/**
 * Participant credentials for shared online play (KHA-67).
 *
 * Two credential kinds exist and never mix:
 *
 * - an **account** credential, derived from the signed-in Clerk session, and
 * - a **guest** credential: a private, revocable token scoped to exactly one
 *   match and one seat.
 *
 * A guest credential cannot authorize an account-scoped request, a different
 * match, or a different seat. Credentials live in memory only: nothing here
 * writes a secret to storage, a URL, a query string, a log line, or a shared
 * snapshot.
 *
 * `describeCredential` produces a **local** participant description. It
 * carries private identifiers (the account ID, the guest ID, the match ID), so
 * it may be shown in this application's own interface and kept in local state
 * only. It is never safe to embed in a shared snapshot, a URL, an analytics
 * payload, or a log line.
 */
import type { Seat } from './contracts';

export type OnlineAuthErrorCode =
  | 'no-credential'
  | 'credential-cleared'
  | 'credential-expired'
  | 'credential-changed'
  | 'invalid-credential'
  | 'wrong-scope'
  | 'identity-changed'
  | 'origin-mismatch'
  | 'invalid-url'
  | 'credential-in-url'
  | 'credential-header-conflict'
  | 'invalid-transport'
  | 'disposed'
  | 'aborted';

/** Every failure of the participant boundary carries a stable, inspectable code. */
export class OnlineAuthError extends Error {
  readonly code: OnlineAuthErrorCode;

  constructor(code: OnlineAuthErrorCode, message: string) {
    super(message);
    this.name = 'OnlineAuthError';
    this.code = code;
  }
}

/** What a request is allowed to act on. */
export type OnlineRequestScope =
  | { readonly kind: 'account' }
  | { readonly kind: 'match-seat'; readonly matchId: string; readonly seat: Seat };

export function accountScope(): OnlineRequestScope {
  return { kind: 'account' };
}

export function matchSeatScope(matchId: string, seat: Seat): OnlineRequestScope {
  return { kind: 'match-seat', matchId, seat };
}

/** A signed-in account participant. The token is minted per request, never cached. */
export interface AccountOnlineCredential {
  readonly kind: 'account';
  readonly accountId: string;
  readonly expiresAt?: number;
  issue(): Promise<string>;
}

/** A private guest participant bound to one match and one seat. */
export interface GuestOnlineCredential {
  readonly kind: 'guest';
  readonly guestId: string;
  readonly matchId: string;
  readonly seat: Seat;
  readonly expiresAt?: number;
  issue(): Promise<string>;
}

export type OnlineCredential = AccountOnlineCredential | GuestOnlineCredential;

/**
 * A local description of the active participant.
 *
 * This shape carries private identifiers. It is local state: it may be shown
 * in this application's own interface, and it must never be embedded in a
 * shared snapshot, a URL, a log line, or an analytics payload.
 */
export type LocalCredentialDescriptor =
  | { readonly kind: 'account'; readonly accountId: string }
  | { readonly kind: 'guest'; readonly guestId: string; readonly matchId: string; readonly seat: Seat };

/**
 * Describes the active participant for local use only.
 *
 * The description never carries a token, but it does carry the private account
 * ID, guest ID, and match ID. Callers must keep it local; see
 * {@link LocalCredentialDescriptor}.
 */
export function describeCredential(credential: OnlineCredential | null): LocalCredentialDescriptor | null {
  if (!credential) return null;
  if (credential.kind === 'account') return { kind: 'account', accountId: credential.accountId };
  return { kind: 'guest', guestId: credential.guestId, matchId: credential.matchId, seat: credential.seat };
}

/** True when the credential may act on the requested scope. */
export function credentialAllowsScope(credential: OnlineCredential, scope: OnlineRequestScope): boolean {
  try {
    assertCredentialScope(credential, scope);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rejects a credential that does not belong to the requested scope. Account
 * credentials may act on any match seat; the service checks membership. Guest
 * credentials are pinned to one match and one seat.
 */
export function assertCredentialScope(credential: OnlineCredential, scope: OnlineRequestScope): void {
  assertScopeShape(scope);
  if (credential.kind !== 'guest') return;
  if (scope.kind !== 'match-seat') {
    throw new OnlineAuthError('wrong-scope', 'A guest seat credential cannot authorize an account-scoped request.');
  }
  if (scope.matchId !== credential.matchId || scope.seat !== credential.seat) {
    throw new OnlineAuthError('wrong-scope', 'This guest seat credential belongs to a different match or seat.');
  }
}

/** Rejects a credential whose own expiry has passed or is not a usable instant. */
export function assertCredentialFresh(credential: OnlineCredential, now: number): void {
  const expiresAt = credential.expiresAt;
  if (expiresAt === undefined) return;
  if (!Number.isFinite(expiresAt)) {
    throw new OnlineAuthError('invalid-credential', 'The participant credential expiry is invalid.');
  }
  if (expiresAt <= now) {
    throw new OnlineAuthError('credential-expired', 'The participant credential has expired. Rejoin the seat to continue.');
  }
}

export interface GuestCredentialInput {
  readonly guestId: string;
  readonly matchId: string;
  readonly seat: Seat;
  readonly token: string;
  readonly expiresAt?: number;
}

/**
 * Builds an in-memory guest seat credential from a private token handed over
 * by the service. The token never leaves this object except through `issue`.
 * A revocable guest credential is still only a credential for one seat: the
 * service decides whether it is still valid.
 *
 * The token and the expiry are captured once, by value. A later mutation of
 * the caller's input object can never change what this credential presents.
 */
export function createGuestCredential(input: GuestCredentialInput): GuestOnlineCredential {
  const guestId = requireIdentifier(input.guestId, 'The guest identity is invalid.');
  const matchId = requireIdentifier(input.matchId, 'The guest match scope is invalid.');
  const seat = requireSeat(input.seat);
  const token = requireToken(input.token);
  const expiresAt = requireExpiry(input.expiresAt);
  const credential: GuestOnlineCredential = {
    kind: 'guest',
    guestId,
    matchId,
    seat,
    issue: async () => token,
  };
  return expiresAt === undefined ? credential : { ...credential, expiresAt };
}

function assertScopeShape(scope: OnlineRequestScope): void {
  if (scope.kind === 'account') return;
  requireIdentifier(scope.matchId, 'The match scope is invalid.');
  requireSeat(scope.seat);
}

function requireIdentifier(value: string, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new OnlineAuthError('wrong-scope', message);
  return value;
}

function requireSeat(value: Seat): Seat {
  if (value !== 'white' && value !== 'black') throw new OnlineAuthError('wrong-scope', 'The seat scope is invalid.');
  return value;
}

function requireToken(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OnlineAuthError('no-credential', 'The guest seat credential is empty.');
  }
  if (value !== value.trim()) {
    throw new OnlineAuthError('invalid-credential', 'The guest seat credential is malformed.');
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new OnlineAuthError('invalid-credential', 'The guest seat credential is malformed.');
    }
  }
  return value;
}

function requireExpiry(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new OnlineAuthError('invalid-credential', 'The guest seat credential expiry is invalid.');
  }
  return value;
}
