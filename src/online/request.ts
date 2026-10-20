/**
 * Authorized request boundary for shared online play (KHA-67).
 *
 * The requester is a generic primitive: it never hardcodes an API route. A
 * caller supplies a path, a scope, and optional JSON body, and the boundary
 * adds the participant credential, the cancellation rules, and the freshness
 * rules.
 *
 * - Every request and every stream renewal mints a fresh credential. A token
 *   is never reused, never cached, and never returned to the caller.
 * - A credential is only used for the scope it owns, so a guest seat token
 *   cannot act on another match, another seat, or an account-scoped route.
 * - The credential travels in a request header only, never in the URL, the
 *   query string, or the body. A URL that carries a credential-shaped value is
 *   refused before anything is sent, and a destination outside the configured
 *   service origin is refused before a credential is even minted.
 * - The credential header slot belongs to the boundary. A caller header that
 *   collides with it, in any spelling, is refused instead of being mixed in.
 * - Every request is fenced by the participant session generation. A late
 *   token, a late response, or a late body from work started under a removed
 *   credential, a changed identity, or a disposed session is discarded even
 *   when the transport ignores the abort signal.
 *
 * The requester never parses the request target. It is a generic primitive:
 * the caller supplies a path, and the service stays authoritative about what a
 * route requires, which participant may call it, and what it answers. The
 * boundary only decides whether the *credential* may act on the *scope*; it
 * never inspects the route to guess a scope, and it never widens a scope that
 * the credential does not already own.
 *
 * The streaming engine belongs to KHA-69. `open` returns the authorized
 * response body plus a `renew` primitive that re-authorizes with a fresh
 * credential and releases the stream it replaces, and an abort signal that the
 * session can cancel.
 */
import { OnlineAuthError, assertCredentialFresh, assertCredentialScope } from './auth';
import type { OnlineAuthErrorCode, OnlineCredential, OnlineRequestScope } from './auth';
import type { ParticipantSession } from './session';

export interface AuthorizedRequestInit {
  /**
   * A path relative to the configured service base URL, or an absolute URL on
   * that origin.
   *
   * The path is never parsed here. The requester does not read the route to
   * decide a scope: the service is authoritative about the routes it exposes
   * and about the participant each route accepts, and the boundary only
   * refuses a credential that may not act on the scope it was given.
   */
  readonly path: string;
  readonly method?: string;
  /** A JSON body. It is serialized and never carries a credential. */
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly accept?: string;
}

export interface AuthorizedResult {
  readonly status: number;
  readonly ok: boolean;
  readonly data: unknown;
}

