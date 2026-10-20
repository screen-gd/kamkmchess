import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openGameStore } from '../storage/index.js';
import {
  checkProofEvidence,
  PROOF_CHECKER_VERSION,
  RULES_ADAPTER_VERSION,
} from '../proofs/index.js';
import type { ProofEvidence, ProofQuery, ProofSearchPassResult } from '../proofs/index.js';
import type { CoordinateMove } from '../rules/index.js';
import type { ClockComparisonPolicy } from '../clocks/index.js';
import {
  createRematchSetup,
  createRestartSetup,
  getOrCreateGameController,
} from './index.js';
import type { ControllerSnapshotV1, GameControllerSetupV1, ModelSelection } from './index.js';

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const model: ModelSelection = {
  kind: 'model',
  providerId: 'openrouter',
  connectionId: 'connection-primary',
  configurationRevision: 7,
  modelRoutingId: 'My/Model:latest',
  protocol: 'chat-completions',
  diagnostic: 'passed-current-session',
};

/**
 * Short cooperative mating lines, each ending in checkmate by the stated color. The
 * controller re-checks every submitted witness, so a fixture that no longer applies is
 * detected and the caller falls back to the real proof search.
 */
const matingFixtures: ReadonlyArray<{ prefix: string; intendedColor: 'w' | 'b'; moves: CoordinateMove[] }> = [
  {
    prefix: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -', intendedColor: 'b',
    moves: [{ from: 'f2', to: 'f3' }, { from: 'e7', to: 'e5' }, { from: 'g2', to: 'g4' }, { from: 'd8', to: 'h4' }],
  },
  {
    prefix: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3', intendedColor: 'w',
    moves: [
      { from: 'a7', to: 'a6' },
      { from: 'f1', to: 'c4' },
      { from: 'a6', to: 'a5' },
      { from: 'd1', to: 'h5' },
      { from: 'a5', to: 'a4' },
      { from: 'h5', to: 'f7' },
    ],
  },
  {
    prefix: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6', intendedColor: 'w',
    moves: [
      { from: 'f1', to: 'c4' },
      { from: 'b8', to: 'c6' },
      { from: 'd1', to: 'h5' },
      { from: 'g8', to: 'f6' },
      { from: 'h5', to: 'f7' },
    ],
  },
  {
    prefix: 'rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR b KQkq -', intendedColor: 'b',
    moves: [{ from: 'e7', to: 'e5' }, { from: 'g2', to: 'g4' }, { from: 'd8', to: 'h4' }],
  },
  {
    prefix: 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq e6', intendedColor: 'b',
    moves: [{ from: 'g2', to: 'g4' }, { from: 'd8', to: 'h4' }],
  },
  {
    prefix: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P1/RNBQKBNR b KQkq g3', intendedColor: 'b',
    moves: [{ from: 'd8', to: 'h4' }],
  },
];

/**
 * Returns checked evidence for the query. A matching short fixture keeps the suite fast and
 * offline; anything else falls back to the cooperative proof search the product uses.
 */
async function checkedEvidence(query: ProofQuery): Promise<ProofSearchPassResult> {
  const requiredColor = query.predicate === 'timeout-opponent-mating'
    ? query.expiredColor === 'w' ? 'b' : 'w'
    : null;
  const fixture = matingFixtures.find((item) =>
    query.positionFen.startsWith(item.prefix) && (requiredColor === null || item.intendedColor === requiredColor));
  if (fixture !== undefined) {
    const evidence: ProofEvidence = {
      schemaVersion: 1,
      proofCheckerVersion: PROOF_CHECKER_VERSION,
      rulesAdapterVersion: RULES_ADAPTER_VERSION,
      queryIdentity: query.queryIdentity,
      kind: 'mate-witness',
      intendedColor: fixture.intendedColor,
      moves: fixture.moves.map((move) => ({ ...move })),
    };
    const checked = checkProofEvidence(query, evidence);
    if (checked.status === 'accepted') {
      return {
        status: 'accepted',
        conclusion: checked.conclusion,
        queryIdentity: query.queryIdentity,
        evidence,
        checkpointDisposition: 'fresh',
        pass: {
          maxDiscoveredStates: 0,
          timeBudgetMs: 0,
          discoveredStateCount: 0,
          processedEdgeCount: 0,
          expandedStateCount: 0,
          totalDiscoveredStateCount: 0,
          totalDiscoveredEdgeCount: 0,
          elapsedMs: 0,
        },
      };
    }
  }
  throw new Error(`No mating fixture covers ${query.predicate} at ${query.positionFen}.`);
}

