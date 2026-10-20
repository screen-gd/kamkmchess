package integration

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/rulesworker"
)

// committingEvaluator commits the original request while the retry is between
// its snapshot and its acceptance. This deterministically exercises an
// overlapping lost-ack retry.
//
// The rules evaluation is the only point of the command path that holds no
// transaction and no database lock. The original command is committed from
// there, so the original overlaps the retry exactly as a lost-ack retry
// overlaps the request it retries. The original's own evaluation must not
// commit again, so the commit fires once.
type committingEvaluator struct {
	online.Evaluator
	mu     sync.Mutex
	fired  bool
	commit func()
}

func (e *committingEvaluator) Evaluate(ctx context.Context, input online.RulesInput) (online.Candidate, error) {
	candidate, err := e.Evaluator.Evaluate(ctx, input)
	if err != nil {
		return candidate, err
	}
	e.mu.Lock()
	fire := !e.fired
	e.fired = true
	e.mu.Unlock()
	if fire {
		e.commit()
	}
	return candidate, nil
}

type winningMoveEvaluator struct{ moveEvaluator }

func (e winningMoveEvaluator) Evaluate(ctx context.Context, input online.RulesInput) (online.Candidate, error) {
	candidate, err := e.moveEvaluator.Evaluate(ctx, input)
	if err == nil {
		candidate.Result = &online.Result{Kind: online.ResultWin, Winner: seatPointer(candidate.Move.Seat), Reason: online.ReasonCheckmate}
	}
	return candidate, err
}

func TestPostgresOnlineInFlightMoveRetryReturnsOriginalReceipt(t *testing.T) {
	for _, tc := range []struct {
		name              string
		terminal, changed bool
	}{
		{name: "active match"},
		{name: "terminal match", terminal: true},
		{name: "changed payload", changed: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			var base online.Evaluator = moveEvaluator{}
			if tc.terminal {
				base = winningMoveEvaluator{}
			}
			var (
				service  *online.Service
				original online.CommandResult
			)
			const matchID = "match-receipt-race"
			move := moveOnlineCommand(matchID, "op-receipt-move", online.SeatWhite, 1, "e2e4")
			evaluator := &committingEvaluator{Evaluator: base, commit: func() {
				var err error
				original, err = service.Execute(ctx, alice, move)
				if err != nil {
					t.Fatalf("original move: %v", err)
				}
			}}
			service, _ = onlineService(t, evaluator)
			createOnlineMatch(t, service, matchID, "op-receipt-create")
			retry := move
			if tc.changed {
				retry.Action.SubmitMove = &online.SubmitMoveAction{UCI: "d2d4"}
			}
			result, err := service.Execute(ctx, alice, retry)
			if tc.changed {
				if !errors.Is(err, online.ErrOperationReuse) {
					t.Fatalf("changed payload after original commit: %v, want ErrOperationReuse", err)
				}
			} else if err != nil || !result.Duplicate || !bytes.Equal(original.Raw, result.Raw) {
				t.Fatalf("identical retry must return original receipt: duplicate=%v, error=%v", result.Duplicate, err)
			}
			match, err := service.GetMatch(ctx, matchID)
			if err != nil || match.Version != 2 || len(match.Moves) != 1 || match.Clock.TurnNumber != 1 {
				t.Fatalf("retry advanced accepted state: %+v, %v", match, err)
			}
		})
	}
}

