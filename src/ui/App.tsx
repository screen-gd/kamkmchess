import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { ChessBoard } from './ChessBoard.js';
import { EvaluationBar } from './EvaluationBar.js';
import { MoveList } from './MoveList.js';
import { useBoardHistory } from './use-board-history.js';
import type { ControllerSnapshotV1 } from '../controller/index.js';
import type { GameResultDeclarationV1, ModelSelection } from '../controller/index.js';
import { legalMoves } from '../rules/index.js';
import type { CoordinateMove, Promotion } from '../rules/index.js';
import { isLocalBoardInputDisabled, parseCoordinateMove, startClassifiedLocalGame, submitBoardMove } from './board-input.js';
import type { LocalGameSession, MatchComposition } from './match-composition.js';
import { T3_PALETTES } from './t3-palettes.js';
import { useTheme } from '../use-theme.js';
import { OpponentPanel } from './OpponentPanel.js';
import { OpponentBadge } from './OpponentBadge.js';
import { EnginePanel } from './EnginePanel.js';
import { isEngineSelection, runEngineTurn } from '../engines/local.js';
import { BROWSER_ENGINES, stopBrowserEngines, stopUnusedBrowserEngines } from '../engines/browser.js';
import { engineSettings } from '../engines/local.js';
import { IconButton } from './Icon.js';
import { GameResultCard } from './GameResultCard.js';
import { describeResult } from './game-result.js';
import type { ResultTone } from './game-result.js';
import { isSoundEnabled, playResultSound, setSoundEnabled } from './sounds.js';
import type { SoundCue } from './sounds.js';
import { pieceImage } from './piece-image.js';
import { conciseError, conciseTurnError } from './concise-error.js';
import { controllerRevisionForConfig, matchesOpponentSelection } from './opponent-selection.js';
import { getGenerationJournal } from '../integration/generation-runner.js';
import type { GenerationJournalV1 } from '../integration/generation-runner.js';
import type { HandoffSnapshotV1, OpponentIdentityV1 } from '../opponents/index.js';
import { RightGameSidebar } from '../navigation/RightGameSidebar.js';
import { LeftGameRail } from '../navigation/LeftGameRail.js';
import { readSidebarPreferences } from '../navigation/sidebar-preferences.js';
import { NewGameSetup } from './NewGameSetup.js';
import type { NewGameDraft, StartedSidebarGame } from './NewGameSetup.js';
import { resultDeclarationAvailability, resultDeclarationCopy } from './result-declaration.js';
import type { ResultDeclarationChoice } from './result-declaration.js';

type PromotionMove = Omit<CoordinateMove, 'promotion'>;
interface AppProps {
  readonly composition: MatchComposition;
  readonly initialSession: LocalGameSession;
  readonly initialSnapshot: ControllerSnapshotV1;
  readonly onOpenAccount?: () => void;
}
const PROMOTIONS: readonly { value: Promotion; label: string }[] = [
  { value: 'q', label: 'Queen' }, { value: 'r', label: 'Rook' },
  { value: 'b', label: 'Bishop' }, { value: 'n', label: 'Knight' },
];

function formatClock(milliseconds: number): string {
  const total = Math.max(0, Math.ceil(milliseconds / 1_000));
  return Math.floor(total / 60) + ':' + (total % 60).toString().padStart(2, '0');
}
const RESULT_CUES: Record<ResultTone, SoundCue> = { win: 'win', loss: 'loss', draw: 'draw', neutral: 'draw' };

function playerName(snapshot: ControllerSnapshotV1, side: 'white' | 'black'): string {
  const player = snapshot.checkpoint.selections.players[side];
  return isEngineSelection(player) ? BROWSER_ENGINES[engineSettings(player).engineId].name
    : player.kind === 'model' ? player.modelRoutingId : side === 'white' ? 'White' : 'Black';
}
const PRACTICE_REASONS = new Set<string>(['resignation', 'illegal-move', 'timeout']);
const PROJECT_URL = 'https://github.com/Kamkmgamer/kamkmchess';

function humanSide(snapshot: ControllerSnapshotV1): 'white' | 'black' | null {
  const { white, black } = snapshot.checkpoint.selections.players;
  return white.kind === 'human' && black.kind === 'model' ? 'white' : black.kind === 'human' && white.kind === 'model' ? 'black' : null;
}
function resultOf(snapshot: ControllerSnapshotV1) {
  return describeResult(snapshot.checkpoint.result, { label: side => playerName(snapshot, side), viewer: humanSide(snapshot) });
}
function finalEventId(snapshot: ControllerSnapshotV1): string | null {
  return snapshot.checkpoint.result.kind === 'final' ? snapshot.checkpoint.result.eventId : null;
}
/** One line for non-final states and the live region; final and pending results come from describeResult. */
function statusLabel(snapshot: ControllerSnapshotV1): string {
  if (snapshot.readiness === 'restore-recovery-pending') return 'Restoring saved game';
  if (snapshot.readiness === 'expiry-persistence-pending') return 'Saving clock result';
  if (snapshot.readiness === 'clock-reconciliation-required') return 'Clock needs review';
  const result = resultOf(snapshot);
  if (result) return result.announcement;
  return (snapshot.position.sideToMove === 'w' ? 'White' : 'Black') + ' to move';
}

