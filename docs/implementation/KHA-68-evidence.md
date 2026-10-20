# KHA-68 authoritative online moves, clocks and match outcomes

## Parent continuity regressions

A final service-boundary regression found that an unavailable timeout policy
could keep the oldest expired match in every bounded batch, starving a later
opening abort. The test failed with a one-match batch because the second pass
selected the same pending timeout again. Batches now rotate by match identifier
and wrap for retries. The test verifies the later opening abort and the subsequent
retry of the original timeout. The focused deadline suite passes after the fix.

Integration review added two service-boundary PostgreSQL regressions. The
first failed because the takeback armed its deadline before removing the
discarded increments, leaving an extra two seconds on a two-second-increment
clock. The second failed because restoring an earlier turn with no journal
entry erased three attempts already spent in the current turn.

The writer now removes discarded increments before arming the restored
clock. Restored counters retain the larger of the journalled allowance spent
and the current allowance spent, and record that carried budget at the
restored prefix. Both regressions and the focused offer/takeback/recovery
PostgreSQL suite pass. `go vet ./backend/... ./cmd/...` also passes. Final
combined verification is recorded below.

Integrated on 2026-10-20 on `feature/kha68-kha72-online-core`, based on
`a1e069e` and the KHA-64/65/66/67 foundations. The takeback correction commits
are `379957f`, `6c311b5`, `ebff3f1`, `f5bb721`, `e66bda3`, `2cf24dc`,
`1d442aa` and the parent continuity correction `27f9420`.

The automatic deadline implementation is `b3b805b`, with additional fixtures
in `eda669f` and `521e22e`. Its isolated checks passed at `521e22e`.
The combined source and final checks are recorded after integration below.

## Final integrated verification

The tested source is `9d2409d6f212ee9be4b39ca7dc20789ebeba98b8` on
`feature/kha68-kha72-online-core`, verified on 2026-10-20. It includes the
deadline merge `190ee98`, the offer and recovery-budget corrections, the
profile corrections, and the bounded-scan rotation regression.

- `go test -count=1 ./backend/... ./cmd/...` passed with required local
  PostgreSQL and the real bundled rules worker. All 150 integration test
  outcomes passed, including subtests; no individual test was skipped. The
  integration package took 86.6 seconds.
- `go vet ./backend/... ./cmd/...` passed on that source.
- `pnpm check` passed on `190ee98`, with lint, both TypeScript projects,
  all 806 tests across 71 files, the production build, the rules-worker
  bundle and distribution notices. `9d2409d` changes Go and documentation
  only, so the frontend source and its successful check remain unchanged.
- The mounted account-switch Chromium regression passed on `190ee98`.
  The interrupted save sent no PUT; the healthy save used the replacement
  account's token. Its source is unchanged by `9d2409d`.

These are local implementation checks. The acceptance matrix remains
unchanged, and no deployment or paid provider request was performed.

The final independent MiniMax deadline review confirmed the bounded-scan
starvation defect on `190ee98` and cleared the transition, authorization,
rules evaluation, lock checks, offer handling and lifecycle cleanup. The
parent's `9d2409d` fixes that sole blocking finding with the failing-then-passing
service regression described above. The narrow follow-up found no blockers,
passed the focused PostgreSQL regression and vet, and verified scan rotation,
wrap, concurrent-sweep safety and release of locks before external rules work.

## Merge note for the parallel corrections

The deadline correction edits `backend/online/service.go` as well. The shared file is split so the
two corrections can be merged in either order:

- `backend/online/offers.go` holds the offer helpers: `loadOfferByID`, `consentOffer`,
  `supersedeSeatOffer` and `withdrawStaleOffers`. The deadline correction does not touch them.
- `backend/online/budgets.go` holds the turn budget journal: `turnPrefixKey`, `recordTurnBudget`,
  `loadTurnBudgets` and `restoreTurnBudgets`. The deadline correction does not touch them.
