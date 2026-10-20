package integration

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/rulesworker"
)

// ARC-01/02/04: exercise the actual pinned Node process and PostgreSQL writer
// together, including the public result and retry after a lost acknowledgement.
func TestPostgresOnlineWorkerCheckmateAwardsTheMatingSide(t *testing.T) {
	entry := os.Getenv("KHA66_WORKER_ENTRY")
	if entry == "" {
		t.Skip("set KHA66_WORKER_ENTRY to the built private worker")
	}
	client, err := rulesworker.New(rulesworker.Config{Entry: entry, RequestTimeout: 3 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	evaluator, err := rulesworker.NewOnlineEvaluator(client)
	if err != nil {
		t.Fatal(err)
	}
	service, _ := onlineService(t, evaluator)
	ctx := context.Background()
	create := createOnlineCommand("worker-mate-game", "worker-create-op")
	create.Action.CreateMatch.StartingFEN = "6k1/8/5K1Q/8/8/8/8/8 w - - 0 1"
	if _, err = service.Execute(ctx, alice, create); err != nil {
		t.Fatal(err)
	}
	move := moveOnlineCommand(create.MatchID, "worker-mating-op", online.SeatWhite, 1, "h6g7")
	accepted, err := service.Execute(ctx, alice, move)
	if err != nil {
		t.Fatal(err)
	}
	result := accepted.Receipt.Result
	if result == nil || result.Reason != online.ReasonCheckmate || result.Winner == nil || *result.Winner != online.SeatWhite {
		t.Fatalf("White played Qg7#: result = %+v, want a White checkmate win", result)
	}
	projection, err := service.GetPublicProjection(ctx, create.MatchID)
	if err != nil {
		t.Fatal(err)
	}
	if projection.Result.Winner == nil || *projection.Result.Winner != online.SeatWhite || len(projection.Moves) != 1 || projection.Moves[0].SAN != "Qg7#" {
		t.Fatalf("public replay did not retain White's mating move: %+v", projection)
	}
	retried, err := service.Execute(ctx, alice, move)
	if err != nil || !bytes.Equal(accepted.Raw, retried.Raw) {
		t.Fatalf("lost acknowledgement retry changed the accepted receipt: %v", err)
	}
	match, err := service.GetMatch(ctx, create.MatchID)
	if err != nil || match.Version != 2 || len(match.Moves) != 1 {
		t.Fatalf("retry changed terminal match: %+v, %v", match, err)
	}
}

func TestPostgresOnlineWorkerFailureLeavesMatchUnchanged(t *testing.T) {
	for name, script := range map[string]string{
		"crash":     "process.exit(13);",
		"timeout":   "setInterval(() => {}, 1000);",
		"malformed": "process.stdout.write('not-json\\n'); setInterval(() => {}, 1000);",
	} {
		t.Run(name, func(t *testing.T) {
			entry := filepath.Join(t.TempDir(), "failed-worker.mjs")
			if err := os.WriteFile(entry, []byte(script), 0600); err != nil {
				t.Fatal(err)
			}
			client, err := rulesworker.New(rulesworker.Config{Entry: entry, RequestTimeout: 200 * time.Millisecond})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = client.Close() })
			evaluator, err := rulesworker.NewOnlineEvaluator(client)
			if err != nil {
				t.Fatal(err)
			}
			// Accept the starting position before installing the failed process.
			// This test targets failure during a move, not setup validation.
			setupService, pool := onlineService(t, moveEvaluator{})
			ctx := context.Background()
			createOnlineMatch(t, setupService, "worker-failure-game", "worker-create-op")
			service, err := online.Open(ctx, pool, evaluator)
			if err != nil {
				t.Fatal(err)
			}
			failedSetup := createOnlineCommand("worker-failed-setup", "worker-setup-op")
			if _, err = service.Execute(ctx, alice, failedSetup); !errors.Is(err, online.ErrUnavailable) {
				t.Fatalf("failed worker must refuse setup, got %v", err)
			}
			if _, err = service.GetMatch(ctx, failedSetup.MatchID); !errors.Is(err, online.ErrNotFound) {
				t.Fatalf("failed setup persisted a match: %v", err)
			}
			if _, err = service.GetReceipt(ctx, failedSetup.MatchID, failedSetup.OperationID); !errors.Is(err, online.ErrNotFound) {
				t.Fatalf("failed setup persisted a receipt: %v", err)
			}
			move := moveOnlineCommand("worker-failure-game", "worker-failed-op", online.SeatWhite, 1, "e2e4")
			if _, err = service.Execute(ctx, alice, move); !errors.Is(err, online.ErrUnavailable) {
				t.Fatalf("failed worker must refuse the move, got %v", err)
			}
			match, err := service.GetMatch(ctx, move.MatchID)
			if err != nil || match.Version != 1 || len(match.Moves) != 0 || match.Result != nil {
				t.Fatalf("worker failure changed canonical state: %+v, %v", match, err)
			}
			if _, err = service.GetReceipt(ctx, move.MatchID, move.OperationID); !errors.Is(err, online.ErrNotFound) {
				t.Fatalf("worker failure wrote an accepted operation receipt: %v", err)
			}
		})
	}
}

