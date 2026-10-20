import type { ControllerSnapshotV1, GameController, GameControllerIntentResultV1, ModelSelection } from '../controller/index.js';
import { isSquareAttackedInFen } from '../rules/index.js';
import type { CoordinateMove, Position, Promotion, Square } from '../rules/index.js';

const SQUARE = /^[a-h][1-8]$/;

export function parseCoordinateMove(value: string): CoordinateMove | null {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(normalized)) return null;
  const move: CoordinateMove = {
    from: normalized.slice(0, 2) as Square,
    to: normalized.slice(2, 4) as Square,
  };
  const promotion = normalized[4] as Promotion | undefined;
  return promotion === undefined ? move : { ...move, promotion };
}

export function isSquare(value: string): value is Square {
  return SQUARE.test(value);
}

/** The side to move is in check when the opposing colour attacks its king. Returns a Chessground colour, or undefined. */
export function checkedColor(position: Position): 'white' | 'black' | undefined {
  const king = position.pieces.find((piece) => piece.type === 'k' && piece.color === position.sideToMove);
  if (!king) return undefined;
  const attacker = position.sideToMove === 'w' ? 'b' : 'w';
  if (!isSquareAttackedInFen(position.fen, king.square, attacker)) return undefined;
  return position.sideToMove === 'w' ? 'white' : 'black';
}

/** All board input reaches the controller through this fenced human-move intent. */
export function submitBoardMove(
  controller: GameController,
  snapshot: ControllerSnapshotV1,
  move: CoordinateMove,
): Promise<GameControllerIntentResultV1> {
  return controller.dispatch({ schemaVersion: 1, kind: 'human-move', fence: snapshot.fence, move });
}

/** Start an immediately classified local position, or a legacy proof-ready setup. */
export function startClassifiedLocalGame(
  controller: GameController,
  snapshot: ControllerSnapshotV1,
  modelSelection?: ModelSelection,
): Promise<ControllerSnapshotV1> {
  if (snapshot.checkpoint.clocks.activeSide !== null ||
      !(snapshot.checkpoint.result.kind === 'unresolved' ||
        (snapshot.adjudication.status === 'setup-ready' && snapshot.checkpoint.result.kind === 'pending-adjudication'))) return Promise.resolve(snapshot);
  return controller.startGame(snapshot.fence, modelSelection);
}

export function isLocalBoardInputDisabled(snapshot: ControllerSnapshotV1, working: boolean): boolean {
  return working || snapshot.checkpoint.result.kind !== 'unresolved' || snapshot.readiness !== 'ready' ||
    snapshot.clockReading?.status !== 'running';
}
