import {
  calculateMoveClockCandidate,
  calculateUndoClockCandidate,
  DEFAULT_TIME_CONTROL,
  readClockAt,
  recoverClockAfterAbsence,
  startClock,
} from '../clocks/index.js';
import type {
  ClockBanks,
  ClockComparisonPolicy,
  ClockReading,
  ClockSide,
  ClockState,
  TimeControl,
  TimeSample,
} from '../clocks/index.js';
import {
  applyCoordinateMove,
  createRepetitionLedger,
  IllegalMoveError,
  observeEndingFacts,
  parsePosition,
  recordPosition,
  restoreRepetitionLedger,
  timeoutWinner,
} from '../rules/index.js';
import type { CoordinateMove, Position } from '../rules/index.js';
import { MAX_FORMAT_CORRECTIONS, MAX_ILLEGAL_MOVE_ATTEMPTS } from '../moves/index.js';
import type { ModelTurnDecision } from '../moves/index.js';
import { explainIllegalMove } from '../moves/violations.js';
import { checkProofEvidence } from '../proofs/checker.js';
import { createDeadnessQuery, createTimeoutMatingQuery, proofQueryIdentity } from '../proofs/queries.js';
import type { ProofQuery, ProofSearchPassResult } from '../proofs/index.js';
import type {
  AppliedMoveV1,
  ArchiveChunkV1,
  ArchiveEventV1,
  DiscardedLineReferenceV1,
  GameCheckpointV1,
  GameNamespaceV1,
  GameResultV1,
  GameStore,
  JsonValue,
  PlayerSelectionV1,
  VersionedExtensionSectionV1,
} from '../storage/index.js';
import { sha256Hex } from '../archive/index.js';

export type ModelSelection = Extract<PlayerSelectionV1, { kind: 'model' }>;
export type HumanSideChoice = ClockSide | 'random';
type ClockDiscrepancyReading = Extract<ClockReading, { status: 'reconciliation-required' }>;

const INITIAL_POSITION = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MOVE_ATTEMPTS_EXTENSION = 'move-attempts';
const GAME_CONTROLLER_INTENT_KINDS: ReadonlySet<string> = new Set([
  'begin-model-turn',
  'queue-model-selection',
  'cancel-model-selection',
  'resume-prior-model',
  'retry-model-selection',
  'stop-model-turn',
  'model-turn-interrupted',
  'human-move',
  'model-move',
  'model-turn-effect',
  'declare-result',
]);

function isGameControllerIntentKind(kind: unknown): kind is GameControllerIntentV1['kind'] {
  return typeof kind === 'string' && GAME_CONTROLLER_INTENT_KINDS.has(kind);
}

export interface ControllerTimeSource {
  /** Use decisionTimeMs as the wall reference when called from a checkpoint decision hook. */
  sample(decisionTimeMs?: number): TimeSample;
}

export interface GameControllerOptions {
  gameId: string;
  /** Legacy proof replay is opt-in; interactive games use bounded Lichess rules. */
  positionChecks?: 'lichess' | 'legacy-proof';
  /** Stable logical store namespace, such as JSON.stringify(connectionNamespace). Defaults to legacy guest scope. */
  registryScope?: string;
  store: GameStore;
  clockPolicy: ClockComparisonPolicy;
  timeSource?: ControllerTimeSource;
  idFactory?: () => string;
  randomSide?: () => ClockSide;
}

export interface GameControllerSetupV1 {
  humanSide: HumanSideChoice;
  /** Explicit seats support spectator matches; overrides the legacy human/model pair. */
  players?: Record<ClockSide, PlayerSelectionV1>;
  /** Omit for a local game with two human players. */
  modelSelection?: ModelSelection;
  namespace: GameNamespaceV1;
  ownershipEpoch: number;
  startingFen?: string;
  timeControl?: TimeControl;
}

export interface ControllerFenceV1 {
  schemaVersion: 1;
  gameId: string;
  segmentId: string;
  side: ClockSide;
  revision: number;
  positionRevision: number;
  requestGeneration: number;
  analysisGeneration: number;
  ownershipEpoch: number;
  modelConfigurationIdentity: string | null;
}

export interface ControllerSnapshotV1 {
  checkpoint: GameCheckpointV1;
  position: Position;
  clockReading: ClockReading | null;
  fence: ControllerFenceV1;
  readiness:
    | 'ready'
    | 'restore-recovery-pending'
    | 'expiry-persistence-pending'
    | 'clock-reconciliation-required';
  adjudication: {
    readonly status: 'none' | 'queued' | 'running' | 'stopped' | 'setup-ready';
    readonly query: ProofQuery | null;
    readonly requestId: string | null;
  };
  modelHandoff: ModelHandoffSnapshotV1;
}

export interface ModelHandoffSnapshotV1 {
  readonly committed: ModelSelection | null;
  readonly producing: ModelSelection | null;
  readonly queued: { readonly selection: ModelSelection; readonly state: 'queued' | 'awaiting-first-reply' | 'failed'; readonly failure: string | null } | null;
}

export interface ControllerMoveEventV1 {
  schemaVersion: 1;
  kind: 'human-move' | 'model-move';
  fence: ControllerFenceV1;
  move: CoordinateMove;
}

/**
 * A local, explicit final result. Offline play records the owner's decision; it does not
 * depend on an opponent reply, provider request or online draw offer.
 */
export type GameResultDeclarationV1 =
  | { readonly kind: 'draw' }
  | { readonly kind: 'resignation'; readonly side: ClockSide };

export type GameControllerIntentV1 =
  | { schemaVersion: 1; kind: 'begin-model-turn'; fence: ControllerFenceV1 }
  | { schemaVersion: 1; kind: 'queue-model-selection'; fence: ControllerFenceV1; candidate: ModelSelection }
  | { schemaVersion: 1; kind: 'cancel-model-selection' | 'resume-prior-model' | 'retry-model-selection'; fence: ControllerFenceV1 }
  | { schemaVersion: 1; kind: 'stop-model-turn'; fence: ControllerFenceV1 }
  | { schemaVersion: 1; kind: 'model-turn-interrupted'; fence: ControllerFenceV1; reason: ModelTurnInterruptionReasonV1 }
  | { schemaVersion: 1; kind: 'declare-result'; fence: ControllerFenceV1; declaration: GameResultDeclarationV1 }
  | ControllerMoveEventV1
  | { schemaVersion: 1; kind: 'model-turn-effect'; fence: ControllerFenceV1; effect: ModelTurnDecision };

export type ModelTurnInterruptionReasonV1 = 'failed' | 'incomplete' | 'aborted';

export interface ModelTurnRequestV1 {
  fence: ControllerFenceV1;
  position: Position;
  clockReading: ClockReading;
  selection: ModelSelection;
}

export type GameControllerIntentResultV1 =
  | { kind: 'model-turn-started'; snapshot: ControllerSnapshotV1; request: ModelTurnRequestV1 }
  | { kind: 'accepted'; snapshot: ControllerSnapshotV1 }
  | {
      kind: 'rejected';
      reason: 'stale-fence' | 'wrong-side' | 'not-actionable' | 'illegal-move';
      snapshot: ControllerSnapshotV1;
    }
  | { kind: 'expired'; snapshot: ControllerSnapshotV1 }
  | { kind: 'clock-reconciliation-required'; snapshot: ControllerSnapshotV1 };

export interface GameController {
  initialize(setup?: GameControllerSetupV1): Promise<ControllerSnapshotV1>;
  dispatch(intent: GameControllerIntentV1): Promise<GameControllerIntentResultV1>;
  appendModelTurnArchive(fence: ControllerFenceV1, entry: ModelTurnArchiveEntryV1, knownCredentials?: readonly string[]): Promise<ControllerFenceV1 | null>;
  reconcile(): Promise<ControllerSnapshotV1>;
  snapshot(): ControllerSnapshotV1;
  subscribe(listener: (snapshot: ControllerSnapshotV1) => void): () => void;
  continueAdjudication(fence: ControllerFenceV1): Promise<AdjudicationWorkV1 | null>;
  stopAdjudication(fence: ControllerFenceV1): Promise<ControllerSnapshotV1>;
  acceptAdjudicationResult(input: AdjudicationResultInputV1): Promise<ControllerSnapshotV1>;
  startGame(fence: ControllerFenceV1, modelSelection?: ModelSelection): Promise<ControllerSnapshotV1>;
  undo(fence: ControllerFenceV1): Promise<ControllerSnapshotV1>;
  undoMove(fence: ControllerFenceV1): Promise<ControllerSnapshotV1>;
  takeback(fence: ControllerFenceV1): Promise<ControllerSnapshotV1>;
  /** Records an explicit local draw or resignation as the game's final result. */
  declareResult(fence: ControllerFenceV1, declaration: GameResultDeclarationV1): Promise<GameControllerIntentResultV1>;
  startPractice(fence: ControllerFenceV1, modelSelection: ModelSelection): Promise<ControllerSnapshotV1>;
  beginPractice(fence: ControllerFenceV1, modelSelection: ModelSelection): Promise<ControllerSnapshotV1>;
  queueModelSelection(fence: ControllerFenceV1, candidate: ModelSelection): Promise<ControllerSnapshotV1>;
  cancelModelSelection(fence: ControllerFenceV1): Promise<ControllerSnapshotV1>;
  resumePriorModel(fence: ControllerFenceV1): Promise<ControllerSnapshotV1>;
  retryModelSelection(fence: ControllerFenceV1): Promise<ControllerSnapshotV1>;
}

export type ModelTurnArchiveEntryV1 =
  | { kind: 'request'; requestId: string; protocol: string; modelId: string; body: Uint8Array }
  | { kind: 'response-chunk'; requestId: string; bytes: Uint8Array }
  | { kind: 'terminal'; requestId: string; outcome: 'complete' | 'partial' | 'failed' | 'aborted'; details: unknown;
      messages: readonly { role: 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'function'; content: string }[] };

export interface AdjudicationWorkV1 {
  readonly requestId: string;
  readonly fence: ControllerFenceV1;
  readonly query: ProofQuery;
  readonly searchCheckpoint: unknown;
}

export interface AdjudicationResultInputV1 {
  readonly requestId: string;
  readonly fence: ControllerFenceV1;
  readonly query: ProofQuery;
  readonly result: ProofSearchPassResult;
}

interface AdjudicationCandidateV1 {
  readonly kind: 'deadness' | 'timeout';
  readonly eventId: string;
  readonly eventAtMs: number;
  readonly deadlineMs: number | null;
  readonly query: ProofQuery;
  readonly searchCheckpoint: unknown;
  readonly status: 'queued' | 'running' | 'stopped' | 'accepted';
  readonly requestId: string | null;
  readonly acceptedConclusion?: string;
  readonly acceptedEvidence?: unknown;
}

interface AdjudicationExtensionV1 {
  readonly version: 1;
  readonly data: {
    readonly candidates: readonly AdjudicationCandidateV1[];
    readonly activeQueryIdentity: string | null;
  };
}

const ADJUDICATION_EXTENSION = 'adjudication';

export type GameControllerErrorCode =
  | 'invalid-configuration'
  | 'invalid-intent'
  | 'invalid-setup'
  | 'setup-required'
  | 'revision-conflict'
  | 'saved-game-invalid';

export class GameControllerError extends Error {
  readonly code: GameControllerErrorCode;

  constructor(code: GameControllerErrorCode, message: string) {
    super(message);
    this.name = 'GameControllerError';
    this.code = code;
  }
}

/** Stable, secret-free identity for the exact model configuration in a request fence. */
export function modelConfigurationIdentity(selection: ModelSelection): string {
  if (
    selection.kind !== 'model' ||
    selection.providerId.length === 0 ||
    selection.connectionId.length === 0 ||
    !Number.isSafeInteger(selection.configurationRevision) ||
    selection.configurationRevision < 0 ||
    selection.modelRoutingId.length === 0 ||
    selection.modelRoutingId.trim() !== selection.modelRoutingId
  ) {
    throw new RangeError('Model configuration identity fields are invalid.');
  }

  return JSON.stringify([
    selection.providerId,
    selection.connectionId,
    selection.configurationRevision,
    selection.modelRoutingId,
    selection.protocol,
  ]);
}

const defaultTimeSource: ControllerTimeSource = {
  sample(decisionTimeMs) {
    return {
      monotonicMs: globalThis.performance.now(),
      wallTimeMs: decisionTimeMs ?? Date.now(),
    };
  },
};

const defaultIdFactory = (): string => globalThis.crypto.randomUUID();
const defaultRandomSide = (): ClockSide => (Math.random() < 0.5 ? 'white' : 'black');
interface PreparedSetup {
  readonly humanSide: ClockSide;
  readonly players?: Record<ClockSide, PlayerSelectionV1>;
  readonly modelSelection: ModelSelection | null;
  readonly namespace: GameNamespaceV1;
  readonly ownershipEpoch: number;
  readonly startingFen: string;
  readonly position: Position;
  readonly timeControl: TimeControl;
  readonly segmentId: string;
  readonly lineId: string;
}

interface RegistryConfiguration {
  readonly positionChecks: string;
  readonly store: GameStore;
  readonly timeSource: ControllerTimeSource;
  readonly clockPolicy: ClockComparisonPolicy;
}

interface RecoveryReading {
  readonly reading: ClockReading;
  readonly readiness: ControllerSnapshotV1['readiness'];
}

function toClockSide(side: 'white' | 'black'): ClockSide {
  return side;
}

function fromPositionColor(color: Position['sideToMove']): ClockSide {
  return color === 'w' ? 'white' : 'black';
}

function assertClockPolicy(policy: ClockComparisonPolicy): void {
  if (!Number.isFinite(policy.maxReferenceDivergenceMs) || policy.maxReferenceDivergenceMs < 0) {
    throw new GameControllerError('invalid-configuration', 'The clock comparison policy is invalid.');
  }
}

function sampleAtDecision(timeSource: ControllerTimeSource, decisionTimeMs: number): TimeSample {
  const sample = timeSource.sample(decisionTimeMs);
  if (
    !Number.isFinite(sample.monotonicMs) ||
    !Number.isFinite(sample.wallTimeMs) ||
    sample.wallTimeMs !== decisionTimeMs ||
    (sample.hostOffsetMs !== undefined && !Number.isFinite(sample.hostOffsetMs))
  ) {
    throw new GameControllerError(
      'invalid-configuration',
      'The time source must return finite references at the supplied decision time.',
    );
  }
  return sample.hostOffsetMs === undefined
    ? { monotonicMs: sample.monotonicMs, wallTimeMs: decisionTimeMs }
    : {
        monotonicMs: sample.monotonicMs,
        wallTimeMs: decisionTimeMs,
        hostOffsetMs: sample.hostOffsetMs,
      };
}

function createClockState(checkpoint: GameCheckpointV1): ClockState | null {
  const clocks = checkpoint.clocks;
  if (clocks.schemaVersion !== 1) {
    throw new GameControllerError('saved-game-invalid', 'The saved clock schema is unsupported.');
  }
  if (clocks.activeSide === null) {
    if (clocks.anchor !== null) {
      throw new GameControllerError('saved-game-invalid', 'A stopped clock cannot retain a running anchor.');
    }
    return null;
  }
  if (clocks.anchor === null) {
    throw new GameControllerError('saved-game-invalid', 'An active clock must have a reference anchor.');
  }
  return {
    schemaVersion: clocks.schemaVersion,
    timeControl: { ...clocks.timeControl },
    banksAtAnchor: { ...clocks.banksAtAnchor },
    activeSide: clocks.activeSide,
    anchor: clocks.anchor.hostOffsetMs === undefined
      ? { monotonicMs: clocks.anchor.monotonicMs, wallTimeMs: clocks.anchor.wallTimeMs }
      : {
          monotonicMs: clocks.anchor.monotonicMs,
          wallTimeMs: clocks.anchor.wallTimeMs,
          hostOffsetMs: clocks.anchor.hostOffsetMs,
        },
  };
}

function copyNamespace(value: GameNamespaceV1): GameNamespaceV1 {
  if (typeof value !== 'object' || value === null) {
    throw new GameControllerError('invalid-setup', 'The ownership namespace is invalid.');
  }
  if (value.kind === 'guest' && Object.keys(value).length === 1) return { kind: 'guest' };
  if (
    value.kind === 'account' &&
    Object.keys(value).length === 2 &&
    typeof value.accountId === 'string' &&
    value.accountId.length > 0
  ) {
    return { kind: 'account', accountId: value.accountId };
  }
  throw new GameControllerError('invalid-setup', 'The ownership namespace is invalid.');
}

function checkpointClock(state: ClockState, lastReconciledAtMs: number): GameCheckpointV1['clocks'] {
  return {
    schemaVersion: state.schemaVersion,
    timeControl: { ...state.timeControl },
    banksAtAnchor: { ...state.banksAtAnchor },
    activeSide: state.activeSide,
    anchor: state.anchor.hostOffsetMs === undefined
      ? { monotonicMs: state.anchor.monotonicMs, wallTimeMs: state.anchor.wallTimeMs }
      : {
          monotonicMs: state.anchor.monotonicMs,
          wallTimeMs: state.anchor.wallTimeMs,
          hostOffsetMs: state.anchor.hostOffsetMs,
        },
    lastReconciledAtMs,
  };
}

function pausedClockCheckpoint(
  timeControl: TimeControl,
  banksAtAnchor: ClockBanks,
  lastReconciledAtMs: number,
  schemaVersion = 1,
): GameCheckpointV1['clocks'] {
  return {
    schemaVersion: schemaVersion as 1,
    timeControl: { ...timeControl },
    banksAtAnchor: { ...banksAtAnchor },
    activeSide: null,
    anchor: null,
    lastReconciledAtMs,
  };
}

function stopClock(state: ClockState, lastReconciledAtMs: number): GameCheckpointV1['clocks'] {
  return pausedClockCheckpoint(
    state.timeControl,
    state.banksAtAnchor,
    lastReconciledAtMs,
    state.schemaVersion,
  );
}

function finalResultForPosition(
  position: Position,
  facts: ReturnType<typeof observeEndingFacts>,
  eventId: string,
  decidedAtMs: number,
  materialChecks = true,
): Extract<GameResultV1, { kind: 'final' }> | null {
  const sideToMove = fromPositionColor(position.sideToMove);
  if (facts.checkmate) {
    return {
      kind: 'final',
      winner: sideToMove === 'white' ? 'black' : 'white',
      reason: 'checkmate',
      eventId,
      decidedAtMs,
    };
  }
  if (facts.stalemate) {
    return { kind: 'final', winner: 'draw', reason: 'stalemate', eventId, decidedAtMs };
  }
  if (materialChecks && facts.insufficientMaterial) {
    return { kind: 'final', winner: 'draw', reason: 'dead-position', eventId, decidedAtMs };
  }
  if (facts.thirdRepetition) {
    return { kind: 'final', winner: 'draw', reason: 'threefold-repetition', eventId, decidedAtMs };
  }
  if (facts.hundredHalfmoves) {
    return { kind: 'final', winner: 'draw', reason: 'fifty-move-rule', eventId, decidedAtMs };
  }
  return null;
}

function lichessExtensions(checkpoint: GameCheckpointV1): GameCheckpointV1['extensions'] {
  const extensions = { ...checkpoint.extensions };
  delete extensions[ADJUDICATION_EXTENSION];
  // A legacy undo baseline can itself contain the old proof graph.
  delete extensions['undo-baseline'];
  extensions['position-rules'] = { version: 1, data: { policy: 'lichess', chessops: '0.15.1' } };
  return extensions;
}

function migrateLichessCheckpoint(checkpoint: GameCheckpointV1, position: Position): GameCheckpointV1 {
  if (checkpoint.extensions['position-rules'] !== undefined && checkpoint.extensions[ADJUDICATION_EXTENSION] === undefined) return checkpoint;
  if (checkpoint.result.kind === 'final') {
    const verified = validateAcceptedAdjudicationEvidence(checkpoint);
    return { ...verified, extensions: lichessExtensions(verified) };
  }
  const ledger = restoreRepetitionLedger({ version: checkpoint.rules.repetitionLedger.version,
    entries: checkpoint.rules.repetitionLedger.positions });
  const old = checkpoint.result;
  const eventId = old.kind === 'pending-adjudication' ? old.eventId : checkpoint.archive.currentLine.eventIds[0] ?? 'rules-migration';
  let result: GameResultV1 = finalResultForPosition(position, observeEndingFacts(position, ledger), eventId, checkpoint.updatedAtMs) ?? { kind: 'unresolved' };
  if (result.kind === 'unresolved' && old.kind === 'pending-adjudication' && (old.reason === 'timeout' || (old.activeClockDeadlineMs !== null && checkpoint.clocks.activeSide === null))) {
    result = { kind: 'final', winner: timeoutWinner(position, position.sideToMove), reason: 'timeout', eventId,
      decidedAtMs: old.eventAtMs };
  }
  return { ...checkpoint, result, extensions: lichessExtensions(checkpoint),
    clocks: result.kind === 'final' ? { ...checkpoint.clocks, activeSide: null, anchor: null } : checkpoint.clocks };
}