- `backend/online/service.go` changes in this slice are confined to `executeOffer`, the
  `ActionAcceptDraw` and `ActionAcceptTakeback` cases of `executeMutation`, the
  `ActionRecordRecoveryAttempt` case, `updateMatch` and `insertEvent`. The deadline correction
  changes the read path and the expiry reconciliation; it does not change these functions.
- `backend/online/rules.go` gains `takebacksAllowed`, a pure clock predicate. The deadline
  correction does not touch it.
- `updateMatch` now withdraws the offers that a version transition made inapplicable. A correction
  that also writes offers has to keep that withdrawal, because the pending offers of a match are
  exactly the actionable ones.

No external rules evaluation happens under a transaction or a database lock, and the authorization
and revocation lock order is unchanged: the credential check and the receipt lookup still run
before the seat check, and the decision time is still sampled after every lock is held.

## Corrections of the independent review

The slice was reviewed independently and the findings were corrected on this branch. The corrections
are in four commits on top of the KHA-68 slice:

- `379957f` adds the offer consent and turn budget schema.
- `6c311b5` binds an offer consent to the exact offered identity, versions the offer lifecycle,
  removes the increment of a discarded move and keeps the opening exchange out of a takeback.
- `ebff3f1` restores the recovery budget of the turn a takeback restores.
- `f5bb721` reports an internal rules history disagreement as a service failure.

The corrections are recorded in detail below. The review findings that are not corrected here are
listed under "Remaining limitations".

## Implemented contract

The shared writer owns the order of an online match. A participant proposes, the Go writer decides.

### Opening phase

No main bank runs before its side's first accepted move. A new match has no armed deadline. The
first accepted move adds the increment once and arms a fifteen second reply window for the other
side instead of starting that side's main clock. The accepted reply closes the window and starts the
main clock of the side to move. An unanswered reply aborts the match unscored with the reason
`opening_reply_timeout`.

The rule follows the side to move, so a custom position that starts with Black to move makes Black
the starting side and White the responder. The opening phase is a historical fact of the match: a
takeback never reopens it.

### Cancellation

`abort` became `cancel` in contract version 2. A cancellation aborts the match while the canceling
side has never had an accepted move and resigns afterwards. Whether a seat ever had an accepted move
is a historical fact stored beside the clock, so a takeback that removes the move from the current
line does not turn a later cancellation back into an abort.

### Offers, takebacks and recovery budgets

A draw offer needs the other participant's acceptance. An offer is part of the versioned match
state: it advances the canonical match version and appends an `offer_created` event that carries
the exact offer it created, so a durable event stream can rebuild which offer is pending. It never
changes the position, the turn or the clocks, and the absolute deadlines stay continuous. The offer
is bound to the version it produced, so any later transition withdraws it and the pending offers of
a match are exactly the actionable ones.

The consent of an offer names the exact offer it accepts. The writer reads that offer under the
match lock and checks its identity, its kind, the offering seat, its resolution and the version it
is bound to. A replaced, consumed or stale offer is refused instead of applying a different offer,
and the named identity is part of the operation fingerprint, so a changed consent cannot reuse an
accepted operation ID. The participant live view exposes the offered identity, and it carries no
participant reference or private data.

A takeback offer names the exact version of an accepted move whose position it would restore, or
version `1` for the starting position. Accepting a takeback restores the position and the current
line, charges the side that was thinking, and arms the restored side to move with its normal main
clock. It refunds no time. The increment that was credited to every discarded accepted move is
removed again, so a replacement move is a new accepted move that receives exactly one increment and
a repeated takeback cannot inflate a bank. The discarded accepted moves stay in `online_moves` and
are marked in `online_discarded_moves`, so the discarded private archives survive.

A takeback is unavailable until the opening exchange is complete. The offer and the acceptance are
refused while the fifteen second reply window is open, and the reply deadline, the match state and
the clocks are never touched by the request. The expiry still takes precedence, so an unanswered
reply still aborts the match. The opening phase is a historical fact: a takeback that restores the
starting position does not reopen the reply window and does not clear the first-move flags, so a
later cancellation is still a resignation.

