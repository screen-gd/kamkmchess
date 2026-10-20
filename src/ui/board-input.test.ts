import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openGameStore } from '../storage/index.js';
import { getOrCreateGameController } from '../controller/index.js';
import { checkProofEvidence, PROOF_CHECKER_VERSION, RULES_ADAPTER_VERSION } from '../proofs/index.js';
import type { ProofEvidence } from '../proofs/index.js';
import { parsePosition } from '../rules/index.js';
import { checkedColor, isLocalBoardInputDisabled, parseCoordinateMove, startClassifiedLocalGame, submitBoardMove } from './board-input.js';

describe('checkedColor', () => {
  it('names the side to move only when its king is attacked', () => {
    expect(checkedColor(parsePosition('4k3/8/8/8/8/8/4r3/4K3 w - - 0 1'))).toBe('white');
    expect(checkedColor(parsePosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'))).toBeUndefined();
  });
});

describe('board input to controller seam', () => {
  it('parses coordinate entry and commits white and black moves through the game controller', async () => {
    expect(parseCoordinateMove(' e2e4 ')).toEqual({ from: 'e2', to: 'e4' });
    expect(parseCoordinateMove('a7a8')).toEqual({ from: 'a7', to: 'a8' });
    expect(parseCoordinateMove('a7a8n')).toEqual({ from: 'a7', to: 'a8', promotion: 'n' });
    expect(parseCoordinateMove('e9e4')).toBeNull();

    const gameId = 'ui-board-input-controller-seam';
    const store = await openGameStore({ databaseName: gameId, factory: new IDBFactory(), now: () => 1_000 });
    let sequence = 0;
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
      gameId,
      store,
      timeSource: { sample: (decisionTimeMs) => ({ monotonicMs: 5_000, wallTimeMs: decisionTimeMs ?? 1_000 }) },
      clockPolicy: { maxReferenceDivergenceMs: 5 },
      idFactory: () => gameId + '-' + (++sequence),
    });
    try {
      const initial = await controller.initialize({
        humanSide: 'white',
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
      });
      expect(isLocalBoardInputDisabled(initial, false)).toBe(true);
      const beforeClassification = await startClassifiedLocalGame(controller, initial);
      expect(beforeClassification.checkpoint.clocks.activeSide).toBeNull();
      expect(initial.checkpoint.selections.players).toEqual({
        white: { kind: 'human' },
        black: { kind: 'human' },
      });
      const work = await controller.continueAdjudication(initial.fence);
      if (!work) throw new Error('The standard position did not enter setup classification.');
      const evidence: ProofEvidence = {
        schemaVersion: 1,
        proofCheckerVersion: PROOF_CHECKER_VERSION,
        rulesAdapterVersion: RULES_ADAPTER_VERSION,
        queryIdentity: work.query.queryIdentity,
        kind: 'mate-witness',
        intendedColor: 'b',
        moves: [
          { from: 'f2', to: 'f3' },
          { from: 'e7', to: 'e5' },
          { from: 'g2', to: 'g4' },
          { from: 'd8', to: 'h4' },
        ],
      };
      const checked = checkProofEvidence(work.query, evidence);
      if (checked.status !== 'accepted') throw new Error('The fixture witness was not accepted by the proof checker.');
      const ready = await controller.acceptAdjudicationResult({
        requestId: work.requestId,
        fence: work.fence,
        query: work.query,
        result: {
          status: 'accepted',
          conclusion: checked.conclusion,
          queryIdentity: checked.queryIdentity,
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
        },
      });
      const started = await startClassifiedLocalGame(controller, ready);
      expect(started.checkpoint.result.kind).toBe('unresolved');
      expect(isLocalBoardInputDisabled(started, false)).toBe(false);
      const white = await submitBoardMove(controller, started, parseCoordinateMove('e2e4')!);
      expect(white.kind).toBe('accepted');
      expect(white.snapshot.checkpoint.rules.moves.map((move) => move.san)).toEqual(['e4']);
      expect(white.snapshot.checkpoint.result.kind).toBe('pending-adjudication');
      expect(isLocalBoardInputDisabled(white.snapshot, false)).toBe(true);
      const stored = await store.readGame(gameId);
      expect(stored?.checkpoint.history.segments[0]).toMatchObject({
        providerId: null,
        modelRoutingId: null,
        connectionRevision: null,
      });
      expect(white.snapshot.checkpoint.history.segments[0]).toMatchObject({
        providerId: null,
        modelRoutingId: null,
        connectionRevision: null,
      });
    } finally {
      store.close();
    }
  });
});
