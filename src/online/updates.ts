/**
 * Canonical match updates for shared online play (KHA-69).
 *
 * One route serves both transports:
 *
 *   GET /v1/online/matches/{matchID}/updates
 *
 * `Accept: text/event-stream` opens a finite server-sent event stream.
 * `Accept: application/json` answers the same canonical envelope once. Both
 * answers carry the same envelope:
 *
 *   { schemaVersion: 1, cursor: number, snapshot: <participant match view> }
 *
 * The cursor is the durable match version. `cursor` always equals
 * `snapshot.version`, so a snapshot always describes the whole state at that
 * version. A participant that missed events converges on the next snapshot
 * instead of replaying history: the transport never exposes raw private
 * events, participant identifiers or credentials.
 *
 * The rules this module keeps:
 *
 * - A stream is finite. The service closes it at or before twenty seconds or
 *   at credential expiry, and sends heartbeat comments while it waits. The
 *   subscriber reopens with a fresh credential, so a renewal never reuses a
 *   token and never keeps a credential past its own lifetime.
 * - The subscriber never holds a database connection. It only reads the
 *   response body, and an idle stream holds nothing but the socket.
 * - The subscriber delivers whole snapshots, never a move list to apply. A
 *   consumer replaces its state with the snapshot, so a gap, a duplicate or a
 *   lost acknowledgement can never reapply a move.
 * - A snapshot is the canonical state at its version. The clock it carries is
 *   the sample of that version; interpolating it between versions belongs to
 *   the interface, not to this transport.
 * - A cursor is stored only after a complete, valid, accepted snapshot. A
 *   newer cursor replaces the stored one, the same cursor is idempotent and
 *   an older cursor is refused, so a version never regresses and a reconnect
 *   never rolls the client back to an earlier state.
 * - A durable cursor that was loaded without a local view is populated by
 *   the canonical snapshot of that same version, so a resumed participant
 *   sees its match again instead of an empty board.
 * - A late snapshot, a late poll answer or a late durable write that belongs
 *   to a removed participant, a changed identity or a disposed subscriber is
 *   discarded instead of being committed.
 * - The transport is bounded. Backoff grows to a ceiling and never spins,
 *   polling is the compatibility fallback, and a tab wake is an explicit
 *   reconnect.
 * - A truncated frame is discarded. A response that ends in the middle of an
 *   event never commits a snapshot and never advances a cursor.
 *
 * The module has no interface. It is a reusable subscriber that a caller
 * wires to its own state; it renders nothing and owns no chess authority.
 */
import { OnlineAuthError, describeCredential, matchSeatScope } from './auth';
import { ONLINE_CONTRACTS_SCHEMA_VERSION } from './contracts';
import type { ClockState, MatchStatus, Move, OfferKind, Result, Seat, SeatControl, TimeControl } from './contracts';
import type { AuthorizedRequester, AuthorizedStream } from './request';
import type { ParticipantSession } from './session';

/** The envelope schema version this client understands. */
export const ONLINE_UPDATE_ENVELOPE_SCHEMA_VERSION = 1;

/**
 * The default bound on one server-sent event, in UTF-8 bytes.
 *
 * A snapshot is one line of JSON and a completed game carries every
 * accepted move, so the bound has to hold a full game. One mebibyte is far
 * above a legal long game and still finite.
 */
const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024;

/** The default bound on one server-sent event line, in UTF-8 bytes. */
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

/** The default polling interval for the compatibility fallback. */
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** The default first backoff delay after a failed cycle. */
const DEFAULT_BASE_BACKOFF_MS = 500;

/** The default ceiling of the network backoff. */
const DEFAULT_MAX_BACKOFF_MS = 30_000;

/** The default pause between two consecutive streams. */
const DEFAULT_RECONNECT_DELAY_MS = 250;

/** The default idle bound. The service heartbeats every five seconds. */
const DEFAULT_MAX_IDLE_MS = 30_000;

/** The allowlisted seat view. It carries no participant reference. */
export interface OnlineMatchSeatView {
  readonly seat: Seat;
  readonly publicLabel: string;
  readonly control: SeatControl;
  readonly controlEpoch: number;
  readonly illegalAttemptsSpent: number;
  readonly formatCorrectionsSpent: number;
}

/** The allowlisted pending offer view. It carries no participant reference. */
export interface OnlineOfferView {
  readonly offerId: string;
  readonly kind: OfferKind;
  readonly seat: Seat;
  readonly targetVersion: number | null;
  readonly baseVersion: number;
  readonly createdAt: string;
}

/**
 * The participant live match view.
 *
 * It mirrors the allowlisted `onlineMatchResponse` of the Go API. It carries
 * no participant reference, owner identifier, session identifier, credential,
 * token or hash, and it is not the internal match of the writer.
 *
 * The service serializes an empty slice as `null`, so a fresh match carries
 * `null` for its moves. The client reads that as an empty list.
 */
export interface OnlineMatchView {
  readonly schemaVersion: number;
  readonly matchId: string;
  readonly variant: 'orthodox';
  readonly startingFen: string;
  readonly positionFen: string;
  readonly timeControl: TimeControl;
  readonly version: number;
  readonly controlEpoch: number;
  readonly rulesPolicyVersion: string;
  readonly status: MatchStatus;
  readonly result: Result | null;
  readonly seats: readonly OnlineMatchSeatView[];
  readonly clock: ClockState;
  readonly moves: readonly Move[];
  readonly pendingOffers: readonly OnlineOfferView[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly yourSeat: Seat | null;
}

/** The canonical update envelope. The cursor is the durable match version. */
export interface OnlineUpdateEnvelope {
  readonly schemaVersion: number;
  readonly cursor: number;
  readonly snapshot: OnlineMatchView;
}

/** Why an update could not be read or accepted. */
export type OnlineUpdateErrorCode =
  | 'invalid-envelope'
  | 'invalid-cursor'
  | 'match-mismatch'
  | 'protocol-error'
  | 'event-too-large'
  | 'unsupported'
  | 'http-error';

/** A failure of the update transport or of the envelope it carried. */
export class OnlineUpdateError extends Error {
  readonly code: OnlineUpdateErrorCode;

