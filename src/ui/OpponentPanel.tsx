import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createConnectionProfile, getConnectionEndpoints, hasCurrentDisclosureConsent, reviseConnectionProfile } from '../providers/connections/index.js';
import type { ConnectionAuth, ConnectionProfile, ConnectionProvider, ConnectionProtocol, ConnectionStore, ConnectionNamespace, CreateConnectionProfileInput } from '../providers/connections/index.js';
import type { OpponentIdentityV1, OpponentService } from '../opponents/index.js';
import type { ModelSelection } from '../controller/index.js';
import { controllerRevisionForConfig } from './opponent-selection.js';
import { IconButton } from './Icon.js';
import { conciseError } from './concise-error.js';
import { usesProviderRelay } from '../providers/transport.js';

interface Props {
  readonly service: Promise<OpponentService>;
  readonly connectionStore: Promise<ConnectionStore>;
  readonly onSelect: (selection: ModelSelection, identity: OpponentIdentityV1) => void;
  readonly selected: ModelSelection | null;
  readonly idPrefix?: string;
  readonly selectLabel?: string;
  readonly namespace?: ConnectionNamespace;
  readonly onClose?: () => void;
  readonly onSelectionInvalidated?: () => void;
}
const GUEST: ConnectionNamespace = { kind: 'guest' };
const providers: Record<ConnectionProvider, string> = { cliproxy: 'CLIProxyAPI', openai: 'OpenAI', openrouter: 'OpenRouter', anthropic: 'Anthropic', custom: 'Custom' };
const defaults = {
  cliproxy: ['http://127.0.0.1:8317/v1', 'chat-completions', 'bearer'],
  openai: ['https://api.openai.com/v1', 'responses', 'bearer'],
  openrouter: ['https://openrouter.ai/api/v1', 'chat-completions', 'bearer'],
  anthropic: ['https://api.anthropic.com/v1', 'messages', 'api-key-header'],
  custom: ['', 'chat-completions', 'bearer'],
} as const;

