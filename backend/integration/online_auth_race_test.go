package integration

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The tests in this file are timing regressions. Every one of them holds a
// real database lock, a real pending transaction, or a real credential
// deadline, and every one of them proves an ordering property that the
// production code must keep:
//
//   - a credential that was revoked while a participant waited for the
//     participant lock is rejected, and it receives neither live state nor a
//     stored receipt;
//   - a command that waited for the participant lock past the active deadline
//     is adjudicated as a timeout instead of being accepted;
//   - a credential that expires while a participant waits for the participant
//     lock is rejected;
//   - an empty revocation reason is stored as a reason the database accepts.

// lockProbe traces the participant advisory lock statements.
//
// It records the lock key the production code uses, so a test can hold the
// same lock from another connection, and it can pause a chosen lock statement
// so a test controls exactly when a command acquires the participant lock.
type lockProbe struct {
	mu          sync.Mutex
	key         int64
	haveKey     bool
	seen        int
	pauseAt     int
	paused      bool
	reached     chan struct{}
	entered     chan struct{}
	release     chan struct{}
	reachedOnce sync.Once
	enterOnce   sync.Once
	releaseOnce sync.Once
}

func newLockProbe(pauseAt int) *lockProbe {
	return &lockProbe{
		pauseAt: pauseAt,
		reached: make(chan struct{}),
		entered: make(chan struct{}),
		release: make(chan struct{}),
	}
}

func (p *lockProbe) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if !strings.Contains(data.SQL, "pg_advisory_xact_lock") {
		return ctx
	}
	p.mu.Lock()
	p.seen++
	if !p.haveKey && len(data.Args) > 0 {
		if key, ok := data.Args[0].(int64); ok {
			p.key = key
			p.haveKey = true
		}
	}
	occurrence := p.seen
	pause := p.pauseAt > 0 && occurrence == p.pauseAt && !p.paused
	if pause {
		p.paused = true
	}
	p.mu.Unlock()
	p.reachedOnce.Do(func() { close(p.reached) })
	if pause {
		p.enterOnce.Do(func() { close(p.entered) })
		<-p.release
	}
	return ctx
}

func (p *lockProbe) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// Release lets a paused statement continue. It is safe to call more than
// once, so a failing test never leaves a command blocked in the tracer.
func (p *lockProbe) Release() {
	p.releaseOnce.Do(func() { close(p.release) })
}

// LockKey returns the participant advisory lock key the production code used.
func (p *lockProbe) LockKey(t *testing.T) int64 {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		p.mu.Lock()
		key, ok := p.key, p.haveKey
		p.mu.Unlock()
		if ok {
			return key
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("the participant lock key was never observed")
	return 0
}

// revocationPause pauses a revocation after its revocation statement and
// before its commit.
//
// The revocation transaction therefore holds the participant lock while the
// revocation is still pending, which is exactly the state a reader must not
// treat as "still authorized".
type revocationPause struct {
	once        sync.Once
	releaseOnce sync.Once
	entered     chan struct{}
	release     chan struct{}
	statement   string
}

func newRevocationPause(statement string) *revocationPause {
	return &revocationPause{entered: make(chan struct{}), release: make(chan struct{}), statement: statement}
}

// Release lets the paused revocation finish. It is safe to call more than
// once, so a failing test never leaves a revocation holding the participant
// lock.
func (p *revocationPause) Release() {
	p.releaseOnce.Do(func() { close(p.release) })
}

type revocationUpdateKey struct{}

func (p *revocationPause) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	update := strings.Contains(data.SQL, p.statement)
	return context.WithValue(ctx, revocationUpdateKey{}, update)
}

func (p *revocationPause) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	if update, _ := ctx.Value(revocationUpdateKey{}).(bool); !update {
		return
	}
	p.once.Do(func() { close(p.entered) })
	<-p.release
}

// probedPool opens a second pool on the same schema with a query tracer.
func probedPool(t *testing.T, fixture *onlineAuthFixture, tracer pgx.QueryTracer) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	cfg := fixture.pool.Config()
	cfg.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// holdParticipantLock takes the participant advisory lock on its own
