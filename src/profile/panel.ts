/**
 * Profile panel state (KHA-72).
 *
 * The panel is a small, pure state machine. It owns the drafts, the busy
 * state, and the one status line the interface shows, and it never touches
 * the DOM. The React component renders the state and forwards intent, so the
 * behaviour can be exercised without a browser.
 *
 * The status line is the whole feedback surface, so every outcome has one
 * short sentence: what happened, or what to do next.
 *
 * The panel holds no resource of its own. It has no timer, no subscription
 * and no connection, so it needs no teardown: the interface unsubscribes when
 * it goes away, and a late answer then reaches nobody.
 */
import type { ProfileClient, GuestSeatBinding } from './client';
import { ProfileRequestError } from './client';
import { isAcceptableAvatar, isAcceptableUsername, isReservedUsername } from './contracts';
import type { OwnProfile } from './contracts';

export type ProfilePanelStatus = 'idle' | 'loading' | 'ready' | 'saving' | 'linking' | 'error';

export interface ProfilePanelState {
  readonly status: ProfilePanelStatus;
  /** The loaded profile, or null before the first load. */
  readonly profile: OwnProfile | null;
  /** The public name the owner is editing. */
  readonly usernameDraft: string;
  /** The avatar the owner is choosing. An empty value is the generated one. */
  readonly avatarDraft: string;
  /** The one status line. It is empty when there is nothing to say. */
  readonly message: string;
  /** The guest seat this browser controls, when there is one. */
  readonly guestSeat: GuestSeatBinding | null;
}

export interface ProfilePanelOptions {
  readonly client: ProfileClient;
  /** The guest seat this browser controls, when there is one. */
  readonly guestSeat?: GuestSeatBinding | null;
}

export interface ProfilePanel {
  getSnapshot(): ProfilePanelState;
  subscribe(listener: () => void): () => void;
  /** Loads the signed-in account's profile. */
  load(): Promise<void>;
  setUsernameDraft(value: string): void;
  setAvatarDraft(value: string): void;
  /** Saves the chosen name and avatar. */
  save(): Promise<void>;
  /** Links the guest seat this browser controls to the account. */
  linkGuestSeat(): Promise<void>;
}

export function createProfilePanel(options: ProfilePanelOptions): ProfilePanel {
  const listeners = new Set<() => void>();
  let state: ProfilePanelState = {
    status: 'idle',
    profile: null,
    usernameDraft: '',
    avatarDraft: '',
    message: '',
    guestSeat: options.guestSeat ?? null,
  };

  function publish(next: Partial<ProfilePanelState>): void {
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener();
  }

  async function load(): Promise<void> {
    publish({ status: 'loading', message: '' });
    try {
      const profile = await options.client.readOwnProfile();
      publish({
        status: 'ready',
        profile,
        usernameDraft: profile.username ?? '',
        avatarDraft: profile.avatar.kind === 'chosen' ? profile.avatar.value : '',
        message: '',
      });
    } catch (error) {
      publish({ status: 'error', message: messageFor(error, 'Could not load your profile. Retry.') });
    }
  }

  async function save(): Promise<void> {
    const username = state.usernameDraft.trim();
    if (username.length > 0 && isReservedUsername(username)) {
      publish({ status: 'ready', message: 'That name is reserved.' });
      return;
    }
    if (username.length > 0 && !isAcceptableUsername(username)) {
      publish({ status: 'ready', message: 'Use 3 to 24 letters, digits, dashes.' });
      return;
    }
    if (!isAcceptableAvatar(state.avatarDraft)) {
      publish({ status: 'ready', message: 'Choose an avatar from the list.' });
      return;
    }
    publish({ status: 'saving', message: 'Saving…' });
    try {
      const profile = await options.client.updateOwnProfile({
        username: username.length > 0 ? username : null,
        avatar: state.avatarDraft,
      });
      publish({
        status: 'ready',
        profile: state.profile ? { ...state.profile, ...profile } : null,
        usernameDraft: profile.username ?? '',
        avatarDraft: profile.avatar.kind === 'chosen' ? profile.avatar.value : '',
        message: 'Profile saved.',
      });
    } catch (error) {
      publish({ status: 'ready', message: messageFor(error, 'Could not save your profile. Retry.') });
    }
  }

  async function linkGuestSeat(): Promise<void> {
    const seat = state.guestSeat;
    if (!seat) {
      publish({ status: state.status, message: 'No guest seat is open in this browser.' });
      return;
    }
    publish({ status: 'linking', message: 'Linking guest seat…' });
    try {
      await options.client.linkGuestSeat(seat);
      const profile = await options.client.readOwnProfile();
      publish({ status: 'ready', profile, message: 'Guest seat linked to your account.' });
    } catch (error) {
      publish({ status: 'ready', message: messageFor(error, 'Could not link the guest seat. Retry.') });
    }
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load,
    setUsernameDraft(value) {
      publish({ usernameDraft: value, message: '' });
    },
    setAvatarDraft(value) {
      publish({ avatarDraft: value, message: '' });
    },
    save,
    linkGuestSeat,
  };
}

/**
 * Turns a failed request into one short sentence.
 *
 * The service error code is the stable part of a refusal, so the copy is
 * chosen from the code and never read out of an English message. The message
 * names the problem and the recovery. It never carries a status code, a URL,
 * or a service detail.
 *
 * A refusal that does not say which part was refused keeps its own copy: the
 * link route carries the account session and the ownership proof, so it never
 * claims that the guest seat is gone when the session may be the cause.
 */
function messageFor(error: unknown, fallback: string): string {
  const code = error instanceof ProfileRequestError ? error.code : '';
  const chosen = code ? BY_CODE.get(code) : undefined;
  if (chosen) return chosen;
  if (error instanceof Error) {
    const detail = error.message;
    if (/taken/i.test(detail)) return BY_CODE.get('username_taken') ?? fallback;
    if (/reserved/i.test(detail)) return BY_CODE.get('reserved_username') ?? fallback;
    if (/not allowed/i.test(detail)) return BY_CODE.get('invalid_username') ?? fallback;
    if (/already linked/i.test(detail)) return BY_CODE.get('seat_already_linked') ?? fallback;
    if (/no longer yours/i.test(detail)) return BY_CODE.get('guest_seat_unauthorized') ?? fallback;
    if (/link was refused/i.test(detail)) return BY_CODE.get('link_unauthorized') ?? fallback;
    if (/account changed/i.test(detail)) return BY_CODE.get('account_changed') ?? fallback;
    if (/sign in/i.test(detail)) return BY_CODE.get('not_signed_in') ?? fallback;
    if (/unavailable|invalid response/i.test(detail)) return fallback;
  }
  return fallback;
}

/** The copy of each service refusal. */
const BY_CODE = new Map<string, string>([
  ['username_taken', 'That name is already taken.'],
  ['invalid_username', 'Use 3 to 24 letters, digits, dashes.'],
  ['reserved_username', 'That name is reserved.'],
  ['invalid_avatar', 'Choose an avatar from the list.'],
  ['seat_already_linked', 'That guest seat is already linked.'],
  ['proof_already_used', 'That ownership proof was already used.'],
  ['proof_seat_mismatch', 'That proof names another seat.'],
  ['guest_seat_unauthorized', 'That guest seat is no longer yours.'],
  ['link_unauthorized', 'Link refused. Sign in again or rejoin the seat.'],
  ['account_changed', 'The signed-in account changed.'],
  ['not_signed_in', 'Sign in to edit your profile.'],
  ['no_guest_seat', 'No guest seat is open in this browser.'],
  ['temporarily_unavailable', 'The profile service is unavailable. Retry.'],
]);