function sideForCheckpoint(checkpoint: GameCheckpointV1): ClockSide {
  return toClockSide(checkpoint.rules.sideToMove);
}

function modelSideForCheckpoint(checkpoint: GameCheckpointV1): ClockSide | null {
  if (checkpoint.selections.players.white.kind === 'model' && checkpoint.selections.players.black.kind === 'model') return sideForCheckpoint(checkpoint);
  if (checkpoint.selections.players.white.kind === 'model') return 'white';
  if (checkpoint.selections.players.black.kind === 'model') return 'black';
  return null;
}

function readResultDeclaration(value: unknown): GameResultDeclarationV1 {
  if (value === null || typeof value !== 'object') {
    throw new GameControllerError('invalid-intent', 'The result declaration is invalid.');
  }
  const record = value as { kind?: unknown; side?: unknown };
  if (record.kind === 'draw') return { kind: 'draw' };
  if (record.kind === 'resignation' && (record.side === 'white' || record.side === 'black')) {
    return { kind: 'resignation', side: record.side };
  }
  throw new GameControllerError('invalid-intent', 'The result declaration is invalid.');
}

function createFence(checkpoint: GameCheckpointV1): ControllerFenceV1 {
  const side = sideForCheckpoint(checkpoint);
  const selection = handoffData(checkpoint).producing ?? checkpoint.selections.players[side];
  return {
    schemaVersion: 1,
    gameId: checkpoint.gameId,
    segmentId: checkpoint.segmentId,
    side,
    revision: checkpoint.revision,
    positionRevision: checkpoint.positionRevision,
    requestGeneration: checkpoint.requestGeneration,
    analysisGeneration: checkpoint.analysisGeneration,
    ownershipEpoch: checkpoint.ownershipEpoch,
    modelConfigurationIdentity: selection.kind === 'model'
      ? modelConfigurationIdentity(selection)
      : null,
  };
}

function adjudicationExtension(checkpoint: GameCheckpointV1): AdjudicationExtensionV1 {
  const section = checkpoint.extensions[ADJUDICATION_EXTENSION];
  if (section === undefined) {
    return { version: 1, data: { candidates: [], activeQueryIdentity: null } };
  }
  if (section.version !== 1 || typeof section.data !== 'object' || section.data === null) {
    throw new GameControllerError('saved-game-invalid', 'The saved adjudication extension is invalid.');
  }
  const data = section.data as unknown as AdjudicationExtensionV1['data'];
  if (!Array.isArray(data.candidates) || !(data.activeQueryIdentity === null || typeof data.activeQueryIdentity === 'string')) {
    throw new GameControllerError('saved-game-invalid', 'The saved adjudication candidate list is invalid.');
  }
  for (const candidate of data.candidates) {
    if (typeof candidate !== 'object' || candidate === null || typeof candidate.query !== 'object' || candidate.query === null) {
      throw new GameControllerError('saved-game-invalid', 'The saved adjudication candidate is malformed.');
    }
    const queryIsCanonical = (() => {
      try {
        return candidate.query.queryIdentity === proofQueryIdentity(candidate.query) &&
          parsePosition(candidate.query.positionFen).fen === candidate.query.positionFen;
      } catch {
        return false;
      }
    })();
    if ((candidate.kind !== 'deadness' && candidate.kind !== 'timeout') ||
        typeof candidate.eventId !== 'string' || candidate.eventId.length === 0 ||
        !Number.isFinite(candidate.eventAtMs) ||
        !(candidate.deadlineMs === null || Number.isFinite(candidate.deadlineMs)) ||
        !['queued', 'running', 'stopped', 'accepted'].includes(candidate.status) ||
        !(candidate.requestId === null || typeof candidate.requestId === 'string') ||
        !queryIsCanonical || candidate.query.gameId !== checkpoint.gameId || candidate.query.segmentId !== checkpoint.segmentId ||
        candidate.query.ownershipEpoch !== String(checkpoint.ownershipEpoch) ||
        (candidate.kind === 'deadness' && candidate.query.predicate !== 'global-deadness') ||
        (candidate.kind === 'timeout' && candidate.query.predicate !== 'timeout-opponent-mating') ||
        (candidate.status === 'running' ? candidate.requestId === null : candidate.requestId !== null) ||
        (candidate.status !== 'accepted' && (candidate.query.positionFen !== checkpoint.rules.currentFen ||
          candidate.query.positionRevision !== String(checkpoint.positionRevision) ||
          candidate.query.analysisGeneration !== String(checkpoint.analysisGeneration)))) {
      throw new GameControllerError('saved-game-invalid', 'The saved adjudication candidate is malformed or bound to another game.');
    }
  }
  const runningCandidates = data.candidates.filter((candidate) => candidate.status === 'running');
  if (runningCandidates.length > 1 ||
      (runningCandidates.length === 1 && data.activeQueryIdentity !== runningCandidates[0]?.query.queryIdentity) ||
      (runningCandidates.length === 0 && data.activeQueryIdentity !== null)) {
    throw new GameControllerError('saved-game-invalid', 'The saved active adjudication request does not match its candidate.');
  }
  return structuredClone({ version: 1, data });
}

function validateAcceptedAdjudicationEvidence(checkpoint: GameCheckpointV1): GameCheckpointV1 {
  const extension = adjudicationExtension(checkpoint);
  let changed = false;
  const candidates = extension.data.candidates.map((candidate) => {
    if (candidate.status !== 'accepted') return candidate;
    if (candidate.acceptedEvidence === undefined || typeof candidate.acceptedConclusion !== 'string') {
      changed = true;
      return { ...candidate, status: 'queued' as const, requestId: null, searchCheckpoint: null };
    }
    const checked = checkProofEvidence(candidate.query, candidate.acceptedEvidence);
    const resultMatchesProof = checkpoint.result.kind !== 'final' || candidate.eventId !== checkpoint.result.eventId ||
      (checkpoint.result.reason === 'dead-position' && candidate.kind === 'deadness' && checked.status === 'accepted' && checked.conclusion === 'dead') ||
      (checkpoint.result.reason === 'timeout' && candidate.kind === 'timeout' && checked.status === 'accepted' &&
        ((checked.conclusion === 'opponent-can-mate' && checkpoint.result.winner !== 'draw') ||
          (checked.conclusion === 'opponent-cannot-mate' && checkpoint.result.winner === 'draw')));
    if (checked.status !== 'accepted' || checked.conclusion !== candidate.acceptedConclusion || !resultMatchesProof) {
      if (checkpoint.result.kind === 'final' && (checkpoint.result.reason === 'dead-position' || checkpoint.result.reason === 'timeout')) {
        throw new GameControllerError('saved-game-invalid', 'A final adjudication result has no matching checked proof.');
      }
      changed = true;
      return { ...candidate, status: 'queued' as const, requestId: null, searchCheckpoint: null };
    }
    return candidate;
  });
  return changed ? { ...checkpoint, extensions: withAdjudicationExtension(checkpoint, { version: 1,
    data: { candidates, activeQueryIdentity: null } }) } : checkpoint;
}

function withAdjudicationExtension(
  checkpoint: GameCheckpointV1,
  extension: AdjudicationExtensionV1,
): GameCheckpointV1['extensions'] {
  return {
    ...checkpoint.extensions,
    [ADJUDICATION_EXTENSION]: {
      version: 1,
      data: JSON.parse(JSON.stringify(extension.data)) as GameCheckpointV1['extensions'][string]['data'],
    },
  };
}

/**
 * Rewrites the adjudication list so every retained candidate still describes the committed
 * segment, epoch and position. Candidates are bound to the position that raised them, so an
 * undo or a new practice segment drops the ones it moves away from instead of reviving them.
 */
function carriedAdjudicationExtensions(
  extensions: GameCheckpointV1['extensions'],
  candidates: readonly AdjudicationCandidateV1[],
): GameCheckpointV1['extensions'] {
  if (extensions['position-rules'] !== undefined) return withoutExtension(extensions, ADJUDICATION_EXTENSION);
  return {
    ...extensions,
    [ADJUDICATION_EXTENSION]: {
      version: 1,
      data: JSON.parse(JSON.stringify({ candidates, activeQueryIdentity: null })) as JsonValue,
    },
  };
}

function withoutExtension(
  extensions: GameCheckpointV1['extensions'],
  name: string,
): GameCheckpointV1['extensions'] {
  const retained: GameCheckpointV1['extensions'] = {};
  for (const [key, section] of Object.entries(extensions)) {
    if (key === name) continue;
    retained[key] = section;
  }
  return retained;
}

function deadnessQuery(checkpoint: GameCheckpointV1): ProofQuery {
  return createDeadnessQuery({
    gameId: checkpoint.gameId,
    segmentId: checkpoint.segmentId,
    positionRevision: String(checkpoint.positionRevision),
    analysisGeneration: String(checkpoint.analysisGeneration),
    ownershipEpoch: String(checkpoint.ownershipEpoch),
    positionFen: checkpoint.rules.currentFen,
  });
}

function timeoutQuery(checkpoint: GameCheckpointV1, expiredSide: ClockSide): ProofQuery {
  return createTimeoutMatingQuery({
    gameId: checkpoint.gameId,
    segmentId: checkpoint.segmentId,
    positionRevision: String(checkpoint.positionRevision),
    analysisGeneration: String(checkpoint.analysisGeneration),
    ownershipEpoch: String(checkpoint.ownershipEpoch),
    positionFen: checkpoint.rules.currentFen,
    expiredColor: expiredSide === 'white' ? 'w' : 'b',
  });
}

function jsonSafe(value: unknown): GameCheckpointV1['extensions'][string]['data'] {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : JSON.parse(serialized) as GameCheckpointV1['extensions'][string]['data'];
  } catch {
    return null;
  }
}

function validateMoveAttemptsExtension(section: VersionedExtensionSectionV1 | undefined): void {
  if (section === undefined) return;
  const data = section.data;
  if (section.version !== 1 || data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new GameControllerError('saved-game-invalid', 'The saved move-attempt extension is invalid.');
  }
  const values = data as Record<string, unknown>;
  if (Object.keys(values).some((key) => key !== 'white' && key !== 'black')) {
    throw new GameControllerError('saved-game-invalid', 'The saved move-attempt extension is invalid.');
  }
  for (const side of ['white', 'black'] as const) {
    const records = values[side] ?? [];
    if (!Array.isArray(records) || records.some((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return true;
      const record = item as Record<string, unknown>;
      const move = record.move;
      const violation = record.violation;
      return !Number.isSafeInteger(record.attempt) || (record.attempt as number) < 1 || (record.attempt as number) > MAX_ILLEGAL_MOVE_ATTEMPTS ||
        record.modelConfigurationIdentity !== null && typeof record.modelConfigurationIdentity !== 'string' ||
        move === null || typeof move !== 'object' || typeof (move as Record<string, unknown>).from !== 'string' || typeof (move as Record<string, unknown>).to !== 'string' ||
        violation === null || typeof violation !== 'object' || typeof (violation as Record<string, unknown>).code !== 'string' ||
        typeof (violation as Record<string, unknown>).message !== 'string';
    })) throw new GameControllerError('saved-game-invalid', 'The saved move-attempt extension is invalid.');
  }
}

function appendMoveAttempt(
  extensions: GameCheckpointV1['extensions'], side: ClockSide, record: JsonValue,
): GameCheckpointV1['extensions'] {
  const section = extensions[MOVE_ATTEMPTS_EXTENSION];
  validateMoveAttemptsExtension(section);
  const data = section?.data as { white?: readonly JsonValue[]; black?: readonly JsonValue[] } | undefined;
  return {
    ...extensions,
    [MOVE_ATTEMPTS_EXTENSION]: { version: 1, data: {
      white: [...(data?.white ?? []), ...(side === 'white' ? [record] : [])],
      black: [...(data?.black ?? []), ...(side === 'black' ? [record] : [])],
    } },
  };
}

function rebindPendingCandidates(
  prior: GameCheckpointV1,
  next: GameCheckpointV1,
): GameCheckpointV1['extensions'] {
  if (next.extensions['position-rules'] !== undefined) return withoutExtension(next.extensions, ADJUDICATION_EXTENSION);
  const extension = adjudicationExtension(prior);
  const candidates = extension.data.candidates.map((candidate) => {
    if (candidate.status === 'accepted') return candidate;
    const query = candidate.kind === 'timeout'
      ? timeoutQuery(next, candidate.query.predicate === 'timeout-opponent-mating' && candidate.query.expiredColor === 'w' ? 'white' : 'black')
      : deadnessQuery(next);
    return {
      kind: candidate.kind,
      eventId: candidate.eventId,
      eventAtMs: candidate.eventAtMs,
      deadlineMs: candidate.deadlineMs,
      query,
      searchCheckpoint: null,
      status: 'queued' as const,
      requestId: null,
    };
  });
  return withAdjudicationExtension(prior, { version: 1, data: { candidates, activeQueryIdentity: null } });
}

/** Prepare a locally owned checkpoint from an accepted cloud checkpoint without changing chess state. */
export function prepareOwnershipTakeover(checkpoint: GameCheckpointV1, newEpoch: number): GameCheckpointV1 {
  if (!Number.isSafeInteger(newEpoch) || newEpoch <= checkpoint.ownershipEpoch ||
      checkpoint.revision >= Number.MAX_SAFE_INTEGER || checkpoint.requestGeneration >= Number.MAX_SAFE_INTEGER ||
      checkpoint.analysisGeneration >= Number.MAX_SAFE_INTEGER) {
    throw new GameControllerError('invalid-configuration', 'Ownership takeover requires a strictly newer safe epoch and available generation counters.');
  }
  const handoff = handoffData(checkpoint);
  const queued = handoff.queued === null ? null : {
    ...handoff.queued,
    state: 'queued' as const,
    failure: null,
  };
  const next: GameCheckpointV1 = {
    ...checkpoint,
    revision: checkpoint.revision + 1,
    ownershipEpoch: newEpoch,
    requestGeneration: checkpoint.requestGeneration + 1,
    analysisGeneration: checkpoint.analysisGeneration + 1,
    extensions: withHandoff(checkpoint, { producing: null, queued }),
  };
  if (next.extensions['position-rules'] !== undefined) return next;
  const adjudication = adjudicationExtension(checkpoint);
  const candidates = adjudication.data.candidates.map((candidate) => {
    const query = candidate.kind === 'timeout'
      ? timeoutQuery(next, candidate.query.predicate === 'timeout-opponent-mating' && candidate.query.expiredColor === 'w' ? 'white' : 'black')
      : deadnessQuery(next);
    return {
      kind: candidate.kind,
      eventId: candidate.eventId,
      eventAtMs: candidate.eventAtMs,
      deadlineMs: candidate.deadlineMs,
      query,
      searchCheckpoint: null,
      status: 'queued' as const,
      requestId: null,
    };
  });
  return {
    ...next,
    extensions: withAdjudicationExtension(next, { version: 1, data: { candidates, activeQueryIdentity: null } }),
  };
}

function copySnapshot(snapshot: ControllerSnapshotV1): ControllerSnapshotV1 {
  return {
    checkpoint: structuredClone(snapshot.checkpoint),
    position: snapshot.position,
    clockReading: snapshot.clockReading === null ? null : structuredClone(snapshot.clockReading),
    fence: { ...snapshot.fence },
    readiness: snapshot.readiness,
    adjudication: structuredClone(snapshot.adjudication),
    modelHandoff: structuredClone(snapshot.modelHandoff),
  };
}

function freezeModelSelection(selection: ModelSelection): ModelSelection {
  return {
    kind: 'model',
    providerId: selection.providerId,
    connectionId: selection.connectionId,
    configurationRevision: selection.configurationRevision,
    modelRoutingId: selection.modelRoutingId,
    protocol: selection.protocol,
    diagnostic: selection.diagnostic,
  };
}

function prepareSetup(
  setup: GameControllerSetupV1,
  idFactory: () => string,
  randomSide: () => ClockSide,
): PreparedSetup {
  if (setup.modelSelection !== undefined) modelConfigurationIdentity(setup.modelSelection);
  if (setup.players !== undefined) {
    for (const side of ['white', 'black'] as const) {
      const player = setup.players[side];
      if (player.kind === 'model') modelConfigurationIdentity(player);
      else if (player.kind !== 'human') throw new GameControllerError('invalid-setup', 'Unknown player type.');
    }
  }
  if (!Number.isSafeInteger(setup.ownershipEpoch) || setup.ownershipEpoch < 0) {
    throw new GameControllerError('invalid-setup', 'The ownership epoch must be a nonnegative safe integer.');
  }
  const namespace = copyNamespace(setup.namespace);
  const timeControl = setup.timeControl ?? DEFAULT_TIME_CONTROL;
  if (
    !Number.isFinite(timeControl.startingTimeMs) ||
    timeControl.startingTimeMs <= 0 ||
    !Number.isFinite(timeControl.incrementMs) ||
    timeControl.incrementMs < 0
  ) {
    throw new GameControllerError('invalid-setup', 'The time control must have positive starting time and nonnegative increment.');
  }
  const humanSide = setup.humanSide === 'random' ? randomSide() : setup.humanSide;
  if (humanSide !== 'white' && humanSide !== 'black') {
    throw new GameControllerError('invalid-setup', 'The selected human side is invalid.');
  }
  const position = parsePosition(setup.startingFen ?? INITIAL_POSITION);
  const segmentId = idFactory();
  const lineId = idFactory();
  if (
    typeof segmentId !== 'string' ||
    segmentId.length === 0 ||
    typeof lineId !== 'string' ||
    lineId.length === 0 ||
    segmentId === lineId
  ) {
    throw new GameControllerError('invalid-setup', 'The identifier source must return distinct nonempty IDs.');
  }
  return {
    humanSide,
    ...(setup.players === undefined ? {} : { players: structuredClone(setup.players) }),
    modelSelection: setup.modelSelection === undefined ? null : freezeModelSelection(setup.modelSelection),
    namespace,
    ownershipEpoch: setup.ownershipEpoch,
    startingFen: setup.startingFen ?? INITIAL_POSITION,
    position,
    timeControl: { ...timeControl },
    segmentId,
    lineId,
  };
}

function makeCheckpoint(
  gameId: string,
  prepared: PreparedSetup,
  clock: ClockState | null,
  decisionTimeMs: number,
  createdEventId: string,
  result: GameResultV1 = { kind: 'unresolved' },
): GameCheckpointV1 {
  const ledger = createRepetitionLedger(prepared.position);
  const players: Record<ClockSide, PlayerSelectionV1> = prepared.players ?? {
    white: prepared.modelSelection === null || prepared.humanSide === 'white' ? { kind: 'human' } : prepared.modelSelection,
    black: prepared.modelSelection === null || prepared.humanSide === 'black' ? { kind: 'human' } : prepared.modelSelection,
  };
  return {
    schemaVersion: 1,
    gameId,
    namespace: structuredClone(prepared.namespace),
    revision: 1,
    ownershipEpoch: prepared.ownershipEpoch,
    segmentId: prepared.segmentId,
    positionRevision: 0,
    requestGeneration: 0,
    analysisGeneration: 0,
    updatedAtMs: decisionTimeMs,
    rules: {
      variant: 'orthodox',
      startingFen: prepared.startingFen,
      currentFen: prepared.position.fen,
      sideToMove: fromPositionColor(prepared.position.sideToMove),
      castlingRights: prepared.position.castlingRights,
      enPassantSquare: prepared.position.enPassantSquare,
      halfmoveClock: prepared.position.halfmoveClock,
      fullmoveNumber: prepared.position.fullmoveNumber,
      repetitionLedger: {
        version: 1,
        positions: ledger.entries.map((entry) => ({ ...entry })),
      },
      moves: [],
    },
    history: {
      currentSegmentId: prepared.segmentId,
      segments: [
        {
          segmentId: prepared.segmentId,
          providerId: prepared.modelSelection?.providerId ?? null,
          modelRoutingId: prepared.modelSelection?.modelRoutingId ?? null,
          connectionRevision: prepared.modelSelection?.configurationRevision ?? null,
          startedAtMs: decisionTimeMs,
          messageIds: [],
        },
      ],
      messages: [],
    },
    clocks: clock === null
      ? pausedClockCheckpoint(
          prepared.timeControl,
          {
            whiteMs: prepared.timeControl.startingTimeMs,
            blackMs: prepared.timeControl.startingTimeMs,
          },
          decisionTimeMs,
        )
      : checkpointClock(clock, decisionTimeMs),
    budgets: {
      formattingCorrectionsRemaining: MAX_FORMAT_CORRECTIONS,
      illegalMoveAttemptsRemaining: { white: MAX_ILLEGAL_MOVE_ATTEMPTS, black: MAX_ILLEGAL_MOVE_ATTEMPTS },
      manualRetriesBySide: { white: 0, black: 0 },
    },
    selections: { players },
    archive: {
      egressStatus: 'eligible',
      currentLine: { lineId: prepared.lineId, eventIds: [createdEventId] },
      discardedLines: [],
    },
    result,
    practice: {
      mode: 'ordinary',
      scored: true,
      sourceGameId: null,
      sourcePositionFen: null,
      originalResult: null,
    },
    extensions: {},
  };
}

