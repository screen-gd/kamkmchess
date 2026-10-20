import { BrowserUciEngine, downloadBrowserEngine } from './browser.js';
import type { BrowserEngineId, EngineProgress } from './browser.js';
import type { EngineEvaluation } from './uci-score.js';

/** Analysis owns its worker. Cancelling it cannot stop or occupy an opponent's engine. */
export class PositionEvaluator {
  private worker: BrowserUciEngine | null = null;

  close(): void { this.worker?.close(); this.worker = null; }

  async evaluate(position: { startingFen: string; moves: readonly string[] }, signal: AbortSignal,
    onEvaluation: (evaluation: EngineEvaluation, engineId: BrowserEngineId) => void,
    onProgress: (engineId: BrowserEngineId, progress?: EngineProgress) => void): Promise<void> {
    const id = 'stockfish-lite';
    if (signal.aborted) throw new DOMException('Analysis stopped.', 'AbortError');
    onProgress(id);
    const source = await downloadBrowserEngine(id, progress => { if (!signal.aborted) onProgress(id, progress); }, signal);
    if (signal.aborted) throw new DOMException('Analysis stopped.', 'AbortError');
    if (!this.worker || this.worker.stopped) {
      this.close(); this.worker = new BrowserUciEngine(source);
    }
    // Keep shallow search swings out of the bar. Publish once the search settles.
    let settled: EngineEvaluation | undefined;
    await this.worker.analyze({ engineId: id, hashMb: 16, moveTimeMs: 800 }, position,
      evaluation => { settled = evaluation; }, signal);
    if (settled && !signal.aborted) onEvaluation(settled, id);
  }
}
