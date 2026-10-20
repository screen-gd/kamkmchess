/**
 * Versioned shared contracts for casual online play (KHA-65).
 *
 * These types mirror `backend/online/contracts.go`. The Go service is the only
 * writer; clients may propose commands and read allowlisted public projections.
 * Nothing here accepts arbitrary state, SQL, credentials, or private routes.
 */

export const ONLINE_CONTRACTS_SCHEMA_VERSION = 2;
export const ONLINE_RULES_INPUT_SCHEMA_VERSION = 1;
export const ONLINE_PUBLIC_PROJECTION_SCHEMA_VERSION = 1;
export const ONLINE_DEFAULT_RULES_POLICY_VERSION = 'online-rules/1';

export type Seat = 'white' | 'black';
export type ParticipantKind = 'account' | 'guest';
export type ControlKind = 'human' | 'agent' | 'engine';
export type MatchStatus = 'active' | 'completed' | 'aborted';
export type ResultKind = 'win' | 'draw' | 'abort';
export type ResultReason =
  | 'checkmate'
  | 'resignation'
  | 'timeout'
  | 'abandonment'
  | 'stalemate'
  | 'repetition'
  | 'fifty_move'
  | 'insufficient_material'
  | 'agreement'
  | 'abort'
  | 'opening_reply_timeout'
  | 'illegal_move';
export type EventKind =
  | 'match_created'
  | 'move'
  | 'resign'
  | 'abort'
  | 'cancel'
  | 'control_change'
  | 'timeout'
  | 'replay_removed'
  | 'draw_agreement'
  | 'takeback_accepted'
  | 'offer_created'
  | 'recovery_attempt'
  | 'illegal_move_loss';
export type ReceiptOutcome = 'accepted' | 'deadline_expired' | 'replay_removed' | 'opening_expired';
export type QueueStatus = 'waiting' | 'cancelled' | 'assigned';
export type LeaseStatus = 'active' | 'revoked' | 'expired';
export type OfferKind = 'draw' | 'takeback';
export type RecoveryAttemptKind = 'illegal_move' | 'formatting_correction';

export interface ParticipantRef {
  kind: ParticipantKind;
  id: string;
}

/** Declared controller. modelLabel is a chosen public label, never a route ID. */
export interface SeatControl {
  kind: ControlKind;
  modelLabel?: string;
}

export interface TimeControl {
  startingTimeMs: number;
  incrementMs: number;
}

export interface ClockState {
  whiteMs: number;
  blackMs: number;
  activeSeat: Seat | null;
  activeSince: string | null;
  deadlineAt: string | null;
  whiteMoved: boolean;
  blackMoved: boolean;
  turnNumber: number;
  /**
   * The seat that owes the opening reply. It is set only between the first
   * accepted move of the match and the responder's first accepted reply.
   * While it is set no main clock runs.
   */
  replySeat: Seat | null;
  /** The end of the opening reply window. */
  replyDeadlineAt: string | null;
}

export interface Result {
  kind: ResultKind;
  winner: Seat | null;
  reason: ResultReason;
}

export interface Move {
  version: number;
  seat: Seat;
  uci: string;
  san: string;
  resultingFen: string;
}

export interface Event {
  schemaVersion: number;
  matchId: string;
  version: number;
  kind: EventKind;
  seat?: Seat;
  controlEpoch: number;
  decisionAt: string;
  acceptedAt: string;
  move?: Move;
  result?: Result;
  control?: SeatControl;
  /** The pending offer an `offer_created` event created. */
  offer?: Offer;
  /** The exact position an accepted takeback restored. */
  takebackTargetVersion?: number;
  /** The spent recovery attempt an event records. */
  recoveryAttempt?: RecoveryAttemptKind;
}

export interface CreateSeat {
  participant: ParticipantRef;
  publicLabel: string;
  control: SeatControl;
}

export interface CreateMatchSetup {
  variant: 'orthodox';
  startingFen: string;
  timeControl: TimeControl;
  seats: { white: CreateSeat; black: CreateSeat };
}

/**
 * `cancel` aborts the match while the seat has never had an accepted move and
 * resigns afterwards. A takeback that removes the move from the current line
 * does not turn a later cancellation back into an abort.
 */
export type OnlineAction =
  | { kind: 'create_match'; setup: CreateMatchSetup }
  | { kind: 'submit_move'; move: string }
  | { kind: 'resign' }
  | { kind: 'cancel' }
  | { kind: 'set_control'; control: SeatControl }
  | { kind: 'remove_public_replay'; reason: 'owner_request' | 'erasure_request' }
  | { kind: 'offer_draw' }
  | { kind: 'accept_draw'; offerId: string }
  | { kind: 'offer_takeback'; targetVersion: number }
  | { kind: 'accept_takeback'; offerId: string }
  | { kind: 'record_recovery_attempt'; attempt: RecoveryAttemptKind };

export interface Command {
  schemaVersion: number;
  matchId: string;
  operationId: string;
  expectedVersion: number;
  seat: Seat;
  controlEpoch: number;
  action: OnlineAction;
}

