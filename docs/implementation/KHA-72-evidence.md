# KHA-72 public profile and explicit guest linking evidence

## Parent response cleanup regression

The parent added a real `ReadableStream` regression for an identity change
during an unfinished JSON body. It failed because `Response.text()` held the
reader lock and cancellation of the locked body never reached its source.
The client now owns the reader, cancels it on identity invalidation and
releases its lock. The regression and all 78 focused profile/account tests
pass. Additional liveness checks discard work invalidated between promise
stages. The workspace also clears the profile binding at the start of its
identity fence, before asynchronous sign-out cleanup.

The repository's mounted account-switch Chromium check passes on the
integrated source. It sends no interrupted save and sends the healthy save
with the replacement account's token.

Integrated on 2026-10-20 on `feature/kha68-kha72-online-core`. The tested
source commit for the final profile review is `bd0f392`. The combined
deadline integration is `190ee98`; its final checks are recorded below.

The integrated implementation commits are `fd700fc` for the service, routes,
storage and PostgreSQL fixtures, `c5e07bc` for the browser client and panel,
`75bf589` for the initial review corrections, and `c3fb56d` for compact profile
controls. The account-switch corrections are `99e122a`, `1391fa3`,
`df0818c` and `bd0f392`. These commits are ancestors of the combined branch.

## Implemented contract

A signed-in account has a stable public identity that is independent of its
editable name, its chosen avatar, and its private sign-in identity. The
public profile identifier is a random opaque value, the username is chosen
deliberately and compared case-insensitively, and the avatar is a key from a
bounded catalog of eight. A generated avatar is the default until the owner
chooses one, and it is derived from the public profile identifier, so it is
stable for a person and stores nothing.

The public payload is an allowlist: the public identifier, the chosen name,
the chosen avatar, and the timestamps. The account identifier, the sign-in
email, the legal name, the session, the credential and every hash stay on the
server. The HTTP response and the browser parser both reject an unknown
field, so a private value cannot reach a public payload even by accident.

A guest has no profile. A guest stays labelled `Guest`, and separate guests
are never merged because they share that label.

Linking a guest seat to an account is an explicit action. The browser proves
that it controls the seat by minting a short-lived ownership proof from the
private guest seat credential; a shareable invitation link is never a proof.
The signed-in account then asks to link the seat, and the proof must name
exactly that seat. The link transaction holds the account advisory lock and
the guest seat advisory lock, the same locks the revocation paths hold, and
inside the transaction it re-checks the account session revocation, the
proof, the parent credential, the seat ownership and every expiry, because a
lock can be held for an unbounded time. The proof is consumed in that same
transaction.

The link changes nothing else. The seat owner in `online_seats` stays the
guest, the guest stays the actor of every accepted move, the accepted
receipts stay, and the accepted operation fingerprints keep their original
value. Signing in never links a seat on its own.

The service, the routes, the storage, the username rules and the boundaries
are described in [the public profile contract](../architecture/public-profiles.md).

## Verification

`pnpm check` passed ESLint, both TypeScript projects, 803 tests across 71
files, the browser production build, the private rules-worker build and the
distribution notices. The pre-change baseline had 744 tests across 67 files.

PostgreSQL 17.11 ran in the isolated local `kamkmchess-kha67-local`
container on loopback port 55467. Each database fixture created and dropped
its own schema. The final commands were:

```powershell
$env:KHA41_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:55467/kamkmchess_online_test?sslmode=disable'
$env:KHA41_REQUIRE_POSTGRES='1'
$env:KHA66_WORKER_ENTRY=Join-Path (Get-Location).Path 'build/rules-worker/worker.mjs'
go test -count=1 ./backend/... ./cmd/...
go vet ./backend/... ./cmd/...
```

Both commands passed. The full integration package took 71 seconds. The
checks used the real private Node rules artifact and required PostgreSQL
rather than skipping absent-database fixtures. The Windows race detector was
not run locally because this host has no C compiler; the existing Linux Go CI
configuration runs `go test -race` against PostgreSQL and the built worker.

The new fixtures are:

- 14 PostgreSQL integration fixtures in
  `backend/integration/online_profile_test.go`, over the real HTTP
  composition, the real authorization service and the real database.
- 6 unit fixtures in `backend/profile/profile_test.go` for the public name
  and avatar rules and for the shared shape contract.
- 58 browser fixtures in `src/profile/` for the wire contract, the client,
  the identity binding and the panel state machine.

The integration fixtures cover:

- A public profile created on first use and published without the account
  identity. The signed-out read returns exactly the allowlisted fields, and
  the payload carries no account identifier, email, session or Clerk value.
  An unknown profile is a 404.
