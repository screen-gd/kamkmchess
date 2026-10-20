import { IconButton } from './Icon.js';
import { useEffect, useState } from 'react';
import type { AccountSession } from '../accounts';
import { importGuestGames, previewGuestImport } from '../accounts';
import type { GuestImportPort, GuestImportPreview } from '../accounts';

export interface AccountPanelProps {
  readonly session: AccountSession;
  readonly guestImport?: GuestImportPort;
  readonly onIdentityChanged?: () => void;
  readonly onOpenGames?: () => void;
  readonly onOpenProfile?: (() => void) | undefined;
}

/** Optional account controls. The parent decides where to mount this panel. */
export function AccountPanel({ session, guestImport, onIdentityChanged, onOpenGames, onOpenProfile }: AccountPanelProps) {
  const [identity, setIdentity] = useState(session.identity);
  const [preview, setPreview] = useState<GuestImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState('');
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => session.subscribe((nextIdentity) => {
    setIdentity((current) => {
      if (current?.accountId !== nextIdentity?.accountId) {
        setPreview(null);
        setSelected(new Set());
        setMessage('');
      }
      return nextIdentity;
    });
  }), [session]);

  async function beginImport() {
    if (!guestImport || !identity) return;
    setBusy(true); setMessage('');
    try {
      const result = await previewGuestImport(guestImport, identity.accountId);
      if (session.identity?.accountId !== result.accountId) throw new Error('The signed-in account changed. Review the import again.');
      setPreview(result);
      setSelected(new Set(result.games.map((game) => game.gameId)));
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function confirmImport() {
    if (!guestImport || !preview) return;
    if (session.identity?.accountId !== preview.accountId) {
      setPreview(null); setSelected(new Set()); setMessage('The signed-in account changed. Review guest games again.');
      return;
    }
    setBusy(true);
    try {
      await importGuestGames(guestImport, preview, [...selected], () => session.identity?.accountId === preview.accountId);
      if (session.identity?.accountId !== preview.accountId) throw new Error('The signed-in account changed during import. No more guest games will be copied.');
      setPreview(null); setMessage('Selected guest games were copied into this account. Guest copies remain on this device.');
      onIdentityChanged?.();
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function signIn() {
    setBusy(true); setMessage('');
    try { await session.signInWithGoogle(); }
    catch (error) { setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function signOut() {
    setBusy(true); setMessage('');
    try { await session.signOut(); setPreview(null); setSelected(new Set()); onIdentityChanged?.(); }
    catch (error) { setMessage(session.client?.user ? `Sign-out needs attention. Private games are hidden. Try signing out again: ${errorMessage(error)}` : `You are signed out, but local credential cleanup reported an error: ${errorMessage(error)}`); }
    finally { setBusy(false); }
  }

  return <section aria-labelledby="account-panel-title" className="account-panel">
    <h2 id="account-panel-title">{preview ? 'Import games' : 'Account'}</h2>
    {preview ? <>
      <p>Device copies stay.</p>
      {preview.games.length === 0 ? <p>No games yet.</p> : <fieldset disabled={busy}>
        <legend className="sr-only">Select games</legend>
        {preview.games.slice(page, page + 1).map(game => <label key={game.gameId}>
          <input type="checkbox" aria-label="Import this game" checked={selected.has(game.gameId)} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(game.gameId); else next.delete(game.gameId); return next; })} />
          <span>{game.gameId}</span>
        </label>)}
      </fieldset>}
      <div className="account-panel-actions"><IconButton icon="back" label="Previous game" disabled={page === 0 || busy} onClick={() => setPage(value => value - 1)} /><IconButton icon="next" label="Next game" disabled={page + 1 >= preview.games.length || busy} onClick={() => setPage(value => value + 1)} />
        <button onClick={() => void confirmImport()} disabled={busy || selected.size === 0}>Import ({selected.size})</button><button onClick={() => setPreview(null)} disabled={busy}>Cancel</button></div>
    </> : <>
      {!session.enabled && <p>Play as guest.</p>}
      {session.enabled && !identity && <>
        {session.client?.user && <button onClick={() => void signOut()} disabled={busy}>Sign out</button>}
        <button onClick={() => void signIn()} disabled={busy}>Sign in</button>
      </>}
      {identity && <div className="account-panel-actions">
        {onOpenProfile && <IconButton icon="account" label="Public profile" onClick={onOpenProfile} disabled={busy} />}
        {onOpenGames && <button onClick={onOpenGames} disabled={busy}>Games</button>}
        {guestImport && <button onClick={() => { setPage(0); void beginImport(); }} disabled={busy}>Import</button>}
        <button onClick={() => void signOut()} disabled={busy}>Sign out</button>
      </div>}
    </>}
    {message && <p role="status">{message.startsWith('Selected guest games') ? 'Imported.' : 'Try again.'}</p>}
    <a className="account-privacy-link" href="/privacy.html" target="_blank" rel="noreferrer">Privacy policy</a>
  </section>;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Please try again.'; }
