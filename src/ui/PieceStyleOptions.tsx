import { pieceImage } from './piece-image.js';
import { PIECE_STYLES, setPieceStyle } from './piece-style.js';
import { usePieceStyle } from './use-piece-style.js';
import './piece-style-options.css';

export function PieceStyleOptions() {
  const style = usePieceStyle();
  return <div className="piece-style-options">
    <label>Piece style
      <select value={style} onChange={event => setPieceStyle(event.target.value)}>
        {Object.entries(PIECE_STYLES).map(([id, { label }]) => <option key={id} value={id}>{label}</option>)}
      </select>
    </label>
    <div className="piece-style-preview" role="img" aria-label={`${PIECE_STYLES[style].label} pieces`}>
      {(['w', 'b'] as const).flatMap(color => (['k', 'q', 'r', 'b', 'n', 'p'] as const).map(type =>
        <span key={`${color}${type}`}><img src={pieceImage(color, type, style)} alt="" /></span>,
      ))}
    </div>
    <p className="piece-style-credit">By {PIECE_STYLES[style].artist}</p>
  </div>;
}
