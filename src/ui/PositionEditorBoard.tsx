import { useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { PieceType, Square } from '../rules/index.js';
import { Icon } from './Icon.js';
import { pieceImage } from './piece-image.js';
import { usePieceStyle } from './use-piece-style.js';
import { editPositionFen, movePositionPiece, readEditorPieces } from './position-editor.js';
import type { EditorPiece } from './position-editor.js';

type PlacedPiece = Exclude<EditorPiece, 'empty'>;
type Tool = EditorPiece | 'move';
interface Drag {
  pointerId: number;
  fen: string;
  from: Square | null;
  piece: PlacedPiece;
  color: 'w' | 'b';
  type: PieceType;
  startX: number;
  startY: number;
  x: number;
  y: number;
  size: number;
  started: boolean;
}

const PIECES = [
  { type: 'k', name: 'king' }, { type: 'q', name: 'queen' },
  { type: 'r', name: 'rook' }, { type: 'b', name: 'bishop' },
  { type: 'n', name: 'knight' }, { type: 'p', name: 'pawn' },
] as const;

export function PositionEditorBoard({ fen, flipped, onFlip, onChange, onError }: {
  readonly fen: string;
  readonly flipped: boolean;
  readonly onFlip: () => void;
  readonly onChange: (fen: string) => void;
  readonly onError: (error: unknown) => void;
}) {
  const pieceStyle = usePieceStyle();
  const [tool, setTool] = useState<Tool>('move');
  const [selection, setSelection] = useState<{ square: Square; fen: string } | null>(null);
  const selected = selection?.fen === fen ? selection.square : null;
  const setSelected = (square: Square | null) => setSelection(square ? { square, fen } : null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const pending = useRef<Drag | null>(null);
  const ignoreClick = useRef(false);
  const board = useRef<HTMLDivElement>(null);
  let pieces: ReturnType<typeof readEditorPieces> | null = null;
  try { pieces = readEditorPieces(fen); } catch { /* Keep the FEN field available for corrections. */ }

  const edit = (change: () => string) => {
    try { onChange(change()); setSelected(null); }
    catch (error) { onError(error); }
  };
  const chooseTool = (next: Tool) => { setTool(next); setSelected(null); };
  const cancelDrag = () => { pending.current = null; setDrag(null); };
  const startDrag = (event: PointerEvent<HTMLButtonElement>, color: 'w' | 'b', type: PieceType, from: Square | null) => {
    if (event.button !== 0 || !event.isPrimary) return;
    ignoreClick.current = false;
    const size = (board.current?.getBoundingClientRect().width ?? 480) / 8;
    pending.current = {
      pointerId: event.pointerId, fen, from, piece: `${color}${type}`, color, type, startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, size, started: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: PointerEvent) => {
    const current = pending.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.started && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 5) return;
    current.started = true;
    current.x = event.clientX;
    current.y = event.clientY;
    setDrag({ ...current });
    setSelected(null);
  };
  const finishDrag = (event: PointerEvent) => {
    const current = pending.current;
    if (!current || current.pointerId !== event.pointerId) return;
    cancelDrag();
    if (!current.started || current.fen !== fen) return;
    ignoreClick.current = true;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLButtonElement>('[data-editor-square]');
    const square = target && board.current?.contains(target) ? target.dataset.editorSquare as Square : null;
    const from = current.from;
    if (from) {
      chooseTool('move');
      if (square && square !== from) edit(() => movePositionPiece(fen, from, square));
      else if (!square) edit(() => editPositionFen(fen, from, 'empty'));
    } else if (square) {
      chooseTool(current.piece);
      edit(() => editPositionFen(fen, square, current.piece));
    }
  };
  const clickSquare = (square: Square) => {
    if (tool !== 'move') edit(() => editPositionFen(fen, square, tool));
    else if (selected === square) setSelected(null);
    else if (selected && pieces?.some(piece => piece.square === selected)) edit(() => movePositionPiece(fen, selected, square));
    else setSelected(pieces?.some(piece => piece.square === square) ? square : null);
  };
  const tray = (color: 'w' | 'b') => <div className={`editor-piece-picker ${color === 'w' ? 'white-tools' : 'black-tools'}`} role="group" aria-label={`${color === 'w' ? 'White' : 'Black'} pieces`}>
    {PIECES.map(({ type, name }) => {
      const piece: PlacedPiece = `${color}${type}`;
      return <button className={`editor-piece-choice${tool === piece ? ' selected' : ''}`} key={piece} type="button"
        aria-label={`Place ${color === 'w' ? 'white' : 'black'} ${name}`} aria-pressed={tool === piece} title={`Place ${color === 'w' ? 'white' : 'black'} ${name}`}
        draggable={false} disabled={!pieces} onPointerDown={event => startDrag(event, color, type, null)} onClick={() => chooseTool(piece)}>
        <img alt="" draggable={false} src={pieceImage(color, type, pieceStyle)} />
      </button>;
    })}
  </div>;

  return <div className="editor-interaction" onPointerMove={moveDrag} onPointerUp={finishDrag}
    onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag} onDragStart={event => event.preventDefault()}
    onClickCapture={event => { if (ignoreClick.current) { ignoreClick.current = false; event.stopPropagation(); event.preventDefault(); } }}
    onKeyDown={event => {
      ignoreClick.current = false;
      if (event.key === 'Escape') {
        if (pending.current || selected || tool !== 'move') {
          event.preventDefault();
          event.stopPropagation();
        }
        cancelDrag(); setSelected(null); chooseTool('move');
      }
    }}>
    <div className="editor-board-column">
      {pieces ? <div className={`editor-grid${flipped ? ' flipped' : ''}${tool === 'empty' ? ' erase-mode' : ''}`} ref={board} role="group" aria-label="Visual starting position board">
        {Array.from({ length: 64 }, (_, index) => {
          const row = Math.floor(index / 8);
          const column = index % 8;
          const file = (flipped ? 'hgfedcba' : 'abcdefgh')[column];
          const rank = flipped ? row + 1 : 8 - row;
          const square = (file + String(rank)) as Square;
          const piece = pieces.find(item => item.square === square);
          const pieceName = piece ? `${piece.color === 'w' ? 'white' : 'black'} ${PIECES.find(item => item.type === piece.type)?.name}` : 'empty';
          return <button className={`editor-square ${(column + row) % 2 === 0 ? 'light-square' : 'dark-square'}${selected === square ? ' picked-up' : ''}${drag?.from === square ? ' dragging-origin' : ''}`}
            type="button" key={square} data-editor-square={square} draggable={false} aria-label={`${square}, ${pieceName}`} aria-pressed={selected === square}
            onPointerDown={event => { if (piece && tool !== 'empty') startDrag(event, piece.color, piece.type, square); }}
            onClick={() => clickSquare(square)} onContextMenu={event => { event.preventDefault(); edit(() => editPositionFen(fen, square, 'empty')); }}>
            {piece && <img alt="" draggable={false} src={pieceImage(piece.color, piece.type, pieceStyle)} />}
            {column === 0 && <span className="editor-coordinate rank-coordinate">{rank}</span>}
            {row === 7 && <span className="editor-coordinate file-coordinate">{file}</span>}
          </button>;
        })}
      </div> : <div className="editor-board-error" role="status">Enter a valid six-field FEN below to edit this position.</div>}
      <div className="editor-board-toolbar"><span>{tool === 'move' ? 'Drag to move. Drop off the board to remove.' : tool === 'empty' ? 'Click a piece to remove it.' : 'Click a square to place the selected piece.'}</span>
        <button className="button quiet" type="button" aria-label="Flip board" aria-pressed={flipped} onClick={() => { cancelDrag(); setSelected(null); onFlip(); }}><Icon name="flip" />Flip</button>
      </div>
    </div>
    <div className="editor-palette-panel">
      <div className="editor-mode-tools" role="group" aria-label="Board tools">
        <button className={`button quiet${tool === 'move' ? ' selected' : ''}`} type="button" aria-label="Move pieces" aria-pressed={tool === 'move'} onClick={() => chooseTool('move')}><Icon name="move" />Move</button>
        <button className={`button quiet${tool === 'empty' ? ' selected' : ''}`} type="button" aria-label="Remove pieces" aria-pressed={tool === 'empty'} onClick={() => chooseTool('empty')}><Icon name="close" />Erase</button>
      </div>
      <div className="editor-palette-heading">Pieces <span>Drag or select, then place</span></div>
      {tray('w')}{tray('b')}
    </div>
    {drag && <img className="editor-drag-piece" alt="" draggable={false} src={pieceImage(drag.color, drag.type, pieceStyle)}
      style={{ left: drag.x, top: drag.y, width: drag.size, height: drag.size }} />}
  </div>;
}
