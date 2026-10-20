import {
  applyCoordinateMove,
  IllegalMoveError,
  observeEndingFacts,
  recordPosition,
  repetitionIdentity,
  timeoutWinner,
  type EndingFacts,
  type Position,
  type RepetitionLedger,
} from '../rules/index.js';
import {
  ENGINE_NAME,
  ENGINE_VERSION,
  inputFingerprint,
  LIMITS,
  materialSummary,
  parseRulesWorkerRequest,
  rejectionResponse,
  RULES_POLICY_VERSION,
  RULES_WORKER_PROTOCOL_VERSION,
  RulesWorkerRequestError,
  type MaterialSummary,
  type ParsedRulesWorkerRequest,
  type WorkerErrorCode,
} from './protocol.js';

export type WorkerEnding =
  | 'checkmate'
  | 'stalemate'
  | 'insufficient-material'
  | 'threefold-repetition'
  | 'hundred-halfmoves'
  | 'none';

export interface WorkerFacts extends Omit<EndingFacts, 'ending'> {
  /**
   * Terminal outcome in policy order: mate, stalemate, dead position,
   * threefold repetition, then the hundred-halfmove boundary. The raw
   * `observeEndingFacts` ending omits dead positions, so the worker resolves
   * the authoritative precedence once and Go only maps a known string.
   */
  readonly ending: WorkerEnding;
  readonly material: MaterialSummary;
  readonly timeoutWinner: 'white' | 'black' | 'draw' | null;
}

export function policyEnding(facts: EndingFacts): WorkerEnding {
  if (facts.checkmate) return 'checkmate';
  if (facts.stalemate) return 'stalemate';
  if (facts.insufficientMaterial) return 'insufficient-material';
  if (facts.thirdRepetition) return 'threefold-repetition';
  if (facts.hundredHalfmoves) return 'hundred-halfmoves';
  return 'none';
}

export interface RepetitionSnapshot {
  readonly version: 1;
  readonly entries: readonly { readonly identity: string; readonly occurrences: string }[];
}

export interface Candidate {
  readonly move: {
    readonly from: string;
    readonly to: string;
    readonly promotion?: string;
  };
  readonly san: string;
  readonly resultingFen: string;
  readonly ending: WorkerFacts;
  readonly repetition: RepetitionSnapshot;
  readonly material: MaterialSummary;
}

export interface OkRulesWorkerResponse {
  readonly protocolVersion: typeof RULES_WORKER_PROTOCOL_VERSION;
  readonly status: 'ok';
  readonly requestId: string;
  readonly matchVersion: number;
  readonly rulesPolicyVersion: string;
  readonly inputFingerprint: string;
  readonly engine: { readonly name: string; readonly version: string };
  readonly input: {
    readonly fen: string;
    readonly identity: string;
    readonly repetitionCount: string;
  };
  readonly facts: WorkerFacts;
  readonly candidate: Candidate | null;
}

export interface RejectedRulesWorkerResponse {
  readonly protocolVersion: typeof RULES_WORKER_PROTOCOL_VERSION;
  readonly status: 'rejected';
  readonly requestId: string | null;
  readonly code: WorkerErrorCode;
  readonly message: string;
}

export type RulesWorkerResponse = OkRulesWorkerResponse | RejectedRulesWorkerResponse;

function snapshot(ledger: RepetitionLedger): RepetitionSnapshot {
  return Object.freeze({
    version: 1 as const,
    entries: Object.freeze(ledger.entries.map((entry) => Object.freeze({
      identity: entry.identity,
      occurrences: entry.occurrences,
    }))),
  });
}

function factsFor(
  position: Position,
  ledger: RepetitionLedger,
  timeout: 'white' | 'black' | 'draw' | null,
): WorkerFacts {
  const ending = observeEndingFacts(position, ledger);
  return Object.freeze({
    ...ending,
    ending: policyEnding(ending),
    material: materialSummary(position),
    timeoutWinner: timeout,
  });
}

