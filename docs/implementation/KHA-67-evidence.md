# KHA-67 participant authorization evidence

Locally verified on 2026-10-20 on `feature/kha67-participant-auth`.
Tested source commit: `38f6e6ae8328380ec85ef3ef12274853b44fb76b`.
The branch starts at `3431b16`, which includes the KHA-64/65/66 foundations.

## Implemented contract

The server composes a participant-only online HTTP API with the existing Go writer. Clerk accounts
carry verified session identity, origin and expiry. Guest credentials are random, hashed at rest,
revocable and bound to a match, seat and origin. Live responses omit internal authentication
identifiers. Completed public replays use the existing allowlist. There is no public match creation
or guest credential issuance route.

The trusted invitation allocator issues guest credentials only for an existing seat owned by that
guest. Rotations leave one live credential per seat. Ownership proofs cannot control a seat and
become invalid with their revoked, superseded or expired parent credential. Minting shares the
revocation lock. Link authorization requires an authenticated account principal and does not change
the original guest actor, seat or receipt fingerprint.

Authorization is checked before receipt retries, participant reads and writes. Participant snapshots
use READ COMMITTED with a shared match lock so a pending revocation cannot hide behind an older
snapshot. Accepted commands sample decision time after authorization lock waits and recheck expiry.
Rules evaluation holds no transaction or database lock.

The browser request boundary checks a trusted service origin, obtains credentials for each request
and renewal, rejects guest scope mismatches and fences token, fetch and body work after participant
changes. It cancels underlying readers even when a transport ignores abort. Account-session disposal
notifies subscribers. Guests never silently merge into signed-in accounts. Cleared credentials need
an explicit selection to resume.

API, configuration and integration responsibilities are in
[the authorization contract](../architecture/online-authorization.md).

## Verification

`pnpm check` passed ESLint, both TypeScript projects, 744 tests across 67 files, the browser production
build, the private rules-worker build and distribution notices. The pre-change baseline had 673
tests. Focused regressions cover identity and same-account session changes, disposal, delayed token
resolution, trusted origins, expiry, credential-header conflicts, stream renewal, stale chunks,
listener cleanup and unfinished JSON bodies.

PostgreSQL 17.11 ran in the isolated local `kamkmchess-kha67-local` container on loopback port 55467.
Each database fixture created and dropped its own schema. Final commands were:

```powershell
$env:KHA41_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:55467/kamkmchess_online_test?sslmode=disable'
$env:KHA41_REQUIRE_POSTGRES='1'
$env:KHA66_WORKER_ENTRY=Join-Path (Get-Location).Path 'build/rules-worker/worker.mjs'
go test -count=1 ./backend/... ./cmd/...
go vet ./backend/... ./cmd/...
```

Both commands passed. The full integration package took 33 seconds. Checks used the real private
Node rules artifact and required PostgreSQL rather than skipping absent-database fixtures.

New Go fixtures cover:

- Actual HTTP, authorization-service and PostgreSQL composition for guest commands, redacted live
  state, exact receipts, same-origin GETs, wrong origins, missing mutation origins and revoked access.
- Wrong owner, seat and match; expired credentials; durable account-session revocation before token
  expiry; guest reconnect; public replay separation; secret-free persisted state and role isolation.
- Revocation during rules evaluation and revocation serialized with an accepted write.
- Pending revocation before a participant read, duplicate move preflight or duplicate create retry.
- Authorization lock waits crossing chess deadlines or credential expiry, with no extra move or increment.
- Empty revocation reasons normalized to `owner_request`.
- Proof invalidation by revocation, rotation and expiry; account identity checks; proof issuance racing
  seat removal; insert guards, one live credential per seat and immutable original seat ownership.
- Stream grant renewal with fresh credentials, membership and revocation checks, bounded by token
  expiry and a hard maximum of 20 seconds.

The existing lost-acknowledgement fixture now overlaps requests during external evaluation, where
no match lock is held. Its assertions remain unchanged. Isolated schema names have a random suffix
to prevent collisions between concurrently running test processes.

The correction agents checked that the new timing and proof regressions fail against the unfixed
code. Browser cleanup regressions also failed before their fixes. `git diff --check` passed.
The Windows race detector was not run locally because this host has no C compiler. The existing
Linux Go CI configuration runs `go test -race` against PostgreSQL and the built worker.

## Chromium CORS check

A review suggested `cache: 'no-store'` would break cross-origin preflight. A real Chromium check
through T3 preview disproved it. Two local HTTP origins used the online API's exact allowed-header
list. Account and guest requests both returned 200. Captured preflight requested only `authorization`
or `x-guest-seat-token`; Chromium's automatic `Pragma` and `Cache-Control` headers were not included
in that requested header list. Cache policy and the CORS allowlist were retained.

## Acceptance boundaries and review disposition

ARC-05 and ARC-06 have local authorization, HTTP and database evidence. The overall product matrix
remains unchanged. These fixtures do not establish deployed or native acceptance.

Full SSE delivery, heartbeats, cursors and polling recovery remain KHA-69. This slice tests stream
authorization windows and renewal primitives, without claiming a delivered subscription journey.
KHA-75 owns invitation consumption, cancellation and the acceptance transaction. KHA-72 owns the
explicit account link and must atomically consume or bind a proof when that link commits. KHA-79
owns complete erasure, anonymization, retention and safe restore. Guest removal authority here uses
the existing participant replay-removal command and trusted seat revocation methods.

Durable account revocation methods are implemented and tested. No Clerk webhook or session-status
poller populates them automatically yet. Revocation made only in Clerk is enforced through token
expiry unless trusted server integration records it first. Deployment and provider spending were
not performed. The verification above used the local source tree; branch publication is tracked
separately in the pull request.

OpenCode `opencode/minimax-m3.1-flash-free` handled implementation, independent reviews and corrective
work. The parent checked the findings, rejected the disproved CORS claim, completed two browser
resource-cleanup corrections and ran the final combined checks. The optional authorizer remains a
trusted-service interface for existing offline fixtures; production composition explicitly installs it.
