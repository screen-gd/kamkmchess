import { createHash } from 'node:crypto';
import {
  parsePosition,
  PositionValidationError,
  repetitionIdentity,
  restoreRepetitionLedger,
  type CoordinateMove,
  type Position,
  type Promotion,
  type RepetitionLedger,
} from '../rules/index.js';

/**
 * The stdin/stdout contract between the Go match authority and the private
 * rules worker. Bump the protocol for shape changes and the rules-policy
 * version for behavioural changes that can alter accepted results.
 *
 * `online-rules/1` is the shared online policy identifier: the October 18
 * bounded ending policy evaluated with chessops 0.15.1. It intentionally
 * matches `ONLINE_DEFAULT_RULES_POLICY_VERSION` in `src/online/contracts.ts`
 * and `online.DefaultRulesPolicyVersion` in Go.
 */
export const RULES_WORKER_PROTOCOL_VERSION = 1 as const;
export const RULES_POLICY_VERSION = 'online-rules/1';
export const ENGINE_NAME = 'chessops';
export const ENGINE_VERSION = '0.15.1';

export const LIMITS = Object.freeze({
  maxRequestBytes: 256 * 1024,
  maxResponseBytes: 1024 * 1024,
  maxFenLength: 256,
  maxRequestIdLength: 128,
  maxHistoryFens: 4096,
  maxLedgerEntries: 4096,
  maxIdentityLength: 256,
  maxOccurrencesLength: 40,
  maxMatchVersion: Number.MAX_SAFE_INTEGER,
});

export type WorkerErrorCode =
  | 'malformed-json'
  | 'request-too-large'
  | 'invalid-request'
  | 'unsupported-protocol-version'
  | 'rules-policy-version-mismatch'
  | 'invalid-fen'
  | 'invalid-history'
  | 'history-mismatch'
  | 'illegal-move'
  | 'position-terminal'
  | 'response-too-large'
  | 'internal-error';

export class RulesWorkerRequestError extends Error {
  readonly code: WorkerErrorCode;

  constructor(code: WorkerErrorCode, message: string) {
    super(message);
    this.name = 'RulesWorkerRequestError';
    this.code = code;
  }
}

export interface MoveIntent {
  readonly kind: 'move';
  readonly move: CoordinateMove;
}

export interface TimeoutIntent {
  readonly kind: 'timeout';
  readonly expiredColor: 'w' | 'b';
}

export type RulesWorkerIntent = MoveIntent | TimeoutIntent;

export interface ParsedRulesWorkerRequest {
  readonly protocolVersion: typeof RULES_WORKER_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly rulesPolicyVersion: string;
  readonly matchVersion: number;
  readonly fen: string;
  readonly position: Position;
  /**
   * Ordered positions from the starting FEN through the evaluated position.
   * The worker owns repetition-identity derivation so the Go authority never
   * re-implements chess rules.
   */
  readonly history: readonly string[];
  readonly repetition: RepetitionLedger;
  readonly intent: RulesWorkerIntent | null;
}

export interface PieceCounts {
  readonly p: number;
  readonly n: number;
  readonly b: number;
  readonly r: number;
  readonly q: number;
  readonly k: number;
}

export interface MaterialSummary {
  readonly white: PieceCounts;
  readonly black: PieceCounts;
  readonly total: number;
}

const PROMOTIONS: readonly Promotion[] = ['q', 'r', 'b', 'n'];
const SQUARE_PATTERN = /^[a-h][1-8]$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

function fail(code: WorkerErrorCode, message: string): never {
  throw new RulesWorkerRequestError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail('invalid-request', `${label} must be an object.`);
  return value;
}

function expectExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('invalid-request', `${label} has an unsupported field.`);
  }
}

function expectString(value: unknown, code: WorkerErrorCode, label: string): string {
  if (typeof value !== 'string') fail(code, `${label} must be a string.`);
  return value;
}

export function rejectionResponse(
  requestId: string | null,
  code: WorkerErrorCode,
  message: string,
): {
  readonly protocolVersion: typeof RULES_WORKER_PROTOCOL_VERSION;
  readonly status: 'rejected';
  readonly requestId: string | null;
  readonly code: WorkerErrorCode;
  readonly message: string;
} {
  return Object.freeze({ protocolVersion: RULES_WORKER_PROTOCOL_VERSION, status: 'rejected', requestId, code, message });
}

function parseFen(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > LIMITS.maxFenLength ||
    /[\r\n\0]/.test(value)
  ) {
    fail('invalid-fen', `${label} must be one bounded single-line FEN string.`);
  }
  return value;
}

/**
 * Rebuilds the canonical repetition ledger from the authoritative position
 * history. Every entry is parsed with the pinned rules engine, and the final
 * entry must be byte-identical to the evaluated FEN so a truncated or reordered
 * history cannot silently change repetition or fifty-move facts.
 */
function parseHistory(value: unknown, fen: string): { history: string[]; repetition: RepetitionLedger } {
  if (!Array.isArray(value)) fail('invalid-history', 'history must be an array of FEN strings.');
  if (value.length < 1 || value.length > LIMITS.maxHistoryFens) {
    fail('invalid-history', 'history entry count is outside the supported bounds.');
  }

  const history: string[] = [];
  const counts = new Map<string, string>();
  for (let index = 0; index < value.length; index += 1) {
    const entryFen = parseFen(value[index], `history[${index}]`);
    const position = parsePositionOrFail(entryFen);
    history.push(entryFen);
    const identity = repetitionIdentity(position);
    counts.set(identity, (BigInt(counts.get(identity) ?? '0') + 1n).toString());
  }

  if (history[history.length - 1] !== fen) fail('history-mismatch', 'history must end with the evaluated FEN.');

  const repetition = restoreRepetitionLedger({
    version: 1,
    entries: [...counts].map(([identity, occurrences]) => ({ identity, occurrences })),
  });
  return { history, repetition };
}