- The username lookup a named friend challenge needs. It is
  case-insensitive, it finds the owner whichever spelling the challenger
  typed, it keeps the chosen spelling, and an unknown name is a 404.
- Username uniqueness. The same name in another spelling belongs to the same
  owner, and two accounts racing for one free name produce exactly one
  winner and one `username_taken` refusal, with one profile owning the name
  afterwards.
- Ownership-checked edits. A body that names another profile, another
  account or an owner is refused as an unknown field and the other
  account's profile is untouched. A guest credential never acts on an
  account route.
- The avatar. An avatar outside the catalog is refused and the stored choice
  never changes; a chosen avatar is published as a bounded key; clearing the
  choice returns the generated default.
- Reserved and unsafe names. The reserved names, a name that is too short, a
  name with a space, a name that reads as an email address, a name with a
  leading or trailing dash and an over-long name are all refused, and a
  refused name is never published.
- The removal of a chosen name. An empty name removes the chosen name and
  returns the profile to the generated default, and the removed name is free
  again for another account.
- Two concurrent edits of the same profile. The row lock orders them, so the
  name and the avatar never end up from different requests.
- The explicit guest link. The guest moves before the link, so an accepted
  fingerprint exists. Signing in does not link the seat. The guest mints an
  ownership proof from its own seat credential, and the proof identifier
  matches the shape the browser contract parses. The account links the seat,
  the seat owner is still the guest afterwards, the stored receipt is still
  readable, the duplicate operation still returns it, the link is listed on
  the account's profile, the spent proof no longer verifies anywhere, and
  the same proof cannot link a second profile.
- The rejection of another person's seat. A proof for another seat never
  links this one, in both directions and for both accounts. A guest seat
  credential is not an ownership proof. A request without a proof is refused.
  A guest never links a seat to an account. A seat that is already linked is
  refused for a second account, even with a fresh valid proof of that seat.
  No refused request created a link.
- A dead proof and a dead credential. A revoked seat credential invalidates
  every proof it issued, so the link is refused.
- A revoked account session. The link is refused and no link row is
  created.
- The link ledger guard. A link row that names a seat the guest does not
  own is refused by the database with SQLSTATE 55000, even when it is
  written directly.
- The stored profile keeps the account identifier on the server, and the
  public identifier does not contain it.

The browser fixtures cover the closed wire contract (an unknown field, a
missing field, an unsupported version, a name outside the contract and an
avatar outside the catalog are all refused), the shared shape contract (the
browser rules and the service rules are the same, and the fixture in
`backend/profile/testdata` is read by both), the client (a public read with
no credential at all, an account call that keeps the credential in the
`Authorization` header and out of the body, a name that another profile
already owns, the service error code of a refusal, a request without a
signed-in account, the two-step guest link, a proof that names another seat,
a browser that holds no guest credential, a base URL that is not a trusted
service origin, and a failed request with its status), the identity binding
(a refresh of the same identity keeps the binding, a changed account, a
replaced session and a changed guest seat make a new one, and a disposed
tracker fences the binding), and the panel state machine (the load, the
save, the refused name before the request leaves, the reserved name before
the request leaves, the name conflict, the guest link, the missing guest
seat, the already linked seat, the spent proof, an expired account session,
a refused link and a failed load).

## The account-switch corrections

An independent review of the integrated slice found that the profile surface
was not bound to the account it loaded. The client resolved the session
token at call time, so a save that started under one account could be sent
under the account that replaced it, and a load that started under the
previous account could publish into the new account's surface. The same
review found that an expired account session was reported as a lost guest
seat, and it recorded three lower findings.

The corrections are:

- The profile surface is bound to an identity. `src/profile/identity.ts`
  makes a binding that names the signed-in account and the guest seat, and
  the signal of that binding fires when either of them changes. The client
  checks the binding after every asynchronous stage of a credentialed call:
  the session token, the request, the response body, the ownership proof,
  the link and the reload after the link. A token minted for a replaced
  account is discarded, a request that has not left the browser is never
  sent, a response that arrives too late is released instead of published,
  and a pending call settles with `account_changed` instead of hanging.
- The tracker makes a new binding when the account changes, when the Clerk
  session is replaced, when the guest seat credential changes and when the
  workspace is disposed. The same identity object reported again is not a
  new owner, so an ordinary refresh keeps the binding.
- The account workspace owns the tracker, and the panel is mounted for one
  binding. A replaced account therefore shows its own profile and never the
  drafts of the account it replaced. A signed-out browser and a browser in
  the middle of a session change ask for a sign-in; only a build without a
  service origin says that the profile service is not configured.
