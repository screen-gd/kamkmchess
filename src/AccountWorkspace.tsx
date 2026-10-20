import { IconButton } from './ui/Icon.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { accountGameDatabaseName, createAccountSession, createIndexedDbAccountData, readClerkRuntimeConfig } from './accounts/index.js';
import type { AccountIdentity, AccountSession, GuestGameSummary } from './accounts/index.js';
import { createCloudCoordination, createCloudSyncManager, createIndexedDbCloudLocal, GoCloudClient, readCloudRuntimeConfig } from './cloud/index.js';
import { openGameStore } from './storage/index.js';
import type { ControllerSnapshotV1 } from './controller/index.js';
import { App } from './ui/App.js';
import { AccountPanel } from './ui/AccountPanel.js';
import { ProfilePanel } from './ui/ProfilePanel.js';
import { MatchComposition } from './ui/match-composition.js';
import type { LocalGameSession } from './ui/match-composition.js';
import { createProfileClient } from './profile/client.js';
import type { GuestSeatBinding } from './profile/client.js';
import { createProfileIdentityTracker } from './profile/identity.js';
import type { ProfileIdentityBinding, ProfileIdentityTracker } from './profile/identity.js';
import { createParticipantSession } from './online/session.js';
import type { ParticipantSession } from './online/session.js';
import type { GuestOnlineCredential } from './online/auth.js';
import { publicConfig } from './public-config.js';
import './account-workspace.css';

interface WorkspaceView {
  readonly composition: MatchComposition;
  readonly initialSession: LocalGameSession;
  readonly initialSnapshot: ControllerSnapshotV1;
}

const repositories = createIndexedDbAccountData();
const accountCompositions = new Map<string, MatchComposition>();
const retiringCompositions = new Map<string, Promise<void>>();

async function releaseAccountCompositions(keep?: MatchComposition): Promise<void> {
  const pending = [...retiringCompositions.values()];
  for (const [key, composition] of accountCompositions) {
    if (composition === keep) continue;
    accountCompositions.delete(key);
    const retirement = composition.dispose().finally(() => retiringCompositions.delete(key));
    retiringCompositions.set(key, retirement);
    pending.push(retirement);
  }
  await Promise.all(pending);
}