function sameFence(left: ControllerFenceV1, right: ControllerFenceV1): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.gameId === right.gameId &&
    left.segmentId === right.segmentId &&
    left.side === right.side &&
    left.revision === right.revision &&
    left.positionRevision === right.positionRevision &&
    left.requestGeneration === right.requestGeneration &&
    left.analysisGeneration === right.analysisGeneration &&
    left.ownershipEpoch === right.ownershipEpoch &&
    left.modelConfigurationIdentity === right.modelConfigurationIdentity;
}

function sameRequestFence(left: ControllerFenceV1, right: ControllerFenceV1): boolean {
  return left.gameId === right.gameId && left.segmentId === right.segmentId && left.side === right.side &&
    left.positionRevision === right.positionRevision && left.requestGeneration === right.requestGeneration &&
    left.analysisGeneration === right.analysisGeneration && left.ownershipEpoch === right.ownershipEpoch &&
    left.modelConfigurationIdentity === right.modelConfigurationIdentity;
}

const UNDO_BASELINE_EXTENSION = 'undo-baseline';
const MODEL_HANDOFF_EXTENSION = 'model-handoff';
interface ModelHandoffDataV1 {
  readonly producing: ModelSelection | null;
  readonly queued: { readonly selection: ModelSelection; readonly state: 'queued' | 'awaiting-first-reply' | 'failed'; readonly failure: string | null } | null;
}

function handoffData(checkpoint: GameCheckpointV1): ModelHandoffDataV1 {
  const section = checkpoint.extensions[MODEL_HANDOFF_EXTENSION];
  if (section?.version === 1 && section.data && typeof section.data === 'object') {
    const data = section.data as unknown as ModelHandoffDataV1;
    if ((data.producing === null || data.producing?.kind === 'model') &&
        (data.queued === null || data.queued?.selection?.kind === 'model')) return data;
  }
  return { producing: null, queued: null };
}

function withHandoff(checkpoint: GameCheckpointV1, data: ModelHandoffDataV1): GameCheckpointV1['extensions'] {
  return { ...checkpoint.extensions, [MODEL_HANDOFF_EXTENSION]: { version: 1, data: jsonSafe(data) } };
}

function handoffSnapshot(checkpoint: GameCheckpointV1): ModelHandoffSnapshotV1 {
  const side = modelSideForCheckpoint(checkpoint) ?? 'black';
  const committed = checkpoint.selections.players[side];
  const state = handoffData(checkpoint);
  return { committed: committed.kind === 'model' ? freezeModelSelection(committed) : null,
    producing: state.producing === null ? null : freezeModelSelection(state.producing),
    queued: state.queued === null ? null : { ...state.queued, selection: freezeModelSelection(state.queued.selection) } };
}

function undoBaselineSection(checkpoint: GameCheckpointV1): VersionedExtensionSectionV1 {
  const previous = readUndoBaseline(checkpoint);
  const points = previous === undefined ? [] : [...undoPoints(previous), compactUndoPoint(previous)];
  const extensions = withoutExtension(withoutUndoBaseline(checkpoint.extensions), 'undo-points');
  if (points.length > 0) extensions['undo-points'] = { version: 1, data: jsonSafe(points) };
  return { version: 1, data: JSON.parse(JSON.stringify({ ...checkpoint, extensions })) as JsonValue };
}

interface CompactUndoPoint {
  readonly moveCount: number;
  readonly eventCount: number;
  readonly messageCount: number;
  readonly segmentCount: number;
  readonly discardedLineCount: number;
  readonly segmentId: string;
  readonly selections: GameCheckpointV1['selections'];
  readonly budgets: GameCheckpointV1['budgets'];
  readonly extensions: GameCheckpointV1['extensions'];
}

function undoPoints(checkpoint: GameCheckpointV1): readonly CompactUndoPoint[] {
  const section = checkpoint.extensions['undo-points'];
  if (section === undefined) return [];
  if (section.version !== 1 || !Array.isArray(section.data)) {
    throw new GameControllerError('saved-game-invalid', 'The saved undo points are invalid.');
  }
  return section.data as unknown as readonly CompactUndoPoint[];
}

function compactUndoPoint(checkpoint: GameCheckpointV1): CompactUndoPoint {
  return { moveCount: checkpoint.rules.moves.length, eventCount: checkpoint.archive.currentLine.eventIds.length,
    messageCount: checkpoint.history.messages.length, segmentCount: checkpoint.history.segments.length,
    discardedLineCount: checkpoint.archive.discardedLines.length, segmentId: checkpoint.segmentId,
    selections: checkpoint.selections, budgets: checkpoint.budgets,
    extensions: withoutExtension(withoutUndoBaseline(checkpoint.extensions), 'undo-points') };
}

/** Rebuild older takebacks from existing ledgers; retain only small turn metadata. */
function previousUndoCheckpoint(checkpoint: GameCheckpointV1): GameCheckpointV1 | null {
  const points = undoPoints(checkpoint);
  const point = points.at(-1);
  if (point === undefined) return null;
  if (!Number.isSafeInteger(point.moveCount) || point.moveCount < 0 || point.moveCount >= checkpoint.rules.moves.length ||
      !Number.isSafeInteger(point.eventCount) || point.eventCount < 0 || point.eventCount > checkpoint.archive.currentLine.eventIds.length ||
      !Number.isSafeInteger(point.messageCount) || point.messageCount < 0 || point.messageCount > checkpoint.history.messages.length ||
      !Number.isSafeInteger(point.segmentCount) || point.segmentCount < 1 || point.segmentCount > checkpoint.history.segments.length ||
      !Number.isSafeInteger(point.discardedLineCount) || point.discardedLineCount < 0 || point.discardedLineCount > checkpoint.archive.discardedLines.length) {
    throw new GameControllerError('saved-game-invalid', 'The saved undo point does not match the move and archive ledgers.');
  }
  const moves = checkpoint.rules.moves.slice(0, point.moveCount);
  const position = parsePosition(moves.at(-1)?.fenAfter ?? checkpoint.rules.startingFen);
  let ledger = createRepetitionLedger(parsePosition(checkpoint.rules.startingFen));
  for (const move of moves) ledger = recordPosition(ledger, parsePosition(move.fenAfter));
  const extensions = { ...point.extensions };
  if (points.length > 1) extensions['undo-points'] = { version: 1, data: jsonSafe(points.slice(0, -1)) };
  return { ...checkpoint, segmentId: point.segmentId, selections: point.selections, budgets: point.budgets,
    rules: { ...checkpoint.rules, moves, currentFen: position.fen, sideToMove: fromPositionColor(position.sideToMove),
      castlingRights: position.castlingRights, enPassantSquare: position.enPassantSquare,
      halfmoveClock: position.halfmoveClock, fullmoveNumber: position.fullmoveNumber,
      repetitionLedger: { version: 1, positions: ledger.entries.map(entry => ({ ...entry })) } },
    history: { currentSegmentId: point.segmentId, segments: checkpoint.history.segments.slice(0, point.segmentCount),
      messages: checkpoint.history.messages.slice(0, point.messageCount) },
    archive: { ...checkpoint.archive, discardedLines: checkpoint.archive.discardedLines.slice(0, point.discardedLineCount),
      currentLine: { ...checkpoint.archive.currentLine, eventIds: checkpoint.archive.currentLine.eventIds.slice(0, point.eventCount) } },
    extensions,
  };
}

/**
 * Reads the stored baseline. The section data is the previous checkpoint verbatim, so an
 * unrecognized or absent shape simply means Undo is unavailable rather than a hard failure.
 */
function readUndoBaseline(checkpoint: GameCheckpointV1): GameCheckpointV1 | undefined {
  const section = checkpoint.extensions[UNDO_BASELINE_EXTENSION];
  if (section === undefined || section.version !== 1) return undefined;
  const data = section.data as Partial<GameCheckpointV1> | null;
  if (data === null || typeof data !== 'object' || data.schemaVersion !== 1) return undefined;
  if (typeof data.gameId !== 'string' || data.gameId !== checkpoint.gameId) return undefined;
  return data.rules === undefined || data.clocks === undefined ? undefined : (data as GameCheckpointV1);
}

function withoutUndoBaseline(
  extensions: GameCheckpointV1['extensions'],
): GameCheckpointV1['extensions'] {
  return withoutExtension(extensions, UNDO_BASELINE_EXTENSION);
}

function validCoordinateMove(move: CoordinateMove): boolean {
  if (typeof move !== 'object' || move === null || Array.isArray(move)) return false;
  const keys = Object.keys(move);
  if (keys.some((key) => key !== 'from' && key !== 'to' && key !== 'promotion')) return false;
  if (typeof move.from !== 'string' || typeof move.to !== 'string') return false;
  return move.promotion === undefined ||
    move.promotion === 'q' ||
    move.promotion === 'r' ||
    move.promotion === 'b' ||
    move.promotion === 'n';
}

function nextUniqueId(idFactory: () => string, used: Set<string>): string {
  const id = idFactory();
  if (typeof id !== 'string' || id.length === 0 || used.has(id)) {
    throw new GameControllerError('invalid-configuration', 'The identifier source returned an empty or duplicate ID.');
  }
  used.add(id);
  return id;
}

function eventPayload(
  fence: ControllerFenceV1,
  details: unknown,
): ArchiveEventV1['payload'] {
  const versionedPayload = {
    schemaVersion: 1,
    fence: {
      schemaVersion: fence.schemaVersion,
      gameId: fence.gameId,
      segmentId: fence.segmentId,
      side: fence.side,
      revision: fence.revision,
      positionRevision: fence.positionRevision,
      requestGeneration: fence.requestGeneration,
      analysisGeneration: fence.analysisGeneration,
      ownershipEpoch: fence.ownershipEpoch,
      modelConfigurationIdentity: fence.modelConfigurationIdentity,
    },
    details,
  };
  return structuredClone(versionedPayload) as unknown as ArchiveEventV1['payload'];
}

function recoveryReading(state: ClockState, sample: TimeSample, policy: ClockComparisonPolicy): RecoveryReading {
  const recovery = recoverClockAfterAbsence(state, sample, policy);
  if (recovery.status === 'recovered' || recovery.status === 'expired') {
    return {
      reading: {
        status: recovery.status === 'recovered' ? 'running' : 'expired',
        activeSide: state.activeSide,
        remaining: recovery.remaining,
        elapsedMs: recovery.elapsedChargedMs,
        deadline: recovery.deadline,
        evidence: recovery.evidence,
      },
      readiness: recovery.status === 'recovered'
        ? 'restore-recovery-pending'
        : 'expiry-persistence-pending',
    };
  }
  return {
    reading: {
      status: 'reconciliation-required',
      activeSide: state.activeSide,
      remaining: null,
      elapsedMs: null,
      deadline: recovery.deadline,
      evidence: recovery.evidence,
      reason: recovery.reason,
    },
    readiness: 'clock-reconciliation-required',
  };
}

interface ControllerDecisionContext {
  readonly checkpoint: GameCheckpointV1;
  readonly position: Position;
  readonly clockState: ClockState | null;
  readonly decisionTimeMs: number;
  readonly at: TimeSample;
  createEvent(
    kind: string,
    occurredAtMs: number,
    fence: ControllerFenceV1,
    details: Record<string, unknown>,
  ): ArchiveEventV1;
  createEventId(): string;
}

interface ControllerDecisionCandidate<Value> {
  readonly checkpoint: GameCheckpointV1;
  readonly position: Position;
  readonly clockState: ClockState | null;
  readonly value: Value;
}

type IntentMutationValue =
  | { kind: 'started' }
  | { kind: 'accepted' }
  | { kind: 'reconciled' }
  | { kind: 'expired' }
  | { kind: 'clock-reconciliation-required' }
  | { kind: 'rejected'; reason: 'not-actionable' | 'wrong-side' | 'illegal-move' };

class IndexedGameController implements GameController {
  private checkpoint: GameCheckpointV1 | null = null;
  private position: Position | null = null;
  private clockState: ClockState | null = null;
  private restored = false;
  private clockReconciliationRequired = false;
  private pendingClockDiscrepancy: ClockDiscrepancyReading | null = null;
  private activeRequest: ModelTurnRequestV1 | null = null;
  private restoredUnsettledModelRequest: ControllerFenceV1 | null = null;
  private initialization: Promise<ControllerSnapshotV1> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(snapshot: ControllerSnapshotV1) => void>();

  constructor(
    private readonly gameId: string,
    private readonly store: GameStore,
    private readonly timeSource: ControllerTimeSource,
    private readonly clockPolicy: ClockComparisonPolicy,
    private readonly idFactory: () => string,
    private readonly randomSide: () => ClockSide,
    private readonly positionChecks: NonNullable<GameControllerOptions['positionChecks']>,
  ) {}

  initialize(setup?: GameControllerSetupV1): Promise<ControllerSnapshotV1> {
    if (this.checkpoint !== null) return Promise.resolve(this.snapshot());
    if (this.initialization !== null) return this.initialization;
    let capturedSetup = setup;
    if (setup !== undefined) {
      try {
        capturedSetup = structuredClone(setup);
      } catch {
        return Promise.reject(new GameControllerError('invalid-setup', 'The game setup must be cloneable.'));
      }
    }
    const initialization = this.loadOrCreate(capturedSetup);
    this.initialization = initialization;
    const clearInitialization = () => {
      if (this.initialization === initialization) this.initialization = null;
    };
    void initialization.then(clearInitialization, clearInitialization);
    return initialization;
  }

