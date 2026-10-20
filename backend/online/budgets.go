package online

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// TurnBudget is the recovery budget one seat spent in one turn.
//
// The budget belongs to the turn, not to the seat row alone: a turn is
// identified by the accepted-move prefix it starts from, so the budget
// survives the move that ended the turn and a takeback that restores it.
type TurnBudget struct {
	IllegalAttemptsSpent   int
	FormatCorrectionsSpent int
}

// turnPrefixKey hashes the accepted-move prefix that defines a turn.
//
// The prefix is the identity of the turn. Two lines that share a prefix end
// in the same turn and share its budget, and a line that replaced it has a
// different prefix and therefore its own budget.
func turnPrefixKey(moves []Move) string {
	digest := sha256.New()
	for _, move := range moves {
		_, _ = fmt.Fprintf(digest, "%d\x00%s\x00%s\x00%s\x00", move.Version, move.Seat, move.UCI, move.ResultingFEN)
	}
	return hex.EncodeToString(digest.Sum(nil))
}

// recordTurnBudget stores what a seat spent in the turn it is in. The journal
// is written on every spent attempt, so the allowance of a turn is known even
// after that turn's accepted move reset the seat counters.
func recordTurnBudget(ctx context.Context, tx pgx.Tx, matchID string, seat Seat, turnNumber int64, prefixKey string, budget TurnBudget, at time.Time) error {
	_, err := tx.Exec(ctx, `INSERT INTO online_turn_budgets(match_id,seat,turn_number,prefix_hash,illegal_attempts_spent,format_corrections_spent,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (match_id,seat,prefix_hash) DO UPDATE SET turn_number=EXCLUDED.turn_number,illegal_attempts_spent=EXCLUDED.illegal_attempts_spent,format_corrections_spent=EXCLUDED.format_corrections_spent,updated_at=EXCLUDED.updated_at`,
		matchID, string(seat), turnNumber, prefixKey, budget.IllegalAttemptsSpent, budget.FormatCorrectionsSpent, at.UTC())
	return err
}

// loadTurnBudgets reads what every seat spent in the turn the prefix defines.
// A seat that never spent an attempt has no journal entry, so its budget is
// zero.
func loadTurnBudgets(ctx context.Context, q queryer, matchID, prefixKey string) (map[Seat]TurnBudget, error) {
	rows, err := q.Query(ctx, `SELECT seat,illegal_attempts_spent,format_corrections_spent FROM online_turn_budgets WHERE match_id=$1 AND prefix_hash=$2`, matchID, prefixKey)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[Seat]TurnBudget, 2)
	for rows.Next() {
		var seat string
		var budget TurnBudget
		if err = rows.Scan(&seat, &budget.IllegalAttemptsSpent, &budget.FormatCorrectionsSpent); err != nil {
			return nil, err
		}
		out[Seat(seat)] = budget
	}
	return out, rows.Err()
}

// restoreTurnBudgets writes the spent budget of the restored turn back to the
// seat rows.
//
// A takeback restores a turn that was already paid for, so it must not hand a
// seat a fresh attempt allowance. The restored turn is the one the restored
// prefix starts, and the journal holds what that turn had already spent.
// Attempts spent in the current turn also survive: rewinding to an earlier
// turn with a smaller journal entry must not replenish that allowance.
func restoreTurnBudgets(ctx context.Context, tx pgx.Tx, match Match, prefixKey string, at time.Time) error {
	budgets, err := loadTurnBudgets(ctx, tx, match.MatchID, prefixKey)
	if err != nil {
		return err
	}
	for index := range match.Seats {
		seat := &match.Seats[index]
		budget := budgets[seat.Seat]
		budget.IllegalAttemptsSpent = max(budget.IllegalAttemptsSpent, seat.IllegalAttemptsSpent)
		budget.FormatCorrectionsSpent = max(budget.FormatCorrectionsSpent, seat.FormatCorrectionsSpent)
		seat.IllegalAttemptsSpent = budget.IllegalAttemptsSpent
		seat.FormatCorrectionsSpent = budget.FormatCorrectionsSpent
		if _, err = tx.Exec(ctx, `UPDATE online_seats SET illegal_attempts_spent=$1,format_corrections_spent=$2,updated_at=$3 WHERE match_id=$4 AND seat=$5`,
			seat.IllegalAttemptsSpent, seat.FormatCorrectionsSpent, at.UTC(), match.MatchID, string(seat.Seat)); err != nil {
			return err
		}
		if err = recordTurnBudget(ctx, tx, match.MatchID, seat.Seat, int64(len(match.Moves)), prefixKey, budget, at); err != nil {
			return err
		}
	}
	return nil
}
