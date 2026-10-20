import { describe, expect, it } from 'vitest';
import type { FinalResultReasonV1, GameResultV1 } from '../storage/types.js';
import { MAX_ILLEGAL_MOVE_ATTEMPTS } from '../moves/budgets.js';
import { describeResult } from './game-result.js';

const label = (side: 'white' | 'black') => (side === 'white' ? 'Ada' : 'Claude');
const final = (winner: 'white' | 'black' | 'draw', reason: Exclude<FinalResultReasonV1, 'stalemate'>): GameResultV1 =>
  ({ kind: 'final', winner, reason, eventId: 'e1', decidedAtMs: 1 });
const describeFor = (result: GameResultV1, viewer: 'white' | 'black' | null = 'white') => describeResult(result, { label, viewer });

describe('describeResult', () => {
  it('words each final reason and names the loser, not the winner', () => {
    const cases = [
      ['resignation', 'white', 'White won', 'Claude resigned'],
      ['checkmate', 'black', 'Black won', 'by checkmate'],
      ['timeout', 'white', 'White won', 'Claude ran out of time'],
      ['illegal-move', 'black', 'Black won', `Ada made ${MAX_ILLEGAL_MOVE_ATTEMPTS} illegal moves`],
      ['threefold-repetition', 'draw', 'Draw', 'by threefold repetition'],
      ['fifty-move-rule', 'draw', 'Draw', 'by the fifty-move rule'],
      ['dead-position', 'draw', 'Draw', 'by insufficient material'],
    ] as const;
    for (const [reason, winner, headline, detail] of cases) {
      expect(describeFor(final(winner, reason))).toMatchObject({ headline, detail, announcement: `${headline}. ${detail}.` });
    }
    const stalemate: GameResultV1 = { kind: 'final', winner: 'draw', reason: 'stalemate', eventId: 'e1', decidedAtMs: 1 };
    expect(describeFor(stalemate)).toMatchObject({ headline: 'Draw', detail: 'by stalemate' });
  });

  it('keeps a drawn timeout a draw', () => {
    expect(describeFor(final('draw', 'timeout'))).toMatchObject({
      tone: 'draw',
      detail: 'out of time with insufficient material',
    });
  });

  it('derives tone from the viewer', () => {
    const whiteWins = final('white', 'checkmate');
    expect(describeFor(whiteWins, 'white')?.tone).toBe('win');
    expect(describeFor(whiteWins, 'black')?.tone).toBe('loss');
    expect(describeFor(whiteWins, null)?.tone).toBe('neutral');
  });

  it('ignores unresolved results and flags pending ones', () => {
    expect(describeFor({ kind: 'unresolved' })).toBeNull();
    expect(describeFor({ kind: 'pending-adjudication', reason: 'dead-position', eventId: 'e', eventAtMs: 1, activeClockDeadlineMs: null })).toMatchObject({
      headline: 'Position check pending',
      detail: 'Confirming the dead position',
      tone: 'neutral',
    });
  });
});