  dispatch(intent: GameControllerIntentV1): Promise<GameControllerIntentResultV1> {
    let frozenIntent: GameControllerIntentV1;
    try {
      frozenIntent = structuredClone(intent);
    } catch {
      return Promise.reject(new GameControllerError('invalid-intent', 'The controller intent must be cloneable.'));
    }
    const operation = this.operationQueue.then(() => this.dispatchReady(frozenIntent));
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  appendModelTurnArchive(fence: ControllerFenceV1, entry: ModelTurnArchiveEntryV1, knownCredentials: readonly string[] = []): Promise<ControllerFenceV1 | null> {
    let frozen: ModelTurnArchiveEntryV1;
    try { frozen = structuredClone(entry); } catch {
      return Promise.reject(new GameControllerError('invalid-intent', 'The model archive entry must be cloneable.'));
    }
    const credentials = [...knownCredentials];
    const operation = this.operationQueue.then(() => this.appendModelTurnArchiveReady(fence, frozen, credentials));
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async appendModelTurnArchiveReady(fence: ControllerFenceV1, entry: ModelTurnArchiveEntryV1, knownCredentials: readonly string[]): Promise<ControllerFenceV1 | null> {
    const checkpoint = this.checkpoint;
    const active = this.activeRequest;
    if (checkpoint === null || active === null || !sameRequestFence(active.fence, fence) ||
        !sameRequestFence(createFence(checkpoint), fence)) return null;
    const stored = await this.store.readGame(this.gameId);
    if (stored === null || stored.checkpoint.revision !== checkpoint.revision || stored.checkpoint.ownershipEpoch !== checkpoint.ownershipEpoch ||
        !sameRequestFence(active.fence, fence) || this.checkpoint !== checkpoint) return null;
    const eventId = nextUniqueId(this.idFactory, new Set(stored.events.map((event) => event.eventId)));
    const eventSequence = stored.events.reduce((n, event) => Math.max(n, event.sequence), -1) + 1;
    const chunkSequence = stored.chunks.reduce((n, chunk) => Math.max(n, chunk.sequence), -1) + 1;
    const occurredAtMs = this.timeSource.sample().wallTimeMs;
    const chunkId = 'body' in entry || 'bytes' in entry ? nextUniqueId(this.idFactory, new Set(stored.chunks.map((chunk) => chunk.chunkId))) : null;
    const bytes = 'body' in entry ? entry.body : 'bytes' in entry ? entry.bytes : null;
    const chunk: ArchiveChunkV1 | null = bytes === null || chunkId === null ? null : {
      chunkId, gameId: this.gameId, sequence: chunkSequence, receivedAtMs: occurredAtMs,
      isFinal: entry.kind === 'request' || entry.kind === 'terminal', egressStatus: 'eligible',
      bytes: new Uint8Array(bytes), sha256: await sha256Hex(bytes),
    };
    const event = {
      eventId, gameId: this.gameId, sequence: eventSequence, segmentId: checkpoint.segmentId,
      kind: entry.kind === 'request' ? 'model-request-persisted' : entry.kind === 'response-chunk' ? 'model-response-chunk-received' : 'model-turn-transcript-finalized',
      occurredAtMs, receiveState: entry.kind === 'response-chunk' || (entry.kind === 'terminal' && entry.outcome !== 'complete')
        ? 'partial' as const : 'complete' as const,
      egressStatus: 'eligible' as const,
      payload: eventPayload(fence, entry.kind === 'request'
        ? { requestId: entry.requestId, protocol: entry.protocol, modelId: entry.modelId, bodyChunkId: chunkId }
        : entry.kind === 'response-chunk'
          ? { requestId: entry.requestId, bodyChunkId: chunkId }
          : { requestId: entry.requestId, outcome: entry.outcome, details: jsonSafe(entry.details) }),
      chunkIds: chunk === null ? [] : [chunk.chunkId],
    } satisfies ArchiveEventV1;
    const historyMessages = entry.kind === 'terminal' ? entry.messages.map((message, index) => ({
      messageId: `${entry.requestId}:${index}`, segmentId: checkpoint.segmentId,
      lineId: checkpoint.archive.currentLine.lineId, role: message.role, content: message.content,
      eventIds: [eventId], disposition: 'retained' as const,
    })) : [];
    const nextHistory = historyMessages.length === 0 ? checkpoint.history : {
      ...checkpoint.history,
      messages: [...checkpoint.history.messages, ...historyMessages],
      segments: checkpoint.history.segments.map((segment) => segment.segmentId === checkpoint.segmentId
        ? { ...segment, messageIds: [...segment.messageIds, ...historyMessages.map((message) => message.messageId)] } : segment),
    };
    const nextCheckpoint = {
      ...checkpoint, revision: checkpoint.revision + 1, updatedAtMs: occurredAtMs, history: nextHistory,
      archive: { ...checkpoint.archive, currentLine: { ...checkpoint.archive.currentLine,
        eventIds: [...checkpoint.archive.currentLine.eventIds, eventId] } },
    };
    const result = await this.store.commitCheckpoint({
      gameId: this.gameId, expectedRevision: checkpoint.revision, expectedEpoch: checkpoint.ownershipEpoch,
      events: [event], chunks: chunk === null ? [] : [chunk], knownCredentials,
      decide: () => ({ checkpoint: nextCheckpoint, outboxOperationIds: [] }),
    });
    if (result.kind !== 'committed' || this.checkpoint !== checkpoint || !sameRequestFence(active.fence, fence)) return null;
    this.checkpoint = result.checkpoint;
    this.activeRequest = { ...active, fence: createFence(result.checkpoint) };
    this.publish(this.snapshot());
    return this.snapshot().fence;
  }

  reconcile(): Promise<ControllerSnapshotV1> {
    const operation = this.operationQueue.then(() => this.reconcileReady());
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  snapshot(): ControllerSnapshotV1 {
    const checkpoint = this.checkpoint;
    const position = this.position;
    if (checkpoint === null || position === null) {
      throw new GameControllerError('setup-required', 'Initialize the game before requesting a snapshot.');
    }
    let clockReading: ClockReading | null = null;
    let readiness: ControllerSnapshotV1['readiness'] = 'ready';
    const hasNoActiveDeadline =
      checkpoint.result.kind === 'pending-adjudication' && checkpoint.result.activeClockDeadlineMs === null;
    if (this.clockState !== null && checkpoint.result.kind !== 'final' && !hasNoActiveDeadline) {
      const sample = this.timeSource.sample();
      if (this.restored) {
        const recovery = recoveryReading(this.clockState, sample, this.clockPolicy);
        clockReading = recovery.reading;
        readiness = recovery.readiness;
      } else {
        clockReading = readClockAt(this.clockState, sample, this.clockPolicy);
      }
      if (clockReading.status === 'reconciliation-required') {
        this.rememberClockDiscrepancy(clockReading);
      }
      if (!this.restored && clockReading.status === 'expired') {
        readiness = 'expiry-persistence-pending';
      } else if (!this.restored && clockReading.status === 'reconciliation-required') {
        readiness = 'clock-reconciliation-required';
      }
    }
    if (this.clockReconciliationRequired) readiness = 'clock-reconciliation-required';
    return {
      checkpoint: structuredClone(checkpoint),
      position,
      clockReading,
      fence: createFence(checkpoint),
      readiness,
      adjudication: this.adjudicationStatus(checkpoint),
      modelHandoff: handoffSnapshot(checkpoint),
    };
  }

  private adjudicationStatus(checkpoint: GameCheckpointV1): ControllerSnapshotV1['adjudication'] {
    const extension = adjudicationExtension(checkpoint);
    const active = extension.data.candidates.find((candidate) => candidate.query.queryIdentity === extension.data.activeQueryIdentity) ??
      extension.data.candidates.find((candidate) => candidate.status !== 'accepted');
    if (active === undefined) {
      return {
        status: checkpoint.result.kind === 'pending-adjudication' && checkpoint.result.reason === 'dead-position'
          ? 'setup-ready'
          : 'none',
        query: null,
        requestId: null,
      };
    }
    return { status: active.status === 'accepted' ? 'none' : active.status, query: structuredClone(active.query), requestId: active.requestId };
  }

  subscribe(listener: (snapshot: ControllerSnapshotV1) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  continueAdjudication(fence: ControllerFenceV1): Promise<AdjudicationWorkV1 | null> {
    const operation = this.operationQueue.then(async () => {
      const checkpoint = this.checkpoint;
      if (checkpoint?.result.kind === 'pending-adjudication' && checkpoint.result.activeClockDeadlineMs !== null &&
          this.snapshot().clockReading?.status === 'expired' &&
          !adjudicationExtension(checkpoint).data.candidates.some((item) => item.kind === 'timeout')) {
        await this.reconcileReady();
        return null;
      }
      if (checkpoint === null || !sameFence(createFence(checkpoint), fence)) return null;
      const extension = adjudicationExtension(checkpoint);
      const candidate = extension.data.candidates.find((item) => item.status !== 'accepted');
      if (candidate === undefined || checkpoint.result.kind === 'final') return null;
      if (candidate.status === 'running' && candidate.requestId !== null) return null;
      const requestId = candidate.query.queryIdentity;
      const committed = await this.commitMutation<{ kind: 'accepted' }>(fence, (context) => {
        const current = adjudicationExtension(context.checkpoint);
        const candidates = current.data.candidates.map((item) => item.query.queryIdentity === candidate.query.queryIdentity
          ? { ...item, status: 'running' as const, requestId }
          : item);
        const event = context.createEvent('adjudication-analysis-continued', context.decisionTimeMs, fence, {
          queryIdentity: candidate.query.queryIdentity,
          requestId,
        });
        const next = { ...context.checkpoint, extensions: withAdjudicationExtension(context.checkpoint, {
          version: 1,
          data: { candidates, activeQueryIdentity: candidate.query.queryIdentity },
        }), archive: { ...context.checkpoint.archive, currentLine: {
          ...context.checkpoint.archive.currentLine,
          eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId],
        } } };
        return { checkpoint: next, position: context.position, clockState: context.clockState, value: { kind: 'accepted' } };
      });
      const updated = adjudicationExtension(committed.snapshot.checkpoint).data.candidates.find((item) => item.query.queryIdentity === candidate.query.queryIdentity);
      if (updated === undefined || updated.status !== 'running') return null;
      return { requestId, fence: committed.snapshot.fence, query: structuredClone(updated.query), searchCheckpoint: structuredClone(updated.searchCheckpoint) };
    });
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  stopAdjudication(fence: ControllerFenceV1): Promise<ControllerSnapshotV1> {
    const operation = this.operationQueue.then(async () => {
      const checkpoint = this.checkpoint;
      if (checkpoint?.result.kind === 'pending-adjudication' && checkpoint.result.activeClockDeadlineMs !== null &&
          this.snapshot().clockReading?.status === 'expired' &&
          !adjudicationExtension(checkpoint).data.candidates.some((item) => item.kind === 'timeout')) {
        await this.reconcileReady();
        return this.snapshot();
      }
      if (checkpoint === null || !sameFence(createFence(checkpoint), fence)) return this.snapshot();
      const extension = adjudicationExtension(checkpoint);
      const candidate = extension.data.candidates.find((item) => item.status === 'running');
      if (candidate === undefined) return this.snapshot();
      const committed = await this.commitMutation<{ kind: 'accepted' }>(fence, (context) => {
        const nextBase = { ...context.checkpoint, analysisGeneration: context.checkpoint.analysisGeneration + 1 };
        const reboundExtension = adjudicationExtension({ ...context.checkpoint,
          extensions: rebindPendingCandidates(context.checkpoint, nextBase),
          analysisGeneration: nextBase.analysisGeneration,
        });
        const reboundCandidate = reboundExtension.data.candidates.find((item) => item.kind === candidate.kind &&
          item.eventId === candidate.eventId);
        if (reboundCandidate === undefined) throw new GameControllerError('saved-game-invalid', 'The active adjudication candidate disappeared.');
        const rebound = reboundCandidate.query;
        const candidates = reboundExtension.data.candidates.map((item) => item.eventId === candidate.eventId
          ? { ...item, searchCheckpoint: null, status: 'stopped' as const, requestId: null }
          : item);
        const event = context.createEvent('adjudication-analysis-stopped', context.decisionTimeMs, fence, {
          stoppedRequestId: candidate.requestId,
          priorQueryIdentity: candidate.query.queryIdentity,
          queryIdentity: rebound.queryIdentity,
        });
        return { checkpoint: { ...nextBase,
          extensions: withAdjudicationExtension(context.checkpoint, { version: 1, data: {
            candidates, activeQueryIdentity: null,
          } }),
          archive: { ...context.checkpoint.archive, currentLine: { ...context.checkpoint.archive.currentLine,
            eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId] } },
        }, position: context.position, clockState: context.clockState, value: { kind: 'accepted' } };
      });
      return committed.snapshot;
    });
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  acceptAdjudicationResult(input: AdjudicationResultInputV1): Promise<ControllerSnapshotV1> {
    const frozen = structuredClone(input);
    const operation = this.operationQueue.then(async () => {
      const checkpoint = this.checkpoint;
      if (checkpoint?.result.kind === 'pending-adjudication' && checkpoint.result.activeClockDeadlineMs !== null &&
          this.snapshot().clockReading?.status === 'expired' &&
          !adjudicationExtension(checkpoint).data.candidates.some((item) => item.kind === 'timeout')) {
        await this.reconcileReady();
        return this.snapshot();
      }
      if (checkpoint === null || checkpoint.result.kind === 'final' || !sameFence(createFence(checkpoint), frozen.fence)) return this.snapshot();
      const extension = adjudicationExtension(checkpoint);
      const candidate = extension.data.candidates.find((item) => item.query.queryIdentity === frozen.query.queryIdentity);
      if (candidate === undefined || candidate.status !== 'running' || candidate.requestId !== frozen.requestId ||
          candidate.query.queryIdentity !== frozen.query.queryIdentity || frozen.result.queryIdentity !== frozen.query.queryIdentity ||
          frozen.query.ownershipEpoch !== String(checkpoint.ownershipEpoch) || frozen.query.gameId !== checkpoint.gameId ||
          frozen.query.segmentId !== checkpoint.segmentId || frozen.query.positionFen !== checkpoint.rules.currentFen) return this.snapshot();

      if (frozen.result.status === 'accepted') {
        const checked = checkProofEvidence(frozen.query, frozen.result.evidence);
        if (checked.status !== 'accepted' || checked.conclusion !== frozen.result.conclusion || checked.queryIdentity !== frozen.query.queryIdentity) {
          throw new GameControllerError('invalid-intent', 'The adjudication proof did not pass the independent checker.');
        }
      }
      const committed = await this.commitMutation<{ kind: 'accepted' }>(frozen.fence, (context) => {
        const current = adjudicationExtension(context.checkpoint);
        const isAccepted = frozen.result.status === 'accepted';
        const candidates = current.data.candidates.map((item) => item.query.queryIdentity === candidate.query.queryIdentity
          ? { ...item, searchCheckpoint: isAccepted ? null : jsonSafe(frozen.result.checkpoint), status: isAccepted ? 'accepted' as const : 'queued' as const, requestId: null,
              ...(isAccepted ? { acceptedConclusion: frozen.result.conclusion, acceptedEvidence: jsonSafe(frozen.result.evidence) } : {}) }
          : item);
        let result = context.checkpoint.result;
        let clockState = context.clockState;
        let clocks = context.checkpoint.clocks;
        if (isAccepted) {
          const event = context.createEvent('adjudication-proof-accepted', candidate.eventAtMs, frozen.fence, {
            queryIdentity: frozen.query.queryIdentity,
            conclusion: frozen.result.conclusion,
            evidenceKind: frozen.result.evidence.kind,
          });
          if (candidate.kind === 'deadness' && frozen.result.conclusion === 'dead') {
            result = { kind: 'final', winner: 'draw', reason: 'dead-position', eventId: candidate.eventId, decidedAtMs: candidate.eventAtMs };
            if (clockState !== null) clocks = stopClock(clockState, context.decisionTimeMs);
            clockState = null;
          } else if (candidate.kind === 'timeout') {
            const canMate = frozen.result.conclusion === 'opponent-can-mate';
            const expired = candidate.query.predicate === 'timeout-opponent-mating' && candidate.query.expiredColor === 'w' ? 'white' : 'black';
            result = { kind: 'final', winner: canMate ? (expired === 'white' ? 'black' : 'white') : 'draw', reason: 'timeout', eventId: candidate.eventId, decidedAtMs: candidate.eventAtMs };
            if (clockState !== null) clocks = stopClock(clockState, context.decisionTimeMs);
            clockState = null;
          } else if (candidate.kind === 'deadness' && frozen.result.conclusion === 'not-dead') {
            const setupPending = candidate.deadlineMs === null && context.checkpoint.result.kind === 'pending-adjudication' &&
              context.checkpoint.clocks.activeSide === null;
            const timeoutCandidate = candidates.find((item) => item.kind === 'timeout' && item.status !== 'accepted');
            if (setupPending) {
              result = context.checkpoint.result;
            } else if (timeoutCandidate !== undefined) {
              result = { kind: 'pending-adjudication', reason: 'timeout', eventId: timeoutCandidate.eventId,
                eventAtMs: timeoutCandidate.eventAtMs, activeClockDeadlineMs: null };
              if (clockState !== null) clocks = stopClock(clockState, context.decisionTimeMs);
              clockState = null;
            } else {
              result = { kind: 'unresolved' };
            }
          }
          const next = { ...context.checkpoint, clocks, result,
            extensions: withAdjudicationExtension(context.checkpoint, { version: 1, data: {
              candidates, activeQueryIdentity: null,
            } }),
            archive: { ...context.checkpoint.archive, currentLine: { ...context.checkpoint.archive.currentLine,
              eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId] } },
          };
          return { checkpoint: next, position: context.position, clockState, value: { kind: 'accepted' } };
        }
        return { checkpoint: { ...context.checkpoint, extensions: withAdjudicationExtension(context.checkpoint, { version: 1, data: {
          candidates, activeQueryIdentity: null,
        } }) }, position: context.position, clockState, value: { kind: 'accepted' } };
      });
      return committed.snapshot;
    });
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  startGame(fence: ControllerFenceV1, modelSelection?: ModelSelection): Promise<ControllerSnapshotV1> {
    const operation = this.operationQueue.then(async () => {
      const checkpoint = this.checkpoint;
      if (checkpoint === null || !sameFence(createFence(checkpoint), fence) || checkpoint.clocks.activeSide !== null) return this.snapshot();
      const ready = this.positionChecks === 'lichess' ? checkpoint.result.kind === 'unresolved'
        : checkpoint.result.kind === 'pending-adjudication' && checkpoint.result.reason === 'dead-position' &&
          this.adjudicationStatus(checkpoint).status === 'setup-ready';
      if (!ready) return this.snapshot();
      if (modelSelection !== undefined) {
        if (modelSelection.diagnostic !== 'passed-current-session') throw new GameControllerError('invalid-setup', 'A current-session diagnostic must pass before clocks start.');
        modelConfigurationIdentity(modelSelection);
      } else if (Object.values(checkpoint.selections.players).some(player => player.kind === 'model' && player.diagnostic !== 'passed-current-session')) {
        throw new GameControllerError('invalid-setup', 'Both opponents must pass their compatibility checks before clocks start.');
      }
      const committed = await this.commitMutation<{ kind: 'accepted' }>(fence, (context) => {
        const clock = startClock({ at: context.at, activeSide: fromPositionColor(context.position.sideToMove), timeControl: context.checkpoint.clocks.timeControl });
        const players = { ...context.checkpoint.selections.players };
        const currentSegment = context.checkpoint.history.segments.findIndex((segment) => segment.segmentId === context.checkpoint.segmentId);
        const segments = context.checkpoint.history.segments.map((segment, index) => index === currentSegment
          ? modelSelection === undefined ? segment : { ...segment, providerId: modelSelection.providerId, modelRoutingId: modelSelection.modelRoutingId,
              connectionRevision: modelSelection.configurationRevision }
          : segment);
        if (modelSelection !== undefined) {
          const modelSide = modelSideForCheckpoint(context.checkpoint) ?? 'black';
          players[modelSide] = freezeModelSelection(modelSelection);
        }
        const details = modelSelection === undefined ? { players } : {
          modelSelection: { providerId: modelSelection.providerId, connectionId: modelSelection.connectionId,
            configurationRevision: modelSelection.configurationRevision, modelRoutingId: modelSelection.modelRoutingId,
            protocol: modelSelection.protocol },
        };
        const event = context.createEvent('game-started-after-classification', context.decisionTimeMs, fence, details);
        return { checkpoint: { ...context.checkpoint, selections: { players }, history: { ...context.checkpoint.history, segments }, result: { kind: 'unresolved' },
          clocks: checkpointClock(clock, context.decisionTimeMs),
          archive: { ...context.checkpoint.archive, currentLine: { ...context.checkpoint.archive.currentLine,
            eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId] } },
        }, position: context.position, clockState: clock, value: { kind: 'accepted' } };
      });
      return committed.snapshot;
    });
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async undoImplementation(fence: ControllerFenceV1): Promise<ControllerSnapshotV1> {
    if (this.restored) {
      await this.reconcileReady();
      return this.snapshot();
    }
    const checkpoint = this.checkpoint;
    if (checkpoint?.result.kind === 'pending-adjudication' && checkpoint.result.activeClockDeadlineMs !== null &&
        this.snapshot().clockReading?.status === 'expired') {
      await this.reconcileReady();
    }
    const current = this.checkpoint;
    if (current === null || !sameFence(createFence(current), fence)) return this.snapshot();
    if (current.result.kind !== 'unresolved') return this.snapshot();
    if (current.practice.mode === 'practice') return this.snapshot();
    const baseline = readUndoBaseline(current);
    if (baseline === undefined) return this.snapshot();

    const humanSide: ClockSide = current.selections.players.white.kind === 'human' ? 'white' : 'black';
    const removedCount = current.rules.moves.length - baseline.rules.moves.length;
    if (removedCount <= 0) return this.snapshot();
    let whiteRemoved = 0;
    let blackRemoved = 0;
    let removedPlySide: ClockSide = baseline.rules.sideToMove === 'white' ? 'white' : 'black';
    for (let index = baseline.rules.moves.length; index < current.rules.moves.length; index += 1) {
      if (removedPlySide === 'white') whiteRemoved += 1;
      else blackRemoved += 1;
      removedPlySide = removedPlySide === 'white' ? 'black' : 'white';
    }
    const incrementMs = current.clocks.timeControl.incrementMs;
    const credits = { whiteMs: whiteRemoved * incrementMs, blackMs: blackRemoved * incrementMs };

    const clockState = this.clockState;
    if (clockState === null) return this.snapshot();

    let committed: { snapshot: ControllerSnapshotV1; value: IntentMutationValue };
    let rejectedCreditRemoval = false;
    try {
      committed = await this.commitMutation<IntentMutationValue>(fence, (context) => {
        const contextClockState = context.clockState;
        if (contextClockState === null) {
          throw new GameControllerError('invalid-intent', 'Undo requires a running clock.');
        }
        const candidate = calculateUndoClockCandidate(
          contextClockState,
          { resumedSide: humanSide, incrementCreditsToRemove: credits },
          context.at,
          this.clockPolicy,
        );
        if (candidate.status === 'expired') {
          return this.expiryCandidate(context, fence, candidate.reading);
        }
        if (candidate.status === 'reconciliation-required') {
          return this.clockDiscrepancyCandidate(context, fence, candidate.reading);
        }
        if (candidate.status === 'rejected-credit-removal') {
          rejectedCreditRemoval = true;
          throw new GameControllerError('invalid-intent', 'Undo would leave a clock bank nonpositive.');
        }
        if (candidate.status !== 'candidate') {
          throw new GameControllerError('invalid-intent', 'Undo clock candidate is unavailable.');
        }

        const restoredBase = structuredClone(baseline);
      const oldLineId = context.checkpoint.archive.currentLine.lineId;
      const newLineId = this.idFactory();
      if (
        typeof newLineId !== 'string' ||
        newLineId.length === 0 ||
        newLineId === oldLineId ||
        context.checkpoint.archive.discardedLines.some((line) => line.lineId === newLineId)
      ) {
        throw new GameControllerError('invalid-configuration', 'The identifier source must return distinct nonempty IDs.');
      }
      const discardedLine: DiscardedLineReferenceV1 = {
        lineId: oldLineId,
        eventIds: [...context.checkpoint.archive.currentLine.eventIds],
        discardedAtRevision: context.checkpoint.revision + 1,
        reason: 'undo',
      };
      const event = context.createEvent('undo-accepted', context.decisionTimeMs, fence, {
        removedMoveCount: removedCount,
      });
      restoredBase.archive.currentLine = {
        ...restoredBase.archive.currentLine,
        lineId: newLineId,
      };
      const baselineMessageIds = new Set(restoredBase.history.messages.map((message) => message.messageId));
      const restoredSegmentIds = new Set(restoredBase.history.segments.map((segment) => segment.segmentId));
      const mergedSegments = [
        ...restoredBase.history.segments,
        ...context.checkpoint.history.segments.filter((segment) => !restoredSegmentIds.has(segment.segmentId)),
      ];
      const mergedMessages = context.checkpoint.history.messages.map((message) => {
        if (baselineMessageIds.has(message.messageId)) {
          const baseMessage = restoredBase.history.messages.find((entry) => entry.messageId === message.messageId)!;
          return {
            ...baseMessage,
            lineId: baseMessage.lineId === oldLineId ? newLineId : baseMessage.lineId,
            disposition: baseMessage.lineId === oldLineId ? ('retained' as const) : baseMessage.disposition,
          };
        }
        return message.lineId === oldLineId
          ? { ...message, lineId: oldLineId, disposition: 'discarded' as const }
          : { ...message };
      });
      for (const baseMessage of restoredBase.history.messages) {
        if (!mergedMessages.some((message) => message.messageId === baseMessage.messageId)) {
          mergedMessages.push(
            baseMessage.lineId === oldLineId
              ? { ...baseMessage, lineId: newLineId, disposition: 'retained' as const }
              : { ...baseMessage },
          );
        }
      }
      const previousUndo = previousUndoCheckpoint(restoredBase);
      const restoredExtensions = carriedAdjudicationExtensions(
        restoredBase.extensions,
        adjudicationExtension(restoredBase).data.candidates.filter(
          (item) => item.status === 'accepted' && item.query.segmentId === context.checkpoint.segmentId,
        ),
      );
      const restoredCheckpoint: GameCheckpointV1 = {
        ...restoredBase,
        revision: context.checkpoint.revision + 1,
        updatedAtMs: context.decisionTimeMs,
        positionRevision: context.checkpoint.positionRevision + 1,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
        clocks: checkpointClock(candidate.clock, context.decisionTimeMs),
        history: {
          ...restoredBase.history,
          currentSegmentId: restoredBase.history.currentSegmentId,
          segments: mergedSegments,
          messages: mergedMessages,
        },
        archive: {
          ...restoredBase.archive,
          discardedLines: [...restoredBase.archive.discardedLines, discardedLine],
          currentLine: {
            ...restoredBase.archive.currentLine,
            lineId: newLineId,
            eventIds: [...restoredBase.archive.currentLine.eventIds, event.eventId],
          },
        },
        extensions: previousUndo === null ? restoredExtensions : {
          ...withoutExtension(restoredExtensions, 'undo-points'),
          [UNDO_BASELINE_EXTENSION]: { version: 1, data: jsonSafe(previousUndo) },
        },
      };
      return {
        checkpoint: restoredCheckpoint,
        position: parsePosition(restoredBase.rules.currentFen),
        clockState: candidate.clock,
        value: { kind: 'accepted' },
      };
    });
      if (committed.value.kind === 'clock-reconciliation-required') {
        this.clockReconciliationRequired = true;
      }
      if (committed.value.kind === 'accepted') {
        this.activeRequest = null;
      }
      return committed.snapshot;
    } catch (error) {
      if (rejectedCreditRemoval) return this.snapshot();
      throw error;
    }
  }

  undo(fence: ControllerFenceV1): Promise<ControllerSnapshotV1> {
    return this.enqueueControllerOperation(() => this.undoImplementation(fence));
  }
  undoMove(fence: ControllerFenceV1): Promise<ControllerSnapshotV1> {
    return this.enqueueControllerOperation(() => this.undoImplementation(fence));
  }
  takeback(fence: ControllerFenceV1): Promise<ControllerSnapshotV1> {
    return this.enqueueControllerOperation(() => this.undoImplementation(fence));
  }
  declareResult(
    fence: ControllerFenceV1,
    declaration: GameResultDeclarationV1,
  ): Promise<GameControllerIntentResultV1> {
    return this.dispatch({ schemaVersion: 1, kind: 'declare-result', fence, declaration });
  }

  private async startPracticeImplementation(fence: ControllerFenceV1, modelSelection: ModelSelection): Promise<ControllerSnapshotV1> {
    const checkpoint = this.checkpoint;
    if (checkpoint?.result.kind === 'pending-adjudication' && checkpoint.result.activeClockDeadlineMs !== null &&
        this.snapshot().clockReading?.status === 'expired') {
      await this.reconcileReady();
    }
    const current = this.checkpoint;
    if (current === null || !sameFence(createFence(current), fence)) return this.snapshot();
    if (current.result.kind !== 'final') return this.snapshot();
    const position = this.position;
    if (position === null) return this.snapshot();
    const facts = observeEndingFacts(position, restoreRepetitionLedger({
      version: current.rules.repetitionLedger.version,
      entries: current.rules.repetitionLedger.positions.map((entry) => ({ ...entry })),
    }));
    if (!facts.hasLegalMoves) return this.snapshot();
    const humanSide: ClockSide = current.selections.players.white.kind === 'human' ? 'white' : 'black';
    const approvedPracticeReasons = new Set(['resignation', 'illegal-move', 'timeout']);
    if (!approvedPracticeReasons.has(current.result.reason)) return this.snapshot();
    if (current.result.winner !== humanSide) return this.snapshot();
    if (modelSelection.diagnostic !== 'passed-current-session') {
      throw new GameControllerError('invalid-setup', 'A current-session diagnostic must pass before clocks start.');
    }
    modelConfigurationIdentity(modelSelection);

    const newSegmentId = this.idFactory();
    const newLineId = this.idFactory();
    if (typeof newSegmentId !== 'string' || newSegmentId.length === 0 ||
        typeof newLineId !== 'string' || newLineId.length === 0 || newSegmentId === newLineId ||
        newLineId === current.archive.currentLine.lineId ||
        current.archive.discardedLines.some((line) => line.lineId === newLineId)) {
      throw new GameControllerError('invalid-configuration', 'The identifier source must return distinct nonempty IDs.');
    }

    const originalResult = current.result as Extract<GameResultV1, { kind: 'final' }>;
    const timeControl = current.clocks.timeControl;

    const committed = await this.commitMutation<{ kind: 'accepted' }>(fence, (context) => {
      const clock = startClock({
        at: context.at,
        activeSide: fromPositionColor(context.position.sideToMove),
        timeControl,
      });
      const players = { ...context.checkpoint.selections.players };
      const modelSide = players.white.kind === 'human' ? 'black' : 'white';
      players[modelSide] = freezeModelSelection(modelSelection);
      const segments = [...context.checkpoint.history.segments, {
        segmentId: newSegmentId,
        providerId: modelSelection.providerId,
        modelRoutingId: modelSelection.modelRoutingId,
        connectionRevision: modelSelection.configurationRevision,
        startedAtMs: context.decisionTimeMs,
        messageIds: [],
      }];
      const event = context.createEvent('practice-started', context.decisionTimeMs, fence, {
        sourceResult: originalResult,
      });
      const nextCheckpoint: GameCheckpointV1 = {
        ...context.checkpoint,
        revision: context.checkpoint.revision + 1,
        segmentId: newSegmentId,
        positionRevision: context.checkpoint.positionRevision,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
        updatedAtMs: context.decisionTimeMs,
        rules: { ...context.checkpoint.rules },
        history: {
          currentSegmentId: newSegmentId,
          segments,
          messages: context.checkpoint.history.messages.map((message) =>
            message.lineId === context.checkpoint.archive.currentLine.lineId
              ? { ...message, disposition: 'discarded' as const }
              : { ...message },
          ),
        },
        clocks: checkpointClock(clock, context.decisionTimeMs),
        budgets: {
          formattingCorrectionsRemaining: MAX_FORMAT_CORRECTIONS,
          illegalMoveAttemptsRemaining: { white: MAX_ILLEGAL_MOVE_ATTEMPTS, black: MAX_ILLEGAL_MOVE_ATTEMPTS },
          manualRetriesBySide: { white: 0, black: 0 },
        },
        selections: { players },
        archive: {
          ...context.checkpoint.archive,
          currentLine: { lineId: newLineId, eventIds: [event.eventId] },
          discardedLines: [...context.checkpoint.archive.discardedLines, {
            lineId: context.checkpoint.archive.currentLine.lineId,
            eventIds: [...context.checkpoint.archive.currentLine.eventIds],
            discardedAtRevision: context.checkpoint.revision + 1,
            reason: 'branch',
          }],
        },
        result: { kind: 'unresolved' },
        practice: {
          mode: 'practice',
          scored: false,
          sourceGameId: context.checkpoint.gameId,
          sourcePositionFen: context.checkpoint.rules.currentFen,
          originalResult,
        },
        extensions: carriedAdjudicationExtensions(
          withoutUndoBaseline(context.checkpoint.extensions),
          [],
        ),
      };
      return {
        checkpoint: nextCheckpoint,
        position: context.position,
        clockState: clock,
        value: { kind: 'accepted' },
      };
    });
    this.activeRequest = null;
    return committed.snapshot;
  }

  startPractice(fence: ControllerFenceV1, modelSelection: ModelSelection): Promise<ControllerSnapshotV1> {
    return this.enqueueControllerOperation(() => this.startPracticeImplementation(fence, modelSelection));
  }
  beginPractice(fence: ControllerFenceV1, modelSelection: ModelSelection): Promise<ControllerSnapshotV1> {
    return this.enqueueControllerOperation(() => this.startPracticeImplementation(fence, modelSelection));
  }

  /** Every public mutation runs after earlier controller work so intents stay serialized. */
  private enqueueControllerOperation(run: () => Promise<ControllerSnapshotV1>): Promise<ControllerSnapshotV1> {
    const operation = this.operationQueue.then(() => run());
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private rememberClockDiscrepancy(reading: ClockDiscrepancyReading): void {
    if (!this.clockReconciliationRequired) {
      this.pendingClockDiscrepancy = structuredClone(reading);
    }
    this.clockReconciliationRequired = true;
  }

  private async persistPendingClockDiscrepancy(): Promise<ControllerSnapshotV1> {
    const checkpoint = this.checkpoint;
    const reading = this.pendingClockDiscrepancy;
    if (checkpoint === null || reading === null) return this.snapshot();
    const committed = await this.commitMutation<IntentMutationValue>(createFence(checkpoint), (context) =>
      this.clockDiscrepancyCandidate(context, createFence(context.checkpoint), reading),
    );
    return committed.snapshot;
  }

  private async dispatchReady(intent: GameControllerIntentV1): Promise<GameControllerIntentResultV1> {
    if (!isGameControllerIntentKind(intent.kind)) {
      throw new GameControllerError('invalid-intent', 'The controller intent kind is unsupported.');
    }
    if (intent.schemaVersion !== 1 || !intent.fence || intent.fence.schemaVersion !== 1) {
      throw new GameControllerError('invalid-intent', 'The controller intent version or fence is invalid.');
    }
    const checkpoint = this.checkpoint;
    const position = this.position;
    if (checkpoint === null || position === null) {
      throw new GameControllerError('setup-required', 'Initialize the game before dispatching an intent.');
    }
    let snapshot = this.snapshot();
    if (this.clockReconciliationRequired) {
      if (this.pendingClockDiscrepancy !== null) {
        snapshot = await this.persistPendingClockDiscrepancy();
      }
      return { kind: 'clock-reconciliation-required', snapshot };
    }
    if (!sameFence(createFence(checkpoint), intent.fence)) {
      return { kind: 'rejected', reason: 'stale-fence', snapshot };
    }
    if (this.restored || checkpoint.result.kind !== 'unresolved') {
      return { kind: 'rejected', reason: 'not-actionable', snapshot };
    }
    if (intent.kind === 'begin-model-turn') return this.beginModelTurn(intent.fence);
    if (intent.kind === 'queue-model-selection' || intent.kind === 'cancel-model-selection' ||
        intent.kind === 'resume-prior-model' || intent.kind === 'retry-model-selection') return this.changeModelSelection(intent);
    if (intent.kind === 'stop-model-turn') return this.stopModelTurn(intent.fence);
    if (intent.kind === 'model-turn-interrupted') {
      if (!['failed', 'incomplete', 'aborted'].includes(intent.reason)) {
        throw new GameControllerError('invalid-intent', 'The model turn interruption reason is unsupported.');
      }
      return this.interruptModelTurn(intent.fence, intent.reason);
    }
    if (intent.kind === 'model-turn-effect') return this.applyModelTurnEffect(intent);
    if (intent.kind === 'declare-result') return this.declareResultImplementation(intent.fence, intent.declaration);
    if (intent.kind === 'human-move' || intent.kind === 'model-move') return this.acceptMove(intent);
    throw new GameControllerError('invalid-intent', 'The controller intent kind is unsupported.');
  }

  private async changeModelSelection(intent: Extract<GameControllerIntentV1, { kind: 'queue-model-selection' | 'cancel-model-selection' | 'resume-prior-model' | 'retry-model-selection' }>): Promise<GameControllerIntentResultV1> {
    const checkpoint = this.checkpoint;
    if (checkpoint === null) throw new GameControllerError('setup-required', 'Initialize the game before changing model selection.');
    const side = modelSideForCheckpoint(checkpoint);
    if (side === null || checkpoint.result.kind !== 'unresolved') {
      return { kind: 'rejected', reason: 'not-actionable', snapshot: this.snapshot() };
    }
    const current = handoffData(checkpoint);
    if (intent.kind === 'queue-model-selection' && checkpoint.selections.players.white.kind === 'model' &&
        checkpoint.selections.players.black.kind === 'model' && (this.activeRequest !== null || current.producing !== null)) {
      return { kind: 'rejected', reason: 'not-actionable', snapshot: this.snapshot() };
    }
    let queued = current.queued;
    if (intent.kind === 'queue-model-selection') {
      const candidate = freezeModelSelection(intent.candidate);
      modelConfigurationIdentity(candidate);
      if (candidate.diagnostic !== 'passed-current-session') throw new GameControllerError('invalid-intent', 'A current-session diagnostic must pass before queueing a model.');
      const committed = checkpoint.selections.players[side] as ModelSelection;
      queued = modelConfigurationIdentity(candidate) === modelConfigurationIdentity(committed)
        ? null : { selection: candidate, state: 'queued', failure: null };
    } else if (intent.kind === 'cancel-model-selection' || intent.kind === 'resume-prior-model') queued = null;
    else {
      if (queued === null || queued.state !== 'failed') return { kind: 'rejected', reason: 'not-actionable', snapshot: this.snapshot() };
      queued = { ...queued, state: 'queued', failure: null };
    }
    const committed = await this.commitMutation<IntentMutationValue>(intent.fence, (context) => {
      const clock = context.clockState;
      if (clock === null) return this.noClockCandidate(context, intent.fence);
      const reading = readClockAt(clock, context.at, this.clockPolicy);
      if (reading.status === 'expired') return this.expiryCandidate(context, intent.fence, reading);
      if (reading.status === 'reconciliation-required') return this.clockDiscrepancyCandidate(context, intent.fence, reading);
      const event = context.createEvent('model-selection-queued', context.decisionTimeMs, intent.fence, {
        action: intent.kind, candidateIdentity: queued === null ? null : modelConfigurationIdentity(queued.selection),
      });
      const next = { ...context.checkpoint, revision: context.checkpoint.revision + 1,
        extensions: withHandoff(context.checkpoint, { producing: current.producing, queued }),
        archive: { ...context.checkpoint.archive, currentLine: { ...context.checkpoint.archive.currentLine,
          eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId] } } };
      return { checkpoint: next, position: context.position, clockState: clock, value: { kind: 'accepted' as const } };
    });
    if (committed.value.kind === 'clock-reconciliation-required') this.clockReconciliationRequired = true;
    if (this.activeRequest !== null) this.activeRequest = { ...this.activeRequest, fence: committed.snapshot.fence };
    return committed.value.kind === 'expired' ? { kind: 'expired', snapshot: committed.snapshot } :
      committed.value.kind === 'clock-reconciliation-required' ? { kind: 'clock-reconciliation-required', snapshot: committed.snapshot } :
      committed.value.kind === 'rejected' ? { kind: 'rejected', reason: committed.value.reason, snapshot: committed.snapshot } :
      { kind: 'accepted', snapshot: committed.snapshot };
  }

  queueModelSelection(fence: ControllerFenceV1, candidate: ModelSelection): Promise<ControllerSnapshotV1> {
    return this.dispatch({ schemaVersion: 1, kind: 'queue-model-selection', fence, candidate }).then((result) => result.snapshot);
  }
  cancelModelSelection(fence: ControllerFenceV1): Promise<ControllerSnapshotV1> {
    return this.dispatch({ schemaVersion: 1, kind: 'cancel-model-selection', fence }).then((result) => result.snapshot);
  }
  resumePriorModel(fence: ControllerFenceV1): Promise<ControllerSnapshotV1> {
    return this.dispatch({ schemaVersion: 1, kind: 'resume-prior-model', fence }).then((result) => result.snapshot);
  }
  retryModelSelection(fence: ControllerFenceV1): Promise<ControllerSnapshotV1> {
    return this.dispatch({ schemaVersion: 1, kind: 'retry-model-selection', fence }).then((result) => result.snapshot);
  }

  private async applyModelTurnEffect(
    intent: Extract<GameControllerIntentV1, { kind: 'model-turn-effect' }>,
  ): Promise<GameControllerIntentResultV1> {
    const { effect, fence } = intent;
    if (effect === null || typeof effect !== 'object' || !['accepted-move', 'illegal-attempt', 'format-correction', 'model-resignation'].includes(effect.kind)) {
      throw new GameControllerError('invalid-intent', 'The model turn effect shape is invalid.');
    }
    if (effect.kind === 'accepted-move') {
      const state = handoffData(this.checkpoint!);
      const side = sideForCheckpoint(this.checkpoint!);
      const prior = this.checkpoint!.selections.players[side] as ModelSelection;
      const candidate = state.producing !== null &&
        modelConfigurationIdentity(state.producing) !== modelConfigurationIdentity(prior) ? state.producing : undefined;
      return this.acceptMove({ schemaVersion: 1, kind: 'model-move', fence, move: effect.move }, candidate);
    }
    if (effect.budgets === null || typeof effect.budgets !== 'object' || effect.budgets.schemaVersion !== 1 ||
      !Number.isSafeInteger(effect.budgets.illegalMoveAttempts) || !Number.isSafeInteger(effect.budgets.formatCorrections) ||
      !Number.isSafeInteger(effect.budgets.manualRetries) ||
      effect.kind === 'illegal-attempt' && (effect.record === null || typeof effect.record !== 'object' || !validCoordinateMove(effect.record.move) ||
        effect.record.violation === null || typeof effect.record.violation !== 'object' || typeof effect.record.violation.code !== 'string' ||
        typeof effect.record.violation.message !== 'string') ||
      effect.kind === 'format-correction' && (typeof effect.reason !== 'string' || typeof effect.correction !== 'string' ||
        typeof effect.automatic !== 'boolean' || !Number.isSafeInteger(effect.formatCorrectionsRemaining)) ||
      effect.kind === 'model-resignation' && typeof effect.statement !== 'string') {
      throw new GameControllerError('invalid-intent', 'The model turn effect shape is invalid.');
    }
    const checkpoint = this.checkpoint;
    if (checkpoint === null) throw new GameControllerError('setup-required', 'Initialize the game before applying a model turn effect.');
    const activePosition = this.position;
    if (activePosition === null) throw new GameControllerError('saved-game-invalid', 'The active position is unavailable.');
    const side = sideForCheckpoint(checkpoint);
    if (checkpoint.selections.players[side].kind !== 'model' || this.activeRequest === null ||
      !sameFence(this.activeRequest.fence, fence)) {
      return { kind: 'rejected', reason: 'not-actionable', snapshot: this.snapshot() };
    }
    validateMoveAttemptsExtension(checkpoint.extensions['move-attempts']);
    const handoff = handoffData(checkpoint);
    const committedSelection = checkpoint.selections.players[side] as ModelSelection;
    const firstCandidateReply = handoff.queued?.state === 'awaiting-first-reply' && handoff.producing !== null &&
      modelConfigurationIdentity(handoff.producing) !== modelConfigurationIdentity(committedSelection);
    const expectedAttempts = firstCandidateReply ? 0 : MAX_ILLEGAL_MOVE_ATTEMPTS - checkpoint.budgets.illegalMoveAttemptsRemaining[side];
    const expectedFormatting = firstCandidateReply ? 0 : MAX_FORMAT_CORRECTIONS - checkpoint.budgets.formattingCorrectionsRemaining;
    const expectedRetries = firstCandidateReply ? 0 : checkpoint.budgets.manualRetriesBySide[side];
    if (expectedAttempts < 0 || expectedAttempts > MAX_ILLEGAL_MOVE_ATTEMPTS ||
      expectedFormatting < 0 || expectedFormatting > MAX_FORMAT_CORRECTIONS || !Number.isSafeInteger(expectedRetries)) {
      throw new GameControllerError('saved-game-invalid', 'The saved model turn recovery counters are invalid.');
    }
    const nextAttempts = effect.kind === 'illegal-attempt' ? expectedAttempts + 1 : expectedAttempts;
    const nextFormatting = effect.kind === 'format-correction' && effect.automatic ? expectedFormatting + 1 : expectedFormatting;
    if (effect.budgets.illegalMoveAttempts !== nextAttempts || effect.budgets.formatCorrections !== nextFormatting ||
      effect.budgets.manualRetries !== expectedRetries || effect.budgets.schemaVersion !== 1 ||
      !Number.isSafeInteger(nextAttempts) || nextAttempts > MAX_ILLEGAL_MOVE_ATTEMPTS ||
      !Number.isSafeInteger(nextFormatting) || nextFormatting > MAX_FORMAT_CORRECTIONS) {
      throw new GameControllerError('invalid-intent', 'The classified model turn effect has inconsistent recovery budgets.');
    }
    if (effect.kind === 'illegal-attempt') {
      let isIllegal = false;
      try {
        applyCoordinateMove(activePosition, effect.record.move);
      } catch (error) {
        if (!(error instanceof IllegalMoveError)) throw error;
        isIllegal = true;
      }
      const violation = isIllegal ? explainIllegalMove(activePosition, effect.record.move) : null;
      const terminalAttempt = nextAttempts === MAX_ILLEGAL_MOVE_ATTEMPTS;
      if (!isIllegal || effect.attempt !== nextAttempts || effect.record.attempt !== nextAttempts ||
        effect.record.modelConfigurationIdentity !== fence.modelConfigurationIdentity ||
        violation === null || effect.record.violation.code !== violation.code || effect.record.violation.message !== violation.message ||
        effect.illegalMoveAttemptsRemaining !== MAX_ILLEGAL_MOVE_ATTEMPTS - nextAttempts ||
        (terminalAttempt ? effect.loss?.winner !== 'human' || effect.loss.reason !== 'illegal-move' : effect.loss !== null)) {
        throw new GameControllerError('invalid-intent', 'The classified illegal-attempt effect does not match the active turn.');
      }
    }
    if (effect.kind === 'format-correction' &&
      (effect.formatCorrectionsRemaining !== MAX_FORMAT_CORRECTIONS - nextFormatting ||
        effect.automatic !== (expectedFormatting < MAX_FORMAT_CORRECTIONS) ||
        (effect.pause !== (effect.automatic ? null : 'retry-or-switch')))) {
      throw new GameControllerError('invalid-intent', 'The classified format-correction effect has inconsistent counters.');
    }
    const committed = await this.commitMutation<IntentMutationValue>(fence, (context) => {
      const clockState = context.clockState;
      if (clockState === null) return this.noClockCandidate(context, fence);
      const reading = readClockAt(clockState, context.at, this.clockPolicy);
      if (reading.status === 'expired') return this.expiryCandidate(context, fence, reading);
      if (reading.status === 'reconciliation-required') return this.clockDiscrepancyCandidate(context, fence, reading);
      const handoff = handoffData(context.checkpoint);
      const committedSelection = context.checkpoint.selections.players[side] as ModelSelection;
      const candidateTurn = handoff.queued?.state === 'awaiting-first-reply' && handoff.producing !== null &&
        modelConfigurationIdentity(handoff.producing) !== modelConfigurationIdentity(committedSelection);
      const promoting = effect.kind !== 'format-correction' && handoff.producing !== null &&
        handoff.producing !== null && modelConfigurationIdentity(handoff.producing) !== modelConfigurationIdentity(committedSelection)
        ? handoff.producing : null;
      const segmentId = promoting === null ? null : context.createEventId();
      const players = promoting === null ? context.checkpoint.selections.players
        : { ...context.checkpoint.selections.players, [side]: freezeModelSelection(promoting) };
      const promotedHistory = promoting === null || segmentId === null ? context.checkpoint.history : {
        ...context.checkpoint.history, currentSegmentId: segmentId,
        segments: [...context.checkpoint.history.segments, { segmentId, providerId: promoting.providerId,
          modelRoutingId: promoting.modelRoutingId, connectionRevision: promoting.configurationRevision,
          startedAtMs: context.decisionTimeMs, messageIds: [] }],
      };
      const nextCheckpoint: GameCheckpointV1 = {
        ...context.checkpoint,
        revision: context.checkpoint.revision + 1,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
        budgets: {
          formattingCorrectionsRemaining: MAX_FORMAT_CORRECTIONS - effect.budgets.formatCorrections,
          illegalMoveAttemptsRemaining: {
            ...context.checkpoint.budgets.illegalMoveAttemptsRemaining,
            [side]: MAX_ILLEGAL_MOVE_ATTEMPTS - effect.budgets.illegalMoveAttempts,
          },
          manualRetriesBySide: {
            ...context.checkpoint.budgets.manualRetriesBySide,
            [side]: effect.budgets.manualRetries,
          },
        },
        ...(promoting === null ? {} : { segmentId: segmentId as string, selections: { players }, history: promotedHistory }),
        extensions: (() => {
          const nextExtensions = withHandoff(context.checkpoint, promoting === null
          ? { producing: null, queued: effect.kind === 'format-correction' && handoff.queued !== null && handoff.producing !== null &&
            modelConfigurationIdentity(handoff.queued.selection) === modelConfigurationIdentity(handoff.producing)
            ? effect.pause !== null || candidateTurn
              ? { ...handoff.queued, state: 'failed', failure: 'The candidate reply was not interpretable. Retry, replace, or resume the prior model.' }
              : { ...handoff.queued, state: 'queued', failure: null }
            : handoff.queued }
          : { producing: null, queued: handoff.queued !== null &&
              modelConfigurationIdentity(handoff.queued.selection) !== modelConfigurationIdentity(promoting)
            ? handoff.queued : null });
          return effect.kind === 'illegal-attempt' ? appendMoveAttempt(nextExtensions, side, jsonSafe(effect.record)) : nextExtensions;
        })(),
      };
      const terminal = effect.kind === 'model-resignation' ||
        (effect.kind === 'illegal-attempt' && nextAttempts === MAX_ILLEGAL_MOVE_ATTEMPTS);
      const eventKind = effect.kind === 'illegal-attempt' ? 'illegal-move-rejected' :
        effect.kind === 'format-correction' ? 'model-format-correction' : 'model-resigned';
      const details = effect.kind === 'illegal-attempt'
        ? { attempt: effect.attempt, illegalMoveCode: effect.record.violation.code, rejectedMove: { ...effect.record.move }, modelConfigurationIdentity: effect.record.modelConfigurationIdentity }
        : effect.kind === 'format-correction'
          ? { reason: effect.reason, correction: effect.correction, automatic: effect.automatic, formatCorrectionsRemaining: effect.formatCorrectionsRemaining }
          : { statement: effect.statement };
      const event = context.createEvent(eventKind, context.decisionTimeMs, fence, details);
      const feedback = effect.kind === 'illegal-attempt' || effect.kind === 'format-correction' ? effect.correction : null;
      const feedbackMessageId = feedback === null ? null : context.createEventId();
      const history = feedback === null || feedbackMessageId === null ? nextCheckpoint.history : {
        ...nextCheckpoint.history,
        messages: [...nextCheckpoint.history.messages, {
          messageId: feedbackMessageId,
          segmentId: nextCheckpoint.segmentId,
          lineId: context.checkpoint.archive.currentLine.lineId,
          role: 'user' as const,
          content: feedback,
          eventIds: [event.eventId],
          disposition: 'retained' as const,
        }],
        segments: nextCheckpoint.history.segments.map((segment) => segment.segmentId === nextCheckpoint.segmentId
          ? { ...segment, messageIds: [...segment.messageIds, feedbackMessageId] } : segment),
      };
      let result: GameResultV1 = context.checkpoint.result;
      if (terminal) result = {
        kind: 'final', winner: side === 'white' ? 'black' : 'white', reason: effect.kind === 'model-resignation' ? 'resignation' : 'illegal-move',
        eventId: event.eventId, decidedAtMs: context.decisionTimeMs,
      };
      const finalCheckpoint = {
        ...nextCheckpoint,
        history,
        result,
        clocks: terminal
          ? pausedClockCheckpoint(clockState.timeControl, reading.remaining, context.decisionTimeMs, clockState.schemaVersion)
          : context.checkpoint.clocks,
        archive: { ...nextCheckpoint.archive, currentLine: { ...nextCheckpoint.archive.currentLine,
          eventIds: [...nextCheckpoint.archive.currentLine.eventIds, event.eventId] } },
      };
      return { checkpoint: finalCheckpoint, position: context.position, clockState: terminal ? null : clockState,
        value: { kind: 'accepted' as const } };
    });
    this.activeRequest = null;
    if (committed.value.kind === 'expired') return { kind: 'expired', snapshot: committed.snapshot };
    if (committed.value.kind === 'clock-reconciliation-required') {
      this.clockReconciliationRequired = true;
      return { kind: 'clock-reconciliation-required', snapshot: committed.snapshot };
    }
    return { kind: 'accepted', snapshot: committed.snapshot };
  }

  private async reconcileReady(): Promise<ControllerSnapshotV1> {
    const checkpoint = this.checkpoint;
    if (checkpoint === null) {
      throw new GameControllerError('setup-required', 'Initialize the game before reconciling its clock.');
    }
    if (this.clockState === null || (checkpoint.result.kind !== 'unresolved' &&
        !(checkpoint.result.kind === 'pending-adjudication' && checkpoint.result.activeClockDeadlineMs !== null))) return this.snapshot();
    if (checkpoint.result.kind === 'pending-adjudication' && adjudicationExtension(checkpoint).data.candidates.some((item) => item.kind === 'timeout')) {
      return this.snapshot();
    }

    await this.commitMutation<IntentMutationValue>(null, (context) => {
      const clockState = context.clockState;
      if (clockState === null) return this.noClockCandidate(context, createFence(context.checkpoint));
      const eventFence = createFence(context.checkpoint);
      if (this.restored) {
        const recovery = recoverClockAfterAbsence(clockState, context.at, this.clockPolicy);
        if (recovery.status === 'expired') {
          return this.expiryCandidate(context, eventFence, {
            status: 'expired',
            activeSide: clockState.activeSide,
            remaining: recovery.remaining,
            elapsedMs: recovery.elapsedChargedMs,
            deadline: recovery.deadline,
            evidence: recovery.evidence,
          });
        }
        if (recovery.status === 'reconciliation-required') {
          return this.clockDiscrepancyCandidate(context, eventFence, this.pendingClockDiscrepancy ?? {
            status: 'reconciliation-required',
            activeSide: clockState.activeSide,
            remaining: null,
            elapsedMs: null,
            deadline: recovery.deadline,
            evidence: recovery.evidence,
            reason: recovery.reason,
          });
        }
        const priorDiscrepancyEvent = this.pendingClockDiscrepancy === null
          ? null
          : context.createEvent(
              'clock-reconciliation-required',
              context.decisionTimeMs,
              eventFence,
              {
                reason: this.pendingClockDiscrepancy.reason,
                evidence: this.pendingClockDiscrepancy.evidence,
              },
            );
        const event = context.createEvent(
          'clock-absence-reconciled',
          context.decisionTimeMs,
          eventFence,
          { elapsedChargedMs: recovery.elapsedChargedMs, evidence: recovery.evidence },
        );
        const interruptionEvent = this.restoredUnsettledModelRequest !== null &&
          sameFence(this.restoredUnsettledModelRequest, eventFence)
          ? context.createEvent('model-turn-interrupted', context.decisionTimeMs, eventFence, {
              interruptedRequestGeneration: eventFence.requestGeneration,
              reason: 'incomplete',
            })
          : null;
        const nextCheckpoint = {
          ...context.checkpoint,
          requestGeneration: context.checkpoint.requestGeneration + 1,
          analysisGeneration: context.checkpoint.analysisGeneration + 1,
          clocks: checkpointClock(recovery.clock, context.decisionTimeMs),
          archive: { ...context.checkpoint.archive, currentLine: { ...context.checkpoint.archive.currentLine,
            eventIds: [...context.checkpoint.archive.currentLine.eventIds,
              ...(priorDiscrepancyEvent === null ? [] : [priorDiscrepancyEvent.eventId]), event.eventId,
              ...(interruptionEvent === null ? [] : [interruptionEvent.eventId])] } },
        };
        return {
          checkpoint: { ...nextCheckpoint, extensions: rebindPendingCandidates(context.checkpoint, nextCheckpoint) },
          position: context.position,
          clockState: recovery.clock,
          value: { kind: 'reconciled' },
        };
      }

      const reading = readClockAt(clockState, context.at, this.clockPolicy);
      if (reading.status === 'expired') return this.expiryCandidate(context, eventFence, reading);
      if (reading.status === 'reconciliation-required') {
        return this.clockDiscrepancyCandidate(
          context,
          eventFence,
          this.pendingClockDiscrepancy ?? reading,
        );
      }
      const priorDiscrepancyEvent = this.pendingClockDiscrepancy === null
        ? null
        : context.createEvent(
            'clock-reconciliation-required',
            context.decisionTimeMs,
            eventFence,
            {
              reason: this.pendingClockDiscrepancy.reason,
              evidence: this.pendingClockDiscrepancy.evidence,
            },
          );
      const event = context.createEvent(
        'clock-reference-reconciled',
        context.decisionTimeMs,
        eventFence,
        { evidence: reading.evidence },
      );
      const interruptionEvent = this.restoredUnsettledModelRequest !== null &&
        sameFence(this.restoredUnsettledModelRequest, eventFence)
        ? context.createEvent('model-turn-interrupted', context.decisionTimeMs, eventFence, {
            interruptedRequestGeneration: eventFence.requestGeneration,
            reason: 'incomplete',
          })
        : null;
      const nextCheckpoint = {
        ...context.checkpoint,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
        clocks: checkpointClock(clockState, context.decisionTimeMs),
        archive: { ...context.checkpoint.archive, currentLine: { ...context.checkpoint.archive.currentLine,
          eventIds: [...context.checkpoint.archive.currentLine.eventIds,
            ...(priorDiscrepancyEvent === null ? [] : [priorDiscrepancyEvent.eventId]), event.eventId,
            ...(interruptionEvent === null ? [] : [interruptionEvent.eventId])] } },
      };
      return {
        checkpoint: { ...nextCheckpoint, extensions: rebindPendingCandidates(context.checkpoint, nextCheckpoint) },
        position: context.position,
        clockState,
        value: { kind: 'reconciled' },
      };
    });
    this.activeRequest = null;
    this.restoredUnsettledModelRequest = null;
    return this.snapshot();
  }

  private async beginModelTurn(fence: ControllerFenceV1): Promise<GameControllerIntentResultV1> {
    const checkpoint = this.checkpoint;
    const position = this.position;
    if (checkpoint === null || position === null) {
      throw new GameControllerError('setup-required', 'Initialize the game before starting a model turn.');
    }
    const side = sideForCheckpoint(checkpoint);
    if (checkpoint.selections.players[side].kind !== 'model') {
      return { kind: 'rejected', reason: 'wrong-side', snapshot: this.snapshot() };
    }
    if (this.activeRequest !== null) {
      return { kind: 'rejected', reason: 'not-actionable', snapshot: this.snapshot() };
    }
    const handoff = handoffData(checkpoint);
    const selection = handoff.queued?.state === 'failed'
      ? null
      : handoff.queued?.selection ?? checkpoint.selections.players[side] as ModelSelection;
    if (selection === null) return { kind: 'rejected', reason: 'not-actionable', snapshot: this.snapshot() };
    const currentFacts = observeEndingFacts(
      position,
      restoreRepetitionLedger({
        version: checkpoint.rules.repetitionLedger.version,
        entries: checkpoint.rules.repetitionLedger.positions.map((entry) => ({ ...entry })),
      }),
    );
    if (!currentFacts.hasLegalMoves) {
      return { kind: 'rejected', reason: 'not-actionable', snapshot: this.snapshot() };
    }

    const committed = await this.commitMutation<IntentMutationValue>(fence, (context) => {
      const clockState = context.clockState;
      if (clockState === null) {
        return this.noClockCandidate(context, fence);
      }
      const reading = readClockAt(clockState, context.at, this.clockPolicy);
      if (reading.status === 'expired') return this.expiryCandidate(context, fence, reading);
      if (reading.status === 'reconciliation-required') {
        return this.clockDiscrepancyCandidate(context, fence, reading);
      }

      const requestCheckpoint = {
        ...context.checkpoint,
        revision: context.checkpoint.revision + 1,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
        extensions: withHandoff(context.checkpoint, { producing: selection,
          queued: handoff.queued === null ? null : { ...handoff.queued, state: 'awaiting-first-reply', failure: null } }),
      };
      const requestFence = createFence(requestCheckpoint);
      const event = context.createEvent(
        'model-turn-started',
        context.decisionTimeMs,
        requestFence,
        { requestGeneration: requestCheckpoint.requestGeneration },
      );
      const nextCheckpoint = {
        ...requestCheckpoint,
        archive: {
          ...requestCheckpoint.archive,
          currentLine: {
            ...requestCheckpoint.archive.currentLine,
            eventIds: [...requestCheckpoint.archive.currentLine.eventIds, event.eventId],
          },
        },
      };
      return {
        checkpoint: nextCheckpoint,
        position: context.position,
        clockState,
        value: { kind: 'started' as const },
      };
    });

    if (committed.value.kind === 'clock-reconciliation-required') {
      this.clockReconciliationRequired = true;
    }
    if (committed.value.kind === 'expired') return { kind: 'expired', snapshot: committed.snapshot };
    if (committed.value.kind === 'clock-reconciliation-required') {
      return { kind: 'clock-reconciliation-required', snapshot: committed.snapshot };
    }
    const clockReading = committed.snapshot.clockReading;
    if (clockReading === null || clockReading.status !== 'running') {
      if (clockReading?.status === 'expired') {
        const expired = await this.persistCurrentExpiry();
        return { kind: 'expired', snapshot: expired };
      }
      if (clockReading?.status === 'reconciliation-required') {
        await this.persistCurrentClockDiscrepancy();
        return { kind: 'clock-reconciliation-required', snapshot: this.snapshot() };
      }
      return { kind: 'rejected', reason: 'not-actionable', snapshot: committed.snapshot };
    }
    const request = {
      fence: committed.snapshot.fence,
      position: committed.snapshot.position,
      clockReading,
      selection,
    };
    this.activeRequest = request;
    return {
      kind: 'model-turn-started',
      snapshot: committed.snapshot,
      request,
    };
  }

  private async declareResultImplementation(
    fence: ControllerFenceV1,
    declaration: GameResultDeclarationV1,
  ): Promise<GameControllerIntentResultV1> {
    const checkpoint = this.checkpoint;
    if (checkpoint === null) {
      throw new GameControllerError('setup-required', 'Initialize the game before declaring a result.');
    }
    const declared = readResultDeclaration(declaration);
    const players = checkpoint.selections.players;
    if (declared.kind === 'draw') {
      if (players.white.kind !== 'human' && players.black.kind !== 'human') {
        return { kind: 'rejected', reason: 'not-actionable', snapshot: this.snapshot() };
      }
    } else if (players[declared.side].kind !== 'human') {
      return { kind: 'rejected', reason: 'wrong-side', snapshot: this.snapshot() };
    }
    const committed = await this.commitMutation<IntentMutationValue>(fence, (context) => {
      const clockState = context.clockState;
      if (clockState === null) return this.noClockCandidate(context, fence);
      const reading = readClockAt(clockState, context.at, this.clockPolicy);
      if (reading.status === 'expired') return this.expiryCandidate(context, fence, reading);
      if (reading.status === 'reconciliation-required') {
        return this.clockDiscrepancyCandidate(context, fence, reading);
      }
      const event = context.createEvent(
        'game-declared-final',
        context.decisionTimeMs,
        fence,
        declared.kind === 'draw'
          ? { declaration: 'draw', reason: 'draw-agreement' }
          : { declaration: 'resignation', resigningSide: declared.side, reason: 'resignation' },
      );
      const nextCheckpoint: GameCheckpointV1 = {
        ...context.checkpoint,
        revision: context.checkpoint.revision + 1,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
        result: declared.kind === 'draw'
          ? { kind: 'final', winner: 'draw', reason: 'draw-agreement', eventId: event.eventId,
              decidedAtMs: context.decisionTimeMs }
          : { kind: 'final', winner: declared.side === 'white' ? 'black' : 'white', reason: 'resignation',
              eventId: event.eventId, decidedAtMs: context.decisionTimeMs },
        clocks: pausedClockCheckpoint(
          clockState.timeControl,
          reading.remaining,
          context.decisionTimeMs,
          clockState.schemaVersion,
        ),
        extensions: withHandoff(context.checkpoint, { producing: null, queued: null }),
        archive: { ...context.checkpoint.archive, currentLine: { ...context.checkpoint.archive.currentLine,
          eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId] } },
      };
      return {
        checkpoint: nextCheckpoint,
        position: context.position,
        clockState: null,
        value: { kind: 'accepted' as const },
      };
    });
    // A final result fences every late provider or engine reply for this game.
    this.activeRequest = null;
    if (committed.value.kind === 'expired') return { kind: 'expired', snapshot: committed.snapshot };
    if (committed.value.kind === 'clock-reconciliation-required') {
      this.clockReconciliationRequired = true;
      return { kind: 'clock-reconciliation-required', snapshot: committed.snapshot };
    }
    if (committed.value.kind === 'rejected') {
      return { kind: 'rejected', reason: committed.value.reason, snapshot: committed.snapshot };
    }
    return { kind: 'accepted', snapshot: committed.snapshot };
  }

  private async stopModelTurn(fence: ControllerFenceV1): Promise<GameControllerIntentResultV1> {
    const checkpoint = this.checkpoint;
    if (checkpoint === null) {
      throw new GameControllerError('setup-required', 'Initialize the game before stopping a model turn.');
    }
    const side = sideForCheckpoint(checkpoint);
    if (
      checkpoint.selections.players[side].kind !== 'model' ||
      this.activeRequest === null ||
      !sameFence(this.activeRequest.fence, fence)
    ) {
      return { kind: 'rejected', reason: 'not-actionable', snapshot: this.snapshot() };
    }
    const committed = await this.commitMutation<IntentMutationValue>(fence, (context) => {
      const clockState = context.clockState;
      if (clockState === null) return this.noClockCandidate(context, fence);
      const reading = readClockAt(clockState, context.at, this.clockPolicy);
      if (reading.status === 'expired') return this.expiryCandidate(context, fence, reading);
      if (reading.status === 'reconciliation-required') {
        return this.clockDiscrepancyCandidate(context, fence, reading);
      }
      const nextCheckpoint = {
        ...context.checkpoint,
        revision: context.checkpoint.revision + 1,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
      };
      const event = context.createEvent(
        'model-turn-stopped',
        context.decisionTimeMs,
        fence,
        { stoppedRequestGeneration: fence.requestGeneration },
      );
      const handoff = handoffData(context.checkpoint);
      const committedSelection = context.checkpoint.selections.players[side] as ModelSelection;
      const stoppedCandidate = handoff.queued?.state === 'awaiting-first-reply' && handoff.producing !== null &&
        modelConfigurationIdentity(handoff.producing) !== modelConfigurationIdentity(committedSelection) &&
        modelConfigurationIdentity(handoff.queued.selection) === modelConfigurationIdentity(handoff.producing);
      const stoppedCheckpoint = {
        ...nextCheckpoint,
        extensions: withHandoff(context.checkpoint, { producing: null, queued: stoppedCandidate
          ? { ...handoff.queued!, state: 'failed', failure: 'The candidate request was stopped. Retry, replace, or resume the prior model.' }
          : handoff.queued }),
      };
      return {
        checkpoint: {
          ...stoppedCheckpoint,
          archive: {
            ...nextCheckpoint.archive,
            currentLine: {
              ...nextCheckpoint.archive.currentLine,
              eventIds: [...nextCheckpoint.archive.currentLine.eventIds, event.eventId],
            },
          },
        },
        position: context.position,
        clockState,
        value: { kind: 'accepted' },
      };
    });
    this.activeRequest = null;
    if (committed.value.kind === 'clock-reconciliation-required') {
      this.clockReconciliationRequired = true;
      return { kind: 'clock-reconciliation-required', snapshot: committed.snapshot };
    }
    if (committed.value.kind === 'expired') return { kind: 'expired', snapshot: committed.snapshot };
    if (committed.value.kind === 'rejected') {
      return { kind: 'rejected', reason: committed.value.reason, snapshot: committed.snapshot };
    }
    return { kind: 'accepted', snapshot: committed.snapshot };
  }

  private async interruptModelTurn(
    fence: ControllerFenceV1,
    reason: ModelTurnInterruptionReasonV1,
  ): Promise<GameControllerIntentResultV1> {
    const checkpoint = this.checkpoint;
    if (checkpoint === null) {
      throw new GameControllerError('setup-required', 'Initialize the game before settling a model turn.');
    }
    const side = sideForCheckpoint(checkpoint);
    if (
      checkpoint.selections.players[side].kind !== 'model' ||
      this.activeRequest === null ||
      !sameFence(this.activeRequest.fence, fence)
    ) {
      return { kind: 'rejected', reason: 'not-actionable', snapshot: this.snapshot() };
    }
    const committed = await this.commitMutation<IntentMutationValue>(fence, (context) => {
      const clockState = context.clockState;
      if (clockState === null) return this.noClockCandidate(context, fence);
      const reading = readClockAt(clockState, context.at, this.clockPolicy);
      if (reading.status === 'expired') return this.expiryCandidate(context, fence, reading);
      if (reading.status === 'reconciliation-required') {
        return this.clockDiscrepancyCandidate(context, fence, reading);
      }
      const nextCheckpoint = {
        ...context.checkpoint,
        revision: context.checkpoint.revision + 1,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
      };
      const event = context.createEvent(
        'model-turn-interrupted',
        context.decisionTimeMs,
        fence,
        { interruptedRequestGeneration: fence.requestGeneration, reason },
      );
      const handoff = handoffData(context.checkpoint);
      const committedSelection = context.checkpoint.selections.players[side] as ModelSelection;
      const failedCandidate = handoff.queued?.state === 'awaiting-first-reply' && handoff.producing !== null &&
        modelConfigurationIdentity(handoff.producing) !== modelConfigurationIdentity(committedSelection) &&
        modelConfigurationIdentity(handoff.queued.selection) === modelConfigurationIdentity(handoff.producing);
      const interruptedCheckpoint = {
        ...nextCheckpoint,
        extensions: withHandoff(context.checkpoint, { producing: null, queued: failedCandidate
          ? { ...handoff.queued!, state: 'failed', failure: `The candidate turn ${reason}; retry, replace, or resume the prior model.` }
          : handoff.queued }),
      };
      return {
        checkpoint: {
          ...interruptedCheckpoint,
          archive: {
            ...nextCheckpoint.archive,
            currentLine: {
              ...nextCheckpoint.archive.currentLine,
              eventIds: [...nextCheckpoint.archive.currentLine.eventIds, event.eventId],
            },
          },
        },
        position: context.position,
        clockState,
        value: { kind: 'accepted' },
      };
    });
    // Only clear the in-memory request after the storage transaction commits.
    this.activeRequest = null;
    if (committed.value.kind === 'clock-reconciliation-required') {
      this.clockReconciliationRequired = true;
      return { kind: 'clock-reconciliation-required', snapshot: committed.snapshot };
    }
    if (committed.value.kind === 'expired') return { kind: 'expired', snapshot: committed.snapshot };
    if (committed.value.kind === 'rejected') {
      return { kind: 'rejected', reason: committed.value.reason, snapshot: committed.snapshot };
    }
    return { kind: 'accepted', snapshot: committed.snapshot };
  }

  private async acceptMove(event: ControllerMoveEventV1, promotion?: ModelSelection): Promise<GameControllerIntentResultV1> {
    const checkpoint = this.checkpoint;
    const position = this.position;
    if (checkpoint === null || position === null) {
      throw new GameControllerError('setup-required', 'Initialize the game before accepting a move.');
    }
    const side = sideForCheckpoint(checkpoint);
    const expectedPlayer = event.kind === 'human-move' ? 'human' : 'model';
    if (checkpoint.selections.players[side].kind !== expectedPlayer) {
      return { kind: 'rejected', reason: 'wrong-side', snapshot: this.snapshot() };
    }
    if (
      event.kind === 'model-move' &&
      (this.activeRequest === null || !sameFence(this.activeRequest.fence, event.fence))
    ) {
      return { kind: 'rejected', reason: 'not-actionable', snapshot: this.snapshot() };
    }
    if (!validCoordinateMove(event.move)) {
      return { kind: 'rejected', reason: 'illegal-move', snapshot: this.snapshot() };
    }

    const committed = await this.commitMutation<IntentMutationValue>(event.fence, (context) => {
      const clockState = context.clockState;
      if (clockState === null) return this.noClockCandidate(context, event.fence);
      const clockCandidate = calculateMoveClockCandidate(
        clockState,
        side,
        context.at,
        this.clockPolicy,
      );
      if (clockCandidate.status === 'expired') {
        return this.expiryCandidate(context, event.fence, clockCandidate.reading);
      }
      if (clockCandidate.status === 'reconciliation-required') {
        return this.clockDiscrepancyCandidate(context, event.fence, clockCandidate.reading);
      }
      if (clockCandidate.status === 'wrong-side') {
        return {
          checkpoint: context.checkpoint,
          position: context.position,
          clockState,
          value: { kind: 'rejected' as const, reason: 'wrong-side' as const },
        };
      }

      let transition;
      try {
        transition = applyCoordinateMove(position, event.move);
      } catch (error) {
        if (!(error instanceof IllegalMoveError)) throw error;
        const nextCheckpoint = {
          ...context.checkpoint,
          revision: context.checkpoint.revision + 1,
          requestGeneration: context.checkpoint.requestGeneration + 1,
          analysisGeneration: context.checkpoint.analysisGeneration + 1,
        };
        const rejectionFence = createFence(nextCheckpoint);
        const rejectedEvent = context.createEvent(
          'illegal-move-rejected',
          context.decisionTimeMs,
          event.fence,
          { rejectedMove: { ...event.move } },
        );
        return {
          checkpoint: {
            ...nextCheckpoint,
            archive: {
              ...nextCheckpoint.archive,
              currentLine: {
                ...nextCheckpoint.archive.currentLine,
                eventIds: [...nextCheckpoint.archive.currentLine.eventIds, rejectedEvent.eventId],
              },
            },
          },
          position: context.position,
          clockState,
          value: { kind: 'rejected' as const, reason: 'illegal-move' as const, rejectionFence },
        };
      }

      const priorLedger = restoreRepetitionLedger({
        version: context.checkpoint.rules.repetitionLedger.version,
        entries: context.checkpoint.rules.repetitionLedger.positions.map((entry) => ({ ...entry })),
      });
      const nextLedger = recordPosition(priorLedger, transition.position);
      const endingFacts = observeEndingFacts(transition.position, nextLedger);
      const san = transition.san;
      const nextCheckpoint = {
        ...context.checkpoint,
        revision: context.checkpoint.revision + 1,
        positionRevision: context.checkpoint.positionRevision + 1,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
        budgets: {
          ...context.checkpoint.budgets,
          formattingCorrectionsRemaining: MAX_FORMAT_CORRECTIONS,
          illegalMoveAttemptsRemaining: {
            ...context.checkpoint.budgets.illegalMoveAttemptsRemaining,
            [fromPositionColor(transition.position.sideToMove)]: MAX_ILLEGAL_MOVE_ATTEMPTS,
          },
          manualRetriesBySide: {
            ...context.checkpoint.budgets.manualRetriesBySide,
            [fromPositionColor(transition.position.sideToMove)]: 0,
          },
        },
      };
      const moveEvent = context.createEvent(
        event.kind === 'human-move' ? 'human-move-accepted' : 'model-move-accepted',
        context.decisionTimeMs,
        event.fence,
        {
          move: {
            from: transition.move.from,
            to: transition.move.to,
            promotion: transition.move.promotion ?? null,
            san,
          },
          clock: {
            elapsedChargedMs: clockCandidate.elapsedChargedMs,
            incrementCredit: clockCandidate.incrementCredit,
            nextAnchor: clockCandidate.clock.anchor,
            evidence: clockCandidate.reading.evidence,
          },
        },
      );
      const appliedMove: AppliedMoveV1 = {
        moveId: context.createEventId(),
        from: transition.move.from,
        to: transition.move.to,
        promotion: transition.move.promotion ?? null,
        san,
        fenBefore: position.fen,
        fenAfter: transition.position.fen,
        eventId: moveEvent.eventId,
      };
      const finalResult = finalResultForPosition(
        transition.position,
        endingFacts,
        moveEvent.eventId,
        context.decisionTimeMs,
        this.positionChecks === 'lichess',
      );
      const result = finalResult ?? (this.positionChecks === 'lichess' ? { kind: 'unresolved' as const } : {
        kind: 'pending-adjudication' as const,
        reason: 'dead-position' as const,
        eventId: moveEvent.eventId,
        eventAtMs: context.decisionTimeMs,
        activeClockDeadlineMs: clockCandidate.reading.deadline.wallTimeMs,
      });
      const rules = {
        ...context.checkpoint.rules,
        currentFen: transition.position.fen,
        sideToMove: fromPositionColor(transition.position.sideToMove),
        castlingRights: transition.position.castlingRights,
        enPassantSquare: transition.position.enPassantSquare,
        halfmoveClock: transition.position.halfmoveClock,
        fullmoveNumber: transition.position.fullmoveNumber,
        repetitionLedger: {
          version: 1 as const,
          positions: nextLedger.entries.map((entry) => ({ ...entry })),
        },
        moves: [...context.checkpoint.rules.moves, appliedMove],
      };
      const nextCheckpointWithMove = {
        ...nextCheckpoint,
        rules,
        clocks: finalResult === null
          ? checkpointClock(clockCandidate.clock, context.decisionTimeMs)
          : stopClock(clockCandidate.clock, context.decisionTimeMs),
        archive: {
          ...nextCheckpoint.archive,
          currentLine: {
            ...nextCheckpoint.archive.currentLine,
            eventIds: [...nextCheckpoint.archive.currentLine.eventIds, moveEvent.eventId],
          },
        },
        result,
      };
      let finalCheckpoint = nextCheckpointWithMove;
      if (promotion !== undefined) {
        const segmentId = context.createEventId();
        const players = { ...finalCheckpoint.selections.players, [side]: freezeModelSelection(promotion) };
        const segments = [...finalCheckpoint.history.segments, { segmentId, providerId: promotion.providerId,
          modelRoutingId: promotion.modelRoutingId, connectionRevision: promotion.configurationRevision,
          startedAtMs: context.decisionTimeMs, messageIds: [] }];
        finalCheckpoint = { ...finalCheckpoint, segmentId, selections: { players },
          history: { ...finalCheckpoint.history, currentSegmentId: segmentId, segments },
          extensions: withHandoff(finalCheckpoint, { producing: null, queued: handoffData(context.checkpoint).queued !== null &&
            modelConfigurationIdentity(handoffData(context.checkpoint).queued!.selection) !== modelConfigurationIdentity(promotion)
            ? handoffData(context.checkpoint).queued : null }) };
      }
      if (finalResult === null && this.positionChecks === 'legacy-proof') {
        const query = deadnessQuery(finalCheckpoint);
        const candidateEvent = context.createEvent('deadness-candidate-created', context.decisionTimeMs, createFence(finalCheckpoint), {
          queryIdentity: query.queryIdentity,
          reason: 'position-entry',
          precedingMoveEventId: moveEvent.eventId,
        });
        const currentExtension = adjudicationExtension(context.checkpoint);
        const candidates = [...currentExtension.data.candidates.filter((item) => item.status === 'accepted' && item.query.segmentId === finalCheckpoint.segmentId), {
          kind: 'deadness' as const,
          eventId: candidateEvent.eventId,
          eventAtMs: context.decisionTimeMs,
          deadlineMs: clockCandidate.reading.deadline.wallTimeMs,
          query,
          searchCheckpoint: null,
          status: 'queued' as const,
          requestId: null,
        }];
        finalCheckpoint = {
          ...finalCheckpoint,
          extensions: withAdjudicationExtension(finalCheckpoint, { version: 1, data: {
            candidates, activeQueryIdentity: null,
          } }),
          archive: { ...finalCheckpoint.archive, currentLine: { ...finalCheckpoint.archive.currentLine,
            eventIds: [...nextCheckpointWithMove.archive.currentLine.eventIds, candidateEvent.eventId] } },
        };
      }
      if (promotion === undefined) {
        finalCheckpoint = { ...finalCheckpoint, extensions: withHandoff(finalCheckpoint, {
          producing: null, queued: handoffData(context.checkpoint).queued,
        }) };
      }
      const checkpointWithUndoBaseline = event.kind === 'human-move'
        ? {
            ...finalCheckpoint,
            extensions: {
              ...finalCheckpoint.extensions,
              [UNDO_BASELINE_EXTENSION]: undoBaselineSection(context.checkpoint),
            },
          }
        : finalCheckpoint;
      return {
        checkpoint: checkpointWithUndoBaseline,
        position: transition.position,
        clockState: finalResult === null ? clockCandidate.clock : null,
        value: { kind: 'accepted' as const },
      };
    });

    this.activeRequest = null;
    if (committed.value.kind === 'clock-reconciliation-required') {
      this.clockReconciliationRequired = true;
    }
    if (committed.value.kind === 'expired') return { kind: 'expired', snapshot: committed.snapshot };
    if (committed.value.kind === 'clock-reconciliation-required') {
      return { kind: 'clock-reconciliation-required', snapshot: committed.snapshot };
    }
    if (committed.value.kind === 'rejected') {
      return {
        kind: 'rejected',
        reason: committed.value.reason,
        snapshot: committed.snapshot,
      };
    }
    return { kind: 'accepted', snapshot: committed.snapshot };
  }

  private noClockCandidate(
    context: ControllerDecisionContext,
    fence: ControllerFenceV1,
  ): ControllerDecisionCandidate<{ kind: 'rejected'; reason: 'not-actionable' }> {
    const event = context.createEvent(
      'clock-state-invalid',
      context.decisionTimeMs,
      fence,
      { message: 'An actionable game has no running clock.' },
    );
    return {
      checkpoint: {
        ...context.checkpoint,
        revision: context.checkpoint.revision + 1,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
        archive: {
          ...context.checkpoint.archive,
          currentLine: {
            ...context.checkpoint.archive.currentLine,
            eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId],
          },
        },
      },
      position: context.position,
      clockState: null,
      value: { kind: 'rejected', reason: 'not-actionable' },
    };
  }

  private expiryCandidate(
    context: ControllerDecisionContext,
    fence: ControllerFenceV1,
    reading: ClockReading,
  ): ControllerDecisionCandidate<IntentMutationValue> {
    if (reading.status !== 'expired') {
      throw new GameControllerError('invalid-configuration', 'An expiry decision needs an expired clock reading.');
    }
    const event = context.createEvent(
      'timeout-candidate',
      reading.deadline.wallTimeMs,
      fence,
      {
        decisionTimeMs: context.decisionTimeMs,
        deadline: reading.deadline,
        evidence: reading.evidence,
      },
    );
    const nextBase = {
      ...context.checkpoint,
      revision: context.checkpoint.revision + 1,
      requestGeneration: context.checkpoint.requestGeneration + 1,
      analysisGeneration: context.checkpoint.analysisGeneration + 1,
    };
    if (this.positionChecks === 'lichess') {
      return {
        checkpoint: { ...nextBase,
          extensions: lichessExtensions(nextBase),
          clocks: pausedClockCheckpoint(context.checkpoint.clocks.timeControl, reading.remaining, context.decisionTimeMs),
          result: { kind: 'final', winner: timeoutWinner(context.position, reading.activeSide === 'white' ? 'w' : 'b'),
            reason: 'timeout', eventId: event.eventId, decidedAtMs: reading.deadline.wallTimeMs },
          archive: { ...nextBase.archive, currentLine: { ...nextBase.archive.currentLine,
            eventIds: [...nextBase.archive.currentLine.eventIds, event.eventId] } },
        }, position: context.position, clockState: null, value: { kind: 'expired' },
      };
    }
    const query = timeoutQuery(nextBase, reading.activeSide);
    const timeoutEvent = context.createEvent('timeout-adjudication-candidate-created', reading.deadline.wallTimeMs, fence, {
      queryIdentity: query.queryIdentity,
      expiredSide: reading.activeSide,
      deadline: reading.deadline,
    });
    const currentExtension = adjudicationExtension(context.checkpoint);
    const reboundCandidates = currentExtension.data.candidates.map((candidate) => {
      if (candidate.status === 'accepted') return candidate;
      const reboundQuery = candidate.kind === 'timeout'
        ? timeoutQuery(nextBase, candidate.query.predicate === 'timeout-opponent-mating' && candidate.query.expiredColor === 'w' ? 'white' : 'black')
        : deadnessQuery(nextBase);
      return { ...candidate, query: reboundQuery, searchCheckpoint: null, status: 'queued' as const, requestId: null };
    });
    const candidates = [...reboundCandidates, {
      kind: 'timeout' as const,
      eventId: timeoutEvent.eventId,
      eventAtMs: reading.deadline.wallTimeMs,
      deadlineMs: reading.deadline.wallTimeMs,
      query,
      searchCheckpoint: null,
      status: 'queued' as const,
      requestId: null,
    }];
    const earlierDeadness = currentExtension.data.candidates.find((candidate) =>
      candidate.kind === 'deadness' && candidate.eventAtMs <= reading.deadline.wallTimeMs && candidate.status !== 'accepted');
    return {
      checkpoint: {
        ...nextBase,
        archive: {
          ...context.checkpoint.archive,
          currentLine: {
            ...context.checkpoint.archive.currentLine,
            eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId, timeoutEvent.eventId],
          },
        },
        extensions: withAdjudicationExtension(context.checkpoint, { version: 1, data: {
          candidates, activeQueryIdentity: null,
        } }),
        clocks: pausedClockCheckpoint(
          context.clockState?.timeControl ?? context.checkpoint.clocks.timeControl,
          reading.remaining,
          context.decisionTimeMs,
        ),
        result: earlierDeadness === undefined
          ? { kind: 'pending-adjudication', reason: 'timeout', eventId: timeoutEvent.eventId,
              eventAtMs: reading.deadline.wallTimeMs, activeClockDeadlineMs: null }
          : context.checkpoint.result.kind === 'pending-adjudication'
            ? { ...context.checkpoint.result, activeClockDeadlineMs: null }
            : context.checkpoint.result,
      },
      position: context.position,
      clockState: null,
      value: { kind: 'expired' },
    };
  }

  private clockDiscrepancyCandidate(
    context: ControllerDecisionContext,
    fence: ControllerFenceV1,
    reading: ClockReading,
  ): ControllerDecisionCandidate<IntentMutationValue> {
    if (reading.status !== 'reconciliation-required') {
      throw new GameControllerError('invalid-configuration', 'A clock discrepancy decision needs a reconciliation reading.');
    }
    const event = context.createEvent(
      'clock-reconciliation-required',
      context.decisionTimeMs,
      fence,
      { reason: reading.reason, evidence: reading.evidence },
    );
    const nextCheckpoint = {
      ...context.checkpoint,
      revision: context.checkpoint.revision + 1,
      requestGeneration: context.checkpoint.requestGeneration + 1,
      analysisGeneration: context.checkpoint.analysisGeneration + 1,
      archive: { ...context.checkpoint.archive, currentLine: { ...context.checkpoint.archive.currentLine,
        eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId] } },
    };
    return {
      checkpoint: { ...nextCheckpoint, extensions: rebindPendingCandidates(context.checkpoint, nextCheckpoint) },
      position: context.position,
      clockState: context.clockState,
      value: { kind: 'clock-reconciliation-required' },
    };
  }

