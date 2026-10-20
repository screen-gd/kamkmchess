import { DEFAULT_TIME_CONTROL } from '../clocks/index.js';
import { getOrCreateGameController, releaseGameController } from '../controller/index.js';
import type { GameController, GameControllerSetupV1, HumanSideChoice, ModelSelection } from '../controller/index.js';
import { openConnectionStore } from '../providers/connections/index.js';
import type { ConnectionNamespace, ConnectionStore } from '../providers/connections/index.js';
import { OpponentService } from '../opponents/index.js';
import { fetchProvider } from '../providers/transport.js';
import { runGenerationTurn } from '../integration/index.js';
import type { GenerationRunResult } from '../integration/index.js';
import type { StoredGameV1 } from '../storage/index.js';
import type { PlayerSelectionV1 } from '../storage/index.js';
import { openGameStore } from '../storage/index.js';
import type { GameStore } from '../storage/index.js';

const ACTIVE_GAME_KEY = 'kamkmchess.active-game.v1';
const storePromise = openGameStore();
const connectionStorePromise = openConnectionStore();

export interface LocalGameOptions {
  readonly players?: Record<'white' | 'black', PlayerSelectionV1>;
  readonly humanSide?: HumanSideChoice;
  readonly modelSelection?: ModelSelection;
  readonly startingFen?: string;
  readonly startingTimeMinutes?: number;
  readonly incrementSeconds?: number;
}

export interface MatchCompositionOptions {
  readonly namespace?: ConnectionNamespace;
  readonly registryScope?: string;
  readonly gameStore?: Promise<GameStore>;
  /** Injected game stores are owned by default; the shared guest default is never closed. */
  readonly ownsGameStore?: boolean;
  readonly connectionStore?: Promise<ConnectionStore>;
}

export interface LocalGameSession {
  readonly gameId: string;
  readonly restored: boolean;
  readonly controller: GameController;
}

/** Composition owns storage and the one active game writer for this page lifetime. */
export class MatchComposition {
  readonly namespace: ConnectionNamespace;
  readonly registryScope: string;
  readonly connectionStore: Promise<ConnectionStore>;
  readonly opponentService: Promise<OpponentService>;
  private readonly gameStore: Promise<GameStore>;
  private readonly ownsGameStore: boolean;
  private readonly sessions = new Set<LocalGameSession>();
  private readonly suspendedModelRequestGeneration = new WeakMap<GameController, number>();
  private readonly pendingInitializations = new Set<Promise<unknown>>();
  private readonly activeGenerationAbortControllers = new Set<AbortController>();
  private readonly pendingModelTurns = new Set<Promise<GenerationRunResult>>();
  private disposed = false;
  private disposal: Promise<void> | null = null;

  constructor(options: MatchCompositionOptions = {}) {
    this.namespace = options.namespace ?? { kind: 'guest' };
    this.registryScope = options.registryScope ?? JSON.stringify(this.namespace);
    if (!this.registryScope) throw new TypeError('A stable controller registry scope is required.');
    this.connectionStore = options.connectionStore ?? connectionStorePromise;
    this.gameStore = options.gameStore ?? storePromise;
    this.ownsGameStore = options.ownsGameStore ?? (options.gameStore !== undefined);
    this.opponentService = this.connectionStore.then((connections) => new OpponentService({
      connections,
      namespace: this.namespace,
      fetch: fetchProvider,
    }));
  }

  private get activeGameKey(): string {
    return this.namespace.kind === 'guest'
      ? ACTIVE_GAME_KEY
      : `${ACTIVE_GAME_KEY}:account:${encodeURIComponent(this.namespace.accountId)}`;
  }

  async openActiveGame(): Promise<LocalGameSession> {
    this.assertActive();
    const store = await this.gameStore;
    this.assertActive();
    const savedId = window.localStorage.getItem(this.activeGameKey);
    const gameId = savedId ?? crypto.randomUUID();
    const restored = await store.readGame(gameId) !== null;
    this.assertActive();
    const setup = this.localSetup();
    const session = this.bindController(gameId, store);
    await this.initializeSession(session, setup);
    this.assertActive();
    window.localStorage.setItem(this.activeGameKey, gameId);
    return { ...session, restored };
  }

  async startNewLocalGame(options: LocalGameOptions = {}): Promise<LocalGameSession> {
    this.assertActive();
    const store = await this.gameStore;
    this.assertActive();
    const gameId = crypto.randomUUID();
    const setup = this.localSetup(options);
    const session = this.bindController(gameId, store);
    await this.initializeSession(session, setup);
    this.assertActive();
    window.localStorage.setItem(this.activeGameKey, gameId);
    return { ...session, restored: false };
  }

