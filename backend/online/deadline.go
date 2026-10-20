package online

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The trusted deadline boundary.
//
// A match arms at most one deadline: the opening reply window or the main
// clock. When that deadline passes, the match must end even if neither
// participant sends another command. The reconciliation below realises that
// deadline without a participant command.
//
// The boundary is trusted, not public. It never fabricates an account or guest
// identity, it never spends a participant-chosen operation ID, and it is not
// reachable from an unauthenticated HTTP caller: the participant API holds
// only the narrow reader/writer interface, and the sweep is started by the
// server lifecycle.
//
// Every transition is decided under the match row lock, is written atomically
// with its authoritative event and its public projection, and is idempotent:
// a second sweep of the same match finds the terminal result and writes
// nothing.

// DefaultDeadlineSweepBatch bounds one reconciliation pass.
const DefaultDeadlineSweepBatch = 100

// MaxDeadlineSweepBatch is the hard ceiling of one reconciliation pass. A
// caller cannot ask for an unbounded batch.
const MaxDeadlineSweepBatch = 1000

// deadlineScan rotates bounded passes through due matches. A pending rules
// evaluation cannot permanently keep later deadlines outside the batch.
type deadlineScan struct {
	mu    sync.Mutex
	after string
}

// DeadlineOutcome reports what one trusted reconciliation did with a match.
type DeadlineOutcome string

const (
	// DeadlineSettled means the match ended with a terminal result.
	DeadlineSettled DeadlineOutcome = "settled"
	// DeadlineNotDue means the match carries no passed deadline any more.
	DeadlineNotDue DeadlineOutcome = "not_due"
	// DeadlineAlreadySettled means the match already carried a terminal result.
	DeadlineAlreadySettled DeadlineOutcome = "already_settled"
)

// DeadlineSweep summarises one bounded reconciliation pass.
type DeadlineSweep struct {
	// Due is the number of matches the bounded scan reported.
	Due int
	// Settled is the number of matches this pass ended with a terminal result.
	Settled int
	// Skipped is the number of due matches that were already settled or that
	// carried no passed deadline any more.
	Skipped int
	// Pending is the number of due matches that stay pending for a later
	// pass. A pending match keeps its expiry, so a later pass retries it.
	Pending int
}

// DeadlineReconciler is the trusted deadline seam the server lifecycle uses.
//
// It is satisfied by *Service, which stays the only transaction writer. The
// server owns the cadence; the service owns the decision.
type DeadlineReconciler interface {
	// ReconcileDeadlines settles the due matches of one bounded pass.
	ReconcileDeadlines(ctx context.Context, limit int) (DeadlineSweep, error)
}

// DueDeadlineMatchIDs returns the identifiers of the matches whose armed
// deadline has passed.
//
// The scan is bounded and returns identifiers only. No database connection is
// held while an external rules evaluation runs, and no connection waits idle
// between two passes.
func (s *Service) DueDeadlineMatchIDs(ctx context.Context, limit int) ([]string, error) {
	return s.dueDeadlineMatchIDs(ctx, limit, "")
}

func (s *Service) dueDeadlineMatchIDs(ctx context.Context, limit int, after string) ([]string, error) {
	if limit <= 0 {
		limit = DefaultDeadlineSweepBatch
	}
	if limit > MaxDeadlineSweepBatch {
		limit = MaxDeadlineSweepBatch
	}
	// The scan uses one database timestamp. Final acceptance still samples a
	// fresh clock after the match lock; the scan only selects possible work.
	rows, err := s.db.Query(ctx, `SELECT c.match_id FROM online_clocks c JOIN online_matches m ON m.match_id=c.match_id WHERE m.status='active' AND ((c.deadline_at IS NOT NULL AND c.deadline_at <= statement_timestamp()) OR (c.reply_deadline_at IS NOT NULL AND c.reply_deadline_at <= statement_timestamp())) ORDER BY (c.match_id <= $2),c.match_id LIMIT $1`, limit, after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0, limit)
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}

func (s *Service) nextDueDeadlineMatchIDs(ctx context.Context, limit int) ([]string, error) {
	s.deadlineScan.mu.Lock()
	defer s.deadlineScan.mu.Unlock()
	ids, err := s.dueDeadlineMatchIDs(ctx, limit, s.deadlineScan.after)
	if err == nil && len(ids) != 0 {
		s.deadlineScan.after = ids[len(ids)-1]
	}
	return ids, err
}

// ReconcileDeadline settles one match whose armed deadline has passed.
//
// This is a trusted seam. It never fabricates a participant identity and it
// never spends a participant-chosen operation ID: the transition is recorded
// as an authoritative event and the public projection is published in the same
// transaction under the match row lock.
//
// The transition is idempotent. A second sweep of the same match finds the
// terminal result and settles nothing.
//
// A main clock expiry needs the bounded timeout policy, so it is evaluated
// outside every transaction and every lock. When that policy is unavailable
// the expiry stays pending for a later pass instead of inventing a result.
func (s *Service) ReconcileDeadline(ctx context.Context, matchID string) (DeadlineOutcome, error) {
	if !idPattern.MatchString(matchID) {
		return "", ErrInvalidArgument
	}
	// One consistent snapshot decides which deadline applies. No lock and no
	// transaction is held while the rules process runs.
	snapshot, now, err := loadDeadlineSnapshot(ctx, s.db, matchID)
	if err != nil {
		return "", err
	}
	if snapshot.Status != MatchActive {
		return DeadlineAlreadySettled, nil
	}
	if snapshot.Clock.ReplyExpired(now) {
		return s.settleOpeningExpiry(ctx, snapshot)
	}
	if snapshot.Clock.IsExpired(now) {
		return s.settleClockExpiry(ctx, snapshot)
	}
	return DeadlineNotDue, nil
}