  private async commitMutation<Value extends { kind: string }>(
    expectedFence: ControllerFenceV1 | null,
    decide: (context: ControllerDecisionContext) => ControllerDecisionCandidate<Value>,
  ): Promise<{ snapshot: ControllerSnapshotV1; value: Value }> {
    const baseCheckpoint = this.checkpoint;
    const basePosition = this.position;
    if (baseCheckpoint === null || basePosition === null) {
      throw new GameControllerError('setup-required', 'Initialize the game before committing an intent.');
    }
    if (expectedFence !== null && !sameFence(createFence(baseCheckpoint), expectedFence)) {
      throw new GameControllerError('invalid-intent', 'The intent fence became stale before commit.');
    }

    const stored = await this.store.readGame(this.gameId);
    if (
      stored === null ||
      stored.checkpoint.revision !== baseCheckpoint.revision ||
      stored.checkpoint.ownershipEpoch !== baseCheckpoint.ownershipEpoch
    ) {
      throw new GameControllerError('revision-conflict', 'The saved checkpoint changed before the controller decision.');
    }
    const usedIds = new Set(stored.events.map((event) => event.eventId));
    let nextSequence = stored.events.reduce((highest, event) => Math.max(highest, event.sequence), -1) + 1;
    const acceptedCandidate: { value: ControllerDecisionCandidate<Value> | null } = { value: null };
    const generatedEvents: ArchiveEventV1[] = [];

    const result = await this.store.commitCheckpoint({
      gameId: this.gameId,
      expectedRevision: baseCheckpoint.revision,
      expectedEpoch: baseCheckpoint.ownershipEpoch,
      events: [],
      chunks: [],
      knownCredentials: [],
      decide: (decisionTimeMs) => {
        if (this.checkpoint !== baseCheckpoint) {
          throw new GameControllerError('revision-conflict', 'The controller checkpoint changed during the decision.');
        }
        if (expectedFence !== null && !sameFence(createFence(baseCheckpoint), expectedFence)) {
          throw new GameControllerError('invalid-intent', 'The intent fence changed before its decision.');
        }
        const at = sampleAtDecision(this.timeSource, decisionTimeMs);
        const context: ControllerDecisionContext = {
          checkpoint: baseCheckpoint,
          position: basePosition,
          clockState: this.clockState,
          decisionTimeMs,
          at,
          createEvent: (kind, occurredAtMs, fence, details) => {
            if (!Number.isFinite(occurredAtMs) || nextSequence > Number.MAX_SAFE_INTEGER) {
              throw new GameControllerError('invalid-configuration', 'A controller event has invalid time or sequence data.');
            }
            const eventId = nextUniqueId(this.idFactory, usedIds);
            const event: ArchiveEventV1 = {
              eventId,
              gameId: this.gameId,
              sequence: nextSequence,
              segmentId: baseCheckpoint.segmentId,
              kind,
              occurredAtMs,
              receiveState: 'complete',
              egressStatus: 'eligible',
              payload: eventPayload(fence, details),
              chunkIds: [],
            };
            nextSequence += 1;
            generatedEvents.push(event);
            return event;
          },
          createEventId: () => nextUniqueId(this.idFactory, usedIds),
        };
        const candidate = decide(context);
        const nextCheckpoint: GameCheckpointV1 = {
          ...candidate.checkpoint,
          revision: baseCheckpoint.revision + 1,
          updatedAtMs: decisionTimeMs,
        };
        acceptedCandidate.value = { ...candidate, checkpoint: nextCheckpoint };
        return {
          checkpoint: nextCheckpoint,
          events: generatedEvents,
          outboxOperationIds: [],
        };
      },
    });
    if (result.kind === 'revision-conflict') {
      throw new GameControllerError('revision-conflict', 'The persisted game revision or ownership epoch changed.');
    }
    if (acceptedCandidate.value === null) {
      throw new GameControllerError('revision-conflict', 'The checkpoint decision produced no controller state.');
    }
    this.checkpoint = result.checkpoint;
    this.position = acceptedCandidate.value.position;
    this.clockState = acceptedCandidate.value.clockState;
    if (acceptedCandidate.value.value.kind === 'reconciled') this.restored = false;
    if (acceptedCandidate.value.value.kind === 'clock-reconciliation-required') {
      this.clockReconciliationRequired = true;
      this.pendingClockDiscrepancy = null;
      this.activeRequest = null;
    } else if (acceptedCandidate.value.value.kind === 'reconciled') {
      this.clockReconciliationRequired = false;
      this.pendingClockDiscrepancy = null;
      this.activeRequest = null;
    }
    const snapshot = this.snapshot();
    this.publish(snapshot);
    return { snapshot, value: acceptedCandidate.value.value };
  }

