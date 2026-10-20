/**
 * Client for the public profile service (KHA-72).
 *
 * The client has two kinds of call, and they never mix:
 *
 * - a **public read**, which needs no credential at all. A signed-out visitor
 *   can read a public profile and look a public name up. A public read names
 *   no owner, so it is not fenced by the identity binding.
 * - an **account call**, which needs the verified session of the signed-in
 *   account. The account is never named in a request body: the service takes
 *   it from the credential it verified.
 *
 * Every credentialed call is bound to the identity it started under. The
 * binding names the account and the guest seat, and its signal fires when
 * either of them changes. Each asynchronous stage checks the binding again:
 * a token minted for a replaced account is discarded, a request that has not
 * left the browser is never sent, and a response that arrives too late is
 * released instead of published. A call whose account changed is settled
 * with `account_changed`; it never carries the answer of another account.
 *
 * The guest link is a deliberate two-step action. The browser first proves
 * that it controls a guest seat by minting an ownership proof from the seat
 * credential, and then it binds that proof to the account. Signing in never
 * performs either step on its own.
 *
 * Every credential travels in a request header only. It never enters a URL, a
 * query string, or a request body, and the destination is checked against the
 * trusted service origin before a credential is minted.
 */
import {
  PROFILE_AVATAR_CHOICES,
  createProfileUpdateBody,
  parseGuestLink,
  parseGuestOwnershipProof,
  parsePublicProfile,
  parseOwnProfile,
} from './contracts';
import type { GuestOwnershipProof, OwnProfile, ProfileGuestLink, ProfileUpdate, PublicProfile } from './contracts';
import type { ProfileIdentityBinding } from './identity';

/** The seat a guest seat credential is bound to. */
export type ProfileSeat = 'white' | 'black';

/** A guest seat this browser controls. */
export interface GuestSeatBinding {
  readonly matchId: string;
  readonly seat: ProfileSeat;
}

export interface ProfileClientOptions {
  /** The trusted service origin. A credential is never sent outside it. */
  readonly baseUrl: string;
  /**
   * The account and the guest seat this client acts for.
   *
   * The binding is the fence of the whole slice. Every credentialed stage of
   * a call checks it, so a call that started under one account is settled
   * and discarded instead of publishing under another.
   */
  readonly identity: ProfileIdentityBinding;
  readonly fetch?: typeof fetch;
}

export interface ProfileClient {
  /** Reads one public profile. It works without signing in. */
  readPublicProfile(profileId: string): Promise<PublicProfile>;
  /** Looks a public name up. It works without signing in. */
  readPublicProfileByUsername(username: string): Promise<PublicProfile>;
  /** Reads the signed-in account's own profile. */
  readOwnProfile(): Promise<OwnProfile>;
  /** Applies an ownership-checked change to the signed-in account's profile. */
  updateOwnProfile(update: ProfileUpdate): Promise<PublicProfile>;
  /** Mints a guest ownership proof from the guest seat credential. */
  mintOwnershipProof(): Promise<GuestOwnershipProof>;
  /** Binds a guest seat to the signed-in account with a fresh ownership proof. */
  linkGuestSeat(seat: GuestSeatBinding): Promise<ProfileGuestLink>;
}

/** The catalog of chosen avatars, for an interface that offers the choice. */
export const PROFILE_AVATARS = PROFILE_AVATAR_CHOICES;

/** The header the account session token travels in. */
const ACCOUNT_CREDENTIAL_HEADER = 'Authorization';
/** The header the private guest seat credential travels in. */
const GUEST_CREDENTIAL_HEADER = 'X-Guest-Seat-Token';
/** The header the guest ownership proof travels in. */
const GUEST_PROOF_HEADER = 'X-Guest-Ownership-Proof';

