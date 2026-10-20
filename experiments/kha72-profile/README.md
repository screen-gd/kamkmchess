# KHA-72 public profile browser check

From the repository root, run `pnpm dev --port 5183 --strictPort` and open
`http://127.0.0.1:5183/experiments/kha72-profile/index.html`.

The page mounts the real `ProfilePanel` component and the real panel state
machine. Only the profile service is a local stand-in: it answers with a
fixture profile, refuses the name `rookie` the way the service refuses a name
another profile already owns, and accepts a guest link.

The check confirms the interface behaviour that the service fixtures cannot
show: the loaded profile, the name field, the avatar
choice, the saved state, the name-conflict status, the guest-link status, and
the linked guest-seat count.

It does not reach a network service, a hosted account, a provider, or a
deployed bundle. It does not certify native accessibility, other browsers, or
devices, and it is not production acceptance. The product acceptance scenarios
`HIS-01` and `HIS-02` remain `not_run` in the acceptance matrix.

## The account switch check

The second page mounts the same real panel with the real client, the real
state machine and the real identity binding. Only the profile service is a
local stand-in, and it records every request it receives.

```
pnpm dev --port 5186 --strictPort
node experiments/kha72-profile/check-switch.mjs http://127.0.0.1:5186
```

The check starts a save under one account, replaces the account while the
session token is still being minted, and then starts a save that is not
interrupted. It shows that the interrupted save never reaches the service,
that the new account sees its own profile instead of the previous drafts,
and that an uninterrupted save is sent under the account it started under.

Like the panel preview, this check reaches no network service, no hosted
account and no provider. It is not product acceptance, and the product
acceptance scenarios `HIS-01` and `HIS-02` remain `not_run`.
