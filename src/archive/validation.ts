import { ArchiveError, decodeBase64, sha256Hex } from './codec';
import type { ArchiveChunkExportV1, GameArchiveExportV1 } from './types';
import type {
  ArchiveChunkV1,
  ArchiveEventV1,
  ArchiveLineReferenceV1,
  BudgetCheckpointV1,
  CheckpointExtensionsV1,
  ClockCheckpointV1,
  DiscardedLineReferenceV1,
  GameNamespaceV1,
  GameCheckpointV1,
  GameResultV1,
  HistoryCheckpointV1,
  HistoryMessageV1,
  HistorySegmentV1,
  JsonValue,
  PlayerSelectionV1,
  PracticeCheckpointV1,
  RulesCheckpointV1,
  SelectionCheckpointV1,
} from '../storage';

type UnknownRecord = Record<string, unknown>;

function fail(message: string): never {
  throw new ArchiveError('invalid-archive', message);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown, path: string): UnknownRecord {
  if (!isRecord(value)) fail(`${path} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${path} must be a plain object.`);
  return value;
}

function exactKeys(record: UnknownRecord, allowed: readonly string[], path: string): void {
  const allowlist = new Set(allowed);
  for (const key of allowed) {
    if (!Object.hasOwn(record, key)) fail(`${path}.${key} is required.`);
  }
  for (const key of Object.keys(record)) {
    if (!allowlist.has(key)) fail(`${path}.${key} is not a supported field.`);
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(`${path} must be a string.`);
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (text.length === 0) fail(`${path} must not be empty.`);
  return text;
}

function decimalString(value: unknown, path: string, minimumOne = false): string {
  const decimal = nonEmptyString(value, path);
  if (!/^(0|[1-9][0-9]*)$/.test(decimal) || (minimumOne && decimal === '0')) {
    fail(`${path} must be an exact non-negative decimal string.`);
  }
  return decimal;
}

function numberValue(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path} must be a finite number.`);
  return value;
}

function integerValue(value: unknown, path: string): number {
  const number = numberValue(value, path);
  if (!Number.isSafeInteger(number)) fail(`${path} must be a safe integer.`);
  return number;
}

function nonNegativeIntegerValue(value: unknown, path: string): number {
  const number = integerValue(value, path);
  if (number < 0) fail(`${path} must be a non-negative safe integer.`);
  return number;
}

function positiveIntegerValue(value: unknown, path: string): number {
  const number = integerValue(value, path);
  if (number < 1) fail(`${path} must be a positive safe integer.`);
  return number;
}

function nullableNumber(value: unknown, path: string): number | null {
  return value === null ? null : numberValue(value, path);
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : stringValue(value, path);
}

function enumValue<T extends string>(value: unknown, values: readonly T[], path: string): T {
  for (const candidate of values) {
    if (value === candidate) return candidate;
  }
  return fail(`${path} has an unsupported value.`);
}

function readGameNamespace(value: unknown, path: string): GameNamespaceV1 {
  const namespace = readRecord(value, path);
  const kind = enumValue(namespace.kind, ['guest', 'account'] as const, `${path}.kind`);
  if (kind === 'guest') {
    exactKeys(namespace, ['kind'], path);
    return { kind };
  }
  exactKeys(namespace, ['kind', 'accountId'], path);
  return { kind, accountId: nonEmptyString(namespace.accountId, `${path}.accountId`) };
}

function readStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(`${path} must be an array.`);
  return value.map((entry, index) => stringValue(entry, `${path}[${index}]`));
}

function readJsonValue(value: unknown, path: string, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} contains a non-finite number.`);
    return value;
  }
  if (typeof value !== 'object') fail(`${path} contains a non-JSON value.`);
  if (seen.has(value)) fail(`${path} contains a circular reference.`);
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((entry, index) => readJsonValue(entry, `${path}[${index}]`, seen));
    seen.delete(value);
    return result;
  }

  const source = readRecord(value, path);
  const result: { [key: string]: JsonValue } = {};
  for (const [key, entry] of Object.entries(source)) {
    Object.defineProperty(result, key, {
      value: readJsonValue(entry, `${path}.${key}`, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  seen.delete(value);
  return result;
}

function readExtensionSections(value: unknown, path: string): CheckpointExtensionsV1 {
  const sections = readRecord(value, path);
  const result: CheckpointExtensionsV1 = {};
  for (const [key, rawSection] of Object.entries(sections)) {
    const section = readRecord(rawSection, `${path}.${key}`);
    exactKeys(section, ['version', 'data'], `${path}.${key}`);
    Object.defineProperty(result, key, {
      value: {
        version: positiveIntegerValue(section.version, `${path}.${key}.version`),
        data: readJsonValue(section.data, `${path}.${key}.data`),
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function readMove(value: unknown, path: string): RulesCheckpointV1['moves'][number] {
  const move = readRecord(value, path);
  exactKeys(move, ['moveId', 'from', 'to', 'promotion', 'san', 'fenBefore', 'fenAfter', 'eventId'], path);
  return {
    moveId: nonEmptyString(move.moveId, `${path}.moveId`),
    from: stringValue(move.from, `${path}.from`),
    to: stringValue(move.to, `${path}.to`),
    promotion: nullableString(move.promotion, `${path}.promotion`),
    san: stringValue(move.san, `${path}.san`),
    fenBefore: stringValue(move.fenBefore, `${path}.fenBefore`),
    fenAfter: stringValue(move.fenAfter, `${path}.fenAfter`),
    eventId: nonEmptyString(move.eventId, `${path}.eventId`),
  };
}

function readRules(value: unknown): RulesCheckpointV1 {
  const rules = readRecord(value, 'checkpoint.rules');
  exactKeys(
    rules,
    [
      'variant',
      'startingFen',
      'currentFen',
      'sideToMove',
      'castlingRights',
      'enPassantSquare',
      'halfmoveClock',
      'fullmoveNumber',
      'repetitionLedger',
      'moves',
    ],
    'checkpoint.rules',
  );
  const ledger = readRecord(rules.repetitionLedger, 'checkpoint.rules.repetitionLedger');
  exactKeys(ledger, ['version', 'positions'], 'checkpoint.rules.repetitionLedger');
  if (ledger.version !== 1) fail('checkpoint.rules.repetitionLedger.version is unsupported.');
  if (!Array.isArray(ledger.positions)) fail('checkpoint.rules.repetitionLedger.positions must be an array.');
  if (!Array.isArray(rules.moves)) fail('checkpoint.rules.moves must be an array.');
  return {
    variant: enumValue(rules.variant, ['orthodox'] as const, 'checkpoint.rules.variant'),
    startingFen: stringValue(rules.startingFen, 'checkpoint.rules.startingFen'),
    currentFen: stringValue(rules.currentFen, 'checkpoint.rules.currentFen'),
    sideToMove: enumValue(rules.sideToMove, ['white', 'black'] as const, 'checkpoint.rules.sideToMove'),
    castlingRights: stringValue(rules.castlingRights, 'checkpoint.rules.castlingRights'),
    enPassantSquare: nullableString(rules.enPassantSquare, 'checkpoint.rules.enPassantSquare'),
    halfmoveClock: decimalString(rules.halfmoveClock, 'checkpoint.rules.halfmoveClock'),
    fullmoveNumber: decimalString(rules.fullmoveNumber, 'checkpoint.rules.fullmoveNumber', true),
    repetitionLedger: {
      version: 1,
      positions: ledger.positions.map((entry, index) => {
        const path = `checkpoint.rules.repetitionLedger.positions[${index}]`;
        const position = readRecord(entry, path);
        exactKeys(position, ['identity', 'occurrences'], path);
        return {
          identity: nonEmptyString(position.identity, `${path}.identity`),
          occurrences: decimalString(position.occurrences, `${path}.occurrences`, true),
        };
      }),
    },
    moves: rules.moves.map((entry, index) => readMove(entry, `checkpoint.rules.moves[${index}]`)),
  };
}

function readHistorySegment(value: unknown, path: string): HistorySegmentV1 {
  const segment = readRecord(value, path);
  exactKeys(segment, ['segmentId', 'providerId', 'modelRoutingId', 'connectionRevision', 'startedAtMs', 'messageIds'], path);
  const providerId = nullableString(segment.providerId, `${path}.providerId`);
  const modelRoutingId = nullableString(segment.modelRoutingId, `${path}.modelRoutingId`);
  const connectionRevision = nullableNumber(segment.connectionRevision, `${path}.connectionRevision`);
  if ((providerId === null || modelRoutingId === null || connectionRevision === null) &&
      !(providerId === null && modelRoutingId === null && connectionRevision === null)) {
    fail(`${path} must identify a complete model selection or a local game.`);
  }
  if (connectionRevision !== null && (!Number.isSafeInteger(connectionRevision) || connectionRevision < 0)) {
    fail(`${path}.connectionRevision must be a nonnegative safe integer.`);
  }
  return {
    segmentId: nonEmptyString(segment.segmentId, `${path}.segmentId`),
    providerId,
    modelRoutingId,
    connectionRevision,
    startedAtMs: numberValue(segment.startedAtMs, `${path}.startedAtMs`),
    messageIds: readStringArray(segment.messageIds, `${path}.messageIds`),
  };
}

function readHistoryMessage(value: unknown, path: string): HistoryMessageV1 {
  const message = readRecord(value, path);
  exactKeys(message, ['messageId', 'segmentId', 'lineId', 'role', 'content', 'eventIds', 'disposition'], path);
  return {
    messageId: nonEmptyString(message.messageId, `${path}.messageId`),
    segmentId: nonEmptyString(message.segmentId, `${path}.segmentId`),
    lineId: nonEmptyString(message.lineId, `${path}.lineId`),
    role: enumValue(
      message.role,
      ['system', 'developer', 'user', 'assistant', 'tool', 'function'] as const,
      `${path}.role`,
    ),
    content: stringValue(message.content, `${path}.content`),
    eventIds: readStringArray(message.eventIds, `${path}.eventIds`),
    disposition: enumValue(message.disposition, ['retained', 'discarded'] as const, `${path}.disposition`),
  };
}

function readHistory(value: unknown): HistoryCheckpointV1 {
  const history = readRecord(value, 'checkpoint.history');
  exactKeys(history, ['currentSegmentId', 'segments', 'messages'], 'checkpoint.history');
  if (!Array.isArray(history.segments)) fail('checkpoint.history.segments must be an array.');
  if (!Array.isArray(history.messages)) fail('checkpoint.history.messages must be an array.');
  return {
    currentSegmentId: nonEmptyString(history.currentSegmentId, 'checkpoint.history.currentSegmentId'),
    segments: history.segments.map((entry, index) =>
      readHistorySegment(entry, `checkpoint.history.segments[${index}]`),
    ),
    messages: history.messages.map((entry, index) =>
      readHistoryMessage(entry, `checkpoint.history.messages[${index}]`),
    ),
  };
}

function readClock(value: unknown): ClockCheckpointV1 {
  const clock = readRecord(value, 'checkpoint.clocks');
  exactKeys(clock, ['schemaVersion', 'timeControl', 'banksAtAnchor', 'activeSide', 'anchor', 'lastReconciledAtMs'], 'checkpoint.clocks');
  if (clock.schemaVersion !== 1) fail('checkpoint.clocks.schemaVersion is unsupported.');
  const timeControl = readRecord(clock.timeControl, 'checkpoint.clocks.timeControl');
  exactKeys(timeControl, ['startingTimeMs', 'incrementMs'], 'checkpoint.clocks.timeControl');
  const banks = readRecord(clock.banksAtAnchor, 'checkpoint.clocks.banksAtAnchor');
  exactKeys(banks, ['whiteMs', 'blackMs'], 'checkpoint.clocks.banksAtAnchor');
  let anchor: ClockCheckpointV1['anchor'] = null;
  if (clock.anchor !== null) {
    const anchorRecord = readRecord(clock.anchor, 'checkpoint.clocks.anchor');
    const anchorKeys = ['monotonicMs', 'wallTimeMs'];
    if (Object.hasOwn(anchorRecord, 'hostOffsetMs')) anchorKeys.push('hostOffsetMs');
    exactKeys(anchorRecord, anchorKeys, 'checkpoint.clocks.anchor');
    anchor = {
      monotonicMs: numberValue(anchorRecord.monotonicMs, 'checkpoint.clocks.anchor.monotonicMs'),
      wallTimeMs: numberValue(anchorRecord.wallTimeMs, 'checkpoint.clocks.anchor.wallTimeMs'),
      ...(Object.hasOwn(anchorRecord, 'hostOffsetMs')
        ? { hostOffsetMs: numberValue(anchorRecord.hostOffsetMs, 'checkpoint.clocks.anchor.hostOffsetMs') }
        : {}),
    };
  }
  const activeSide =
    clock.activeSide === null
      ? null
      : enumValue(clock.activeSide, ['white', 'black'] as const, 'checkpoint.clocks.activeSide');
  if ((activeSide === null) !== (anchor === null)) {
    fail('checkpoint.clocks.activeSide and anchor must both be null while paused.');
  }
  return {
    schemaVersion: 1,
    timeControl: {
      startingTimeMs: numberValue(timeControl.startingTimeMs, 'checkpoint.clocks.timeControl.startingTimeMs'),
      incrementMs: numberValue(timeControl.incrementMs, 'checkpoint.clocks.timeControl.incrementMs'),
    },
    banksAtAnchor: {
      whiteMs: numberValue(banks.whiteMs, 'checkpoint.clocks.banksAtAnchor.whiteMs'),
      blackMs: numberValue(banks.blackMs, 'checkpoint.clocks.banksAtAnchor.blackMs'),
    },
    activeSide,
    anchor,
    lastReconciledAtMs: numberValue(clock.lastReconciledAtMs, 'checkpoint.clocks.lastReconciledAtMs'),
  };
}

function readBudgets(value: unknown): BudgetCheckpointV1 {
  const budgets = readRecord(value, 'checkpoint.budgets');
  exactKeys(
    budgets,
    ['formattingCorrectionsRemaining', 'illegalMoveAttemptsRemaining', 'manualRetriesBySide'],
    'checkpoint.budgets',
  );
  const illegal = readRecord(budgets.illegalMoveAttemptsRemaining, 'checkpoint.budgets.illegalMoveAttemptsRemaining');
  const retries = readRecord(budgets.manualRetriesBySide, 'checkpoint.budgets.manualRetriesBySide');
  exactKeys(illegal, ['white', 'black'], 'checkpoint.budgets.illegalMoveAttemptsRemaining');
  exactKeys(retries, ['white', 'black'], 'checkpoint.budgets.manualRetriesBySide');
  return {
    formattingCorrectionsRemaining: nonNegativeIntegerValue(
      budgets.formattingCorrectionsRemaining,
      'checkpoint.budgets.formattingCorrectionsRemaining',
    ),
    illegalMoveAttemptsRemaining: {
      white: nonNegativeIntegerValue(illegal.white, 'checkpoint.budgets.illegalMoveAttemptsRemaining.white'),
      black: nonNegativeIntegerValue(illegal.black, 'checkpoint.budgets.illegalMoveAttemptsRemaining.black'),
    },
    manualRetriesBySide: {
      white: nonNegativeIntegerValue(retries.white, 'checkpoint.budgets.manualRetriesBySide.white'),
      black: nonNegativeIntegerValue(retries.black, 'checkpoint.budgets.manualRetriesBySide.black'),
    },
  };
}

function readPlayerSelection(value: unknown, path: string): PlayerSelectionV1 {
  const player = readRecord(value, path);
  const kind = enumValue(player.kind, ['human', 'model'] as const, `${path}.kind`);
  if (kind === 'human') {
    exactKeys(player, ['kind'], path);
    return { kind };
  }
  exactKeys(
    player,
    [
      'kind',
      'providerId',
      'connectionId',
      'configurationRevision',
      'modelRoutingId',
      'protocol',
      'diagnostic',
    ],
    path,
  );
  return {
    kind,
    providerId: stringValue(player.providerId, `${path}.providerId`),
    connectionId: nonEmptyString(player.connectionId, `${path}.connectionId`),
    configurationRevision: nonNegativeIntegerValue(player.configurationRevision, `${path}.configurationRevision`),
    modelRoutingId: nonEmptyString(player.modelRoutingId, `${path}.modelRoutingId`),
    protocol: enumValue(
      player.protocol,
      ['chat-completions', 'responses', 'messages', 'custom'] as const,
      `${path}.protocol`,
    ),
    diagnostic: enumValue(
      player.diagnostic,
      ['not-run', 'passed-current-session', 'failed', 'unknown'] as const,
      `${path}.diagnostic`,
    ),
  };
}

function readSelections(value: unknown): SelectionCheckpointV1 {
  const selection = readRecord(value, 'checkpoint.selections');
  exactKeys(selection, ['players'], 'checkpoint.selections');
  const players = readRecord(selection.players, 'checkpoint.selections.players');
  exactKeys(players, ['white', 'black'], 'checkpoint.selections.players');
  return {
    players: {
      white: readPlayerSelection(players.white, 'checkpoint.selections.players.white'),
      black: readPlayerSelection(players.black, 'checkpoint.selections.players.black'),
    },
  };
}

function readLineReference(value: unknown, path: string): ArchiveLineReferenceV1 {
  const line = readRecord(value, path);
  exactKeys(line, ['lineId', 'eventIds'], path);
  return {
    lineId: nonEmptyString(line.lineId, `${path}.lineId`),
    eventIds: readStringArray(line.eventIds, `${path}.eventIds`),
  };
}

function readDiscardedLine(value: unknown, path: string): DiscardedLineReferenceV1 {
  const line = readRecord(value, path);
  exactKeys(line, ['lineId', 'eventIds', 'discardedAtRevision', 'reason'], path);
  return {
    lineId: nonEmptyString(line.lineId, `${path}.lineId`),
    eventIds: readStringArray(line.eventIds, `${path}.eventIds`),
    discardedAtRevision: positiveIntegerValue(line.discardedAtRevision, `${path}.discardedAtRevision`),
    reason: enumValue(line.reason, ['undo', 'branch', 'replacement'] as const, `${path}.reason`),
  };
}

function readArchiveReferences(value: unknown): GameCheckpointV1['archive'] {
  const archive = readRecord(value, 'checkpoint.archive');
  exactKeys(archive, ['egressStatus', 'currentLine', 'discardedLines'], 'checkpoint.archive');
  if (!Array.isArray(archive.discardedLines)) fail('checkpoint.archive.discardedLines must be an array.');
  return {
    egressStatus: enumValue(
      archive.egressStatus,
      ['eligible', 'credential-echo-quarantined'] as const,
      'checkpoint.archive.egressStatus',
    ),
    currentLine: readLineReference(archive.currentLine, 'checkpoint.archive.currentLine'),
    discardedLines: archive.discardedLines.map((entry, index) =>
      readDiscardedLine(entry, `checkpoint.archive.discardedLines[${index}]`),
    ),
  };
}

function readResult(value: unknown): GameResultV1 {
  const result = readRecord(value, 'checkpoint.result');
  const kind = enumValue(result.kind, ['unresolved', 'pending-adjudication', 'final'] as const, 'checkpoint.result.kind');
  if (kind === 'unresolved') {
    exactKeys(result, ['kind'], 'checkpoint.result');
    return { kind };
  }
  if (kind === 'pending-adjudication') {
    exactKeys(result, ['kind', 'reason', 'eventId', 'eventAtMs', 'activeClockDeadlineMs'], 'checkpoint.result');
    return {
      kind,
      reason: enumValue(
        result.reason,
        ['checkmate', 'timeout', 'dead-position', 'threefold-repetition', 'fifty-move-rule'] as const,
        'checkpoint.result.reason',
      ),
      eventId: nonEmptyString(result.eventId, 'checkpoint.result.eventId'),
      eventAtMs: numberValue(result.eventAtMs, 'checkpoint.result.eventAtMs'),
      activeClockDeadlineMs: nullableNumber(
        result.activeClockDeadlineMs,
        'checkpoint.result.activeClockDeadlineMs',
      ),
    };
  }
  exactKeys(result, ['kind', 'winner', 'reason', 'eventId', 'decidedAtMs'], 'checkpoint.result');
  const winner = enumValue(result.winner, ['white', 'black', 'draw'] as const, 'checkpoint.result.winner');
  const reason = enumValue(
    result.reason,
    [
      'checkmate',
      'timeout',
      'dead-position',
      'threefold-repetition',
      'fifty-move-rule',
      'resignation',
      'illegal-move',
      'stalemate',
      'draw-agreement',
    ] as const,
    'checkpoint.result.reason',
  );
  if (reason === 'stalemate' || reason === 'draw-agreement') {
    if (winner !== 'draw') fail('checkpoint.result ' + reason + ' must have a draw winner.');
    return {
      kind,
      winner,
      reason,
      eventId: nonEmptyString(result.eventId, 'checkpoint.result.eventId'),
      decidedAtMs: numberValue(result.decidedAtMs, 'checkpoint.result.decidedAtMs'),
    };
  }
  return {
    kind,
    winner,
    reason,
    eventId: nonEmptyString(result.eventId, 'checkpoint.result.eventId'),
    decidedAtMs: numberValue(result.decidedAtMs, 'checkpoint.result.decidedAtMs'),
  };
}

function readPractice(value: unknown): PracticeCheckpointV1 {
  const practice = readRecord(value, 'checkpoint.practice');
  exactKeys(practice, ['mode', 'scored', 'sourceGameId', 'sourcePositionFen', 'originalResult'], 'checkpoint.practice');
  let originalResult: PracticeCheckpointV1['originalResult'] = null;
  if (practice.originalResult !== null) {
    const parsed = readResult(practice.originalResult);
    if (parsed.kind !== 'final') fail('checkpoint.practice.originalResult must be final or null.');
    originalResult = parsed;
  }
  if (typeof practice.scored !== 'boolean') fail('checkpoint.practice.scored must be a boolean.');
  return {
    mode: enumValue(practice.mode, ['ordinary', 'practice'] as const, 'checkpoint.practice.mode'),
    scored: practice.scored,
    sourceGameId: nullableString(practice.sourceGameId, 'checkpoint.practice.sourceGameId'),
    sourcePositionFen: nullableString(practice.sourcePositionFen, 'checkpoint.practice.sourcePositionFen'),
    originalResult,
  };
}

export function readGameCheckpoint(value: unknown): GameCheckpointV1 {
  const checkpoint = readRecord(value, 'checkpoint');
  exactKeys(
    checkpoint,
    [
      'schemaVersion',
      'gameId',
      'namespace',
      'revision',
      'ownershipEpoch',
      'segmentId',
      'positionRevision',
      'requestGeneration',
      'analysisGeneration',
      'updatedAtMs',
      'rules',
      'history',
      'clocks',
      'budgets',
      'selections',
      'archive',
      'result',
      'practice',
      'extensions',
    ],
    'checkpoint',
  );
  if (checkpoint.schemaVersion !== 1) fail('checkpoint.schemaVersion is unsupported.');
  return {
    schemaVersion: 1,
    gameId: nonEmptyString(checkpoint.gameId, 'checkpoint.gameId'),
    namespace: readGameNamespace(checkpoint.namespace, 'checkpoint.namespace'),
    revision: positiveIntegerValue(checkpoint.revision, 'checkpoint.revision'),
    ownershipEpoch: nonNegativeIntegerValue(checkpoint.ownershipEpoch, 'checkpoint.ownershipEpoch'),
    segmentId: nonEmptyString(checkpoint.segmentId, 'checkpoint.segmentId'),
    positionRevision: nonNegativeIntegerValue(checkpoint.positionRevision, 'checkpoint.positionRevision'),
    requestGeneration: nonNegativeIntegerValue(checkpoint.requestGeneration, 'checkpoint.requestGeneration'),
    analysisGeneration: nonNegativeIntegerValue(checkpoint.analysisGeneration, 'checkpoint.analysisGeneration'),
    updatedAtMs: numberValue(checkpoint.updatedAtMs, 'checkpoint.updatedAtMs'),
    rules: readRules(checkpoint.rules),
    history: readHistory(checkpoint.history),
    clocks: readClock(checkpoint.clocks),
    budgets: readBudgets(checkpoint.budgets),
    selections: readSelections(checkpoint.selections),
    archive: readArchiveReferences(checkpoint.archive),
    result: readResult(checkpoint.result),
    practice: readPractice(checkpoint.practice),
    extensions: readExtensionSections(checkpoint.extensions, 'checkpoint.extensions'),
  };
}

export function readArchiveEvent(value: unknown): ArchiveEventV1 {
  const event = readRecord(value, 'event');
  exactKeys(
    event,
    [
      'eventId',
      'gameId',
      'sequence',
      'segmentId',
      'kind',
      'occurredAtMs',
      'receiveState',
      'egressStatus',
      'payload',
      'chunkIds',
    ],
    'event',
  );
  return {
    eventId: nonEmptyString(event.eventId, 'event.eventId'),
    gameId: nonEmptyString(event.gameId, 'event.gameId'),
    sequence: nonNegativeIntegerValue(event.sequence, 'event.sequence'),
    segmentId: nonEmptyString(event.segmentId, 'event.segmentId'),
    kind: nonEmptyString(event.kind, 'event.kind'),
    occurredAtMs: numberValue(event.occurredAtMs, 'event.occurredAtMs'),
    receiveState: enumValue(event.receiveState, ['complete', 'partial'] as const, 'event.receiveState'),
    egressStatus: enumValue(
      event.egressStatus,
      ['eligible', 'credential-echo-quarantined'] as const,
      'event.egressStatus',
    ),
    payload: readJsonValue(event.payload, 'event.payload'),
    chunkIds: readStringArray(event.chunkIds, 'event.chunkIds'),
  };
}

export function readArchiveChunk(value: unknown): ArchiveChunkV1 {
  const chunk = readRecord(value, 'chunk');
  exactKeys(
    chunk,
    ['chunkId', 'gameId', 'sequence', 'receivedAtMs', 'isFinal', 'egressStatus', 'bytes', 'sha256'],
    'chunk',
  );
  if (!(chunk.bytes instanceof Uint8Array)) fail('chunk.bytes must be a Uint8Array.');
  if (typeof chunk.isFinal !== 'boolean') fail('chunk.isFinal must be a boolean.');
  return {
    chunkId: nonEmptyString(chunk.chunkId, 'chunk.chunkId'),
    gameId: nonEmptyString(chunk.gameId, 'chunk.gameId'),
    sequence: nonNegativeIntegerValue(chunk.sequence, 'chunk.sequence'),
    receivedAtMs: numberValue(chunk.receivedAtMs, 'chunk.receivedAtMs'),
    isFinal: chunk.isFinal,
    egressStatus: enumValue(
      chunk.egressStatus,
      ['eligible', 'credential-echo-quarantined'] as const,
      'chunk.egressStatus',
    ),
    bytes: new Uint8Array(chunk.bytes),
    sha256: stringValue(chunk.sha256, 'chunk.sha256'),
  };
}

function readExportChunk(value: unknown, index: number): ArchiveChunkExportV1 {
  const path = `archive.chunks[${index}]`;
  const chunk = readRecord(value, path);
  exactKeys(
    chunk,
    ['chunkId', 'gameId', 'sequence', 'receivedAtMs', 'isFinal', 'egressStatus', 'bytesBase64', 'sha256'],
    path,
  );
  if (typeof chunk.isFinal !== 'boolean') fail(`${path}.isFinal must be a boolean.`);
  const sha256 = stringValue(chunk.sha256, `${path}.sha256`);
  if (!/^[a-f0-9]{64}$/.test(sha256)) fail(`${path}.sha256 must be a lowercase SHA-256 digest.`);
  const bytesBase64 = stringValue(chunk.bytesBase64, `${path}.bytesBase64`);
  decodeBase64(bytesBase64);
  return {
    chunkId: nonEmptyString(chunk.chunkId, `${path}.chunkId`),
    gameId: nonEmptyString(chunk.gameId, `${path}.gameId`),
    sequence: nonNegativeIntegerValue(chunk.sequence, `${path}.sequence`),
    receivedAtMs: numberValue(chunk.receivedAtMs, `${path}.receivedAtMs`),
    isFinal: chunk.isFinal,
    egressStatus: enumValue(
      chunk.egressStatus,
      ['eligible', 'credential-echo-quarantined'] as const,
      `${path}.egressStatus`,
    ),
    bytesBase64,
    sha256,
  };
}

function requireSortedUnique(numbers: number[], path: string): void {
  for (let index = 1; index < numbers.length; index += 1) {
    const previous = numbers[index - 1];
    const current = numbers[index];
    if (previous === undefined || current === undefined || current <= previous) {
      fail(`${path} must be strictly ordered with no duplicate sequence numbers.`);
    }
  }
}

export function assertArchiveReferenceIntegrity(
  checkpoint: GameCheckpointV1,
  events: ArchiveEventV1[],
  chunks: ArchiveChunkV1[],
): void {
  const eventIds = new Set(events.map((event) => event.eventId));
  const chunkIds = new Set(chunks.map((chunk) => chunk.chunkId));
  if (eventIds.size !== events.length) fail('archive.events contains duplicate event IDs.');
  if (chunkIds.size !== chunks.length) fail('archive.chunks contains duplicate chunk IDs.');
  if (events.some((event) => event.gameId !== checkpoint.gameId)) fail('archive.events contains a different game ID.');
  if (chunks.some((chunk) => chunk.gameId !== checkpoint.gameId)) fail('archive.chunks contains a different game ID.');

  for (const event of events) {
    if (event.chunkIds.some((chunkId) => !chunkIds.has(chunkId))) {
      fail(`archive event ${event.eventId} references a missing raw chunk.`);
    }
    const eventChunks = event.chunkIds.map((chunkId) => chunks.find((chunk) => chunk.chunkId === chunkId)!);
    for (let index = 1; index < eventChunks.length; index += 1) {
      if (eventChunks[index]!.sequence <= eventChunks[index - 1]!.sequence) {
        fail(`archive event ${event.eventId} has chunks out of receive order.`);
      }
    }
    const lastChunk = eventChunks.at(-1);
    if (lastChunk && event.receiveState === 'complete' && !lastChunk.isFinal) {
      fail(`complete archive event ${event.eventId} is missing its final chunk marker.`);
    }
    if (lastChunk && event.receiveState === 'partial' && lastChunk.isFinal) {
      fail(`partial archive event ${event.eventId} has a final chunk marker.`);
    }
  }

  const referencedEventIds = [
    ...checkpoint.rules.moves.map((move) => move.eventId),
    ...checkpoint.history.messages.flatMap((message) => message.eventIds),
    ...checkpoint.archive.currentLine.eventIds,
    ...checkpoint.archive.discardedLines.flatMap((line) => line.eventIds),
  ];
  if (referencedEventIds.some((eventId) => !eventIds.has(eventId))) {
    fail('checkpoint references an event that is missing from the archive.');
  }
  const lineReferences = [checkpoint.archive.currentLine, ...checkpoint.archive.discardedLines];
  const lineIds = new Set(lineReferences.map((line) => line.lineId));
  if (lineIds.size !== lineReferences.length) fail('checkpoint.archive contains duplicate line IDs.');
  const linesById = new Map(lineReferences.map((line) => [line.lineId, line]));
  const discardedLineIds = new Set(checkpoint.archive.discardedLines.map((line) => line.lineId));
  for (const message of checkpoint.history.messages) {
    const line = linesById.get(message.lineId);
    if (!line) fail(`history message ${message.messageId} references a missing line.`);
    const isDiscardedLine = discardedLineIds.has(message.lineId);
    if ((message.disposition === 'discarded') !== isDiscardedLine) {
      fail(`history message ${message.messageId} disposition does not match its line.`);
    }
    const lineEventIds = new Set(line.eventIds);
    if (message.eventIds.some((eventId) => !lineEventIds.has(eventId))) {
      fail(`history message ${message.messageId} references an event outside its line.`);
    }
  }
  const anyQuarantined =
    events.some((event) => event.egressStatus === 'credential-echo-quarantined') ||
    chunks.some((chunk) => chunk.egressStatus === 'credential-echo-quarantined');
  if (anyQuarantined && checkpoint.archive.egressStatus !== 'credential-echo-quarantined') {
    fail('checkpoint.archive is missing the persisted egress quarantine marker.');
  }

  const eventSequences = events.map((event) => event.sequence);
  const chunkSequences = chunks.map((chunk) => chunk.sequence);
  requireSortedUnique(eventSequences, 'archive.events');
  requireSortedUnique(chunkSequences, 'archive.chunks');
}

export async function readGameArchive(value: unknown): Promise<GameArchiveExportV1> {
  const archive = readRecord(value, 'archive');
  exactKeys(archive, ['format', 'schemaVersion', 'exportedAtMs', 'checkpoint', 'events', 'chunks'], 'archive');
  if (archive.format !== 'kamkmchess.game-archive' || archive.schemaVersion !== 1) {
    fail('The archive format or schema version is unsupported.');
  }
  if (!Array.isArray(archive.events) || !Array.isArray(archive.chunks)) {
    fail('archive.events and archive.chunks must be arrays.');
  }
  const checkpoint = readGameCheckpoint(archive.checkpoint);
  const events = archive.events.map((event) => readArchiveEvent(event));
  const exportedChunks = archive.chunks.map((chunk, index) => readExportChunk(chunk, index));
  if (events.some((event, index) => index > 0 && event.sequence <= events[index - 1]!.sequence)) {
    fail('archive.events must be ordered by sequence.');
  }
  if (exportedChunks.some((chunk, index) => index > 0 && chunk.sequence <= exportedChunks[index - 1]!.sequence)) {
    fail('archive.chunks must be ordered by sequence.');
  }
  const chunks: ArchiveChunkV1[] = await Promise.all(
    exportedChunks.map(async (chunk) => {
      const bytes = decodeBase64(chunk.bytesBase64);
      if ((await sha256Hex(bytes)) !== chunk.sha256) fail(`Raw chunk ${chunk.chunkId} failed its digest check.`);
      return {
        chunkId: chunk.chunkId,
        gameId: chunk.gameId,
        sequence: chunk.sequence,
        receivedAtMs: chunk.receivedAtMs,
        isFinal: chunk.isFinal,
        egressStatus: chunk.egressStatus,
        bytes,
        sha256: chunk.sha256,
      };
    }),
  );
  assertArchiveReferenceIntegrity(checkpoint, events, chunks);
  return {
    format: 'kamkmchess.game-archive',
    schemaVersion: 1,
    exportedAtMs: numberValue(archive.exportedAtMs, 'archive.exportedAtMs'),
    checkpoint,
    events,
    chunks: exportedChunks,
  };
}

export async function verifyChunkDigest(chunk: ArchiveChunkV1): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(chunk.sha256) || (await sha256Hex(chunk.bytes)) !== chunk.sha256) {
    fail(`Raw chunk ${chunk.chunkId} failed its digest check.`);
  }
}
