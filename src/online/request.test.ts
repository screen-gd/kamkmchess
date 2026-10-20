import { describe, expect, it, vi } from 'vitest';
import { OnlineAuthError, createGuestCredential, matchSeatScope } from './auth';
import type { GuestOnlineCredential } from './auth';
import { createAuthorizedRequester } from './request';
import { createParticipantSession } from './session';
import type { AccountIdentityPort } from './session';
import { createAccountSession } from '../accounts/clerk';

interface RecordedRequest {
  readonly url: string;
  readonly init: RequestInit;
  readonly headers: Record<string, string>;
}

function recordingFetch(handler?: (request: RecordedRequest) => Promise<Response> | Response) {
  const calls: RecordedRequest[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[name] = value;
    const request: RecordedRequest = { url: String(input), init: init ?? {}, headers };
    calls.push(request);
    return handler ? await handler(request) : new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { calls, fetcher: fetcher as unknown as typeof fetch };
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

function accountIdentity(accountId: string, token = 'jwt'): AccountIdentityPort {
  return { accountId, token: async () => token };
}

function guestSession() {
  const session = createParticipantSession({ accountSession: null });
  session.selectGuest(createGuestCredential({ guestId: 'guest_1', matchId: 'match_alpha', seat: 'white', token: 'guest-secret-token' }));
  return session;
}

/** The Node process handle, used to observe unhandled rejections. */
interface UnhandledRejectionHost {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
}

function unhandledRejectionHost(): UnhandledRejectionHost | null {
  return (globalThis as unknown as { process?: UnhandledRejectionHost }).process ?? null;
}

describe('authorized online requests', () => {
  it('mints a fresh credential for every request and never returns it to the caller', async () => {
    let issued = 0;
    const accountSession = accountSessionStub({
      accountId: 'user_2abcdefghijklmnop',
      token: async () => { issued += 1; return `jwt-${issued}`; },
    });
    const session = createParticipantSession({ accountSession });
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    const first = await requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/matches/match_alpha' });
    const second = await requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/matches/match_alpha' });

    expect(issued).toBe(2);
    expect(first.data).toEqual({ ok: true });
    expect(second.data).toEqual({ ok: true });
    expect(calls[0]?.headers.Authorization).toBe('Bearer jwt-1');
    expect(calls[1]?.headers.Authorization).toBe('Bearer jwt-2');
    expect(calls[0]?.url).toBe('https://service.example/v1/matches/match_alpha');
    expect(calls[0]?.url).not.toContain('jwt-1');
    expect(calls[0]?.init.credentials).toBe('omit');
    expect(calls[0]?.init.redirect).toBe('error');
    requester.dispose();
  });

  it('refuses a guest credential for another match or another seat', async () => {
    const session = guestSession();
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    await expect(requester.request(matchSeatScope('match_beta', 'white'), { path: '/v1/x' })).rejects.toThrow(OnlineAuthError);
    await expect(requester.request(matchSeatScope('match_alpha', 'black'), { path: '/v1/x' })).rejects.toThrow(/different match or seat/);
    expect(calls).toHaveLength(0);
    requester.dispose();
  });

  it('refuses a guest credential for an account-scoped request', async () => {
    const session = guestSession();
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });
    await expect(requester.request({ kind: 'account' }, { path: '/v1/account/games' })).rejects.toThrow(/account-scoped/);
    expect(calls).toHaveLength(0);
    requester.dispose();
  });

  it('keeps the guest credential off the Clerk bearer transport', async () => {
    const session = guestSession();
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });
    await requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' });
    expect(calls[0]?.headers.Authorization).toBeUndefined();
    expect(calls[0]?.headers['X-Guest-Seat-Token']).toBe('guest-secret-token');
    expect(calls[0]?.url).not.toContain('guest-secret-token');
    requester.dispose();
  });

  it('uses an explicit credential transport when the service owns the header names', async () => {
    const session = guestSession();
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({
      session,
      baseUrl: 'https://service.example',
      fetch: fetcher,
      guestTransport: (_credential, token) => ({ 'X-Online-Seat-Credential': token }),
    });
    await requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' });
    expect(calls[0]?.headers['X-Online-Seat-Credential']).toBe('guest-secret-token');
    expect(calls[0]?.headers.Authorization).toBeUndefined();
    expect(calls[0]?.headers['X-Guest-Seat-Token']).toBeUndefined();
    requester.dispose();
  });

  it('refuses an expired credential before anything is sent', async () => {
    const session = createParticipantSession({ accountSession: null });
    session.selectGuest(createGuestCredential({
      guestId: 'guest_1', matchId: 'match_alpha', seat: 'white', token: 'guest-secret-token', expiresAt: 1_000,
    }));
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher, now: () => 2_000 });
    await expect(requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' })).rejects.toThrow(/expired/);
    expect(calls).toHaveLength(0);
    requester.dispose();
  });

  it('refuses a credential that expires while it is being minted', async () => {
    let clock = 500;
    const session = createParticipantSession({ accountSession: null });
    const slowGuest: GuestOnlineCredential = {
      kind: 'guest',
      guestId: 'guest_1',
      matchId: 'match_alpha',
      seat: 'white',
      expiresAt: 1_000,
      issue: async () => { clock = 2_000; return 'guest-secret-token'; },
    };
    session.selectGuest(slowGuest);
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher, now: () => clock });

    await expect(requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' })).rejects.toThrow(/expired/);
    expect(calls).toHaveLength(0);
    requester.dispose();
  });

  it('refuses a credential that expires immediately before the request leaves', async () => {
    const readings = [500, 500, 2_000];
    let index = 0;
    const session = createParticipantSession({ accountSession: null });
    session.selectGuest(createGuestCredential({
      guestId: 'guest_1', matchId: 'match_alpha', seat: 'white', token: 'guest-secret-token', expiresAt: 1_000,
    }));
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({
      session,
      baseUrl: 'https://service.example',
      fetch: fetcher,
      now: () => readings[Math.min(index++, readings.length - 1)] ?? 500,
    });

    await expect(requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' })).rejects.toThrow(/expired/);
    expect(calls).toHaveLength(0);
    requester.dispose();
  });

  it('cancels an in-flight request when the signed-in identity changes', async () => {
    const accountSession = accountSessionStub(accountIdentity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const { calls, fetcher } = recordingFetch(() => new Promise<Response>(() => {}));
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    const pending = requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    accountSession.emit(accountIdentity('user_3qrstuvwxyzabcdef'));
    expect(calls[0]?.init.signal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow(/participant session changed/);
    requester.dispose();
  });

  it('cancels an in-flight request when the same account is replaced by a new session', async () => {
    const accountSession = accountSessionStub(accountIdentity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const { calls, fetcher } = recordingFetch(() => new Promise<Response>(() => {}));
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    const pending = requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    accountSession.emit(accountIdentity('user_2abcdefghijklmnop', 'jwt-new'));
    await expect(pending).rejects.toThrow(/participant session changed/);
    requester.dispose();
  });

  it('cancels a request whose credential never resolves', async () => {
    let requested = false;
    const accountSession = accountSessionStub({
      accountId: 'user_2abcdefghijklmnop',
      token: () => {
        requested = true;
        return new Promise<string>(() => {});
      },
    });
    const session = createParticipantSession({ accountSession });
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    const pending = requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' });
    await vi.waitFor(() => expect(requested).toBe(true));
    accountSession.emit(accountIdentity('user_3qrstuvwxyzabcdef'));
    await expect(pending).rejects.toThrow(/participant session changed/);
    expect(calls).toHaveLength(0);
    requester.dispose();
  });

  it('cancels a request whose credential never resolves when the caller aborts', async () => {
    let requested = false;
    const accountSession = accountSessionStub({
      accountId: 'user_2abcdefghijklmnop',
      token: () => {
        requested = true;
        return new Promise<string>(() => {});
      },
    });
    const session = createParticipantSession({ accountSession });
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });
    const controller = new AbortController();

    const pending = requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x', signal: controller.signal });
    await vi.waitFor(() => expect(requested).toBe(true));
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(calls).toHaveLength(0);
    requester.dispose();
  });

  it('ignores a token that resolves after the identity changed', async () => {
    let resolveToken!: (token: string) => void;
    const accountSession = accountSessionStub({
      accountId: 'user_2abcdefghijklmnop',
      token: () => new Promise<string>((resolve) => { resolveToken = resolve; }),
    });
    const session = createParticipantSession({ accountSession });
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    const pending = requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' });
    await vi.waitFor(() => expect(resolveToken).toBeTypeOf('function'));
    accountSession.emit(accountIdentity('user_3qrstuvwxyzabcdef'));
    resolveToken('jwt-late');
    await expect(pending).rejects.toThrow(/participant session changed/);
    expect(calls).toHaveLength(0);
    requester.dispose();
  });

  it('ignores a late response that arrives after the identity changed', async () => {
    let release!: (response: Response) => void;
    const accountSession = accountSessionStub(accountIdentity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const { calls, fetcher } = recordingFetch(() => new Promise<Response>((resolve) => { release = resolve; }));
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    const pending = requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    accountSession.emit(accountIdentity('user_3qrstuvwxyzabcdef'));
    release(new Response('{"ok":true}', { status: 200 }));
    await expect(pending).rejects.toThrow(/participant session changed/);
    requester.dispose();
  });

  it('ignores a late body that resolves after the identity changed', async () => {
    let releaseBody!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        releaseBody = () => {
          // Cancellation can close the source before this late delivery.
          try {
            controller.enqueue(new TextEncoder().encode('{"ok":true}'));
            controller.close();
          } catch { /* the source was cancelled */ }
        };
      },
    });
    const accountSession = accountSessionStub(accountIdentity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const { calls, fetcher } = recordingFetch(() => Promise.resolve(new Response(body, { status: 200 })));

    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    const pending = requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    accountSession.emit(accountIdentity('user_3qrstuvwxyzabcdef'));
    releaseBody();
    await expect(pending).rejects.toThrow(/participant session changed/);
    requester.dispose();
  });

  it('cancels an in-flight request when the participant credential is removed', async () => {
    const accountSession = accountSessionStub(accountIdentity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const { calls, fetcher } = recordingFetch(() => new Promise<Response>(() => {}));
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    const pending = requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    session.clear();
    await expect(pending).rejects.toThrow(/credential was removed/);
    requester.dispose();
  });

  it('refuses a request after the participant credential was removed', async () => {
    const accountSession = accountSessionStub(accountIdentity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });
    session.clear();
    await expect(requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' })).rejects.toThrow(/no longer available/);
    expect(calls).toHaveLength(0);
    requester.dispose();
  });

  it('cancels in-flight requests when the client is disposed', async () => {
    const accountSession = accountSessionStub(accountIdentity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const { calls, fetcher } = recordingFetch(() => new Promise<Response>(() => {}));
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    const pending = requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    requester.dispose();
    expect(calls[0]?.init.signal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow(/disposed/);
  });

  it('aborts when the caller cancels the request', async () => {
    const accountSession = accountSessionStub(accountIdentity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const { calls, fetcher } = recordingFetch(() => new Promise<Response>(() => {}));
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });
    const controller = new AbortController();

    const pending = requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x', signal: controller.signal });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    requester.dispose();
  });

  it('never puts a credential in a URL', async () => {
    const accountSession = accountSessionStub(accountIdentity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    await expect(requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x?token=abc' })).rejects.toThrow(/must not carry/);
    await expect(requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x?cursor=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature' })).rejects.toThrow(/credential-shaped/);
    expect(calls).toHaveLength(0);
    requester.dispose();
  });

  it('requires a trusted service base URL', () => {
    const session = createParticipantSession({ accountSession: null });
    expect(() => createAuthorizedRequester({ session, baseUrl: '' })).toThrow(/base URL is required/);
    expect(() => createAuthorizedRequester({ session, baseUrl: '   ' })).toThrow(/base URL is required/);
    expect(() => createAuthorizedRequester({ session, baseUrl: 'not a url' })).toThrow(/base URL is invalid/);
    expect(() => createAuthorizedRequester({ session, baseUrl: 'https://user:pass@service.example' })).toThrow(/base URL is invalid/);
  });

  it('refuses a remote service base URL that is not HTTPS', () => {
    const session = createParticipantSession({ accountSession: null });
    expect(() => createAuthorizedRequester({ session, baseUrl: 'http://service.example' })).toThrow(/HTTPS/);
  });

  it('allows a loopback service base URL over HTTP for local development', async () => {
    const session = guestSession();
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({ session, baseUrl: 'http://127.0.0.1:8080', fetch: fetcher });
    await requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' });
    expect(calls[0]?.url).toBe('http://127.0.0.1:8080/v1/x');
    requester.dispose();
  });

  it('refuses to send a credential outside the trusted origin', async () => {
    const accountSession = accountSessionStub(accountIdentity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    await expect(requester.request(matchSeatScope('match_alpha', 'white'), { path: 'https://other.example/v1/x' })).rejects.toThrow(/trusted service origin|service origin/);
    await expect(requester.request(matchSeatScope('match_alpha', 'white'), { path: 'https://user:pass@service.example/v1/x' })).rejects.toThrow(/must not carry credentials/);
    expect(calls).toHaveLength(0);
    requester.dispose();
  });

  it('refuses a foreign or exotic destination before a credential is minted', async () => {
    let issued = 0;
    const accountSession = accountSessionStub({
      accountId: 'user_2abcdefghijklmnop',
      token: async () => { issued += 1; return 'jwt-a'; },
    });
    const session = createParticipantSession({ accountSession });
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    await expect(requester.request(matchSeatScope('match_alpha', 'white'), { path: 'https://other.example/v1/x' })).rejects.toThrow(/trusted service origin/);
    await expect(requester.request(matchSeatScope('match_alpha', 'white'), { path: '//other.example/v1/x' })).rejects.toThrow(/trusted service origin/);
    await expect(requester.request(matchSeatScope('match_alpha', 'white'), { path: 'javascript:alert(1)' })).rejects.toThrow(/HTTP or HTTPS/);
    await expect(requester.request(matchSeatScope('match_alpha', 'white'), { path: 'file:///etc/passwd' })).rejects.toThrow(/HTTP or HTTPS/);
    await expect(requester.request(matchSeatScope('match_alpha', 'white'), { path: 'https://user:pass@service.example/v1/x' })).rejects.toThrow(/must not carry credentials/);
    expect(issued).toBe(0);
    expect(calls).toHaveLength(0);
    requester.dispose();
  });

  it('refuses a caller header that collides with the credential slot', async () => {
    const accountSession = accountSessionStub(accountIdentity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    await expect(requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x', headers: { Authorization: 'Bearer stale' } })).rejects.toThrow(/owned by the participant credential/);
    await expect(requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x', headers: { authorization: 'Bearer stale' } })).rejects.toThrow(/owned by the participant credential/);
    expect(calls).toHaveLength(0);
    requester.dispose();
  });

  it('refuses a stale bearer header next to a guest seat credential', async () => {
    const session = guestSession();
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    await expect(requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x', headers: { Authorization: 'Bearer stale' } })).rejects.toThrow(/owned by the participant credential/);
    expect(calls).toHaveLength(0);
    requester.dispose();
  });

  it('refuses a caller header that collides with the guest credential slot', async () => {
    const session = guestSession();
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    await expect(requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x', headers: { 'x-guest-seat-token': 'stale' } })).rejects.toThrow(/owned by the participant credential/);
    expect(calls).toHaveLength(0);
    requester.dispose();
  });

  it('refuses a guest transport that rides the account bearer transport', async () => {
    const session = guestSession();
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({
      session,
      baseUrl: 'https://service.example',
      fetch: fetcher,
      guestTransport: (_credential, token) => ({ Authorization: token }),
    });
    await expect(requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' })).rejects.toThrow(/never ride the account bearer transport/);
    expect(calls).toHaveLength(0);
    requester.dispose();
  });

  it('refuses a transport that produces an empty credential header', async () => {
    const session = guestSession();
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({
      session,
      baseUrl: 'https://service.example',
      fetch: fetcher,
      guestTransport: () => ({ 'X-Guest-Seat-Token': '' }),
    });
    await expect(requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' })).rejects.toThrow(/empty credential header/);
    expect(calls).toHaveLength(0);
    requester.dispose();
  });

  it('refuses an empty participant credential', async () => {
    const session = createParticipantSession({ accountSession: null });
    session.selectGuest({
      kind: 'guest',
      guestId: 'guest_1',
      matchId: 'match_alpha',
      seat: 'white',
      issue: async () => '   ',
    });
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });
    await expect(requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' })).rejects.toThrow(/credential is empty/);
    expect(calls).toHaveLength(0);
    requester.dispose();
  });

  it('refuses a transport that produces more than one credential header', async () => {
    const session = guestSession();
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({
      session,
      baseUrl: 'https://service.example',
      fetch: fetcher,
      guestTransport: (_credential, token) => ({ 'X-Guest-Seat-Token': token, 'X-Other-Token': token }),
    });
    await expect(requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' })).rejects.toThrow(/exactly one credential header/);
    expect(calls).toHaveLength(0);
    requester.dispose();
  });

  it('refuses an account transport that does not use the bearer slot', async () => {
    const accountSession = accountSessionStub(accountIdentity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const { calls, fetcher } = recordingFetch();
    const requester = createAuthorizedRequester({
      session,
      baseUrl: 'https://service.example',
      fetch: fetcher,
      accountTransport: (_credential, token) => ({ 'X-Account-Token': token }),
    });
    await expect(requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' })).rejects.toThrow(/must ride the account bearer transport/);
    expect(calls).toHaveLength(0);
    requester.dispose();
  });

  it('renews a stream with a fresh credential and rechecks the scope', async () => {
    let issued = 0;
    const accountSession = accountSessionStub({
      accountId: 'user_2abcdefghijklmnop',
      token: async () => { issued += 1; return `jwt-${issued}`; },
    });
    const session = createParticipantSession({ accountSession });
    const { calls, fetcher } = recordingFetch(() => new Response('', { status: 200 }));
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    const stream = await requester.open(matchSeatScope('match_alpha', 'white'), { path: '/v1/stream' });
    expect(stream.signal.aborted).toBe(false);
    const renewed = await stream.renew();
    expect(issued).toBe(2);
    expect(calls[0]?.headers.Authorization).toBe('Bearer jwt-1');
    expect(calls[1]?.headers.Authorization).toBe('Bearer jwt-2');
    expect(renewed.scope).toEqual({ kind: 'match-seat', matchId: 'match_alpha', seat: 'white' });
    stream.close();
    renewed.close();
    requester.dispose();
  });

  it('releases the stream that a renewal replaces', async () => {
    let cancelledBodies = 0;
    const accountSession = accountSessionStub(accountIdentity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const { calls, fetcher } = recordingFetch(() => {
      const body = new ReadableStream<Uint8Array>({ cancel() { cancelledBodies += 1; } });
      return new Response(body, { status: 200 });
    });
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    const stream = await requester.open(matchSeatScope('match_alpha', 'white'), { path: '/v1/stream' });
    const firstSignal = stream.signal;
    const renewed = await stream.renew();

    expect(calls).toHaveLength(2);
    expect(firstSignal.aborted).toBe(true);
    expect(cancelledBodies).toBe(1);
    expect(renewed.signal.aborted).toBe(false);
    expect(stream.renew).toBeTypeOf('function');
    await expect(stream.renew()).rejects.toThrow(/closed/);
    renewed.close();
    requester.dispose();
  });

  it('keeps the current stream when a renewal fails', async () => {
    let attempts = 0;
    const accountSession = accountSessionStub(accountIdentity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const { fetcher } = recordingFetch(() => {
      attempts += 1;
      if (attempts === 1) return new Response('', { status: 200 });
      throw new Error('the service is unreachable');
    });
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    const stream = await requester.open(matchSeatScope('match_alpha', 'white'), { path: '/v1/stream' });
    await expect(stream.renew()).rejects.toThrow(/unreachable/);
    expect(stream.signal.aborted).toBe(false);
    stream.close();
    requester.dispose();
  });

  it('cancels an in-flight renewal when the stream is closed', async () => {
    let attempts = 0;
    const accountSession = accountSessionStub(accountIdentity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const { calls, fetcher } = recordingFetch(() => {
      attempts += 1;
      if (attempts === 1) return new Response('', { status: 200 });
      return new Promise<Response>(() => {});
    });
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    const stream = await requester.open(matchSeatScope('match_alpha', 'white'), { path: '/v1/stream' });
    const renewal = stream.renew();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    stream.close();
    await expect(renewal).rejects.toThrow(/cancelled/);
    requester.dispose();
  });

  it('aborts an open stream when the participant session changes', async () => {
    const accountSession = accountSessionStub(accountIdentity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const { fetcher } = recordingFetch(() => new Response('', { status: 200 }));
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    const stream = await requester.open(matchSeatScope('match_alpha', 'white'), { path: '/v1/stream' });
    accountSession.emit(accountIdentity('user_3qrstuvwxyzabcdef'));
    expect(stream.signal.aborted).toBe(true);
    await expect(stream.renew()).rejects.toThrow(/participant session changed/);
    requester.dispose();
  });

  it('detaches the caller signal when an open stream loses its participant', async () => {
    const session = createParticipantSession();
    session.selectGuest(createGuestCredential({ guestId: 'guest_1', matchId: 'match_alpha', seat: 'white', token: 'guest-secret-token' }));
    const external = new AbortController();
    const removed = vi.spyOn(external.signal, 'removeEventListener');
    const { fetcher } = recordingFetch(() => new Response(new ReadableStream<Uint8Array>(), { status: 200 }));
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });
    const stream = await requester.open(matchSeatScope('match_alpha', 'white'), { path: '/v1/stream', signal: external.signal });

    session.clear();
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    await expect(stream.renew()).rejects.toMatchObject({ code: 'credential-cleared' });
    requester.dispose();
  });

  it('cancels the underlying JSON body when its participant is removed', async () => {
    const session = createParticipantSession();
    session.selectGuest(createGuestCredential({ guestId: 'guest_1', matchId: 'match_alpha', seat: 'white', token: 'guest-secret-token' }));
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const { calls, fetcher } = recordingFetch(() => new Response(body, { status: 200 }));
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });
    const pending = requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await vi.waitFor(() => expect(body.locked).toBe(true));

    session.clear();
    await expect(pending).rejects.toMatchObject({ code: 'credential-cleared' });
    expect(cancelled).toHaveBeenCalledOnce();
    requester.dispose();
  });

  it('releases an open stream when the client is disposed', async () => {
    let cancelledBodies = 0;
    const accountSession = accountSessionStub(accountIdentity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const { fetcher } = recordingFetch(() => {
      const body = new ReadableStream<Uint8Array>({ cancel() { cancelledBodies += 1; } });
      return new Response(body, { status: 200 });
    });
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    const stream = await requester.open(matchSeatScope('match_alpha', 'white'), { path: '/v1/stream' });
    requester.dispose();
    expect(stream.signal.aborted).toBe(true);
    await vi.waitFor(() => expect(cancelledBodies).toBe(1));
  });

  it('never delivers a chunk that arrives after the participant session changed', async () => {
    const encoder = new TextEncoder();
    let push!: (text: string) => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('first'));
        push = (text) => {
          try { controller.enqueue(encoder.encode(text)); } catch { /* the body was already released */ }
        };
      },
    });
    const accountSession = accountSessionStub(accountIdentity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const { fetcher } = recordingFetch(() => new Response(body, { status: 200 }));
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    const stream = await requester.open(matchSeatScope('match_alpha', 'white'), { path: '/v1/stream' });
    const reader = stream.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('first');

    // The transport ignores the abort and keeps pushing. The consumer must
    // never see data that belongs to a response that was already cancelled.
    accountSession.emit(accountIdentity('user_3qrstuvwxyzabcdef'));
    push('late');
    await expect(reader.read()).rejects.toThrow(/participant session changed/);
    requester.dispose();
  });

  it('fails the fenced body when the client is disposed', async () => {
    const accountSession = accountSessionStub(accountIdentity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const { fetcher } = recordingFetch(() => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }));
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    const stream = await requester.open(matchSeatScope('match_alpha', 'white'), { path: '/v1/stream' });
    const reader = stream.body!.getReader();
    const pendingRead = reader.read();
    requester.dispose();

    const failure = await Promise.race([
      pendingRead.then(() => null, (error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve(null), 250)),
    ]);
    expect(failure).toBeInstanceOf(OnlineAuthError);
    expect((failure as OnlineAuthError).code).toBe('disposed');
  });

  it('releases a response that arrives after the request was cancelled', async () => {
    let cancelledBodies = 0;
    let release!: (response: Response) => void;
    const accountSession = accountSessionStub(accountIdentity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const { calls, fetcher } = recordingFetch(() => new Promise<Response>((resolve) => { release = resolve; }));
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    const pending = requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    accountSession.emit(accountIdentity('user_3qrstuvwxyzabcdef'));
    release(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelledBodies += 1; } }), { status: 200 }));

    await expect(pending).rejects.toThrow(/participant session changed/);
    // The late response owns an open body: it must be released, not left
    // dangling behind a cancelled call.
    await vi.waitFor(() => expect(cancelledBodies).toBe(1));
    requester.dispose();
  });

  it('releases the response body when the consumer already locked the stream', async () => {
    let cancelledBodies = 0;
    const accountSession = accountSessionStub(accountIdentity('user_2abcdefghijklmnop'));
    const session = createParticipantSession({ accountSession });
    const { fetcher } = recordingFetch(() => {
      const body = new ReadableStream<Uint8Array>({ cancel() { cancelledBodies += 1; } });
      return new Response(body, { status: 200 });
    });
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    const stream = await requester.open(matchSeatScope('match_alpha', 'white'), { path: '/v1/stream' });
    const reader = stream.body!.getReader();
    stream.close();

    // The consumer locked the body, so a plain body cancel is impossible.
    await vi.waitFor(() => expect(cancelledBodies).toBe(1));
    await expect(reader.read()).resolves.toMatchObject({ done: true });
    requester.dispose();
  });

  it('handles a transport that fails after the request was cancelled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    const host = unhandledRejectionHost();
    host?.on('unhandledRejection', onUnhandled);
    try {
      let release!: (error: Error) => void;
      const accountSession = accountSessionStub(accountIdentity('user_2abcdefghijklmnop'));
      const session = createParticipantSession({ accountSession });
      const { calls, fetcher } = recordingFetch(() => new Promise<Response>((_resolve, reject) => { release = reject; }));
      const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

      const pending = requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      accountSession.emit(accountIdentity('user_3qrstuvwxyzabcdef'));
      release(new Error('the transport failed late'));

      await expect(pending).rejects.toThrow(/participant session changed/);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      requester.dispose();
    } finally {
      host?.off('unhandledRejection', onUnhandled);
    }
  });

  it('cancels a pending request when the Clerk account session is disposed', async () => {
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
    const { calls, fetcher } = recordingFetch(() => new Promise<Response>(() => {}));
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });

    const pending = requester.request(matchSeatScope('match_alpha', 'white'), { path: '/v1/x' });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    accountSession.dispose();

    const outcome = await Promise.race([
      pending.then(() => 'resolved', () => 'rejected'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 250)),
    ]);
    expect(outcome).toBe('rejected');
    requester.dispose();
  });
});