const NO_CLOCK_DRIFT: ClockComparisonPolicy = { maxReferenceDivergenceMs: 0 };

const STANDARD_TIME_CONTROL = { startingTimeMs: 60_000, incrementMs: 3_000 };
const SHORT_TIME_CONTROL = { startingTimeMs: 30_000, incrementMs: 3_000 };

interface Harness {
  readonly controller: ReturnType<typeof getOrCreateGameController>;
  readonly store: Awaited<ReturnType<typeof openGameStore>>;
  readonly gameId: string;
  advance(ms: number): void;
}

async function createHarness(gameId: string): Promise<Harness> {
  let decisionTimeMs = 1_000;
  let monotonicMs = 5_000;
  const store = await openGameStore({
    databaseName: gameId,
    factory: new IDBFactory(),
    now: () => decisionTimeMs,
  });
  let generatedId = 0;
  const harness: Harness = {
    gameId,
    store,
    controller: getOrCreateGameController({ positionChecks: 'legacy-proof',
      gameId,
      store,
      timeSource: {
        sample(atDecisionTimeMs) {
          return { monotonicMs, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs };
        },
      },
      clockPolicy: NO_CLOCK_DRIFT,
      idFactory: () => `${gameId}-id-${++generatedId}`,
    }),
    advance(ms) {
      decisionTimeMs += ms;
      monotonicMs += ms;
    },
  };
  return harness;
}

async function initializePlayable(harness: Harness, setup: GameControllerSetupV1): Promise<ControllerSnapshotV1> {
  const initialized = await harness.controller.initialize(setup);
  const classified = initialized.adjudication.status === 'queued'
    ? await settlePending(harness, initialized)
    : initialized;
  if (classified.adjudication.status !== 'setup-ready') return classified;
  return harness.controller.startGame(classified.fence, setup.modelSelection);
}

/** Runs the explicit adjudication passes until the controller stops waiting for a proof. */
async function settlePending(
  harness: Harness,
  snapshot: ControllerSnapshotV1,
  evidence: (query: ProofQuery) => Promise<ProofSearchPassResult> = checkedEvidence,
): Promise<ControllerSnapshotV1> {
  let current = snapshot;
  const waiting = (value: ControllerSnapshotV1) =>
    value.adjudication.status !== 'none' && value.adjudication.status !== 'setup-ready';
  for (let pass = 0; pass < 8 && waiting(current); pass += 1) {
    const work = await harness.controller.continueAdjudication(current.fence);
    if (work === null) throw new Error('The pending adjudication did not start.');
    current = await harness.controller.acceptAdjudicationResult({
      requestId: work.requestId,
      fence: work.fence,
      query: work.query,
      result: await evidence(work.query),
    });
  }
  return current;
}

/** Plays the human move followed by the model reply, settling the exact check after each move. */
async function playRound(harness: Harness): Promise<ControllerSnapshotV1> {
  let state = harness.controller.snapshot();
  const humanMove = await harness.controller.dispatch({
    schemaVersion: 1,
    kind: 'human-move',
    fence: state.fence,
    move: { from: 'e2', to: 'e4' },
  });
  if (humanMove.kind !== 'accepted') throw new Error(`The human move was not accepted: ${humanMove.kind}.`);
  state = await settlePending(harness, humanMove.snapshot);
  const started = await harness.controller.dispatch({
    schemaVersion: 1,
    kind: 'begin-model-turn',
    fence: state.fence,
  });
  if (started.kind !== 'model-turn-started') throw new Error(`The model turn did not start: ${started.kind}.`);
  const modelMove = await harness.controller.dispatch({
    schemaVersion: 1,
    kind: 'model-move',
    fence: started.request.fence,
    move: { from: 'e7', to: 'e5' },
  });
  if (modelMove.kind !== 'accepted') throw new Error(`The model move was not accepted: ${modelMove.kind}.`);
  return settlePending(harness, modelMove.snapshot);
}