  constructor(code: OnlineUpdateErrorCode, message: string) {
    super(message);
    this.name = 'OnlineUpdateError';
    this.code = code;
  }
}

/** Why the subscriber stopped. */
export type OnlineUpdateStopReason =
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'invalid-request'
  | 'no-participant'
  | 'session-invalidated'
  | 'disposed';

/** What the subscriber is doing right now. */
export type OnlineUpdateStatus = 'idle' | 'connecting' | 'streaming' | 'polling' | 'stopped';

/** How the subscriber reads the updates route. */
export type OnlineUpdateTransport = 'auto' | 'sse' | 'poll';

/** One accepted snapshot and the cursor it replaced. */
export interface OnlineUpdateSnapshot {
  readonly envelope: OnlineUpdateEnvelope;
  readonly snapshot: OnlineMatchView;
  readonly cursor: number;
  /** The last snapshot this session applied, or null when it applied none. */
  readonly previousCursor: number | null;
  /** True when more than one version was skipped since the last snapshot. */
  readonly gap: boolean;
}

/** The durable cursor scope. A cursor belongs to one match and one identity. */
export interface OnlineCursorScope {
  readonly matchId: string;
  /** A local identity key. It never leaves the browser. */
  readonly identity: string;
}

/**
 * The durable cursor hook.
 *
 * A caller that owns durable storage supplies its own adapter, scoped to the
 * match and the participant identity. The default adapter keeps cursors in
 * memory for the lifetime of the page.
 * Shared adapters must atomically retain the greater cursor when subscribers
 * write out of order, including writes from separate tabs.
 */
export interface OnlineCursorStorage {
  read(scope: OnlineCursorScope): number | null | Promise<number | null>;
  write(scope: OnlineCursorScope, cursor: number): void | Promise<void>;
}

export interface OnlineUpdatesOptions {
  /** The authorized request boundary. Every call mints a fresh credential. */
  readonly requester: AuthorizedRequester;
  /** The participant session. It fences every cycle of the subscriber. */
  readonly session: ParticipantSession;
  readonly matchId: string;
  readonly seat: Seat;
  /** `auto` streams first and falls back to polling. Defaults to `auto`. */
  readonly transport?: OnlineUpdateTransport;
  /** Overrides the updates route. */
  readonly path?: string;
  /** The durable cursor hook. Defaults to an in-memory store. */
  readonly storage?: OnlineCursorStorage;
  /** Receives every accepted snapshot. The consumer replaces its state. */
  readonly onSnapshot: (update: OnlineUpdateSnapshot) => void;
  /** Receives a transport or protocol failure that the subscriber retried. */
  readonly onError?: (error: Error) => void;
  /** Receives the reason the subscriber stopped. */
  readonly onStop?: (reason: OnlineUpdateStopReason) => void;
  readonly now?: () => number;
  /** The wait between cycles. It settles early when the cycle is interrupted. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The jitter source of the bounded backoff. */
  readonly random?: () => number;
  readonly pollIntervalMs?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly reconnectDelayMs?: number;
  readonly maxIdleMs?: number;
  readonly maxEventBytes?: number;
  readonly maxLineBytes?: number;
}

/** The reusable, interface-free update subscriber. */
export interface OnlineUpdatesSubscriber {
  /** Begins reading updates. It is idempotent. */
  start(): void;
  /** Reconnects at once. A tab wake uses it. */
  wake(): void;
  /** Stops the subscriber and releases every pending request. */
  dispose(): void;
  readonly status: OnlineUpdateStatus;
  readonly transport: 'sse' | 'poll';
  readonly cursor: number | null;
  readonly stopReason: OnlineUpdateStopReason | null;
}

/** The path of the canonical updates route. */
export function onlineUpdatesPath(matchId: string): string {
  return `/v1/online/matches/${encodeURIComponent(matchId)}/updates`;
}

/**
 * An in-memory cursor store.
 *
 * It is the default adapter and it is shared by the page, so a subscriber
 * that is recreated for the same match and identity resumes where the
 * previous one stopped.
 */
export function createMemoryCursorStorage(): OnlineCursorStorage {
  const store = new Map<string, number>();
  return {
    read(scope) {
      return store.get(cursorScopeKey(scope)) ?? null;
    },
    write(scope, cursor) {
      const key = cursorScopeKey(scope);
      store.set(key, Math.max(store.get(key) ?? 0, cursor));
    },
  };
}

const sharedMemoryCursors = new Map<string, number>();

const defaultCursorStorage: OnlineCursorStorage = {
  read(scope) {
    return sharedMemoryCursors.get(cursorScopeKey(scope)) ?? null;
  },
  write(scope, cursor) {
    const key = cursorScopeKey(scope);
    sharedMemoryCursors.set(key, Math.max(sharedMemoryCursors.get(key) ?? 0, cursor));
  },
};

function cursorScopeKey(scope: OnlineCursorScope): string {
  return `${scope.matchId}\u0000${scope.identity}`;
}

/** One parsed server-sent event. */
export interface SseEvent {
  readonly event: string;
  readonly id: string | null;
  readonly data: string;
}

export interface SseParserOptions {
  readonly maxEventBytes?: number;
  readonly maxLineBytes?: number;
}

export interface SseParser {
  /** Feeds a decoded chunk and returns the events it completed. */
  push(chunk: string): SseEvent[];
  /** Finishes the stream and returns the event it left pending. */
  flush(): SseEvent[];
}

/**
 * A bounded server-sent event parser.
 *
 * It accepts the three line terminators, ignores comment lines as
 * heartbeats, and bounds both a single line and a single event in UTF-8
 * bytes, so a misbehaving service cannot grow the client's memory without
 * limit.
 *
 * The bound is generous on purpose. A snapshot is one line of JSON, and a
 * completed game carries every accepted move, so a legal long game must
 * still fit into one event and one line.
 *
 * The parser reads each chunk once. It never rescans what it already read,
 * so a huge incomplete line costs one pass and not one pass per chunk.
 */
export function createSseParser(options: SseParserOptions = {}): SseParser {
  const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  /** The line that is being read, without its terminator. */
  let line = '';
  /** The UTF-8 byte length of the line that is being read. */
  let lineBytes = 0;
  /** True when a carriage return ended a chunk and may carry a line feed. */
  let pendingCarriageReturn = false;
  let dataLines: string[] = [];
  let dataBytes = 0;
  let eventName = '';
  let eventId: string | null = null;

  function reset(): void {
    dataLines = [];
    dataBytes = 0;
    eventName = '';
    eventId = null;
  }

  function dispatch(): SseEvent | null {
    if (dataLines.length === 0) {
      reset();
      return null;
    }
    const event: SseEvent = {
      event: eventName === '' ? 'message' : eventName,
      id: eventId,
      data: dataLines.join('\n'),
    };
    reset();
    return event;
  }

  function handleLine(text: string): SseEvent | null {
    if (text === '') return dispatch();
    // A comment line is a heartbeat. It carries no event and no data.
    if (text.startsWith(':')) return null;
    const separator = text.indexOf(':');
    const field = separator === -1 ? text : text.slice(0, separator);
    let value = separator === -1 ? '' : text.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        if (!value.includes('\u0000')) eventName = value;
        return null;
      case 'data':
        dataLines.push(value);
        dataBytes += utf8ByteLength(value) + 1;
        if (dataBytes > maxEventBytes) {
          throw new OnlineUpdateError('event-too-large', 'The update event exceeded the accepted size.');
        }
        return null;
      case 'id':
        if (!value.includes('\u0000')) eventId = value;
        return null;
      default:
        // `retry` and every unknown field are ignored. The client's own
        // bounded backoff decides when a stream is reopened.
        return null;
    }
  }