export interface Receipt {
  schemaVersion: number;
  matchId: string;
  operationId: string;
  outcome: ReceiptOutcome;
  version: number;
  controlEpoch: number;
  decidedAt: string;
  event?: Event;
  result?: Result;
}

export interface MatchSeat {
  seat: Seat;
  participant: ParticipantRef;
  publicLabel: string;
  control: SeatControl;
  controlEpoch: number;
  /** The recovery budget already spent in this seat's current turn. */
  illegalAttemptsSpent: number;
  formatCorrectionsSpent: number;
}

/**
 * A pending draw or takeback offer. An offer is part of the versioned match
 * state: creating it advances the match version without changing the
 * position, the turn or the clocks.
 */
export interface Offer {
  offerId: string;
  matchId: string;
  kind: OfferKind;
  seat: Seat;
  /** The exact position a takeback offer would restore. */
  targetVersion: number | null;
  /** The match version the offer produced. */
  baseVersion: number;
  createdAt: string;
}

/**
 * Server-side match view. It carries internal participant references for
 * authorization and must not be used as a public replay DTO.
 */
export interface MatchSnapshot {
  schemaVersion: number;
  matchId: string;
  variant: 'orthodox';
  startingFen: string;
  positionFen: string;
  timeControl: TimeControl;
  version: number;
  controlEpoch: number;
  rulesPolicyVersion: string;
  status: MatchStatus;
  result: Result | null;
  seats: MatchSeat[];
  clock: ClockState;
  moves: Move[];
  offers: Offer[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface RulesInput {
  schemaVersion: number;
  rulesPolicyVersion: string;
  matchId: string;
  version: number;
  controlEpoch: number;
  inputHash: string;
  startingFen: string;
  positionFen: string;
  proposedMove?: string;
  timeControl: TimeControl;
  moves: Move[];
  activeSeat: Seat | null;
}

export interface Candidate {
  schemaVersion: number;
  evaluatedVersion: number;
  evaluatedInputHash: string;
  controlEpoch: number;
  move?: Move;
  result?: Result;
}

/**
 * Trusted rules-process adjudication of a flag fall. `winner: null` means the
 * position has insufficient mating material, so the timeout is a draw. Facts
 * are bound to the evaluated rules input so the Go writer can reject them after
 * any concurrent change.
 */
export interface TimeoutFacts {
  schemaVersion: number;
  evaluatedVersion: number;
  evaluatedInputHash: string;
  controlEpoch: number;
  expiredSeat: Seat;
  winner: Seat | null;
}

export interface PublicParticipant {
  seat: Seat;
  publicLabel: string;
  control: SeatControl;
}

export interface PublicMove {
  version: number;
  seat: Seat;
  uci: string;
  san: string;
}

/** Allowlisted projection. No owner IDs, operation IDs, routes, or credentials. */
export interface PublicProjection {
  schemaVersion: number;
  matchId: string;
  variant: 'orthodox';
  startingFen: string;
  timeControl: TimeControl;
  participants: PublicParticipant[];
  moves: PublicMove[];
  result: Result;
  rulesPolicyVersion: string;
  completedAt: string;
}

export interface QueueEntry {
  schemaVersion: number;
  entryId: string;
  owner: ParticipantRef;
  control: SeatControl;
  timeControl: TimeControl;
  status: QueueStatus;
  version: number;
  readyAt: string | null;
  cutoffAt: string | null;
  assignedMatchId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunnerLease {
  schemaVersion: number;
  leaseId: string;
  matchId: string;
  seat: Seat;
  controlEpoch: number;
  generation: number;
  runnerId: string;
  status: LeaseStatus;
  acquiredAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface DeletionMarker {
  schemaVersion: number;
  markerId: string;
  kind: 'replay_removal' | 'account_anonymization' | 'match_removal';
  subjectKind: 'account' | 'guest' | 'match';
  subjectId: string;
  matchId: string | null;
  reason: 'owner_request' | 'erasure_request' | 'account_deletion';
  requestedAt: string;
  appliedAt: string;
}

export class OnlineContractError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${path}: ${message}`);
    this.name = 'OnlineContractError';
    this.path = path;
  }
}

type JsonObject = Record<string, unknown>;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
const UCI_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function object(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OnlineContractError('expected an object', path);
  }
  return value as JsonObject;
}

function onlyKeys(value: JsonObject, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new OnlineContractError(`unexpected field ${key}`, path);
    }
  }
}

function requiredKeys(value: JsonObject, keys: readonly string[], path: string): void {
  for (const key of keys) {
    if (!(key in value)) {
      throw new OnlineContractError(`missing field ${key}`, path);
    }
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new OnlineContractError('expected a string', path);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return stringValue(value, path);
}

function idValue(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (!ID_PATTERN.test(text)) {
    throw new OnlineContractError('invalid id', path);
  }
  return text;
}

function hashValue(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (!HASH_PATTERN.test(text)) {
    throw new OnlineContractError('invalid sha256 hash', path);
  }
  return text;
}

function integerValue(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new OnlineContractError('expected a safe integer', path);
  }
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  const number = integerValue(value, path);
  if (number < 1) {
    throw new OnlineContractError('expected a positive integer', path);
  }
  return number;
}

function nonNegativeInteger(value: unknown, path: string): number {
  const number = integerValue(value, path);
  if (number < 0) {
    throw new OnlineContractError('expected a non-negative integer', path);
  }
  return number;
}

function timestampValue(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (Number.isNaN(Date.parse(text))) {
    throw new OnlineContractError('expected an ISO timestamp', path);
  }
  return text;
}

function nullableTimestamp(value: unknown, path: string): string | null {
  if (value === null) {
    return null;
  }
  return timestampValue(value, path);
}

function seatValue(value: unknown, path: string): Seat {
  if (value === 'white' || value === 'black') {
    return value;
  }
  throw new OnlineContractError('expected white or black', path);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function publicLabelValue(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (
    text.length < 1 ||
    text.length > 64 ||
    text.trim() !== text ||
    text.includes('@') ||
    text.includes('://') ||
    hasControlCharacter(text)
  ) {
    throw new OnlineContractError('invalid public label', path);
  }
  return text;
}

function sanValue(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (text.length < 1 || text.length > 16 || !/^[a-hA-Z1-8=+#xO-]+$/.test(text)) {
    throw new OnlineContractError('invalid SAN', path);
  }
  return text;
}

function fenValue(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (text.length < 4 || text.length > 128 || text.split(' ').length < 6) {
    throw new OnlineContractError('invalid fen', path);
  }
  return text;
}

function parseParticipant(value: unknown, path: string): ParticipantRef {
  const objectValue = object(value, path);
  onlyKeys(objectValue, ['kind', 'id'], path);
  requiredKeys(objectValue, ['kind', 'id'], path);
  const kind = stringValue(objectValue.kind, `${path}.kind`);
  if (kind !== 'account' && kind !== 'guest') {
    throw new OnlineContractError('invalid participant kind', `${path}.kind`);
  }
  const id = stringValue(objectValue.id, `${path}.id`);
  if (id.length < 1 || id.length > 128 || hasControlCharacter(id)) {
    throw new OnlineContractError('invalid participant id', `${path}.id`);
  }
  return { kind, id };
}

function parseEventKind(value: unknown, path: string): EventKind {
  const kind = stringValue(value, path);
  const allowed: readonly EventKind[] = [
    'match_created',
    'move',
    'resign',
    'abort',
    'cancel',
    'control_change',
    'timeout',
    'replay_removed',
    'draw_agreement',
    'takeback_accepted',
    'offer_created',
    'recovery_attempt',
    'illegal_move_loss',
  ];
  if (!allowed.includes(kind as EventKind)) {
    throw new OnlineContractError('invalid event kind', path);
  }
  return kind as EventKind;
}

function parseControl(value: unknown, path: string): SeatControl {
  const objectValue = object(value, path);
  onlyKeys(objectValue, ['kind', 'modelLabel'], path);
  requiredKeys(objectValue, ['kind'], path);
  const kind = stringValue(objectValue.kind, `${path}.kind`);
  if (kind === 'human') {
    if ('modelLabel' in objectValue) {
      throw new OnlineContractError('human control cannot declare a model', path);
    }
    return { kind };
  }
  if (kind !== 'agent' && kind !== 'engine') {
    throw new OnlineContractError('invalid control kind', `${path}.kind`);
  }
  return { kind, modelLabel: publicLabelValue(objectValue.modelLabel, `${path}.modelLabel`) };
}

function parseTimeControl(value: unknown, path: string): TimeControl {
  const objectValue = object(value, path);
  onlyKeys(objectValue, ['startingTimeMs', 'incrementMs'], path);
  requiredKeys(objectValue, ['startingTimeMs', 'incrementMs'], path);
  const startingTimeMs = positiveInteger(objectValue.startingTimeMs, `${path}.startingTimeMs`);
  const incrementMs = nonNegativeInteger(objectValue.incrementMs, `${path}.incrementMs`);
  if (startingTimeMs > 86_400_000 || incrementMs > 60_000) {
    throw new OnlineContractError('time control out of range', path);
  }
  return { startingTimeMs, incrementMs };
}

function parseResult(value: unknown, path: string): Result {
  const objectValue = object(value, path);
  onlyKeys(objectValue, ['kind', 'winner', 'reason'], path);
  requiredKeys(objectValue, ['kind', 'winner', 'reason'], path);
  const kind = stringValue(objectValue.kind, `${path}.kind`);
  const reason = stringValue(objectValue.reason, `${path}.reason`);
  const winner = objectValue.winner === null ? null : seatValue(objectValue.winner, `${path}.winner`);
  if (kind === 'win') {
    if (winner === null || !['checkmate', 'resignation', 'timeout', 'abandonment', 'illegal_move'].includes(reason)) {
      throw new OnlineContractError('invalid win result', path);
    }
    return { kind, winner, reason: reason as ResultReason };
  }
  if (kind === 'draw') {
    if (winner !== null || !['stalemate', 'repetition', 'fifty_move', 'insufficient_material', 'agreement'].includes(reason)) {
      throw new OnlineContractError('invalid draw result', path);
    }
    return { kind, winner, reason: reason as ResultReason };
  }
  if (kind === 'abort') {
    if (winner !== null || (reason !== 'abort' && reason !== 'opening_reply_timeout')) {
      throw new OnlineContractError('invalid abort result', path);
    }
    return { kind, winner, reason };
  }
  throw new OnlineContractError('invalid result kind', `${path}.kind`);
}

function parseMove(value: unknown, path: string): Move {
  const objectValue = object(value, path);
  onlyKeys(objectValue, ['version', 'seat', 'uci', 'san', 'resultingFen'], path);
  requiredKeys(objectValue, ['version', 'seat', 'uci', 'san', 'resultingFen'], path);
  const uci = stringValue(objectValue.uci, `${path}.uci`);
  if (!UCI_PATTERN.test(uci)) {
    throw new OnlineContractError('invalid uci move', `${path}.uci`);
  }
  return {
    version: positiveInteger(objectValue.version, `${path}.version`),
    seat: seatValue(objectValue.seat, `${path}.seat`),
    uci,
    san: sanValue(objectValue.san, `${path}.san`),
    resultingFen: fenValue(objectValue.resultingFen, `${path}.resultingFen`),
  };
}

function parseOffer(value: unknown, path: string): Offer {
  const objectValue = object(value, path);
  onlyKeys(objectValue, ['offerId', 'matchId', 'kind', 'seat', 'targetVersion', 'baseVersion', 'createdAt'], path);
  requiredKeys(objectValue, ['offerId', 'matchId', 'kind', 'seat', 'baseVersion', 'createdAt'], path);
  const kind = stringValue(objectValue.kind, `${path}.kind`);
  if (kind !== 'draw' && kind !== 'takeback') {
    throw new OnlineContractError('invalid offer kind', `${path}.kind`);
  }
  const targetVersion =
    objectValue.targetVersion === null || objectValue.targetVersion === undefined
      ? null
      : positiveInteger(objectValue.targetVersion, `${path}.targetVersion`);
  if ((kind === 'takeback') !== (targetVersion !== null)) {
    throw new OnlineContractError('offer kind does not match its target version', path);
  }
  return {
    offerId: idValue(objectValue.offerId, `${path}.offerId`),
    matchId: idValue(objectValue.matchId, `${path}.matchId`),
    kind,
    seat: seatValue(objectValue.seat, `${path}.seat`),
    targetVersion,
    baseVersion: positiveInteger(objectValue.baseVersion, `${path}.baseVersion`),
    createdAt: timestampValue(objectValue.createdAt, `${path}.createdAt`),
  };
}

function parseEvent(value: unknown, path: string): Event {
  const objectValue = object(value, path);
  onlyKeys(objectValue, ['schemaVersion', 'matchId', 'version', 'kind', 'seat', 'controlEpoch', 'decisionAt', 'acceptedAt', 'move', 'result', 'control', 'offer', 'takebackTargetVersion', 'recoveryAttempt'], path);
  requiredKeys(objectValue, ['schemaVersion', 'matchId', 'version', 'kind', 'controlEpoch', 'decisionAt', 'acceptedAt'], path);
  const event: Event = {
    schemaVersion: positiveInteger(objectValue.schemaVersion, `${path}.schemaVersion`),
    matchId: idValue(objectValue.matchId, `${path}.matchId`),
    version: positiveInteger(objectValue.version, `${path}.version`),
    kind: parseEventKind(objectValue.kind, `${path}.kind`),
    controlEpoch: positiveInteger(objectValue.controlEpoch, `${path}.controlEpoch`),
    decisionAt: timestampValue(objectValue.decisionAt, `${path}.decisionAt`),
    acceptedAt: timestampValue(objectValue.acceptedAt, `${path}.acceptedAt`),
  };
  const seat = optionalString(objectValue.seat, `${path}.seat`);
  if (seat !== undefined) {
    event.seat = seatValue(seat, `${path}.seat`);
  }
  if (objectValue.move !== undefined) {
    event.move = parseMove(objectValue.move, `${path}.move`);
  }
  if (objectValue.result !== undefined) {
    event.result = parseResult(objectValue.result, `${path}.result`);
  }
  if (objectValue.control !== undefined) {
    event.control = parseControl(objectValue.control, `${path}.control`);
  }
  if (objectValue.offer !== undefined) {
    event.offer = parseOffer(objectValue.offer, `${path}.offer`);
  }
  if (objectValue.takebackTargetVersion !== undefined) {
    event.takebackTargetVersion = positiveInteger(objectValue.takebackTargetVersion, `${path}.takebackTargetVersion`);
  }
  if (objectValue.recoveryAttempt !== undefined) {
    const attempt = stringValue(objectValue.recoveryAttempt, `${path}.recoveryAttempt`);
    if (attempt !== 'illegal_move' && attempt !== 'formatting_correction') {
      throw new OnlineContractError('invalid recovery attempt', `${path}.recoveryAttempt`);
    }
    event.recoveryAttempt = attempt;
  }
  return event;
}

function parseCreateSeat(value: unknown, path: string): CreateSeat {
  const objectValue = object(value, path);
  onlyKeys(objectValue, ['participant', 'publicLabel', 'control'], path);
  requiredKeys(objectValue, ['participant', 'publicLabel', 'control'], path);
  return {
    participant: parseParticipant(objectValue.participant, `${path}.participant`),
    publicLabel: publicLabelValue(objectValue.publicLabel, `${path}.publicLabel`),
    control: parseControl(objectValue.control, `${path}.control`),
  };
}

function parseCreateMatch(value: unknown, path: string): CreateMatchSetup {
  const objectValue = object(value, path);
  onlyKeys(objectValue, ['variant', 'startingFen', 'timeControl', 'seats'], path);
  requiredKeys(objectValue, ['variant', 'startingFen', 'timeControl', 'seats'], path);
  if (objectValue.variant !== 'orthodox') {
    throw new OnlineContractError('unsupported variant', `${path}.variant`);
  }
  const seats = object(objectValue.seats, `${path}.seats`);
  onlyKeys(seats, ['white', 'black'], `${path}.seats`);
  requiredKeys(seats, ['white', 'black'], `${path}.seats`);
  const white = parseCreateSeat(seats.white, `${path}.seats.white`);
  const black = parseCreateSeat(seats.black, `${path}.seats.black`);
  if (white.participant.kind === black.participant.kind && white.participant.id === black.participant.id) {
    throw new OnlineContractError('both seats belong to the same participant', `${path}.seats`);
  }
  return {
    variant: 'orthodox',
    startingFen: fenValue(objectValue.startingFen, `${path}.startingFen`),
    timeControl: parseTimeControl(objectValue.timeControl, `${path}.timeControl`),
    seats: { white, black },
  };
}

function parseAction(value: unknown, path: string): OnlineAction {
  const objectValue = object(value, path);
  const kind = stringValue(objectValue.kind, `${path}.kind`);
  switch (kind) {
    case 'create_match': {
      onlyKeys(objectValue, ['kind', 'setup'], path);
      requiredKeys(objectValue, ['setup'], path);
      return { kind, setup: parseCreateMatch(objectValue.setup, `${path}.setup`) };
    }
    case 'submit_move': {
      onlyKeys(objectValue, ['kind', 'move'], path);
      requiredKeys(objectValue, ['move'], path);
      const move = stringValue(objectValue.move, `${path}.move`);
      if (!UCI_PATTERN.test(move)) {
        throw new OnlineContractError('invalid uci move', `${path}.move`);
      }
      return { kind, move };
    }
    case 'resign':
    case 'cancel':
    case 'offer_draw': {
      onlyKeys(objectValue, ['kind'], path);
      return { kind } as OnlineAction;
    }
    case 'accept_draw':
    case 'accept_takeback': {
      onlyKeys(objectValue, ['kind', 'offerId'], path);
      requiredKeys(objectValue, ['offerId'], path);
      return { kind, offerId: idValue(objectValue.offerId, `${path}.offerId`) } as OnlineAction;
    }
    case 'set_control': {
      onlyKeys(objectValue, ['kind', 'control'], path);
      requiredKeys(objectValue, ['control'], path);
      return { kind, control: parseControl(objectValue.control, `${path}.control`) };
    }
    case 'offer_takeback': {
      onlyKeys(objectValue, ['kind', 'targetVersion'], path);
      requiredKeys(objectValue, ['targetVersion'], path);
      const targetVersion = positiveInteger(objectValue.targetVersion, `${path}.targetVersion`);
      return { kind, targetVersion };
    }
    case 'record_recovery_attempt': {
      onlyKeys(objectValue, ['kind', 'attempt'], path);
      requiredKeys(objectValue, ['attempt'], path);
      const attempt = stringValue(objectValue.attempt, `${path}.attempt`);
      if (attempt !== 'illegal_move' && attempt !== 'formatting_correction') {
        throw new OnlineContractError('invalid recovery attempt', `${path}.attempt`);
      }
      return { kind, attempt };
    }
    case 'remove_public_replay': {
      onlyKeys(objectValue, ['kind', 'reason'], path);
      requiredKeys(objectValue, ['reason'], path);
      const reason = stringValue(objectValue.reason, `${path}.reason`);
      if (reason !== 'owner_request' && reason !== 'erasure_request') {
        throw new OnlineContractError('invalid replay removal reason', `${path}.reason`);
      }
      return { kind, reason };
    }
    default:
      throw new OnlineContractError('unknown action kind', `${path}.kind`);
  }
}

export function parseCommand(value: unknown): Command {
  const path = 'command';
  const objectValue = object(value, path);
  onlyKeys(objectValue, ['schemaVersion', 'matchId', 'operationId', 'expectedVersion', 'seat', 'controlEpoch', 'action'], path);
  requiredKeys(objectValue, ['schemaVersion', 'matchId', 'operationId', 'expectedVersion', 'seat', 'controlEpoch', 'action'], path);
  if (integerValue(objectValue.schemaVersion, `${path}.schemaVersion`) !== ONLINE_CONTRACTS_SCHEMA_VERSION) {
    throw new OnlineContractError('unsupported schema version', `${path}.schemaVersion`);
  }
  const action = parseAction(objectValue.action, `${path}.action`);
  const expectedVersion = nonNegativeInteger(objectValue.expectedVersion, `${path}.expectedVersion`);
  if (action.kind === 'create_match' && expectedVersion !== 0) {
    throw new OnlineContractError('create_match expects version 0', `${path}.expectedVersion`);
  }
  if (action.kind !== 'create_match' && expectedVersion < 1) {
    throw new OnlineContractError('expected version must be positive', `${path}.expectedVersion`);
  }
  return {
    schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION,
    matchId: idValue(objectValue.matchId, `${path}.matchId`),
    operationId: idValue(objectValue.operationId, `${path}.operationId`),
    expectedVersion,
    seat: seatValue(objectValue.seat, `${path}.seat`),
    controlEpoch: positiveInteger(objectValue.controlEpoch, `${path}.controlEpoch`),
    action,
  };
}

export function parseReceipt(value: unknown): Receipt {
  const path = 'receipt';
  const objectValue = object(value, path);
  onlyKeys(objectValue, ['schemaVersion', 'matchId', 'operationId', 'outcome', 'version', 'controlEpoch', 'decidedAt', 'event', 'result'], path);
  requiredKeys(objectValue, ['schemaVersion', 'matchId', 'operationId', 'outcome', 'version', 'controlEpoch', 'decidedAt'], path);
  if (integerValue(objectValue.schemaVersion, `${path}.schemaVersion`) !== ONLINE_CONTRACTS_SCHEMA_VERSION) {
    throw new OnlineContractError('unsupported schema version', `${path}.schemaVersion`);
  }
  const outcome = stringValue(objectValue.outcome, `${path}.outcome`);
  if (outcome !== 'accepted' && outcome !== 'deadline_expired' && outcome !== 'replay_removed' && outcome !== 'opening_expired') {
    throw new OnlineContractError('invalid receipt outcome', `${path}.outcome`);
  }
  const receipt: Receipt = {
    schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION,
    matchId: idValue(objectValue.matchId, `${path}.matchId`),
    operationId: idValue(objectValue.operationId, `${path}.operationId`),
    outcome,
    version: positiveInteger(objectValue.version, `${path}.version`),
    controlEpoch: positiveInteger(objectValue.controlEpoch, `${path}.controlEpoch`),
    decidedAt: timestampValue(objectValue.decidedAt, `${path}.decidedAt`),
  };
  if (objectValue.event !== undefined) {
    receipt.event = parseEvent(objectValue.event, `${path}.event`);
  }
  if (objectValue.result !== undefined) {
    receipt.result = parseResult(objectValue.result, `${path}.result`);
  }
  return receipt;
}

export function parsePublicProjection(value: unknown): PublicProjection {
  const path = 'publicProjection';
  const objectValue = object(value, path);
  onlyKeys(objectValue, ['schemaVersion', 'matchId', 'variant', 'startingFen', 'timeControl', 'participants', 'moves', 'result', 'rulesPolicyVersion', 'completedAt'], path);
  requiredKeys(objectValue, ['schemaVersion', 'matchId', 'variant', 'startingFen', 'timeControl', 'participants', 'moves', 'result', 'rulesPolicyVersion', 'completedAt'], path);
  if (integerValue(objectValue.schemaVersion, `${path}.schemaVersion`) !== ONLINE_PUBLIC_PROJECTION_SCHEMA_VERSION) {
    throw new OnlineContractError('unsupported schema version', `${path}.schemaVersion`);
  }
  if (objectValue.variant !== 'orthodox') {
    throw new OnlineContractError('unsupported variant', `${path}.variant`);
  }
  if (!Array.isArray(objectValue.participants) || objectValue.participants.length !== 2) {
    throw new OnlineContractError('expected two public participants', `${path}.participants`);
  }
  const participants = objectValue.participants.map((participant, index) => {
    const participantPath = `${path}.participants[${index}]`;
    const item = object(participant, participantPath);
    onlyKeys(item, ['seat', 'publicLabel', 'control'], participantPath);
    requiredKeys(item, ['seat', 'publicLabel', 'control'], participantPath);
    return {
      seat: seatValue(item.seat, `${participantPath}.seat`),
      publicLabel: publicLabelValue(item.publicLabel, `${participantPath}.publicLabel`),
      control: parseControl(item.control, `${participantPath}.control`),
    };
  });
  if (participants[0]?.seat === participants[1]?.seat) {
    throw new OnlineContractError('duplicate public seat', `${path}.participants`);
  }
  if (!Array.isArray(objectValue.moves)) {
    throw new OnlineContractError('expected moves array', `${path}.moves`);
  }
  const moves = objectValue.moves.map((move, index) => {
    const movePath = `${path}.moves[${index}]`;
    const item = object(move, movePath);
    onlyKeys(item, ['version', 'seat', 'uci', 'san'], movePath);
    requiredKeys(item, ['version', 'seat', 'uci', 'san'], movePath);
    const uci = stringValue(item.uci, `${movePath}.uci`);
    if (!UCI_PATTERN.test(uci)) {
      throw new OnlineContractError('invalid uci move', `${movePath}.uci`);
    }
    return {
      version: positiveInteger(item.version, `${movePath}.version`),
      seat: seatValue(item.seat, `${movePath}.seat`),
      uci,
      san: sanValue(item.san, `${movePath}.san`),
    };
  });
  return {
    schemaVersion: ONLINE_PUBLIC_PROJECTION_SCHEMA_VERSION,
    matchId: idValue(objectValue.matchId, `${path}.matchId`),
    variant: 'orthodox',
    startingFen: fenValue(objectValue.startingFen, `${path}.startingFen`),
    timeControl: parseTimeControl(objectValue.timeControl, `${path}.timeControl`),
    participants,
    moves,
    result: parseResult(objectValue.result, `${path}.result`),
    rulesPolicyVersion: stringValue(objectValue.rulesPolicyVersion, `${path}.rulesPolicyVersion`),
    completedAt: timestampValue(objectValue.completedAt, `${path}.completedAt`),
  };
}

export function parseQueueEntry(value: unknown): QueueEntry {
  const path = 'queueEntry';
  const objectValue = object(value, path);
  onlyKeys(objectValue, ['schemaVersion', 'entryId', 'owner', 'control', 'timeControl', 'status', 'version', 'readyAt', 'cutoffAt', 'assignedMatchId', 'createdAt', 'updatedAt'], path);
  requiredKeys(objectValue, ['schemaVersion', 'entryId', 'owner', 'control', 'timeControl', 'status', 'version', 'readyAt', 'cutoffAt', 'assignedMatchId', 'createdAt', 'updatedAt'], path);
  const status = stringValue(objectValue.status, `${path}.status`);
  if (status !== 'waiting' && status !== 'cancelled' && status !== 'assigned') {
    throw new OnlineContractError('invalid queue status', `${path}.status`);
  }
  const control = parseControl(objectValue.control, `${path}.control`);
  if (control.kind === 'engine') {
    throw new OnlineContractError('queue entries use human or agent control', `${path}.control.kind`);
  }
  return {
    schemaVersion: positiveInteger(objectValue.schemaVersion, `${path}.schemaVersion`),
    entryId: idValue(objectValue.entryId, `${path}.entryId`),
    owner: parseParticipant(objectValue.owner, `${path}.owner`),
    control,
    timeControl: parseTimeControl(objectValue.timeControl, `${path}.timeControl`),
    status,
    version: positiveInteger(objectValue.version, `${path}.version`),
    readyAt: nullableTimestamp(objectValue.readyAt, `${path}.readyAt`),
    cutoffAt: nullableTimestamp(objectValue.cutoffAt, `${path}.cutoffAt`),
    assignedMatchId: objectValue.assignedMatchId === null ? null : idValue(objectValue.assignedMatchId, `${path}.assignedMatchId`),
    createdAt: timestampValue(objectValue.createdAt, `${path}.createdAt`),
    updatedAt: timestampValue(objectValue.updatedAt, `${path}.updatedAt`),
  };
}

export function parseRunnerLease(value: unknown): RunnerLease {
  const path = 'runnerLease';
  const objectValue = object(value, path);
  onlyKeys(objectValue, ['schemaVersion', 'leaseId', 'matchId', 'seat', 'controlEpoch', 'generation', 'runnerId', 'status', 'acquiredAt', 'expiresAt', 'revokedAt'], path);
  requiredKeys(objectValue, ['schemaVersion', 'leaseId', 'matchId', 'seat', 'controlEpoch', 'generation', 'runnerId', 'status', 'acquiredAt', 'expiresAt', 'revokedAt'], path);
  const status = stringValue(objectValue.status, `${path}.status`);
  if (status !== 'active' && status !== 'revoked' && status !== 'expired') {
    throw new OnlineContractError('invalid lease status', `${path}.status`);
  }
  return {
    schemaVersion: positiveInteger(objectValue.schemaVersion, `${path}.schemaVersion`),
    leaseId: idValue(objectValue.leaseId, `${path}.leaseId`),
    matchId: idValue(objectValue.matchId, `${path}.matchId`),
    seat: seatValue(objectValue.seat, `${path}.seat`),
    controlEpoch: positiveInteger(objectValue.controlEpoch, `${path}.controlEpoch`),
    generation: positiveInteger(objectValue.generation, `${path}.generation`),
    runnerId: stringValue(objectValue.runnerId, `${path}.runnerId`),
    status,
    acquiredAt: timestampValue(objectValue.acquiredAt, `${path}.acquiredAt`),
    expiresAt: timestampValue(objectValue.expiresAt, `${path}.expiresAt`),
    revokedAt: nullableTimestamp(objectValue.revokedAt, `${path}.revokedAt`),
  };
}

export function parseDeletionMarker(value: unknown): DeletionMarker {
  const path = 'deletionMarker';
  const objectValue = object(value, path);
  onlyKeys(objectValue, ['schemaVersion', 'markerId', 'kind', 'subjectKind', 'subjectId', 'matchId', 'reason', 'requestedAt', 'appliedAt'], path);
  requiredKeys(objectValue, ['schemaVersion', 'markerId', 'kind', 'subjectKind', 'subjectId', 'matchId', 'reason', 'requestedAt', 'appliedAt'], path);
  const kind = stringValue(objectValue.kind, `${path}.kind`);
  if (kind !== 'replay_removal' && kind !== 'account_anonymization' && kind !== 'match_removal') {
    throw new OnlineContractError('invalid marker kind', `${path}.kind`);
  }
  const subjectKind = stringValue(objectValue.subjectKind, `${path}.subjectKind`);
  if (subjectKind !== 'account' && subjectKind !== 'guest' && subjectKind !== 'match') {
    throw new OnlineContractError('invalid subject kind', `${path}.subjectKind`);
  }
  const reason = stringValue(objectValue.reason, `${path}.reason`);
  if (reason !== 'owner_request' && reason !== 'erasure_request' && reason !== 'account_deletion') {
    throw new OnlineContractError('invalid marker reason', `${path}.reason`);
  }
  return {
    schemaVersion: positiveInteger(objectValue.schemaVersion, `${path}.schemaVersion`),
    markerId: idValue(objectValue.markerId, `${path}.markerId`),
    kind,
    subjectKind,
    subjectId: stringValue(objectValue.subjectId, `${path}.subjectId`),
    matchId: objectValue.matchId === null ? null : idValue(objectValue.matchId, `${path}.matchId`),
    reason,
    requestedAt: timestampValue(objectValue.requestedAt, `${path}.requestedAt`),
    appliedAt: timestampValue(objectValue.appliedAt, `${path}.appliedAt`),
  };
}

export function parseCandidate(value: unknown): Candidate {
  const path = 'candidate';
  const objectValue = object(value, path);
  onlyKeys(objectValue, ['schemaVersion', 'evaluatedVersion', 'evaluatedInputHash', 'controlEpoch', 'move', 'result'], path);
  requiredKeys(objectValue, ['schemaVersion', 'evaluatedVersion', 'evaluatedInputHash', 'controlEpoch'], path);
  const candidate: Candidate = {
    schemaVersion: positiveInteger(objectValue.schemaVersion, `${path}.schemaVersion`),
    evaluatedVersion: positiveInteger(objectValue.evaluatedVersion, `${path}.evaluatedVersion`),
    evaluatedInputHash: hashValue(objectValue.evaluatedInputHash, `${path}.evaluatedInputHash`),
    controlEpoch: positiveInteger(objectValue.controlEpoch, `${path}.controlEpoch`),
  };
  if (candidate.schemaVersion !== ONLINE_RULES_INPUT_SCHEMA_VERSION) {
    throw new OnlineContractError('unsupported candidate schema version', `${path}.schemaVersion`);
  }
  if (objectValue.move === undefined) {
    throw new OnlineContractError('missing candidate move', `${path}.move`);
  }
  candidate.move = parseMove(objectValue.move, `${path}.move`);
  const nextSide = candidate.move.resultingFen.split(' ')[1];
  if (nextSide !== (candidate.move.seat === 'white' ? 'b' : 'w')) {
    throw new OnlineContractError('candidate must leave the opponent to move', `${path}.move.resultingFen`);
  }
  if (objectValue.result !== undefined) {
    candidate.result = parseResult(objectValue.result, `${path}.result`);
    const result = candidate.result;
    if (result.kind === 'win') {
      if (result.reason !== 'checkmate' || result.winner !== candidate.move.seat) {
        throw new OnlineContractError('a mating move must award the mover', `${path}.result`);
      }
    } else if (result.kind !== 'draw' || !['stalemate', 'repetition', 'fifty_move', 'insufficient_material'].includes(result.reason)) {
      throw new OnlineContractError('result cannot arise from a legal move', `${path}.result`);
    }
  }
  return candidate;
}

export function parseTimeoutFacts(value: unknown): TimeoutFacts {
  const path = 'timeoutFacts';
  const objectValue = object(value, path);
  onlyKeys(objectValue, ['schemaVersion', 'evaluatedVersion', 'evaluatedInputHash', 'controlEpoch', 'expiredSeat', 'winner'], path);
  requiredKeys(objectValue, ['schemaVersion', 'evaluatedVersion', 'evaluatedInputHash', 'controlEpoch', 'expiredSeat', 'winner'], path);
  const schemaVersion = positiveInteger(objectValue.schemaVersion, `${path}.schemaVersion`);
  if (schemaVersion !== ONLINE_RULES_INPUT_SCHEMA_VERSION) {
    throw new OnlineContractError('unsupported timeout facts schema version', `${path}.schemaVersion`);
  }
  const expiredSeat = seatValue(objectValue.expiredSeat, `${path}.expiredSeat`);
  const winner = objectValue.winner === null ? null : seatValue(objectValue.winner, `${path}.winner`);
  if (winner !== null && winner === expiredSeat) {
    throw new OnlineContractError('timeout cannot win for the flagged seat', `${path}.winner`);
  }
  return {
    schemaVersion,
    evaluatedVersion: positiveInteger(objectValue.evaluatedVersion, `${path}.evaluatedVersion`),
    evaluatedInputHash: hashValue(objectValue.evaluatedInputHash, `${path}.evaluatedInputHash`),
    controlEpoch: positiveInteger(objectValue.controlEpoch, `${path}.controlEpoch`),
    expiredSeat,
    winner,
  };
}