  private async persistCurrentExpiry(): Promise<ControllerSnapshotV1> {
    return this.persistCurrentClockStatus();
  }

  private async persistCurrentClockDiscrepancy(): Promise<ControllerSnapshotV1> {
    return this.persistCurrentClockStatus();
  }

  private async persistCurrentClockStatus(): Promise<ControllerSnapshotV1> {
    const checkpoint = this.checkpoint;
    if (checkpoint === null) {
      throw new GameControllerError('setup-required', 'Initialize the game before reconciling its clock.');
    }
    const committed = await this.commitMutation<IntentMutationValue>(createFence(checkpoint), (context) => {
      const clockState = context.clockState;
      if (clockState === null) return this.noClockCandidate(context, createFence(context.checkpoint));
      const reading = readClockAt(clockState, context.at, this.clockPolicy);
      if (reading.status === 'expired') {
        return this.expiryCandidate(context, createFence(context.checkpoint), reading);
      }
      if (reading.status === 'reconciliation-required') {
        return this.clockDiscrepancyCandidate(context, createFence(context.checkpoint), reading);
      }
      const currentFence = createFence(context.checkpoint);
      const event = context.createEvent(
        'clock-reference-rechecked',
        context.decisionTimeMs,
        currentFence,
        { status: reading.status, evidence: reading.evidence },
      );
      const nextCheckpoint = {
        ...context.checkpoint,
        revision: context.checkpoint.revision + 1,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
        archive: { ...context.checkpoint.archive, currentLine: { ...context.checkpoint.archive.currentLine,
          eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId] } },
      };
      return {
        checkpoint: { ...nextCheckpoint, extensions: rebindPendingCandidates(context.checkpoint, nextCheckpoint) },
        position: context.position,
        clockState,
        value: { kind: 'accepted' },
      };
    });
    if (committed.value.kind === 'clock-reconciliation-required') {
      this.clockReconciliationRequired = true;
    }
    return committed.snapshot;
  }

  private async loadOrCreate(setup?: GameControllerSetupV1): Promise<ControllerSnapshotV1> {
    const existing = await this.store.readGame(this.gameId);
    if (existing !== null) {
      this.restore(existing.checkpoint, existing.events);
      let snapshot = this.snapshot();
      if (this.positionChecks === 'lichess' && (existing.checkpoint.extensions['position-rules'] === undefined ||
          existing.checkpoint.extensions[ADJUDICATION_EXTENSION] !== undefined)) {
        const migrated = await this.commitMutation<IntentMutationValue>(snapshot.fence, context => {
          const event = context.createEvent('position-rules-migrated', context.decisionTimeMs, snapshot.fence, { policy: 'lichess' });
          return { checkpoint: { ...context.checkpoint,
            archive: { ...context.checkpoint.archive, currentLine: { ...context.checkpoint.archive.currentLine,
              eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId] } } },
            position: context.position, clockState: context.clockState, value: { kind: 'accepted' } };
        });
        snapshot = migrated.snapshot;
      }
      if (this.positionChecks === 'legacy-proof' && existing.checkpoint.extensions[ADJUDICATION_EXTENSION] === undefined &&
          existing.checkpoint.result.kind === 'unresolved') {
        snapshot = await this.createRestoredPositionCandidate();
      }
      if (snapshot.clockReading?.status === 'expired') snapshot = await this.reconcileReady();
      this.publish(snapshot);
      return snapshot;
    }
    if (setup === undefined) {
      throw new GameControllerError('setup-required', 'A new game requires a validated setup.');
    }

    const prepared = prepareSetup(setup, this.idFactory, this.randomSide);
    let acceptedClock: ClockState | null = null;
    let decisionCompleted = false;
    const result = await this.store.commitCheckpoint({
      gameId: this.gameId,
      expectedRevision: null,
      expectedEpoch: prepared.ownershipEpoch,
      events: [],
      chunks: [],
      knownCredentials: [],
      decide: (decisionTimeMs) => {
        sampleAtDecision(this.timeSource, decisionTimeMs);
        const usedIds = new Set([prepared.segmentId, prepared.lineId]);
        const eventId = nextUniqueId(this.idFactory, usedIds);
        const startingFacts = observeEndingFacts(
          prepared.position,
          createRepetitionLedger(prepared.position),
        );
        const initialResult = finalResultForPosition(
          prepared.position,
          startingFacts,
          eventId,
          decisionTimeMs,
          this.positionChecks === 'lichess',
        );
        const needsProof = initialResult === null && this.positionChecks === 'legacy-proof';
        const setupCandidateEventId = needsProof ? nextUniqueId(this.idFactory, usedIds) : null;
        const checkpointBase = makeCheckpoint(
          this.gameId,
          prepared,
          null,
          decisionTimeMs,
          eventId,
          initialResult ?? (this.positionChecks === 'lichess' ? { kind: 'unresolved' } : {
            kind: 'pending-adjudication',
            reason: 'dead-position',
            eventId: setupCandidateEventId as string,
            eventAtMs: decisionTimeMs,
            activeClockDeadlineMs: null,
          }),
        );
        const checkpoint = needsProof
          ? {
              ...checkpointBase,
              archive: { ...checkpointBase.archive, currentLine: {
                ...checkpointBase.archive.currentLine,
                eventIds: [...checkpointBase.archive.currentLine.eventIds, setupCandidateEventId as string],
              } },
              extensions: withAdjudicationExtension(checkpointBase, {
                version: 1,
                data: {
                  candidates: [{
                    kind: 'deadness' as const,
                    eventId: setupCandidateEventId as string,
                    eventAtMs: decisionTimeMs,
                    deadlineMs: null,
                    query: deadnessQuery(checkpointBase),
                    searchCheckpoint: null,
                    status: 'queued' as const,
                    requestId: null,
                  }],
                  activeQueryIdentity: null,
                },
              }),
            }
          : this.positionChecks === 'lichess' ? { ...checkpointBase, extensions: lichessExtensions(checkpointBase) } : checkpointBase;
        const details: Record<string, unknown> = {
          humanSide: prepared.humanSide,
          startingFen: prepared.startingFen,
          timeControl: prepared.timeControl,
        };
        if (initialResult !== null) details.result = initialResult;
        const event: ArchiveEventV1 = {
          eventId,
          gameId: this.gameId,
          sequence: 0,
          segmentId: prepared.segmentId,
          kind: 'game-created',
          occurredAtMs: decisionTimeMs,
          receiveState: 'complete',
          egressStatus: 'eligible',
          payload: eventPayload(createFence(checkpoint), details),
          chunkIds: [],
        };
        const events = [event];
        if (needsProof) {
          const query = deadnessQuery(checkpoint);
          const candidateEvent: ArchiveEventV1 = {
            eventId: setupCandidateEventId as string,
            gameId: this.gameId,
            sequence: 1,
            segmentId: prepared.segmentId,
            kind: 'deadness-candidate-created',
            occurredAtMs: decisionTimeMs,
            receiveState: 'complete',
            egressStatus: 'eligible',
            payload: eventPayload(createFence(checkpoint), { queryIdentity: query.queryIdentity, reason: 'setup-classification' }),
            chunkIds: [],
          };
          events.push(candidateEvent);
        }
        acceptedClock = null;
        decisionCompleted = true;
        return {
          checkpoint,
          events,
          outboxOperationIds: [],
        };
      },
    });
    if (result.kind === 'revision-conflict') {
      throw new GameControllerError('revision-conflict', 'A game with this ID already has a saved checkpoint.');
    }
    if (!decisionCompleted) {
      throw new GameControllerError('invalid-configuration', 'The checkpoint decision did not produce controller state.');
    }
    this.checkpoint = result.checkpoint;
    this.position = prepared.position;
    this.clockState = acceptedClock;
    this.restored = false;
    const snapshot = this.snapshot();
    this.publish(snapshot);
    return snapshot;
  }

  private async createRestoredPositionCandidate(): Promise<ControllerSnapshotV1> {
    const checkpoint = this.checkpoint;
    if (checkpoint === null) throw new GameControllerError('setup-required', 'Initialize the game before classifying a restored position.');
    const committed = await this.commitMutation<{ kind: 'accepted' }>(null, (context) => {
      const reading = context.clockState === null ? null : readClockAt(context.clockState, context.at, this.clockPolicy);
      const nextCheckpoint = {
        ...context.checkpoint,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
      };
      const query = deadnessQuery(nextCheckpoint);
      const deadlineMs = reading === null || reading.status === 'reconciliation-required' ? null : reading.deadline.wallTimeMs;
      const event = context.createEvent('deadness-candidate-created', context.checkpoint.updatedAtMs,
        createFence(nextCheckpoint), { queryIdentity: query.queryIdentity, reason: 'restored-position-classification' });
      const candidate: AdjudicationCandidateV1 = {
        kind: 'deadness', eventId: event.eventId, eventAtMs: context.checkpoint.updatedAtMs,
        deadlineMs, query, searchCheckpoint: null, status: 'queued', requestId: null,
      };
      const result: GameResultV1 = {
        kind: 'pending-adjudication', reason: 'dead-position', eventId: event.eventId,
        eventAtMs: context.checkpoint.updatedAtMs, activeClockDeadlineMs: deadlineMs,
      };
      return { checkpoint: {
        ...nextCheckpoint, result,
        extensions: withAdjudicationExtension(context.checkpoint, { version: 1,
          data: { candidates: [candidate], activeQueryIdentity: null } }),
        archive: { ...context.checkpoint.archive, currentLine: { ...context.checkpoint.archive.currentLine,
          eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId] } },
      }, position: context.position, clockState: context.clockState, value: { kind: 'accepted' } };
    });
    return committed.snapshot;
  }

  private restore(checkpoint: GameCheckpointV1, events: readonly ArchiveEventV1[]): void {
    if (checkpoint.gameId !== this.gameId) {
      throw new GameControllerError('saved-game-invalid', 'The saved checkpoint has a different game ID.');
    }
    const position = parsePosition(checkpoint.rules.currentFen);
    if (fromPositionColor(position.sideToMove) !== checkpoint.rules.sideToMove) {
      throw new GameControllerError('saved-game-invalid', 'The saved rules turn does not match the saved FEN.');
    }
    restoreRepetitionLedger({
      version: checkpoint.rules.repetitionLedger.version,
      entries: checkpoint.rules.repetitionLedger.positions.map((entry) => ({ ...entry })),
    });
    const verifiedCheckpoint = this.positionChecks === 'lichess'
      ? migrateLichessCheckpoint(checkpoint, position) : validateAcceptedAdjudicationEvidence(checkpoint);
    const adjudication = adjudicationExtension(verifiedCheckpoint);
    const abandonedRunning = adjudication.data.candidates.some((candidate) => candidate.status === 'running');
    const recoveredCheckpoint = abandonedRunning
      ? (() => {
          const reboundBase = { ...verifiedCheckpoint, analysisGeneration: verifiedCheckpoint.analysisGeneration + 1 };
          const candidates = adjudication.data.candidates.map((candidate) => {
            if (candidate.status !== 'running') return candidate;
            const query = candidate.kind === 'timeout'
              ? timeoutQuery(reboundBase, candidate.query.predicate === 'timeout-opponent-mating' && candidate.query.expiredColor === 'w' ? 'white' : 'black')
              : deadnessQuery(reboundBase);
            return { ...candidate, query, status: 'queued' as const, requestId: null, searchCheckpoint: null };
          });
          return { ...reboundBase, extensions: withAdjudicationExtension(reboundBase, { version: 1,
            data: { candidates, activeQueryIdentity: null } }) };
        })()
      : verifiedCheckpoint;
    this.checkpoint = structuredClone(recoveredCheckpoint);
    this.position = position;
    this.clockState = createClockState(recoveredCheckpoint);
    this.restored = this.clockState !== null;
    const currentFence = createFence(recoveredCheckpoint);
    const currentSide = sideForCheckpoint(recoveredCheckpoint);
    const hasUnsettledStartedRequest = recoveredCheckpoint.result.kind === 'unresolved' &&
      recoveredCheckpoint.selections.players[currentSide].kind === 'model' &&
      events.some((event) => {
        if (event.kind !== 'model-turn-started' || event.segmentId !== recoveredCheckpoint.segmentId) return false;
        const payload = event.payload as { fence?: ControllerFenceV1; details?: { requestGeneration?: number } } | null;
        return payload !== null && typeof payload === 'object' && payload.fence !== undefined &&
          sameFence(payload.fence, currentFence) && payload.details?.requestGeneration === currentFence.requestGeneration;
      });
    this.restoredUnsettledModelRequest = this.restored && hasUnsettledStartedRequest ? currentFence : null;
    this.pendingClockDiscrepancy = null;
    const latestClockResolution = events
      .filter((event) =>
        event.kind === 'clock-reconciliation-required' ||
        event.kind === 'clock-absence-reconciled' ||
        event.kind === 'clock-reference-reconciled',
      )
      .reduce<ArchiveEventV1 | null>(
        (latest, event) => latest === null || event.sequence > latest.sequence ? event : latest,
        null,
      );
    this.clockReconciliationRequired = latestClockResolution?.kind === 'clock-reconciliation-required';
    if (
      this.clockState !== null &&
      this.clockState.activeSide !== fromPositionColor(position.sideToMove)
    ) {
      throw new GameControllerError('saved-game-invalid', 'The saved clock side does not match the saved FEN.');
    }
  }

  private publish(snapshot: ControllerSnapshotV1): void {
    for (const listener of this.listeners) {
      try {
        listener(copySnapshot(snapshot));
      } catch {
        // A view listener cannot change the durable controller result.
      }
    }
  }
}

