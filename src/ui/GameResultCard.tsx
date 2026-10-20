import { Icon } from './Icon.js';
import type { IconName } from './Icon.js';
import type { ResultAnnouncement, ResultTone } from './game-result.js';

const GLYPHS: Record<ResultTone, IconName> = { win: 'trophy', loss: 'flag', draw: 'handshake', neutral: 'trophy' };

/**
 * Sits at the top of the moves sidebar once a game is final. The live region in App announces
 * the result, so the card carries no aria-live of its own.
 */
export function GameResultCard({ result, onNewGame }: {
  readonly result: ResultAnnouncement;
  readonly onNewGame: () => void;
}) {
  return <section className="game-result-card" data-tone={result.tone} aria-label="Game result">
    <div className="game-result-summary">
      <span className="game-result-glyph"><Icon name={GLYPHS[result.tone]} /></span>
      <div className="game-result-text">
        <strong className="game-result-headline">{result.headline}</strong>
        {result.detail && <span className="game-result-detail">{result.detail}</span>}
      </div>
    </div>
    <button className="button primary" type="button" onClick={onNewGame}>New game</button>
  </section>;
}