/** Reaches a final loss on time for the model opponent with the human on the other side. */
async function loseOnTime(harness: Harness): Promise<ControllerSnapshotV1> {
  const started = await initializePlayable(harness, {
    humanSide: 'black',
    modelSelection: model,
    namespace: { kind: 'guest' },
    ownershipEpoch: 0,
    timeControl: SHORT_TIME_CONTROL,
  });
  if (started.checkpoint.result.kind !== 'unresolved') {
    throw new Error(`The game should be running before the model flag, not ${started.checkpoint.result.kind}.`);
  }
  const turn = await harness.controller.dispatch({
    schemaVersion: 1,
    kind: 'begin-model-turn',
    fence: harness.controller.snapshot().fence,
  });
  if (turn.kind !== 'model-turn-started') throw new Error('The model turn did not start.');
  harness.advance(31_000);
  const expired = await harness.controller.dispatch({
    schemaVersion: 1,
    kind: 'model-move',
    fence: turn.request.fence,
    move: { from: 'e2', to: 'e4' },
  });
  if (expired.kind !== 'expired') throw new Error(`The late model move was not expired: ${expired.kind}.`);
  return settlePending(harness, expired.snapshot);
}

describe('guest lifecycle undo', () => {
  it('restores the previous human decision and keeps the discarded line in the archive', async () => {
    const harness = await createHarness('lifecycle-undo-restores-decision');
    try {
      const initial = await initializePlayable(harness, {
        humanSide: 'white',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: STANDARD_TIME_CONTROL,
      });
      const played = await playRound(harness);
      expect(played.checkpoint.rules.moves).toHaveLength(2);
      const discardedLineId = played.checkpoint.archive.currentLine.lineId;
      const discardedEventIds = [...played.checkpoint.archive.currentLine.eventIds];
      const positionRevision = played.checkpoint.positionRevision;
      const requestGeneration = played.checkpoint.requestGeneration;

      const undone = await harness.controller.undo(harness.controller.snapshot().fence);

      expect(undone.checkpoint.rules.moves).toHaveLength(0);
      expect(undone.checkpoint.rules.currentFen).toBe(STARTING_FEN);
      expect(undone.position.fen).toBe(STARTING_FEN);
      expect(undone.checkpoint.rules.repetitionLedger).toEqual(initial.checkpoint.rules.repetitionLedger);
      expect(undone.checkpoint.rules.repetitionLedger.positions).toHaveLength(1);
      expect(undone.checkpoint.rules.repetitionLedger.positions[0]?.occurrences).toBe('1');
      expect(undone.checkpoint.result).toEqual({ kind: 'unresolved' });
      expect(undone.checkpoint.archive.currentLine.lineId).not.toBe(discardedLineId);
      expect(undone.checkpoint.archive.discardedLines).toEqual([
        { lineId: discardedLineId, eventIds: discardedEventIds, discardedAtRevision: played.checkpoint.revision + 1, reason: 'undo' },
      ]);
      expect(undone.checkpoint.positionRevision).toBeGreaterThan(positionRevision);
      expect(undone.checkpoint.requestGeneration).toBeGreaterThan(requestGeneration);

      const saved = await harness.store.readGame(harness.gameId);
      expect(saved?.checkpoint.revision).toBe(undone.checkpoint.revision);
      expect(saved?.checkpoint.rules.moves).toHaveLength(0);
      const savedKinds = (saved?.events ?? []).map((event) => event.kind);
      expect(savedKinds).toContain('human-move-accepted');
      expect(savedKinds).toContain('model-move-accepted');
      expect(savedKinds).toContain('undo-accepted');
    } finally {
      harness.store.close();
    }
  });

  it('is unavailable before the first human decision', async () => {
    const harness = await createHarness('lifecycle-undo-unavailable');
    try {
      const initial = await initializePlayable(harness, {
        humanSide: 'white',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: STANDARD_TIME_CONTROL,
      });
      const undone = await harness.controller.undo(harness.controller.snapshot().fence);

      expect(undone.checkpoint.revision).toBe(initial.checkpoint.revision);
      expect(undone.checkpoint.rules.moves).toHaveLength(0);
      expect(undone.checkpoint.archive.discardedLines).toHaveLength(0);
    } finally {
      harness.store.close();
    }
  });

  it('charges elapsed time, removes only undone increments and resumes the human clock', async () => {
    const harness = await createHarness('lifecycle-undo-clock');
    try {
      const initial = await initializePlayable(harness, {
        humanSide: 'white',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: STANDARD_TIME_CONTROL,
      });
      expect(initial.checkpoint.clocks.banksAtAnchor).toEqual({ whiteMs: 60_000, blackMs: 60_000 });
      const played = await playRound(harness);
      expect(played.checkpoint.clocks.banksAtAnchor).toEqual({ whiteMs: 63_000, blackMs: 63_000 });
      expect(played.checkpoint.clocks.activeSide).toBe('white');

      harness.advance(5_000);
      const undone = await harness.controller.undo(harness.controller.snapshot().fence);

      expect(undone.checkpoint.clocks.banksAtAnchor).toEqual({ whiteMs: 55_000, blackMs: 60_000 });
      expect(undone.checkpoint.clocks.activeSide).toBe('white');
      expect(undone.clockReading).toMatchObject({ status: 'running', elapsedMs: 0 });
    } finally {
      harness.store.close();
    }
  });

  it('rejects an undo that would leave a clock bank nonpositive', async () => {
    const harness = await createHarness('lifecycle-undo-nonpositive');
    try {
      await initializePlayable(harness, {
        humanSide: 'white',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: { startingTimeMs: 30_000, incrementMs: 10_000 },
      });
      const played = await playRound(harness);
      harness.advance(35_000);

      const undone = await harness.controller.undo(harness.controller.snapshot().fence);

      expect(undone.checkpoint.revision).toBe(played.checkpoint.revision);
      expect(undone.checkpoint.rules.moves).toHaveLength(2);
      expect(undone.checkpoint.clocks.banksAtAnchor).toEqual({ whiteMs: 40_000, blackMs: 40_000 });
    } finally {
      harness.store.close();
    }
  });

  it('serializes an undo behind queued controller work', async () => {
    const harness = await createHarness('lifecycle-undo-serialized');
    try {
      await initializePlayable(harness, {
        humanSide: 'white',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: STANDARD_TIME_CONTROL,
      });
      await playRound(harness);
      const fence = harness.controller.snapshot().fence;

      const [undone, moved] = await Promise.all([
        harness.controller.undo(fence),
        harness.controller.dispatch({ schemaVersion: 1, kind: 'human-move', fence, move: { from: 'd2', to: 'd4' } }),
      ]);

      expect(moved.kind).toBe('rejected');
      expect(undone.checkpoint.rules.moves).toHaveLength(0);
      const saved = await harness.store.readGame(harness.gameId);
      expect(saved?.checkpoint.revision).toBe(undone.checkpoint.revision);
    } finally {
      harness.store.close();
    }
  });
});