export function App({ composition, initialSession, initialSnapshot, onOpenAccount }: AppProps) {
  const [session, setSession] = useState(initialSession);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [orientation, setOrientation] = useState<'white' | 'black'>(() =>
    initialSnapshot.checkpoint.selections.players.white.kind === 'model' && initialSnapshot.checkpoint.selections.players.black.kind === 'human' ? 'black' : 'white');
  const { theme, setTheme, appearance, setAppearance } = useTheme();
  const [coordinate, setCoordinate] = useState('');
  const [coordinateError, setCoordinateError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [sound, setSound] = useState(isSoundEnabled);
  const [menuOpen, setMenuOpen] = useState(false);
  const [promotion, setPromotion] = useState<PromotionMove | null>(null);
  const [setupOpen, setSetupOpen] = useState(() => new URLSearchParams(window.location.search).get('setup') === 'new' || !readSidebarPreferences().collapsed);
  const [setupRequest, setSetupRequest] = useState(0);
  const [setupStartingFen, setSetupStartingFen] = useState<string | undefined>();
  const [setupFocus, setSetupFocus] = useState<'opponent' | 'time' | 'position' | null>(null);
  const [setupDraft, setSetupDraft] = useState<NewGameDraft | undefined>();
  const [tool, setTool] = useState<'settings' | 'position' | 'archive' | 'move' | null>(null);
  const [resultPrompt, setResultPrompt] = useState<ResultDeclarationChoice | null>(null);
  const [working, setWorking] = useState(false);
  const checkedIdentities = useRef(new Map<string, OpponentIdentityV1>());
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(null);
  const [opponentIdentity, setOpponentIdentity] = useState<OpponentIdentityV1 | null>(null);
  const [handoff, setHandoff] = useState<HandoffSnapshotV1>({ committed: null, queued: null, producing: null });
  const [autoGeneration, setAutoGeneration] = useState(true);
  const [generationAttempt, setGenerationAttempt] = useState(0);
  const [generationState, setGenerationState] = useState<'idle' | 'producing' | 'failed' | 'stopped'>('idle');
  const [generationDetail, setGenerationDetail] = useState('');
  const [generationJournal, setGenerationJournal] = useState<GenerationJournalV1 | null>(null);
  const [journalRefresh, setJournalRefresh] = useState(0);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const history = useBoardHistory(snapshot, !setupOpen && !promotion && !recoveryOpen && !tool && resultPrompt === null);
  const generationController = useRef<AbortController | null>(null);
  const practiceController = useRef<AbortController | null>(null);
  const generationFenceKey = useRef('');
  const sessionRef = useRef(session);
  const announcedResult = useRef(finalEventId(initialSnapshot));
  const movesPanel = useRef<HTMLElement>(null);
  const boardPanel = useRef<HTMLElement>(null);
  const keepPlaying = useRef<HTMLButtonElement>(null);
  const resultTrigger = useRef<HTMLButtonElement | null>(null);
  const resultConfirmed = useRef(false);
  const resultStatus = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('setup') !== 'new') return;
    url.searchParams.delete('setup');
    window.history.replaceState(window.history.state, '', url);
  }, []);
  const refresh = useCallback((next: ControllerSnapshotV1) => {
    setSnapshot(next);
    if (next.checkpoint.result.kind === 'final') {
      // A final result can arrive while the confirmation is open, for example on an AI checkmate.
      resultConfirmed.current = true;
      setResultPrompt(null);
      setFeedback(statusLabel(next));
    }
  }, []);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => () => {
    generationController.current?.abort();
    practiceController.current?.abort();
    generationController.current = null;
    stopBrowserEngines();
  }, [session.gameId]);
  const whitePlayer = snapshot.checkpoint.selections.players.white;
  const blackPlayer = snapshot.checkpoint.selections.players.black;
  const queuedPlayer = snapshot.modelHandoff.queued?.selection;
  const whiteEngineId = isEngineSelection(whitePlayer) ? engineSettings(whitePlayer).engineId : null;
  const blackEngineId = isEngineSelection(blackPlayer) ? engineSettings(blackPlayer).engineId : null;
  const queuedEngineId = queuedPlayer && isEngineSelection(queuedPlayer) ? engineSettings(queuedPlayer).engineId : null;
  useEffect(() => {
    const keep = snapshot.checkpoint.result.kind === 'final' || generationState === 'stopped'
      ? [] : [whiteEngineId, blackEngineId, queuedEngineId].filter(id => id !== null);
    stopUnusedBrowserEngines(keep);
  }, [whiteEngineId, blackEngineId, queuedEngineId, snapshot.checkpoint.result.kind, generationState]);
  useEffect(() => session.controller.subscribe(refresh), [refresh, session.controller]);
  useEffect(() => {
    let current = true;
    let unsubscribe: (() => void) | undefined;
    void composition.opponentService.then((service) => {
      if (!current) return;
      setHandoff(service.getSnapshot());
      unsubscribe = service.subscribe(setHandoff);
    });
    return () => { current = false; unsubscribe?.(); };
  }, [composition]);
  useEffect(() => {
    let current = true;
    void composition.readSavedGame(session.gameId).then((saved) => {
      if (current) setGenerationJournal(saved ? getGenerationJournal(saved) : null);
    }).catch((error: unknown) => {
      if (current) setGenerationDetail(error instanceof Error ? error.message : 'Saved archive status is unavailable.');
    });
    return () => { current = false; };
  }, [composition, session.gameId, journalRefresh]);
  useEffect(() => {
    let stopped = false;
    let timer = 0;
    let reconciling = false;
    const tick = async () => {
      if (!reconciling) {
        reconciling = true;
        try {
          const observed = session.controller.snapshot();
          const needsReconciliation = observed.readiness === 'expiry-persistence-pending' ||
            observed.readiness === 'restore-recovery-pending' || observed.clockReading?.status === 'expired';
          const next = needsReconciliation ? await session.controller.reconcile() : observed;
          if (!stopped) setSnapshot(next);
        } catch {
          if (!stopped) setSnapshot(session.controller.snapshot());
        } finally { reconciling = false; }
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), 1_000);
    };
    timer = window.setTimeout(() => void tick(), 1_000);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [session.controller]);

  useEffect(() => {
    const current = session.controller.snapshot();
    if (current.checkpoint.result.kind !== 'unresolved' || current.checkpoint.clocks.activeSide !== null) return;
    const players = current.checkpoint.selections.players;
    const selection = players.white.kind === 'model' ? players.white : players.black.kind === 'model' ? players.black : undefined;
    if (selection && selection.diagnostic !== 'passed-current-session') return;
    if (Object.values(players).some(player => player.kind === 'model' && player.diagnostic !== 'passed-current-session')) return;
    void startClassifiedLocalGame(session.controller, current).then(refresh).catch(error => {
      setFeedback(error instanceof Error ? error.message : 'The game could not start.');
    });
  }, [session, refresh, snapshot.checkpoint.result.kind, snapshot.checkpoint.clocks.activeSide]);

  const generationSide = snapshot.position.sideToMove === 'w' ? 'white' : 'black';
  const generationSelection = snapshot.checkpoint.selections.players[generationSide];
  const queuedGenerationSelection = snapshot.modelHandoff.queued?.selection;
  const queuedGenerationIdentity = queuedGenerationSelection
    ? [queuedGenerationSelection.connectionId, queuedGenerationSelection.configurationRevision,
      queuedGenerationSelection.modelRoutingId, queuedGenerationSelection.protocol].join('/')
    : '';
  const generationResultKind = snapshot.checkpoint.result.kind;
  const generationReadiness = snapshot.readiness;
  const generationClockStatus = snapshot.clockReading?.status;
  const generationKey = [snapshot.checkpoint.gameId, snapshot.checkpoint.segmentId,
    snapshot.checkpoint.positionRevision, generationSide,
    snapshot.fence.modelConfigurationIdentity ?? '',
    generationSelection.kind === 'model' ? generationSelection.connectionId : '',
    generationSelection.kind === 'model' ? generationSelection.modelRoutingId : '',
    queuedGenerationIdentity].join('/');
  useEffect(() => {
    if (!autoGeneration || generationController.current !== null || generationSelection.kind !== 'model' ||
      generationResultKind !== 'unresolved' || generationReadiness !== 'ready' ||
      generationClockStatus !== 'running') return;
    const selection = generationSelection;
    const queuedSelection = queuedGenerationSelection ?? selection;
    const queuedIdentityAtStart = queuedGenerationIdentity;
    const key = generationKey;
    if (generationFenceKey.current === key) return;
    // Deferring the start lets React StrictMode's setup/cleanup probe cancel a
    // not-yet-started run without leaving a controller or fence locked.
    let cancelled = false;
    let abort: AbortController | null = null;
    const timer = window.setTimeout(() => {
      if (cancelled || generationFenceKey.current === key) return;
      generationFenceKey.current = key;
      abort = new AbortController();
      generationController.current = abort;
      setGenerationState('producing');
      setGenerationDetail('Thinking…');
      void (async () => {
        let service: Awaited<typeof composition.opponentService> | null = null;
        let continueAutomatically = false;
        try {
          if (isEngineSelection(queuedSelection)) {
            setGenerationDetail('Thinking…');
            const accepted = await runEngineTurn(session.controller, abort!.signal);
            if (sessionRef.current.gameId !== session.gameId) return;
            setGenerationState(accepted ? 'idle' : 'failed');
            setGenerationDetail(accepted ? 'Move saved.' : 'Move unavailable. Retry.');
            setJournalRefresh(revision => revision + 1);
            return;
          }
          const identities = [...checkedIdentities.current.values(), opponentIdentity, handoff.producing, handoff.queued?.identity, handoff.committed];
          let identity = identities.find(candidate => matchesOpponentSelection(candidate, queuedSelection)) ?? null;
          const store = await composition.connectionStore;
          const profile = await store.getProfile(composition.namespace, queuedSelection.connectionId);
          if (!profile) throw new Error('The model connection was removed.');
          service = await composition.opponentService;
          const credentials = await store.resolveCredentials(composition.namespace, profile);
          if (!identity || identity.configRevision !== profile.configRevision || identity.protocol !== profile.protocol ||
              credentials.status !== 'bound' || identity.credentialRevision !== credentials.credentials.credentialRevision) {
            setGenerationDetail('Checking connection…');
            const result = await service.runCompatibilityDiagnostic({ profileId: profile.id, modelId: queuedSelection.modelRoutingId }, abort!.signal);
            if (abort!.signal.aborted || sessionRef.current.gameId !== session.gameId) return;
            if (result.evidence.state !== 'passed-current-session') throw new Error(result.evidence.detail);
            const prepared = await service.prepareSelection({ profileId: profile.id, modelId: queuedSelection.modelRoutingId });
            identity = prepared.queued?.identity ?? prepared.committed;
            if (!identity || identity.modelId !== queuedSelection.modelRoutingId || identity.profileId !== profile.id) throw new Error('Connection changed.');
            const checked = { ...queuedSelection, diagnostic: 'passed-current-session' as const, configurationRevision: controllerRevisionForConfig(profile.configRevision), protocol: profile.protocol };
            const next = await session.controller.queueModelSelection(session.controller.snapshot().fence, checked);
            if (abort!.signal.aborted || sessionRef.current.gameId !== session.gameId) return;
            refresh(next);
            checkedIdentities.current.set(JSON.stringify(checked), identity);
            identities.push(identity);
            setOpponentIdentity(identity);
          }
          service.setProducingSelection(identity);
          const result = await composition.runModelTurn(session, (requested) => {
            const expected = identities.find((candidate) => matchesOpponentSelection(candidate, requested));
            return expected?.configRevision ?? '';
          }, abort!.signal);
          if (sessionRef.current.gameId !== session.gameId) return;
          setJournalRefresh((revision) => revision + 1);
          if (result.kind === 'completed' && result.dispatch === 'accepted') {
            const currentHandoff = session.controller.snapshot().modelHandoff;
            const latest = currentHandoff.committed;
            const committedIdentity = latest
              ? identities.find((candidate) => matchesOpponentSelection(candidate, latest)) ?? null : null;
            if (latest && committedIdentity && currentHandoff.queued?.state !== 'failed') {
              service.setCommittedSelection(committedIdentity);
              service.recoverCandidate('resume-prior');
              setModelSelection(latest);
              setOpponentIdentity(committedIdentity);
            }
            if (result.recovery) {
              continueAutomatically = result.recovery.kind === 'automatic';
              setGenerationState(continueAutomatically ? 'idle' : 'failed');
              setGenerationDetail(result.recovery.detail);
              setFeedback(result.recovery.detail);
              if (!continueAutomatically) setAutoGeneration(false);
            } else {
              setGenerationState('idle');
              setGenerationDetail(result.persistence === 'saved-locally'
                ? `Model reply saved locally via ${latest?.modelRoutingId ?? queuedSelection.modelRoutingId}.`
                : `Model reply accepted via ${latest?.modelRoutingId ?? queuedSelection.modelRoutingId}; archive status: ${result.persistence}.`);
              setFeedback('Move saved.');
            }
          } else if (result.kind === 'interrupted' || result.kind === 'capacity-rejected') {
            setGenerationState(abort!.signal.aborted ? 'stopped' : 'failed');
            setGenerationDetail(result.kind === 'interrupted'
              ? (result.protocol?.httpStatus ?? 0) >= 400
                ? `Provider returned HTTP ${result.protocol!.httpStatus}.`
                : result.protocol && result.protocol.terminal !== 'complete'
                  ? `Reply ${result.protocol.terminal}.`
                  : result.detail ?? `Generation ${result.reason}.`
              : result.capacity.status === 'rejected' && result.capacity.reason === 'capacity-unverifiable'
                ? 'The request token capacity could not be verified for this model.'
                : 'The chess position request exceeds the configured request limit. Choose another model or start a new game.');
          } else {
            setGenerationState('failed');
            setGenerationDetail(result.kind === 'not-started' ? statusLabel(result.snapshot) : 'The model reply was not accepted. Use Retry or Switch.');
          }
        } catch (error) {
          if (sessionRef.current.gameId === session.gameId) {
            setGenerationState('failed');
            setGenerationDetail(error instanceof Error ? error.message : 'The model request failed. The clock continued.');
          }
        } finally {
          service?.producingReplySettled();
          if (generationController.current === abort) generationController.current = null;
          if (sessionRef.current.gameId === session.gameId) {
            const latest = session.controller.snapshot();
            if (abort?.signal.aborted) {
              setGenerationState(latest.checkpoint.result.kind === 'final' ? 'idle' : 'stopped');
            }
            const latestQueued = latest.modelHandoff.queued?.selection;
            const latestQueuedIdentity = latestQueued
              ? [latestQueued.connectionId, latestQueued.configurationRevision,
                latestQueued.modelRoutingId, latestQueued.protocol].join('/')
              : '';
            if (continueAutomatically && !abort?.signal.aborted) {
              generationFenceKey.current = '';
              setGenerationAttempt((attempt) => attempt + 1);
            } else if (latest.checkpoint.positionRevision !== snapshot.checkpoint.positionRevision ||
              latestQueuedIdentity !== queuedIdentityAtStart) {
              setGenerationAttempt((attempt) => attempt + 1);
            }
          }
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  // Generation is fenced to game/position/model identity. Stream and clock snapshots
  // are display updates and must not clean up a request that is already in flight.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoGeneration, composition, generationAttempt, generationKey, generationResultKind,
    generationReadiness, generationClockStatus, opponentIdentity?.configRevision, session]);

  const submitMove = useCallback(async (move: CoordinateMove) => {
    setWorking(true);
    setFeedback('');
    try {
      const result = await submitBoardMove(session.controller, session.controller.snapshot(), move);
      refresh(result.snapshot);
      if (result.kind === 'accepted') setJournalRefresh((revision) => revision + 1);
      if (result.kind === 'rejected') {
        setFeedback(result.reason === 'illegal-move' ? 'Illegal move.' : 'Position changed. Retry.');
      } else if (result.kind === 'expired') setFeedback('Time expired.');
      else if (result.kind === 'clock-reconciliation-required') setFeedback('Checking clock…');
      else setFeedback('Move saved.');
      return result.kind === 'accepted';
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'The move could not be saved.');
      return false;
    } finally { setWorking(false); }
  }, [refresh, session.controller]);

  const openSetup = (fen?: string, focus: 'opponent' | 'time' | 'position' | null = null) => {
    // A closing popup can still be mounted when another setup request arrives.
    setSetupRequest(request => request + 1);
    setSetupStartingFen(fen);
    setSetupFocus(fen ? 'position' : focus);
    setTool(null);
    setRecoveryOpen(false);
    setSetupOpen(true);
  };

  const attemptBoardMove = useCallback((move: PromotionMove) => {
    const hasPromotions = legalMoves(snapshot.position).some((candidate) =>
      candidate.from === move.from && candidate.to === move.to && candidate.promotion);
    if (hasPromotions) {
      setPromotion(move);
      setFeedback('Choose a piece for promotion from ' + move.from + ' to ' + move.to + '.');
      return Promise.resolve(false);
    }
    return submitMove(move);
  }, [snapshot.position, submitMove]);

  const selectPromotion = (piece: Promotion) => {
    if (!promotion) return;
    const move = { ...promotion, promotion: piece };
    setPromotion(null);
    void submitMove(move);
    window.setTimeout(() => document.getElementById('coordinate-move')?.focus(), 0);
  };
  const submitCoordinate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const move = parseCoordinateMove(coordinate);
    if (!move) {
      setCoordinateError('Use e2e4 format.');
      return;
    }
    const matchingMoves = legalMoves(snapshot.position).filter((candidate) =>
      candidate.from === move.from && candidate.to === move.to);
    if (!matchingMoves.length) { setCoordinateError('Illegal move.'); return; }
    setCoordinateError('');
    if (matchingMoves.some((candidate) => candidate.promotion) && move.promotion === undefined) {
      setPromotion({ from: move.from, to: move.to });
      setFeedback('Promote a pawn.');
      setTool(null);
      return;
    }
    void submitMove(move).then(accepted => { if (accepted) { setTool(null); setCoordinate(''); } else setCoordinateError('Move unavailable.'); });
  };

  const revalidateSavedOpponent = async (selection: ModelSelection, identity: OpponentIdentityV1) => {
    const saved = snapshot.checkpoint.selections.players.white.kind === 'model' && snapshot.checkpoint.selections.players.black.kind === 'model'
      ? snapshot.checkpoint.selections.players[sideKey]
      : snapshot.checkpoint.selections.players.white.kind === 'model'
      ? snapshot.checkpoint.selections.players.white
      : snapshot.checkpoint.selections.players.black.kind === 'model'
        ? snapshot.checkpoint.selections.players.black : snapshot.checkpoint.selections.players[sideKey];
    if (saved.kind !== 'model' || !matchesOpponentSelection(identity, selection)) {
      setFeedback('Select a model and complete its current-session compatibility check first.');
      return;
    }
    if (!final) {
      try {
        const result = await session.controller.dispatch({
          schemaVersion: 1, kind: 'queue-model-selection',
          fence: session.controller.snapshot().fence, candidate: selection,
        });
        refresh(result.snapshot);
        if (result.kind !== 'accepted') {
          throw new Error('The game changed before the model could be queued. Check the match status and choose the model again.');
        }
        const sameAsSaved = saved.kind === 'model' && saved.connectionId === selection.connectionId &&
          saved.modelRoutingId === selection.modelRoutingId && saved.protocol === selection.protocol &&
          saved.configurationRevision === selection.configurationRevision;
        if (sameAsSaved) {
          const service = await composition.opponentService;
          service.setCommittedSelection(identity);
          service.recoverCandidate('resume-prior');
        }
      } catch (error) {
        setFeedback(error instanceof Error ? error.message : 'The model selection could not be queued.');
        return;
      }
    }
    setModelSelection(selection);
    checkedIdentities.current.set(JSON.stringify(selection), identity);
    setOpponentIdentity(identity);
    setRecoveryOpen(false);
    if (!final) setAutoGeneration(true);
    setGenerationState('idle');
    setGenerationDetail('Model ready.');
  };

  const beginPractice = async () => {
    const savedModel = snapshot.checkpoint.selections.players.white.kind === 'model'
      ? snapshot.checkpoint.selections.players.white
      : snapshot.checkpoint.selections.players.black.kind === 'model' ? snapshot.checkpoint.selections.players.black : null;
    if (!savedModel) return;
    practiceController.current?.abort();
    const abort = new AbortController(); practiceController.current = abort;
    setWorking(true);
    try {
      const store = await composition.connectionStore;
      const profile = await store.getProfile(composition.namespace, savedModel.connectionId);
      if (!profile) throw new Error('Connection removed.');
      const credentials = await store.resolveCredentials(composition.namespace, profile);
      let identity = [...checkedIdentities.current.values(), opponentIdentity].find(candidate =>
        matchesOpponentSelection(candidate, savedModel) && candidate?.configRevision === profile.configRevision &&
        credentials.status === 'bound' && candidate.credentialRevision === credentials.credentials.credentialRevision);
      const service = await composition.opponentService;
      if (!identity) {
        const result = await service.runCompatibilityDiagnostic({ profileId: profile.id, modelId: savedModel.modelRoutingId }, abort.signal);
        if (abort.signal.aborted || sessionRef.current.gameId !== session.gameId) return;
        if (result.evidence.state !== 'passed-current-session') throw new Error(result.evidence.detail);
        const prepared = await service.prepareSelection({ profileId: profile.id, modelId: savedModel.modelRoutingId });
        identity = prepared.queued?.identity ?? prepared.committed;
        if (!identity || identity.profileId !== profile.id || identity.modelId !== savedModel.modelRoutingId) throw new Error('Connection changed.');
      }
      if (abort.signal.aborted || sessionRef.current.gameId !== session.gameId) return;
      const checked = { ...savedModel, protocol: profile.protocol, configurationRevision: controllerRevisionForConfig(profile.configRevision), diagnostic: 'passed-current-session' as const };
      const practiced = await session.controller.beginPractice(session.controller.snapshot().fence, checked);
      if (abort.signal.aborted || sessionRef.current.gameId !== session.gameId) return;
      checkedIdentities.current.set(JSON.stringify(checked), identity);
      service.setCommittedSelection(identity);
      service.recoverCandidate('resume-prior');
      setModelSelection(checked); setOpponentIdentity(identity);
      refresh(practiced); setJournalRefresh(revision => revision + 1);
      setAutoGeneration(true); setGenerationState('idle'); setGenerationDetail('');
      setFeedback('Practice started.');
    } catch (error) {
      if (abort.signal.aborted) return;
      setGenerationState('failed'); setGenerationDetail(error instanceof Error ? error.message : 'Practice could not start.');
    } finally { if (practiceController.current === abort) { practiceController.current = null; setWorking(false); } }
  };

  const undo = async () => {
    setWorking(true);
    try {
      const next = await session.controller.undo(snapshot.fence);
      refresh(next);
      setJournalRefresh((revision) => revision + 1);
      setFeedback('Move undone.');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Undo is unavailable.');
    } finally { setWorking(false); }
  };

  const retryModelTurn = () => {
    generationFenceKey.current = '';
    setGenerationState('idle');
    setGenerationDetail('Retrying…');
    setAutoGeneration(true);
    setGenerationAttempt((value) => value + 1);
  };

  const recoverQueuedModel = async (action: 'retry' | 'resume') => {
    setWorking(true);
    try {
      const current = session.controller.snapshot();
      const next = action === 'retry'
        ? await session.controller.retryModelSelection(current.fence)
        : await session.controller.resumePriorModel(current.fence);
      refresh(next);
      generationFenceKey.current = '';
      setGenerationState('idle');
      setGenerationDetail(action === 'retry' ? 'Retrying…' : 'Previous model restored.');
      setAutoGeneration(true);
      setGenerationAttempt((attempt) => attempt + 1);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Model recovery could not be saved.');
    } finally { setWorking(false); }
  };

  const cancelQueuedModel = async () => {
    setWorking(true);
    try {
      const current = session.controller.snapshot();
      const next = await session.controller.cancelModelSelection(current.fence);
      refresh(next);
      const service = await composition.opponentService;
      service.recoverCandidate('resume-prior');
      generationFenceKey.current = '';
      setAutoGeneration(true);
      setGenerationAttempt((attempt) => attempt + 1);
      setFeedback('Model change cancelled.');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'The queued model could not be cancelled.');
    } finally { setWorking(false); }
  };

  const stopModelTurn = async () => {
    setAutoGeneration(false);
    try {
      const stopped = await session.controller.dispatch({
        schemaVersion: 1, kind: 'stop-model-turn', fence: session.controller.snapshot().fence,
      });
      generationController.current?.abort();
      refresh(stopped.snapshot);
      setJournalRefresh((revision) => revision + 1);
      setGenerationState('stopped');
      setGenerationDetail('Paused.');
    } catch (error) {
      setGenerationDetail(error instanceof Error ? error.message : 'The model turn could not be stopped.');
    }
  };

  const clocks = snapshot.clockReading?.remaining ?? {
    whiteMs: snapshot.checkpoint.clocks.banksAtAnchor.whiteMs,
    blackMs: snapshot.checkpoint.clocks.banksAtAnchor.blackMs,
  };
  const activeSide = snapshot.checkpoint.clocks.activeSide;
  const final = snapshot.checkpoint.result.kind === 'final';
  const sideKey = snapshot.position.sideToMove === 'w' ? 'white' : 'black';
  const activePlayer = snapshot.checkpoint.selections.players[sideKey];
  const isModelTurn = activePlayer.kind === 'model';
  const disabled = setupOpen || history.reviewing || promotion !== null || resultPrompt !== null || isLocalBoardInputDisabled(snapshot, working || isModelTurn || generationState === 'producing');
  const players = snapshot.checkpoint.selections.players;
  const spectator = players.white.kind === 'model' && players.black.kind === 'model';
  const resultActions = resultDeclarationAvailability(players, sideKey);
  const resultPromptCopy = resultPrompt !== null && resultActions.resigningSide !== null
    ? resultDeclarationCopy(resultPrompt, resultActions.resigningSide) : null;
  const resultDisabled = working || snapshot.readiness !== 'ready' || snapshot.clockReading?.status !== 'running' ||
    snapshot.checkpoint.result.kind !== 'unresolved' || history.reviewing || promotion !== null || resultActions.resigningSide === null;
  const declareResult = async (choice: ResultDeclarationChoice, resigningSide: 'white' | 'black') => {
    // Stop any provider or engine work before the final result fences this game.
    generationController.current?.abort();
    practiceController.current?.abort();
    setAutoGeneration(false);
    setWorking(true);
    try {
      const declaration: GameResultDeclarationV1 = choice === 'draw'
        ? { kind: 'draw' }
        : { kind: 'resignation', side: resigningSide };
      const result = await session.controller.declareResult(session.controller.snapshot().fence, declaration);
      refresh(result.snapshot);
      setJournalRefresh((revision) => revision + 1);
      if (result.kind === 'accepted') {
        setGenerationState('idle');
        setGenerationDetail('');
        setFeedback(choice === 'draw' ? 'Draw agreed.'
          : `${resigningSide === 'white' ? 'White' : 'Black'} resigned.`);
      } else if (result.kind === 'expired') setFeedback('Time expired.');
      else if (result.kind === 'clock-reconciliation-required') setFeedback('Checking clock…');
      else setFeedback('The game changed before the result was saved.');
    } catch (error) {
      setFeedback(conciseError(error));
    } finally { setWorking(false); }
  };
  const recoverySelection = spectator ? activePlayer : players.white.kind === 'model' ? players.white : players.black;
  const humanColor = humanSide(snapshot);
  const premoveColor = !history.reviewing && !final && !setupOpen && !promotion &&
    snapshot.readiness === 'ready' && snapshot.clockReading?.status === 'running' ? humanColor : null;
  const allowPremove = premoveColor !== null && isModelTurn && !working;
  const playerLabel = (side: 'white' | 'black') => playerName(snapshot, side);
  const finalResult = final ? resultOf(snapshot) : null;
  const finalEvent = finalEventId(snapshot);
  const finalTone = finalResult?.tone;
  useEffect(() => {
    if (finalEvent === null || finalTone === undefined || finalEvent === announcedResult.current) return;
    announcedResult.current = finalEvent;
    playResultSound(RESULT_CUES[finalTone]);
  }, [finalEvent, finalTone]);
  const archiveText = [
    ...(generationJournal?.retainedMessages.map(message => `${message.role}: ${message.content}`) ?? []),
    ...(generationJournal?.discardedMessages.map(message => `Undone ${message.role}: ${message.content}`) ?? []),
  ].join('\n\n');
  const openTool = (next: typeof tool) => { setTool(next); setFeedback(''); setCoordinateError(''); };
  const focusPage = tool !== null || recoveryOpen;
  const result = snapshot.checkpoint.result;
  const practiceOffered = result.kind === 'final' && PRACTICE_REASONS.has(result.reason) && result.winner === humanColor;
  const downloadGame = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ checkpoint: snapshot.checkpoint, conversation: generationJournal }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `chess-${session.gameId}.json`; link.click(); URL.revokeObjectURL(url);
  };
  const showEvaluation = spectator && !focusPage && !setupOpen;
  const acceptSidebarGame = ({ session: nextSession, snapshot: started, identities, draft }: StartedSidebarGame) => {
    setSetupDraft(draft);
    generationController.current?.abort();
    practiceController.current?.abort();
    for (const identity of identities) checkedIdentities.current.set(JSON.stringify(identity), identity);
    setSession(nextSession);
    setSnapshot(started);
    setOrientation(started.checkpoint.selections.players.white.kind === 'model' && started.checkpoint.selections.players.black.kind === 'human' ? 'black' : 'white');
    setCoordinate('');
    setPromotion(null);
    setResultPrompt(null);
    setAutoGeneration(true);
    setGenerationState('idle');
    setGenerationDetail('');
    setJournalRefresh(revision => revision + 1);
    setRecoveryOpen(false);
    setFeedback('New game saved.');
  };
  return <>
    <LeftGameRail tool={tool} recoveryOpen={recoveryOpen} showConversation={Object.values(players).some(player => player.kind === 'model' && !isEngineSelection(player))} menuOpen={menuOpen} onMenuOpenChange={setMenuOpen}
      onNewGame={() => openSetup()} onBoard={() => { setTool(null); setRecoveryOpen(false); }} onTool={openTool} onDownload={downloadGame} onAccount={onOpenAccount} />
    <RightGameSidebar open={setupOpen} onOpenChange={setSetupOpen} showReopenButton={false}>
      {close => <>
        <NewGameSetup key={setupRequest} composition={composition} draft={setupDraft} startingFen={setupStartingFen} focus={setupFocus} onStarted={game => { acceptSidebarGame(game); close(); }} />
        <button className="button quiet game-options-tools" type="button" onClick={() => { close(); openTool('settings'); }}>Settings</button>
      </>}
    </RightGameSidebar>
    <main className="workspace minimal-workspace" id="main">
    {!focusPage && <header className="topbar">
      <a className="wordmark" href="/" aria-label="Kamkm Chess home">kamkm chess</a>
      <div className="topbar-actions">
        <IconButton icon="menu" label="Open menu" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)} />
        <button className="button primary" type="button" onClick={() => openSetup()} aria-label="New game">New</button></div>
    </header>}
    {tool && <section className="focus-page" aria-label="Match tools">
      <div className="panel-heading"><h2>{tool === 'move' ? 'Move' : tool.charAt(0).toUpperCase() + tool.slice(1)}</h2><IconButton icon="close" label="Close" onClick={() => setTool(null)} /></div>
      {tool === 'settings' && <div className="connection-form">
        <label>Theme<select value={theme} onChange={event => setTheme(event.target.value)}>{T3_PALETTES.map(palette => <option key={palette.id} value={palette.id}>{palette.label}</option>)}</select></label>
        <label>Appearance<select value={appearance} onChange={event => setAppearance(event.target.value)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
        <label>Sound<select value={sound ? 'on' : 'off'} onChange={event => { const enabled = event.target.value === 'on'; setSound(enabled); setSoundEnabled(enabled); }}><option value="on">On</option><option value="off">Off</option></select></label>
        <div className="button-row"><IconButton icon="board" label="Position" onClick={() => openTool('position')} /><IconButton icon="archive" label="Conversation and archive" onClick={() => openTool('archive')} /><IconButton icon="download" label="Download game (JSON)" onClick={downloadGame} /></div>
        <div className="settings-links"><a href="/#questions">Help</a><a href={PROJECT_URL}>Project</a></div>
      </div>}
      {tool === 'move' && <form className="coordinate-form" onSubmit={submitCoordinate}><label className="sr-label" htmlFor="coordinate-move">Enter a move by coordinates</label><input id="coordinate-move" aria-label="Enter a move by coordinates" value={coordinate} onChange={event => { setCoordinate(event.target.value); setCoordinateError(''); }} placeholder="e2e4" autoComplete="off" autoCapitalize="none" spellCheck={false} enterKeyHint="go" /><button className="button primary" type="submit" aria-label="Play move" disabled={disabled}>Play</button>{coordinateError && <p role="alert">{coordinateError}</p>}</form>}
      {tool === 'position' && <><p className="fen-value">{history.position.fen}</p><IconButton icon="board" label="New game from here" onClick={() => openSetup(history.position.fen)} /></>}
      {tool === 'archive' && <pre className="archive-page">{archiveText || 'No conversation yet.'}</pre>}
    </section>}
    {recoveryOpen && !setupOpen && !tool && <section className="focus-page" aria-label={isEngineSelection(recoverySelection) ? "Choose another engine" : "Choose another model"}>
      <div className="focus-nav"><IconButton icon="close" label="Close" onClick={() => setRecoveryOpen(false)} /></div>
      {isEngineSelection(recoverySelection) ? <EnginePanel key={`recovery-${sideKey}`} label="Engine setup" selected={recoverySelection} onSelect={selection => {
        if (!selection) return;
        void session.controller.queueModelSelection(session.controller.snapshot().fence, selection).then(next => { refresh(next); setRecoveryOpen(false); generationFenceKey.current = ''; setGenerationState('idle'); setAutoGeneration(true); setGenerationAttempt(attempt => attempt + 1); }).catch(error => setFeedback(conciseError(error)));
      }} /> : <OpponentPanel service={composition.opponentService} connectionStore={composition.connectionStore} namespace={composition.namespace} selected={recoverySelection.kind === 'model' ? recoverySelection : modelSelection} onSelect={revalidateSavedOpponent} />}
    </section>}
    <div className="match-layout" hidden={focusPage} data-practice={snapshot.checkpoint.practice.mode} data-committed-model={snapshot.modelHandoff.committed?.modelRoutingId} data-queued-model={snapshot.modelHandoff.queued?.selection.modelRoutingId}>
      <section className="board-column" id="board" ref={boardPanel} tabIndex={-1} aria-label="Chess match board">
        {(['black', 'white'] as const).map(side => <div key={side} className={`player-row ${side} ${side === orientation ? 'near-player' : 'far-player'} ${activeSide === side ? 'active' : ''}`}>
          <OpponentBadge player={players[side]} side={side} /><div className="player-name"><strong title={playerLabel(side)}>{playerLabel(side)}</strong></div>
          <time className={`clock ${activeSide === side ? 'running' : ''}`} data-low={clocks[`${side}Ms`] < 20_000 || undefined} aria-label={`${side} clock ${formatClock(clocks[`${side}Ms`])}`}>{formatClock(clocks[`${side}Ms`])}</time>
        </div>)}
        <div className={`playing-board${showEvaluation ? ' with-evaluation' : ''}`}>
          {showEvaluation && <EvaluationBar key={session.gameId} orientation={orientation} startingFen={snapshot.checkpoint.rules.startingFen}
            moves={snapshot.checkpoint.rules.moves.slice(0, history.ply).map(move => `${move.from}${move.to}${move.promotion ?? ''}`).join(' ')} />}
          <ChessBoard orientation={orientation} snapshot={snapshot} disabled={disabled} visible={!focusPage} onMove={attemptBoardMove} view={history} premoveColor={premoveColor} allowPremove={allowPremove} />
          {promotion && <section className="promotion-panel" aria-label="Promotion"><div className="promotion-options">{PROMOTIONS.map(piece => <button className="button quiet" type="button" key={piece.value} aria-label={piece.label} autoFocus={piece.value === 'q'} onClick={() => selectPromotion(piece.value)}><img alt="" width="36" height="36" src={pieceImage(snapshot.position.sideToMove, piece.value)} /></button>)}<IconButton icon="close" label="Cancel promotion" onClick={() => setPromotion(null)} /></div></section>}
        </div>
        <nav hidden={setupOpen} className="board-tools" aria-label="Board tools"><IconButton icon="flip" label="Flip board" onClick={() => setOrientation(side => side === 'white' ? 'black' : 'white')} />
          <IconButton icon="undo" label="Undo" onClick={() => void undo()} disabled={working || snapshot.readiness !== 'ready' || !snapshot.checkpoint.rules.moves.length || snapshot.checkpoint.result.kind !== 'unresolved'} />
          <IconButton icon="keyboard" label="Type a move" disabled={disabled} onClick={() => openTool('move')} />
          {resultActions.resigningSide !== null && <>
            <IconButton icon="draw" label="Agree a draw" disabled={resultDisabled} onClick={event => {
              resultTrigger.current = event.currentTarget;
              resultConfirmed.current = false;
              setResultPrompt('draw');
            }} />
            <IconButton icon="resign" label="Resign game" disabled={resultDisabled} onClick={event => {
              resultTrigger.current = event.currentTarget;
              resultConfirmed.current = false;
              setResultPrompt('resignation');
            }} />
          </>}
          <div className="mobile-history-tools">
            <IconButton icon="back" label="Previous move" disabled={history.ply === 0} onClick={() => history.select(history.ply - 1)} />
            <IconButton icon="next" label="Next move" disabled={!history.reviewing} onClick={() => history.select(history.ply + 1)} />
            <IconButton icon="moves" label="Show moves" aria-controls="moves-panel" onClick={() => { movesPanel.current?.focus({ preventScroll: true }); movesPanel.current?.scrollIntoView({ block: 'start' }); }} />
          </div>
        </nav>
        <div className="match-status" data-tone={finalResult?.tone} role="status" aria-description={finalResult ? undefined : generationDetail || feedback}>
          <div className="status-result">
            <h2 ref={resultStatus} tabIndex={-1} className="status-heading" aria-label={!finalResult && generationState === 'producing' ? isEngineSelection(activePlayer) ? 'Engine is choosing a move' : 'AI is choosing a move' : undefined}>{finalResult ? finalResult.headline : history.reviewing ? `${history.ply}/${history.count}` : generationState === 'stopped' ? 'Paused' : generationState === 'failed' ? conciseTurnError(new Error(generationDetail)) : generationState === 'producing' ? generationDetail === 'Checking connection…' ? 'Checking…' : 'Thinking…' : statusLabel(snapshot)}</h2>
            {finalResult?.detail ? <p className="status-detail">{finalResult.detail}</p> : null}
          </div>
          <div className="button-row">
            {!final && generationState === 'producing' && <IconButton icon="stop" label="Stop generation" onClick={() => void stopModelTurn()} />}
            {isModelTurn && !autoGeneration && !final && generationState === 'idle' && <IconButton icon="play" label={isEngineSelection(activePlayer) ? "Resume engine turn" : "Resume model turn"} onClick={retryModelTurn} />}
            {!final && (generationState === 'failed' || generationState === 'stopped') && isModelTurn && <>
              <IconButton icon="play" label={snapshot.modelHandoff.queued?.state === "failed" ? "Retry queued model" : isEngineSelection(activePlayer) ? "Retry engine turn" : "Retry model request"} onClick={() => { if (snapshot.modelHandoff.queued?.state === 'failed') void recoverQueuedModel('retry'); else retryModelTurn(); }} />
              {snapshot.modelHandoff.queued?.state === 'failed' && <IconButton icon="undo" label="Resume previous model" onClick={() => void recoverQueuedModel('resume')} />}
            </>}
            {!final && Object.values(players).some(player => player.kind === 'model') && <IconButton icon="change" label={isEngineSelection(recoverySelection) ? "Choose another engine" : "Choose another model"} onClick={() => setRecoveryOpen(true)} />}
            {snapshot.modelHandoff.queued && <IconButton icon="close" label="Cancel queued model" onClick={() => void cancelQueuedModel()} />}
            {practiceOffered && !spectator && !Object.values(players).some(isEngineSelection) && Object.values(players).some(player => player.kind === 'model') && <IconButton icon="play" label="Start practice from this position" disabled={working} onClick={() => void beginPractice()} />}
          </div>
        </div>
      </section>
      <aside className="moves-sidebar" id="moves-panel" ref={movesPanel} tabIndex={-1} aria-labelledby="moves-title">
        {finalResult && <GameResultCard result={finalResult} onNewGame={() => openSetup()} />}
        <div className="moves-heading"><h2 id="moves-title">Moves</h2><span className="count" aria-label={`Move ${history.ply} of ${history.count}`}>{history.ply}/{history.count}</span>
          <span className="mobile-board-return"><IconButton icon="board" label="Show board" aria-controls="board" onClick={() => { boardPanel.current?.focus({ preventScroll: true }); boardPanel.current?.scrollIntoView({ block: 'start' }); }} /></span>
        </div>
        <MoveList moves={snapshot.checkpoint.rules.moves} selectedPly={history.ply} visible={!focusPage} onSelect={history.select} />
        <nav hidden={setupOpen} className="history-controls" aria-label="Move history"><div className="button-row">
          <IconButton icon="first" label="First" onClick={() => history.select(0)} disabled={history.ply === 0} aria-keyshortcuts="Home" />
          <IconButton icon="back" label="Previous" onClick={() => history.select(history.ply - 1)} disabled={history.ply === 0} aria-keyshortcuts="ArrowLeft" />
          <IconButton icon="next" label="Next" onClick={() => history.select(history.ply + 1)} disabled={!history.reviewing} aria-keyshortcuts="ArrowRight" />
          <IconButton icon="last" label="Live" onClick={() => history.select(history.count)} disabled={!history.reviewing} aria-keyshortcuts="End" />
        </div></nav>
      </aside>
    </div>
    <p className="sr-only" role="status" aria-live="polite">{feedback}</p>
  </main>
  <AlertDialog.Root open={resultPrompt !== null} onOpenChange={open => { if (!open) setResultPrompt(null); }}>
    {resultPromptCopy !== null && resultActions.resigningSide !== null &&
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="result-dialog-backdrop" />
        <AlertDialog.Popup className="result-dialog"
          initialFocus={keepPlaying}
          finalFocus={() => !resultConfirmed.current && resultTrigger.current?.isConnected
            ? resultTrigger.current : resultStatus.current}>
          <AlertDialog.Title>{resultPromptCopy.title}</AlertDialog.Title>
          <AlertDialog.Description>{resultPromptCopy.description}</AlertDialog.Description>
          <div className="button-row result-dialog-actions">
            <AlertDialog.Close ref={keepPlaying} render={<button className="button secondary" type="button" />}>{resultPromptCopy.cancelLabel}</AlertDialog.Close>
            <AlertDialog.Close render={<button className="button primary" type="button" />} onClick={() => {
              const choice = resultPrompt;
              const resigningSide = resultActions.resigningSide;
              resultConfirmed.current = true;
              if (choice !== null && resigningSide !== null) void declareResult(choice, resigningSide);
            }}>{resultPromptCopy.confirmLabel}</AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>}
  </AlertDialog.Root>
  </>;
}