function intentMove(parsed: ParsedRulesWorkerRequest): Candidate | null {
  const intent = parsed.intent;
  if (intent === null || intent.kind !== 'move') return null;

  const source = observeEndingFacts(parsed.position, parsed.repetition);
  if (policyEnding(source) !== 'none') {
    throw new RulesWorkerRequestError('position-terminal', `The position already has ending ${policyEnding(source)}.`);
  }

  const movingPiece = parsed.position.pieces.find((piece) => piece.square === intent.move.from);
  const targetRank = intent.move.to[1];
  const promotionRank = targetRank === '8' || targetRank === '1';
  if (movingPiece?.type === 'p' && promotionRank && intent.move.promotion === undefined) {
    throw new RulesWorkerRequestError('illegal-move', 'A pawn move to the last rank needs a promotion piece.');
  }
  if (intent.move.promotion !== undefined && (movingPiece?.type !== 'p' || !promotionRank)) {
    throw new RulesWorkerRequestError('illegal-move', 'Only a pawn on the last rank can promote.');
  }

  let transition;
  try {
    transition = applyCoordinateMove(parsed.position, intent.move);
  } catch (error) {
    if (error instanceof IllegalMoveError) {
      throw new RulesWorkerRequestError('illegal-move', 'The requested move is not legal in this position.');
    }
    throw error;
  }

  const nextPosition = transition.position;
  const nextLedger = recordPosition(parsed.repetition, nextPosition);
  const nextFacts = factsFor(nextPosition, nextLedger, null);
  const move = transition.move;
  return Object.freeze({
    move: Object.freeze({
      from: move.from,
      to: move.to,
      ...(move.promotion === undefined ? {} : { promotion: move.promotion }),
    }),
    san: transition.san,
    resultingFen: nextPosition.fen,
    ending: nextFacts,
    repetition: snapshot(nextLedger),
    material: materialSummary(nextPosition),
  });
}

export function evaluateRulesRequest(parsed: ParsedRulesWorkerRequest): OkRulesWorkerResponse {
  const timedOut = parsed.intent !== null && parsed.intent.kind === 'timeout'
    ? timeoutWinner(parsed.position, parsed.intent.expiredColor)
    : null;
  const facts = factsFor(parsed.position, parsed.repetition, timedOut);
  const candidate = intentMove(parsed);

  return Object.freeze({
    protocolVersion: RULES_WORKER_PROTOCOL_VERSION,
    status: 'ok',
    requestId: parsed.requestId,
    matchVersion: parsed.matchVersion,
    rulesPolicyVersion: RULES_POLICY_VERSION,
    inputFingerprint: inputFingerprint(parsed),
    engine: Object.freeze({ name: ENGINE_NAME, version: ENGINE_VERSION }),
    input: Object.freeze({
      fen: parsed.fen,
      identity: repetitionIdentity(parsed.position),
      repetitionCount: facts.repetitionCount,
    }),
    facts,
    candidate,
  });
}

/**
 * Converts one protocol line into one response. A rejected line never carries
 * a candidate, so a caller cannot mistake a partial evaluation for a commit.
 */
export function handleRulesWorkerLine(line: string): RulesWorkerResponse {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return rejectionResponse(null, 'malformed-json', 'Request line is not valid JSON.');
  }

  try {
    return evaluateRulesRequest(parseRulesWorkerRequest(value));
  } catch (error) {
    if (error instanceof RulesWorkerRequestError) {
      return rejectionResponse(requestIdFrom(value), error.code, error.message);
    }
    return rejectionResponse(requestIdFrom(value), 'internal-error', 'The rules worker could not evaluate this request.');
  }
}

function requestIdFrom(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const requestId = (value as { requestId?: unknown }).requestId;
  return typeof requestId === 'string' &&
    requestId.length > 0 &&
    requestId.length <= LIMITS.maxRequestIdLength &&
    /^[A-Za-z0-9._:-]+$/.test(requestId)
    ? requestId
    : null;
}

export function serializeRulesWorkerResponse(response: RulesWorkerResponse): string {
  const text = JSON.stringify(response);
  if (Buffer.byteLength(text, 'utf8') <= LIMITS.maxResponseBytes) return text;
  return JSON.stringify(rejectionResponse(
    response.requestId,
    'response-too-large',
    'Response exceeds the protocol size limit.',
  ));
}