The recovery budget of a turn lives in the seat row and in the turn journal. The seat counters hold
what the current turn has already spent and are reset when that seat's own move is accepted. The
journal in `online_turn_budgets` records what a seat spent in a turn, keyed by the accepted-move
prefix the turn starts from, so the allowance survives the move that ended the turn. A takeback
restores the turn it restores, and with it the allowance that turn had already spent. A control
change never resets it. The fourth illegal attempt of a turn loses the match for that seat. The
formatting correction budget is independent and stops at three corrections.

### Clock continuity and expiry

The main clock deadline is absolute, so generation, provider failure, Stop/Retry, control changes,
navigation, refresh and peer disconnects neither pause nor refund the chess time. Every intent
reconciles the expiry before it can change the match. The decision time is sampled after the match
and authorization locks are held and is re-sampled after external rules work, so a lock wait that
crosses a deadline is judged against the time the locks were acquired. A final result cannot be
overwritten by a later intent, a stale offer, a late rules candidate or direct SQL.

### Automatic deadline realisation

An opened match arms exactly one deadline: the opening reply window or the main clock. The
expiry is no longer realised only by the next participant intent. The writer owns a trusted
deadline boundary that settles a due match with no participant command at all.

`backend/online/deadline.go` is the boundary.

- `DueDeadlineMatchIDs` is a bounded scan. It returns identifiers only, so no connection waits
  idle between two passes and no connection is held while the rules process works.
- `ReconcileDeadline` settles one match. It reads one consistent snapshot, decides which
  deadline applies, and then re-locks the match row, re-samples the authoritative database clock
  after the lock, and re-checks the version, the control epoch, the rules input hash and the
  expired seat before it writes.
- `ReconcileDeadlines` is one bounded pass over the due matches. It reports how many were due,
  settled, skipped and left pending.

The boundary is trusted, not public. It never fabricates an account or guest identity and it
never spends a participant-chosen operation ID: the trusted transition writes no
`online_operation_receipts` row. The terminal state, the append-only event and the public
projection are written in one transaction under the match row lock, so the transition is atomic,
and the lock makes it idempotent: a second sweep of the same match finds the terminal result and
writes nothing. The participant path and the trusted path share one transition, so they produce
the same event, the same result and the same projection.

A main clock expiry needs the bounded timeout policy, so it is evaluated outside every
transaction and every lock and is then fenced by the re-lock. Without a timeout-capable rules
process, or while the rules service is unavailable, the expiry stays pending for a later pass
and no result is invented. The opening reply abort needs no chess rules, so it is committed
under one lock.

`backend/serverapp/deadlines.go` owns the cadence. `StartDeadlineReconciler` runs the loop and
binds it to the server context and to the returned stop function, and the stop function waits
for the loop to finish so the caller can close its database pool without a background sweep
still using it. `backend/serverapp/server.go` starts the loop in `Open` and stops it in
`release`. The interval and the batch size are read from `ONLINE_DEADLINE_SWEEP_INTERVAL` and
`ONLINE_DEADLINE_SWEEP_BATCH`; an unparsable value falls back to the default instead of failing
the boot.

The participant API keeps its narrow reader and writer interface, so the trusted mutation is not
reachable from any HTTP route and there is no public cron endpoint.

One correctness fix came with the shared transition. The participant path of the opening abort
read the match without its accepted line, so the published replay of a participant-triggered
opening abort carried no moves and the stored rules input hash described an empty line. The
accepted line is now read under the match lock on that path too.

### Contract and schema changes

