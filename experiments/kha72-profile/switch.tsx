/**
 * Local browser check for the KHA-72 account-switch fence.
 *
 * The panel is the real component, the real state machine and the real
 * client. Only the profile service is a local stand-in: it records every
 * request it receives and answers the account reads with a fixture profile.
 *
 * The check shows three things:
 *
 * - a save started under one account and interrupted by an account change is
 *   never sent under the account that replaced it;
 * - the surface of the new account shows the new account's own profile, not
 *   the drafts of the account it replaced;
 * - a save that is not interrupted reaches the service under the account it
 *   started under.
 *
 * The check never reaches a network service, a hosted account, or a provider.
 */
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ProfilePanel } from '../../src/ui/ProfilePanel.js';
import { createProfileClient } from '../../src/profile/client.js';
import { createProfileIdentityTracker } from '../../src/profile/identity.js';
import type { ProfileAccountPort, ProfileIdentityBinding } from '../../src/profile/identity.js';
import '../../src/ui/styles.css';
import '../../src/account-workspace.css';

/** The delay of a session token, so the check can interrupt a save. */
const TOKEN_DELAY_MS = 300;

interface AccountFixture {
  readonly id: string;
  readonly token: string;
  readonly username: string;
}

const ACCOUNTS: Record<string, AccountFixture> = {
  alpha: { id: 'acct_alpha', token: 'token-alpha', username: 'Alice' },
  bravo: { id: 'acct_bravo', token: 'token-bravo', username: 'Bob' },
};

/** The account that is active. The stand-in service answers for it. */
let activeKey = 'alpha';

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
}

const requests: RecordedRequest[] = [];
const requestListeners = new Set<() => void>();

function recordRequest(entry: RecordedRequest): void {
  requests.push(entry);
  for (const listener of [...requestListeners]) listener();
}

function profileFor(key: string) {
  const account = ACCOUNTS[key];
  return {
    schemaVersion: 1,
    profileId: `kp_${account.id}`,
    username: account.username,
    avatar: { kind: 'chosen', value: 'harbor' },
    createdAt: '2026-10-20T10:00:00Z',
    updatedAt: '2026-10-20T10:05:00Z',
  };
}

/** The stand-in for the profile service. It records and answers. */
const stubFetch: typeof fetch = async (input, init) => {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const method = init?.method ?? 'GET';
  recordRequest({
    method,
    path: String(input).replace('https://service.local', ''),
    authorization: headers.Authorization ?? null,
  });
  const body = init?.body ? JSON.parse(String(init.body)) as { username?: string } : {};
  const profile = { ...profileFor(activeKey), username: method === 'PUT' ? body.username ?? null : profileFor(activeKey).username };
  return new Response(JSON.stringify({ ...profile, guestLinks: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

/** The stable account ports. The tracker compares them by identity. */
const PORTS: Record<string, ProfileAccountPort> = Object.fromEntries(
  Object.entries(ACCOUNTS).map(([key, account]) => [key, {
    accountId: account.id,
    async token() {
      await new Promise(resolve => setTimeout(resolve, TOKEN_DELAY_MS));
      return account.token;
    },
  }]),
);

function AccountSwitchCheck() {
  const [tracker] = useState(() => createProfileIdentityTracker());
  const [accountKey, setAccountKey] = useState('alpha');
  const [binding, setBinding] = useState<ProfileIdentityBinding>(() => tracker.update(PORTS.alpha, null));
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const listener = () => setVersion(value => value + 1);
    requestListeners.add(listener);
    return () => { requestListeners.delete(listener); };
  }, []);

  const client = useMemo(
    () => createProfileClient({ baseUrl: 'https://service.local', identity: binding, fetch: stubFetch }),
    [binding],
  );

  function switchAccount(): void {
    const nextKey = accountKey === 'alpha' ? 'bravo' : 'alpha';
    activeKey = nextKey;
    setAccountKey(nextKey);
    // A new account makes a new binding and fences the previous one.
    setBinding(tracker.update(PORTS[nextKey], null));
  }

  return <div>
    <p id="active-account">Active account: {accountKey}</p>
    <button type="button" id="switch-account" onClick={switchAccount}>Switch account</button>
    <ProfilePanel key={binding.generation} client={client} guestSeat={null} />
    <h2>Requests the stand-in service received</h2>
    <ul id="requests">{requests.map((entry, index) => <li key={index}>{entry.method} {entry.path} | {entry.authorization ?? 'no credential'}</li>)}</ul>
    <span hidden>{version}</span>
  </div>;
}

const root = document.getElementById('root');
if (!root) throw new Error('The preview root is missing.');
createRoot(root).render(
  <StrictMode>
    <AccountSwitchCheck />
  </StrictMode>,
);