function samePolicy(left: ClockComparisonPolicy, right: ClockComparisonPolicy): boolean {
  return left.maxReferenceDivergenceMs === right.maxReferenceDivergenceMs;
}

/** Returns the one actionable controller associated with a game until its registration is released. */
export function getOrCreateGameController(options: GameControllerOptions): GameController {
  if (typeof options.gameId !== 'string' || options.gameId.length === 0) {
    throw new GameControllerError('invalid-configuration', 'The game ID must be a nonempty string.');
  }
  assertClockPolicy(options.clockPolicy);
  const positionChecks = options.positionChecks ?? 'lichess';
  const timeSource = options.timeSource ?? defaultTimeSource;
  const registryScope = options.registryScope ?? 'guest';
  if (typeof registryScope !== 'string' || registryScope.length === 0) {
    throw new GameControllerError('invalid-configuration', 'The controller registry scope must be a nonempty stable string.');
  }
  const registryKey = JSON.stringify([registryScope, options.gameId]);
  const existing = registry.get(registryKey);
  if (existing !== undefined) {
    const configured = existing.configuration;
    if (
      configured.positionChecks !== positionChecks ||
      configured.store !== options.store ||
      configured.timeSource !== timeSource ||
      !samePolicy(configured.clockPolicy, options.clockPolicy)
    ) {
      throw new GameControllerError(
        'invalid-configuration',
        'A game ID cannot be rebound to another store, time source, or clock policy.',
      );
    }
    return existing.controller;
  }
  const controller = new IndexedGameController(
    options.gameId,
    options.store,
    timeSource,
    { ...options.clockPolicy },
    options.idFactory ?? defaultIdFactory,
    options.randomSide ?? defaultRandomSide,
    positionChecks,
  );
  registry.set(registryKey, {
    controller,
    configuration: {
      positionChecks,
      store: options.store,
      timeSource,
      clockPolicy: { ...options.clockPolicy },
    },
  });
  return controller;
}

