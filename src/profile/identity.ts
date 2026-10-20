/**
 * The identity binding of the public profile surface (KHA-72).
 *
 * A binding names one signed-in account and the guest seat this browser
 * holds, and it carries the signal that fires when either of them changes.
 * The profile client captures the binding it started under and checks it
 * after every asynchronous stage, so work started under one account can never
 * publish under another: a token minted for the replaced account is
 * discarded, a request that has not left the browser is never sent, and a
 * response that arrives too late is released instead of shown.
 *
 * The tracker owns the lifecycle. It makes a new binding when the account or
 * the guest seat changes, fences the previous one, and holds no listener, no
 * timer and no subscription of its own. The account workspace owns the
 * tracker, so disposing the workspace fences every profile call.
 */

/** The signed-in account a profile call acts for. */
export interface ProfileAccountPort {
  /** The account identifier. */
  readonly accountId: string;
  /** Mints a fresh session token for this account. */
  token(): Promise<string>;
}

/** The guest seat this browser controls, when it holds one. */
export interface ProfileGuestSeatPort {
  /** Mints the private credential of the guest seat. */
  issue(): Promise<string>;
}

/** One binding of the profile surface to an account and a guest seat. */
export interface ProfileIdentityBinding {
  /** The signed-in account, or null when nobody is signed in. */
  readonly account: ProfileAccountPort | null;
  /** The guest seat this browser controls, when it holds one. */
  readonly guestSeat: ProfileGuestSeatPort | null;
  /** A number that moves whenever a new binding is made. */
  readonly generation: number;
  /** Aborted when the account or the guest seat changes. */
  readonly signal: AbortSignal;
  /** Fences the binding and settles every call started under it. */
  abort(): void;
}

/** The lifecycle of the profile bindings of one workspace. */
export interface ProfileIdentityTracker {
  /** The current binding, or null before the first identity arrives. */
  readonly binding: ProfileIdentityBinding | null;
  /**
   * Reports the active identity and returns the binding that owns it.
   *
   * The same account object is not a new owner: a refresh of the same
   * identity keeps the binding. A different account, a replaced session or a
   * different guest seat makes a new binding and fences the previous one, so
   * every call started under the old binding is settled and discarded.
   */
  update(account: ProfileAccountPort | null, guestSeat: ProfileGuestSeatPort | null): ProfileIdentityBinding;
  /** Fences the current binding and settles every call started under it. */
  dispose(): void;
}

/** The number of the next binding. It moves whenever a binding is made. */
let bindingGeneration = 0;

export function createProfileIdentityTracker(): ProfileIdentityTracker {
  let account: ProfileAccountPort | null = null;
  let guestSeat: ProfileGuestSeatPort | null = null;
  let binding: ProfileIdentityBinding | null = null;
  let disposed = false;

  return {
    get binding() { return binding; },
    update(nextAccount, nextGuestSeat) {
      if (disposed) throw new Error('The profile identity tracker was disposed.');
      if (binding && account === nextAccount && guestSeat === nextGuestSeat) return binding;
      account = nextAccount;
      guestSeat = nextGuestSeat;
      binding?.abort();
      binding = createBinding(nextAccount, nextGuestSeat);
      return binding;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      binding?.abort();
      binding = null;
      account = null;
      guestSeat = null;
    },
  };
}

/** Makes one binding of the profile surface to an account and a guest seat. */
function createBinding(
  account: ProfileAccountPort | null,
  guestSeat: ProfileGuestSeatPort | null,
): ProfileIdentityBinding {
  const controller = new AbortController();
  bindingGeneration += 1;
  return {
    account,
    guestSeat,
    generation: bindingGeneration,
    signal: controller.signal,
    abort() { controller.abort(); },
  };
}
