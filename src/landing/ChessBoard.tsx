import type { Chess } from 'chess.js';
import type { Color } from '../rules/types';
import { pieceImage } from '../ui/piece-image';
import { usePieceStyle } from '../ui/use-piece-style';

const pieceNames = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

type ChessBoardProps = {
  board: ReturnType<Chess['board']>;
  orientation: Color;
  lastMove: Pick<ReturnType<Chess['move']>, 'from' | 'to'> | null;
  label: string;
};

export function ChessBoard({ board, orientation, lastMove, label }: ChessBoardProps) {
  const pieceStyle = usePieceStyle();
  const description = board.flatMap((row) => row.flatMap((piece) => (
    piece ? [`${piece.color === 'w' ? 'White' : 'Black'} ${pieceNames[piece.type]} on ${piece.square}`] : []
  ))).join(', ');
  const rows = orientation === 'w' ? board : [...board].reverse().map((row) => [...row].reverse());

  return (
    // data-surface="paper" keeps the board's own light squares and piece colours
    // whatever theme the page around it uses.
    <div className="chessboard" data-surface="paper" role="img" aria-label={`${label}. ${orientation === 'w' ? 'White' : 'Black'} at the bottom. ${description}`}>
      {rows.map((row, rankIndex) => row.map((piece, fileIndex) => {
        const file = files[orientation === 'w' ? fileIndex : 7 - fileIndex];
        const rank = orientation === 'w' ? 8 - rankIndex : rankIndex + 1;
        const square = `${file}${rank}`;
        return (
          <div className="board-square" key={square} data-color={(rankIndex + fileIndex) % 2 === 0 ? 'light' : 'dark'} data-last-move={lastMove?.from === square || lastMove?.to === square || undefined} aria-hidden="true">
            {fileIndex === 0 && <span className="rank-label">{rank}</span>}
            {rankIndex === 7 && <span className="file-label">{file}</span>}
            {piece && <span className="chess-piece" data-side={piece.color}><img src={pieceImage(piece.color, piece.type, pieceStyle)} alt="" /></span>}
          </div>
        );
      }))}
    </div>
  );
}
