import type { Color, PieceType } from '../rules/index.js';

/** Artwork URL for one piece, shared by the match board, the promotion panel, the position editor and the landing preview. */
export function pieceImage(color: Color, type: PieceType): string {
  return new URL(`./pieces/${color}${type}.svg`, import.meta.url).href;
}
