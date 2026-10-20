package integration

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/auth"
	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/rulesworker"
	"github.com/Kamkmgamer/kamkmchess/backend/serverapp"
	"github.com/jackc/pgx/v5/pgxpool"
)

// KHA-68 evidence for the trusted deadline reconciliation boundary.
//
// An opened match must end when its deadline passes even if neither
// participant sends another command. These fixtures move the stored deadline
// into the past and then invoke the trusted reconciliation once, so the
// outcome never depends on wall-clock waiting.

// realRulesEvaluator returns the private pinned rules process. The timeout
// adjudication needs it, so the automatic outcome is the policy's own.
func realRulesEvaluator(t *testing.T) online.Evaluator {
	t.Helper()
	entry := os.Getenv("KHA66_WORKER_ENTRY")
	if entry == "" {
		t.Skip("set KHA66_WORKER_ENTRY to the built private worker")
	}
	client, err := rulesworker.New(rulesworker.Config{Entry: entry, RequestTimeout: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	evaluator, err := rulesworker.NewOnlineEvaluator(client)
	if err != nil {
		t.Fatal(err)
	}
	return evaluator
}

// timeoutPolicy is a switchable timeout adjudicator. A test can make the
// policy unavailable and available again without rebuilding the service.
type timeoutPolicy struct {
	mu    sync.Mutex
	facts func(input online.RulesInput, expired online.Seat) (online.TimeoutFacts, error)
}

func (p *timeoutPolicy) EvaluateTimeout(_ context.Context, input online.RulesInput, expired online.Seat) (online.TimeoutFacts, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.facts(input, expired)
}

func (p *timeoutPolicy) set(facts func(input online.RulesInput, expired online.Seat) (online.TimeoutFacts, error)) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.facts = facts
}

// policyEvaluator applies the same bounded policy shape as the real rules
// process: a flag fall is either an opponent win or an insufficient-material
// draw.
type policyEvaluator struct {
	moveEvaluator
	policy *timeoutPolicy
}

func (e policyEvaluator) EvaluateTimeout(ctx context.Context, input online.RulesInput, expired online.Seat) (online.TimeoutFacts, error) {
	return e.policy.EvaluateTimeout(ctx, input, expired)
}

func opponentTimeoutFacts(input online.RulesInput, expired online.Seat) (online.TimeoutFacts, error) {
	return online.TimeoutFacts{
		SchemaVersion:      online.RulesInputSchemaVersion,
		EvaluatedVersion:   input.Version,
		EvaluatedInputHash: input.InputHash,
		ControlEpoch:       input.ControlEpoch,
		ExpiredSeat:        expired,
		Winner:             timeoutWinForOpponent(expired),
	}, nil
}

// countRows reads one count from the online tables.
func countRows(t *testing.T, pool *pgxpool.Pool, query string, args ...any) int {
	t.Helper()
	var count int
	if err := pool.QueryRow(context.Background(), query, args...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

// MAT-04: an expired main clock ends the match without any participant
// command. The trusted reconciliation settles it, publishes the public replay
// and leaves no participant receipt behind.
func TestPostgresOnlineTrustedReconciliationSettlesAnExpiredMainClockWithoutAParticipantCommand(t *testing.T) {
	service, pool := onlineService(t, realRulesEvaluator(t))
	ctx := context.Background()
	matchID := "match-deadline-timeout"
	createOnlineMatch(t, service, matchID, "op-deadline-timeout-create")
	playOpeningExchange(t, service, matchID, "op-deadline-timeout")
	before, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if before.Clock.ActiveSeat == nil || *before.Clock.ActiveSeat != online.SeatWhite {
		t.Fatalf("the opening reply did not start White's main clock: %+v", before.Clock)
	}
	expireMainClock(t, pool, matchID)

	// No participant command arrives. The trusted reconciliation realises the
	// deadline on its own.
	sweep, err := service.ReconcileDeadlines(ctx, 10)
	if err != nil {
		t.Fatalf("reconcile deadlines: %v", err)
	}
	if sweep.Due != 1 || sweep.Settled != 1 || sweep.Skipped != 0 || sweep.Pending != 0 {
		t.Fatalf("sweep report = %+v", sweep)
	}

	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != online.MatchCompleted || after.Result == nil {
		t.Fatalf("the expired match did not end: %+v", after)
	}
	if after.Result.Kind != online.ResultWin || after.Result.Reason != online.ReasonTimeout ||
		after.Result.Winner == nil || *after.Result.Winner != online.SeatBlack {
		t.Fatalf("the timeout result = %+v", after.Result)
	}
	// The flagged side lost its whole bank.
	if after.Clock.WhiteMs != 0 {
		t.Fatalf("the flagged bank = %d, want zero", after.Clock.WhiteMs)
	}
	// Exactly one version advance and no extra increment.
	if after.Version != before.Version+1 {
		t.Fatalf("the match version = %d, want %d", after.Version, before.Version+1)
	}
	if len(after.Moves) != len(before.Moves) {
		t.Fatalf("the sweep accepted moves: %d, want %d", len(after.Moves), len(before.Moves))
	}
	if after.Clock.BlackMs != before.Clock.BlackMs {
		t.Fatalf("the sweep minted an increment: %d, want %d", after.Clock.BlackMs, before.Clock.BlackMs)
	}
	// The participant read shows the settled match.
	view, err := service.GetMatchForParticipant(ctx, matchID, alice)
	if err != nil {
		t.Fatal(err)
	}
	if view.Status != online.MatchCompleted || view.Result == nil {
		t.Fatalf("the participant read = %+v", view)
	}
	// The public replay carries the timeout and the accepted line.
	projection, err := service.GetPublicProjection(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if projection.Result.Reason != online.ReasonTimeout || len(projection.Moves) != len(before.Moves) {
		t.Fatalf("the public projection = %+v", projection)
	}
	// The authoritative event log records one timeout and no participant
	// receipt: the sweep fabricates no identity and spends no operation ID.
	if events := countRows(t, pool, `SELECT count(*) FROM online_events WHERE match_id=$1 AND event_kind='timeout'`, matchID); events != 1 {
		t.Fatalf("timeout events = %d, want 1", events)
	}
	if receipts := countRows(t, pool, `SELECT count(*) FROM online_operation_receipts WHERE scope_id=$1`, matchID); receipts != 3 {
		t.Fatalf("receipts = %d, want the creation and the two accepted moves only", receipts)
	}
	// A second reconciliation settles nothing.
	again, err := service.ReconcileDeadlines(ctx, 10)
	if err != nil {
		t.Fatalf("second reconcile: %v", err)
	}
	if again.Due != 0 || again.Settled != 0 {
		t.Fatalf("the second sweep = %+v", again)
	}
	final, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if final.Version != after.Version {
		t.Fatalf("the second sweep advanced the match to %d", final.Version)
	}
}

// MAT-01 and MAT-04: an unanswered opening reply aborts the match without any
// participant command.
func TestPostgresOnlineTrustedReconciliationAbortsAnUnansweredOpeningReplyWithoutAParticipantCommand(t *testing.T) {
	service, pool := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-deadline-opening"
	createOnlineMatch(t, service, matchID, "op-deadline-opening-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-deadline-opening-white", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	before, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if before.Clock.ReplySeat == nil || *before.Clock.ReplySeat != online.SeatBlack {
		t.Fatalf("the opening move armed no reply window: %+v", before.Clock)
	}
	expireReplyWindow(t, pool, matchID)

	sweep, err := service.ReconcileDeadlines(ctx, 10)
	if err != nil {
		t.Fatalf("reconcile deadlines: %v", err)
	}
	if sweep.Due != 1 || sweep.Settled != 1 {
		t.Fatalf("sweep report = %+v", sweep)
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != online.MatchAborted || after.Result == nil {
		t.Fatalf("the unanswered reply did not abort the match: %+v", after)
	}
	if after.Result.Kind != online.ResultAbort || after.Result.Reason != online.ReasonOpeningReplyTimeout || after.Result.Winner != nil {
		t.Fatalf("the opening abort result = %+v", after.Result)
	}
	// The responder's bank never ran, so the abort did not charge it.
	if after.Clock.BlackMs != before.Clock.BlackMs {
		t.Fatalf("the opening abort charged the responder: %d, want %d", after.Clock.BlackMs, before.Clock.BlackMs)
	}
	if after.Version != before.Version+1 {
		t.Fatalf("the match version = %d, want %d", after.Version, before.Version+1)
	}
	projection, err := service.GetPublicProjection(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if projection.Result.Reason != online.ReasonOpeningReplyTimeout {
		t.Fatalf("the public opening abort = %+v", projection.Result)
	}
	if events := countRows(t, pool, `SELECT count(*) FROM online_events WHERE match_id=$1 AND event_kind='abort'`, matchID); events != 1 {
		t.Fatalf("abort events = %d, want 1", events)
	}
	if receipts := countRows(t, pool, `SELECT count(*) FROM online_operation_receipts WHERE scope_id=$1`, matchID); receipts != 2 {
		t.Fatalf("receipts = %d, want the creation and the opening move only", receipts)
	}
}

// MAT-12 and ARC-03: two concurrent sweeps settle the match exactly once.
func TestPostgresOnlineTrustedReconciliationIsIdempotentUnderConcurrentSweeps(t *testing.T) {
	service, pool := onlineService(t, realRulesEvaluator(t))
	ctx := context.Background()
	matchID := "match-deadline-concurrent"
	createOnlineMatch(t, service, matchID, "op-deadline-concurrent-create")
	playOpeningExchange(t, service, matchID, "op-deadline-concurrent")
	before, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	expireMainClock(t, pool, matchID)

	var wg sync.WaitGroup
	sweeps := make(chan online.DeadlineSweep, 4)
	errs := make(chan error, 4)
	for index := 0; index < 4; index++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sweep, err := service.ReconcileDeadlines(ctx, 10)
			sweeps <- sweep
			errs <- err
		}()
	}
	wg.Wait()
	close(sweeps)
	close(errs)
	settled := 0
	for sweep := range sweeps {
		settled += sweep.Settled
	}
	for err := range errs {
		if err != nil {
			t.Fatalf("a concurrent sweep failed: %v", err)
		}
	}
	if settled != 1 {
		t.Fatalf("the concurrent sweeps settled %d matches, want exactly one", settled)
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Version != before.Version+1 {
		t.Fatalf("the match version = %d, want %d", after.Version, before.Version+1)
	}
	if after.Result == nil || after.Result.Reason != online.ReasonTimeout {
		t.Fatalf("the settled result = %+v", after.Result)
	}
	if events := countRows(t, pool, `SELECT count(*) FROM online_events WHERE match_id=$1 AND event_kind='timeout'`, matchID); events != 1 {
		t.Fatalf("timeout events = %d, want 1", events)
	}
	if projections := countRows(t, pool, `SELECT count(*) FROM online_public_projections WHERE match_id=$1`, matchID); projections != 1 {
		t.Fatalf("public projections = %d, want 1", projections)
	}
	if after.Clock.BlackMs != before.Clock.BlackMs {
		t.Fatalf("a concurrent sweep minted an increment: %d, want %d", after.Clock.BlackMs, before.Clock.BlackMs)
	}
}

// MAT-04: a sweep that races a participant command settles the match once.
// The late intent never becomes a move.
func TestPostgresOnlineTrustedReconciliationRacesAParticipantCommand(t *testing.T) {
	service, pool := onlineService(t, realRulesEvaluator(t))
	ctx := context.Background()
	matchID := "match-deadline-race-move"
	createOnlineMatch(t, service, matchID, "op-deadline-race-move-create")
	playOpeningExchange(t, service, matchID, "op-deadline-race-move")
	before, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	expireMainClock(t, pool, matchID)

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-deadline-race-move-late", online.SeatWhite, 3, "g1f3"))
		errs <- err
	}()
	go func() {
		defer wg.Done()
		_, err := service.ReconcileDeadlines(ctx, 10)
		errs <- err
	}()
	wg.Wait()
	close(errs)
	for err := range errs {
		// The late intent either settles the expiry itself or is refused
		// because the match already ended. It never becomes a move.
		if err != nil && !errors.Is(err, online.ErrMatchEnded) && !errors.Is(err, online.ErrConflict) {
			t.Fatalf("the raced command failed: %v", err)
		}
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != online.MatchCompleted || after.Result == nil || after.Result.Reason != online.ReasonTimeout {
		t.Fatalf("the raced match = %+v", after)
	}
	if after.Version != before.Version+1 {
		t.Fatalf("the match version = %d, want %d", after.Version, before.Version+1)
	}
	if len(after.Moves) != len(before.Moves) {
		t.Fatalf("the late move became a move: %d, want %d", len(after.Moves), len(before.Moves))
	}
	if events := countRows(t, pool, `SELECT count(*) FROM online_events WHERE match_id=$1 AND event_kind='timeout'`, matchID); events != 1 {
		t.Fatalf("timeout events = %d, want 1", events)
	}
}

// MAT-04 and MAT-08: a sweep that races a resignation, a cancellation and a
// control change settles the match once, and the expired clock still wins
// over every intent.
func TestPostgresOnlineTrustedReconciliationRacesAResignationACancellationAndAControlChange(t *testing.T) {
	service, pool := onlineService(t, realRulesEvaluator(t))
	ctx := context.Background()
	matchID := "match-deadline-race-cancel"
	createOnlineMatch(t, service, matchID, "op-deadline-race-cancel-create")
	playOpeningExchange(t, service, matchID, "op-deadline-race-cancel")
	before, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	expireMainClock(t, pool, matchID)

	var wg sync.WaitGroup
	errs := make(chan error, 4)
	wg.Add(4)
	go func() {
		defer wg.Done()
		_, err := service.Execute(ctx, bob, cancelOnlineCommand(matchID, "op-deadline-race-cancel-cancel", online.SeatBlack, 3))
		errs <- err
	}()
	go func() {
		defer wg.Done()
		_, err := service.Execute(ctx, bob, resignOnlineCommand(matchID, "op-deadline-race-cancel-resign", online.SeatBlack, 3))
		errs <- err
	}()
	go func() {
		defer wg.Done()
		label := "Declared Model"
		_, err := service.Execute(ctx, alice, setControlOnlineCommand(matchID, "op-deadline-race-cancel-control", online.SeatWhite, 3, online.SeatControl{Kind: online.ControlAgent, ModelLabel: &label}))
		errs <- err
	}()
	go func() {
		defer wg.Done()
		_, err := service.ReconcileDeadlines(ctx, 10)
		errs <- err
	}()
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil && !errors.Is(err, online.ErrMatchEnded) && !errors.Is(err, online.ErrConflict) {
			t.Fatalf("the raced command failed: %v", err)
		}
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != online.MatchCompleted || after.Result == nil || after.Result.Reason != online.ReasonTimeout {
		t.Fatalf("the raced match = %+v", after)
	}
	if after.Version != before.Version+1 {
		t.Fatalf("the match version = %d, want %d", after.Version, before.Version+1)
	}
	// The expiry is reconciled before any other intent, so the control change
	// never took effect.
	if after.ControlEpoch != before.ControlEpoch {
		t.Fatalf("the control epoch = %d, want %d", after.ControlEpoch, before.ControlEpoch)
	}
	terminal := countRows(t, pool, `SELECT count(*) FROM online_events WHERE match_id=$1 AND event_kind IN ('timeout','resign','cancel','abort','draw_agreement','illegal_move_loss')`, matchID)
	if terminal != 1 {
		t.Fatalf("terminal events = %d, want exactly one", terminal)
	}
}

// MAT-04 and ARC-03: the rules evaluation of a flag fall runs outside the
// match row lock and outside every transaction, so a second writer can take
// the row while the rules process works.
func TestPostgresOnlineTrustedReconciliationEvaluatesTheRulesOutsideTheMatchLock(t *testing.T) {
	var pool *pgxpool.Pool
	var lockErr error
	var heldConnections int32
	service, opened := onlineService(t, timeoutEvaluator{
		winnerFor: timeoutWinForOpponent,
		observe: func(input online.RulesInput, _ online.Seat) {
			// The sweep must hold neither the match row nor a pooled
			// connection while the rules process works.
			heldConnections = pool.Stat().AcquiredConns()
			conn, err := pool.Acquire(context.Background())
			if err != nil {
				lockErr = err
				return
			}
			defer conn.Release()
			tx, err := conn.Begin(context.Background())
			if err != nil {
				lockErr = err
				return
			}
			defer tx.Rollback(context.Background())
			var matchID string
			// A lock that is already taken fails at once.
			lockErr = tx.QueryRow(context.Background(), `SELECT match_id FROM online_matches WHERE match_id=$1 FOR UPDATE NOWAIT`, input.MatchID).Scan(&matchID)
		},
	})
	pool = opened
	ctx := context.Background()
	matchID := "match-deadline-outside-lock"
	createOnlineMatch(t, service, matchID, "op-deadline-outside-lock-create")
	playOpeningExchange(t, service, matchID, "op-deadline-outside-lock")
	expireMainClock(t, pool, matchID)

	sweep, err := service.ReconcileDeadlines(ctx, 10)
	if err != nil {
		t.Fatalf("reconcile deadlines: %v", err)
	}
	if lockErr != nil {
		t.Fatalf("the rules evaluation held the match row lock: %v", lockErr)
	}
	if heldConnections != 0 {
		t.Fatalf("the rules evaluation held %d pooled connections, want none", heldConnections)
	}
	if sweep.Settled != 1 {
		t.Fatalf("sweep report = %+v", sweep)
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != online.MatchCompleted || after.Result == nil || after.Result.Reason != online.ReasonTimeout {
		t.Fatalf("the settled match = %+v", after)
	}
}

// MAT-04: without a timeout-capable rules policy the expiry stays pending.
// The writer fails closed instead of manufacturing a win.
func TestPostgresOnlineTrustedReconciliationKeepsAnExpiredClockPendingWithoutATimeoutPolicy(t *testing.T) {
	service, pool := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-deadline-no-policy"
	createOnlineMatch(t, service, matchID, "op-deadline-no-policy-create")
	playOpeningExchange(t, service, matchID, "op-deadline-no-policy")
	before, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	expireMainClock(t, pool, matchID)

	sweep, err := service.ReconcileDeadlines(ctx, 10)
	if !errors.Is(err, online.ErrTimeoutPolicyUnavailable) {
		t.Fatalf("a flag fall without a timeout policy = %v, want ErrTimeoutPolicyUnavailable", err)
	}
	if sweep.Settled != 0 || sweep.Pending != 1 {
		t.Fatalf("sweep report = %+v", sweep)
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != online.MatchActive || after.Result != nil || after.Version != before.Version {
		t.Fatalf("the fail-closed expiry changed the match: %+v", after)
	}
	// The expiry is kept, so a later pass still finds the match.
	ids, err := service.DueDeadlineMatchIDs(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 || ids[0] != matchID {
		t.Fatalf("the pending expiry was dropped: %+v", ids)
	}
	if events := countRows(t, pool, `SELECT count(*) FROM online_events WHERE match_id=$1 AND event_kind='timeout'`, matchID); events != 0 {
		t.Fatalf("the fail-closed expiry wrote %d timeout events", events)
	}
}

// MAT-04: a pending timeout must not keep a later opening abort outside every
// bounded batch. The unavailable rules policy is needed only by the timeout.
func TestPostgresOnlinePendingTimeoutDoesNotStarveLaterOpeningExpiry(t *testing.T) {
	service, pool := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	mainID := "match-deadline-fair-a"
	createOnlineMatch(t, service, mainID, "op-fair-main-create")
	playOpeningExchange(t, service, mainID, "op-fair-main")
	expireMainClock(t, pool, mainID)
	if _, err := pool.Exec(ctx, `UPDATE online_clocks SET active_since=active_since-interval '2 hours',deadline_at=deadline_at-interval '2 hours' WHERE match_id=$1`, mainID); err != nil {
		t.Fatal(err)
	}
	openingID := "match-deadline-fair-b"
	createOnlineMatch(t, service, openingID, "op-fair-opening-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(openingID, "op-fair-opening-move", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE online_clocks SET reply_deadline_at=clock_timestamp()-interval '1 hour' WHERE match_id=$1`, openingID); err != nil {
		t.Fatal(err)
	}

	first, err := service.ReconcileDeadlines(ctx, 1)
	if !errors.Is(err, online.ErrTimeoutPolicyUnavailable) || first.Due != 1 || first.Pending != 1 {
		t.Fatalf("the pending timeout pass = %+v, %v", first, err)
	}
	second, err := service.ReconcileDeadlines(ctx, 1)
	if err != nil || second.Due != 1 || second.Settled != 1 {
		t.Fatalf("a pending timeout starved the later opening expiry: %+v, %v", second, err)
	}
	opening, err := service.GetMatch(ctx, openingID)
	if err != nil || opening.Status != online.MatchAborted || opening.Result == nil || opening.Result.Reason != online.ReasonOpeningReplyTimeout {
		t.Fatalf("the opening reply did not abort: %+v, %v", opening, err)
	}
	// Rotation still retries the earlier failure after reaching the end.
	retry, err := service.ReconcileDeadlines(ctx, 1)
	if !errors.Is(err, online.ErrTimeoutPolicyUnavailable) || retry.Due != 1 || retry.Pending != 1 {
		t.Fatalf("the earlier timeout was not retried: %+v, %v", retry, err)
	}
}

// MAT-04: while the rules service is unavailable the expiry stays pending
// for a retry, and no result is invented.
func TestPostgresOnlineTrustedReconciliationKeepsAnExpiredClockPendingWhileTheRulesServiceIsUnavailable(t *testing.T) {
	policy := &timeoutPolicy{}
	policy.set(func(online.RulesInput, online.Seat) (online.TimeoutFacts, error) {
		return online.TimeoutFacts{}, errors.New("the rules process is unavailable")
	})
	service, pool := onlineService(t, policyEvaluator{moveEvaluator: moveEvaluator{}, policy: policy})
	ctx := context.Background()
	matchID := "match-deadline-rules-down"
	createOnlineMatch(t, service, matchID, "op-deadline-rules-down-create")
	playOpeningExchange(t, service, matchID, "op-deadline-rules-down")
	before, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	expireMainClock(t, pool, matchID)

	sweep, err := service.ReconcileDeadlines(ctx, 10)
	if !errors.Is(err, online.ErrUnavailable) {
		t.Fatalf("an unavailable rules service = %v, want ErrUnavailable", err)
	}
	if sweep.Settled != 0 || sweep.Pending != 1 {
		t.Fatalf("sweep report = %+v", sweep)
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != online.MatchActive || after.Result != nil || after.Version != before.Version {
		t.Fatalf("the pending expiry changed the match: %+v", after)
	}
	if events := countRows(t, pool, `SELECT count(*) FROM online_events WHERE match_id=$1 AND event_kind='timeout'`, matchID); events != 0 {
		t.Fatalf("the pending expiry wrote %d timeout events", events)
	}
	// The rules service recovers and the next pass settles the same expiry.
	policy.set(opponentTimeoutFacts)
	retry, err := service.ReconcileDeadlines(ctx, 10)
	if err != nil {
		t.Fatalf("the retry after the recovery failed: %v", err)
	}
	if retry.Settled != 1 {
		t.Fatalf("the retry report = %+v", retry)
	}
	settled, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if settled.Status != online.MatchCompleted || settled.Result == nil || settled.Result.Reason != online.ReasonTimeout {
		t.Fatalf("the settled match = %+v", settled)
	}
	if settled.Version != before.Version+1 {
		t.Fatalf("the match version = %d, want %d", settled.Version, before.Version+1)
	}
}

// MAT-04: the bounded scan reports due matches only, and it is bounded.
func TestPostgresOnlineDueDeadlineScanIsBoundedAndReturnsIdentifiers(t *testing.T) {
	service, pool := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	due := []string{"match-deadline-scan-a", "match-deadline-scan-b", "match-deadline-scan-c"}
	for _, matchID := range due {
		createOnlineMatch(t, service, matchID, "op-deadline-scan-create-"+matchID[len(matchID)-1:])
		if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-deadline-scan-move-"+matchID[len(matchID)-1:], online.SeatWhite, 1, "e2e4")); err != nil {
			t.Fatalf("opening move: %v", err)
		}
		expireReplyWindow(t, pool, matchID)
	}
	// A match without a deadline is never reported.
	createOnlineMatch(t, service, "match-deadline-scan-open", "op-deadline-scan-open-create")

	ids, err := service.DueDeadlineMatchIDs(ctx, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 {
		t.Fatalf("the bounded scan returned %d identifiers, want 2", len(ids))
	}
	for _, id := range ids {
		found := false
		for _, want := range due {
			if id == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("the scan reported an unexpected match %q", id)
		}
	}
	all, err := service.DueDeadlineMatchIDs(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != len(due) {
		t.Fatalf("the full scan returned %d identifiers, want %d", len(all), len(due))
	}
}

// MAT-04: the server's deadline loop settles a due match without a
// participant command, and the release stops the background work.
func TestPostgresOnlineDeadlineReconcilerSettlesADueMatchAndStopsOnRelease(t *testing.T) {
	service, pool := onlineService(t, realRulesEvaluator(t))
	ctx := context.Background()
	matchID := "match-deadline-loop"
	createOnlineMatch(t, service, matchID, "op-deadline-loop-create")
	playOpeningExchange(t, service, matchID, "op-deadline-loop")
	expireMainClock(t, pool, matchID)

	stop := serverapp.StartDeadlineReconciler(ctx, service, serverapp.DeadlineSweepConfig{Interval: 20 * time.Millisecond, Batch: 10})
	waitForMatchStatus(t, service, matchID, online.MatchCompleted, 10*time.Second)
	stop()

	// The released loop does no more work: a newly expired match stays active.
	second := "match-deadline-loop-after"
	createOnlineMatch(t, service, second, "op-deadline-loop-after-create")
	playOpeningExchange(t, service, second, "op-deadline-loop-after")
	expireMainClock(t, pool, second)
	time.Sleep(300 * time.Millisecond)
	after, err := service.GetMatch(ctx, second)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != online.MatchActive {
		t.Fatalf("the released loop still settled matches: %+v", after)
	}
}

// waitForMatchStatus waits until a match reaches a status.
func waitForMatchStatus(t *testing.T, service *online.Service, matchID string, status online.MatchStatus, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		match, err := service.GetMatch(context.Background(), matchID)
		if err == nil && match.Status == status {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	match, err := service.GetMatch(context.Background(), matchID)
	t.Fatalf("the match %s did not reach %q: %+v (%v)", matchID, status, match, err)
}

// The production wiring: the server bootstrap starts the deadline loop and
// the release stops it. The loop settles a due match without a participant
// command, and no sweep runs after the release.
func TestPostgresOnlineServerLifecycleSettlesADueMatchAndStopsOnRelease(t *testing.T) {
	entry := os.Getenv("KHA66_WORKER_ENTRY")
	if entry == "" {
		t.Skip("set KHA66_WORKER_ENTRY to the built private worker")
	}
	url := isolatedSchemaURL(t)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	service, err := online.Open(ctx, pool, realRulesEvaluator(t))
	if err != nil {
		t.Fatal(err)
	}
	matchID := "match-deadline-server"
	createOnlineMatch(t, service, matchID, "op-deadline-server-create")
	playOpeningExchange(t, service, matchID, "op-deadline-server")
	expireMainClock(t, pool, matchID)

	_, release, err := serverapp.Open(ctx, serverapp.Config{
		DatabaseURL: url,
		Clerk: auth.Config{
			Issuer:            "https://clerk.example",
			JWKSURL:           "https://clerk.example/.well-known/jwks.json",
			AuthorizedParties: []string{"https://app.example"},
			AllowedOrigins:    []string{"https://app.example"},
		},
		Online: serverapp.OnlineConfig{
			RulesWorkerEntry:      entry,
			DeadlineSweepInterval: 20 * time.Millisecond,
			DeadlineSweepBatch:    10,
		},
	})
	if err != nil {
		t.Fatalf("open the server: %v", err)
	}
	waitForMatchStatus(t, service, matchID, online.MatchCompleted, 10*time.Second)
	release()

	// The released server does no more work.
	second := "match-deadline-server-after"
	createOnlineMatch(t, service, second, "op-deadline-server-after-create")
	playOpeningExchange(t, service, second, "op-deadline-server-after")
	expireMainClock(t, pool, second)
	time.Sleep(300 * time.Millisecond)
	after, err := service.GetMatch(ctx, second)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != online.MatchActive {
		t.Fatalf("the released server still settled matches: %+v", after)
	}
}

// MAT-04 boundary: the participant HTTP surface cannot invoke the trusted
// deadline reconciliation, and there is no public cron route. Only the
// trusted seam settles a due match without a participant command.
func TestPostgresOnlineHTTPCannotInvokeTheTrustedDeadlineReconciliation(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	matchID := "match-deadline-http"
	issued := createGuestMatch(t, fixture, matchID)
	guest := guestParticipant(t, fixture, issued)
	guestCtx := onlineauth.WithPrincipal(context.Background(), guest)
	// The opening move arms the reply window, so the match owns a deadline.
	if _, err := fixture.service.Execute(guestCtx, guest.Participant, moveOnlineCommand(matchID, "op-deadline-http-white", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	handler := onlineHTTPFixture(t, fixture)
	expireReplyWindow(t, fixture.pool, matchID)

	for _, path := range []string{
		"/v1/online/matches/" + matchID + "/commands",
		"/v1/online/matches/" + matchID + "/reconcile",
		"/v1/online/matches/" + matchID + "/sweep",
		"/v1/online/matches/" + matchID + "/cron",
		"/v1/online/deadlines",
		"/v1/online/cron",
	} {
		response := onlineHTTPRequest(handler, http.MethodPost, path, authTestOrigin, "", nil, "")
		if response.Code != http.StatusUnauthorized && response.Code != http.StatusNotFound {
			t.Fatalf("%s status=%d body=%s", path, response.Code, response.Body.String())
		}
	}
	// The unauthenticated surface left the expired match untouched.
	match, err := fixture.service.GetMatch(context.Background(), matchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.Status != online.MatchActive || match.Result != nil {
		t.Fatalf("the HTTP surface settled the match: %+v", match)
	}
	// The trusted seam settles the same expiry.
	sweep, err := fixture.service.ReconcileDeadlines(context.Background(), 10)
	if err != nil {
		t.Fatalf("reconcile deadlines: %v", err)
	}
	if sweep.Settled != 1 {
		t.Fatalf("sweep report = %+v", sweep)
	}
	settled, err := fixture.service.GetMatch(context.Background(), matchID)
	if err != nil {
		t.Fatal(err)
	}
	if settled.Status != online.MatchAborted || settled.Result == nil || settled.Result.Reason != online.ReasonOpeningReplyTimeout {
		t.Fatalf("the settled match = %+v", settled)
	}
}

// isolatedSchemaURL creates an isolated schema, applies the migrations and
// returns a connection URL that uses it.
//
// The server bootstrap builds its own pool from a URL, so the production
// wiring fixture needs the isolated schema to be reachable through a URL.
func isolatedSchemaURL(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv(databaseEnv)
	if dsn == "" {
		if os.Getenv("KHA41_REQUIRE_POSTGRES") == "1" {
			t.Fatalf("%s is required", databaseEnv)
		}
		t.Skipf("PostgreSQL integration unavailable: set %s", databaseEnv)
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect isolated PostgreSQL: %v", err)
	}
	if err = admin.Ping(ctx); err != nil {
		admin.Close()
		t.Fatalf("ping isolated PostgreSQL: %v", err)
	}
	schema := fmt.Sprintf("kha68_%d_%s", time.Now().UnixNano(), randomSchemaSuffix())
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatalf("create test schema: %v", err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE"); admin.Close() })
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err = migrations.Apply(ctx, pool); err != nil {
		pool.Close()
		t.Fatalf("apply migrations: %v", err)
	}
	pool.Close()
	separator := "?"
	if strings.Contains(dsn, "?") {
		separator = "&"
	}
	return dsn + separator + "search_path=" + schema
}