export function createProfileClient(options: ProfileClientOptions): ProfileClient {
  const base = parseBaseUrl(options.baseUrl);
  const fetcher = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const identity = options.identity;

  /**
   * The refusal of a call whose account changed under it.
   *
   * The code is one of the client's own, so the interface never mistakes it
   * for a refusal by the service.
   */
  function accountChanged(): ProfileRequestError {
    return new ProfileRequestError('The signed-in account changed.', 409, 'account_changed');
  }

  /** Refuses a call that no longer belongs to the active account. */
  function assertLive(): void {
    if (identity.signal.aborted) throw accountChanged();
  }

  /**
   * Settles a stage as soon as the account changes.
   *
   * The work keeps running when the transport ignores the abort signal, but
   * its answer has nowhere to land: the caller is settled with the fence,
   * and the late result is dropped.
   */
  async function fenced<T>(work: Promise<T>): Promise<T> {
    const signal = identity.signal;
    if (signal.aborted) {
      void work.catch(() => undefined);
      throw accountChanged();
    }
    let onAbort: (() => void) | undefined;
    try {
      const result = await new Promise<T>((resolve, reject) => {
        onAbort = () => { reject(accountChanged()); };
        signal.addEventListener('abort', onAbort, { once: true });
        work.then(
          (value) => { resolve(value); },
          (error: unknown) => { reject(signal.aborted ? accountChanged() : error); },
        );
      });
      assertLive();
      return result;
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  async function readCredentialedBody(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) { assertLive(); return ''; }
    const decoder = new TextDecoder();
    let text = '';
    try {
      assertLive();
      for (;;) {
        const chunk = await fenced(reader.read());
        if (chunk.done) return text + decoder.decode();
        text += decoder.decode(chunk.value, { stream: true });
      }
    } catch (error) {
      // The boundary owns this reader, so cancellation also releases a body
      // whose transport ignored the identity's abort signal.
      void reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Builds the request headers.
   *
   * The credential header slot belongs to the boundary. The caller headers
   * are applied first and the credential is written last, so a caller header
   * can never replace the credential or add a second spelling of it. The only
   * caller header is the ownership proof, and its name is fixed.
   */
  function buildHeaders(init: {
    credential?: { kind: 'account' | 'guest'; token: string };
    proof?: string;
  }): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (init.proof !== undefined) headers[GUEST_PROOF_HEADER] = init.proof;
    if (init.credential) {
      if (init.credential.kind === 'account') headers[ACCOUNT_CREDENTIAL_HEADER] = `Bearer ${init.credential.token}`;
      else headers[GUEST_CREDENTIAL_HEADER] = init.credential.token;
    }
    return headers;
  }

  async function request(
    path: string,
    init: { method?: string; body?: unknown; credential?: { kind: 'account' | 'guest'; token: string }; proof?: string } = {},
  ): Promise<{ status: number; data: unknown }> {
    const url = resolveUrl(base, path);
    const guarded = init.credential !== undefined;
    const headers = buildHeaders(init);
    const requestInit: RequestInit = {
      method: init.method ?? 'GET',
      headers,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    };
    if (guarded) {
      // The transport may honour the signal; the fence below does not depend
      // on it, so a late response is still discarded.
      requestInit.signal = identity.signal;
      assertLive();
    }
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      requestInit.body = JSON.stringify(init.body);
    }
    const pending = Promise.resolve(fetcher(url, requestInit));
    let response: Response;
    try {
      response = guarded ? await fenced(pending) : await pending;
    } catch (error) {
      // The transport may ignore the abort and still deliver a response. That
      // late response owns an open body, so it is released instead of being
      // left behind a cancelled call.
      void pending.then((late) => { void late.body?.cancel().catch(() => undefined); }, () => undefined);
      throw error;
    }
    let text: string;
    try {
      text = guarded
        ? await readCredentialedBody(response)
        : await response.text();
    } catch (error) {
      // A body that was released too late is not left open.
      void response.body?.cancel().catch(() => undefined);
      throw error;
    }
    let data: unknown = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        throw new ProfileRequestError('The profile service returned an invalid response.', response.status);
      }
    }
    if (guarded) assertLive();
    return { status: response.status, data };
  }

  /**
   * Runs an account call.
   *
   * The token is minted under the bound account and checked against the
   * binding again before it is used, so a token that belongs to a replaced
   * account is discarded instead of being sent.
   */
  async function accountRequest(
    path: string,
    init: { method?: string; body?: unknown; proof?: string } = {},
  ): Promise<{ status: number; data: unknown }> {
    const account = identity.account;
    if (!account) throw new ProfileRequestError('Sign in to edit your profile.', 401, 'not_signed_in');
    assertLive();
    let token: string;
    try {
      token = await fenced(account.token());
    } catch (error) {
      if (identity.signal.aborted) throw accountChanged();
      if (error instanceof ProfileRequestError) throw error;
      // The account refused to mint a token, so the session is gone.
      throw new ProfileRequestError('Sign in to edit your profile.', 401, 'not_signed_in');
    }
    // The token is discarded when the account changed while it was minted.
    assertLive();
    if (typeof token !== 'string' || token.trim() === '') {
      throw new ProfileRequestError('Sign in to edit your profile.', 401, 'not_signed_in');
    }
    return request(path, { ...init, credential: { kind: 'account', token } });
  }

  /** Mints an ownership proof from the guest seat credential of this browser. */
  async function mintOwnershipProof(): Promise<GuestOwnershipProof> {
    const guestSeat = identity.guestSeat;
    if (!guestSeat) throw new ProfileRequestError('No guest seat is open in this browser.', 400, 'no_guest_seat');
    assertLive();
    let token: string;
    try {
      token = await fenced(guestSeat.issue());
    } catch (error) {
      if (identity.signal.aborted) throw accountChanged();
      if (error instanceof ProfileRequestError) throw error;
      throw new ProfileRequestError('No guest seat is open in this browser.', 400, 'no_guest_seat');
    }
    assertLive();
    if (typeof token !== 'string' || token.trim() === '') {
      throw new ProfileRequestError('No guest seat is open in this browser.', 400, 'no_guest_seat');
    }
    const result = await request('/v1/guest-seats/ownership-proof', {
      method: 'POST',
      credential: { kind: 'guest', token },
    });
    assertLive();
    if (result.status === 401) throw new ProfileRequestError('That guest seat is no longer yours.', 401, 'guest_seat_unauthorized');
    if (result.status !== 200) throw new ProfileRequestError('The profile service is unavailable.', result.status, errorCode(result.data));
    return parseGuestOwnershipProof(result.data);
  }

  return {
    async readPublicProfile(profileId) {
      const result = await request(`/v1/profiles/${encodeURIComponent(profileId)}`);
      if (result.status === 404) throw new ProfileRequestError('That profile does not exist.', 404, errorCode(result.data));
      if (result.status !== 200) throw new ProfileRequestError('The profile service is unavailable.', result.status, errorCode(result.data));
      return parsePublicProfile(result.data);
    },
    async readPublicProfileByUsername(username) {
      const result = await request(`/v1/profiles/username/${encodeURIComponent(username.trim())}`);
      if (result.status === 404) throw new ProfileRequestError('No player uses that name.', 404, errorCode(result.data));
      if (result.status !== 200) throw new ProfileRequestError('The profile service is unavailable.', result.status, errorCode(result.data));
      return parsePublicProfile(result.data);
    },
    async readOwnProfile() {
      const result = await accountRequest('/v1/account/profile');
      assertLive();
      if (result.status === 401) throw new ProfileRequestError('Sign in to edit your profile.', 401, 'not_signed_in');
      if (result.status !== 200) throw new ProfileRequestError('The profile service is unavailable.', result.status, errorCode(result.data));
      return parseOwnProfile(result.data);
    },
    async updateOwnProfile(update) {
      const result = await accountRequest('/v1/account/profile', { method: 'PUT', body: createProfileUpdateBody(update) });
      assertLive();
      if (result.status === 401) throw new ProfileRequestError('Sign in to edit your profile.', 401, 'not_signed_in');
      if (result.status === 409) throw new ProfileRequestError('That name is already taken.', 409, errorCode(result.data));
      if (result.status === 400) throw new ProfileRequestError('That name or avatar is not allowed.', 400, errorCode(result.data));
      if (result.status !== 200) throw new ProfileRequestError('The profile service is unavailable.', result.status, errorCode(result.data));
      return parsePublicProfile(result.data);
    },
    mintOwnershipProof,
    async linkGuestSeat(seat) {
      assertLive();
      // The proof is minted from the seat credential first, so the link never
      // runs on a shareable invitation.
      const proof = await mintOwnershipProof();
      // The proof belongs to the account that was active when it was minted.
      assertLive();
      if (proof.matchId !== seat.matchId || proof.seat !== seat.seat) {
        throw new ProfileRequestError('That proof names another seat.', 409, 'proof_seat_mismatch');
      }
      const result = await accountRequest('/v1/account/profile/guest-links', {
        method: 'POST',
        body: { matchId: seat.matchId, seat: seat.seat },
        proof: proof.secret,
      });
      assertLive();
      if (result.status === 409) throw new ProfileRequestError('That guest seat is already linked.', 409, errorCode(result.data));
      // The link route carries the account session and the ownership proof, so
      // its refusal does not say which of the two was refused.
      if (result.status === 401) throw new ProfileRequestError('The link was refused.', 401, 'link_unauthorized');
      if (result.status !== 200) throw new ProfileRequestError('The profile service is unavailable.', result.status, errorCode(result.data));
      return parseGuestLink(result.data);
    },
  };
}

