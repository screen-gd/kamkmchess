import type { ClockSide } from '../clocks/index.js';

export type ResultDeclarationChoice = 'draw' | 'resignation';

interface ResultPlayers {
  readonly white: { readonly kind: string };
  readonly black: { readonly kind: string };
}

export interface ResultDeclarationAvailabilityV1 {
  readonly draw: boolean;
  /** The side that resigns on the owner's behalf, or null when no human plays. */
  readonly resigningSide: ClockSide | null;
}

/**
 * Draw and resignation are local decisions. They stay hidden for model-versus-model
 * viewing, follow the sole human side, and follow the side to move in hot-seat play.
 */
export function resultDeclarationAvailability(
  players: ResultPlayers,
  sideToMove: ClockSide,
): ResultDeclarationAvailabilityV1 {
  const whiteHuman = players.white.kind === 'human';
  const blackHuman = players.black.kind === 'human';
  if (!whiteHuman && !blackHuman) return { draw: false, resigningSide: null };
  return {
    draw: true,
    resigningSide: whiteHuman && blackHuman ? sideToMove : whiteHuman ? 'white' : 'black',
  };
}

export interface ResultDeclarationCopyV1 {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}

export function resultDeclarationCopy(
  choice: ResultDeclarationChoice,
  resigningSide: ClockSide,
): ResultDeclarationCopyV1 {
  if (choice === 'draw') {
    return {
      title: 'Agree a draw?',
      description: 'The game will end as a draw. This cannot be undone.',
      confirmLabel: 'Draw',
      cancelLabel: 'Keep playing',
    };
  }
  const resigning = resigningSide === 'white' ? 'White' : 'Black';
  const winner = resigningSide === 'white' ? 'Black' : 'White';
  return {
    title: 'Resign this game?',
    description: `${resigning} resigns and ${winner} wins. This cannot be undone.`,
    confirmLabel: 'Resign',
    cancelLabel: 'Keep playing',
  };
}