`backend/online/contracts.go` and `src/online/contracts.ts` moved from schema version 1 to 2.
The action union gains `cancel` (replacing `abort`), `offer_draw`, `accept_draw`, `offer_takeback`,
`accept_takeback` and `record_recovery_attempt`. The clock state gains the opening reply seat and
its deadline, the result reasons gain `opening_reply_timeout` and `illegal_move`, the event kinds
gain `draw_agreement`, `takeback_accepted`, `offer_created`, `recovery_attempt` and
`illegal_move_loss`, and the receipt outcomes gain `opening_expired`.

The correction commits keep schema version 2 and change the shape of two payloads:

- `accept_draw` and `accept_takeback` carry the offered identity. The identity is part of the
  canonical action payload, so it is part of the request fingerprint.
- The `offer_created` event carries the offer it created.

Migration `backend/migrations/0004_online_match_outcomes.sql` is additive. It adds the reply
window columns, the seat recovery budget counters, `online_offers` and `online_discarded_moves`, and
relaxes the match schema version check to accept version 2. It rewrites no existing row. It also
adds two partial indexes over the armed deadline columns so the bounded deadline scan does not
read every stored clock.

Migration `backend/migrations/0006_online_offer_consent.sql` is additive. It adds the offer payload
of an event, the `offer_created` event kind and `online_turn_budgets`, the journal of what a seat
spent in a turn. It rewrites no existing row.

The shared contract fixture `backend/online/testdata/online-contracts.json` carries one example of
every new action and the offer event, and both the Go and the TypeScript suite parse it.

## Verification

`pnpm check` passed ESLint, both TypeScript projects, 785 tests across 70 files, the browser production
build, the private rules-worker build and the distribution notices.

PostgreSQL 17.11 ran in the isolated local `kamkmchess-kha67-local` container on loopback port
55467. Each database fixture created and dropped its own schema. The final commands were:

```powershell
$env:KHA41_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:55467/kamkmchess_online_test?sslmode=disable'
$env:KHA41_REQUIRE_POSTGRES='1'
$env:KHA66_WORKER_ENTRY=Join-Path (Get-Location).Path 'build/rules-worker/worker.mjs'
go vet ./backend/... ./cmd/...
go test -count=1 ./backend/... ./cmd/...
pnpm check
```

All three commands passed. The full integration package took about 240 seconds. The checks used the
real private Node rules artifact and required PostgreSQL rather than skipping absent-database
fixtures.

### Red evidence of the corrections

Each correction was checked against the behaviour it replaces, and the removed code was restored
afterwards:

- Accepting any pending offer of the kind instead of the named one makes the replaced-offer fixture
  and the draw consent fixture fail: the replaced offer is accepted and the match rewinds.
- Removing the turn journal restore fails the two budget fixtures: the restored turn starts again
  with an empty allowance.
- Removing the increment removal fails the increment fixture: the bank keeps the increment of the
  discarded move.
- Allowing a takeback during the opening exchange fails both opening fixtures: the offer is accepted
  while the reply window is open.
- Removing the withdrawal of the stale offers fails the stale takeback fixture and the withdrawn
  draw offer fixture: the inapplicable offer stays pending.

The isolated deadline correction also passed all three commands, with the real private rules
process and the booted server composition. Combined verification follows integration.

### New Go fixtures

`backend/integration/online_outcome_test.go` covers the ticket scenarios against real PostgreSQL.

- MAT-01: no main bank runs before its side's first accepted move, the opening move arms a fifteen
  second reply window, the accepted reply starts the next side's main clock, and the increment is
  added once. A second fixture repeats the rule for a custom position with Black to move.
- MAT-01 and MAT-04: an unanswered opening reply aborts the match unscored, the late reply does not
  become a move, the responder's bank is not charged, and a later intent cannot revive the match.
- MAT-03: a duplicate, a stale version, the wrong seat, a foreign participant and an illegal move
  advance nothing and mint no increment. The illegal move fixture uses the real private rules
  process.
- MAT-02: a cancellation before the seat's first accepted move aborts the match and stays unscored,
  and a cancellation after it resigns. A third fixture takes back the seat's own move and then
  cancels, and the result is still a resignation.