function parsePositionOrFail(fen: string): Position {
  try {
    return parsePosition(fen);
  } catch (error) {
    if (error instanceof PositionValidationError) {
      const issue = error.issues[0];
      fail('invalid-fen', issue === undefined ? 'FEN was rejected.' : `FEN rejected: ${issue.field}/${issue.code}.`);
    }
    fail('invalid-fen', 'FEN could not be parsed by the rules engine.');
  }
}

function parseIntent(value: unknown): RulesWorkerIntent {
  const intent = expectRecord(value, 'intent');
  const kind = expectString(intent.kind, 'invalid-request', 'intent.kind');

  if (kind === 'move') {
    expectExactKeys(intent, ['kind', 'from', 'to', 'promotion'], 'move intent');
    const from = expectString(intent.from, 'invalid-request', 'intent.from');
    const to = expectString(intent.to, 'invalid-request', 'intent.to');
    if (!SQUARE_PATTERN.test(from) || !SQUARE_PATTERN.test(to)) {
      fail('invalid-request', 'Move intent squares must be board coordinates.');
    }
    if (intent.promotion === undefined) {
      return Object.freeze({ kind: 'move', move: Object.freeze({ from: from as CoordinateMove['from'], to: to as CoordinateMove['to'] }) });
    }
    if (typeof intent.promotion !== 'string' || !PROMOTIONS.includes(intent.promotion as Promotion)) {
      fail('invalid-request', 'Move intent promotion must be q, r, b, or n.');
    }
    const promotion = intent.promotion as Promotion;
    return Object.freeze({
      kind: 'move',
      move: Object.freeze({ from: from as CoordinateMove['from'], to: to as CoordinateMove['to'], promotion }),
    });
  }

  if (kind === 'timeout') {
    expectExactKeys(intent, ['kind', 'expiredColor'], 'timeout intent');
    if (intent.expiredColor !== 'w' && intent.expiredColor !== 'b') {
      fail('invalid-request', 'Timeout intent needs a w or b expired color.');
    }
    return Object.freeze({ kind: 'timeout', expiredColor: intent.expiredColor });
  }

  return fail('invalid-request', 'Intent kind must be move or timeout.');
}

export function parseRulesWorkerRequest(value: unknown): ParsedRulesWorkerRequest {
  const request = expectRecord(value, 'request');
  expectExactKeys(
    request,
    ['protocolVersion', 'requestId', 'rulesPolicyVersion', 'matchVersion', 'fen', 'history', 'intent'],
    'request',
  );

  if (request.protocolVersion !== RULES_WORKER_PROTOCOL_VERSION) {
    fail('unsupported-protocol-version', `Protocol version must be ${RULES_WORKER_PROTOCOL_VERSION}.`);
  }
  if (request.rulesPolicyVersion !== RULES_POLICY_VERSION) {
    fail('rules-policy-version-mismatch', `Rules policy version must be ${RULES_POLICY_VERSION}.`);
  }

  const requestId = expectString(request.requestId, 'invalid-request', 'requestId');
  if (requestId.length === 0 || requestId.length > LIMITS.maxRequestIdLength || !REQUEST_ID_PATTERN.test(requestId)) {
    fail('invalid-request', 'requestId must be a bounded opaque correlation token.');
  }

  if (
    typeof request.matchVersion !== 'number' ||
    !Number.isSafeInteger(request.matchVersion) ||
    request.matchVersion < 1 ||
    request.matchVersion > LIMITS.maxMatchVersion
  ) {
    fail('invalid-request', 'matchVersion must be a positive safe integer.');
  }

  const fen = parseFen(request.fen, 'fen');
  const position = parsePositionOrFail(fen);
  const { history, repetition } = parseHistory(request.history, fen);

  const intent = request.intent === undefined ? null : parseIntent(request.intent);

  return Object.freeze({
    protocolVersion: RULES_WORKER_PROTOCOL_VERSION,
    requestId,
    rulesPolicyVersion: RULES_POLICY_VERSION,
    matchVersion: request.matchVersion,
    fen,
    position,
    history: Object.freeze(history),
    repetition,
    intent,
  });
}

function canonicalIntent(intent: RulesWorkerIntent | null): unknown {
  if (intent === null) return null;
  if (intent.kind === 'move') {
    return {
      kind: intent.kind,
      from: intent.move.from,
      to: intent.move.to,
      promotion: intent.move.promotion ?? null,
    };
  }
  return { kind: intent.kind, expiredColor: intent.expiredColor };
}

/**
 * Hashes only semantic input. requestId is correlation, so the same board and
 * version keep the same fingerprint across retries.
 */
export function inputFingerprint(request: ParsedRulesWorkerRequest): string {
  const canonical = JSON.stringify({
    protocolVersion: request.protocolVersion,
    rulesPolicyVersion: request.rulesPolicyVersion,
    matchVersion: request.matchVersion,
    fen: request.fen,
    history: request.history,
    intent: canonicalIntent(request.intent),
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

export function materialSummary(position: Position): MaterialSummary {
  const white: Record<keyof PieceCounts, number> = { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 };
  const black: Record<keyof PieceCounts, number> = { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 };
  for (const piece of position.pieces) {
    const counts = piece.color === 'w' ? white : black;
    counts[piece.type] += 1;
  }
  return Object.freeze({
    white: Object.freeze(white),
    black: Object.freeze(black),
    total: position.pieces.length,
  });
}