// connection. A command that needs the same lock waits until the returned
// release function is called. The release function is safe to call more than
// once, so a failing test never leaves the lock held.
func holdParticipantLock(t *testing.T, pool *pgxpool.Pool, key int64) func() {
	t.Helper()
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		conn.Release()
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, key); err != nil {
		_ = tx.Rollback(ctx)
		conn.Release()
		t.Fatal(err)
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			_ = tx.Rollback(ctx)
			conn.Release()
		})
	}
}

// waitForLockWait blocks until the database reports a lock that is not
// granted. It is how a test proves that a command really waits instead of
// racing.
func waitForLockWait(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		var waiting int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_locks WHERE NOT granted`).Scan(&waiting); err == nil && waiting > 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("no lock wait was observed")
}

// waitForDatabaseTime blocks until the database clock reaches the given
// instant.
//
// A match deadline is judged against the database clock, so a test must not
// mix that deadline with the host wall clock.
func waitForDatabaseTime(t *testing.T, pool *pgxpool.Pool, at time.Time) {
	t.Helper()
	ctx := context.Background()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var reached bool
		if err := pool.QueryRow(ctx, `SELECT clock_timestamp() >= $1::timestamptz`, at).Scan(&reached); err == nil && reached {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the database clock did not reach the deadline")
}

func waitSignal(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(20 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

// guestMoveCommand is the guest's first move in a shared match.
func guestMoveCommand(matchID, operationID string) online.Command {
	return online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     operationID,
		ExpectedVersion: 1,
		Seat:            online.SeatWhite,
		ControlEpoch:    1,
		Action:          online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}},
	}
}

// TestPostgresOnlinePendingRevocationRejectsTheWaitingParticipantRead proves
// that a participant which waits for the participant lock behind a pending
// revocation is rejected instead of reading live state.
//
// The revocation holds the participant lock and its credential update is
// still pending when the reader starts. The reader takes its snapshot first
// and then waits for the participant lock. Once the revocation commits, the
// reader must see the revocation: a snapshot that was fixed before the wait
// would still see a live credential.
func TestPostgresOnlinePendingRevocationRejectsTheWaitingParticipantRead(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	issued := createGuestMatch(t, fixture, "match-pending-read")
	ctx := context.Background()
	principal := guestParticipant(t, fixture, issued)
	guestCtx := onlineauth.WithPrincipal(ctx, principal)

	pause := newRevocationPause("UPDATE online_guest_seat_credentials SET revoked_at")
	revokerPool := probedPool(t, fixture, pause)
	revoker, err := onlineauth.Open(ctx, revokerPool, fixture.verifier, onlineauth.Options{GuestCredentialTTL: time.Hour, OwnershipProofTTL: 10 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	revoked := make(chan error, 1)
	go func() {
		revoked <- revoker.RevokeSeatCredential(ctx, issued.Credential.CredentialID, "owner_request")
	}()
	// The credential update has executed. The revocation transaction still
	// holds the participant lock and has not committed.
	waitSignal(t, pause.entered, "the pending credential revocation")
	// A failing test must not leave the revocation holding the lock.
	defer pause.Release()

	probe := newLockProbe(0)
	readerPool := probedPool(t, fixture, probe)
	reader, err := online.Open(ctx, readerPool, moveEvaluator{}, online.WithSeatAuthorizer(fixture.authorizer))
	if err != nil {
		t.Fatal(err)
	}
	read := make(chan error, 1)
	go func() {
		_, readErr := reader.GetMatchForParticipant(guestCtx, "match-pending-read", principal.Participant)
		read <- readErr
	}()
	// The reader has read the match and now waits for the participant lock.
	waitSignal(t, probe.reached, "the participant lock request")
	waitForLockWait(t, fixture.pool)

	pause.Release()
	if err = <-revoked; err != nil {
		t.Fatalf("revoke: %v", err)
	}
	select {
	case err = <-read:
		if !errors.Is(err, onlineauth.ErrUnauthenticated) {
			t.Fatalf("participant read behind a pending revocation = %v, want ErrUnauthenticated", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the participant read never completed")
	}
}

// TestPostgresOnlinePendingRevocationRejectsTheWaitingDuplicatePreflight
// proves the same ordering for the duplicate path. A participant that replays
// an accepted operation while a revocation is pending must not receive the
// stored receipt.
func TestPostgresOnlinePendingRevocationRejectsTheWaitingDuplicatePreflight(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	issued := createGuestMatch(t, fixture, "match-pending-duplicate")
	ctx := context.Background()
	principal := guestParticipant(t, fixture, issued)
	guestCtx := onlineauth.WithPrincipal(ctx, principal)
	move := guestMoveCommand("match-pending-duplicate", "op-pending-duplicate")
	if _, err := fixture.service.Execute(guestCtx, principal.Participant, move); err != nil {
		t.Fatalf("guest move: %v", err)
	}

	pause := newRevocationPause("UPDATE online_guest_seat_credentials SET revoked_at")
	revokerPool := probedPool(t, fixture, pause)
	revoker, err := onlineauth.Open(ctx, revokerPool, fixture.verifier, onlineauth.Options{GuestCredentialTTL: time.Hour, OwnershipProofTTL: 10 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	revoked := make(chan error, 1)
	go func() {
		revoked <- revoker.RevokeSeatCredential(ctx, issued.Credential.CredentialID, "owner_request")
	}()
	waitSignal(t, pause.entered, "the pending credential revocation")
	// A failing test must not leave the revocation holding the lock.
	defer pause.Release()

	probe := newLockProbe(0)
	replayerPool := probedPool(t, fixture, probe)
	replayer, err := online.Open(ctx, replayerPool, moveEvaluator{}, online.WithSeatAuthorizer(fixture.authorizer))
	if err != nil {
		t.Fatal(err)
	}
	replay := make(chan error, 1)
	go func() {
		result, replayErr := replayer.Execute(guestCtx, principal.Participant, move)
		if replayErr == nil && !result.Duplicate {
			replayErr = errors.New("the replay was not resolved as a duplicate")
		}
		replay <- replayErr
	}()
	waitSignal(t, probe.reached, "the participant lock request")
	waitForLockWait(t, fixture.pool)

	pause.Release()
	if err = <-revoked; err != nil {
		t.Fatalf("revoke: %v", err)
	}
	select {
	case err = <-replay:
		if !errors.Is(err, onlineauth.ErrUnauthenticated) {
			t.Fatalf("duplicate replay behind a pending revocation = %v, want ErrUnauthenticated", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the duplicate replay never completed")
	}
}

// TestPostgresOnlinePendingSessionRevocationRejectsTheWaitingCreateReplay
// proves that the create path resolves an already accepted operation inside a
// transaction that holds the participant lock.
//
// A create replay that waits behind a pending session revocation must be
// rejected instead of returning the stored receipt. A duplicate lookup that
// does not take the participant lock cannot see a revocation that is still
// pending.
func TestPostgresOnlinePendingSessionRevocationRejectsTheWaitingCreateReplay(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	ctx := context.Background()
	actor := online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_a"}
	create := createOnlineCommand("match-pending-create", "op-pending-create")
	if _, err := fixture.service.Execute(accountContext("user_a", "session-alice"), actor, create); err != nil {
		t.Fatalf("create match: %v", err)
	}

	pause := newRevocationPause("INSERT INTO online_session_revocations")
	revokerPool := probedPool(t, fixture, pause)
	revoker, err := onlineauth.Open(ctx, revokerPool, fixture.verifier, onlineauth.Options{GuestCredentialTTL: time.Hour, OwnershipProofTTL: 10 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	revoked := make(chan error, 1)
	go func() {
		revoked <- revoker.RevokeAccountSession(ctx, "user_a", "session-alice", "owner_request")
	}()
	// The session revocation is pending. Its transaction holds the
	// participant lock and has not committed.
	waitSignal(t, pause.entered, "the pending session revocation")
	// A failing test must not leave the revocation holding the lock.
	defer pause.Release()

	probe := newLockProbe(0)
	replayerPool := probedPool(t, fixture, probe)
	replayer, err := online.Open(ctx, replayerPool, moveEvaluator{}, online.WithSeatAuthorizer(fixture.authorizer))
	if err != nil {
		t.Fatal(err)
	}
	replay := make(chan error, 1)
	go func() {
		result, replayErr := replayer.Execute(accountContext("user_a", "session-alice"), actor, create)
		if replayErr == nil && !result.Duplicate {
			replayErr = errors.New("the replay was not resolved as a duplicate")
		}
		replay <- replayErr
	}()
	// The replay must take the participant lock. A duplicate lookup that
	// resolves the receipt without that lock cannot see a revocation that
	// is still pending.
	select {
	case <-probe.reached:
	case replayErr := <-replay:
		t.Fatalf("the create replay resolved before it took the participant lock: %v", replayErr)
	case <-time.After(20 * time.Second):
		t.Fatal("the create replay never reached the participant lock")
	}
	waitForLockWait(t, fixture.pool)

	pause.Release()
	if err = <-revoked; err != nil {
		t.Fatalf("revoke: %v", err)
	}
	select {
	case err = <-replay:
		if !errors.Is(err, onlineauth.ErrUnauthenticated) {
			t.Fatalf("create replay behind a pending revocation = %v, want ErrUnauthenticated", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the create replay never completed")
	}
}

// TestPostgresOnlineCommandThatWaitsPastTheReplyDeadlineAborts proves that a
// command which waits for the participant lock past the opening reply
// deadline is adjudicated as the opening abort instead of being accepted.
//
// The participant lock is held by another connection without revoking
// anything. The command samples its decision time before it waits, so the
// decision time must be re-sampled after the lock is acquired.
func TestPostgresOnlineCommandThatWaitsPastTheReplyDeadlineAborts(t *testing.T) {
	fixture := newOnlineAuthFixture(t, timeoutEvaluator{winnerFor: timeoutWinForOpponent})
	issued := createGuestMatch(t, fixture, "match-deadline-wait")
	ctx := context.Background()
	principal := guestParticipant(t, fixture, issued)
	guestCtx := onlineauth.WithPrincipal(ctx, principal)
	if _, err := fixture.service.Execute(guestCtx, principal.Participant, guestMoveCommand("match-deadline-wait", "op-deadline-guest")); err != nil {
		t.Fatalf("guest move: %v", err)
	}
	// The guest's move armed the account's opening reply window. Shorten it so
	// the deadline is reached while the command waits for the participant
	// lock.
	if _, err := fixture.pool.Exec(ctx, `UPDATE online_clocks SET reply_deadline_at=clock_timestamp()+$1::interval WHERE match_id=$2`, "2500 milliseconds", "match-deadline-wait"); err != nil {
		t.Fatal(err)
	}
	state, err := fixture.service.GetMatch(ctx, "match-deadline-wait")
	if err != nil {
		t.Fatal(err)
	}
	if state.Clock.ReplyDeadlineAt == nil || state.Clock.ReplySeat == nil {
		t.Fatal("the account reply window was not armed")
	}
	deadline := *state.Clock.ReplyDeadlineAt

	probe := newLockProbe(2)
	commandPool := probedPool(t, fixture, probe)
	commander, err := online.Open(ctx, commandPool, timeoutEvaluator{winnerFor: timeoutWinForOpponent}, online.WithSeatAuthorizer(fixture.authorizer))
	if err != nil {
		t.Fatal(err)
	}
	accountCtx := accountContext("user_a", "session-alice")
	move := online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         "match-deadline-wait",
		OperationID:     "op-deadline-account",
		ExpectedVersion: 2,
		Seat:            online.SeatBlack,
		ControlEpoch:    1,
		Action:          online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e7e5"}},
	}
	type outcome struct {
		result online.CommandResult
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		result, executeErr := commander.Execute(accountCtx, online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_a"}, move)
		done <- outcome{result: result, err: executeErr}
	}()
	// The command has sampled its decision time and now waits for the
	// participant lock.
	waitSignal(t, probe.entered, "the participant lock request")
	// A failing test must not leave the command blocked in the tracer.
	defer probe.Release()
	// The command sampled its decision time before the deadline, so only a
	// decision time that is re-sampled after the lock can catch the expiry.
	var beforeDeadline bool
	if err = fixture.pool.QueryRow(ctx, `SELECT clock_timestamp() < $1::timestamptz`, deadline).Scan(&beforeDeadline); err != nil {
		t.Fatal(err)
	}
	if !beforeDeadline {
		t.Fatal("the command did not reach the participant lock before the deadline")
	}
	release := holdParticipantLock(t, fixture.pool, probe.LockKey(t))
	// A failing test must not leave the participant lock held.
	defer release()
	// The deadline passes while the command waits.
	waitForDatabaseTime(t, fixture.pool, deadline)
	probe.Release()
	waitForLockWait(t, fixture.pool)
	release()

	var got outcome
	select {
	case got = <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("the blocked command never completed")
	}
	if got.err != nil {
		t.Fatalf("blocked command: %v", got.err)
	}
	if got.result.Receipt.Outcome != online.OutcomeOpeningExpired {
		t.Fatalf("outcome = %q, want %q", got.result.Receipt.Outcome, online.OutcomeOpeningExpired)
	}
	if got.result.Receipt.Result == nil || got.result.Receipt.Result.Reason != online.ReasonOpeningReplyTimeout {
		t.Fatalf("opening abort result = %+v", got.result.Receipt.Result)
	}
	if got.result.Receipt.DecidedAt.Before(deadline) {
		t.Fatalf("decision time %s predates the deadline %s", got.result.Receipt.DecidedAt, deadline)
	}
	after, err := fixture.service.GetMatch(ctx, "match-deadline-wait")
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Moves) != 1 {
		t.Fatalf("the late move was accepted after the deadline: moves=%d", len(after.Moves))
	}
	if after.Status != online.MatchAborted || after.Result == nil || after.Result.Reason != online.ReasonOpeningReplyTimeout {
		t.Fatalf("match after the blocked command = %+v", after)
	}
}

// TestPostgresOnlineCommandThatWaitsPastTheMainDeadlineTimesOut proves that a
// command which waits for the participant lock past the main clock deadline is
// adjudicated as a timeout instead of being accepted.
//
// The match first reaches normal play, so the account owes a main clock rather
// than the opening reply window.
func TestPostgresOnlineCommandThatWaitsPastTheMainDeadlineTimesOut(t *testing.T) {
	fixture := newOnlineAuthFixture(t, timeoutEvaluator{winnerFor: timeoutWinForOpponent})
	issued := createGuestMatch(t, fixture, "match-main-deadline-wait")
	ctx := context.Background()
	principal := guestParticipant(t, fixture, issued)
	guestCtx := onlineauth.WithPrincipal(ctx, principal)
	accountCtx := accountContext("user_a", "session-alice")
	account := online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_a"}
	// The guest opens, the account replies, and the guest moves again, so the
	// account's main clock is the armed deadline.
	if _, err := fixture.service.Execute(guestCtx, principal.Participant, guestMoveCommand("match-main-deadline-wait", "op-main-guest-open")); err != nil {
		t.Fatalf("guest opening move: %v", err)
	}
	if _, err := fixture.service.Execute(accountCtx, account, online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         "match-main-deadline-wait",
		OperationID:     "op-main-account-reply",
		ExpectedVersion: 2,
		Seat:            online.SeatBlack,
		ControlEpoch:    1,
		Action:          online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e7e5"}},
	}); err != nil {
		t.Fatalf("account reply: %v", err)
	}
	if _, err := fixture.service.Execute(guestCtx, principal.Participant, online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         "match-main-deadline-wait",
		OperationID:     "op-main-guest-second",
		ExpectedVersion: 3,
		Seat:            online.SeatWhite,
		ControlEpoch:    1,
		Action:          online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "g1f3"}},
	}); err != nil {
		t.Fatalf("guest second move: %v", err)
	}
	// The account's main clock expires while its command waits for the
	// participant lock.
	if _, err := fixture.pool.Exec(ctx, `UPDATE online_clocks SET active_since=clock_timestamp(),deadline_at=clock_timestamp()+$1::interval WHERE match_id=$2`, "2500 milliseconds", "match-main-deadline-wait"); err != nil {
		t.Fatal(err)
	}
	state, err := fixture.service.GetMatch(ctx, "match-main-deadline-wait")
	if err != nil {
		t.Fatal(err)
	}
	if state.Clock.DeadlineAt == nil || state.Clock.ActiveSeat == nil || *state.Clock.ActiveSeat != online.SeatBlack {
		t.Fatalf("the account main clock is not armed: %+v", state.Clock)
	}
	deadline := *state.Clock.DeadlineAt

	probe := newLockProbe(2)
	commandPool := probedPool(t, fixture, probe)
	commander, err := online.Open(ctx, commandPool, timeoutEvaluator{winnerFor: timeoutWinForOpponent}, online.WithSeatAuthorizer(fixture.authorizer))
	if err != nil {
		t.Fatal(err)
	}
	move := online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         "match-main-deadline-wait",
		OperationID:     "op-main-account-late",
		ExpectedVersion: 4,
		Seat:            online.SeatBlack,
		ControlEpoch:    1,
		Action:          online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "b8c6"}},
	}
	type outcome struct {
		result online.CommandResult
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		result, executeErr := commander.Execute(accountCtx, account, move)
		done <- outcome{result: result, err: executeErr}
	}()
	waitSignal(t, probe.entered, "the participant lock request")
	defer probe.Release()
	var beforeDeadline bool
	if err = fixture.pool.QueryRow(ctx, `SELECT clock_timestamp() < $1::timestamptz`, deadline).Scan(&beforeDeadline); err != nil {
		t.Fatal(err)
	}
	if !beforeDeadline {
		t.Fatal("the command did not reach the participant lock before the deadline")
	}
	release := holdParticipantLock(t, fixture.pool, probe.LockKey(t))
	defer release()
	waitForDatabaseTime(t, fixture.pool, deadline)
	probe.Release()
	waitForLockWait(t, fixture.pool)
	release()

	var got outcome
	select {
	case got = <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("the blocked command never completed")
	}
	if got.err != nil {
		t.Fatalf("blocked command: %v", got.err)
	}
	if got.result.Receipt.Outcome != online.OutcomeDeadlineExpired {
		t.Fatalf("outcome = %q, want %q", got.result.Receipt.Outcome, online.OutcomeDeadlineExpired)
	}
	if got.result.Receipt.Result == nil || got.result.Receipt.Result.Reason != online.ReasonTimeout {
		t.Fatalf("timeout result = %+v", got.result.Receipt.Result)
	}
	if got.result.Receipt.DecidedAt.Before(deadline) {
		t.Fatalf("decision time %s predates the deadline %s", got.result.Receipt.DecidedAt, deadline)
	}
	after, err := fixture.service.GetMatch(ctx, "match-main-deadline-wait")
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Moves) != 3 {
		t.Fatalf("the late move was accepted after the deadline: moves=%d", len(after.Moves))
	}
	if after.Status != online.MatchCompleted || after.Result == nil || after.Result.Reason != online.ReasonTimeout {
		t.Fatalf("match after the blocked command = %+v", after)
	}
}

// TestPostgresOnlineExpiredCredentialIsRejectedAfterTheLockWait proves that
// a credential which expires while a participant waits for the participant
// lock is rejected.
//
// The participant lock is held by another connection. The credential is
// still valid when the check starts, so only a re-check after the lock can
// reject it.
func TestPostgresOnlineExpiredCredentialIsRejectedAfterTheLockWait(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	ctx := context.Background()
	probe := newLockProbe(0)
	servicePool := probedPool(t, fixture, probe)
	service, err := online.Open(ctx, servicePool, moveEvaluator{}, online.WithSeatAuthorizer(fixture.authorizer))
	if err != nil {
		t.Fatal(err)
	}
	actor := online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_a"}
	if _, err = service.Execute(accountContext("user_a", "session-alice"), actor, createOnlineCommand("match-expiry-read", "op-expiry-create")); err != nil {
		t.Fatalf("create match: %v", err)
	}
	// The create took the participant lock, so its key is known.
	key := probe.LockKey(t)
	release := holdParticipantLock(t, fixture.pool, key)
	// A failing test must not leave the participant lock held.
	defer release()

	expiring := onlineauth.NewAccountPrincipal("user_a", "session-alice", authTestOrigin, time.Now().Add(300*time.Millisecond))
	expiringCtx := onlineauth.WithPrincipal(ctx, expiring)
	read := make(chan error, 1)
	go func() {
		_, readErr := service.GetMatchForParticipant(expiringCtx, "match-expiry-read", actor)
		read <- readErr
	}()
	waitSignal(t, probe.reached, "the participant lock request")
	waitForLockWait(t, fixture.pool)
	// The credential expires while the participant waits.
	time.Sleep(400 * time.Millisecond)
	release()

	select {
	case err = <-read:
		if !errors.Is(err, onlineauth.ErrUnauthenticated) {
			t.Fatalf("read with a credential that expired during the lock wait = %v, want ErrUnauthenticated", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the blocked read never completed")
	}
}

// TestPostgresOnlineExpiredCredentialCannotReplayAnAcceptedOperation proves
// that the duplicate path rejects a credential which expired while the
// participant waited for the participant lock.
func TestPostgresOnlineExpiredCredentialCannotReplayAnAcceptedOperation(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	ctx := context.Background()
	probe := newLockProbe(0)
	servicePool := probedPool(t, fixture, probe)
	service, err := online.Open(ctx, servicePool, moveEvaluator{}, online.WithSeatAuthorizer(fixture.authorizer))
	if err != nil {
		t.Fatal(err)
	}
	actor := online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_a"}
	if _, err = service.Execute(accountContext("user_a", "session-alice"), actor, createOnlineCommand("match-expiry-replay", "op-expiry-replay-create")); err != nil {
		t.Fatalf("create match: %v", err)
	}
	move := moveOnlineCommand("match-expiry-replay", "op-expiry-replay-move", online.SeatWhite, 1, "e2e4")
	if _, err = service.Execute(accountContext("user_a", "session-alice"), actor, move); err != nil {
		t.Fatalf("account move: %v", err)
	}
	key := probe.LockKey(t)
	release := holdParticipantLock(t, fixture.pool, key)
	// A failing test must not leave the participant lock held.
	defer release()

	expiring := onlineauth.NewAccountPrincipal("user_a", "session-alice", authTestOrigin, time.Now().Add(300*time.Millisecond))
	expiringCtx := onlineauth.WithPrincipal(ctx, expiring)
	replay := make(chan error, 1)
	go func() {
		result, replayErr := service.Execute(expiringCtx, actor, move)
		if replayErr == nil && !result.Duplicate {
			replayErr = errors.New("the replay was not resolved as a duplicate")
		}
		replay <- replayErr
	}()
	waitSignal(t, probe.reached, "the participant lock request")
	waitForLockWait(t, fixture.pool)
	time.Sleep(400 * time.Millisecond)
	release()

	select {
	case err = <-replay:
		if !errors.Is(err, onlineauth.ErrUnauthenticated) {
			t.Fatalf("replay with a credential that expired during the lock wait = %v, want ErrUnauthenticated", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the blocked replay never completed")
	}
}

// TestPostgresOnlineEmptyRevocationReasonIsRecorded proves that an empty
// revocation reason is stored as a reason the database accepts, and that an
// unsupported reason is rejected without writing a row.
func TestPostgresOnlineEmptyRevocationReasonIsRecorded(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	ctx := context.Background()
	if err := fixture.authorizer.RevokeAccountSession(ctx, "user_reason", "session-reason", ""); err != nil {
		t.Fatalf("revoke a session with an empty reason: %v", err)
	}
	var reason string
	if err := fixture.pool.QueryRow(ctx, `SELECT reason FROM online_session_revocations WHERE subject_id='user_reason' AND session_id='session-reason'`).Scan(&reason); err != nil {
		t.Fatal(err)
	}
	if reason != "owner_request" {
		t.Fatalf("stored reason = %q, want owner_request", reason)
	}
	if err := fixture.authorizer.RevokeAccountSession(ctx, "user_reason", "session-other", "because"); err == nil {
		t.Fatal("an unsupported revocation reason was accepted")
	}
	var stored int
	if err := fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_session_revocations WHERE subject_id='user_reason'`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != 1 {
		t.Fatalf("stored revocations = %d, want 1", stored)
	}

	issued := createGuestMatch(t, fixture, "match-reason")
	if err := fixture.authorizer.RevokeSeatCredential(ctx, issued.Credential.CredentialID, ""); err != nil {
		t.Fatalf("revoke a credential with an empty reason: %v", err)
	}
	var revokedReason *string
	if err := fixture.pool.QueryRow(ctx, `SELECT revoked_reason FROM online_guest_seat_credentials WHERE credential_id=$1`, issued.Credential.CredentialID).Scan(&revokedReason); err != nil {
		t.Fatal(err)
	}
	if revokedReason == nil || *revokedReason != "owner_request" {
		t.Fatalf("stored credential reason = %v, want owner_request", revokedReason)
	}
}