describe('guest lifecycle practice', () => {
  it('starts an unscored timed segment that preserves rules and the original loss', async () => {
    const harness = await createHarness('lifecycle-practice-segment');
    try {
      const lost = await loseOnTime(harness);
      expect(lost.checkpoint.result).toMatchObject({ kind: 'final', winner: 'black', reason: 'timeout' });
      const finalPositionFen = lost.checkpoint.rules.currentFen;
      const finalLineId = lost.checkpoint.archive.currentLine.lineId;
      const finalSegmentId = lost.checkpoint.segmentId;
      const originalResult = lost.checkpoint.result;

      const practice = await harness.controller.startPractice(harness.controller.snapshot().fence, model);

      expect(practice.checkpoint.result).toEqual({ kind: 'unresolved' });
      expect(practice.checkpoint.practice).toMatchObject({
        mode: 'practice',
        scored: false,
        sourceGameId: harness.gameId,
        sourcePositionFen: finalPositionFen,
        originalResult,
      });
      expect(practice.checkpoint.rules.currentFen).toBe(finalPositionFen);
      expect(practice.checkpoint.rules.halfmoveClock).toBe(lost.checkpoint.rules.halfmoveClock);
      expect(practice.checkpoint.segmentId).not.toBe(finalSegmentId);
      expect(practice.checkpoint.history.currentSegmentId).toBe(practice.checkpoint.segmentId);
      expect(practice.checkpoint.history.segments).toHaveLength(lost.checkpoint.history.segments.length + 1);
      expect(practice.checkpoint.archive.currentLine.lineId).not.toBe(finalLineId);
      expect(practice.checkpoint.archive.discardedLines.at(-1)).toMatchObject({ lineId: finalLineId, reason: 'branch' });
      expect(practice.checkpoint.clocks.banksAtAnchor).toEqual({ whiteMs: 30_000, blackMs: 30_000 });
      expect(practice.checkpoint.clocks.activeSide).toBe('white');
      expect(practice.checkpoint.budgets).toEqual({
        formattingCorrectionsRemaining: 3,
        illegalMoveAttemptsRemaining: { white: 4, black: 4 },
        manualRetriesBySide: { white: 0, black: 0 },
      });

      const saved = await harness.store.readGame(harness.gameId);
      expect(saved?.checkpoint.practice.mode).toBe('practice');
      expect(saved?.events.at(-1)?.kind).toBe('practice-started');
    } finally {
      harness.store.close();
    }
  });

  it('does not start practice before a final model loss', async () => {
    const harness = await createHarness('lifecycle-practice-unresolved');
    try {
      const initial = await initializePlayable(harness, {
        humanSide: 'white',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: STANDARD_TIME_CONTROL,
      });
      expect(initial.checkpoint.result).toEqual({ kind: 'unresolved' });
      const practice = await harness.controller.startPractice(harness.controller.snapshot().fence, model);

      expect(practice.checkpoint.revision).toBe(initial.checkpoint.revision);
      expect(practice.checkpoint.practice.mode).toBe('ordinary');
      expect(practice.checkpoint.result).toEqual({ kind: 'unresolved' });
    } finally {
      harness.store.close();
    }
  });

  it('keeps undo inside the practice segment and never restores the lost game', async () => {
    const harness = await createHarness('lifecycle-practice-undo-boundary');
    try {
      const lost = await loseOnTime(harness);
      const practice = await harness.controller.startPractice(harness.controller.snapshot().fence, model);
      expect(practice.checkpoint.practice.mode).toBe('practice');

      const crossed = await harness.controller.undo(harness.controller.snapshot().fence);
      expect(crossed.checkpoint.revision).toBe(practice.checkpoint.revision);
      expect(crossed.checkpoint.practice.mode).toBe('practice');
      expect(crossed.checkpoint.result).toEqual({ kind: 'unresolved' });
      expect(crossed.checkpoint.practice.originalResult).toEqual(lost.checkpoint.result);
    } finally {
      harness.store.close();
    }
  });
});