  function append(text: string): void {
    line += text;
    lineBytes += utf8ByteLength(text);
    if (lineBytes > maxLineBytes) {
      throw new OnlineUpdateError('event-too-large', 'The update event line exceeded the accepted size.');
    }
  }

  function takeLine(text: string): SseEvent | null {
    // A complete line is bounded as well, so an oversized line cannot slip
    // through when the whole line arrives in one chunk.
    if (utf8ByteLength(text) > maxLineBytes) {
      throw new OnlineUpdateError('event-too-large', 'The update event line exceeded the accepted size.');
    }
    const event = handleLine(text);
    line = '';
    lineBytes = 0;
    return event;
  }

  return {
    push(chunk) {
      const events: SseEvent[] = [];
      let index = 0;
      let start = 0;
      if (pendingCarriageReturn) {
        // The carriage return already ended the line. A line feed that
        // follows it belongs to the same terminator and is consumed here.
        pendingCarriageReturn = false;
        if (chunk.startsWith('\n')) index = 1;
        const event = takeLine(line);
        if (event) events.push(event);
        // The consumed line feed is not part of the next line.
        start = index;
      }
      while (index < chunk.length) {
        const character = chunk[index];
        if (character === '\n') {
          const text = line + chunk.slice(start, index);
          const event = takeLine(text);
          if (event) events.push(event);
          start = index + 1;
          index = start;
          continue;
        }
        if (character === '\r') {
          if (index === chunk.length - 1) {
            // The terminator may still be completed by a line feed, so the
            // line waits for the next chunk.
            append(chunk.slice(start, index));
            pendingCarriageReturn = true;
            start = chunk.length;
            break;
          }
          const text = line + chunk.slice(start, index);
          const event = takeLine(text);
          if (event) events.push(event);
          start = index + 1;
          if (chunk[start] === '\n') start += 1;
          index = start;
          continue;
        }
        index += 1;
      }
      if (start < chunk.length) append(chunk.slice(start));
      return events;
    },
    flush() {
      const events: SseEvent[] = [];
      if (pendingCarriageReturn) {
        // The carriage return ended the line, so the line is complete. Only
        // a blank line dispatches an event.
        pendingCarriageReturn = false;
        const event = takeLine(line);
        if (event) events.push(event);
      }
      // An incomplete frame is discarded. A truncated response never commits
      // a snapshot and never advances a cursor.
      line = '';
      lineBytes = 0;
      reset();
      return events;
    },
  };
}

/**
 * The UTF-8 byte length of a string.
 *
 * The event bounds are byte bounds, so a payload of many multi-byte
 * characters cannot exceed them. The count is exact and allocates nothing.
 */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Validates one canonical envelope.
 *
 * The envelope is strict: an unknown field, a missing field, a cursor that is
 * not a positive safe integer, a snapshot of another match or a cursor that
 * does not equal the snapshot version is refused.
 */
export function parseOnlineUpdateEnvelope(value: unknown, expectedMatchId: string): OnlineUpdateEnvelope {
  const object = asObject(value, 'envelope');
  onlyKeys(object, ['schemaVersion', 'cursor', 'snapshot'], 'envelope');
  requireKeys(object, ['schemaVersion', 'cursor', 'snapshot'], 'envelope');
  const schemaVersion = asSafeInteger(object.schemaVersion, 'envelope.schemaVersion');
  if (schemaVersion !== ONLINE_UPDATE_ENVELOPE_SCHEMA_VERSION) {
    throw new OnlineUpdateError('invalid-envelope', 'The update envelope schema version is not supported.');
  }
  const cursor = asPositiveInteger(object.cursor, 'envelope.cursor');
  const snapshot = parseOnlineMatchView(object.snapshot, expectedMatchId);
  if (snapshot.version !== cursor) {
    throw new OnlineUpdateError('invalid-envelope', 'The update cursor does not match the snapshot version.');
  }
  return { schemaVersion, cursor, snapshot };
}

