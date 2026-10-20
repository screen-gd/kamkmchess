import { describe, expect, it, vi } from 'vitest';
import { ProfileRequestError, createProfileClient } from './client';
import { createProfileIdentityTracker } from './identity';
import type { ProfileAccountPort, ProfileGuestSeatPort, ProfileIdentityBinding } from './identity';

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

function recordingFetch(handler: (request: RecordedRequest) => Response | Promise<Response>) {
  const calls: RecordedRequest[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[name] = value;
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
    };
    calls.push(request);
    return handler(request);
  });
  return { calls, fetcher: fetcher as unknown as typeof fetch };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const publicProfile = {
  schemaVersion: 1,
  profileId: 'kp_alphaalphaalpha',
  username: 'Alice',
  avatar: { kind: 'chosen', value: 'harbor' },
  createdAt: '2026-10-20T10:00:00Z',
  updatedAt: '2026-10-20T10:05:00Z',
};

const ownProfile = {
  ...publicProfile,
  username: null,
  avatar: { kind: 'generated', value: 'kp_alphaalphaalpha' },
  guestLinks: [],
};

const ownershipProof = {
  schemaVersion: 1,
  proofId: 'kgp_proofproofproof',
  secret: 'kgp1_secretsecretsecret',
  matchId: 'match_alpha',
  seat: 'white',
  expiresAt: '2026-10-20T10:30:00Z',
};

const guestLink = {
  schemaVersion: 1,
  linkId: 'kl_linklinklink',
  profileId: 'kp_alphaalphaalpha',
  matchId: 'match_alpha',
  seat: 'white',
  linkedAt: '2026-10-20T10:15:00Z',
};

/** The account a binding acts for. */
function account(accountId: string, token: () => Promise<string> = async () => 'jwt'): ProfileAccountPort {
  return { accountId, token };
}

/** The guest seat a binding acts for. */
function guestSeat(issue: () => Promise<string> = async () => 'guest-secret'): ProfileGuestSeatPort {
  return { issue };
}

/** A binding and the tracker that owns it. */
function bindingFor(
  nextAccount: ProfileAccountPort | null,
  nextGuestSeat: ProfileGuestSeatPort | null = null,
): { binding: ProfileIdentityBinding; tracker: ReturnType<typeof createProfileIdentityTracker> } {
  const tracker = createProfileIdentityTracker();
  return { binding: tracker.update(nextAccount, nextGuestSeat), tracker };
}