describe('guest lifecycle restart and rematch', () => {
  it('prepares a separate game that keeps the previous game and its clock intact', async () => {
    const harness = await createHarness('lifecycle-restart');
    try {
      await initializePlayable(harness, {
        humanSide: 'white',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: STANDARD_TIME_CONTROL,
      });
      const played = await playRound(harness);
      harness.advance(4_000);

      const next = await createHarness('lifecycle-restart-rematch');
      try {
        const prepared = createRestartSetup(played);
        const classified = await settlePending(next, await next.controller.initialize(prepared));
        const restarted = classified.adjudication.status === 'setup-ready'
          ? await next.controller.startGame(classified.fence, prepared.modelSelection)
          : classified;
        expect(restarted.checkpoint.gameId).toBe(next.gameId);
        expect(restarted.checkpoint.gameId).not.toBe(played.checkpoint.gameId);
        expect(restarted.checkpoint.result).toEqual({ kind: 'unresolved' });
        expect(restarted.checkpoint.clocks.activeSide).toBe('white');
        expect(restarted.checkpoint.practice).toMatchObject({ mode: 'ordinary', scored: true });
        expect(restarted.checkpoint.rules.currentFen).toBe(STARTING_FEN);
        expect(restarted.checkpoint.selections.players.white).toMatchObject({ kind: 'human' });
        expect(restarted.checkpoint.selections.players.black).toMatchObject({
          kind: 'model',
          providerId: model.providerId,
          modelRoutingId: model.modelRoutingId,
        });

        const stillRunning = harness.controller.snapshot();
        expect(stillRunning.checkpoint.rules.moves).toHaveLength(2);
        expect(stillRunning.clockReading).toMatchObject({ status: 'running', elapsedMs: 4_000 });
        const saved = await harness.store.readGame(harness.gameId);
        expect(saved?.checkpoint.rules.moves).toHaveLength(2);
      } finally {
        next.store.close();
      }
    } finally {
      harness.store.close();
    }
  });

  it('swaps colors for a rematch while keeping the position and model', async () => {
    const harness = await createHarness('lifecycle-rematch-setup');
    try {
      await initializePlayable(harness, {
        humanSide: 'white',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: STANDARD_TIME_CONTROL,
      });
      const played = await playRound(harness);
      const restart = createRestartSetup(played);
      const rematch = createRematchSetup(played);

      expect(restart.humanSide).toBe('white');
      expect(rematch.humanSide).toBe('black');
      expect(rematch.modelSelection!.modelRoutingId).toBe(restart.modelSelection!.modelRoutingId);
      expect(rematch.startingFen).toBe(restart.startingFen);
      expect(rematch.timeControl).toEqual(restart.timeControl);

      const next = await createHarness('lifecycle-rematch-game');
      try {
        const rematched = await next.controller.initialize(rematch);
        expect(rematched.checkpoint.selections.players.black).toMatchObject({ kind: 'human' });
        expect(rematched.checkpoint.selections.players.white).toMatchObject({
          kind: 'model',
          modelRoutingId: model.modelRoutingId,
        });
        expect(rematched.checkpoint.revision).toBeLessThan(played.checkpoint.revision + 1);
        expect(rematched.checkpoint.rules.moves).toHaveLength(0);
      } finally {
        next.store.close();
      }
      expect(harness.controller.snapshot().checkpoint.rules.moves).toHaveLength(2);
    } finally {
      harness.store.close();
    }
  });
});