/**
 * Validates the allowlisted participant match view.
 *
 * The view is the redacted live state of the service. It never carries a
 * participant reference, so an accepted snapshot is safe to keep in local
 * state and safe to show.
 */
export function parseOnlineMatchView(value: unknown, expectedMatchId: string): OnlineMatchView {
  const object = asObject(value, 'snapshot');
  onlyKeys(
    object,
    [
      'schemaVersion',
      'matchId',
      'variant',
      'startingFen',
      'positionFen',
      'timeControl',
      'version',
      'controlEpoch',
      'rulesPolicyVersion',
      'status',
      'result',
      'seats',
      'clock',
      'moves',
      'pendingOffers',
      'createdAt',
      'updatedAt',
      'completedAt',
      'yourSeat',
    ],
    'snapshot',
  );
  requireKeys(
    object,
    [
      'schemaVersion',
      'matchId',
      'variant',
      'startingFen',
      'positionFen',
      'timeControl',
      'version',
      'controlEpoch',
      'rulesPolicyVersion',
      'status',
      'result',
      'seats',
      'clock',
      'moves',
      'pendingOffers',
      'createdAt',
      'updatedAt',
      'completedAt',
      'yourSeat',
    ],
    'snapshot',
  );
  const matchId = asString(object.matchId, 'snapshot.matchId');
  if (matchId !== expectedMatchId) {
    throw new OnlineUpdateError('match-mismatch', 'The update snapshot belongs to another match.');
  }
  const variant = asString(object.variant, 'snapshot.variant');
  if (variant !== 'orthodox') {
    throw new OnlineUpdateError('invalid-envelope', 'The update snapshot uses an unsupported variant.');
  }
  if (object.schemaVersion !== ONLINE_CONTRACTS_SCHEMA_VERSION) {
    throw new OnlineUpdateError('invalid-envelope', 'The update snapshot schema version is not supported.');
  }
  return {
    schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION,
    matchId,
    variant,
    startingFen: asFen(object.startingFen, 'snapshot.startingFen'),
    positionFen: asFen(object.positionFen, 'snapshot.positionFen'),
    timeControl: parseTimeControl(object.timeControl, 'snapshot.timeControl'),
    version: asPositiveInteger(object.version, 'snapshot.version'),
    controlEpoch: asPositiveInteger(object.controlEpoch, 'snapshot.controlEpoch'),
    rulesPolicyVersion: asString(object.rulesPolicyVersion, 'snapshot.rulesPolicyVersion'),
    status: asMatchStatus(object.status, 'snapshot.status'),
    result: object.result === null ? null : parseResult(object.result, 'snapshot.result'),
    seats: parseSeats(object.seats),
    clock: parseClock(object.clock, 'snapshot.clock'),
    moves: parseMoves(object.moves),
    pendingOffers: parseOffers(object.pendingOffers),
    createdAt: asTimestamp(object.createdAt, 'snapshot.createdAt'),
    updatedAt: asTimestamp(object.updatedAt, 'snapshot.updatedAt'),
    completedAt: asNullableTimestamp(object.completedAt, 'snapshot.completedAt'),
    yourSeat: asNullableSeat(object.yourSeat, 'snapshot.yourSeat'),
  };
}

/**
 * Creates the reusable update subscriber.
 *
 * The subscriber owns no chess authority. It reads the canonical envelope,
 * hands accepted snapshots to the caller and keeps the durable cursor.
 */