export interface AuthorizedRenewalInit {
  readonly path?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface AuthorizedStream {
  readonly status: number;
  readonly ok: boolean;
  readonly scope: OnlineRequestScope;
  readonly body: ReadableStream<Uint8Array> | null;
  /** Aborted when the participant session changes or the stream is closed. */
  readonly signal: AbortSignal;
  /** Re-authorizes with a fresh credential and opens a new response. */
  renew(init?: AuthorizedRenewalInit): Promise<AuthorizedStream>;
  /** Releases the stream and cancels its renewals. */
  close(): void;
}

/**
 * How a credential is carried. The service owns the final header names, so the
 * transport is explicit and configurable. A guest seat credential is never
 * sent on the Clerk bearer transport.
 *
 * A transport must return exactly one header: a non-empty name and a non-empty
 * value. The account transport owns the `Authorization` slot; the guest
 * transport must not use it.
 */
export type CredentialTransport = (credential: OnlineCredential, token: string) => Record<string, string>;

export interface AuthorizedRequesterOptions {
  readonly session: ParticipantSession;
  /** The trusted service origin. A credential is never sent outside it. */
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Overrides the header transport for a signed-in account credential. */
  readonly accountTransport?: CredentialTransport;
  /** Overrides the header transport for a private guest seat credential. */
  readonly guestTransport?: CredentialTransport;
}

export interface AuthorizedRequester {
  request(scope: OnlineRequestScope, init: AuthorizedRequestInit): Promise<AuthorizedResult>;
  open(scope: OnlineRequestScope, init: AuthorizedRequestInit): Promise<AuthorizedStream>;
  dispose(): void;
}

/** The cancellation wiring of one authorized call. */
interface CallBinding {
  readonly controller: AbortController;
  readonly externalSignal: AbortSignal | undefined;
  readonly onExternalAbort: () => void;
  readonly parentSignal: AbortSignal | undefined;
  readonly onParentAbort: () => void;
}

interface AuthorizedCall extends CallBinding {
  readonly generation: number;
  readonly response: Response;
}

/** One authorized call that has not finished yet, with its cancellation reason. */
interface PendingCall {
  reason: OnlineAuthErrorCode | null;
  readonly binding: CallBinding;
  response?: Response;
  /** The fenced body, when the response body was handed to a consumer. */
  fence?: FencedBody;
}

/**
 * A response body fenced by the participant session generation.
 *
 * The fence owns the underlying reader, so it can release a body that the
 * consumer has already locked. When the call is cancelled the reader is
 * cancelled and the fenced stream is errored with the cancellation reason; a
 * chunk that the transport delivers afterwards is dropped instead of reaching
 * the caller.
 */
interface FencedBody {
  /** The fenced stream, or null when the response carried no body at all. */
  readonly stream: ReadableStream<Uint8Array> | null;
  /** Closes the fence and releases the underlying reader. */
  release(): void;
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

/** A JWT-shaped value never belongs in a URL. */
const JWT_LIKE = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

/** The header slot the account bearer transport owns. */
const ACCOUNT_CREDENTIAL_HEADER = 'authorization';

/** The signed-in account credential rides the Clerk bearer transport. */
const defaultAccountTransport: CredentialTransport = (_credential, token) => ({ Authorization: `Bearer ${token}` });

/**
 * The guest seat credential rides its own transport so it is never mistaken
 * for a Clerk token. This header matches the online API; an alternate service
 * adapter may replace it through `guestTransport`.
 */
const defaultGuestTransport: CredentialTransport = (_credential, token) => ({ 'X-Guest-Seat-Token': token });

export function createAuthorizedRequester(options: AuthorizedRequesterOptions): AuthorizedRequester {
  const { session } = options;
  const fetcher = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const now = options.now ?? Date.now;
  const base = parseBaseUrl(options.baseUrl);
  const accountTransport = options.accountTransport ?? defaultAccountTransport;
  const guestTransport = options.guestTransport ?? defaultGuestTransport;
  const pending = new Map<AbortController, PendingCall>();
  let disposed = false;

  function abortOne(controller: AbortController, code: OnlineAuthErrorCode): void {
    const entry = pending.get(controller);
    if (!entry) return;
    if (entry.reason === null) entry.reason = code;
    controller.abort(new OnlineAuthError(entry.reason, cancellationMessage(entry.reason)));
    // A fenced body handles cancellation synchronously. Release the caller's
    // signal binding even if its consumer never closes the invalidated stream.
    if (entry.fence) finish(entry.binding);
  }

  function abortAll(code: OnlineAuthErrorCode): void {
    for (const controller of [...pending.keys()]) abortOne(controller, code);
  }

  function finish(binding: CallBinding): void {
    pending.delete(binding.controller);
    binding.externalSignal?.removeEventListener('abort', binding.onExternalAbort);
    binding.parentSignal?.removeEventListener('abort', binding.onParentAbort);
  }

  function assertLive(controller: AbortController, generation: number): void {
    const reason = pending.get(controller)?.reason;
    if (reason) throw new OnlineAuthError(reason, cancellationMessage(reason));
    if (disposed) throw new OnlineAuthError('disposed', 'The online client was disposed.');
    if (generation !== session.generation) {
      throw new OnlineAuthError('identity-changed', 'The participant session changed before the request completed.');
    }
  }

  /** The error that describes why a call was cancelled. */
  function cancellationError(controller: AbortController): OnlineAuthError {
    if (controller.signal.reason instanceof OnlineAuthError) return controller.signal.reason;
    const reason = pending.get(controller)?.reason ?? 'aborted';
    return new OnlineAuthError(reason, cancellationMessage(reason));
  }

  function translate(error: unknown, controller: AbortController, generation: number): Error {
    if (error instanceof OnlineAuthError) return error;
    const reason = pending.get(controller)?.reason;
    if (reason) return new OnlineAuthError(reason, cancellationMessage(reason));
    if (disposed) return new OnlineAuthError('disposed', 'The online client was disposed.');
    if (generation !== session.generation) {
      return new OnlineAuthError('identity-changed', 'The participant session changed before the response arrived.');
    }
    if (error instanceof Error) return error;
    return new Error('The online request failed.');
  }

  /**
   * Resolves the request destination against the trusted service origin. A
   * foreign origin, a non-HTTP scheme, or embedded user information is refused
   * here, before a credential is minted.
   */
  function resolveUrl(path: string): URL {
    if (typeof path !== 'string' || path.trim() === '') {
      throw new OnlineAuthError('invalid-url', 'An online request path is required.');
    }
    let url: URL;
    try {
      url = new URL(path, base);
    } catch {
      throw new OnlineAuthError('invalid-url', 'The online request path is invalid.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new OnlineAuthError('origin-mismatch', 'An online request URL must use HTTP or HTTPS.');
    }
    if (url.username || url.password) {
      throw new OnlineAuthError('origin-mismatch', 'An online request URL must not carry credentials.');
    }
    if (url.origin !== base.origin) {
      throw new OnlineAuthError('origin-mismatch', 'An online request must stay on the trusted service origin.');
    }
    return url;
  }

  /** Rejects a URL that carries a credential-shaped value, before anything is sent. */
  function assertSafeUrl(url: URL): void {
    for (const key of url.searchParams.keys()) {
      if (CREDENTIAL_QUERY_KEYS.has(key.toLowerCase())) {
        throw new OnlineAuthError('credential-in-url', `An online request URL must not carry a "${key}" parameter.`);
      }
    }
    if (JWT_LIKE.test(url.href)) {
      throw new OnlineAuthError('credential-in-url', 'An online request URL must not carry a credential-shaped value.');
    }
  }

  /** Rejects a URL that carries the minted credential itself. */
  function assertTokenOutOfUrl(url: URL, token: string): void {
    if (token.length >= 8 && url.href.includes(token)) {
      throw new OnlineAuthError('credential-in-url', 'A participant credential must never be placed in a URL.');
    }
  }

  /**
   * Resolves the single credential header the transport owns and refuses a
   * transport that would mix the account and guest transports, or that would
   * send an empty credential.
   */
  function resolveCredentialHeader(
    credential: OnlineCredential,
    token: string,
    transport: CredentialTransport,
  ): { name: string; value: string; key: string } {
    const produced = transport(credential, token);
    const entries = Object.entries(produced ?? {});
    const entry = entries.length === 1 ? entries[0] : undefined;
    if (!entry) {
      throw new OnlineAuthError('invalid-transport', 'The credential transport must set exactly one credential header.');
    }
    const [name, value] = entry;
    if (typeof name !== 'string' || name.trim() === '' || name !== name.trim()) {
      throw new OnlineAuthError('invalid-transport', 'The credential transport header name is invalid.');
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new OnlineAuthError('invalid-transport', 'The credential transport produced an empty credential header.');
    }
    const key = name.toLowerCase();
    if (credential.kind === 'guest' && key === ACCOUNT_CREDENTIAL_HEADER) {
      throw new OnlineAuthError('invalid-transport', 'A guest seat credential must never ride the account bearer transport.');
    }
    if (credential.kind === 'account' && key !== ACCOUNT_CREDENTIAL_HEADER) {
      throw new OnlineAuthError('invalid-transport', 'An account credential must ride the account bearer transport.');
    }
    return { name, value, key };
  }

  function buildRequestInit(
    credential: OnlineCredential,
    token: string,
    init: AuthorizedRequestInit,
    signal: AbortSignal,
  ): RequestInit {
    const transport = credential.kind === 'account' ? accountTransport : guestTransport;
    const slot = resolveCredentialHeader(credential, token, transport);
    const headers: Record<string, string> = {};
    // Header names are compared case-insensitively so a caller cannot smuggle
    // a second spelling of the credential slot into the same request. The
    // bearer slot is reserved for every credential: a guest request must never
    // carry a stale account token next to its own.
    const claimed = new Map<string, string>();
    const put = (name: string, value: string, replace = false): void => {
      const key = name.toLowerCase();
      const existing = claimed.get(key);
      if (existing !== undefined) {
        if (!replace) return;
        delete headers[existing];
      }
      claimed.set(key, name);
      headers[name] = value;
    };
    const reserved = new Set<string>([ACCOUNT_CREDENTIAL_HEADER, slot.key]);
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      if (reserved.has(name.toLowerCase())) {
        throw new OnlineAuthError(
          'credential-header-conflict',
          `The "${name}" header is owned by the participant credential and cannot be set by the caller.`,
        );
      }
      put(name, value);
    }
    put('Accept', init.accept ?? 'application/json');
    put(slot.name, slot.value, true);
    const requestInit: RequestInit = {
      method: init.method ?? 'GET',
      headers,
      credentials: 'omit',
      redirect: 'error',
      // The boundary never reuses a cached response for a participant
      // credential. A browser adds `Pragma` and `Cache-Control` to the wire
      // request after the preflight, so the service allowlists those headers
      // in its CORS policy; the request itself only asks for the credential
      // header.
      cache: 'no-store',
      signal,
    };
    if (init.body !== undefined) {
      put('Content-Type', 'application/json', true);
      requestInit.body = JSON.stringify(init.body);
    }
    return requestInit;
  }

  async function authorize(
    scope: OnlineRequestScope,
    init: AuthorizedRequestInit,
    parentSignal?: AbortSignal,
  ): Promise<AuthorizedCall> {
    if (disposed) throw new OnlineAuthError('disposed', 'The online client was disposed.');
    const credential: OnlineCredential | null = session.credential;
    if (!credential) {
      throw new OnlineAuthError(
        session.hasParticipant ? 'credential-cleared' : 'no-credential',
        session.hasParticipant
          ? 'The participant credential is no longer available. Sign in again or rejoin the seat.'
          : 'No participant credential is active.',
      );
    }
    assertCredentialScope(credential, scope);
    assertCredentialFresh(credential, now());
    if (credential.kind === 'account' && session.accountId !== null && credential.accountId !== session.accountId) {
      throw new OnlineAuthError('identity-changed', 'The signed-in account changed before the request started.');
    }
    // The destination is checked before a credential is minted: a foreign URL
    // must never cause a token to be issued at all.
    const url = resolveUrl(init.path);
    assertSafeUrl(url);
    const generation = session.generation;
    const controller = new AbortController();
    const externalSignal = init.signal;
    const onExternalAbort = () => abortOne(controller, 'aborted');
    const onParentAbort = () => abortOne(controller, 'aborted');
    const binding: CallBinding = { controller, externalSignal, onExternalAbort, parentSignal, onParentAbort };
    pending.set(controller, { reason: null, binding });
    if (externalSignal) {
      if (externalSignal.aborted) abortOne(controller, 'aborted');
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    if (parentSignal) {
      if (parentSignal.aborted) abortOne(controller, 'aborted');
      else parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
    let token: string;
    try {
      assertLive(controller, generation);
      // The token work is raced against cancellation. A credential that never
      // resolves must not keep the request pending, and the cancellation
      // reason must survive the cleanup that follows.
      token = await withAbort(Promise.resolve().then(() => credential.issue()), controller);
    } catch (error) {
      const failure = translate(error, controller, generation);
      finish(binding);
      throw failure;
    }
    try {
      assertLive(controller, generation);
      if (typeof token !== 'string' || token.trim() === '') {
        throw new OnlineAuthError('no-credential', 'The participant credential is empty.');
      }
      // The credential may have expired while it was being minted.
      assertCredentialFresh(credential, now());
      assertTokenOutOfUrl(url, token);
      const requestInit = buildRequestInit(credential, token, init, controller.signal);
      // The credential is checked again immediately before the request leaves.
      assertCredentialFresh(credential, now());
      const responsePromise = Promise.resolve(fetcher(url, requestInit));
      let response: Response;
      try {
        response = await withAbort(responsePromise, controller);
      } catch (error) {
        // The transport may ignore the abort and still deliver a response.
        // That late response owns an open body, so it is released instead of
        // being left behind a cancelled call.
        void responsePromise.then((late) => cancelBody(late), () => undefined);
        throw error;
      }
      assertLive(controller, generation);
      const entry = pending.get(controller);
      if (entry) entry.response = response;
      return { ...binding, generation, response };
    } catch (error) {
      const failure = translate(error, controller, generation);
      finish(binding);
      throw failure;
    }
  }

  /**
   * Settles as soon as the request is cancelled, even when the transport
   * ignores the abort signal. A late response then has nowhere to land: the
   * caller is settled already, and the late body is released.
   */
  async function withAbort<T>(work: Promise<T>, controller: AbortController): Promise<T> {
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        const reason = pending.get(controller)?.reason ?? 'aborted';
        reject(new OnlineAuthError(reason, cancellationMessage(reason)));
      };
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([work, cancelled]);
    } finally {
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
  }

  async function requestJson(scope: OnlineRequestScope, init: AuthorizedRequestInit): Promise<AuthorizedResult> {
    const call = await authorize(scope, init);
    const fence = createFencedBody(call.response, call.controller.signal, () => cancellationError(call.controller));
    const entry = pending.get(call.controller);
    if (entry) entry.fence = fence;
    try {
      const text = await withAbort(new Response(fence.stream).text(), call.controller);
      assertLive(call.controller, call.generation);
      const data = text.length > 0 ? parseJson(text) : null;
      return { status: call.response.status, ok: call.response.ok, data };
    } catch (error) {
      throw translate(error, call.controller, call.generation);
    } finally {
      fence.release();
      finish(call);
    }
  }

  async function openStream(scope: OnlineRequestScope, init: AuthorizedRequestInit): Promise<AuthorizedStream> {
    const call = await authorize(scope, init);
    return makeStream(scope, init, call);
  }

  /**
   * A stream owns exactly one authorized response. The response body is
   * fenced by the call that owns it, so a chunk that arrives after the
   * participant session changed is never delivered to the consumer. A renewal
   * acquires a fresh authorization first, so a failed renewal leaves the
   * current stream usable, and then releases the stream it replaces: the
   * previous response body is cancelled, its controller is aborted, and its
   * caller signal listener is removed. A renewal that is still in flight is
   * cancelled when the stream is closed.
   */
  function makeStream(scope: OnlineRequestScope, init: AuthorizedRequestInit, call: AuthorizedCall): AuthorizedStream {
    const lifecycle = new AbortController();
    const fence = createFencedBody(call.response, call.controller.signal, () => cancellationError(call.controller));
    const entry = pending.get(call.controller);
    if (entry) entry.fence = fence;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      lifecycle.abort();
      // The fence is released before the controller aborts, so a stream that
      // is closed on purpose ends cleanly instead of failing its consumer.
      fence.release();
      abortOne(call.controller, 'aborted');
      finish(call);
    };
    return {
      status: call.response.status,
      ok: call.response.ok,
      scope,
      body: fence.stream,
      signal: call.controller.signal,
      async renew(renewInit) {
        if (disposed) throw new OnlineAuthError('disposed', 'The online client was disposed.');
        if (released) throw new OnlineAuthError('aborted', 'The online stream was closed.');
        if (call.controller.signal.aborted) {
          throw cancellationError(call.controller);
        }
        const nextInit = mergeRenewalInit(init, renewInit);
        const renewal = new AbortController();
        const onRelease = () => renewal.abort();
        lifecycle.signal.addEventListener('abort', onRelease, { once: true });
        let next: AuthorizedCall;
        try {
          next = await authorize(scope, nextInit, renewal.signal);
        } finally {
          lifecycle.signal.removeEventListener('abort', onRelease);
        }
        if (released) {
          // The stream was closed while the renewal was in flight. The fresh
          // authorization is released instead of handing back a dead stream.
          abortOne(next.controller, 'aborted');
          finish(next);
          void cancelBody(next.response);
          throw new OnlineAuthError('aborted', 'The online stream was closed.');
        }
        release();
        return makeStream(scope, nextInit, next);
      },
      close() {
        release();
      },
    };
  }

  const unsubscribe = session.subscribe((state) => {
    if (state.invalidates) abortAll(state.invalidates);
  });

  return {
    request: requestJson,
    open: openStream,
    dispose() {
      if (disposed) return;
      disposed = true;
      abortAll('disposed');
      unsubscribe();
      // Every pending call releases its caller signal listener and its
      // response body, so a disposed client leaves nothing attached to the
      // caller's own signal and keeps no open response. A fenced body is
      // released through its own reader, because the body itself is locked.
      for (const entry of [...pending.values()]) {
        finish(entry.binding);
        if (entry.fence) entry.fence.release();
        else if (entry.response) void cancelBody(entry.response);
      }
      pending.clear();
    },
  };
}

/**
 * Fences a response body by the call that owns it.
 *
 * The consumer only ever sees a chunk that the transport delivered while the
 * call was still live. When the call is cancelled the underlying reader is
 * cancelled, the fenced stream is errored with the cancellation reason, and a
 * chunk that arrives afterwards is dropped. The fence also owns the reader, so
 * a body that the consumer has already locked is still released.
 */
function createFencedBody(response: Response, signal: AbortSignal, reason: () => OnlineAuthError): FencedBody {
  const source = response.body;
  if (!source) return { stream: null, release() {} };
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = source.getReader();
  } catch {
    // Somebody else already locked the body, so there is nothing left to fence.
    return { stream: null, release() {} };
  }
  let fenced = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const detach = (): void => { signal.removeEventListener('abort', onAbort); };
  const close = (error: Error | null): void => {
    if (fenced) return;
    fenced = true;
    detach();
    // The reader belongs to the fence, so the body is released even when the
    // consumer has already locked the fenced stream.
    void Promise.resolve(reader.cancel(error ?? undefined)).catch(() => undefined);
    if (!controllerRef) return;
    try {
      if (error) controllerRef.error(error);
      else controllerRef.close();
    } catch {
      // The fenced stream already settled.
    }
  };
  const onAbort = (): void => { close(reason()); };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (signal.aborted) {
        close(reason());
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    },
    async pull(controller) {
      if (fenced) return;
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (fenced) return;
        fenced = true;
        detach();
        try { controller.error(error); } catch { /* the fenced stream already settled */ }
        return;
      }
      if (fenced) {
        // A chunk that arrives after the fence closed is dropped. The caller
        // must never see data from a response that was already cancelled.
        return;
      }
      if (result.done) {
        fenced = true;
        detach();
        try { controller.close(); } catch { /* the fenced stream already settled */ }
        return;
      }
      try {
        controller.enqueue(result.value);
      } catch {
        close(null);
      }
    },
    cancel(cause) {
      fenced = true;
      detach();
      void Promise.resolve(reader.cancel(cause)).catch(() => undefined);
    },
  });

  return { stream, release: () => close(null) };
}

