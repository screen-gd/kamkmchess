import { describe, expect, it, vi } from 'vitest';
import { createGuestCredential } from './auth';
import { createAuthorizedRequester } from './request';
import { createParticipantSession } from './session';
import type { AccountIdentityPort } from './session';
import type { AuthorizedRequester } from './request';
import { createOnlineUpdatesSubscriber, createMemoryCursorStorage, createSseParser, parseOnlineUpdateEnvelope } from './updates';
import type { OnlineCursorScope, OnlineCursorStorage, OnlineUpdateSnapshot, OnlineUpdatesSubscriber } from './updates';

interface RecordedCall {
  readonly url: string;
  readonly headers: Record<string, string>;
}

function recordingFetch(handler: (call: RecordedCall, index: number) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[name] = value;
    const call: RecordedCall = { url: String(input), headers };
    calls.push(call);
    return handler(call, calls.length - 1);
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

function guestSession() {
  const session = createParticipantSession({ accountSession: null });
  session.selectGuest(createGuestCredential({
    guestId: 'guest_1',
    matchId: 'match_alpha',
    seat: 'white',
    token: 'guest-secret-token',
  }));
  return session;
}

/** A participant match view that passes the structural checks. */
function matchView(version: number, matchId = 'match_alpha') {
  return {
    schemaVersion: 2,
    matchId,
    variant: 'orthodox',
    startingFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    positionFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    timeControl: { startingTimeMs: 60_000, incrementMs: 1_000 },
    version,
    controlEpoch: 1,
    rulesPolicyVersion: 'online-rules/1',
    status: 'active',
    result: null,
    seats: [
      { seat: 'white', publicLabel: 'White', control: { kind: 'human' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
      { seat: 'black', publicLabel: 'Black', control: { kind: 'agent', modelLabel: 'Test model' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
    ],
    clock: {
      whiteMs: 60_000,
      blackMs: 60_000,
      activeSeat: 'white',
      activeSince: '2026-10-20T10:00:00.000Z',
      deadlineAt: '2026-10-20T10:01:00.000Z',
      whiteMoved: false,
      blackMoved: false,
      turnNumber: 1,
      replySeat: null,
      replyDeadlineAt: null,
    },
    moves: [],
    pendingOffers: [],
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
    completedAt: null,
    yourSeat: 'white',
  };
}

function envelope(version: number, matchId = 'match_alpha') {
  return { schemaVersion: 1, cursor: version, snapshot: matchView(version, matchId) };
}

/** The wire form of one snapshot event. */
function snapshotEvent(version: number, matchId = 'match_alpha'): string {
  return `event: snapshot\nid: ${version}\ndata: ${JSON.stringify(envelope(version, matchId))}\n\n`;
}

function sseResponse(text: string, status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A stream that stays open until the test releases it. */
function openStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) { controller = streamController; },
  });
  return {
    body,
    push(text: string) {
      try { controller.enqueue(encoder.encode(text)); } catch { /* the stream was already released */ }
    },
    close() {
      try { controller.close(); } catch { /* the stream was already released */ }
    },
  };
}

function memoryStorage(initial: number | null = null) {
  const state = { value: initial, writes: [] as number[], reads: 0 };
  const storage: OnlineCursorStorage = {
    read() {
      state.reads += 1;
      return state.value;
    },
    write(_scope: OnlineCursorScope, cursor: number) {
      state.value = cursor;
      state.writes.push(cursor);
    },
  };
  return { state, storage };
}

interface Harness {
  readonly subscriber: OnlineUpdatesSubscriber;
  readonly session: ReturnType<typeof guestSession>;
  readonly requester: AuthorizedRequester;
  readonly updates: OnlineUpdateSnapshot[];
  readonly errors: Error[];
  readonly stops: string[];
}

function harness(options: {
  fetcher: typeof fetch;
  storage?: OnlineCursorStorage;
  session?: ReturnType<typeof guestSession>;
  transport?: 'auto' | 'sse' | 'poll';
  pollIntervalMs?: number;
  reconnectDelayMs?: number;
  maxIdleMs?: number;
  maxEventBytes?: number;
  maxLineBytes?: number;
  baseBackoffMs?: number;
}): Harness {
  const session = options.session ?? guestSession();
  const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: options.fetcher });
  const updates: OnlineUpdateSnapshot[] = [];
  const errors: Error[] = [];
  const stops: string[] = [];
  const subscriber = createOnlineUpdatesSubscriber({
    requester,
    session,
    matchId: 'match_alpha',
    seat: 'white',
    transport: options.transport ?? 'auto',
    // Every test owns its cursor store, so one test never resumes the cursor
    // of another test.
    storage: options.storage ?? createMemoryCursorStorage(),
    pollIntervalMs: options.pollIntervalMs ?? 10,
    reconnectDelayMs: options.reconnectDelayMs ?? 10,
    baseBackoffMs: options.baseBackoffMs ?? 500,
    maxIdleMs: options.maxIdleMs ?? 200,
    maxEventBytes: options.maxEventBytes ?? 64 * 1024,
    maxLineBytes: options.maxLineBytes ?? 64 * 1024,
    onSnapshot: (update) => { updates.push(update); },
    onError: (error) => { errors.push(error); },
    onStop: (reason) => { stops.push(reason); },
  });
  return { subscriber, session, requester, updates, errors, stops };
}