- MAT-08: a control change keeps the active seat, the active start, the deadline and both banks
  unchanged, and the clock still expires on its own deadline. A second fixture moves the start of
  the running clock into the past and shows that the next accepted move charges the elapsed time
  and adds the increment once.
- MAT-11: a draw offer advances the match version, does not move a clock and does not end the match,
  the offering seat cannot accept its own offer, and a seat without an offer cannot accept a draw.
  An accepted move withdraws every pending draw offer, so a declined offer cannot end the match
  later. A takeback restores the exact position and the accepted line, keeps the discarded accepted
  move rows, refunds no time and removes the increment of every discarded move. A stale takeback
  offer is withdrawn, is no longer published as pending and is refused when it is named. A takeback
  offer for a position outside the current line is refused. A finished match exposes no pending
  offer.
- MAT-11: the spent recovery budget of a turn survives a control change, and only an accepted move
  of that seat starts it again. A takeback restores the budget of the turn it restores, so the
  fourth illegal attempt of that turn still loses the match and the automatic formatting allowance
  of that turn cannot be replenished.
- MAT-12: a final result survives a later move, cancellation, draw offer, draw acceptance, takeback
  acceptance and recovery report, and the stored result cannot be rewritten by direct SQL. The
  cancellation is recorded as its own event, so the audit trail separates it from an explicit
  resignation.
- MAT-04: an expired clock settles the match even when the intent that noticed it is refused, so a
  late, stale or wrong-seat intent produces the same terminal event as a late legal move.
- MAT-11 and MAT-12: a late rules candidate evaluated against an earlier position is refused as
  stale and changes nothing.
- ARC-04: a retried offer returns the original receipt bytes and a changed payload with the same
  operation ID fails.

Existing fixtures were updated where they encoded the old opening-clock behaviour. The timeout
fixtures now reach normal play through the opening exchange before they expire a clock, and the
participant-lock race fixture now proves that a command that waits past the opening reply deadline
is adjudicated as the opening abort. A second participant-lock fixture covers the main clock
deadline. The assertions were not weakened.

`backend/online/contracts_test.go` covers the clock state machine at the package boundary. The
opening phase fixture asserts that the first accepted move arms the reply window instead of a main
clock, that the responder's bank is untouched, and that the reply starts the next side's clock.

### Correction fixtures

`backend/integration/online_offer_consent_test.go` covers the corrected offer contract against real
PostgreSQL.

- The consent of a takeback is bound to the exact offered identity. A replaced offer is refused
  instead of accepting the offer that replaced it, the match does not rewind, and the acceptance of
  the live offer restores exactly the position that offer named. The replaced offer keeps the
  resolution `superseded` and the accepted offer the resolution `accepted`.
- A consumed offer, an unknown offer identity and the offering seat's own offer are refused, and a
  refused acceptance changes nothing.
- The consent of a draw offer is bound to the exact offered identity too, and the accepted offer is
  resolved as accepted in the same transaction.
- An offer advances the canonical version, appends an `offer_created` event that carries the offer,
  and leaves the position, the turn, the banks and the running clock untouched. A late rules
  candidate evaluated before the offer changes nothing.
- The increment of every discarded accepted move is removed again. The fixtures assert the literal
  banks: the elapsed time that was already charged stays charged, the replacement move receives
  exactly one increment, and a repeated takeback never leaves a bank above the line without a
  takeback.
- A takeback is refused during the opening exchange. The reply deadline, the match state and the
  clocks are untouched, and the expiry still takes precedence, so an unanswered reply still aborts
  the match. A second fixture repeats the rule for a custom position that starts with Black to
  move.
- A takeback that restores the starting position does not reopen the reply window and does not clear
  the first-move flags, so the later cancellation is still a resignation.
- The offered identity is part of the request fingerprint, so a changed consent cannot reuse an
  accepted operation ID.

`backend/integration/online_takeback_budget_test.go` covers the corrected recovery budget against
real PostgreSQL.