- The client tells the three refusals apart. An account route that answers
  401 is an expired account session and asks for a sign-in. The ownership
  proof route keeps the guest seat sentence. The link route carries the
  account session and the ownership proof at once, so its refusal says that
  the link was refused and does not claim which of the two failed.
- A reserved public name has its own sentence, so a reserved name is no
  longer refused with the shape guidance.
- The credential header slot belongs to the boundary. The generic caller
  header bag is gone; the ownership proof travels in its own named header
  and the credential is written last, so no caller header can replace it or
  add a second spelling of it. The link fixture shows the account
  credential and the ownership proof travelling side by side.
- The linked guest seats are still listed without a limit. The interface
  shows a count, the wire contract stays complete because the panel decides
  whether the current seat is already linked from the full set, and the
  scaling concern is recorded for KHA-78 and KHA-83 rather than answered
  with a silent truncation.
- The unconditional delete guard of migration `0005_public_profiles.sql` is
  recorded as an integration note for KHA-79. No deletion behaviour was
  changed here.

## Browser check

A real Chromium check through T3 preview confirmed the interface behaviour
that the service fixtures cannot show. The harness in
`experiments/kha72-profile/` mounts the real panel and the real state
machine against a local stand-in for the profile service.

The loaded panel showed the public profile identifier, the chosen name, the
name field, the avatar choice with the selected swatch outlined, the save
action and the guest seat section. Typing a name that another profile owns
and saving answered `That name is already taken.` and left the published
name unchanged. Typing a new name, choosing another avatar and saving
answered `Profile saved.`, published the new name and selected the new
avatar. Linking the guest seat answered `Guest seat linked to your account.`
and listed the linked seat. The panel was inspected in the light and the
dark appearance, and the automated design detector reported no findings on
the changed interface files.

The first pass of this check found a real defect: the panel never loaded,
because the interface tore the panel down in its effect cleanup and React's
development double-mount disposed the panel before the first load resolved.
The panel now holds no resource of its own, so it needs no teardown, and the
check confirmed the load, the save, the conflict and the link.

The second pass added an account switch to the same harness. The page
`experiments/kha72-profile/switch.html` mounts the real panel with the real
client and the real identity binding, and
`experiments/kha72-profile/check-switch.mjs` drives it with the repository
Playwright Chromium. The check starts a save under one account, replaces the
account while the session token is still being minted, and then starts a
save that is not interrupted. The interrupted save never reaches the
service, the new account shows its own profile instead of the drafts of the
account it replaced, and the uninterrupted save is sent under the account it
started under. The check was run against the shipped source and against a
source with the fence removed; it fails on the second one, so it is a
regression check and not a screenshot. The first panel preview was run
again on the corrected source and still answered `That name is already
taken.`, `Profile saved.` and `Guest seat linked to your account.` without a
page error.

The mounted account workspace itself was not exercised in a browser: it
needs a hosted Clerk session, which this check does not reach. What the
check covers is the part that can be exercised locally, the panel mounted
for one binding with the real client, the real state machine and the real
identity binding.

This is a local check of the interface against a stub service. It is not a
deployed acceptance run, and it does not certify native accessibility, other
browsers or devices.

## Acceptance boundaries and review disposition

`HIS-01` and `HIS-02` have local service, HTTP, database and browser
evidence. The scenarios in the acceptance matrix remain `not_run`, because
that matrix is only updated by the owner against the deployed product, and
these fixtures do not establish deployed or native acceptance.

The public history, the public replay, the control attribution, the ordinary
account deletion and the explicit removal request belong to KHA-78 and
KHA-79. This slice does not publish a game, does not anonymize a
participant, does not remove a replay, and does not claim any of those
behaviours.

Three boundaries are deliberate and are stated rather than hidden:

- The link is an association, not a seat takeover. Seat control stays with
  the retained guest credential, as KHA-67 established, and a linked account
  does not gain the ability to command the seat.
- The ownership proof is a capability for the seat it names. It is minted
  only from the seat credential, it names one seat, it is single use, and
  the browser that controls a guest seat is the browser that can link it.
  A stolen guest seat credential would therefore be as consequential as a
  stolen session token; the link does not add a new transfer of authority.
- A guest seat can only be linked while its credential is live. A revoked,
  superseded or expired credential invalidates every proof it issued, so a
  guest that returns after the credential expired cannot link that seat
  later.

One further boundary is a product gap rather than a design choice. The
application can only offer the link once a browser holds a guest seat
credential. The invitation and guest-join flow belongs to KHA-75, so until
that flow exists the account workspace never holds one, and the panel says
that linking needs an open guest seat. The service path, the browser client
path and the proof of ownership are complete and exercised; what is missing
is the invitation flow that produces the guest seat in the first place.

