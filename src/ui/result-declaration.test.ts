import { describe, expect, it } from 'vitest';
import { resultDeclarationAvailability, resultDeclarationCopy } from './result-declaration.js';

const human = { kind: 'human' } as const;
const model = { kind: 'model' } as const;

describe('result declaration availability', () => {
  it('offers nothing when both players are automated', () => {
    expect(resultDeclarationAvailability({ white: model, black: model }, 'white'))
      .toEqual({ draw: false, resigningSide: null });
  });

  it('offers the human side even when it is not to move', () => {
    expect(resultDeclarationAvailability({ white: human, black: model }, 'black'))
      .toEqual({ draw: true, resigningSide: 'white' });
    expect(resultDeclarationAvailability({ white: model, black: human }, 'white'))
      .toEqual({ draw: true, resigningSide: 'black' });
  });

  it('resigns the side to move in hot-seat play', () => {
    expect(resultDeclarationAvailability({ white: human, black: human }, 'black'))
      .toEqual({ draw: true, resigningSide: 'black' });
    expect(resultDeclarationAvailability({ white: human, black: human }, 'white'))
      .toEqual({ draw: true, resigningSide: 'white' });
  });
});

describe('result declaration copy', () => {
  it('names the final consequence and the safe cancel action for a draw', () => {
    expect(resultDeclarationCopy('draw', 'white')).toEqual({
      title: 'Agree a draw?',
      description: 'The game will end as a draw. This cannot be undone.',
      confirmLabel: 'Draw',
      cancelLabel: 'Keep playing',
    });
  });

  it('names the resigning color and the winner', () => {
    expect(resultDeclarationCopy('resignation', 'black')).toEqual({
      title: 'Resign this game?',
      description: 'Black resigns and White wins. This cannot be undone.',
      confirmLabel: 'Resign',
      cancelLabel: 'Keep playing',
    });
  });
});
