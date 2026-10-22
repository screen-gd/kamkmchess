import { useSyncExternalStore } from 'react';
import { DEFAULT_PIECE_STYLE, getPieceStyle, subscribePieceStyle } from './piece-style.js';

export function usePieceStyle() {
  return useSyncExternalStore(subscribePieceStyle, getPieceStyle, () => DEFAULT_PIECE_STYLE);
}
