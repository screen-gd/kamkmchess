/**
 * Participant session boundary for shared online play (KHA-67).
 *
 * The session owns exactly one participant credential at a time and a
 * generation counter that fences every piece of work started under an older
 * credential. The generation moves whenever the active credential is
 * replaced, removed, invalidated by a signed-in identity change, or disposed.
 *
 * A signed-in account and a guest seat never merge. Signing in while a guest
 * seat is selected leaves the guest seat alone; moving to the account seat is
 * always an explicit selection.
 *
 * An explicit `clear` is sticky. It removes the participant credential, for
 * example because the seat was removed, and no later account notification can
 * silently restore it: only an explicit `selectAccount` or `selectGuest` puts
 * a credential back. Without that rule a routine Clerk session refresh would
 * hand a removed seat a live credential again.
 *
 * The account session is injected, so the existing `AccountSession` in
 * `src/accounts/clerk.ts` composes directly: its subscription is what fences
 * this session when the signed-in account or the Clerk session changes.
 */
import { OnlineAuthError } from './auth';
import type { AccountOnlineCredential, GuestOnlineCredential, OnlineAuthErrorCode, OnlineCredential } from './auth';

/** The signed-in identity, shaped like `AccountIdentity` in `src/accounts/clerk.ts`. */
export interface AccountIdentityPort {
  readonly accountId: string;
  token(): Promise<string>;
}

/** The account session, shaped like `AccountSession` in `src/accounts/clerk.ts`. */
export interface AccountSessionPort {
  readonly identity: AccountIdentityPort | null;
  subscribe(listener: (identity: AccountIdentityPort | null) => void): () => void;
}

export type ParticipantSelection = 'account' | 'guest' | 'none';

export interface ParticipantSessionState {
  readonly generation: number;
  readonly selection: ParticipantSelection;
  readonly credential: OnlineCredential | null;
  readonly accountId: string | null;
  /** True once a participant credential was selected, even after it was removed. */
  readonly hasParticipant: boolean;
  /** Why the previous credential stopped being valid, or null when nothing was invalidated. */
  readonly invalidates: OnlineAuthErrorCode | null;
}

export interface ParticipantSession {
  readonly generation: number;
  readonly selection: ParticipantSelection;
  readonly credential: OnlineCredential | null;
  readonly accountId: string | null;
  readonly hasParticipant: boolean;
  subscribe(listener: (state: ParticipantSessionState) => void): () => void;
  /** Explicitly act as the signed-in account. Requires a signed-in identity. */
  selectAccount(): void;
  /** Explicitly act as the owner of a private guest seat. Never merges into the account. */
  selectGuest(credential: GuestOnlineCredential): void;
  /** Remove the active participant credential, for example when a seat is removed. */
  clear(): void;
  dispose(): void;
}

export interface ParticipantSessionOptions {
  readonly accountSession?: AccountSessionPort | null;
}

