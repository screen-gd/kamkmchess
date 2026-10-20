import { describe, expect, it, vi } from 'vitest';
import { createProfilePanel } from './panel';
import { ProfileRequestError } from './client';
import type { ProfileClient } from './client';
import type { PublicProfile } from './contracts';

const ownProfile: PublicProfile = {
  schemaVersion: 1,
  profileId: 'kp_alphaalphaalpha',
  username: 'Alice',
  avatar: { kind: 'chosen', value: 'harbor' },
  createdAt: '2026-10-20T10:00:00Z',
  updatedAt: '2026-10-20T10:05:00Z',
};

function clientStub(overrides: Partial<ProfileClient> = {}): ProfileClient {
  return {
    readPublicProfile: vi.fn(async () => ownProfile),
    readPublicProfileByUsername: vi.fn(async () => ownProfile),
    readOwnProfile: vi.fn(async () => ownProfile),
    updateOwnProfile: vi.fn(async () => ownProfile),
    mintOwnershipProof: vi.fn(async () => ({
      schemaVersion: 1,
      proofId: 'kgp_proofproofproof',
      secret: 'kgp1_secretsecretsecret',
      matchId: 'match_alpha',
      seat: 'white' as const,
      expiresAt: '2026-10-20T10:30:00Z',
    })),
    linkGuestSeat: vi.fn(async () => ({
      schemaVersion: 1,
      linkId: 'kl_linklinklink',
      profileId: 'kp_alphaalphaalpha',
      matchId: 'match_alpha',
      seat: 'white' as const,
      linkedAt: '2026-10-20T10:15:00Z',
    })),
    ...overrides,
  } as ProfileClient;
}

