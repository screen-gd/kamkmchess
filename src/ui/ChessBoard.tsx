import { Icon, IconButton } from './Icon.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Key } from '@lichess-org/chessground/types';
import '@lichess-org/chessground/assets/chessground.base.css';
import type { ControllerSnapshotV1 } from '../controller/index.js';
import { legalMoves } from '../rules/index.js';
import type { CoordinateMove, Position, Square } from '../rules/index.js';
import { checkedColor, isSquare } from './board-input.js';

function squareDescription(position: Position, square: Square): string {
  const piece = position.pieces.find((item) => item.square === square);
  if (!piece) return square + ', empty';
  const names = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
  return square + ', ' + (piece.color === 'w' ? 'White ' : 'Black ') + names[piece.type];
}

function destinations(snapshot: ControllerSnapshotV1): Map<Key, Key[]> {
  const dests = new Map<Key, Key[]>();
  for (const move of legalMoves(snapshot.position)) {
    const squares = dests.get(move.from) ?? [];
    if (!squares.includes(move.to)) squares.push(move.to);
    dests.set(move.from, squares);
  }
  return dests;
}

export function ChessBoard({ orientation, snapshot, disabled, visible, onMove, view, premoveColor, allowPremove }: {
  readonly orientation: 'white' | 'black';
  readonly snapshot: ControllerSnapshotV1;
  readonly disabled: boolean;
  readonly visible: boolean;
  readonly onMove: (move: Omit<CoordinateMove, 'promotion'>) => Promise<boolean>;
  readonly view: { readonly position: Position; readonly lastMove: { readonly from: string; readonly to: string } | null };
  readonly premoveColor: 'white' | 'black' | null;
  readonly allowPremove: boolean;
}) {
  const [keyboardOrigin, setKeyboardOrigin] = useState<{ square: Square; fen: string } | null>(null);
  const [premove, setPremove] = useState<{ from: Key; to: Key } | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const board = useRef<Api | null>(null);
  const latest = useRef({ snapshot, disabled, onMove, view, premoveColor });
  const fen = view.position.fen;
  const lastMove = view.lastMove;
  const lastFrom = lastMove?.from as Key | undefined;
  const lastTo = lastMove?.to as Key | undefined;

  useLayoutEffect(() => { latest.current = { snapshot, disabled, onMove, view, premoveColor }; }, [snapshot, disabled, onMove, view, premoveColor]);
  useEffect(() => {
    if (!host.current) return;
    const instance = Chessground(host.current, {
      fen: latest.current.snapshot.position.fen,
      orientation,
      coordinates: true,
      disableContextMenu: true,
      animation: { enabled: !window.matchMedia('(prefers-reduced-motion: reduce)').matches, duration: 180 },
      movable: {
        free: false,
        showDests: true,
        rookCastle: false,
        events: {
          after: (from, to) => {
            // Chessground places the piece immediately. Saving must not send
            // the previous FEN back to the board while the transaction runs.
            const current = latest.current;
            instance.set({ movable: { dests: new Map() } });
            const restore = () => {
              if (board.current !== instance) return;
              const { snapshot: saved, disabled: blocked, view: displayed, premoveColor: humanColor } = latest.current;
              const previous = displayed.lastMove;
              instance.set({
                fen: displayed.position.fen,
                turnColor: saved.position.sideToMove === 'w' ? 'white' : 'black',
                lastMove: previous ? [previous.from as Key, previous.to as Key] : [],
              });
              if (!blocked) instance.set({ movable: { color: humanColor ?? (saved.position.sideToMove === 'w' ? 'white' : 'black'), dests: destinations(saved) } });
            };
            if (current.disabled || !isSquare(from) || !isSquare(to)) { restore(); return; }
            void current.onMove({ from, to }).then((accepted) => {
              if (!accepted) restore();
            }).catch(restore);
          },
        },
      },
      draggable: { enabled: true, showGhost: true, distance: 3 },
      premovable: {
        enabled: false,
        showDests: true,
        events: {
          set: () => {
            const queued = instance.state.premovable.current;
            if (board.current === instance && queued) setPremove({ from: queued[0], to: queued[1] });
          },
          unset: () => {
            if (board.current === instance && !instance.state.premovable.current) setPremove(null);
          },
        },
      },
      drawable: { enabled: true, visible: true },
    });
    board.current = instance;
    // Chessground groups Shift and Control together. Pick a distinct brush
    // after its pointer handler starts the drawing, before its first frame.
    const chooseBrush = (event: MouseEvent) => {
      if (event.button !== 2) return;
      const brush = event.altKey ? 'yellow' : event.ctrlKey ? 'blue' : event.shiftKey ? 'red' : 'green';
      requestAnimationFrame(() => {
        if (board.current !== instance) return;
        const drawing = instance.state.drawable.current;
        if (drawing) drawing.brush = brush;
      });
    };
    const element = host.current;
    // React layout changes can move the board without resizing it. Refresh
    // cached coordinates before Chessground handles the next pointer start.
    const refreshBounds = () => instance.state.dom.bounds.clear();
    element.addEventListener('mousedown', refreshBounds, true);
    element.addEventListener('touchstart', refreshBounds, { capture: true, passive: true });
    element.addEventListener('mousedown', chooseBrush, true);
    return () => {
      element.removeEventListener('mousedown', refreshBounds, true);
      element.removeEventListener('touchstart', refreshBounds, true);
      element.removeEventListener('mousedown', chooseBrush, true);
      instance.destroy();
      board.current = null;
    };
    // Create once; subsequent effects update the stable board.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    // Focused tools hide the board. Rebuild its geometry when it returns so
    // Chessground cannot retain the zero-width bounds measured while hidden.
    if (visible) board.current?.redrawAll();
  }, [visible]);

  useEffect(() => {
    // History, Undo, a new game, and match endings invalidate queued input.
    board.current?.cancelMove();
  }, [snapshot.checkpoint.gameId, snapshot.checkpoint.segmentId, snapshot.checkpoint.archive.currentLine.lineId, premoveColor]);

  useEffect(() => {
    if (!premove) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') board.current?.cancelMove();
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [premove]);

  useEffect(() => {
    board.current?.set({ fen, lastMove: lastFrom && lastTo ? [lastFrom, lastTo] : [], check: checkedColor(view.position) ?? false });
  }, [fen, lastFrom, lastTo, view.position]);
  useEffect(() => {
    const instance = board.current;
    if (!instance) return;
    instance.set({ orientation, turnColor: latest.current.snapshot.position.sideToMove === 'w' ? 'white' : 'black' });
    if (disabled) {
      if (premoveColor) instance.selectSquare(null);
      else instance.cancelMove();
    }
    instance.set({
      movable: {
        color: premoveColor ?? (latest.current.snapshot.position.sideToMove === 'w' ? 'white' : 'black'),
        dests: disabled ? new Map() : destinations(latest.current.snapshot),
      },
      premovable: { enabled: premoveColor !== null },
      draggable: { enabled: !disabled || allowPremove },
      selectable: { enabled: !disabled || allowPremove },
    });
    // playPremove checks the queued move against the new legal destinations.
    // Invalid queues are discarded without submitting a controller intent.
    if (!disabled) instance.playPremove();
  }, [disabled, fen, orientation, premoveColor, allowPremove]);

  return (
    <div className="board-frame">
      <div className="board-host cg-wrap" ref={host} role="img" aria-label="Chessboard. Use the coordinate move controls or inspect a square."
        onContextMenu={(event) => { event.preventDefault(); board.current?.cancelMove(); }} />
      {premove && premoveColor && <div className="premove-notice" role="status" aria-label={`Premove ${premove.from} to ${premove.to} queued.`}>
        <span className="sr-only">Premove</span>
        <IconButton icon="close" label="Cancel premove" onClick={() => board.current?.cancelMove()} />

      </div>}
      <p className="sr-only">Right-drag for green arrows; right-click for circles. Hold Shift for red, Control for blue, or Alt for amber.</p>
      <details className="board-inspection sr-only">
        <summary aria-label="Keyboard board"><Icon name="board" /></summary>
        <p className="sr-only">Choose a square to inspect it. Choose a piece of the side to move, then its destination to play a move.</p>
        <div className="square-grid">
          {Array.from({ length: 64 }, (_, index) => {
            const square = ('abcdefgh'[index % 8] + String(8 - Math.floor(index / 8))) as Square;
            return <button className="square-inspect" key={square} type="button"
              aria-label={squareDescription(view.position, square)} aria-pressed={keyboardOrigin?.square === square && keyboardOrigin.fen === fen}
              onClick={() => {
                const node = document.getElementById('board-announcement');
                if (node) node.textContent = squareDescription(view.position, square);
                if (disabled) return;
                const piece = snapshot.position.pieces.find((item) => item.square === square);
                if (piece?.color === snapshot.position.sideToMove) setKeyboardOrigin({ square, fen });
                else if (keyboardOrigin?.fen === fen) {
                  void onMove({ from: keyboardOrigin.square, to: square });
                  setKeyboardOrigin(null);
                }
              }}>{square}</button>;
          })}
        </div>
        <p id="board-announcement" className="sr-only" aria-live="polite" />
      </details>
    </div>
  );
}
