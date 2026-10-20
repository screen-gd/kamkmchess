import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createProfilePanel } from '../profile/panel.js';
import { PROFILE_AVATAR_CHOICES } from '../profile/contracts.js';
import type { ProfileClient, GuestSeatBinding } from '../profile/client.js';
import { IconButton } from './Icon.js';
import '../profile-panel.css';

export interface ProfilePanelProps {
  readonly client: ProfileClient;
  /** The guest seat this browser controls, when there is one. */
  readonly guestSeat?: GuestSeatBinding | null;
}

/** The public name shown for the chosen avatar. */
const AVATAR_LABELS: Record<string, string> = {
  ember: 'Ember',
  harbor: 'Harbor',
  meadow: 'Meadow',
  orchid: 'Orchid',
  slate: 'Slate',
  sunrise: 'Sunrise',
  tide: 'Tide',
  violet: 'Violet',
};

/**
 * The public profile of the signed-in account.
 *
 * The panel edits the chosen name and the chosen avatar, and it links a guest
 * seat to the account. It never shows the private sign-in identity, and it
 * never edits anything that belongs to somebody else.
 */
export function ProfilePanel({ client, guestSeat = null }: ProfilePanelProps) {
  const panel = useMemo(() => createProfilePanel({ client, guestSeat }), [client, guestSeat]);
  // The panel holds no resource of its own, so there is nothing to tear down
  // when the interface goes away. React unsubscribes from it, and a late
  // answer then reaches nobody.
  useEffect(() => {
    void panel.load();
  }, [panel]);
  const state = useSyncExternalStore(panel.subscribe, panel.getSnapshot, panel.getSnapshot);
  const busy = state.status === 'saving' || state.status === 'linking' || state.status === 'loading';
  const linked = state.profile?.guestLinks.some(link => link.matchId === guestSeat?.matchId && link.seat === guestSeat.seat) ?? false;

  return <section className="profile-panel" aria-labelledby="profile-panel-title">
    <h2 id="profile-panel-title">Public profile</h2>
    <div className="profile-identity">
      <ProfileAvatar kind={state.profile?.avatar.kind ?? 'generated'} value={state.profile?.avatar.value ?? ''} profileId={state.profile?.profileId ?? ''} />
      <div className="profile-identity-text">
        <p className="profile-name">{state.profile?.username ?? 'Unnamed'}</p>
      </div>
    </div>

    <label className="profile-field">
      <span>Public name</span>
      <input
        type="text"
        value={state.usernameDraft}
        maxLength={24}
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
        onChange={event => panel.setUsernameDraft(event.target.value)}
      />
    </label>

    <fieldset className="profile-avatars" disabled={busy}>
      <legend>Avatar</legend>
      <div className="profile-avatar-choices">
        <label className="profile-avatar-choice">
          <input className="profile-avatar-input" type="radio" name="profile-avatar" value="" checked={state.avatarDraft === ''} onChange={() => panel.setAvatarDraft('')} />
          <span className="profile-swatch" data-avatar="generated" style={generatedStyle(state.profile?.profileId ?? '')} aria-hidden="true" />
          <span className="sr-only">Generated avatar</span>
        </label>
        {PROFILE_AVATAR_CHOICES.map(choice => <label className="profile-avatar-choice" key={choice}>
          <input className="profile-avatar-input" type="radio" name="profile-avatar" value={choice} checked={state.avatarDraft === choice} onChange={() => panel.setAvatarDraft(choice)} />
          <span className="profile-swatch" data-avatar={choice} aria-hidden="true" />
          <span className="sr-only">{AVATAR_LABELS[choice] ?? choice}</span>
        </label>)}
      </div>
    </fieldset>

    <div className="account-panel-actions">
      <IconButton icon="save" label="Save profile" className="button primary icon-button" disabled={busy || !state.profile} onClick={() => void panel.save()} />
      {state.status === 'error' && <IconButton icon="change" label="Retry profile" onClick={() => void panel.load()} />}
    </div>

    <section className="profile-guest-seats" aria-labelledby="profile-guest-title">
      <h3 id="profile-guest-title">Guest seats</h3>
      {state.profile && state.profile.guestLinks.length > 0
        ? <p>{state.profile.guestLinks.length} linked</p>
        : <p className="muted">{guestSeat ? 'No linked seats.' : 'Guest seat required.'}</p>}
      {guestSeat
        ? <div className="account-panel-actions">
          <IconButton icon="link" label={linked ? 'Guest seat linked' : 'Link guest seat'} disabled={busy || !state.profile || linked} onClick={() => void panel.linkGuestSeat()} />
        </div>
        : null}
    </section>

    <p className="profile-status" role="status">{state.message}</p>
  </section>;
}

/** The avatar of a profile, chosen or generated. */
function ProfileAvatar({ kind, value, profileId }: { kind: string; value: string; profileId: string }) {
  if (kind === 'chosen') {
    return <span className="profile-avatar" data-avatar={value} aria-hidden="true" />;
  }
  return <span className="profile-avatar" data-avatar="generated" style={generatedStyle(profileId || value)} aria-hidden="true" />;
}

/**
 * The hue of a generated avatar.
 *
 * The generated avatar is derived from the public profile identifier, so it
 * is stable for a person and needs no storage. The hue is only a starting
 * point; the swatch keeps its own contrast.
 */
function generatedStyle(profileId: string): React.CSSProperties {
  let hash = 0;
  for (let index = 0; index < profileId.length; index += 1) {
    hash = (hash * 31 + profileId.charCodeAt(index)) % 360;
  }
  return { '--profile-hue': String(hash) } as React.CSSProperties;
}