func TestPostgresOnlineSetupRejectsInvalidAndTerminalPositions(t *testing.T) {
	entry := os.Getenv("KHA66_WORKER_ENTRY")
	if entry == "" {
		t.Skip("set KHA66_WORKER_ENTRY to the built private worker")
	}
	client, err := rulesworker.New(rulesworker.Config{Entry: entry, RequestTimeout: 3 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	evaluator, err := rulesworker.NewOnlineEvaluator(client)
	if err != nil {
		t.Fatal(err)
	}
	service, pool := onlineService(t, evaluator)
	for index, tc := range []struct {
		name, fen string
		want      error
	}{
		{"invalid board", "garbage w - - 0 1", online.ErrInvalidContract},
		{"invalid counter", "4k3/8/8/8/8/8/8/R3K3 w - - 0 0", online.ErrInvalidContract},
		{"checkmate", "7k/6Q1/6K1/8/8/8/8/8 b - - 0 1", online.ErrActionNotAllowed},
		{"stalemate", "7k/5Q2/8/8/8/8/8/6K1 b - - 0 1", online.ErrActionNotAllowed},
		{"insufficient material", "8/8/8/8/8/8/8/K6k w - - 0 1", online.ErrActionNotAllowed},
		{"halfmove draw", "4k3/8/8/8/8/8/8/R3K3 w - - 100 60", online.ErrActionNotAllowed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			create := createOnlineCommand(fmt.Sprintf("match-setup-%d", index), "op-setup-create")
			create.Action.CreateMatch.StartingFEN = tc.fen
			if _, err := service.Execute(ctx, alice, create); !errors.Is(err, tc.want) {
				t.Fatalf("setup error = %v, want %v", err, tc.want)
			}
			if _, err := service.GetMatch(ctx, create.MatchID); !errors.Is(err, online.ErrNotFound) {
				t.Fatalf("rejected setup left a match: %v", err)
			}
			for _, table := range []string{"online_seats", "online_clocks", "online_events", "online_public_projections"} {
				var count int
				if err := pool.QueryRow(ctx, "SELECT count(*) FROM "+table+" WHERE match_id=$1", create.MatchID).Scan(&count); err != nil || count != 0 {
					t.Fatalf("rejected setup left %s records: count=%d, error=%v", table, count, err)
				}
			}
			if _, err := service.GetReceipt(ctx, create.MatchID, create.OperationID); !errors.Is(err, online.ErrNotFound) {
				t.Fatalf("rejected setup left a receipt: %v", err)
			}
		})
	}
}

func TestPostgresOnlineReplayRemovalOperationIDsAreMatchScoped(t *testing.T) {
	ctx := context.Background()
	service, pool := onlineService(t, moveEvaluator{})
	for index := 1; index <= 2; index++ {
		matchID := fmt.Sprintf("match-removal-%d", index)
		createOnlineMatch(t, service, matchID, "op-removal-create")
		if _, err := service.Execute(ctx, alice, resignOnlineCommand(matchID, "op-removal-resign", online.SeatWhite, 1)); err != nil {
			t.Fatal(err)
		}
		command := removeReplayCommand(matchID, "op-removal-shared", online.SeatWhite, 2)
		accepted, err := service.Execute(ctx, alice, command)
		if err != nil {
			t.Fatalf("remove match %d with the same scoped operation ID: %v", index, err)
		}
		if _, err := service.GetPublicProjection(ctx, matchID); !errors.Is(err, online.ErrNotFound) {
			t.Fatalf("removed replay remains public: %v", err)
		}
		retry, err := service.Execute(ctx, alice, command)
		if err != nil || !retry.Duplicate || !bytes.Equal(accepted.Raw, retry.Raw) {
			t.Fatalf("removal retry changed receipt: %v", err)
		}
	}
	var recorded int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM online_public_projections p JOIN online_deletion_markers m ON p.revocation_marker_id=m.marker_id AND p.match_id=m.match_id WHERE p.revoked_at IS NOT NULL`).Scan(&recorded); err != nil || recorded != 2 {
		t.Fatalf("both removals need their own durable marker: count=%d, error=%v", recorded, err)
	}
}

func TestPostgresOnlineAcceptedSetupRetrySurvivesUnavailableWorker(t *testing.T) {
	entry := os.Getenv("KHA66_WORKER_ENTRY")
	if entry == "" {
		t.Skip("set KHA66_WORKER_ENTRY to the built private worker")
	}
	client, err := rulesworker.New(rulesworker.Config{Entry: entry, RequestTimeout: 3 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	evaluator, err := rulesworker.NewOnlineEvaluator(client)
	if err != nil {
		t.Fatal(err)
	}
	service, _ := onlineService(t, evaluator)
	ctx := context.Background()
	create := createOnlineCommand("match-setup-retry", "op-setup-retry")
	accepted, err := service.Execute(ctx, alice, create)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	retry, err := service.Execute(ctx, alice, create)
	if err != nil || !retry.Duplicate || !bytes.Equal(accepted.Raw, retry.Raw) {
		t.Fatalf("accepted setup retry requires unavailable rules process: duplicate=%v, error=%v", retry.Duplicate, err)
	}
}

func TestPostgresOnlineTerminalClockChargesElapsedTime(t *testing.T) {
	for _, action := range []string{"resign", "cancel", "timeout"} {
		t.Run(action, func(t *testing.T) {
			ctx := context.Background()
			service, pool := onlineService(t, timeoutEvaluator{winnerFor: timeoutWinForOpponent})
			const matchID = "match-terminal-clock"
			createOnlineMatch(t, service, matchID, "op-terminal-create")
			// The opening exchange closes the reply window, so the side to
			// move now runs a main clock.
			playOpeningExchange(t, service, matchID, "op-terminal")
			elapsed := 10 * time.Second
			if action == "timeout" {
				elapsed = 6 * time.Minute
			}
			if _, err := pool.Exec(ctx, `UPDATE online_clocks SET active_since=active_since-$1::interval,deadline_at=deadline_at-$1::interval WHERE match_id=$2`, fmt.Sprintf("%d seconds", int(elapsed.Seconds())), matchID); err != nil {
				t.Fatal(err)
			}
			before, err := service.GetMatch(ctx, matchID)
			if err != nil {
				t.Fatal(err)
			}
			if before.Clock.ActiveSeat == nil || *before.Clock.ActiveSeat != online.SeatWhite {
				t.Fatalf("the opening reply did not start White's main clock: %+v", before.Clock)
			}
			command := resignOnlineCommand(matchID, "op-terminal-result", online.SeatBlack, 3)
			if action == "cancel" {
				command = cancelOnlineCommand(matchID, "op-terminal-result", online.SeatBlack, 3)
			}
			accepted, err := service.Execute(ctx, bob, command)
			if err != nil {
				t.Fatal(err)
			}
			want := max(int64(0), before.Clock.WhiteMs-accepted.Receipt.DecidedAt.Sub(*before.Clock.ActiveSince).Milliseconds())
			after, err := service.GetMatch(ctx, matchID)
			if err != nil || after.Clock.WhiteMs != want || after.Clock.BlackMs != before.Clock.BlackMs {
				t.Fatalf("final banks = %+v, want White=%d and Black=%d: %v", after.Clock, want, before.Clock.BlackMs, err)
			}
			if after.Clock.ActiveSeat != nil || after.Clock.ActiveSince != nil || after.Clock.DeadlineAt != nil {
				t.Fatalf("terminal clock is still running: %+v", after.Clock)
			}
			retry, err := service.Execute(ctx, bob, command)
			if err != nil || !retry.Duplicate || !bytes.Equal(accepted.Raw, retry.Raw) {
				t.Fatalf("terminal retry changed receipt: %v", err)
			}
			again, err := service.GetMatch(ctx, matchID)
			if err != nil || again.Clock.WhiteMs != want {
				t.Fatalf("retry charged elapsed time again: %+v, %v", again.Clock, err)
			}
		})
	}
}