describe('profile client', () => {
  it('reads a public profile without a credential', async () => {
    const { calls, fetcher } = recordingFetch(() => json(publicProfile));
    const { binding } = bindingFor(account('acct_alpha'));
    const client = createProfileClient({ baseUrl: 'https://service.example', identity: binding, fetch: fetcher });

    const profile = await client.readPublicProfile('kp_alphaalphaalpha');

    expect(profile.username).toBe('Alice');
    expect(calls).toHaveLength(1);
    expect(calls.at(0)?.url).toBe('https://service.example/v1/profiles/kp_alphaalphaalpha');
    expect(calls.at(0)?.headers.Authorization).toBeUndefined();
    expect(calls.at(0)?.headers['X-Guest-Seat-Token']).toBeUndefined();
  });

  it('looks a public name up without a credential', async () => {
    const { calls, fetcher } = recordingFetch(() => json(publicProfile));
    const { binding } = bindingFor(account('acct_alpha'));
    const client = createProfileClient({ baseUrl: 'https://service.example', identity: binding, fetch: fetcher });

    await client.readPublicProfileByUsername('Alice');

    expect(calls.at(0)?.url).toBe('https://service.example/v1/profiles/username/Alice');
    expect(calls.at(0)?.headers.Authorization).toBeUndefined();
  });

  it('reports a missing public name as a not found', async () => {
    const { fetcher } = recordingFetch(() => json({ error: 'not_found' }, 404));
    const { binding } = bindingFor(account('acct_alpha'));
    const client = createProfileClient({ baseUrl: 'https://service.example', identity: binding, fetch: fetcher });

    await expect(client.readPublicProfileByUsername('nobody')).rejects.toThrow(/No player uses that name/);
  });

  it('sends the account credential for an account route and never in the body', async () => {
    const { calls, fetcher } = recordingFetch(() => json(publicProfile));
    const { binding } = bindingFor(account('acct_alpha', async () => 'jwt-1'));
    const client = createProfileClient({ baseUrl: 'https://service.example', identity: binding, fetch: fetcher });

    await client.updateOwnProfile({ username: 'Alice' });

    expect(calls.at(0)?.method).toBe('PUT');
    expect(calls.at(0)?.headers.Authorization).toBe('Bearer jwt-1');
    expect(calls.at(0)?.body).toBe('{"username":"Alice"}');
    expect(calls.at(0)?.body).not.toContain('jwt-1');
  });

  it('reports a name that another profile already owns with the service code', async () => {
    const { fetcher } = recordingFetch(() => json({ error: 'username_taken' }, 409));
    const { binding } = bindingFor(account('acct_alpha'));
    const client = createProfileClient({ baseUrl: 'https://service.example', identity: binding, fetch: fetcher });

    const failure = await client.updateOwnProfile({ username: 'rookie' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProfileRequestError);
    expect((failure as ProfileRequestError).message).toMatch(/already taken/);
    expect((failure as ProfileRequestError).code).toBe('username_taken');
  });

  it('tells an already linked seat apart from a spent proof', async () => {
    const { fetcher } = recordingFetch(request => {
      if (request.url.endsWith('/v1/guest-seats/ownership-proof')) return json(ownershipProof);
      return json({ error: 'proof_already_used' }, 409);
    });
    const { binding } = bindingFor(account('acct_alpha'), guestSeat());
    const client = createProfileClient({ baseUrl: 'https://service.example', identity: binding, fetch: fetcher });

    const failure = await client.linkGuestSeat({ matchId: 'match_alpha', seat: 'white' }).catch((error: unknown) => error);
    expect((failure as ProfileRequestError).code).toBe('proof_already_used');
  });

  it('refuses to work without a signed-in account', async () => {
    const { calls, fetcher } = recordingFetch(() => json(ownProfile));
    const { binding } = bindingFor(null);
    const client = createProfileClient({ baseUrl: 'https://service.example', identity: binding, fetch: fetcher });

    await expect(client.readOwnProfile()).rejects.toThrow(/Sign in/);
    expect(calls).toHaveLength(0);
  });

  it('links a guest seat by proving the seat first and binding the proof second', async () => {
    const { calls, fetcher } = recordingFetch(request => {
      if (request.url.endsWith('/v1/guest-seats/ownership-proof')) return json(ownershipProof);
      return json(guestLink);
    });
    const { binding } = bindingFor(account('acct_alpha', async () => 'jwt-1'), guestSeat());
    const client = createProfileClient({ baseUrl: 'https://service.example', identity: binding, fetch: fetcher });

    const link = await client.linkGuestSeat({ matchId: 'match_alpha', seat: 'white' });

    expect(link.matchId).toBe('match_alpha');
    expect(calls).toHaveLength(2);
    expect(calls.at(0)?.headers['X-Guest-Seat-Token']).toBe('guest-secret');
    expect(calls.at(0)?.headers.Authorization).toBeUndefined();
    expect(calls.at(1)?.headers.Authorization).toBe('Bearer jwt-1');
    expect(calls.at(1)?.headers['X-Guest-Ownership-Proof']).toBe('kgp1_secretsecretsecret');
    expect(calls.at(1)?.body).toBe('{"matchId":"match_alpha","seat":"white"}');
  });

  it('carries the ownership proof beside the account credential without displacing it', async () => {
    const { calls, fetcher } = recordingFetch(request => {
      if (request.url.endsWith('/v1/guest-seats/ownership-proof')) return json(ownershipProof);
      return json(guestLink);
    });
    const { binding } = bindingFor(account('acct_alpha', async () => 'jwt-1'), guestSeat());
    const client = createProfileClient({ baseUrl: 'https://service.example', identity: binding, fetch: fetcher });

    await client.linkGuestSeat({ matchId: 'match_alpha', seat: 'white' });

    const headers = calls.at(1)?.headers ?? {};
    expect(Object.keys(headers).filter(name => name.toLowerCase() === 'authorization')).toHaveLength(1);
    expect(headers.Authorization).toBe('Bearer jwt-1');
  });

  it('refuses to link a seat the proof does not name', async () => {
    const { calls, fetcher } = recordingFetch(() => json({ ...ownershipProof, matchId: 'match_beta' }));
    const { binding } = bindingFor(account('acct_alpha'), guestSeat());
    const client = createProfileClient({ baseUrl: 'https://service.example', identity: binding, fetch: fetcher });

    await expect(client.linkGuestSeat({ matchId: 'match_alpha', seat: 'white' })).rejects.toThrow(/another seat/);
    expect(calls).toHaveLength(1);
  });

  it('refuses to link a guest seat when the browser holds no guest credential', async () => {
    const { calls, fetcher } = recordingFetch(() => json(publicProfile));
    const { binding } = bindingFor(account('acct_alpha'));
    const client = createProfileClient({ baseUrl: 'https://service.example', identity: binding, fetch: fetcher });

    await expect(client.linkGuestSeat({ matchId: 'match_alpha', seat: 'white' })).rejects.toThrow(/No guest seat/);
    expect(calls).toHaveLength(0);
  });

  it('keeps the request on the trusted origin and carries no cookie', async () => {
    const { calls, fetcher } = recordingFetch(() => json(publicProfile));
    const { binding } = bindingFor(account('acct_alpha'));
    const client = createProfileClient({ baseUrl: 'https://service.example', identity: binding, fetch: fetcher });

    await client.readPublicProfile('kp_alphaalphaalpha');

    expect(calls.at(0)?.url.startsWith('https://service.example/')).toBe(true);
  });

  it('refuses a base URL that is not a trusted service origin', () => {
    const { binding } = bindingFor(account('acct_alpha'));
    expect(() => createProfileClient({ baseUrl: 'http://service.example', identity: binding })).toThrow(/HTTPS/);
    expect(() => createProfileClient({ baseUrl: 'not a url', identity: binding })).toThrow(/invalid/);
    expect(() => createProfileClient({ baseUrl: '', identity: binding })).toThrow(/required/);
  });

  it('reports a failed request with its status', async () => {
    const { fetcher } = recordingFetch(() => json({ error: 'temporarily_unavailable' }, 503));
    const { binding } = bindingFor(account('acct_alpha'));
    const client = createProfileClient({ baseUrl: 'https://service.example', identity: binding, fetch: fetcher });

    const failure = await client.readPublicProfile('kp_alphaalphaalpha').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProfileRequestError);
    expect((failure as ProfileRequestError).status).toBe(503);
  });
});