The invitation, queue and match-claiming surfaces are not part of this
slice. The named friend challenge that uses the username lookup is a later
ticket. The offline game layout, the existing sign-in controls and the
private account controls are unchanged.

Deployment and provider spending were not performed. The verification above
used the local source tree and the local PostgreSQL container; branch
publication and the pull request are tracked separately.

An independent review of the slice against the ticket contract ran on the
same branch. It found that the browser contract parsed a proof identifier
shape the service never issued, that a removed public name was a silent
no-op across the wire, that the profile API's preflight did not allow the
method it uses, that the link took a seat lock from a client-supplied value
before the proof was checked, that a spent proof stayed live in the
authorization service, that the profile writes were not ordered against a
session revocation, and that the panel never loaded under React's
development double-mount. All seven were corrected, and the corrections are
covered by the fixtures and the browser check above.

A second independent review ran on the integrated source and found that the
profile surface was not bound to the account it loaded, that an expired
account session was reported as a lost guest seat, and three lower
findings. Those findings and their dispositions are in
[the account-switch corrections](#the-account-switch-corrections) above.

OpenCode `opencode/minimax-m3.1-flash-free` handled the implementation, the
fixtures, the independent review and the browser check. The parent reviewed
the findings, the integration and the tracker updates.

## Parent integration checks

The KHA-68 and KHA-72 commits were combined on
`feature/kha68-kha72-online-core`. TypeScript and the full Go suite passed
with required PostgreSQL and the real rules worker after integration.

The profile panel now uses the shared icon buttons for save, link and profile
navigation. It shows the public name and avatar, a linked-seat count and one
status message. Opaque profile and match identifiers are kept out of this
settings view. A linked seat cannot be linked again through the button, save
is disabled until the profile loads, and a failed load offers Retry.

T3 preview navigation and snapshots timed out. No alternate browser was
available through CUA, so the repository's Playwright Chromium checked the
real component against its local service stand-in. Name conflict, save,
avatar selection, explicit link and the disabled repeat-link action passed.
Desktop and phone widths had no horizontal overflow or page errors. The
linked-success view used 14 words of interface copy, excluding the chosen
public name and numeric count. The manual Impeccable detector found no
issues. The account-switch review is recorded below. The later live invitation
and hosted acceptance runs remain separate.

## The account-switch review

The account-switch review was carried out on the integrated source
and its findings were corrected in `99e122a`, `1391fa3`, `df0818c` and `bd0f392`. The
profile surface is now bound to an identity binding, every credentialed
stage of a call is fenced by it, and the panel is mounted for one binding,
so a replaced account never receives the drafts, the requests or the
answers of the account it replaced. The expired account session, the lost
guest seat and the refused link are now three different sentences.

The corrections are browser-side. The service, the storage, the routes, the
single-use proof, the lock order, the post-lock expiry checks, the wrong
seat refusal and the public allowlist were reviewed and left unchanged, and
the Go suite passed unchanged after the corrections.

The remaining boundaries are unchanged: the linked guest seats are still
listed without a limit and the scaling concern is recorded for KHA-78 and
KHA-83, the unconditional delete guard of migration 0005 is recorded for
KHA-79, and the application still cannot offer a link before the KHA-75
invitation flow exists.

`HIS-01` and `HIS-02` remain `not_run` in the acceptance matrix. The
fixtures and the browser check above are local evidence about the source,
not evidence about the deployed product.

The final independent MiniMax review at `bd0f392` found no blocking issues.
It re-ran all 806 browser unit tests, the 58 profile tests, Go build and vet,
and the mounted account-switch Chromium check. The remaining low finding was
the evidence's reference to isolated commits; the integrated commit references
above correct it.

## Final integrated verification

The tested combined source is `9d2409d6f212ee9be4b39ca7dc20789ebeba98b8`
on `feature/kha68-kha72-online-core`, verified on 2026-10-20.

`pnpm check` passed on the deadline merge `190ee98`: lint, both TypeScript
projects, all 806 tests across 71 files, the production build, rules-worker
bundle and distribution notices. The mounted Chromium account-switch check
also passed, with no interrupted PUT and one healthy PUT under the replacement
account's token. The later `9d2409d` changes Go deadline scanning and its
regression only; the tested frontend source is unchanged.

On `9d2409d`, `go vet ./backend/... ./cmd/...` and the full Go test suite passed
with required PostgreSQL and the real rules worker. All 150 integration test
outcomes passed, including subtests, with no individual test skipped. The
profile service, ownership proof, public allowlist and identity regression
checks are included. `HIS-01` and `HIS-02` remain `not_run` in the deployed
acceptance matrix.