/**
 * The service error code of a failed response.
 *
 * The code is the stable part of a refusal. The interface maps it to one
 * short sentence, so it never has to read an English message to know what
 * happened.
 */
function errorCode(data: unknown): string {
  if (typeof data !== 'object' || data === null) return '';
  const code = (data as { error?: unknown }).error;
  return typeof code === 'string' ? code : '';
}

/**
 * A failed profile request.
 *
 * The code is the stable part of a refusal. It is the service error code
 * when the service answered, and one of the client's own codes when the
 * request never reached the service: `not_signed_in` when the account
 * session is gone, `account_changed` when the account changed under the
 * call, `no_guest_seat` when the browser holds no guest seat,
 * `guest_seat_unauthorized` when the guest seat credential was refused, and
 * `link_unauthorized` when the link route refused the request.
 */
export class ProfileRequestError extends Error {
  readonly status: number;
  /** The service error code, or an empty string when the service gave none. */
  readonly code: string;

  constructor(message: string, status: number, code = '') {
    super(message);
    this.name = 'ProfileRequestError';
    this.status = status;
    this.code = code;
  }
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** Parses the trusted service origin. */
function parseBaseUrl(value: string): URL {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('The profile service base URL is required.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The profile service base URL is invalid.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('The profile service base URL is invalid.');
  }
  if (url.protocol !== 'https:' && !LOOPBACK_HOSTS.includes(url.hostname)) {
    throw new Error('The profile service must use HTTPS outside loopback development.');
  }
  return url;
}

/**
 * Resolves a request destination against the trusted service origin.
 *
 * A foreign origin, a non-HTTP scheme, embedded user information, and a
 * credential-shaped query value are all refused here, before a credential is
 * minted.
 */
function resolveUrl(base: URL, path: string): URL {
  let url: URL;
  try {
    url = new URL(path, base);
  } catch {
    throw new Error('The profile service request path is invalid.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('A profile service request must use HTTP or HTTPS.');
  }
  if (url.username || url.password) {
    throw new Error('A profile service request must not carry credentials.');
  }
  if (url.origin !== base.origin) {
    throw new Error('A profile service request must stay on the trusted service origin.');
  }
  for (const key of url.searchParams.keys()) {
    if (CREDENTIAL_QUERY_KEYS.has(key.toLowerCase())) {
      throw new Error(`A profile service request must not carry a "${key}" parameter.`);
    }
  }
  return url;
}

/** Query parameter names that must never carry a participant credential. */
const CREDENTIAL_QUERY_KEYS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'client_secret',
  'credential',
  'credentials',
  'guest_token',
  'id_token',
  'jwt',
  'password',
  'refresh_token',
  'secret',
  'session_token',
  'token',
]);
