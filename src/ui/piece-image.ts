import type { Color, PieceType } from '../rules/index.js';
import { DEFAULT_PIECE_STYLE } from './piece-style.js';
import type { PieceStyle } from './piece-style.js';

/** Artwork URL for one piece, shared by the match board, the promotion panel, the position editor and the landing preview. */
export function pieceImage(color: Color, type: PieceType, style: PieceStyle = DEFAULT_PIECE_STYLE): string {
  return style === 'merida'
    ? new URL(`./pieces/${color}${type}.svg`, import.meta.url).href
    : new URL(`./pieces/${style}/${color}${type}.svg`, import.meta.url).href;
}

/** Chessground uses the same URLs as the image-based boards and pickers. */
export function pieceImageVariables(style: PieceStyle) {
  return Object.fromEntries((['w', 'b'] as const).flatMap(color =>
    (['k', 'q', 'r', 'b', 'n', 'p'] as const).map(type =>
      [`--piece-${color}${type}`, `url("${pieceImage(color, type, style)}")`],
    ),
  ));
}