export function createOnlineUpdatesSubscriber(options: OnlineUpdatesOptions): OnlineUpdatesSubscriber {
  const { requester, session, matchId, seat } = options;
  const scope = matchSeatScope(matchId, seat);
  const path = options.path ?? onlineUpdatesPath(matchId);
  const storage = options.storage ?? defaultCursorStorage;
  const mode = options.transport ?? 'auto';
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const maxIdleMs = options.maxIdleMs ?? DEFAULT_MAX_IDLE_MS;
  const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;

  const lifetime = new AbortController();
  let disposed = false;
  let started = false;
  let status: OnlineUpdateStatus = 'idle';
  let transport: 'sse' | 'poll' = mode === 'poll' ? 'poll' : 'sse';
  /** The last known durable cursor. It may exist without a local view. */
  let cursor: number | null = null;
  /** The last snapshot this session applied. */
  let appliedCursor: number | null = null;
  let cursorScope: OnlineCursorScope | null = null;
  let stopReason: OnlineUpdateStopReason | null = null;
  let attempts = 0;
  let activeCycle: Cycle | null = null;

  interface Cycle {
    readonly controller: AbortController;
    readonly delayController: AbortController;
    woken: boolean;
  }

  function report(error: unknown): void {
    if (!options.onError) return;
    try {
      options.onError(error instanceof Error ? error : new Error('The online update failed.'));
    } catch {
      // A failing consumer never breaks the subscriber.
    }
  }

  function stop(reason: OnlineUpdateStopReason): void {
    if (stopReason !== null) return;
    stopReason = reason;
    status = 'stopped';
    lifetime.abort();
    if (options.onStop) {
      try {
        options.onStop(reason);
      } catch {
        // A failing consumer never breaks the subscriber.
      }
    }
  }

  function identityKey(): string | null {
    const described = describeCredential(session.credential);
    if (!described) return null;
    if (described.kind === 'account') return `account:${described.accountId}`;
    return `guest:${described.guestId}`;
  }

  function cursorHeaders(): Record<string, string> | undefined {
    if (cursor === null || cursor < 1) return undefined;
    return { 'Last-Event-ID': String(cursor) };
  }

  async function loadCursor(): Promise<void> {
    const identity = identityKey();
    if (identity === null) {
      stop('no-participant');
      return;
    }
    const scopeKey: OnlineCursorScope = { matchId, identity };
    cursorScope = scopeKey;
    let stored: number | null = null;
    try {
      stored = await storage.read(scopeKey);
    } catch (error) {
      report(error);
    }
    // A stored cursor that is not a safe integer is never sent and never
    // trusted. The service answers with the canonical snapshot anyway.
    if (typeof stored === 'number' && Number.isSafeInteger(stored) && stored >= 0) {
      cursor = stored;
    }
  }

  async function persistCursor(value: number, generation: number): Promise<void> {
    if (!cursorScope) return;
    if (disposed || generation !== session.generation) return;
    try {
      await storage.write(cursorScope, value);
    } catch (error) {
      // A durable write that fails is reported, but it never breaks the live
      // stream: the in-memory cursor still moves forward.
      report(error);
    }
  }

  async function applyEnvelope(envelope: OnlineUpdateEnvelope, generation: number): Promise<void> {
    // A snapshot that belongs to a removed participant or a changed identity
    // is never committed.
    if (disposed || generation !== session.generation) return;
    const applied = appliedCursor;
    const known = cursor;
    if (applied !== null) {
      // The same cursor is idempotent and an older cursor is refused, so a
      // duplicate, a replay or a late answer never regresses the version.
      if (envelope.cursor <= applied) return;
    } else if (known !== null && envelope.cursor < known) {
      // A durable cursor that was loaded without a local view still refuses
      // an older version. The client never rolls back to an earlier state.
      return;
    }
    const update: OnlineUpdateSnapshot = {
      envelope,
      snapshot: envelope.snapshot,
      cursor: envelope.cursor,
      previousCursor: applied,
      gap: applied !== null && envelope.cursor > applied + 1,
    };
    try {
      options.onSnapshot(update);
    } catch (error) {
      report(error);
      return;
    }
    if (disposed || generation !== session.generation) return;
    cursor = envelope.cursor;
    appliedCursor = envelope.cursor;
    await persistCursor(envelope.cursor, generation);
  }

  async function handleSseEvent(event: SseEvent, generation: number): Promise<void> {
    // Only the snapshot event carries state. An unknown event type is
    // ignored, so a newer service can add events without breaking a client.
    if (event.event !== 'snapshot') return;
    if (event.data.includes('\n') || event.data.includes('\r')) {
      throw new OnlineUpdateError('protocol-error', 'The update event data must be one line.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data) as unknown;
    } catch {
      throw new OnlineUpdateError('invalid-envelope', 'The update event data is not valid JSON.');
    }
    const envelope = parseOnlineUpdateEnvelope(parsed, matchId);
    if (event.id !== null) {
      const id = parseCursor(event.id);
      if (id === null) {
        throw new OnlineUpdateError('invalid-cursor', 'The update event id is not a cursor.');
      }
      if (id !== envelope.cursor) {
        throw new OnlineUpdateError('invalid-cursor', 'The update event id does not match the envelope cursor.');
      }
    }
    await applyEnvelope(envelope, generation);
  }

  async function readEvents(stream: AuthorizedStream, cycle: Cycle, generation: number): Promise<void> {
    const body = stream.body;
    if (!body) {
      throw new OnlineUpdateError('protocol-error', 'The update stream carried no body.');
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser({ maxEventBytes, maxLineBytes });
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let idleExpired = false;
    let sawSnapshot = false;
    const armIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleExpired = true;
        void Promise.resolve(reader.cancel()).catch(() => undefined);
      }, maxIdleMs);
    };
    const onAbort = (): void => {
      void Promise.resolve(reader.cancel()).catch(() => undefined);
    };
    cycle.controller.signal.addEventListener('abort', onAbort, { once: true });
    armIdle();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const text = decoder.decode(chunk.value, { stream: true });
        if (text.length > 0) {
          armIdle();
          for (const event of parser.push(text)) {
            await handleSseEvent(event, generation);
            if (event.event === 'snapshot') sawSnapshot = true;
          }
        }
      }
      const tail = decoder.decode();
      if (tail.length > 0) {
        for (const event of parser.push(tail)) {
          await handleSseEvent(event, generation);
          if (event.event === 'snapshot') sawSnapshot = true;
        }
      }
      for (const event of parser.flush()) await handleSseEvent(event, generation);
      if (idleExpired) {
        throw new OnlineUpdateError('protocol-error', 'The update stream stopped sending heartbeats.');
      }
      if (!sawSnapshot && !cycle.controller.signal.aborted) {
        throw new OnlineUpdateError('protocol-error', 'The update stream ended without a complete snapshot.');
      }
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      cycle.controller.signal.removeEventListener('abort', onAbort);
      try {
        reader.releaseLock();
      } catch {
        // The reader was already released.
      }
    }
  }

  async function boundedRequest<T>(cycle: Cycle, work: () => Promise<T>): Promise<T> {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      cycle.controller.abort();
    }, maxIdleMs);
    try {
      return await work();
    } catch (error) {
      if (timedOut) throw new OnlineUpdateError('protocol-error', 'The update request timed out.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function runStream(cycle: Cycle): Promise<void> {
    status = 'connecting';
    const generation = session.generation;
    const headers = cursorHeaders();
    const stream = await boundedRequest(cycle, () => requester.open(scope, {
      path,
      accept: 'text/event-stream',
      ...(headers ? { headers } : {}),
      signal: cycle.controller.signal,
    }));
    if (!stream.ok) {
      stream.close();
      throw statusError(stream.status);
    }
    status = 'streaming';
    try {
      await readEvents(stream, cycle, generation);
    } finally {
      stream.close();
    }
  }

  async function runPoll(cycle: Cycle): Promise<void> {
    status = 'polling';
    const generation = session.generation;
    const headers = cursorHeaders();
    const result = await boundedRequest(cycle, () => requester.request(scope, {
      path,
      accept: 'application/json',
      ...(headers ? { headers } : {}),
      signal: cycle.controller.signal,
    }));
    if (!result.ok) throw statusError(result.status);
    const envelope = parseOnlineUpdateEnvelope(result.data, matchId);
    await applyEnvelope(envelope, generation);
  }

  function backoffDelay(attempt: number): number {
    const exponential = Math.min(maxBackoffMs, baseBackoffMs * 2 ** Math.min(attempt, 16));
    const jitter = exponential * 0.2 * random();
    return Math.min(maxBackoffMs, Math.round(exponential + jitter));
  }

  async function wait(cycle: Cycle, ms: number): Promise<void> {
    if (disposed || stopReason !== null) return;
    await sleep(ms, cycle.delayController.signal);
  }

  async function runLoop(): Promise<void> {
    await loadCursor();
    while (!disposed && stopReason === null) {
      const cycle: Cycle = { controller: new AbortController(), delayController: new AbortController(), woken: false };
      activeCycle = cycle;
      const onLifetimeAbort = (): void => {
        cycle.controller.abort();
        cycle.delayController.abort();
      };
      lifetime.signal.addEventListener('abort', onLifetimeAbort, { once: true });
      try {
        if (transport === 'sse') await runStream(cycle);
        else await runPoll(cycle);
        attempts = 0;
        await wait(cycle, transport === 'sse' ? reconnectDelayMs : pollIntervalMs);
      } catch (error) {
        if (disposed || stopReason !== null) return;
        const failure = classifyFailure(error);
        if (failure.terminal) {
          stop(failure.reason);
          return;
        }
        // An explicit wake is a reconnect, not a failure.
        if (cycle.woken) {
          attempts = 0;
          continue;
        }
        report(error);
        if (transport === 'sse' && mode === 'auto' && prefersPolling(error)) {
          // The stream transport is unavailable or misbehaving. The bounded
          // polling fallback converges on the same canonical snapshot. A
          // temporary service failure is not a fallback: the stream is
          // retried with a bounded backoff.
          transport = 'poll';
          continue;
        }
        await wait(cycle, backoffDelay(attempts));
        attempts += 1;
      } finally {
        lifetime.signal.removeEventListener('abort', onLifetimeAbort);
        activeCycle = null;
      }
    }
  }

  const unsubscribe = session.subscribe((state) => {
    // A removed credential, a changed identity or a disposed session stops
    // the subscriber: the participant is no longer the one it started for.
    if (state.invalidates) stop('session-invalidated');
  });

  return {
    get status() { return status; },
    get transport() { return transport; },
    get cursor() { return cursor; },
    get stopReason() { return stopReason; },
    start() {
      if (disposed || started) return;
      started = true;
      void runLoop();
    },
    wake() {
      if (disposed || stopReason !== null) return;
      // A wake reconnects at once and prefers the stream transport again.
      if (mode === 'auto') transport = 'sse';
      const cycle = activeCycle;
      if (!cycle) return;
      cycle.woken = true;
      cycle.controller.abort();
      cycle.delayController.abort();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop('disposed');
      unsubscribe();
    },
  };
}

