# Shared online state and command contracts

This note records the boundaries, schema, and transaction rules added by
[KHA-65](https://linear.app/kamkm/issue/KHA-65/add-shared-online-state-transactional-commands-and-operation-receipts).
It describes the local foundation, the participant authorization added by KHA-67 and the authoritative
opening clocks, offers and outcomes added by KHA-68. SSE delivery and queue allocation remain
separate work. Acceptance scenarios `ARC-02`, `ARC-03`, and `ARC-04` remain `not_run` until the
integrated service and staging exercise exist.

## Ownership boundary

Shared online matches are separate from the private single-owner sync archive:

| Concern | Private archive (`0001_storage.sql`) | Shared online state (`0002_online.sql`) |
| --- | --- | --- |
| Owner | One account or guest namespace | Two independent participants |
| Writer | Existing Go storage API | `backend/online` transaction service |
| Visibility | Owner-only | Participant-only live state; allowlisted completed replay |
| Retention | Existing sync/deletion rules | Online removal markers and projections |
| Foreign keys | Existing private relationships | None into private tables |

`backend/online` never reads or writes `games`, `archive_chunks`, `archive_events`, `operations`, or
`deletion_tombstones`. The online tables have no foreign keys into those tables. Provider
credentials, raw provider requests, model conversations, private endpoints, and owner archives are
not part of any shared row or public projection.

## Schema

Migration `backend/migrations/0002_online.sql` is additive and versioned through
`kamkmchess_schema_migrations`. It creates:

- `online_matches`: match identity, schema version, orthodox variant, starting/current FEN, time
  control, monotonic `version`, `control_epoch`, rules-policy version, input hash, status, terminal
  result and `result_version`, completion time, and timestamps.
- `online_seats`: one row per seat with the authenticated participant reference, chosen public
  label, declared control, and the seat's control epoch.
- `online_clocks`: both time banks, the active seat and start time, authoritative deadline, whether
  each side has moved, the turn number, and the opening reply seat and its deadline.
- `online_moves`: append-only accepted moves, keyed by match and match version, with UCI, SAN,
  resulting FEN, and the authoritative decision/accepted time.
- `online_events`: append-only versioned event log for creation, moves, resignation, abort, control
  change, timeout, replay removal, draw agreement, takeback acceptance, created offers, spent
  recovery attempts and the illegal move loss. An `offer_created` event carries the offer it
  created.
- `online_turn_budgets`: the journal of what a seat spent in a turn, keyed by the accepted-move
  prefix the turn starts from.
- `online_operation_receipts`: scoped operation ID, 32-byte request fingerprint, original result
  bytes, resulting version/epoch, and acceptance time.
- `online_queue_entries`: queue-entry schema and read contract only; allocation commands are not
  implemented.
- `online_runner_leases`: per-seat runner lease schema and read contract only; acquisition and
  revocation commands are not implemented. A partial unique index allows one `active` lease per
  match and seat.
- `online_public_projections`: allowlisted completed-replay JSON plus a result hash and one-way
  revocation fields.
- `online_deletion_markers`: append-only removal/anonymization ledger.

Migration `backend/migrations/0004_online_match_outcomes.sql` is additive and adds the opening reply
window columns, the shared recovery budget counters, `online_offers` (pending draw and takeback
offers) and `online_discarded_moves` (accepted moves that a takeback removed from the current line).
It relaxes the match schema version check to accept version `2`. It changes no existing row. Two
partial indexes over the armed deadline columns keep the bounded deadline scan off a sequential
read of every stored clock.

Migration `backend/migrations/0006_online_offer_consent.sql` is additive and adds the offer payload of
an event, the `offer_created` event kind and `online_turn_budgets`, the journal of what a seat spent
in a turn. It changes no existing row.

Database checks constrain IDs, FEN lengths, UCI shape, time-control ranges, control labels, result
consistency, and clock/projection/lease consistency. A match has at most one armed deadline: either
a main clock or the opening reply window. Move, event, receipt, and marker rows are immutable. A
guard trigger rejects changes to match identity, creation time, terminal status, completion time,
and a non-null result; a delete trigger preserves accepted match rows. The latched `result_version`
cannot be changed after the result exists. A later event such as replay removal cannot move it.

## Command contract

`backend/online/contracts.go` and `src/online/contracts.ts` mirror schema version `2`. A command is a
closed union:

| Action | Payload | Authority |
| --- | --- | --- |
| `create_match` | variant, starting FEN, time control, both seats | Creator must own the claimed seat; expected version `0`, control epoch `1` |
| `submit_move` | lower-case UCI | Claimed seat owner; active match; expected version and control epoch |
| `resign` | none | Claimed seat owner; active match |
| `cancel` | none | Claimed seat owner; active match; aborts before that seat's first accepted move, resigns afterwards |
| `set_control` | declared human/agent/engine control | Claimed seat owner; active match; increments control epoch |
| `remove_public_replay` | `owner_request` or `erasure_request` | A participant after a terminal result; clears the public projection |
| `offer_draw` | none | Claimed seat owner; active match; records a pending offer and advances the match version without changing the position, the turn or the clocks |
| `accept_draw` | the offered identity | Claimed seat owner; requires the opponent's pending draw offer with exactly that identity; ends the match as a draw |
| `offer_takeback` | exact target version | Claimed seat owner; the target must be a position in the current line; unavailable until the opening exchange is complete |
| `accept_takeback` | the offered identity | Claimed seat owner; requires the opponent's pending takeback offer with exactly that identity; unavailable until the opening exchange is complete |
| `record_recovery_attempt` | `illegal_move` or `formatting_correction` | The side to move; spends the recovery budget of the current turn |

Unknown fields, unknown action kinds, arbitrary state blobs, SQL, client timestamps, credentials,
and private route data are rejected. The authenticated participant is a server-supplied argument to
`Service.Execute`; it is never read from the command body. Public labels reject control characters,
`@`, and `://` so an accidental Clerk email or endpoint cannot be published.

## Clocks and the opening phase

The match clock has three states, and at most one deadline is armed at a time.

- Unstarted. No accepted move exists. No clock runs and no deadline is armed. The side to move in
  the starting FEN owns the opening move.
- Opening reply. The first accepted move added the increment once and armed a fifteen second reply
  window for the other side. No main bank runs during the window, so neither side's main clock
  spends time before its own first accepted move. The window closes when the responder's first
  accepted reply is accepted, or when the deadline passes, which aborts the match unscored.
- Normal play. The accepted reply starts the main clock of the side to move. The deadline is
  absolute: the elapsed time is charged at the next decision, so generation, provider failure,
  Stop/Retry, control changes, navigation, refresh and peer disconnects never pause or refund the
  clock.

The opening rule follows the side to move, so a custom position that starts with Black to move
makes Black the starting side and White the responder. The opening phase is a historical fact: a
takeback never reopens it.

Whether a seat ever had an accepted move is a historical fact stored beside the clock. A takeback
that removes a move from the current line does not clear it, so a cancellation after such a
takeback resigns instead of aborting.

## Receipts and idempotency

The request fingerprint hashes the contract version, match ID, operation ID, expected version,
seat, control epoch, authenticated actor, and canonical action payload. Acceptance stores the
original receipt bytes under `(scope_kind, scope_id, operation_id)`.

- An identical retry returns the stored bytes unchanged and marks the result as a duplicate; the
  match is not advanced again.
- A changed payload, seat, expected version, control epoch, or actor reusing an accepted operation ID
  fails with `ErrOperationReuse`.
- Receipt rows are immutable. A lost acknowledgement therefore cannot create a second accepted
  transition.
- For an existing match, duplicate lookup happens again under the match lock, so a retry racing the
  original writer still converges on the stored receipt.
- Move preflight reads the consistent snapshot before checking receipts. An original operation
  visible in that snapshot therefore has a visible receipt before stale-version or terminal-state
  rejection can run.

## Acceptance transaction

For an existing match the writer:

1. Begins a transaction and selects the match row `FOR UPDATE`.
2. Samples `clock_timestamp()` in a separate statement **after** the lock is held, floored at the
   last accepted timestamp so a backward host-clock adjustment cannot reverse event time. A single
   `FOR UPDATE` query that also evaluates `clock_timestamp()` is deliberately avoided because the
   expression may run before a lock wait.
3. Loads the clock, seats, and moves; checks for an existing receipt under the lock.
4. Verifies seat ownership before expiry can mutate the match. If the opening reply window has
   passed, the match aborts unscored. If the main clock deadline has passed, the transaction is
   released and the bounded timeout policy is evaluated through the private rules process. A second
   lock verifies the same position/version/epoch and expired seat before committing the
   material-dependent win or draw and receipt. Missing timeout policy fails closed.
5. Otherwise verifies the expected match version, control epoch and side to move.
6. Applies the typed transition, writes the append-only move/event rows, updates the match and clock,
   publishes an allowlisted projection on a terminal result, writes the receipt, and commits.

A move intent reconciles the expiry before any other refusal, so a late, stale or wrong-seat intent
settles the match the same way as a late legal move. The reconciliation re-checks the deadline under
the match lock with a decision time sampled after the locks are held, so the reading of the
preflight snapshot is only a hint.

For a new match, the pinned rules worker first validates the starting FEN and exact counters with
no database transaction held. Invalid positions return `ErrInvalidContract`; already-terminal
positions return `ErrActionNotAllowed`. Missing or failed setup evaluation returns `ErrUnavailable`
without saving any match state. An accepted creation retry returns its stored receipt without
requiring the worker again.

After validation, the writer samples the decision time and inserts the match, seats, initial clock,
creation event, and receipt in one transaction. A unique conflict from a concurrent create resolves
to the stored receipt when the operation is identical, otherwise `ErrAlreadyExists`.

No client timestamp is trusted. Elapsed time is computed from the stored active start to the
authoritative decision time. Resignation, cancellation, abort and timeout settle the active bank
before clearing the active deadline; an expired bank is zero. These events add no increment.
Increment is applied once per accepted move.

## Offers, takebacks and recovery budgets

An offer is part of the shared match state. It advances the canonical match version and appends its
own `offer_created` event, which carries the exact offer it created, so a durable event stream can
rebuild which offer is pending. It never changes the position, the turn or the clocks, so it does
not interrupt a move the other participant is preparing, and the absolute clock deadlines stay
continuous. The offer is still ordered against the match: it is written under the match lock, after
the same authorization and expiry checks every other intent passes.

The offer is bound to the version it produced. It is actionable only while the match version still
equals it, so any later transition makes it inapplicable and withdraws it. A seat has one
outstanding offer per kind; a newer offer replaces the older one, which stays in the table with the
resolution `superseded`. The pending offers of a match are therefore exactly the offers that can
still be accepted, and a terminal match has no pending offer.

The consent of an offer names the exact offer it accepts. The writer reads that offer under the
match lock and checks its identity, its kind, the offering seat, its resolution and the version it
is bound to. A replaced, consumed or stale offer is refused instead of applying a different offer,
and the named identity is part of the operation fingerprint, so a changed consent cannot reuse an
accepted operation ID.

- A draw offer needs the other participant's acceptance. The acceptance ends the match as a draw by
  agreement. Play that continues after an offer declines it, so an accepted move withdraws every
  pending draw offer.
- A takeback offer names the exact version of an accepted move whose position it would restore, or
  version `1` for the starting position. The target must be a position in the current line and it
  must leave at least one accepted move to discard. A takeback is unavailable until the opening
  exchange is complete: the offer and the acceptance are refused while the reply window is open,
  and the reply deadline, the state and the clocks are never touched by the request. The expiry
  still takes precedence, so an unanswered reply still aborts the match.
- Accepting a takeback restores the position and the current line, charges the side that was
  thinking, and arms the restored side to move with its normal main clock. It refunds no time. The
  increment that was credited to every discarded accepted move is removed again, so a replacement
  move is a new accepted move that receives exactly one increment and a repeated takeback cannot
  inflate a bank. The discarded accepted moves stay in `online_moves` and are marked in
  `online_discarded_moves`, so the discarded private archives survive.
- The opening phase is a historical fact. A takeback that restores the starting position does not
  reopen the reply window and does not clear the first-move flags, so a later cancellation is still
  a resignation.

The recovery budget of a turn lives in the seat row and in the turn journal. The seat counters hold
what the current turn has already spent and are reset when that seat's own move is accepted. The
journal in `online_turn_budgets` records what a seat spent in a turn, keyed by the accepted-move
prefix the turn starts from, so the allowance survives the move that ended the turn. A takeback
restores the turn it restores, and with it the allowance that turn had already spent, so neither a
takeback nor a control change can hand a seat a fresh attempt allowance. The fourth illegal attempt
of a turn loses the match for that seat. The automatic formatting correction budget is independent
and stops at three corrections, after which only owner recovery remains.

## Rules candidate fencing

`RulesInput` is a versioned, private view of the rules-relevant state: policy version, match ID,
version, control epoch, starting/current FEN, optional proposed move, time control, accepted moves,
and active seat. Its SHA-256 hash covers all of those fields plus the match version and control
epoch.

A move command may call an external evaluator with no transaction or row lock held. The returned
candidate is accepted only when all of the following still match under the fresh lock:

- evaluated match version equals the locked version and the command's expected version;
- evaluated input hash equals the locked rules-input hash;
- control epoch equals the locked epoch;
- candidate seat and UCI equal the command;
- candidate move shape and any terminal result pass contract validation.

A stale candidate fails with `ErrStaleCandidate` and writes nothing. The evaluator has no database
handle in this package; the Go writer remains the only committer.

`rulesworker.NewOnlineEvaluator` implements the setup, move and timeout evaluator contracts using the
private pinned Node process. Real-process/PostgreSQL fixtures exercise this composition. The server
bootstrap composes participant credential verification and the writer. Internal match/receipt
read helpers require authorization by their server callers; they are not public routes.

A refused proposal keeps its own answer: an illegal or terminal proposal is refused with
`ErrActionNotAllowed` and an invalid position with `ErrInvalidContract`. A history that does not
match the evaluated position means that the writer and the rules process disagree about the position
itself. That is an internal consistency failure and not a conflict a participant can fix, so it is
reported as `ErrUnavailable` and reaches the client as a temporary service failure.

`GetMatchForParticipant` and `GetReceiptForParticipant` provide membership-scoped reads. They return
`ErrNotFound` for non-members as well as missing matches, while unrestricted helpers remain trusted
internal interfaces. Command decoding requires EOF after the JSON value. Accepted move and public
replay SAN use a bounded notation check rather than the broader public-label validator.

Trusted internal match snapshots use one repeatable-read transaction. Participant snapshots use
READ COMMITTED while holding the match row FOR SHARE across match, seat, clock, move and receipt
reads. This blocks the writer while allowing a revocation committed during an authorization-lock
wait to become visible to the subsequent credential check.

## Automatic deadline reconciliation

Bounded passes rotate by match identifier and wrap to retry pending expiries.
An unavailable timeout policy therefore cannot keep a later opening abort
outside every batch. The cursor belongs to one service process and resets
on restart; terminal decisions remain database-locked and idempotent across
processes. Scan selection releases its lock and database connection before
external rules work begins.

A match arms at most one deadline, so a match that nobody touches still has to end. The writer owns
a trusted deadline boundary that realises the deadline without a participant command.

- `backend/online/deadline.go` is the boundary. `DueDeadlineMatchIDs` is a bounded scan that
  returns identifiers only, so no connection waits idle between two passes and none is held while
  the rules process works. `ReconcileDeadline` settles one match. `ReconcileDeadlines` is one
  bounded pass and reports how many matches were due, settled, skipped and left pending.
- The boundary is trusted, not public. It never fabricates an account or guest identity and it
  never spends a participant-chosen operation ID, so the trusted transition writes no operation
  receipt. The participant API keeps its narrow reader and writer interface, so no HTTP route and
  no unauthenticated caller reaches it. There is no public cron endpoint.
- Each reconciliation re-locks the match row, re-samples the authoritative database clock after
  the lock, and re-checks the version, the control epoch, the rules input hash and the expired
  seat. The terminal state, the append-only event and the public projection are written in one
  transaction, so the transition is atomic, and the row lock makes it idempotent: a second sweep
  of the same match finds the terminal result and writes nothing.
- A main clock expiry needs the bounded timeout policy, so it is evaluated outside every
  transaction and every lock and is then fenced by the re-lock. Without a timeout-capable rules
  process, or while the rules service is unavailable, the expiry stays pending for a later pass
  and no result is invented. The opening reply abort needs no chess rules and is committed under
  one lock.
- The participant path and the trusted path share one transition, so they produce the same event,
  the same result and the same projection. A participant intent still reconciles the expiry
  before any other refusal, so a late intent and a sweep agree on the terminal state.
- `backend/serverapp/deadlines.go` owns the cadence. `StartDeadlineReconciler` binds the loop to
  the server context and to its stop function, and the stop function waits for the loop to finish
  before the database pool closes. The interval and the batch size come from
  `ONLINE_DEADLINE_SWEEP_INTERVAL` and `ONLINE_DEADLINE_SWEEP_BATCH`.

## Public projection and removal

`BuildPublicProjection` emits only the allowlisted replay fields: starting position, time control,
public participants and declared controls, accepted moves, final result, rules-policy version, and
completion time. It excludes owner IDs, participant references, operation IDs, private routes,
credentials, conversation, and archive references.

`remove_public_replay` is available only after a terminal result. It clears the projection JSON to `{}`,
records a revocation time and marker ID, and appends a `replay_removal` deletion marker. Projection
lookup then returns `ErrNotFound`. The projection guard allows this one-way transition only; the
projection identity and payload are otherwise immutable, and revoked rows cannot be deleted or
un-revoked. The match result remains immutable for anonymous aggregate history.

The marker ID is the accepted command fingerprint, which includes the match scope. Separate
matches can therefore reuse an operation ID without colliding in the global deletion ledger.

Public projection reads also validate the requested match identity and the stored result hash.

## Runtime roles and isolation

The migration creates, when the migration role has `CREATEROLE`:

- `kamkm_online_api`: schema `USAGE` plus `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on the online
  tables only.
- `kamkm_online_rules`: schema `USAGE` with all table and sequence privileges revoked. It cannot
  read or write online state or the private archive, and has no public command surface.

`PUBLIC` privileges are revoked on every online table. Role creation and grants are best effort so a
restricted migration role can still apply the additive schema. Integration tests skip the grant
assertions explicitly when the roles are unavailable; a skipped assertion is never reported as a
pass.

## Participant authorization

KHA-67 adds the participant HTTP API under `/v1/online`, independently of private archive sync.
See [the authorization contract](online-authorization.md) for routes, credential scope, revocation,
browser identity fencing and the trusted invitation/linking interfaces.

Migration `0003_online_auth.sql` adds session revocations, guest seat credentials and guest ownership
proofs. Only hashes of the random guest secrets are stored. Match seats retain their original
participant references, preserving receipt fingerprints and the existing seat immutability guard.

## Public profiles

KHA-72 adds the stable public identity of a signed-in account: an opaque public profile identifier,
a deliberately chosen and case-insensitively unique username, and a chosen avatar from a bounded
catalog. The public payload is an allowlist, so it never carries the account identifier, the
sign-in email, the legal name, or a session or credential. A guest has no profile.

Linking a guest seat to an account is an explicit action that consumes a guest ownership proof
inside the link transaction, under the account lock and the guest seat lock. The seat owner, the
guest actor, the accepted receipts and the accepted fingerprints are left untouched. See
[the public profile contract](public-profiles.md) for the routes, the storage, and the boundaries.

The [online update transport](online-updates.md) delivers participant snapshots over finite
fetch-SSE or authenticated polling. Its cursor is the durable match version. Shared notifications
do not change command authority or the stored operation-receipt contract.

## Deferred work

- Queue allocation, lease acquisition/revocation commands, matchmaking, cutoffs, and fallback.
- The abandonment claim after one continuous minute offline, and the reconnection window.
- The browser agent runner that produces the recovery attempt reports and the per-move declared
  control timeline.
- Per-move declared-control timeline in replays and public attribution presentation.
- Retention automation, backup replay of the removal ledger, staging verification, and deployment.

## Version boundary of the unreleased branch

The online branch has never been released, so there is no deployed schema version 1 receipt. The
contract is at schema version 2 and the request fingerprint hashes the schema version, so a version 2
command can never reuse a version 1 operation ID: the stored fingerprint of a version 1 operation
does not match and the retry is refused with `ErrOperationReuse`. The receipt route returns the
stored bytes of a version 1 receipt unchanged, and the TypeScript receipt parser requires schema
version 2, so such a body is not accepted by a version 2 client. A match row created with schema
version 1 still accepts version 2 commands. This boundary is recorded here so the next reader does
not mistake it for a compatibility layer: there is none, and none is needed before the first
release.