- Three illegal attempts of a turn, an accepted move of that seat, and a takeback that restores the
  turn leave the three spent attempts in place, so the next illegal attempt is the fourth of that
  turn and loses the match for that seat.
- The automatic formatting allowance of a restored turn is restored as well, so the third correction
  of that turn is allowed and the fourth is refused.

`backend/httpapi/online_test.go` asserts that the participant live view exposes the offered
identity without any participant reference or private data, and that an acceptance command without
that identity is rejected before it reaches the writer.

`backend/rulesworker/evaluator_test.go` asserts that a refused proposal keeps its own answer and
that an internal history disagreement is an unavailable service instead of a participant error.

### New automatic deadline fixtures

`backend/integration/online_deadline_test.go` covers the trusted deadline boundary against real
PostgreSQL. Every fixture moves the stored deadline into the past and then invokes the trusted
reconciliation once, so no fixture waits for wall-clock time and no fixture needs a participant
command.

- MAT-04: `TestPostgresOnlineTrustedReconciliationSettlesAnExpiredMainClockWithoutAParticipantCommand`
  expires the main clock of an opened match and reconciles it with the real private rules process.
  The match ends as a timeout, the flagged bank is zero, the version advances exactly once, no
  increment is minted, the public replay carries the accepted line and the timeout, exactly one
  timeout event is written, and no participant receipt is written. A second reconciliation settles
  nothing.
- MAT-01 and MAT-04: `TestPostgresOnlineTrustedReconciliationAbortsAnUnansweredOpeningReplyWithoutAParticipantCommand`
  expires the opening reply window and reconciles it. The match aborts unscored with the reason
  `opening_reply_timeout`, the responder's bank is untouched, and exactly one abort event is
  written.
- MAT-12 and ARC-03: `TestPostgresOnlineTrustedReconciliationIsIdempotentUnderConcurrentSweeps`
  runs four concurrent sweeps over one expired match. Exactly one sweep settles it, the version
  advances exactly once, exactly one timeout event and one public projection exist, and no
  increment is minted.
- MAT-04: `TestPostgresOnlineTrustedReconciliationRacesAParticipantCommand` races the sweep with
  a late participant move. The late intent never becomes a move, the match ends as a timeout and
  exactly one timeout event exists.
- MAT-04 and MAT-08: `TestPostgresOnlineTrustedReconciliationRacesAResignationACancellationAndAControlChange`
  races the sweep with a resignation, a cancellation and a control change. The expired clock still
  wins over every intent, the control epoch does not move, and exactly one terminal event exists.
- MAT-04 and ARC-03: `TestPostgresOnlineTrustedReconciliationEvaluatesTheRulesOutsideTheMatchLock`
  proves that the flag fall is adjudicated outside the match row lock and outside every
  transaction: while the rules process works, a second connection takes the match row lock at
  once and the pool holds no connection of the sweep.
- MAT-04: `TestPostgresOnlineTrustedReconciliationKeepsAnExpiredClockPendingWithoutATimeoutPolicy`
  reconciles without a timeout-capable rules process. The writer fails closed, the expiry stays
  pending, the match stays active, no timeout event is written and the scan still reports the
  match.
- MAT-04: `TestPostgresOnlineTrustedReconciliationKeepsAnExpiredClockPendingWhileTheRulesServiceIsUnavailable`
  reconciles while the rules process fails. The expiry stays pending and no result is invented. The
  policy recovers and the next pass settles the same expiry.
- MAT-04: `TestPostgresOnlineDueDeadlineScanIsBoundedAndReturnsIdentifiers` proves the scan is
  bounded, reports due matches only, and never reports a match without an armed deadline.
- MAT-04: `TestPostgresOnlineDeadlineReconcilerSettlesADueMatchAndStopsOnRelease` runs the server
  loop against real PostgreSQL. The loop settles a due match with no participant command, and the
  released loop settles nothing afterwards.