describe('guest lifecycle declared results', () => {
  it('persists an agreed draw, pauses the clocks, and refuses to undo the final result', async () => {
    const harness = await createHarness('lifecycle-declare-draw');
    try {
      const started = await initializePlayable(harness, {
        humanSide: 'white',
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: STANDARD_TIME_CONTROL,
      });
      expect(started.checkpoint.selections.players).toEqual({ white: { kind: 'human' }, black: { kind: 'human' } });

      const declared = await harness.controller.declareResult(started.fence, { kind: 'draw' });
      expect(declared.kind).toBe('accepted');
      const result = declared.snapshot.checkpoint.result;
      expect(result).toMatchObject({ kind: 'final', winner: 'draw', reason: 'draw-agreement' });
      expect(declared.snapshot.checkpoint.clocks.activeSide).toBeNull();
      expect(declared.snapshot.clockReading).toBeNull();
      expect(declared.snapshot.position.fen).toBe(STARTING_FEN);
      expect(declared.snapshot.checkpoint.rules.moves).toHaveLength(0);

      const saved = await harness.store.readGame(harness.gameId);
      expect(saved?.checkpoint.result).toMatchObject({ kind: 'final', winner: 'draw', reason: 'draw-agreement' });
      expect(saved?.checkpoint.clocks.activeSide).toBeNull();
      expect(saved?.events.map((event) => event.kind)).toContain('game-declared-final');

      const undone = await harness.controller.undo(declared.snapshot.fence);
      expect(undone.checkpoint.revision).toBe(declared.snapshot.checkpoint.revision);
      expect(undone.checkpoint.result).toEqual(result);
      expect(undone.position.fen).toBe(STARTING_FEN);
    } finally {
      harness.store.close();
    }
  });

  it('records a human resignation and fences late model moves and archive writes', async () => {
    const harness = await createHarness('lifecycle-declare-resignation');
    try {
      const initial = await initializePlayable(harness, {
        humanSide: 'white',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: STANDARD_TIME_CONTROL,
      });
      const humanMove = await harness.controller.dispatch({
        schemaVersion: 1,
        kind: 'human-move',
        fence: initial.fence,
        move: { from: 'e2', to: 'e4' },
      });
      if (humanMove.kind !== 'accepted') throw new Error(`The human move was not accepted: ${humanMove.kind}.`);
      const settled = await settlePending(harness, humanMove.snapshot);
      const started = await harness.controller.dispatch({
        schemaVersion: 1,
        kind: 'begin-model-turn',
        fence: settled.fence,
      });
      if (started.kind !== 'model-turn-started') throw new Error('The model turn did not start.');

      const declared = await harness.controller.declareResult(started.request.fence, {
        kind: 'resignation',
        side: 'white',
      });
      expect(declared.kind).toBe('accepted');
      const result = declared.snapshot.checkpoint.result;
      expect(result).toMatchObject({ kind: 'final', winner: 'black', reason: 'resignation' });
      expect(declared.snapshot.checkpoint.clocks.activeSide).toBeNull();
      expect(declared.snapshot.modelHandoff).toMatchObject({ producing: null, queued: null });
      expect(declared.snapshot.checkpoint.rules.moves).toHaveLength(1);

      const lateMove = await harness.controller.dispatch({
        schemaVersion: 1,
        kind: 'model-turn-effect',
        fence: started.request.fence,
        effect: {
          kind: 'model-resignation',
          statement: 'I resign.',
          loss: { winner: 'human', reason: 'resignation' },
          budgets: {
            schemaVersion: 1,
            illegalMoveAttempts: 0,
            formatCorrections: 0,
            manualRetries: 0,
            attemptRecords: [],
          },
        },
      });
      expect(lateMove.kind).toBe('rejected');
      expect(lateMove.snapshot.checkpoint.result).toEqual(result);
      expect(lateMove.snapshot.checkpoint.rules.moves).toHaveLength(1);

      const lateArchive = await harness.controller.appendModelTurnArchive(started.request.fence, {
        kind: 'terminal',
        requestId: 'late-request',
        outcome: 'complete',
        details: {},
        messages: [],
      });
      expect(lateArchive).toBeNull();

      const saved = await harness.store.readGame(harness.gameId);
      expect(saved?.checkpoint.result).toMatchObject({ kind: 'final', winner: 'black', reason: 'resignation' });
      expect(saved?.checkpoint.rules.moves).toHaveLength(1);
      expect(saved?.events.map((event) => event.kind)).toContain('game-declared-final');

      const undone = await harness.controller.undo(declared.snapshot.fence);
      expect(undone.checkpoint.result).toEqual(result);
      expect(undone.checkpoint.rules.moves).toHaveLength(1);
    } finally {
      harness.store.close();
    }
  });

  it('rejects stale fences, automated draws, and non-human resignation sides', async () => {
    const hotseat = await createHarness('lifecycle-declare-stale');
    try {
      const started = await initializePlayable(hotseat, {
        humanSide: 'white',
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: STANDARD_TIME_CONTROL,
      });
      const stale = await hotseat.controller.declareResult(
        { ...started.fence, revision: started.fence.revision + 1 },
        { kind: 'draw' },
      );
      expect(stale.kind).toBe('rejected');
      expect(stale.kind === 'rejected' && stale.reason).toBe('stale-fence');
      expect(stale.snapshot.checkpoint.result).toEqual({ kind: 'unresolved' });
    } finally {
      hotseat.store.close();
    }

    const spectator = await createHarness('lifecycle-declare-automated');
    try {
      const started = await initializePlayable(spectator, {
        humanSide: 'white',
        players: { white: model, black: model },
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: STANDARD_TIME_CONTROL,
      });
      const draw = await spectator.controller.declareResult(started.fence, { kind: 'draw' });
      expect(draw.kind).toBe('rejected');
      expect(draw.kind === 'rejected' && draw.reason).toBe('not-actionable');
      const resignation = await spectator.controller.declareResult(started.fence, {
        kind: 'resignation',
        side: 'white',
      });
      expect(resignation.kind).toBe('rejected');
      expect(resignation.kind === 'rejected' && resignation.reason).toBe('wrong-side');
      expect(spectator.controller.snapshot().checkpoint.result).toEqual({ kind: 'unresolved' });
    } finally {
      spectator.store.close();
    }
  });
});