export function createParticipantSession(options: ParticipantSessionOptions = {}): ParticipantSession {
  const listeners = new Set<(state: ParticipantSessionState) => void>();
  const accountSession = options.accountSession ?? null;
  let generation = 0;
  let selection: ParticipantSelection = 'none';
  let credential: OnlineCredential | null = null;
  let accountId: string | null = null;
  let hasParticipant = false;
  let guestOwned = false;
  let disposed = false;
  /** True once the participant credential was removed on purpose. */
  let explicitlyCleared = false;
  let lastIdentity: AccountIdentityPort | null = null;
  /** The identity the active account credential was minted from. */
  let accountIdentity: AccountIdentityPort | null = null;

  if (accountSession) {
    lastIdentity = accountSession.identity;
    if (lastIdentity) {
      accountId = lastIdentity.accountId;
      selection = 'account';
      credential = makeAccountCredential(lastIdentity);
      accountIdentity = lastIdentity;
      hasParticipant = true;
    }
  }

  function state(reason: OnlineAuthErrorCode | null): ParticipantSessionState {
    return { generation, selection, credential, accountId, hasParticipant, invalidates: reason };
  }

  function publish(reason: OnlineAuthErrorCode | null): void {
    const snapshot = state(reason);
    for (const listener of [...listeners]) listener(snapshot);
  }

  function commit(
    next: { selection: ParticipantSelection; credential: OnlineCredential | null; accountId: string | null },
    reason: OnlineAuthErrorCode | null,
  ): void {
    if (next.selection === selection && next.credential === credential && next.accountId === accountId) return;
    if (next.credential !== credential || next.selection !== selection) generation += 1;
    selection = next.selection;
    credential = next.credential;
    accountId = next.accountId;
    publish(reason);
  }

  function setAccountIdentity(next: AccountIdentityPort | null): void {
    if (disposed) return;
    // The same identity object is a re-notification, not a change. A different
    // object is a different Clerk session, even for the same account.
    if (next === lastIdentity) return;
    lastIdentity = next;
    const nextAccountId = next ? next.accountId : null;
    if (explicitlyCleared) {
      // The participant credential was removed on purpose. An account
      // notification never restores it; only an explicit selection does.
      commit({ selection: 'none', credential: null, accountId: nextAccountId }, 'identity-changed');
      return;
    }
    if (guestOwned) {
      // The guest seat keeps its own private credential. A signed-in account
      // never silently adopts a guest seat.
      commit({ selection: 'guest', credential, accountId: nextAccountId }, null);
      return;
    }
    const nextCredential = next ? makeAccountCredential(next) : null;
    accountIdentity = next;
    commit(
      { selection: next ? 'account' : 'none', credential: nextCredential, accountId: nextAccountId },
      'identity-changed',
    );
  }

  const unsubscribeAccount = accountSession
    ? accountSession.subscribe((identity) => setAccountIdentity(identity))
    : undefined;

  return {
    get generation() { return generation; },
    get selection() { return selection; },
    get credential() { return credential; },
    get accountId() { return accountId; },
    get hasParticipant() { return hasParticipant; },
    subscribe(listener) {
      if (disposed) {
        listener(state(null));
        return () => {};
      }
      listeners.add(listener);
      listener(state(null));
      return () => { listeners.delete(listener); };
    },
    selectAccount() {
      if (disposed) throw new OnlineAuthError('disposed', 'The participant session was disposed.');
      if (!lastIdentity) throw new OnlineAuthError('no-credential', 'Sign in before using the account seat.');
      // Re-selecting the account seat that is already active is not a change.
      if (selection === 'account' && accountIdentity === lastIdentity) return;
      guestOwned = false;
      explicitlyCleared = false;
      hasParticipant = true;
      accountIdentity = lastIdentity;
      commit(
        { selection: 'account', credential: makeAccountCredential(lastIdentity), accountId: lastIdentity.accountId },
        'credential-changed',
      );
    },
    selectGuest(next) {
      if (disposed) throw new OnlineAuthError('disposed', 'The participant session was disposed.');
      if (next.kind !== 'guest') throw new OnlineAuthError('wrong-scope', 'A guest seat credential is required.');
      guestOwned = true;
      explicitlyCleared = false;
      hasParticipant = true;
      accountIdentity = null;
      commit({ selection: 'guest', credential: next, accountId }, 'credential-changed');
    },
    clear() {
      if (disposed) return;
      guestOwned = false;
      explicitlyCleared = true;
      accountIdentity = null;
      commit({ selection: 'none', credential: null, accountId }, 'credential-cleared');
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      explicitlyCleared = true;
      generation += 1;
      credential = null;
      selection = 'none';
      publish('disposed');
      listeners.clear();
      unsubscribeAccount?.();
    },
  };
}

function makeAccountCredential(identity: AccountIdentityPort): AccountOnlineCredential {
  return {
    kind: 'account',
    accountId: identity.accountId,
    issue: () => identity.token(),
  };
}