- Production wiring: `TestPostgresOnlineServerLifecycleSettlesADueMatchAndStopsOnRelease` boots
  the real server composition over an isolated schema with the real rules worker. The booted
  server settles a due match with no participant command, and the released server settles nothing
  afterwards.
- Authorization boundary: `TestPostgresOnlineHTTPCannotInvokeTheTrustedDeadlineReconciliation`
  proves that the participant HTTP surface exposes no route that reaches the trusted mutation and
  that an unauthenticated request never settles an expired match.

`backend/serverapp/server_test.go` covers the loop itself without a database. The release stops the
background work, the server context stops it, the stop function is idempotent, a composition
without a reconciler starts nothing, and the sweep settings are read from the environment with a
fallback to the default.

### Deterministic time and real races

Deadlines are moved into the past with a direct update of the stored clock rows, so the expiry
fixtures do not depend on wall-clock sleeps. The lock-wait fixture keeps a real PostgreSQL race: a
second connection holds the match row, the command waits, and the deadline passes during the wait.
The participant-lock race fixture holds the credential lock across the deadline in the same way.
The deadline fixtures use the same deterministic deadline shift, and the concurrent sweeps and the
sweeps against a participant command are real PostgreSQL races over the same match row.

The local PostgreSQL container used for this verification steps its clock backwards by up to about
0.9 seconds roughly every fifteen seconds, while the host clock stays steady. A probe over 241
seconds recorded sixteen such steps. An absolute deadline with a sub-second window can therefore
be un-passed by the clock itself, so the lock-wait fixture waits for the database clock to reach
past the deadline instead of sleeping for a fixed duration. The deadline fixtures of this
correction move the deadline an hour into the past, so a clock step cannot reach them. The
underlying clock behaviour is an environment property of the local container, not of the writer:
the writer reads one authoritative database clock for every deadline decision, and the participant
path and the trusted path read the same clock.

### Red evidence

The new fixtures were checked against the behaviour they replace. Removing the opening branch of
`ApplyAcceptedMove` fails the opening clock fixtures in both packages and the opening abort fixture.
Removing the ever-moved check of the cancellation fails both cancellation fixtures. Adding an
increment to the takeback acceptance fails the takeback fixture. The removed code was restored
after each check.

The automatic deadline fixtures were checked against the missing behaviour. Making the trusted
reconciliation settle nothing fails the timeout fixture, the opening abort fixture, the concurrent
sweep fixture, the two pending-expiry fixtures, the loop fixture, the server lifecycle fixture and
the HTTP boundary fixture. In that state an expired match stays active with no participant
command, which is the defect this correction removes. The stub was removed after the check.
Opening the transaction before the flag fall is adjudicated fails the outside-lock fixture, which
reports the pooled connection the sweep held during the rules work. The change was reverted after
the check.

## Acceptance boundaries and limitations

- MAT-01, MAT-02, MAT-03, MAT-04, MAT-08, MAT-11 and MAT-12 have local Go and PostgreSQL evidence
  in this slice. The product acceptance matrix is unchanged; the scenarios are not marked as run
  here.
- ARC-03 has local evidence for both lock kinds and both deadlines. The match lock is covered by
  `TestPostgresOnlineLockWaitCrossesClockExpiry` for the main clock and by
  `TestPostgresOnlineUnansweredOpeningReplyAbortsTheMatch` for the opening reply window. The
  participant lock is covered by `TestPostgresOnlineCommandThatWaitsPastTheMainDeadlineTimesOut`
  for the main clock and by
  `TestPostgresOnlineCommandThatWaitsPastTheReplyDeadlineAborts` for the opening reply window.
- ARC-04 has local evidence for the existing actions and for the new offer actions.
- MAT-04 has local evidence for the automatic realisation of both deadlines. The opening reply
  abort and the main clock timeout are settled by the trusted reconciliation with no participant
  command, through the real private rules process and through the booted server composition.