// ReconcileDeadlines settles the due matches of one bounded pass.
//
// The pass reports what it did. A match that cannot be settled stays pending:
// its expiry is kept, so a later pass retries it. The first failure is
// returned so a caller can log it, and the remaining matches of the pass are
// still attempted.
func (s *Service) ReconcileDeadlines(ctx context.Context, limit int) (DeadlineSweep, error) {
	// Only scan selection is serialized. The cursor advances before any rules
	// work starts, with all database connections and scan locks released.
	ids, err := s.nextDueDeadlineMatchIDs(ctx, limit)
	if err != nil {
		return DeadlineSweep{}, err
	}
	sweep := DeadlineSweep{Due: len(ids)}
	var firstErr error
	for _, id := range ids {
		outcome, err := s.ReconcileDeadline(ctx, id)
		switch {
		case err != nil:
			sweep.Pending++
			if firstErr == nil {
				firstErr = err
			}
		case outcome == DeadlineSettled:
			sweep.Settled++
		default:
			sweep.Skipped++
		}
	}
	return sweep, firstErr
}

// settleOpeningExpiry ends a match whose opening reply window closed without
// an accepted reply.
//
// The abort needs no chess rules, so the decision is taken under a fresh lock
// and a freshly sampled decision time.
func (s *Service) settleOpeningExpiry(ctx context.Context, snapshot Match) (DeadlineOutcome, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	match, clock, _, err := lockMatch(ctx, tx, snapshot.MatchID)
	if err != nil {
		return "", err
	}
	if match.Status != MatchActive {
		return DeadlineAlreadySettled, nil
	}
	match.Clock = clock
	// The accepted line belongs to the terminal state and to the published
	// projection, so it is read under the same lock.
	if match.Moves, err = loadMoves(ctx, tx, snapshot.MatchID); err != nil {
		return "", err
	}
	decision, err := sampleDecision(ctx, tx, match.UpdatedAt)
	if err != nil {
		return "", err
	}
	if clock.ReplySeat == nil || !clock.ReplyExpired(decision) {
		return DeadlineNotDue, nil
	}
	result := &Result{Kind: ResultAbort, Reason: ReasonOpeningReplyTimeout}
	if _, err = s.applyDeadlineResult(ctx, tx, match, clock, decision, EventAbort, *clock.ReplySeat, result); err != nil {
		return "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	return DeadlineSettled, nil
}

// settleClockExpiry ends a match whose main clock ran out.
//
// The bounded timeout policy needs chess rules, so it is evaluated outside
// every transaction and every lock and then fenced by re-locking and
// re-checking the identical position, version, control epoch and expired seat.
// When no timeout-capable evaluator exists the writer fails closed: the expiry
// stays pending and no win is manufactured for the side that did not flag.
func (s *Service) settleClockExpiry(ctx context.Context, snapshot Match) (DeadlineOutcome, error) {
	if snapshot.Clock.ActiveSeat == nil {
		return DeadlineNotDue, nil
	}
	expired := *snapshot.Clock.ActiveSeat
	evaluator, ok := s.evaluator.(TimeoutEvaluator)
	if !ok {
		return "", ErrTimeoutPolicyUnavailable
	}
	input := BuildRulesInput(snapshot, snapshot.Moves, "")
	// External rules evaluation happens with no database lock or transaction
	// held.
	facts, err := evaluator.EvaluateTimeout(ctx, input, expired)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if err = facts.Validate(); err != nil {
		return "", err
	}
	if facts.EvaluatedVersion != input.Version ||
		facts.EvaluatedInputHash != input.InputHash ||
		facts.ControlEpoch != input.ControlEpoch ||
		facts.ExpiredSeat != expired {
		return "", ErrStaleCandidate
	}
	result := facts.Result()
	if err = result.Validate(); err != nil {
		return "", err
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	match, clock, _, err := lockMatch(ctx, tx, snapshot.MatchID)
	if err != nil {
		return "", err
	}
	if match.Status != MatchActive {
		return DeadlineAlreadySettled, nil
	}
	match.Clock = clock
	if match.Moves, err = loadMoves(ctx, tx, snapshot.MatchID); err != nil {
		return "", err
	}
	// The decision time is re-sampled after every lock is held, so a sweep
	// that waited for a busy match is judged against the time it acquired the
	// lock.
	decision, err := sampleDecision(ctx, tx, match.UpdatedAt)
	if err != nil {
		return "", err
	}
	if clock.ActiveSeat == nil || *clock.ActiveSeat != expired || !clock.IsExpired(decision) {
		return DeadlineNotDue, nil
	}
	if match.Version != facts.EvaluatedVersion || match.ControlEpoch != facts.ControlEpoch {
		return "", ErrStaleCandidate
	}
	if BuildRulesInput(match, match.Moves, "").InputHash != facts.EvaluatedInputHash {
		return "", ErrStaleCandidate
	}
	if _, err = s.applyDeadlineResult(ctx, tx, match, clock, decision, EventTimeout, expired, result); err != nil {
		return "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	return DeadlineSettled, nil
}

// loadDeadlineSnapshot reads one match and the authoritative database time in
// one consistent snapshot.
//
// The snapshot is read-only and repeatable-read, so the match state and the
// clock reading describe the same committed version.
func loadDeadlineSnapshot(ctx context.Context, db *pgxpool.Pool, matchID string) (Match, time.Time, error) {
	tx, err := db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Match{}, time.Time{}, err
	}
	defer tx.Rollback(ctx)
	match, err := loadMatch(ctx, tx, matchID)
	if err != nil {
		return Match{}, time.Time{}, err
	}
	var now time.Time
	if err = tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return Match{}, time.Time{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Match{}, time.Time{}, err
	}
	return match, now.UTC(), nil
}
