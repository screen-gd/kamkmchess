# Online participant authorization

[KHA-67](https://linear.app/kamkm/issue/KHA-67/authorize-online-participants-and-revocable-guest-seats)
adds a participant authorization boundary around the shared online writer. Private archive sync
keeps its existing Clerk-only routes and payloads. This code does not enable friend matchmaking,
public queues or an online board interface.

## HTTP boundary

The server mounts these routes under `/v1/online`:

| Method and path | Access | Result |
| --- | --- | --- |
| `GET /matches/{matchId}/replay` | Public | Completed replay projection, or 404 |
| `GET /matches/{matchId}` | Participant | Live match with internal identities removed |
| `GET /matches/{matchId}/operations/{operationId}` | Participant | Original accepted receipt |
| `POST /matches/{matchId}/commands` | Participant | Accepted receipt, or a refusal |

Accounts send `Authorization: Bearer <Clerk session token>`. Guests send
`X-Guest-Seat-Token: <private seat credential>`. Presenting both is rejected. Tokens never belong
in URLs, shared state or logs. Command bodies use the existing versioned `online.Command` envelope.
The route refuses `create_match`; a browser cannot create a match by naming somebody else's seat.

Mutations require an explicit `Origin`. Cross-origin browser reads also send it. Same-origin GET
requests may omit it, so the handler resolves a configured allowed origin whose host matches the
request host and refuses cross-site fetch metadata. Include the API's origin in `APP_ALLOWED_ORIGINS`
when serving the browser and API on the same origin. Forwarded scheme headers do not select origins.

Membership failures and missing matches both return 404. Invalid credentials return 401, invalid
requests 400, missing mutation origin 403, version/operation conflicts 409 and unavailable rules or
storage 503. JSON responses use `Cache-Control: no-store`.

The live response contains position, clocks, accepted moves, public labels, declared controls,
pending draw and takeback offers, the spent recovery budget of each seat and `yourSeat`. It omits
participant references, Clerk subjects, guest IDs, session IDs, credential IDs and hashes. Public
replay reads use the existing completed-game allowlist and respect removal.

## Credentials and revocation

`backend/onlineauth` verifies Clerk identity, session ID, origin and expiry, then checks durable
session revocations. `RevokeAccountSession` records a single session; `RevokeAccountSessions` blocks
the account, including later sessions. These are trusted server methods. This slice does not
subscribe to Clerk webhooks or poll Clerk session status. An external Clerk revocation becomes
visible through token expiry unless the server records it through the revocation method.

Guest control uses a 32-byte random secret with a distinct format. PostgreSQL stores a domain-separated
SHA-256 hash, match, seat, guest identity, origin, expiry and one-way revocation/supersession fields.
A credential for one seat cannot command another match or seat. A retained, valid credential can
reconnect to the same participant. The API role can access the new authorization tables; the rules
role and `PUBLIC` cannot.

The writer checks authorization before duplicate receipts and accepted changes. Guest-seat and
account advisory locks order revocation with accepted writes. Decision time and credential expiry
are checked after lock waits. Participant reads hold a shared match lock under READ COMMITTED so
they see revocations committed while waiting for authorization. Rules evaluation remains outside
the transaction. A revocation accepted while the worker runs prevents the later candidate from committing.

## Invitation, linking and removal interfaces

`onlineauth.Allocator` is a trusted server capability. The future invitation allocator calls
`AcceptInvitation` only after accepting and consuming the invitation. There is no public issuance
route, and invitation possession alone never authenticates a match participant. KHA-75 owns the
invitation's expiry, consumption, cancellation and allocation transaction.

The allocator can issue a short-lived ownership proof from a valid guest credential. The proof has
a separate secret format and hash and cannot command a seat. Revoking, superseding or expiring its
parent credential invalidates the proof. Minting is serialized with seat revocation.
`AuthorizeGuestLink` verifies the proof
for an authenticated account principal. It does not change seat ownership or merge history.
KHA-72 owns explicit linking, must consume or bind the proof within its linking transaction, and
must preserve the original actor used in operation fingerprints.

KHA-72 implements that link. The public profile service re-verifies the account session, the
proof, the parent credential, the seat ownership and every expiry inside the link transaction,
under the account lock and the guest seat lock, and consumes the proof there. The seat owner, the
guest actor and the accepted fingerprints are unchanged. `VerifyLinkSeat` is the in-transaction
verification the link uses, and the advisory lock helpers let the link take the same locks the
revocation paths take. See [the public profile contract](public-profiles.md).

A verified guest can use its participant authority to request replay removal through the existing
command contract. Trusted removal handling can revoke the guest seat's credentials. Full erasure,
anonymization, retention and restore handling remain KHA-79.

## Browser boundary

`src/online/session.ts` composes the existing `AccountSession` subscription with an explicitly
selected guest credential. Identity changes and same-account session replacement fence pending
requests. A token refresh preserves the same identity. Signing in never silently links a guest seat.
After `clear()`, explicit participant selection is required to resume. Dispose the participant
session and requester when their owning workspace is disposed.

`src/online/request.ts` requires a trusted HTTPS API base URL, with HTTP allowed for loopback.
Each request and renewal obtains credentials again and checks scope, expiry and generation.
Cancellation settles pending token, fetch and body work even when an injected transport ignores
the abort signal. Renewing releases the prior stream. Requests omit cookies, reject redirects and
reserve credential headers against caller overrides. Credentials stay in memory; device persistence
and the invitation UI must deliberately manage reconnect storage in their own integration.

`describeCredential` returns private local state. Its account and guest identifiers are unsuitable
for shared snapshots, public labels, logs or analytics.

## Streams and configuration

`AuthorizeStream` and `RenewStream` check current participant membership and credentials. A grant
lasts at most 20 seconds or credential expiry. The [online update transport](online-updates.md)
uses those grants for finite fetch-SSE windows, with canonical snapshots, version cursors and
authenticated polling. Each renewal obtains fresh credentials and repeats membership checks.

Server-only optional settings are `ONLINE_RULES_WORKER_ENTRY`, `ONLINE_GUEST_CREDENTIAL_TTL`
with a 12-hour default, `ONLINE_OWNERSHIP_PROOF_TTL` with a 15-minute default, and
`ONLINE_STREAM_MAX_DURATION`, capped at 20 seconds. The trusted deadline reconciliation reads
`ONLINE_DEADLINE_SWEEP_INTERVAL`, with a one-second default, and `ONLINE_DEADLINE_SWEEP_BATCH`,
with a batch of one hundred. Build the private artifact with `pnpm build:rules-worker`. An absent
worker entry leaves rules-dependent commands unavailable. Apply migrations separately through
`cmd/migrate`; server startup never migrates the database.
