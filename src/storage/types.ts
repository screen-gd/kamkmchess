export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ChessSideV1 = 'white' | 'black';

export type GameNamespaceV1 =
  | { kind: 'guest' }
  | { kind: 'account'; accountId: string };

export interface VersionedExtensionSectionV1 {
  version: number;
  data: JsonValue;
}

export type CheckpointExtensionsV1 = Record<string, VersionedExtensionSectionV1>;

export interface AppliedMoveV1 {
  moveId: string;
  from: string;
  to: string;
  promotion: string | null;
  san: string;
  fenBefore: string;
  fenAfter: string;
  eventId: string;
}

export interface RulesCheckpointV1 {
  variant: 'orthodox';
  startingFen: string;
  currentFen: string;
  sideToMove: ChessSideV1;
  castlingRights: string;
  enPassantSquare: string | null;
  halfmoveClock: string;
  fullmoveNumber: string;
  repetitionLedger: {
    version: 1;
    positions: Array<{ identity: string; occurrences: string }>;
  };
  moves: AppliedMoveV1[];
}

export interface HistorySegmentV1 {
  segmentId: string;
  providerId: string | null;
  modelRoutingId: string | null;
  connectionRevision: number | null;
  startedAtMs: number;
  messageIds: string[];
}

export interface HistoryMessageV1 {
  messageId: string;
  segmentId: string;
  lineId: string;
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'function';
  content: string;
  eventIds: string[];
  disposition: 'retained' | 'discarded';
}

export interface HistoryCheckpointV1 {
  currentSegmentId: string;
  segments: HistorySegmentV1[];
  messages: HistoryMessageV1[];
}

export interface ClockAnchorCheckpointV1 {
  monotonicMs: number;
  wallTimeMs: number;
  hostOffsetMs?: number;
}

export interface ClockCheckpointV1 {
  schemaVersion: 1;
  timeControl: {
    startingTimeMs: number;
    incrementMs: number;
  };
  banksAtAnchor: {
    whiteMs: number;
    blackMs: number;
  };
  activeSide: ChessSideV1 | null;
  anchor: ClockAnchorCheckpointV1 | null;
  lastReconciledAtMs: number;
}

export interface BudgetCheckpointV1 {
  formattingCorrectionsRemaining: number;
  illegalMoveAttemptsRemaining: Record<ChessSideV1, number>;
  manualRetriesBySide: Record<ChessSideV1, number>;
}

export type PlayerSelectionV1 =
  | { kind: 'human' }
  | {
      kind: 'model';
      providerId: string;
      connectionId: string;
      configurationRevision: number;
      modelRoutingId: string;
      protocol: 'chat-completions' | 'responses' | 'messages' | 'custom';
      diagnostic: 'not-run' | 'passed-current-session' | 'failed' | 'unknown';
    };

export interface SelectionCheckpointV1 {
  players: Record<ChessSideV1, PlayerSelectionV1>;
}

export interface ArchiveLineReferenceV1 {
  lineId: string;
  eventIds: string[];
}

export interface DiscardedLineReferenceV1 extends ArchiveLineReferenceV1 {
  discardedAtRevision: number;
  reason: 'undo' | 'branch' | 'replacement';
}

export interface ArchiveReferencesV1 {
  egressStatus: 'eligible' | 'credential-echo-quarantined';
  currentLine: ArchiveLineReferenceV1;
  discardedLines: DiscardedLineReferenceV1[];
}

export type PendingResultReasonV1 =
  | 'checkmate'
  | 'timeout'
  | 'dead-position'
  | 'threefold-repetition'
  | 'fifty-move-rule';

export type FinalResultReasonV1 =
  | PendingResultReasonV1
  | 'resignation'
  | 'illegal-move'
  | 'stalemate'
  | 'draw-agreement';

export type GameResultV1 =
  | { kind: 'unresolved' }
  | {
      kind: 'pending-adjudication';
      reason: PendingResultReasonV1;
      eventId: string;
      eventAtMs: number;
      activeClockDeadlineMs: number | null;
    }
  | {
      kind: 'final';
      winner: ChessSideV1 | 'draw';
      reason: Exclude<FinalResultReasonV1, 'stalemate' | 'draw-agreement'>;
      eventId: string;
      decidedAtMs: number;
    }
  | {
      kind: 'final';
      winner: 'draw';
      reason: 'stalemate' | 'draw-agreement';
      eventId: string;
      decidedAtMs: number;
    };