/** Releases only the exact controller registered for this store scope and game ID. */
export function releaseGameController(options: {
  readonly gameId: string;
  readonly registryScope: string;
  readonly controller: GameController;
}): boolean {
  const registryKey = JSON.stringify([options.registryScope, options.gameId]);
  const registered = registry.get(registryKey);
  if (registered === undefined || registered.controller !== options.controller) return false;
  registry.delete(registryKey);
  return true;
}

interface RegisteredController {
  readonly controller: IndexedGameController;
  readonly configuration: RegistryConfiguration;
}

// Use a registered wrapper so accidental factory calls cannot create a second writer.
export function createRestartSetup(source: ControllerSnapshotV1): GameControllerSetupV1 {
  const checkpoint = source.checkpoint;
  if (checkpoint.selections.players.white.kind === 'human' && checkpoint.selections.players.black.kind === 'human') {
    return {
      humanSide: 'white',
      namespace: structuredClone(checkpoint.namespace),
      ownershipEpoch: checkpoint.ownershipEpoch,
      startingFen: checkpoint.rules.startingFen,
      timeControl: { ...checkpoint.clocks.timeControl },
    };
  }
  const modelSelection = checkpoint.selections.players.white.kind === 'model'
    ? checkpoint.selections.players.white
    : checkpoint.selections.players.black;
  return {
    humanSide: checkpoint.selections.players.white.kind === 'human' ? 'white' : 'black',
    players: structuredClone(checkpoint.selections.players),
    modelSelection: structuredClone(modelSelection) as ModelSelection,
    namespace: structuredClone(checkpoint.namespace),
    ownershipEpoch: checkpoint.ownershipEpoch,
    startingFen: checkpoint.rules.startingFen,
    timeControl: { ...checkpoint.clocks.timeControl },
  };
}

export function createRematchSetup(source: ControllerSnapshotV1): GameControllerSetupV1 {
  const setup = createRestartSetup(source);
  setup.humanSide = setup.humanSide === 'white' ? 'black' : 'white';
  if (setup.players) setup.players = { white: setup.players.black, black: setup.players.white };
  return setup;
}

export const prepareRestart = createRestartSetup;
export const prepareRematch = createRematchSetup;
export const createRestartGameSetup = createRestartSetup;
export const createRematchGameSetup = createRematchSetup;

const registry = new Map<string, RegisteredController>();