/**
 * True when the stream transport itself is the problem.
 *
 * A refused transport or a malformed frame is answered by the compatible
 * polling path. A temporary service failure is not: the stream is retried.
 */
function prefersPolling(error: unknown): boolean {
  if (error instanceof OnlineAuthError) return false;
  // A proxy can fail the stream connection while ordinary JSON requests work.
  if (!(error instanceof OnlineUpdateError)) return true;
  return error.code === 'unsupported'
    || error.code === 'protocol-error'
    || error.code === 'invalid-envelope'
    || error.code === 'invalid-cursor'
    || error.code === 'event-too-large'
    || error.code === 'match-mismatch';
}

/** Maps a service status onto a terminal or a retryable failure. */
function statusError(status: number): Error {
  switch (status) {
    case 400:
      return new TerminalUpdateError('invalid-request', 'The update service refused the request.');
    case 401:
      return new TerminalUpdateError('unauthorized', 'The update service refused the participant credential.');
    case 403:
      return new TerminalUpdateError('forbidden', 'The update service refused the participant.');
    case 404:
      return new TerminalUpdateError('not-found', 'The participant is not a member of this match.');
    case 406:
    case 415:
      return new OnlineUpdateError('unsupported', 'The update service does not offer this transport.');
    default:
      return new OnlineUpdateError('http-error', `The update service answered ${status}.`);
  }
}

/** A failure that ends the subscriber. */
class TerminalUpdateError extends Error {
  readonly reason: OnlineUpdateStopReason;

  constructor(reason: OnlineUpdateStopReason, message: string) {
    super(message);
    this.name = 'TerminalUpdateError';
    this.reason = reason;
  }
}

function classifyFailure(error: unknown): { terminal: boolean; reason: OnlineUpdateStopReason } {
  if (error instanceof TerminalUpdateError) {
    return { terminal: true, reason: error.reason };
  }
  if (error instanceof OnlineAuthError) {
    switch (error.code) {
      case 'credential-cleared':
      case 'credential-changed':
      case 'identity-changed':
        return { terminal: true, reason: 'session-invalidated' };
      case 'no-credential':
        return { terminal: true, reason: 'no-participant' };
      case 'credential-expired':
      case 'invalid-credential':
        return { terminal: true, reason: 'unauthorized' };
      case 'wrong-scope':
        return { terminal: true, reason: 'invalid-request' };
      case 'disposed':
        return { terminal: true, reason: 'disposed' };
      default:
        return { terminal: false, reason: 'disposed' };
    }
  }
  return { terminal: false, reason: 'disposed' };
}