export interface PracticeCheckpointV1 {
  mode: 'ordinary' | 'practice';
  scored: boolean;
  sourceGameId: string | null;
  sourcePositionFen: string | null;
  originalResult: Extract<GameResultV1, { kind: 'final' }> | null;
}

export interface GameCheckpointV1 {
  schemaVersion: 1;
  gameId: string;
  namespace: GameNamespaceV1;
  revision: number;
  ownershipEpoch: number;
  segmentId: string;
  positionRevision: number;
  requestGeneration: number;
  analysisGeneration: number;
  updatedAtMs: number;
  rules: RulesCheckpointV1;
  history: HistoryCheckpointV1;
  clocks: ClockCheckpointV1;
  budgets: BudgetCheckpointV1;
  selections: SelectionCheckpointV1;
  archive: ArchiveReferencesV1;
  result: GameResultV1;
  practice: PracticeCheckpointV1;
  extensions: CheckpointExtensionsV1;
}

export interface ArchiveEventV1 {
  eventId: string;
  gameId: string;
  sequence: number;
  segmentId: string;
  kind: string;
  occurredAtMs: number;
  receiveState: 'complete' | 'partial';
  egressStatus: 'eligible' | 'credential-echo-quarantined';
  payload: JsonValue;
  chunkIds: string[];
}

export interface ArchiveChunkV1 {
  chunkId: string;
  gameId: string;
  sequence: number;
  receivedAtMs: number;
  isFinal: boolean;
  egressStatus: 'eligible' | 'credential-echo-quarantined';
  bytes: Uint8Array;
  sha256: string;
}

export interface StoredGameV1 {
  checkpoint: GameCheckpointV1;
  events: ArchiveEventV1[];
  chunks: ArchiveChunkV1[];
}

export type StorageFailureCodeV1 =
  | 'unavailable'
  | 'upgrade-blocked'
  | 'upgrade-failed'
  | 'quota'
  | 'transaction-aborted'
  | 'revision-conflict'
  | 'invalid-data'
  | 'unknown';

export interface StorageFailureV1 {
  code: StorageFailureCodeV1;
  occurredAtMs: number;
}

export type PersistencePermissionV1 =
  | 'unsupported'
  | 'not-requested'
  | 'granted'
  | 'denied'
  | 'failed';

export type SyncStatusV1 =
  | { kind: 'not-configured'; syncedRevision: null }
  | { kind: 'current'; syncedRevision: number }
  | { kind: 'pending'; syncedRevision: number | null }
  | { kind: 'blocked'; syncedRevision: number | null }
  | { kind: 'failed'; syncedRevision: number | null };

export type LocalSaveStatusV1 =
  | { kind: 'memory-only' }
  | { kind: 'saved-locally'; revision: number }
  | { kind: 'failed'; savedRevision: number | null; failure: StorageFailureV1 };

export interface GameStorageStatusV1 {
  local: LocalSaveStatusV1;
  persistentStorage: PersistencePermissionV1;
  sync: SyncStatusV1;
  lastFailure: StorageFailureV1 | null;
}

export interface StoredOutboxRecordV1 {
  operationId: string;
  gameId: string;
  namespace: GameNamespaceV1;
  checkpointRevision: number;
  ownershipEpoch: number;
  createdAtMs: number;
  state: 'pending' | 'blocked' | 'synced' | 'failed';
  blockedReason: 'credential-echo' | null;
  failureCode: 'network' | 'authentication' | 'conflict' | 'unknown' | null;
  syncedRevision: number | null;
}

export interface CommitDecisionV1 {
  checkpoint: GameCheckpointV1;
  /** Metadata events created synchronously from the fenced decision-time sample. */
  events?: ArchiveEventV1[];
  outboxOperationIds: string[];
}

export interface CheckpointCommitInputV1 {
  gameId: string;
  expectedRevision: number | null;
  expectedEpoch: number;
  events: ArchiveEventV1[];
  chunks: ArchiveChunkV1[];
  knownCredentials: readonly string[];
  decide: (decisionTimeMs: number) => CommitDecisionV1;
}

export type CheckpointCommitResultV1 =
  | { kind: 'committed'; checkpoint: GameCheckpointV1; decisionTimeMs: number }
  | {
      kind: 'revision-conflict';
      actualRevision: number | null;
      actualEpoch: number | null;
    };