describe('server-sent event parsing', () => {
  it('reads a frame that arrives one character at a time', () => {
    const parser = createSseParser();
    const text = 'event: snapshot\nid: 4\ndata: {"schemaVersion":1}\n\n';
    const events = [...text].flatMap((character) => parser.push(character));
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('snapshot');
    expect(events[0]?.id).toBe('4');
    expect(events[0]?.data).toBe('{"schemaVersion":1}');
  });

  it('reads a carriage return and a line feed that arrive in different chunks', () => {
    const parser = createSseParser();
    const events = [
      ...parser.push('event: snapshot\r'),
      ...parser.push('\nid: 4\r\ndata: {"schemaVersion":1}\r'),
      ...parser.push('\n'),
      ...parser.push('\r\n'),
    ];
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('snapshot');
    expect(events[0]?.id).toBe('4');
    expect(events[0]?.data).toBe('{"schemaVersion":1}');
  });

  it('ignores a heartbeat comment', () => {
    const parser = createSseParser();
    const events = parser.push(': keep-alive\n\n');
    expect(events).toEqual([]);
  });

  it('discards an incomplete frame when the stream ends', () => {
    const parser = createSseParser();
    const events = parser.push('event: snapshot\nid: 4\ndata: {"schemaVersion":1}\n');
    expect(events).toEqual([]);
    expect(parser.flush()).toEqual([]);
  });

  it('refuses an event beyond the accepted byte count', () => {
    const parser = createSseParser({ maxEventBytes: 16 });
    expect(() => parser.push(`data: ${'x'.repeat(64)}\n\n`)).toThrow(/accepted size/);
  });

  it('counts the byte bound in UTF-8 bytes', () => {
    const parser = createSseParser({ maxEventBytes: 6 });
    // Three characters of two bytes each are six bytes. A bound that counted
    // code units would read three and let the payload through.
    expect(() => parser.push('data: äöü\n\n')).toThrow(/accepted size/);
  });
});