func TestPostgresOnlineWorkerTimeoutUsesMatingMaterial(t *testing.T) {
	entry := os.Getenv("KHA66_WORKER_ENTRY")
	if entry == "" {
		t.Skip("set KHA66_WORKER_ENTRY to the built private worker")
	}
	for _, tc := range []struct {
		name, fen, whiteMove, blackMove, whiteSecondMove, blackLateMove string
		kind                                                            online.ResultKind
	}{
		{"mating material wins", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "e2e4", "e7e5", "g1f3", "g8f6", online.ResultWin},
		{"bare king draws", "7k/7p/8/8/8/8/8/K7 w - - 0 1", "a1a2", "h7h6", "a2a3", "h6h5", online.ResultDraw},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client, err := rulesworker.New(rulesworker.Config{Entry: entry, RequestTimeout: 3 * time.Second})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = client.Close() })
			evaluator, err := rulesworker.NewOnlineEvaluator(client)
			if err != nil {
				t.Fatal(err)
			}
			service, pool := onlineService(t, evaluator)
			ctx := context.Background()
			create := createOnlineCommand("worker-timeout-game", "worker-create-op")
			create.Action.CreateMatch.StartingFEN = tc.fen
			create.Action.CreateMatch.TimeControl = online.TimeControl{StartingTimeMs: 60_000}
			if _, err := service.Execute(ctx, alice, create); err != nil {
				t.Fatal(err)
			}
			// The opening exchange closes the reply window, so the side to
			// move then runs a main clock.
			if _, err := service.Execute(ctx, alice, moveOnlineCommand(create.MatchID, "worker-white-op", online.SeatWhite, 1, tc.whiteMove)); err != nil {
				t.Fatal(err)
			}
			if _, err := service.Execute(ctx, bob, moveOnlineCommand(create.MatchID, "worker-black-op", online.SeatBlack, 2, tc.blackMove)); err != nil {
				t.Fatal(err)
			}
			if _, err := service.Execute(ctx, alice, moveOnlineCommand(create.MatchID, "worker-white-second-op", online.SeatWhite, 3, tc.whiteSecondMove)); err != nil {
				t.Fatal(err)
			}
			// Black's main clock expires before Black's next intent.
			expireMainClock(t, pool, create.MatchID)
			result, err := service.Execute(ctx, bob, moveOnlineCommand(create.MatchID, "worker-black-late-op", online.SeatBlack, 4, tc.blackLateMove))
			if err != nil {
				t.Fatalf("reconcile expired Black clock using pinned rules: %v", err)
			}
			if result.Receipt.Outcome != online.OutcomeDeadlineExpired || result.Receipt.Result == nil || result.Receipt.Result.Kind != tc.kind {
				t.Fatalf("timeout outcome = %+v, want %s", result.Receipt, tc.kind)
			}
			if tc.kind == online.ResultWin && (result.Receipt.Result.Winner == nil || *result.Receipt.Result.Winner != online.SeatWhite) {
				t.Fatalf("Black flagged with White mating material: %+v", result.Receipt.Result)
			}
			match, err := service.GetMatch(ctx, create.MatchID)
			if err != nil || len(match.Moves) != 3 || match.Status != online.MatchCompleted {
				t.Fatalf("late move was accepted after flag fall: %+v, %v", match, err)
			}
		})
	}
}