function mergeRenewalInit(init: AuthorizedRequestInit, renewInit?: AuthorizedRenewalInit): AuthorizedRequestInit {
  const headers = renewInit?.headers !== undefined ? renewInit.headers : init.headers;
  const signal = renewInit?.signal ?? init.signal;
  return {
    path: renewInit?.path ?? init.path,
    ...(init.method !== undefined ? { method: init.method } : {}),
    ...(init.accept !== undefined ? { accept: init.accept } : {}),
    ...(init.body !== undefined ? { body: init.body } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(signal !== undefined ? { signal } : {}),
  };
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body that is already consumed or locked is released by the transport.
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('The online service returned an invalid response body.');
  }
}

function parseBaseUrl(value: string): URL {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('The online service base URL is required.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The online service base URL is invalid.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('The online service base URL is invalid.');
  }
  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
    throw new Error('The online service must use HTTPS outside loopback development.');
  }
  return url;
}

function isLoopbackHost(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}

function cancellationMessage(code: OnlineAuthErrorCode): string {
  switch (code) {
    case 'identity-changed':
      return 'The participant session changed. The request was cancelled.';
    case 'credential-cleared':
      return 'The participant credential was removed. The request was cancelled.';
    case 'credential-changed':
      return 'The participant credential changed. The request was cancelled.';
    case 'disposed':
      return 'The online client was disposed. The request was cancelled.';
    default:
      return 'The request was cancelled.';
  }
}
