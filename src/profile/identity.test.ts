import { describe, expect, it } from 'vitest';
import { createProfileIdentityTracker } from './identity';
import type { ProfileAccountPort, ProfileGuestSeatPort } from './identity';

function account(accountId: string): ProfileAccountPort {
  return { accountId, token: async () => `token-${accountId}` };
}

function guestSeat(secret: string): ProfileGuestSeatPort {
  return { issue: async () => secret };
}

describe('profile identity tracker', () => {
  it('keeps the binding when the same identity is reported again', () => {
    const tracker = createProfileIdentityTracker();
    const owner = account('acct_alpha');

    const first = tracker.update(owner, null);
    const second = tracker.update(owner, null);

    expect(second).toBe(first);
    expect(first.signal.aborted).toBe(false);
  });

  it('makes a new binding and fences the old one when the account changes', () => {
    const tracker = createProfileIdentityTracker();
    const first = tracker.update(account('acct_alpha'), null);

    const second = tracker.update(account('acct_bravo'), null);

    expect(second).not.toBe(first);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(second.account?.accountId).toBe('acct_bravo');
    expect(second.generation).toBeGreaterThan(first.generation);
  });

  it('makes a new binding when the session of the same account is replaced', () => {
    const tracker = createProfileIdentityTracker();
    const first = tracker.update(account('acct_alpha'), null);

    // A replaced Clerk session is a new identity object for the same account.
    const second = tracker.update(account('acct_alpha'), null);

    expect(second).not.toBe(first);
    expect(first.signal.aborted).toBe(true);
    expect(second.account?.accountId).toBe('acct_alpha');
  });

  it('makes a new binding when the guest seat changes', () => {
    const tracker = createProfileIdentityTracker();
    const owner = account('acct_alpha');
    const first = tracker.update(owner, guestSeat('secret-1'));

    const second = tracker.update(owner, guestSeat('secret-2'));

    expect(second).not.toBe(first);
    expect(first.signal.aborted).toBe(true);
  });

  it('fences the binding when the tracker is disposed', () => {
    const tracker = createProfileIdentityTracker();
    const binding = tracker.update(account('acct_alpha'), null);

    tracker.dispose();

    expect(binding.signal.aborted).toBe(true);
    expect(tracker.binding).toBeNull();
  });

  it('refuses to make a binding after it was disposed', () => {
    const tracker = createProfileIdentityTracker();
    tracker.dispose();

    expect(() => tracker.update(account('acct_alpha'), null)).toThrow(/disposed/);
  });
});
