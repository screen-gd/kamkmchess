import { describe, expect, it } from 'vitest';
import {
  applyCoordinateMove,
  createRepetitionLedger,
  observeEndingFacts,
  parsePosition,
  recordPosition,
  timeoutWinner,
  type CoordinateMove,
  type RepetitionLedger,
} from '../rules/index.js';
import { handleRulesWorkerLine, policyEnding, type OkRulesWorkerResponse } from './evaluate.js';
import {
  ENGINE_NAME,
  ENGINE_VERSION,
  RULES_POLICY_VERSION,
  RULES_WORKER_PROTOCOL_VERSION,
} from './protocol.js';

const INITIAL = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function repetitionFor(fen: string, occurrences = 1): RepetitionLedger {
  let ledger = createRepetitionLedger(parsePosition(fen));
  for (let index = 1; index < occurrences; index += 1) {
    ledger = recordPosition(ledger, parsePosition(fen));
  }
  return ledger;
}

function request(fen: string, occurrences = 1, intent?: unknown): Record<string, unknown> {
  return {
    protocolVersion: 1,
    requestId: `request-${occurrences}`,
    rulesPolicyVersion: RULES_POLICY_VERSION,
    matchVersion: 12,
    fen,
    history: Array.from({ length: occurrences }, () => fen),
    ...(intent === undefined ? {} : { intent }),
  };
}

function evaluate(fen: string, occurrences = 1, intent?: unknown): OkRulesWorkerResponse {
  const response = handleRulesWorkerLine(JSON.stringify(request(fen, occurrences, intent)));
  if (response.status !== 'ok') throw new Error(`Expected ok response, got ${response.code}: ${response.message}`);
  return response;
}

function rejectionCode(fen: string, intent: unknown, occurrences = 1): string {
  const response = handleRulesWorkerLine(JSON.stringify(request(fen, occurrences, intent)));
  if (response.status !== 'rejected') throw new Error('Expected a rejection.');
  return response.code;
}

function move(from: string, to: string, promotion?: string): Record<string, unknown> {
  return { kind: 'move', from, to, ...(promotion === undefined ? {} : { promotion }) };
}