/** Parses a cursor. A cursor is a non-negative safe decimal integer. */
function parseCursor(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OnlineUpdateError('invalid-envelope', `${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Reads a list.
 *
 * The service serializes an empty slice as `null`, so a fresh match carries
 * `null` for its moves. The client reads `null` as an empty list and never
 * invents a value.
 */
function asArray(value: unknown, path: string): unknown[] {
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw new OnlineUpdateError('invalid-envelope', `${path} must be a list.`);
  }
  return value;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new OnlineUpdateError('invalid-envelope', `${path} carries an unexpected field.`);
    }
  }
}

function requireKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const key of keys) {
    if (!(key in value)) {
      throw new OnlineUpdateError('invalid-envelope', `${path} is missing a required field.`);
    }
  }
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new OnlineUpdateError('invalid-envelope', `${path} must be a string.`);
  }
  return value;
}

function asSafeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new OnlineUpdateError('invalid-envelope', `${path} must be a safe integer.`);
  }
  return value;
}

function asPositiveInteger(value: unknown, path: string): number {
  const parsed = asSafeInteger(value, path);
  if (parsed < 1) {
    throw new OnlineUpdateError('invalid-envelope', `${path} must be a positive integer.`);
  }
  return parsed;
}

function asNonNegativeInteger(value: unknown, path: string): number {
  const parsed = asSafeInteger(value, path);
  if (parsed < 0) {
    throw new OnlineUpdateError('invalid-envelope', `${path} must not be negative.`);
  }
  return parsed;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new OnlineUpdateError('invalid-envelope', `${path} must be a boolean.`);
  }
  return value;
}

function asSeat(value: unknown, path: string): Seat {
  if (value !== 'white' && value !== 'black') {
    throw new OnlineUpdateError('invalid-envelope', `${path} must be white or black.`);
  }
  return value;
}

function asNullableSeat(value: unknown, path: string): Seat | null {
  if (value === null) return null;
  return asSeat(value, path);
}

function asTimestamp(value: unknown, path: string): string {
  const text = asString(value, path);
  if (Number.isNaN(Date.parse(text))) {
    throw new OnlineUpdateError('invalid-envelope', `${path} must be a timestamp.`);
  }
  return text;
}

function asNullableTimestamp(value: unknown, path: string): string | null {
  if (value === null) return null;
  return asTimestamp(value, path);
}

function asFen(value: unknown, path: string): string {
  const text = asString(value, path);
  if (text.length < 4 || text.length > 128 || text.split(' ').length < 6) {
    throw new OnlineUpdateError('invalid-envelope', `${path} must be a FEN.`);
  }
  return text;
}

function asMatchStatus(value: unknown, path: string): MatchStatus {
  const text = asString(value, path);
  if (text !== 'active' && text !== 'completed' && text !== 'aborted') {
    throw new OnlineUpdateError('invalid-envelope', `${path} must be a match status.`);
  }
  return text;
}

function parseTimeControl(value: unknown, path: string): TimeControl {
  const object = asObject(value, path);
  onlyKeys(object, ['startingTimeMs', 'incrementMs'], path);
  requireKeys(object, ['startingTimeMs', 'incrementMs'], path);
  const startingTimeMs = asPositiveInteger(object.startingTimeMs, `${path}.startingTimeMs`);
  const incrementMs = asNonNegativeInteger(object.incrementMs, `${path}.incrementMs`);
  if (startingTimeMs > 86_400_000 || incrementMs > 60_000) {
    throw new OnlineUpdateError('invalid-envelope', `${path} is out of range.`);
  }
  return { startingTimeMs, incrementMs };
}

function parseControl(value: unknown, path: string): SeatControl {
  const object = asObject(value, path);
  onlyKeys(object, ['kind', 'modelLabel'], path);
  requireKeys(object, ['kind'], path);
  const kind = asString(object.kind, `${path}.kind`);
  if (kind !== 'human' && kind !== 'agent' && kind !== 'engine') {
    throw new OnlineUpdateError('invalid-envelope', `${path}.kind must be a control kind.`);
  }
  if (kind === 'human') {
    if ('modelLabel' in object) {
      throw new OnlineUpdateError('invalid-envelope', `${path}.kind cannot declare a model.`);
    }
    return { kind };
  }
  const label = asString(object.modelLabel, `${path}.modelLabel`);
  if (label.length < 1 || label.length > 64) {
    throw new OnlineUpdateError('invalid-envelope', `${path}.modelLabel is invalid.`);
  }
  return { kind, modelLabel: label };
}

function parseResult(value: unknown, path: string): Result {
  const object = asObject(value, path);
  onlyKeys(object, ['kind', 'winner', 'reason'], path);
  requireKeys(object, ['kind', 'winner', 'reason'], path);
  const kind = asString(object.kind, `${path}.kind`);
  const reason = asString(object.reason, `${path}.reason`);
  const winner = object.winner === null ? null : asSeat(object.winner, `${path}.winner`);
  if (kind === 'win') {
    if (winner === null) {
      throw new OnlineUpdateError('invalid-envelope', `${path}.winner must name the winning seat.`);
    }
    return { kind, winner, reason: reason as Result['reason'] };
  }
  if (kind === 'draw' || kind === 'abort') {
    if (winner !== null) {
      throw new OnlineUpdateError('invalid-envelope', `${path}.winner must be empty.`);
    }
    return { kind, winner, reason: reason as Result['reason'] };
  }
  throw new OnlineUpdateError('invalid-envelope', `${path}.kind is not a result kind.`);
}

function parseClock(value: unknown, path: string): ClockState {
  const object = asObject(value, path);
  onlyKeys(
    object,
    [
      'whiteMs',
      'blackMs',
      'activeSeat',
      'activeSince',
      'deadlineAt',
      'whiteMoved',
      'blackMoved',
      'turnNumber',
      'replySeat',
      'replyDeadlineAt',
    ],
    path,
  );
  requireKeys(
    object,
    [
      'whiteMs',
      'blackMs',
      'activeSeat',
      'activeSince',
      'deadlineAt',
      'whiteMoved',
      'blackMoved',
      'turnNumber',
      'replySeat',
      'replyDeadlineAt',
    ],
    path,
  );
  return {
    whiteMs: asNonNegativeInteger(object.whiteMs, `${path}.whiteMs`),
    blackMs: asNonNegativeInteger(object.blackMs, `${path}.blackMs`),
    activeSeat: asNullableSeat(object.activeSeat, `${path}.activeSeat`),
    activeSince: asNullableTimestamp(object.activeSince, `${path}.activeSince`),
    deadlineAt: asNullableTimestamp(object.deadlineAt, `${path}.deadlineAt`),
    whiteMoved: asBoolean(object.whiteMoved, `${path}.whiteMoved`),
    blackMoved: asBoolean(object.blackMoved, `${path}.blackMoved`),
    turnNumber: asNonNegativeInteger(object.turnNumber, `${path}.turnNumber`),
    replySeat: asNullableSeat(object.replySeat, `${path}.replySeat`),
    replyDeadlineAt: asNullableTimestamp(object.replyDeadlineAt, `${path}.replyDeadlineAt`),
  };
}

function parseMoves(value: unknown): readonly Move[] {
  // The service serializes an empty move list as `null`, because a fresh
  // match has no move slice yet. The client reads both spellings as an empty
  // list.
  const entries = asArray(value, 'snapshot.moves');
  return entries.map((entry, index) => {
    const path = `snapshot.moves[${index}]`;
    const object = asObject(entry, path);
    onlyKeys(object, ['version', 'seat', 'uci', 'san', 'resultingFen'], path);
    requireKeys(object, ['version', 'seat', 'uci', 'san', 'resultingFen'], path);
    const uci = asString(object.uci, `${path}.uci`);
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) {
      throw new OnlineUpdateError('invalid-envelope', `${path}.uci is invalid.`);
    }
    const san = asString(object.san, `${path}.san`);
    if (san.length < 1 || san.length > 16) {
      throw new OnlineUpdateError('invalid-envelope', `${path}.san is invalid.`);
    }
    return {
      version: asPositiveInteger(object.version, `${path}.version`),
      seat: asSeat(object.seat, `${path}.seat`),
      uci,
      san,
      resultingFen: asFen(object.resultingFen, `${path}.resultingFen`),
    };
  });
}

function parseSeats(value: unknown): readonly OnlineMatchSeatView[] {
  const entries = asArray(value, 'snapshot.seats');
  const seats = entries.map((entry, index) => {
    const path = `snapshot.seats[${index}]`;
    const object = asObject(entry, path);
    onlyKeys(
      object,
      ['seat', 'publicLabel', 'control', 'controlEpoch', 'illegalAttemptsSpent', 'formatCorrectionsSpent'],
      path,
    );
    requireKeys(
      object,
      ['seat', 'publicLabel', 'control', 'controlEpoch', 'illegalAttemptsSpent', 'formatCorrectionsSpent'],
      path,
    );
    const label = asString(object.publicLabel, `${path}.publicLabel`);
    if (label.length < 1 || label.length > 64) {
      throw new OnlineUpdateError('invalid-envelope', `${path}.publicLabel is invalid.`);
    }
    return {
      seat: asSeat(object.seat, `${path}.seat`),
      publicLabel: label,
      control: parseControl(object.control, `${path}.control`),
      controlEpoch: asPositiveInteger(object.controlEpoch, `${path}.controlEpoch`),
      illegalAttemptsSpent: asNonNegativeInteger(object.illegalAttemptsSpent, `${path}.illegalAttemptsSpent`),
      formatCorrectionsSpent: asNonNegativeInteger(object.formatCorrectionsSpent, `${path}.formatCorrectionsSpent`),
    };
  });
  const seen = new Set<Seat>();
  for (const seat of seats) {
    if (seen.has(seat.seat)) {
      throw new OnlineUpdateError('invalid-envelope', 'snapshot.seats repeats a seat.');
    }
    seen.add(seat.seat);
  }
  return seats;
}

function parseOffers(value: unknown): readonly OnlineOfferView[] {
  const entries = asArray(value, 'snapshot.pendingOffers');
  return entries.map((entry, index) => {
    const path = `snapshot.pendingOffers[${index}]`;
    const object = asObject(entry, path);
    onlyKeys(object, ['offerId', 'kind', 'seat', 'targetVersion', 'baseVersion', 'createdAt'], path);
    requireKeys(object, ['offerId', 'kind', 'seat', 'targetVersion', 'baseVersion', 'createdAt'], path);
    const kind = asString(object.kind, `${path}.kind`);
    if (kind !== 'draw' && kind !== 'takeback') {
      throw new OnlineUpdateError('invalid-envelope', `${path}.kind is not an offer kind.`);
    }
    const targetVersion = object.targetVersion === null
      ? null
      : asPositiveInteger(object.targetVersion, `${path}.targetVersion`);
    if ((kind === 'takeback') !== (targetVersion !== null)) {
      throw new OnlineUpdateError('invalid-envelope', `${path} does not match its target version.`);
    }
    const offerId = asString(object.offerId, `${path}.offerId`);
    if (offerId.length < 1 || offerId.length > 64) {
      throw new OnlineUpdateError('invalid-envelope', `${path}.offerId is invalid.`);
    }
    return {
      offerId,
      kind: kind as OfferKind,
      seat: asSeat(object.seat, `${path}.seat`),
      targetVersion,
      baseVersion: asPositiveInteger(object.baseVersion, `${path}.baseVersion`),
      createdAt: asTimestamp(object.createdAt, `${path}.createdAt`),
    };
  });
}
