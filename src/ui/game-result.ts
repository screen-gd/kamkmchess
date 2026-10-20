import { MAX_ILLEGAL_MOVE_ATTEMPTS } from '../moves/budgets.js';
import type { GameResultV1, PendingResultReasonV1 } from '../storage/types.js';

export type ResultTone = 'win' | 'loss' | 'draw' | 'neutral';

export interface ResultAnnouncement {
  readonly headline: string;
  readonly detail: string;
  readonly tone: ResultTone;
  /** Single sentence for the aria-live region. */
  readonly announcement: string;
}

type Side = 'white' | 'black';

const PENDING_WORDS: Record<PendingResultReasonV1, string> = {
  checkmate: 'checkmate',
  timeout: 'timeout',
  'dead-position': 'dead position',
  'threefold-repetition': 'threefold repetition',
  'fifty-move-rule': 'fifty-move rule',
};

function sentence(headline: string, detail: string): string {
  return detail ? `${headline}. ${detail}.` : `${headline}.`;
}

/**
 * Turns a stored game result into the wording and tone every result surface shares: the status strip,
 * the sidebar card and the live region. `label` names a side, and `viewer` is the human's colour
 * (null when nobody is playing, which gives the neutral tone). Returns null while the game is unresolved.
 */
export function describeResult(
  result: GameResultV1,
  options: {
    readonly label: (side: Side) => string;
    readonly viewer: Side | null;
  },
): ResultAnnouncement | null {
  if (result.kind === 'unresolved') return null;
  if (result.kind === 'pending-adjudication') {
    const headline = 'Position check pending';
    const detail = `Confirming the ${PENDING_WORDS[result.reason]}`;
    return { headline, detail, tone: 'neutral', announcement: sentence(headline, detail) };
  }

  const { winner } = result;
  const loser = winner === 'draw' ? null : winner === 'white' ? 'black' : 'white';
  const named = loser === null ? '' : options.label(loser);
  const headline = winner === 'draw' ? 'Draw' : winner === 'white' ? 'White won' : 'Black won';
  const detail = (() => {
    switch (result.reason) {
      case 'resignation': return named && `${named} resigned`;
      case 'checkmate': return 'by checkmate';
      case 'timeout': return named ? `${named} ran out of time` : 'out of time with insufficient material';
      case 'illegal-move': return named && `${named} made ${MAX_ILLEGAL_MOVE_ATTEMPTS} illegal moves`;
      case 'stalemate': return 'by stalemate';
      case 'threefold-repetition': return 'by threefold repetition';
      case 'fifty-move-rule': return 'by the fifty-move rule';
      case 'dead-position': return 'by insufficient material';
    }
  })();
  const tone: ResultTone = winner === 'draw' ? 'draw' : options.viewer === null ? 'neutral' : winner === options.viewer ? 'win' : 'loss';
  return { headline, detail, tone, announcement: sentence(headline, detail) };
}