describe('profile panel', () => {
  it('loads the account profile into the drafts', async () => {
    const panel = createProfilePanel({ client: clientStub() });

    await panel.load();

    const state = panel.getSnapshot();
    expect(state.status).toBe('ready');
    expect(state.usernameDraft).toBe('Alice');
    expect(state.avatarDraft).toBe('harbor');
    expect(state.message).toBe('');
  });

  it('saves the chosen name and avatar and says so', async () => {
    const updateOwnProfile = vi.fn(async () => ({ ...ownProfile, username: 'Bobby', avatar: { kind: 'chosen' as const, value: 'tide' } }));
    const panel = createProfilePanel({ client: clientStub({ updateOwnProfile }) });
    await panel.load();

    panel.setUsernameDraft('Bobby');
    panel.setAvatarDraft('tide');
    await panel.save();

    expect(updateOwnProfile).toHaveBeenCalledWith({ username: 'Bobby', avatar: 'tide' });
    expect(panel.getSnapshot().message).toBe('Profile saved.');
    expect(panel.getSnapshot().usernameDraft).toBe('Bobby');
  });

  it('refuses a name the service would refuse, before the request leaves', async () => {
    const updateOwnProfile = vi.fn(async () => ownProfile);
    const panel = createProfilePanel({ client: clientStub({ updateOwnProfile }) });
    await panel.load();

    panel.setUsernameDraft('a b');
    await panel.save();

    expect(updateOwnProfile).not.toHaveBeenCalled();
    expect(panel.getSnapshot().message).toBe('Use 3 to 24 letters, digits, dashes.');
  });

  it('refuses a reserved name with its own sentence, before the request leaves', async () => {
    const updateOwnProfile = vi.fn(async () => ownProfile);
    const panel = createProfilePanel({ client: clientStub({ updateOwnProfile }) });
    await panel.load();

    panel.setUsernameDraft('admin');
    await panel.save();

    expect(updateOwnProfile).not.toHaveBeenCalled();
    expect(panel.getSnapshot().message).toBe('That name is reserved.');
  });

  it('asks the user to sign in when the account session expired', async () => {
    const panel = createProfilePanel({
      client: clientStub({ updateOwnProfile: vi.fn(async () => { throw new ProfileRequestError('Sign in to edit your profile.', 401, 'not_signed_in'); }) }),
    });
    await panel.load();

    panel.setUsernameDraft('Bobby');
    await panel.save();

    expect(panel.getSnapshot().message).toBe('Sign in to edit your profile.');
  });

  it('does not claim that the guest seat is gone when the link was refused', async () => {
    const panel = createProfilePanel({
      client: clientStub({ linkGuestSeat: vi.fn(async () => { throw new ProfileRequestError('The link was refused.', 401, 'link_unauthorized'); }) }),
      guestSeat: { matchId: 'match_alpha', seat: 'white' },
    });
    await panel.load();

    await panel.linkGuestSeat();

    expect(panel.getSnapshot().message).toBe('Link refused. Sign in again or rejoin the seat.');
    expect(panel.getSnapshot().message).not.toMatch(/no longer yours/);
  });

  it('reports that the signed-in account changed under a call', async () => {
    const panel = createProfilePanel({
      client: clientStub({ updateOwnProfile: vi.fn(async () => { throw new ProfileRequestError('The signed-in account changed.', 409, 'account_changed'); }) }),
    });
    await panel.load();

    panel.setUsernameDraft('Bobby');
    await panel.save();

    expect(panel.getSnapshot().message).toBe('The signed-in account changed.');
  });

  it('reports a name that another profile already owns', async () => {
    const panel = createProfilePanel({
      client: clientStub({ updateOwnProfile: vi.fn(async () => { throw new ProfileRequestError('That name is already taken.', 409, 'username_taken'); }) }),
    });
    await panel.load();

    panel.setUsernameDraft('rookie');
    await panel.save();

    expect(panel.getSnapshot().message).toBe('That name is already taken.');
  });

  it('reports a guest seat that is already linked from the service code', async () => {
    const panel = createProfilePanel({
      client: clientStub({ linkGuestSeat: vi.fn(async () => { throw new ProfileRequestError('That guest seat is already linked.', 409, 'seat_already_linked'); }) }),
      guestSeat: { matchId: 'match_alpha', seat: 'white' },
    });
    await panel.load();

    await panel.linkGuestSeat();

    expect(panel.getSnapshot().message).toBe('That guest seat is already linked.');
  });

  it('reports a spent ownership proof from the service code', async () => {
    const panel = createProfilePanel({
      client: clientStub({ linkGuestSeat: vi.fn(async () => { throw new ProfileRequestError('That guest seat is already linked.', 409, 'proof_already_used'); }) }),
      guestSeat: { matchId: 'match_alpha', seat: 'white' },
    });
    await panel.load();

    await panel.linkGuestSeat();

    expect(panel.getSnapshot().message).toBe('That ownership proof was already used.');
  });

  it('links the guest seat this browser controls and says so', async () => {
    const linkGuestSeat = vi.fn(async () => ({
      schemaVersion: 1,
      linkId: 'kl_linklinklink',
      profileId: 'kp_alphaalphaalpha',
      matchId: 'match_alpha',
      seat: 'white' as const,
      linkedAt: '2026-10-20T10:15:00Z',
    }));
    const panel = createProfilePanel({ client: clientStub({ linkGuestSeat }), guestSeat: { matchId: 'match_alpha', seat: 'white' } });
    await panel.load();

    await panel.linkGuestSeat();

    expect(linkGuestSeat).toHaveBeenCalledWith({ matchId: 'match_alpha', seat: 'white' });
    expect(panel.getSnapshot().message).toBe('Guest seat linked to your account.');
  });

  it('says so when there is no guest seat to link', async () => {
    const linkGuestSeat = vi.fn();
    const panel = createProfilePanel({ client: clientStub({ linkGuestSeat }) });
    await panel.load();

    await panel.linkGuestSeat();

    expect(linkGuestSeat).not.toHaveBeenCalled();
    expect(panel.getSnapshot().message).toBe('No guest seat is open in this browser.');
  });

  it('reports a guest seat that is already linked', async () => {
    const panel = createProfilePanel({
      client: clientStub({ linkGuestSeat: vi.fn(async () => { throw new Error('That guest seat is already linked.'); }) }),
      guestSeat: { matchId: 'match_alpha', seat: 'white' },
    });
    await panel.load();

    await panel.linkGuestSeat();

    expect(panel.getSnapshot().message).toBe('That guest seat is already linked.');
  });  it('reports a load that failed without losing the drafts', async () => {
    const panel = createProfilePanel({ client: clientStub({ readOwnProfile: vi.fn(async () => { throw new Error('The profile service is unavailable.'); }) }) });

    await panel.load();

    expect(panel.getSnapshot().status).toBe('error');
    expect(panel.getSnapshot().message).toBe('Could not load your profile. Retry.');
  });

  it('notifies its subscribers when the state changes', async () => {
    const panel = createProfilePanel({ client: clientStub() });
    const listener = vi.fn();
    panel.subscribe(listener);

    await panel.load();

    expect(listener).toHaveBeenCalled();
  });
});