describe('online match updates', () => {
  it('applies the canonical snapshot of a stream and stores its cursor', async () => {
    const { calls, fetcher } = recordingFetch(() => sseResponse(snapshotEvent(7)));
    const memory = memoryStorage();
    const { subscriber, updates } = harness({ fetcher, storage: memory.storage });

    subscriber.start();
    await vi.waitFor(() => expect(updates).toHaveLength(1));

    expect(updates[0]?.cursor).toBe(7);
    expect(updates[0]?.previousCursor).toBeNull();
    expect(updates[0]?.gap).toBe(false);
    expect(updates[0]?.snapshot.matchId).toBe('match_alpha');
    expect(updates[0]?.snapshot.yourSeat).toBe('white');
    expect(memory.state.writes).toEqual([7]);
    expect(subscriber.cursor).toBe(7);
    expect(calls[0]?.headers.Accept).toBe('text/event-stream');
    expect(calls[0]?.url).toBe('https://service.example/v1/online/matches/match_alpha/updates');

    subscriber.dispose();
  });

  it('sends the stored cursor as Last-Event-ID and never a malformed one', async () => {
    const { calls, fetcher } = recordingFetch(() => sseResponse(snapshotEvent(9)));
    const memory = memoryStorage(4);
    const { subscriber } = harness({ fetcher, storage: memory.storage });

    subscriber.start();
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]?.headers['Last-Event-ID']).toBe('4');

    subscriber.dispose();

    const broken = recordingFetch(() => sseResponse(snapshotEvent(9)));
    const invalid = harness({
      fetcher: broken.fetcher,
      storage: { read: () => 'not-a-cursor' as unknown as number, write: () => undefined },
    });
    invalid.subscriber.start();
    await vi.waitFor(() => expect(broken.calls.length).toBeGreaterThan(0));
    expect(broken.calls[0]?.headers['Last-Event-ID']).toBeUndefined();
    invalid.subscriber.dispose();
  });

  it('ignores a duplicate snapshot and an older snapshot', async () => {
    const { fetcher } = recordingFetch(() => sseResponse(`${snapshotEvent(9)}${snapshotEvent(9)}${snapshotEvent(5)}`));
    const memory = memoryStorage();
    const { subscriber, updates } = harness({ fetcher, storage: memory.storage });

    subscriber.start();
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The same cursor is idempotent and the older cursor is ignored, so the
    // version never regresses and a snapshot is never applied twice.
    expect(updates).toHaveLength(1);
    expect(subscriber.cursor).toBe(9);
    expect(memory.state.writes).toEqual([9]);

    subscriber.dispose();
  });

  it('applies a newer snapshot after a gap and reports the gap', async () => {
    const { fetcher } = recordingFetch(() => sseResponse(`${snapshotEvent(3)}${snapshotEvent(8)}`));
    const { subscriber, updates } = harness({ fetcher });

    subscriber.start();
    await vi.waitFor(() => expect(updates).toHaveLength(2));

    expect(updates[0]?.cursor).toBe(3);
    expect(updates[0]?.gap).toBe(false);
    expect(updates[1]?.cursor).toBe(8);
    expect(updates[1]?.previousCursor).toBe(3);
    expect(updates[1]?.gap).toBe(true);

    subscriber.dispose();
  });

  it('reads a fragmented stream with heartbeats and CRLF terminators', async () => {
    const stream = openStream();
    const { calls, fetcher } = recordingFetch(() => new Response(stream.body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    const { subscriber, updates } = harness({ fetcher });

    subscriber.start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const text = `: heartbeat\r\nevent: snapshot\r\nid: 4\r\ndata: ${JSON.stringify(envelope(4))}\r\n\r\n`;
    // The event is split in the middle of the payload and of the terminator.
    stream.push(text.slice(0, 30));
    stream.push(text.slice(30, 120));
    stream.push(text.slice(120));

    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]?.cursor).toBe(4);
    expect(updates[0]?.snapshot.version).toBe(4);

    subscriber.dispose();
  });

  it('refuses an oversized event and never applies it', async () => {
    const { fetcher } = recordingFetch(() => sseResponse(`event: snapshot\nid: 4\ndata: ${'x'.repeat(500)}\n\n`));
    const memory = memoryStorage();
    const { subscriber, updates, errors } = harness({ fetcher, storage: memory.storage, transport: 'sse', maxEventBytes: 128 });

    subscriber.start();
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));

    expect(updates).toHaveLength(0);
    expect(memory.state.writes).toEqual([]);
    expect((errors[0] as { code?: string }).code).toBe('event-too-large');

    subscriber.dispose();
  });

  it('refuses an oversized line that arrives whole in one chunk', async () => {
    // The whole line, terminator included, arrives in a single chunk, so a
    // bound that only inspects the leftover buffer would miss it.
    const { fetcher } = recordingFetch(() => sseResponse(`data: ${'x'.repeat(500)}\n\n`));
    const { subscriber, updates, errors } = harness({ fetcher, transport: 'sse', maxLineBytes: 128 });

    subscriber.start();
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));

    expect(updates).toHaveLength(0);
    expect((errors[0] as { code?: string }).code).toBe('event-too-large');

    subscriber.dispose();
  });

  it('discards a frame that was truncated before its blank line', async () => {
    // The payload is valid JSON, but the frame never ended, so the response
    // is truncated and must not commit a snapshot or a cursor.
    const truncated = `event: snapshot\nid: 5\ndata: ${JSON.stringify(envelope(5))}\n`;
    const { calls, fetcher } = recordingFetch(() => sseResponse(truncated));
    const memory = memoryStorage();
    const { subscriber, updates } = harness({ fetcher, storage: memory.storage, transport: 'sse' });

    subscriber.start();
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(updates).toHaveLength(0);
    expect(memory.state.writes).toEqual([]);
    expect(subscriber.cursor).toBeNull();

    subscriber.dispose();
  });

  it('populates a resumed view with the canonical snapshot of the stored cursor', async () => {
    // A durable cursor without a local view must still show the match: the
    // canonical snapshot of that same version is accepted.
    const { fetcher } = recordingFetch(() => sseResponse(snapshotEvent(7)));
    const memory = memoryStorage(7);
    const { subscriber, updates } = harness({ fetcher, storage: memory.storage });

    subscriber.start();
    await vi.waitFor(() => expect(updates).toHaveLength(1));

    expect(updates[0]?.cursor).toBe(7);
    expect(updates[0]?.previousCursor).toBeNull();
    expect(updates[0]?.snapshot.version).toBe(7);

    subscriber.dispose();
  });

  it('refuses an older version when a durable cursor was loaded', async () => {
    const { calls, fetcher } = recordingFetch(() => sseResponse(snapshotEvent(5)));
    const memory = memoryStorage(7);
    const { subscriber, updates } = harness({ fetcher, storage: memory.storage });

    subscriber.start();
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(updates).toHaveLength(0);
    expect(subscriber.cursor).toBe(7);
    expect(memory.state.writes).toEqual([]);

    subscriber.dispose();
  });

  it('reads a snapshot whose empty move list arrived as null', async () => {
    const view = matchView(3);
    const empty = { ...view, moves: null };
    const { fetcher } = recordingFetch(() => sseResponse(
      `event: snapshot\nid: 3\ndata: ${JSON.stringify({ schemaVersion: 1, cursor: 3, snapshot: empty })}\n\n`,
    ));
    const { subscriber, updates } = harness({ fetcher });

    subscriber.start();
    await vi.waitFor(() => expect(updates).toHaveLength(1));

    expect(updates[0]?.snapshot.moves).toEqual([]);

    subscriber.dispose();
  });

  it('refuses a malformed envelope and a snapshot of another match', async () => {
    const broken = recordingFetch(() => sseResponse('event: snapshot\nid: 5\ndata: {"schemaVersion":1,"cursor":5,"snapshot":{"version":4}}\n\n'));
    const first = harness({ fetcher: broken.fetcher, transport: 'sse' });
    first.subscriber.start();
    await vi.waitFor(() => expect(first.errors.length).toBeGreaterThan(0));
    expect(first.updates).toHaveLength(0);
    expect((first.errors[0] as { code?: string }).code).toBe('invalid-envelope');
    first.subscriber.dispose();

    const foreign = recordingFetch(() => sseResponse(snapshotEvent(6, 'match_beta')));
    const second = harness({ fetcher: foreign.fetcher, transport: 'sse' });
    second.subscriber.start();
    await vi.waitFor(() => expect(second.errors.length).toBeGreaterThan(0));
    expect(second.updates).toHaveLength(0);
    expect((second.errors[0] as { code?: string }).code).toBe('match-mismatch');
    second.subscriber.dispose();
  });

  it('stores the cursor only after a complete accepted snapshot', async () => {
    const { fetcher } = recordingFetch(() => sseResponse(snapshotEvent(11)));
    const memory = memoryStorage();
    const { subscriber, updates } = harness({ fetcher, storage: memory.storage });

    subscriber.start();
    expect(memory.state.writes).toEqual([]);
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(memory.state.writes).toEqual([11]);

    subscriber.dispose();
  });

  it('redelivers a snapshot when the consumer failed before accepting it', async () => {
    const { fetcher } = recordingFetch(() => jsonResponse(envelope(11)));
    const session = guestSession();
    const requester = createAuthorizedRequester({ session, baseUrl: 'https://service.example', fetch: fetcher });
    const memory = memoryStorage();
    const consume = vi.fn(() => {
      if (consume.mock.calls.length === 1) throw new Error('Consumer failed');
    });
    const subscriber = createOnlineUpdatesSubscriber({
      requester, session, matchId: 'match_alpha', seat: 'white', transport: 'poll',
      storage: memory.storage, onSnapshot: consume, pollIntervalMs: 10,
    });
    try {
      subscriber.start();
      await vi.waitFor(() => expect(consume).toHaveBeenCalledTimes(2));
      expect(memory.state.writes).toEqual([11]);
      expect(subscriber.cursor).toBe(11);
    } finally {
      subscriber.dispose();
    }
  });

  it('stops when the participant is not a member of the match', async () => {
    const { calls, fetcher } = recordingFetch(() => new Response('', { status: 404 }));
    const { subscriber, stops, updates } = harness({ fetcher });

    subscriber.start();
    await vi.waitFor(() => expect(stops).toEqual(['not-found']));

    expect(subscriber.stopReason).toBe('not-found');
    expect(subscriber.status).toBe('stopped');
    expect(updates).toHaveLength(0);
    // A refused membership is not retried.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toHaveLength(1);

    subscriber.dispose();
  });

  it('stops when the service refuses the participant credential', async () => {
    const { calls, fetcher } = recordingFetch(() => new Response('', { status: 401 }));
    const { subscriber, stops } = harness({ fetcher });

    subscriber.start();
    await vi.waitFor(() => expect(stops).toEqual(['unauthorized']));

    expect(subscriber.stopReason).toBe('unauthorized');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toHaveLength(1);

    subscriber.dispose();
  });

  it('stops when the participant credential is cleared', async () => {
    const stream = openStream();
    const { calls, fetcher } = recordingFetch(() => new Response(stream.body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    const { subscriber, session, stops, updates } = harness({ fetcher });

    subscriber.start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    session.clear();
    await vi.waitFor(() => expect(stops).toEqual(['session-invalidated']));

    expect(subscriber.stopReason).toBe('session-invalidated');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(updates).toHaveLength(0);
    expect(calls).toHaveLength(1);

    subscriber.dispose();
  });

  it('never commits a late snapshot from a transport that ignores the abort', async () => {
    const stream = openStream();
    const { calls, fetcher } = recordingFetch(() => new Response(stream.body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    const { subscriber, session, updates } = harness({ fetcher });

    subscriber.start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    // The participant is removed while the stream is open. The transport keeps
    // pushing, but the snapshot belongs to a participant that is gone.
    session.clear();
    stream.push(snapshotEvent(5));
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(updates).toHaveLength(0);

    subscriber.dispose();
  });

  it('never commits a snapshot after the subscriber was disposed', async () => {
    const stream = openStream();
    const { calls, fetcher } = recordingFetch(() => new Response(stream.body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    const { subscriber, updates, errors } = harness({ fetcher });

    subscriber.start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    subscriber.dispose();
    stream.push(snapshotEvent(5));
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(updates).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(subscriber.stopReason).toBe('disposed');
  });

  it('opens every stream with a fresh credential', async () => {
    let issued = 0;
    const accountSession = accountSessionStub({
      accountId: 'user_2abcdefghijklmnop',
      token: async () => { issued += 1; return `jwt-${issued}`; },
    });
    const session = createParticipantSession({ accountSession });
    const { calls, fetcher } = recordingFetch(() => sseResponse(snapshotEvent(3)));
    const { subscriber } = harness({ fetcher, session });

    subscriber.start();
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));

    expect(calls[0]?.headers.Authorization).toBe('Bearer jwt-1');
    expect(calls[1]?.headers.Authorization).toBe('Bearer jwt-2');
    expect(issued).toBeGreaterThanOrEqual(2);

    subscriber.dispose();
  });

  it('falls back to bounded polling when the stream transport is refused', async () => {
    const { calls, fetcher } = recordingFetch((_call, index) => {
      if (index === 0) return new Response('', { status: 406 });
      return jsonResponse(envelope(6));
    });
    const memory = memoryStorage();
    const { subscriber, updates } = harness({ fetcher, storage: memory.storage });

    subscriber.start();
    await vi.waitFor(() => expect(updates).toHaveLength(1));

    expect(calls[0]?.headers.Accept).toBe('text/event-stream');
    expect(calls[1]?.headers.Accept).toBe('application/json');
    expect(updates[0]?.cursor).toBe(6);
    expect(memory.state.writes).toEqual([6]);
    expect(subscriber.transport).toBe('poll');

    subscriber.dispose();
  });

  it('converges through the polling fallback after a malformed stream', async () => {
    const { calls, fetcher } = recordingFetch((_call, index) => {
      if (index === 0) return sseResponse('event: snapshot\nid: 4\ndata: {"schemaVersion":1}\n\n');
      return jsonResponse(envelope(12));
    });
    const { subscriber, updates, errors } = harness({ fetcher });

    subscriber.start();
    await vi.waitFor(() => expect(updates).toHaveLength(1));

    // The stream carried a frame the client could not accept, so the
    // compatible polling path converged on the canonical snapshot.
    expect(errors.length).toBeGreaterThan(0);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]?.headers.Accept).toBe('text/event-stream');
    expect(calls[1]?.headers.Accept).toBe('application/json');
    expect(updates[0]?.cursor).toBe(12);
    expect(subscriber.cursor).toBe(12);

    subscriber.dispose();
  });

  it('retries the stream after a temporary service failure', async () => {
    const { calls, fetcher } = recordingFetch((_call, index) => {
      if (index === 0) return new Response('', { status: 503 });
      return sseResponse(snapshotEvent(12));
    });
    const { subscriber, updates } = harness({ fetcher, baseBackoffMs: 5 });

    subscriber.start();
    await vi.waitFor(() => expect(updates).toHaveLength(1));

    // A temporary failure is not a reason to leave the stream transport, so
    // the retry is a stream request again.
    expect(calls[0]?.headers.Accept).toBe('text/event-stream');
    expect(calls[1]?.headers.Accept).toBe('text/event-stream');
    expect(updates[0]?.cursor).toBe(12);

    subscriber.dispose();
  });

  it('sends the cursor on a polling request and keeps polling', async () => {
    const { calls, fetcher } = recordingFetch(() => jsonResponse(envelope(8)));
    const memory = memoryStorage(7);
    const { subscriber, updates } = harness({ fetcher, storage: memory.storage, transport: 'poll' });

    subscriber.start();
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));

    expect(calls[0]?.headers['Last-Event-ID']).toBe('7');
    expect(calls[0]?.headers.Accept).toBe('application/json');
    // The first poll carries the canonical snapshot, so the second poll is
    // idempotent and changes nothing.
    expect(updates).toHaveLength(1);
    expect(updates[0]?.cursor).toBe(8);

    subscriber.dispose();
  });

  it('rejects an unsupported nested snapshot schema', () => {
    const update = envelope(2);
    update.snapshot.schemaVersion = 3;
    expect(() => parseOnlineUpdateEnvelope(update, 'match_alpha')).toThrow(/schema version/);
  });

  it('recovers by polling when a stream never delivers its first byte', async () => {
    const { fetcher, calls } = recordingFetch((_call, index) => index === 0
      ? new Response(new ReadableStream<Uint8Array>(), { headers: { 'Content-Type': 'text/event-stream' } })
      : jsonResponse(envelope(12)));
    const { subscriber, updates } = harness({ fetcher, maxIdleMs: 20 });
    try {
      subscriber.start();
      await vi.waitFor(() => expect(updates[0]?.cursor).toBe(12));
      expect(calls[1]?.headers.Accept).toBe('application/json');
    } finally {
      subscriber.dispose();
    }
  });

  it('recovers when the stream connection never answers', async () => {
    const { fetcher, calls } = recordingFetch((_call, index) => index === 0
      ? new Promise<Response>(() => undefined)
      : jsonResponse(envelope(12)));
    const { subscriber, updates } = harness({ fetcher, maxIdleMs: 20 });
    try {
      subscriber.start();
      await vi.waitFor(() => expect(updates[0]?.cursor).toBe(12));
      expect(calls[1]?.headers.Accept).toBe('application/json');
    } finally {
      subscriber.dispose();
    }
  });

  it('falls back to polling after a streaming network failure', async () => {
    const { fetcher, calls } = recordingFetch((call) => {
      if (call.headers.Accept === 'text/event-stream') throw new TypeError('Stream transport unavailable');
      return jsonResponse(envelope(12));
    });
    const { subscriber, updates } = harness({ fetcher, baseBackoffMs: 5 });
    try {
      subscriber.start();
      await vi.waitFor(() => expect(updates[0]?.cursor).toBe(12));
      expect(calls[1]?.headers.Accept).toBe('application/json');
    } finally {
      subscriber.dispose();
    }
  });

  it('falls back after an empty finite stream', async () => {
    const { fetcher } = recordingFetch((_call, index) => index === 0
      ? sseResponse('')
      : jsonResponse(envelope(12)));
    const { subscriber, updates } = harness({ fetcher });
    try {
      subscriber.start();
      await vi.waitFor(() => expect(updates[0]?.cursor).toBe(12));
      expect(subscriber.transport).toBe('poll');
    } finally {
      subscriber.dispose();
    }
  });

  it('keeps the retry backoff after a polling request times out', async () => {
    vi.useFakeTimers();
    const { fetcher, calls } = recordingFetch(() => new Promise<Response>(() => undefined));
    const { subscriber, errors } = harness({ fetcher, transport: 'poll', maxIdleMs: 20, baseBackoffMs: 500 });
    try {
      subscriber.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(21);
      expect(errors).toHaveLength(1);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(400);
      expect(calls).toHaveLength(1);
      subscriber.wake();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(2);
    } finally {
      subscriber.dispose();
      vi.useRealTimers();
    }
  });

  it('reconnects at once when the caller wakes the subscriber', async () => {
    const { calls, fetcher } = recordingFetch(() => sseResponse(snapshotEvent(2)));
    const { subscriber } = harness({ fetcher, reconnectDelayMs: 5_000 });

    subscriber.start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(1);

    subscriber.wake();
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    subscriber.dispose();
  });
});