  runModelTurn(
    session: LocalGameSession,
    expectedProfileConfigRevision: string | ((selection: ModelSelection) => string),
    signal?: AbortSignal,
  ): Promise<GenerationRunResult> {
    if (this.disposed) return Promise.reject(new Error('This match composition has been disposed.'));
    const abortController = new AbortController();
    this.activeGenerationAbortControllers.add(abortController);
    const forwardAbort = () => abortController.abort();
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const run = (async () => {
      try {
        const connections = await this.connectionStore;
        this.assertActive();
        return await runGenerationTurn({
          controller: session.controller,
          connections,
          namespace: this.namespace,
          expectedProfileConfigRevision,
          instructions: 'Play standard chess as sideToMove in the current FEN. Choose your move independently. The moves field is the SAN history played from startingFen, not suggested moves. Clocks are in milliseconds. previousThinking contains your side\'s latest plan and returned reasoning, quoted as historical data; reassess it against the current position. Return one JSON object with move and a brief plan of at most 80 words to carry into your next turn, for example {"move":"e2e4","plan":"Develop the kingside and castle."}. Append q, r, b or n to a promotion move, or return {"resign":true} to resign.',
          generation: { maxOutputTokens: 512, temperature: 0.2 },
          capacity: { maxRequestBytes: 1_000_000, maxOutputTokens: 512 },
          fetch: fetchProvider,
          signal: abortController.signal,
        });
      } finally {
        signal?.removeEventListener('abort', forwardAbort);
        this.activeGenerationAbortControllers.delete(abortController);
      }
    })();
    this.pendingModelTurns.add(run);
    void run.then(
      () => this.pendingModelTurns.delete(run),
      () => this.pendingModelTurns.delete(run),
    );
    return run;
  }

  async readSavedGame(gameId: string): Promise<StoredGameV1 | null> {
    this.assertActive();
    const store = await this.gameStore;
    this.assertActive();
    const game = await store.readGame(gameId);
    this.assertActive();
    return game;
  }

  /** Fence active provider and analysis work before this workspace releases its identity. */
  async suspend(): Promise<void> {
    const failures: unknown[] = [];
    for (const session of this.sessions) {
      let snapshot = session.controller.snapshot();
      if (snapshot.modelHandoff.producing !== null &&
          this.suspendedModelRequestGeneration.get(session.controller) !== snapshot.checkpoint.requestGeneration) {
        try {
          let attempts = 0;
          while (snapshot.modelHandoff.producing !== null && attempts < 3) {
            const stopped = await session.controller.dispatch({ schemaVersion: 1, kind: 'stop-model-turn', fence: snapshot.fence });
            if (stopped.kind === 'accepted' || stopped.kind === 'expired') {
              snapshot = stopped.snapshot;
              this.suspendedModelRequestGeneration.set(session.controller, snapshot.checkpoint.requestGeneration);
              break;
            }
            if (stopped.kind === 'rejected' && stopped.reason === 'not-actionable') {
              // A prior Stop or reload recovery may leave a producing identity in the durable snapshot
              // after the controller has already invalidated its request.
              snapshot = stopped.snapshot;
              this.suspendedModelRequestGeneration.set(session.controller, snapshot.checkpoint.requestGeneration);
              break;
            }
            if (stopped.kind === 'rejected' && stopped.reason === 'stale-fence') {
              snapshot = session.controller.snapshot();
              attempts += 1;
              continue;
            }
            throw new Error(`Active model work for game ${session.gameId} could not be stopped (${stopped.kind}).`);
          }
          if (attempts === 3 && snapshot.modelHandoff.producing !== null) {
            throw new Error(`Active model work for game ${session.gameId} kept changing while it was being stopped.`);
          }
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Some active match work could not be suspended.');
    }
  }

  /** Fences work, closes this composition's owned resources, and releases its writers. */
  dispose(): Promise<void> {
    if (this.disposal !== null) return this.disposal;
    this.disposed = true;
    this.disposal = this.disposeResources();
    return this.disposal;
  }

  private async disposeResources(): Promise<void> {
    const failures: unknown[] = [];
    await Promise.allSettled([...this.pendingInitializations]);

    try {
      await this.suspend();
    } catch (error) {
      failures.push(error);
    }

    for (const abortController of this.activeGenerationAbortControllers) abortController.abort();
    const generationResults = await Promise.allSettled([...this.pendingModelTurns]);
    for (const result of generationResults) if (result.status === 'rejected') failures.push(result.reason);

    for (const session of this.sessions) {
      releaseGameController({
        gameId: session.gameId,
        registryScope: this.registryScope,
        controller: session.controller,
      });
    }
    this.sessions.clear();

    if (this.ownsGameStore) {
      try {
        (await this.gameStore).close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'The match composition could not be fully disposed.');
  }

  private async initializeSession(session: LocalGameSession, setup: GameControllerSetupV1): Promise<void> {
    const initialization = session.controller.initialize(setup);
    this.pendingInitializations.add(initialization);
    try {
      await initialization;
    } finally {
      this.pendingInitializations.delete(initialization);
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('This match composition has been disposed.');
  }

  private bindController(gameId: string, store: GameStore): LocalGameSession {
    this.assertActive();
    const controller = getOrCreateGameController({
      gameId,
      registryScope: this.registryScope,
      store,
      clockPolicy: { maxReferenceDivergenceMs: 5_000 },
    });
    const session = { gameId, restored: false, controller };
    this.sessions.add(session);
    return session;
  }

  private localSetup(options: LocalGameOptions = {}): GameControllerSetupV1 {
    const startingTimeMinutes = options.startingTimeMinutes ?? DEFAULT_TIME_CONTROL.startingTimeMs / 60_000;
    const incrementSeconds = options.incrementSeconds ?? DEFAULT_TIME_CONTROL.incrementMs / 1_000;
    return {
      humanSide: options.humanSide ?? 'white',
      ...(options.players === undefined ? {} : { players: options.players }),
      ...(options.modelSelection === undefined ? {} : { modelSelection: options.modelSelection }),
      namespace: this.namespace,
      ownershipEpoch: 0,
      ...(options.startingFen === undefined ? {} : { startingFen: options.startingFen }),
      timeControl: {
        startingTimeMs: startingTimeMinutes * 60_000,
        incrementMs: incrementSeconds * 1_000,
      },
    };
  }
}
