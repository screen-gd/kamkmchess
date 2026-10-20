import { useEffect, useRef, useState } from 'react';
import { BROWSER_ENGINES } from '../engines/browser.js';
import { PositionEvaluator } from '../engines/evaluation.js';
import { formatEvaluation, whiteEvaluationPercent } from '../engines/uci-score.js';
import type { EngineEvaluation } from '../engines/uci-score.js';

interface EvaluationState { key: string; evaluation?: EngineEvaluation; engine?: string; status: string; pending?: boolean; failed?: boolean }

export function EvaluationBar({ startingFen, moves, orientation }: {
  readonly startingFen: string; readonly moves: string; readonly orientation: 'white' | 'black';
}) {
  const evaluator = useRef<PositionEvaluator | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<EvaluationState | null>(null);
  const key = `${startingFen}|${moves}`;
  useEffect(() => {
    const service = new PositionEvaluator(); evaluator.current = service;
    return () => { service.close(); evaluator.current = null; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    // Debounce history scrubbing without tying analysis to clock ticks or archive updates.
    const timer = window.setTimeout(() => {
      void evaluator.current?.evaluate({ startingFen, moves: moves ? moves.split(' ') : [] }, controller.signal,
        (evaluation, id) => setState({ key, evaluation, engine: BROWSER_ENGINES[id].name, status: `Depth ${evaluation.depth}` }),
        (id, progress) => setState(previous => ({ ...previous, key, engine: BROWSER_ENGINES[id].name, pending: true, failed: false,
          status: progress?.phase === 'downloading'
            ? `Downloading ${Math.min(100, Math.round(progress.loaded / progress.total * 100))}%` : 'Analyzing' })),
      ).catch(() => {
        if (!controller.signal.aborted) setState(previous => ({ ...previous, key, pending: false,
          status: 'Evaluation unavailable. Click to retry.', failed: true }));
      });
    }, 100);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [startingFen, moves, key, attempt]);
  const current = state?.key === key ? state : null;
  // Retain the last settled score across moves and progress updates.
  const score = state?.evaluation?.score;
  const pending = !current || current.pending === true;
  const percent = score ? whiteEvaluationPercent(score) : 50;
  const label = score ? formatEvaluation(score) : current?.failed ? '!' : '…';
  const description = [state?.engine, score ? `White evaluation ${label}` : 'Position evaluation',
    score && (pending || current?.failed) ? 'Showing previous evaluation' : null,
    current?.status ?? 'Preparing analysis'].filter(Boolean).join('. ');
  const whiteFavored = score?.kind === 'mate' ? score.winner === 'white' : (score?.value ?? 0) >= 0;
  const labelAtBottom = whiteFavored === (orientation === 'white');
  return <button type="button" className={`evaluation-bar ${orientation === 'black' ? 'reversed' : ''} ${score ? '' : 'pending'}`}
    aria-label={description} title={description} aria-disabled={!current?.failed} aria-busy={pending}
    data-engine={state?.engine} data-state={current?.failed ? 'failed' : pending ? 'loading' : score ? 'ready' : 'loading'}
    onClick={() => { if (current?.failed) setAttempt(value => value + 1); }}>
    <span className="evaluation-white" style={{ transform: `scaleY(${percent / 100})` }} />
    <span className="evaluation-midpoint" />
    <span className={`evaluation-score ${whiteFavored ? 'for-white' : 'for-black'} ${labelAtBottom ? 'at-bottom' : 'at-top'}`}>{label}</span>
  </button>;
}
