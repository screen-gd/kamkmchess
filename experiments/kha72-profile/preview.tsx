/**
 * Local browser check for the KHA-72 public profile panel.
 *
 * The panel is the real component and the real state machine. Only the
 * profile service is a local stand-in: it answers with a fixture profile,
 * refuses the name "rookie" the way the service refuses a name another
 * profile already owns, and accepts a guest link.
 *
 * The check never reaches a network service, a hosted account, or a provider.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ProfilePanel } from '../../src/ui/ProfilePanel.js';
import '../../src/ui/styles.css';
import '../../src/account-workspace.css';

const TAKEN_NAME = 'rookie';

const profile = {
  schemaVersion: 1,
  profileId: 'kp_previewpreview',
  username: 'Alice',
  avatar: { kind: 'chosen', value: 'harbor' },
  createdAt: '2026-10-20T10:00:00Z',
  updatedAt: '2026-10-20T10:05:00Z',
};

let linked = false;

const client = {
  async readPublicProfile() { return profile; },
  async readPublicProfileByUsername() { return profile; },
  async readOwnProfile() {
    return {
      ...profile,
      guestLinks: linked ? [{
        schemaVersion: 1,
        linkId: 'kl_previewlink1',
        profileId: profile.profileId,
        matchId: 'match_preview',
        seat: 'white',
        linkedAt: '2026-10-20T10:15:00Z',
      }] : [],
    };
  },
  async updateOwnProfile(update) {
    const name = update.username ?? null;
    if (name === TAKEN_NAME) throw new Error('That name is already taken.');
    Object.assign(profile, {
      ...profile,
      username: name,
      avatar: { kind: 'chosen', value: update.avatar || 'harbor' },
    });
    return profile;
  },
  async mintOwnershipProof() {
    return {
      schemaVersion: 1,
      proofId: 'kgp_previewproof',
      secret: 'kgp1_previewsecret',
      matchId: 'match_preview',
      seat: 'white',
      expiresAt: '2026-10-20T10:30:00Z',
    };
  },
  async linkGuestSeat() {
    linked = true;
    return {
      schemaVersion: 1,
      linkId: 'kl_previewlink1',
      profileId: profile.profileId,
      matchId: 'match_preview',
      seat: 'white',
      linkedAt: '2026-10-20T10:15:00Z',
    };
  },
};

const root = document.getElementById('root');
if (!root) throw new Error('The preview root is missing.');
createRoot(root).render(
  <StrictMode>
    <ProfilePanel client={client} guestSeat={{ matchId: 'match_preview', seat: 'white' }} />
  </StrictMode>,
);