describe('[KHA-66] rules worker evaluation parity', () => {
  it('evaluates the initial position with pinned versions and no candidate', () => {
    const response = evaluate(INITIAL);

    expect(response.protocolVersion).toBe(RULES_WORKER_PROTOCOL_VERSION);
    expect(response.rulesPolicyVersion).toBe(RULES_POLICY_VERSION);
    expect(response.engine).toEqual({ name: ENGINE_NAME, version: ENGINE_VERSION });
    expect(response.inputFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(response.input.fen).toBe(INITIAL);
    expect(response.facts.ending).toBe('none');
    expect(response.facts.hasLegalMoves).toBe(true);
    expect(response.facts.insufficientMaterial).toBe(false);
    expect(response.facts.material.total).toBe(32);
    expect(response.facts.repetitionCount).toBe('1');
    expect(response.facts.timeoutWinner).toBeNull();
    expect(response.candidate).toBeNull();
  });

  it('preserves exact large counters and returns a correlated candidate', () => {
    const hugeHalfmoves = '4k3/8/8/8/8/8/8/4K2R w K - 99999999999999999999 9007199254740993';
    const settled = evaluate(hugeHalfmoves);
    expect(settled.input.fen).toBe(hugeHalfmoves);
    expect(settled.facts.hundredHalfmoves).toBe(true);
    expect(settled.facts.ending).toBe('hundred-halfmoves');

    const fen = '4k3/8/8/8/8/8/8/4K2R w K - 0 9007199254740993';
    const response = evaluate(fen, 1, move('h1', 'h2'));

    expect(response.input.fen).toBe(fen);
    expect(response.candidate).not.toBeNull();
    expect(response.candidate?.resultingFen).toBe('4k3/8/8/8/8/8/7R/4K3 b - - 1 9007199254740993');
    expect(response.candidate?.ending.repetitionCount).toBe('1');
  });

  it('matches local rules output for ordinary and special moves', () => {
    const cases: [string, CoordinateMove][] = [
      [INITIAL, { from: 'e2', to: 'e4' }],
      ['4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2', { from: 'e5', to: 'd6' }],
      ['r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', { from: 'e1', to: 'g1' }],
      ['8/P7/8/8/8/8/8/K6k w - - 0 1', { from: 'a7', to: 'a8', promotion: 'q' }],
      ['8/P7/8/8/8/8/8/K6k w - - 0 1', { from: 'a7', to: 'a8', promotion: 'n' }],
    ];

    for (const [fen, candidateMove] of cases) {
      const ledger = repetitionFor(fen);
      const transition = applyCoordinateMove(parsePosition(fen), candidateMove);
      const nextLedger = recordPosition(ledger, transition.position);
      const expectedEnding = observeEndingFacts(transition.position, nextLedger);
      const response = evaluate(fen, 1, move(candidateMove.from, candidateMove.to, candidateMove.promotion));

      expect(response.candidate?.resultingFen, fen).toBe(transition.position.fen);
      expect(response.candidate?.san, fen).toBe(transition.san);
      expect(response.candidate?.ending.ending, fen).toBe(policyEnding(expectedEnding));
      expect(response.candidate?.ending.checkmate, fen).toBe(expectedEnding.checkmate);
      expect(response.candidate?.ending.stalemate, fen).toBe(expectedEnding.stalemate);
      expect(response.candidate?.ending.repetitionCount, fen).toBe(expectedEnding.repetitionCount);
    }
  });

  it('records en passant, castling rights, and promotion facts exactly once', () => {
    const enPassant = evaluate('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2', 1, move('e5', 'd6'));
    expect(enPassant.candidate?.san).toBe('exd6');
    expect(enPassant.candidate?.ending.material.black.p).toBe(0);
    expect(enPassant.candidate?.repetition.entries).toHaveLength(2);

    const castling = evaluate('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 1, move('e1', 'g1'));
    expect(castling.candidate?.san).toBe('O-O');
    expect(castling.candidate?.resultingFen).toBe('r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1');

    const promotion = evaluate('8/P7/8/8/8/8/8/K6k w - - 0 1', 1, move('a7', 'a8', 'q'));
    expect(promotion.candidate?.san).toBe('a8=Q+');
    expect(promotion.candidate?.ending.material.white.q).toBe(1);
    expect(promotion.candidate?.ending.material.white.p).toBe(0);
  });

  it('rejects illegal castling coordinates and incomplete promotions', () => {
    expect(rejectionCode('r3k2r/8/8/8/5r2/8/8/R3K2R w KQkq - 0 1', move('e1', 'g1'))).toBe('illegal-move');
    expect(rejectionCode('r3k2r/8/8/8/4r3/8/8/R3K2R w KQkq - 0 1', move('e1', 'g1'))).toBe('illegal-move');
    expect(rejectionCode('8/P7/8/8/8/8/8/K6k w - - 0 1', move('a7', 'a8'))).toBe('illegal-move');
    expect(rejectionCode(INITIAL, move('e2', 'e4', 'q'))).toBe('illegal-move');
  });
});

describe('[KHA-66] endings, repetition, material, and timeout', () => {
  it('counts repetition identity and stops move intents at the draw boundary', () => {
    const fen = '4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1';
    const once = evaluate(fen, 1);
    const twice = evaluate(fen, 2);
    const threeTimes = evaluate(fen, 3);

    expect(once.facts.repetitionCount).toBe('1');
    expect(twice.facts.repetitionCount).toBe('2');
    expect(threeTimes.facts.thirdRepetition).toBe(true);
    expect(threeTimes.facts.ending).toBe('threefold-repetition');
    expect(rejectionCode(fen, move('e1', 'd1'), 3)).toBe('position-terminal');
  });

  it('applies checkmate precedence over repetition and the halfmove boundary', () => {
    const mate = '7k/6Q1/6K1/8/8/8/8/8 b - - 100 60';
    const response = evaluate(mate, 3);

    expect(response.facts.checkmate).toBe(true);
    expect(response.facts.thirdRepetition).toBe(true);
    expect(response.facts.hundredHalfmoves).toBe(true);
    expect(response.facts.ending).toBe('checkmate');
    expect(rejectionCode(mate, move('h8', 'h7'), 3)).toBe('position-terminal');
  });

  it('detects stalemate and the hundred-halfmove boundary', () => {
    const stalemate = evaluate('7k/5Q2/8/8/8/8/8/6K1 b - - 0 1');
    expect(stalemate.facts.stalemate).toBe(true);
    expect(stalemate.facts.ending).toBe('stalemate');

    const halfmoves = evaluate('7k/8/8/8/8/8/8/K6q w - - 100 60');
    expect(halfmoves.facts.checkmate).toBe(false);
    expect(halfmoves.facts.hundredHalfmoves).toBe(true);
    expect(halfmoves.facts.ending).toBe('hundred-halfmoves');
    expect(rejectionCode('7k/8/8/8/8/8/8/K6q w - - 100 60', move('a1', 'a2'))).toBe('position-terminal');
  });

  it('follows the bounded material timeout policy', () => {
    const bareKings = '8/8/8/8/8/8/8/K6k w - - 0 1';
    const whiteKnight = '7k/8/8/8/8/8/8/K6N w - - 0 1';
    const whiteRook = '7k/8/8/8/8/8/R7/K7 w - - 0 1';

    expect(evaluate(bareKings).facts.insufficientMaterial).toBe(true);
    expect(evaluate(bareKings).facts.ending).toBe('insufficient-material');
    expect(rejectionCode(bareKings, move('a1', 'a2'))).toBe('position-terminal');
    expect(evaluate(bareKings, 1, { kind: 'timeout', expiredColor: 'w' }).facts.timeoutWinner).toBe('draw');
    expect(evaluate(whiteKnight, 1, { kind: 'timeout', expiredColor: 'b' }).facts.timeoutWinner).toBe(
      timeoutWinner(parsePosition(whiteKnight), 'b'),
    );
    expect(evaluate(whiteKnight, 1, { kind: 'timeout', expiredColor: 'b' }).facts.timeoutWinner).toBe('draw');

    const notToMove = evaluate(whiteRook, 1, { kind: 'timeout', expiredColor: 'b' });
    expect(notToMove.facts.timeoutWinner).toBe('white');
    expect(notToMove.candidate).toBeNull();

    const toMove = evaluate('7k/8/8/8/8/8/8/K6q w - - 0 1', 1, { kind: 'timeout', expiredColor: 'w' });
    expect(toMove.facts.timeoutWinner).toBe('black');
    expect(toMove.facts.ending).toBe('none');
  });

  it('gives mate, stalemate, and dead positions precedence over draw counters', () => {
    const mate = '7k/6Q1/6K1/8/8/8/8/8 b - - 100 60';
    expect(evaluate(mate, 3).facts.ending).toBe('checkmate');

    const stalemate = '7k/5Q2/8/8/8/8/8/6K1 b - - 100 1';
    expect(evaluate(stalemate, 3).facts.ending).toBe('stalemate');

    const dead = '7k/8/8/8/8/8/8/K6N w - - 100 60';
    const facts = evaluate(dead, 3).facts;
    expect(facts.insufficientMaterial).toBe(true);
    expect(facts.thirdRepetition).toBe(true);
    expect(facts.hundredHalfmoves).toBe(true);
    expect(facts.ending).toBe('insufficient-material');
  });

  it('keeps candidate repetition history complete for the next authority check', () => {
    const fen = '4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1';
    const response = evaluate(fen, 2, move('e1', 'd1'));

    expect(response.candidate?.repetition.version).toBe(1);
    expect(response.candidate?.repetition.entries).toHaveLength(2);
    expect(response.candidate?.repetition.entries.some((entry) => entry.occurrences === '2')).toBe(true);
    expect(response.candidate?.repetition.entries.some((entry) => entry.occurrences === '1')).toBe(true);
  });
});