export function OpponentPanel({ service, connectionStore, onSelect, selected, idPrefix = 'opponent', namespace = GUEST, onClose, onSelectionInvalidated }: Props) {
  const [profiles, setProfiles] = useState<readonly ConnectionProfile[]>([]);
  const [profile, setProfile] = useState<ConnectionProfile | null>(null);
  const [provider, setProvider] = useState<ConnectionProvider>('cliproxy');
  const [baseUrl, setBaseUrl] = useState<string>(defaults.cliproxy[0]);
  const [protocol, setProtocol] = useState<ConnectionProtocol>('chat-completions');
  const [authMode, setAuthMode] = useState<'bearer' | 'api-key-header' | 'none'>('bearer');
  const [name, setName] = useState('CLIProxyAPI');
  const [catalogUrl, setCatalogUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [entries, setEntries] = useState<Awaited<ReturnType<OpponentService['getCatalog']>>['entries']>([]);
  const [modelId, setModelId] = useState('');
  const [page, setPage] = useState<'connection' | 'advanced' | 'models' | 'consent'>('connection');
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('');
  const [bound, setBound] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const initialSelection = useRef(selected);
  let relayed = false;
  try { relayed = usesProviderRelay(baseUrl) || (catalogUrl.trim() !== '' && usesProviderRelay(catalogUrl)); } catch { /* The form validates incomplete addresses on submit. */ }

  // Saved destinations load their current catalog whenever this picker opens.
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    operation.current = controller;
    void (async () => {
      const store = await connectionStore;
      const saved = await store.listProfiles(namespace);
      if (controller.signal.aborted) return;
      setProfiles(saved);
      const selection = initialSelection.current;
      const current = saved.find(item => item.id === selection?.connectionId) ?? saved[0];
      if (current) await loadProfile(current, controller);
    })().catch(error => { if (active(controller)) setMessage(conciseError(error)); }).finally(() => { if (active(controller)) setBusy(false); });
    return () => { mounted.current = false; operation.current?.abort(); controller.abort(); };
    // The selection is output, not a trigger to reload the picker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionStore, service, namespace]);

  function begin() {
    operation.current?.abort();
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setMessage('');
    return controller;
  }
  function active(controller: AbortController) { return mounted.current && !controller.signal.aborted && operation.current === controller; }
  function invalidate() { onSelectionInvalidated?.(); setModelId(''); setEntries([]); setMessage(''); }
  async function catalog(current: ConnectionProfile, controller: AbortController) {
    const next = await (await service).refreshCatalog(current.id, controller.signal);
    if (!active(controller)) return;
    // Removed and stale entries are never offered as currently available models.
    const available = next.entries.filter(entry => entry.state === 'advertised');
    setEntries(available); setModelId(''); setPage('models');
    if (next.error) setMessage(available.length ? 'Some models unavailable.' : conciseError(new Error(next.error.message)));
    else if (!available.length) setMessage('No models available.');
  }
  async function loadProfile(current: ConnectionProfile, controller = begin()) {
    setProfile(current); setProvider(current.provider); setName(current.name); setBaseUrl(current.baseUrl);
    setProtocol(current.protocol); setAuthMode(current.auth.kind); setCatalogUrl(current.catalogUrl ?? ''); setApiKey('');
    setBusy(true); setPage('connection'); setMessage(''); setEntries([]); setModelId('');
    try {
      const credentials = await (await connectionStore).resolveCredentials(namespace, current);
      if (!active(controller)) return;
      setBound(credentials.status === 'bound');
      if (credentials.status === 'bound') {
        const endpoints = getConnectionEndpoints(current);
        const needsRelay = usesProviderRelay(endpoints.generationUrl) || (endpoints.catalogUrl && usesProviderRelay(endpoints.catalogUrl));
        // Show the relay notice before forwarding a legacy connection's saved
        // key through a new intermediary, including for catalog requests.
        const consent = needsRelay ? await (await connectionStore).getDisclosureChoice(namespace, current) : undefined;
        if (!needsRelay || consent?.transport === 'site-relay') await catalog(current, controller);
      }
    } catch (error) { if (active(controller)) setMessage(conciseError(error)); }
    finally { if (active(controller)) setBusy(false); }
  }
  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); invalidate(); const controller = begin();
    try {
      const store = await connectionStore;
      const auth: ConnectionAuth = authMode === 'api-key-header' ? { kind: authMode, headerName: 'x-api-key' } : { kind: authMode };
      const effectiveCatalog = catalogUrl.trim() || (provider === 'custom' ? `${baseUrl.replace(/\/(?:chat\/completions|responses|messages)\/?$/, '').replace(/\/$/, '')}/models` : '');
      const fields = { id: profile?.id ?? crypto.randomUUID(), name, provider, protocol, baseUrl, auth, ...(effectiveCatalog ? { catalogUrl: effectiveCatalog } : {}) };
      const input: CreateConnectionProfileInput = { ...fields, provider };
      const next = profile ? await reviseConnectionProfile(profile, { ...input, catalogUrl: effectiveCatalog || null }) : await createConnectionProfile(input);
      const credentials = await store.resolveCredentials(namespace, next);
      if (auth.kind !== 'none' && !apiKey.trim() && credentials.status !== 'bound') throw new Error('API key required');
      await store.saveProfile(namespace, next);
      if (apiKey.trim() || auth.kind === 'none') await store.assignCredential(namespace, next.id, auth.kind === 'none' ? {} : { apiKey: apiKey.trim() });
      if (!active(controller)) return;
      setProfile(next); setApiKey(''); setBound(true); setProfiles(await store.listProfiles(namespace));
      await catalog(next, controller);
    } catch (error) { if (active(controller)) setMessage(conciseError(error)); }
    finally { if (active(controller)) setBusy(false); }
  }
  async function check(current: ConnectionProfile, id: string, controller: AbortController) {
    const opponents = await service;
    const result = await opponents.runCompatibilityDiagnostic({ profileId: current.id, modelId: id }, controller.signal);
    if (!active(controller)) return;
    if (result.evidence.state !== 'passed-current-session') throw new Error(result.evidence.detail);
    const handoff = await opponents.prepareSelection({ profileId: current.id, modelId: id });
    if (!active(controller)) return;
    const identity = handoff.queued?.identity ?? handoff.committed;
    if (!identity || identity.profileId !== current.id || identity.modelId !== id || identity.configRevision !== current.configRevision || identity.credentialRevision !== result.evidence.credentialRevision) throw new Error('Connection changed');
    onSelect({ kind: 'model', providerId: current.provider, connectionId: current.id, configurationRevision: controllerRevisionForConfig(current.configRevision), modelRoutingId: id, protocol: current.protocol, diagnostic: 'passed-current-session' }, identity);
    setMessage('Ready');
  }
  async function choose(id: string) {
    if (!profile || !entries.some(entry => entry.id === id)) return;
    onSelectionInvalidated?.(); setModelId(id); const controller = begin();
    try {
      const store = await connectionStore;
      if (!hasCurrentDisclosureConsent(profile, await store.getDisclosureChoice(namespace, profile))) { if (active(controller)) setPage('consent'); return; }
      await check(profile, id, controller);
    } catch (error) { if (active(controller)) setMessage(conciseError(error)); }
    finally { if (active(controller)) setBusy(false); }
  }
  async function allow() {
    if (!profile || !modelId) return;
    const controller = begin();
    try {
      await (await connectionStore).recordDisclosureChoice(namespace, profile, { decision: 'accepted', recordedAtMs: Date.now() });
      if (!active(controller)) return;
      setPage('models'); await check(profile, modelId, controller);
    } catch (error) { if (active(controller)) setMessage(conciseError(error)); }
    finally { if (active(controller)) setBusy(false); }
  }
  return <section className="opponent-panel" aria-label="AI model" aria-busy={busy}>
    <div className="panel-heading"><h2 id={`${idPrefix}-setup-title`}>{page === 'models' ? 'Model' : page === 'consent' ? 'Allow connection?' : page === 'advanced' ? 'Settings' : 'Connect'}</h2>
      <div className="button-row">{page !== 'connection' && <IconButton icon="back" label="Connection" disabled={busy} onClick={() => { setPage('connection'); setMessage(''); }} />}{onClose && <IconButton icon="close" label="Close" onClick={onClose} />}</div></div>
    {page === 'consent' ? <div className="disclosure-panel">
      <p>Send moves to <code>{profile && getConnectionEndpoints(profile).generationUrl}</code>?</p><p>{relayed ? 'Requests and keys pass through this site.' : 'Provider charges may apply.'}</p>
      <div className="button-row"><button className="button primary" disabled={busy} onClick={() => void allow()}>Allow</button><button className="button secondary" disabled={busy} onClick={() => { setPage('models'); setModelId(''); }}>Cancel</button></div>
    </div> : page === 'models' ? <div className="connection-form">
      <label className="sr-label">Available models<select aria-label="Available models" disabled={busy || !entries.length} value={modelId} onChange={event => void choose(event.target.value)}>
        <option value="">Choose model</option>{entries.map(entry => <option key={entry.id} value={entry.id}>{entry.displayName ?? entry.id}</option>)}
      </select></label>
      {message !== 'Ready' && !busy && modelId && <button className="button secondary" onClick={() => void choose(modelId)}>Try again</button>}
      {message !== 'Ready' && !busy && !modelId && !entries.length && <button className="button secondary" onClick={() => { if (profile) void loadProfile(profile); }}>Try again</button>}
    </div> : <form className="connection-form" onSubmit={event => void connect(event)}>
      <fieldset disabled={busy} className="opponent-fields">
        {page === 'connection' ? <>
          {profiles.length > 0 && <label className="sr-label">Saved connection<select aria-label="Saved connection" value={profile?.id ?? ''} onChange={event => {
            invalidate(); const next = profiles.find(item => item.id === event.target.value);
            if (next) void loadProfile(next); else { setProfile(null); setBound(false); setApiKey(''); }
          }}><option value="">New connection</option>{profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
          <label>Provider<select value={provider} onChange={event => {
            const next = event.target.value as ConnectionProvider; const values = defaults[next];
            setProvider(next); setProfile(null); setBound(false); setName(providers[next]); setBaseUrl(values[0]); setProtocol(values[1]); setAuthMode(values[2]); setCatalogUrl(''); setApiKey(''); invalidate();
          }}>{Object.entries(providers).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
          <label>Address<input aria-label="Base URL" type="url" autoCapitalize="none" autoComplete="url" spellCheck={false} required value={baseUrl} onChange={event => { setBaseUrl(event.target.value); setBound(false); invalidate(); }} /></label>
          {relayed && <p>Requests and keys pass through this site.</p>}
          {authMode !== 'none' && <label>API key<input type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} value={apiKey} required={!bound} placeholder={bound ? 'Saved' : ''} onChange={event => { setApiKey(event.target.value); invalidate(); }} /></label>}
          <div className="button-row"><button className="button primary" type="submit">{busy ? 'Connecting…' : 'Connect'}</button><IconButton icon="settings" label="Advanced connection settings" onClick={() => { setPage('advanced'); setMessage(''); }} /></div>
        </> : <>
          <label>Name<input aria-label="Connection name" value={name} required onChange={event => setName(event.target.value)} /></label>
          <label>Protocol<select value={protocol} onChange={event => { setProtocol(event.target.value as ConnectionProtocol); setBound(false); invalidate(); }}><option value="chat-completions">Chat Completions</option><option value="responses">Responses</option><option value="messages">Anthropic Messages</option></select></label>
          <label>Authentication<select value={authMode} onChange={event => { setAuthMode(event.target.value as typeof authMode); setBound(false); setApiKey(''); invalidate(); }}><option value="bearer">Bearer</option><option value="api-key-header">API key</option><option value="none">None</option></select></label>
          <label>Catalog<input aria-label="Catalog URL override" type="url" autoCapitalize="none" spellCheck={false} value={catalogUrl} onChange={event => { setCatalogUrl(event.target.value); setBound(false); invalidate(); }} /></label>
          <button className="button primary" type="button" onClick={() => setPage('connection')}>Done</button>
        </>}
      </fieldset>
    </form>}
    <p className="feedback-inline" role="status" aria-live="polite">{busy ? 'Checking…' : message}</p>
  </section>;
}