describe('profile client identity fence', () => {
  it('cancels and unlocks a stalled response body when the account changes', async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"schemaVersion":1,')); },
      cancel: cancelled,
    });
    const { fetcher } = recordingFetch(() => new Response(body));
    const { binding } = bindingFor(account('acct_alpha'));
    const client = createProfileClient({ baseUrl: 'https://service.example', identity: binding, fetch: fetcher });

    const pending = client.readOwnProfile();
    await vi.waitFor(() => expect(body.locked).toBe(true));
    binding.abort();

    await expect(pending).rejects.toMatchObject({ code: 'account_changed' });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it('never sends a save under the account that replaced the one the call started under', async () => {
    const { calls, fetcher } = recordingFetch(() => json(publicProfile));
    let release: (() => void) | undefined;
    const token = new Promise<void>(resolve => { release = resolve; });
    const { binding } = bindingFor(account('acct_alpha', async () => {
      await token;
      return 'jwt-bravo';
    }));
    const client = createProfileClient({ baseUrl: 'https://service.example', identity: binding, fetch: fetcher });

    const pending = client.updateOwnProfile({ username: 'Bobby' });
    binding.abort();
    release?.();

    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProfileRequestError);
    expect((failure as ProfileRequestError).code).toBe('account_changed');
    expect(calls).toHaveLength(0);
  });

  it('discards a profile that answers after the account changed', async () => {
    let release: ((response: Response) => void) | undefined;
    const { fetcher } = recordingFetch(() => new Promise<Response>(resolve => { release = resolve; }));
    const { binding } = bindingFor(account('acct_alpha'));
    const client = createProfileClient({ baseUrl: 'https://service.example', identity: binding, fetch: fetcher });

    const pending = client.readOwnProfile();
    binding.abort();
    release?.(json(ownProfile));

    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProfileRequestError);
    expect((failure as ProfileRequestError).code).toBe('account_changed');
  });

  it('settles a pending call when the account changes', async () => {
    const { fetcher } = recordingFetch(() => json(ownProfile));
    const { binding } = bindingFor(account('acct_alpha', () => new Promise<string>(() => undefined)));
    const client = createProfileClient({ baseUrl: 'https://service.example', identity: binding, fetch: fetcher });

    const pending = client.readOwnProfile();
    binding.abort();

    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProfileRequestError);
    expect((failure as ProfileRequestError).code).toBe('account_changed');
  });

  it('never binds a proof that was minted under the previous account', async () => {
    const { calls, fetcher } = recordingFetch(request => {
      if (request.url.endsWith('/v1/guest-seats/ownership-proof')) return json(ownershipProof);
      return json(guestLink);
    });
    const { binding } = bindingFor(
      account('acct_alpha', async () => {
        // The account changed while the link was being authorized.
        binding.abort();
        return 'jwt-bravo';
      }),
      guestSeat(),
    );
    const client = createProfileClient({ baseUrl: 'https://service.example', identity: binding, fetch: fetcher });

    const failure = await client.linkGuestSeat({ matchId: 'match_alpha', seat: 'white' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProfileRequestError);
    expect((failure as ProfileRequestError).code).toBe('account_changed');
    // The proof was minted, but the link was never sent.
    expect(calls).toHaveLength(1);
    expect(calls.at(0)?.url).toContain('/v1/guest-seats/ownership-proof');
  });

  it('never sends a link when the guest seat changed under the call', async () => {
    const { calls, fetcher } = recordingFetch(request => {
      if (request.url.endsWith('/v1/guest-seats/ownership-proof')) return json(ownershipProof);
      return json(guestLink);
    });
    const { binding, tracker } = bindingFor(account('acct_alpha'), guestSeat());
    const client = createProfileClient({ baseUrl: 'https://service.example', identity: binding, fetch: fetcher });

    const pending = client.linkGuestSeat({ matchId: 'match_alpha', seat: 'white' });
    tracker.update(account('acct_alpha'), guestSeat(async () => 'other-secret'));

    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProfileRequestError);
    expect((failure as ProfileRequestError).code).toBe('account_changed');
    expect(calls.every(call => !call.url.includes('/v1/account/profile/guest-links'))).toBe(true);
  });

  it('keeps a healthy call of the same identity working', async () => {
    const { calls, fetcher } = recordingFetch(() => json(publicProfile));
    const tracker = createProfileIdentityTracker();
    const first = account('acct_alpha', async () => 'jwt-1');
    const binding = tracker.update(first, null);
    const client = createProfileClient({ baseUrl: 'https://service.example', identity: binding, fetch: fetcher });

    await client.updateOwnProfile({ username: 'Alice' });
    // The same identity reported again is not a new owner.
    expect(tracker.update(first, null)).toBe(binding);

    await client.updateOwnProfile({ username: 'Bobby' });
    expect(calls).toHaveLength(2);
    expect(calls.every(call => call.headers.Authorization === 'Bearer jwt-1')).toBe(true);
  });

  it('reports an expired account session as a sign-in on an account route', async () => {
    const { fetcher } = recordingFetch(() => json({ error: 'unauthorized' }, 401));
    const { binding } = bindingFor(account('acct_alpha'));
    const client = createProfileClient({ baseUrl: 'https://service.example', identity: binding, fetch: fetcher });

    const failure = await client.updateOwnProfile({ username: 'Bobby' }).catch((error: unknown) => error);
    expect((failure as ProfileRequestError).code).toBe('not_signed_in');
    expect((failure as ProfileRequestError).message).toMatch(/Sign in/);
  });

  it('keeps the guest seat refusal on the ownership proof route', async () => {
    const { fetcher } = recordingFetch(() => json({ error: 'unauthorized' }, 401));
    const { binding } = bindingFor(account('acct_alpha'), guestSeat());
    const client = createProfileClient({ baseUrl: 'https://service.example', identity: binding, fetch: fetcher });

    const failure = await client.mintOwnershipProof().catch((error: unknown) => error);
    expect((failure as ProfileRequestError).code).toBe('guest_seat_unauthorized');
  });

  it('does not claim which half of the link was refused', async () => {
    const { fetcher } = recordingFetch(request => {
      if (request.url.endsWith('/v1/guest-seats/ownership-proof')) return json(ownershipProof);
      return json({ error: 'unauthorized' }, 401);
    });
    const { binding } = bindingFor(account('acct_alpha'), guestSeat());
    const client = createProfileClient({ baseUrl: 'https://service.example', identity: binding, fetch: fetcher });

    const failure = await client.linkGuestSeat({ matchId: 'match_alpha', seat: 'white' }).catch((error: unknown) => error);
    expect((failure as ProfileRequestError).code).toBe('link_unauthorized');
    expect((failure as ProfileRequestError).message).not.toMatch(/guest seat is no longer yours/);
  });
});