- The trusted reconciliation is a server capability. It has no HTTP route, it fabricates no
  participant identity, and it writes no participant operation receipt. Its interval and batch
  size are server settings.
- The browser agent runner that produces the recovery attempt reports is not implemented. The shared
  writer owns the budget, the reset rule and the illegal move loss; the runner that detects an
  illegal move in a model reply is downstream work.
- The abandonment claim after one continuous minute offline is not part of this slice. The clock
  keeps running through a peer disconnect, which is what this ticket required.
- The rules process refusal now decides the answer instead of the transport: an illegal or
  terminal proposal is refused with `ErrActionNotAllowed` and an invalid position with
  `ErrInvalidContract`. A history that does not match the evaluated position means that the writer
  and the rules process disagree about the position, so it is reported with `ErrUnavailable` and
  reaches the client as a temporary service failure instead of a conflict it cannot fix. The HTTP
  status for an illegal move changes from 503 to 409, and an invalid position changes from 503 to
  400. This is a wire visible change to the KHA-66/67 surface.
- The public replay projection carries the current line only. A takeback removes the discarded moves
  from the replay and keeps them in the shared tables.
- Deployment, provider spending, staging verification and native accessibility were not performed.
- The local PostgreSQL container steps its clock backwards by up to about 0.9 seconds every fifteen
  seconds. The writer reads one authoritative database clock for every deadline decision, so the
  participant path and the trusted path always agree, but an absolute deadline with a sub-second
  window can be un-passed by the clock itself in that environment. Production clock behaviour
  was not measured here. No deadline decision in this slice depends on the host wall clock.

## Review disposition

An independent review of the slice against the ticket contract found two medium and six low
findings. The medium findings are fixed: a move intent now reconciles the expiry before any other
refusal, so a late, stale or wrong-seat intent settles the match the same way as a late legal move,
and an accepted move now withdraws every pending draw offer, so a declined offer cannot end the
match later. The low findings are fixed as well: a finished match exposes no pending offer, the
cancellation is recorded as its own event, the takeback target is documented as the version of an
accepted move, the increment of a discarded move is documented as not given back, the offer shape
no longer advertises fields the server never fills, and the participant lock fixture for the main
clock deadline was restored.

A second independent review of the corrected slice raised one high, six medium and four low
findings. Their dispositions are:

- The consent of an offer is bound to the exact offered identity. Fixed in `6c311b5`.
- An offer is versioned and discoverable. Fixed in `6c311b5`: the offer advances the canonical
  version, appends an `offer_created` event that carries the offer, and the clocks stay continuous.
- An accepted takeback is resolved as accepted, and only actionable offers stay pending. Fixed in
  `6c311b5`.
- A takeback restored a turn whose recovery budget had already been consumed. Fixed in `ebff3f1`
  with the turn journal.
- The increment of a discarded move is removed again, so a replacement move receives exactly one
  increment. The ruling of the parent is applied and documented in `6c311b5`.
- A takeback during the opening reply window cancelled the window. Fixed in `6c311b5`: takebacks
  are unavailable until the opening exchange is complete.
- The read path returns stored state. Automatic deadline settlement is now integrated through
  `b3b805b`, so expiry is realised independently of participant commands and reads.
- The browser agent runner that produces the recovery reports is not implemented. It is the
  downstream runner ticket, and the illegal move loss stays unreachable until it lands.
- An internal history disagreement was reported as a user-fixable conflict. Fixed in `f5bb721`.
- A version 1 receipt cannot be retried with a version 2 command. Recorded honestly as the
  pre-release version boundary in the architecture note. The branch has never been released, no
  stored receipt or fingerprint was rewritten, and the receipt route still returns the stored bytes
  of an old receipt unchanged.

OpenCode `opencode/minimax-m3.1-flash-free` handled the implementation and the verification of this
slice, and of the automatic deadline correction. The parent reviewed the contract change, the
migration and the evidence.