/** Mounted only by an explicitly configured account build. Guest startup stays local. */
export function AccountWorkspace(initialView: WorkspaceView) {
  const [accountPage, setAccountPage] = useState<'account' | 'games' | 'profile' | null>(null);
  const [gamePage, setGamePage] = useState(0);
  const [guestView] = useState(initialView);
  const guestResumeView = useRef(guestView);
  const [session, setSession] = useState<AccountSession | null>(null);
  const [identity, setIdentity] = useState<AccountIdentity | null>(null);
  const [guestCredential, setGuestCredential] = useState<GuestOnlineCredential | null>(null);
  const [view, setView] = useState<WorkspaceView>(guestView);
  const [games, setGames] = useState<readonly GuestGameSummary[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [conflicts, setConflicts] = useState<Record<string, { revision: number; epoch: number }>>({});
  const activeRequests = useRef(new Set<AbortController>());
  const accountSession = useRef<AccountSession | null>(null);
  const participantSession = useRef<ParticipantSession | null>(null);
  const identityGeneration = useRef(0);
  const activeView = useRef(view);
  const profileIdentities = useRef<ProfileIdentityTracker | null>(null);
  const identityRef = useRef<AccountIdentity | null>(null);
  const guestCredentialRef = useRef<GuestOnlineCredential | null>(null);
  const [profileIdentity, setProfileIdentity] = useState<ProfileIdentityBinding | null>(null);
  useEffect(() => { activeView.current = view; }, [view]);

  useEffect(() => {
    const requests = activeRequests.current;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeParticipant: (() => void) | undefined;
    let initialized: AccountSession | null = null;
    const clearProfileIdentity = () => {
      if (cancelled) return;
      identityRef.current = null;
      const identities = profileIdentities.current;
      if (identities) setProfileIdentity(identities.update(null, guestCredentialRef.current));
    };
    void (async () => {
      const credentials = await guestView.composition.connectionStore;
      const created = await createAccountSession({
        config: readClerkRuntimeConfig({ publishableKey: publicConfig.clerkPublishableKey }),
        credentials,
        fence: {
          async fencePendingRequests() {
            clearProfileIdentity();
            identityGeneration.current += 1;
            for (const request of activeRequests.current) request.abort();
            activeRequests.current.clear();
            await releaseAccountCompositions();
          },
          clearInMemoryIdentity() { if (!cancelled) { setIdentity(null); clearProfileIdentity(); } },
          hidePrivateViews() { if (!cancelled) { setGames([]); setView(guestResumeView.current); } },
        },
      });
      if (cancelled) { created.dispose(); return; }
      initialized = created;
      accountSession.current = created;
      setSession(created);
      // The profile surface is bound to the signed-in account and to the
      // guest seat this browser holds. A new account makes a new binding and
      // fences the old one, so a call started under the previous account is
      // settled and discarded instead of publishing under the new one.
      const identities = createProfileIdentityTracker();
      profileIdentities.current = identities;
      const publishIdentity = () => {
        if (cancelled) return;
        setProfileIdentity(identities.update(identityRef.current, guestCredentialRef.current));
      };
      // The account subscription is registered first, so a session change
      // reaches the binding before the participant session reports it.
      unsubscribe = created.subscribe((next) => {
        if (cancelled) return;
        identityGeneration.current += 1;
        for (const request of activeRequests.current) request.abort();
        identityRef.current = next;
        setIdentity(next);
        setGames([]);
        setConflicts({});
        setView(guestResumeView.current);
        setRevision((value) => value + 1);
        publishIdentity();
      });
      // The participant session holds the guest seat credential, if this
      // browser controls one. It never merges into the signed-in account.
      const participants = createParticipantSession({ accountSession: created });
      participantSession.current = participants;
      unsubscribeParticipant = participants.subscribe((state) => {
        if (cancelled) return;
        const credential = state.credential;
        guestCredentialRef.current = credential && credential.kind === 'guest' ? credential : null;
        setGuestCredential(guestCredentialRef.current);
        publishIdentity();
      });
    })().catch((error: unknown) => { if (!cancelled) setMessage(errorText(error)); });
    return () => {
      cancelled = true;
      unsubscribe?.();
      unsubscribeParticipant?.();
      participantSession.current?.dispose();
      participantSession.current = null;
      initialized?.dispose();
      identityGeneration.current += 1;
      for (const request of requests) request.abort();
      // Disposing the workspace fences every profile call that is still in
      // flight, so a pending answer settles instead of hanging.
      profileIdentities.current?.dispose();
      profileIdentities.current = null;
      identityRef.current = null;
      guestCredentialRef.current = null;
      void releaseAccountCompositions().catch(() => undefined);
    };
  }, [guestView]);

  // The public profile client. It needs the service origin and the identity
  // binding it acts for; without them there is no profile surface to show.
  // The client is bound to the binding, so a new account makes a new client
  // and the old one can never answer for the new account.
  const profileClient = useMemo(() => {
    if (!publicConfig.apiBaseUrl || !profileIdentity?.account) return null;
    return createProfileClient({ baseUrl: publicConfig.apiBaseUrl, identity: profileIdentity });
  }, [profileIdentity]);

  // The guest seat this browser controls, when there is one.
  const guestSeat = useMemo<GuestSeatBinding | null>(
    () => (guestCredential ? { matchId: guestCredential.matchId, seat: guestCredential.seat } : null),
    [guestCredential],
  );

  /**
   * What the profile page shows.
   *
   * A signed-out browser and a browser in the middle of a session change ask
   * for a sign-in. Only a build without a service origin says that the
   * profile service is not configured.
   */
  const profileSurface = !publicConfig.apiBaseUrl
    ? <p>The profile service is not configured.</p>
    : !session
      ? <p>Loading…</p>
      : profileClient
        ? <ProfilePanel key={profileIdentity?.generation ?? 'signed-out'} client={profileClient} guestSeat={guestSeat} />
        : <p>Sign in to edit your profile.</p>;

  useEffect(() => {
    if (!identity) return;
    let current = true;
    void repositories.listAccountGames(identity.accountId).then((next) => {
      if (current) setGames(next);
    }).catch((error: unknown) => { if (current) setMessage(errorText(error)); });
    return () => { current = false; };
  }, [identity, revision]);

  async function compositionFor(accountId: string, generation: number, gameId?: string): Promise<MatchComposition> {
    const databaseName = gameId ? await repositories.resolveActiveGameDatabaseName(accountId, gameId) : accountGameDatabaseName(accountId);
    const cacheKey = JSON.stringify([accountId, databaseName]);
    await retiringCompositions.get(cacheKey);
    if (accountSession.current?.identity?.accountId !== accountId || identityGeneration.current !== generation) {
      throw new Error('The signed-in account changed. Open the workspace again.');
    }
    let composition = accountCompositions.get(cacheKey);
    if (!composition) {
      composition = new MatchComposition({
        namespace: { kind: 'account', accountId },
        registryScope: JSON.stringify({ namespace: { kind: 'account', accountId }, databaseName }),
        gameStore: openGameStore({ databaseName, syncConfigured: true }),
        connectionStore: guestView.composition.connectionStore,
      });
      accountCompositions.set(cacheKey, composition);
    }
    return composition;
  }

  async function openAccountGame(gameId?: string) {
    if (!identity) return;
    const owner = identity.accountId;
    const generation = identityGeneration.current;
    setBusy(true);
    try {
      if (activeView.current.composition.namespace.kind === 'guest') {
        await guestView.composition.suspend();
        const guestSession = await guestView.composition.openActiveGame();
        guestResumeView.current = { composition: guestView.composition, initialSession: guestSession, initialSnapshot: await guestSession.controller.reconcile() };
      } else await activeView.current.composition.suspend();
      const selectedId = gameId ?? window.localStorage.getItem(`kamkmchess.active-game.v1:account:${encodeURIComponent(owner)}`) ?? undefined;
      if (selectedId && await createIndexedDbCloudLocal({ accountId: owner, games: repositories }).pendingTakeoverAdoption(selectedId)) {
        throw new Error('This game has an unfinished cloud takeover. Use Sync game to finish recovery before opening it.');
      }
      const composition = await compositionFor(owner, generation, selectedId);
      if (gameId) window.localStorage.setItem(`kamkmchess.active-game.v1:account:${encodeURIComponent(owner)}`, gameId);
      const initialSession = await composition.openActiveGame();
      const initialSnapshot = await initialSession.controller.reconcile();
      if (accountSession.current?.identity?.accountId !== owner || identityGeneration.current !== generation) return;
      await releaseAccountCompositions(composition);
      if (accountSession.current?.identity?.accountId !== owner || identityGeneration.current !== generation) return;
      activeView.current = { composition, initialSession, initialSnapshot };
      setView({ composition, initialSession, initialSnapshot });
      setMessage('Account game opened. AI connections must be configured separately for this account.');
    } catch (error) { if (identityGeneration.current === generation) setMessage(errorText(error)); }
    finally { setBusy(false); }
  }

  async function openGuestWorkspace() {
    setBusy(true);
    try {
      await releaseAccountCompositions();
      const initialSession = await guestView.composition.openActiveGame();
      const initialSnapshot = await initialSession.controller.reconcile();
      const next = { composition: guestView.composition, initialSession, initialSnapshot };
      guestResumeView.current = next;
      activeView.current = next;
      setView(next);
      setMessage('Guest workspace opened. Account games remain separate.');
    } catch (error) { setMessage(errorText(error)); }
    finally { setBusy(false); }
  }

  async function syncGame(gameId: string, action: 'sync' | 'takeover' = 'sync') {
    if (!identity || !publicConfig.apiBaseUrl) return;
    const owner = identity.accountId;
    const generation = identityGeneration.current;
    const abort = new AbortController();
    activeRequests.current.add(abort);
    setBusy(true);
    const coordination = createCloudCoordination({ databaseName: `kamkmchess-coordination-${encodeURIComponent(owner)}` });
    try {
      const connections = await guestView.composition.connectionStore;
      const local = createIndexedDbCloudLocal({
        accountId: owner,
        games: repositories,
        knownCredentials: () => connections.snapshotKnownCredentials({ kind: 'account', accountId: owner }),
      });
      const client = new GoCloudClient({
        accountId: owner,
        config: readCloudRuntimeConfig({ apiBaseUrl: publicConfig.apiBaseUrl }),
        async getToken() {
          const active = accountSession.current?.identity;
          if (!active || active.accountId !== owner || identityGeneration.current !== generation) throw new Error('The signed-in account changed.');
          return active.token();
        },
        fetcher: (input, init) => fetch(input, { ...init, signal: abort.signal }),
      });
      const metadata = await local.readMetadata(gameId);
      const manager = createCloudSyncManager({
        accountId: owner, client, coordination, local,
        async beforeTakeoverAdoption() {
          if (identityGeneration.current !== generation) throw new Error('The signed-in account changed.');
          await releaseAccountCompositions();
          if (identityGeneration.current !== generation) throw new Error('The signed-in account changed.');
        },
      });
      const head = conflicts[gameId];
      if (action === 'takeover' && !head) throw new Error('Refresh the cloud conflict before taking over.');
      if (action === 'takeover' && activeView.current.composition.namespace.kind === 'account') await activeView.current.composition.suspend();
      const result = action === 'takeover' && head
        ? await manager.takeover(gameId, head.revision, head.epoch)
        : await manager.sync(gameId, metadata?.acknowledgedRevision ?? null, metadata?.ownershipEpoch ?? 0);
      if (identityGeneration.current !== generation) return;
      if (result.kind === 'conflict' && result.conflict.cloud) {
        setConflicts((current) => ({ ...current, [gameId]: { revision: result.conflict.cloud!.revision, epoch: result.conflict.cloud!.epoch } }));
      }
      if (result.kind === 'synced' && result.adopted) {
        setConflicts((current) => { const next = { ...current }; delete next[gameId]; return next; });
        await openAccountGame(gameId);
        setMessage('The accepted cloud game is open. Your previous local continuation remains saved separately.');
        setRevision((value) => value + 1);
        return;
      }
      setMessage(result.kind === 'synced' ? 'Complete game and archive saved to your account.' : result.kind === 'conflict'
        ? 'Cloud history changed. Your local continuation and the cloud snapshot were preserved separately. No history was overwritten.' : result.message);
    } catch (error) { if (identityGeneration.current === generation) setMessage(errorText(error)); }
    finally { coordination.close(); activeRequests.current.delete(abort); setBusy(false); }
  }

  return <>
    {accountPage && <section className="focus-page account-workspace" aria-label="Account and saved games">
      <div className="panel-heading"><IconButton icon="back" label="Back" onClick={() => setAccountPage('account')} disabled={accountPage === 'account'} /><IconButton icon="close" label="Close account" onClick={() => setAccountPage(null)} /></div>
      {accountPage === 'account' ? session ? <AccountPanel session={session} guestImport={repositories} onIdentityChanged={() => setRevision(value => value + 1)} onOpenGames={() => { setGamePage(0); setAccountPage('games'); }} onOpenProfile={profileClient ? () => setAccountPage('profile') : undefined} /> : <p>Loading…</p>
        : accountPage === 'profile' ? profileSurface : <>
        <h2>Saved games</h2>
        <div className="account-actions">
          <IconButton icon="plus" label="New account game" disabled={busy} onClick={() => void openAccountGame()} />
          <IconButton icon="account" label="Guest workspace" disabled={busy} onClick={() => void openGuestWorkspace()} />
          <IconButton icon="change" label="Refresh saved games" disabled={busy} onClick={() => setRevision(value => value + 1)} />
        </div>
        {games.slice(gamePage, gamePage + 1).map(game => <div key={game.gameId}>
          <p>{game.gameId}</p><p>{game.result}</p>
          <div className="account-actions"><button disabled={busy} onClick={() => { void openAccountGame(game.gameId); setAccountPage(null); }}>Open</button><button disabled={busy} onClick={() => void syncGame(game.gameId)}>Sync</button>
            {conflicts[game.gameId] && <button disabled={busy} onClick={() => void syncGame(game.gameId, 'takeover')}>Take over</button>}
          </div>
        </div>)}
        {games.length === 0 && <p>No games yet.</p>}
        <div className="account-actions"><IconButton icon="back" label="Previous game" disabled={gamePage === 0} onClick={() => setGamePage(value => value - 1)} /><IconButton icon="next" label="Next game" disabled={gamePage + 1 >= games.length} onClick={() => setGamePage(value => value + 1)} /></div>
        {message && <p role="status">{busy ? 'Syncing…' : message.startsWith('Complete game') ? 'Synced.' : message.startsWith('Cloud history') ? 'Sync conflict. Choose continuation.' : message.startsWith('Account game opened') || message.startsWith('Guest workspace opened') || message.startsWith('The accepted cloud game') ? 'Opened.' : 'Sync failed. Retry.'}</p>}
      </>}
    </section>}
    <div hidden={accountPage !== null}><App key={JSON.stringify([view.composition.registryScope, view.initialSession.gameId])} {...view} onOpenAccount={() => setAccountPage('account')} /></div>
  </>;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : 'The account operation could not complete. Your local game remains available.'; }
