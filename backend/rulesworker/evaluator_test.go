package rulesworker

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

func onlineInput() online.RulesInput {
	input := online.RulesInput{
		SchemaVersion:      online.RulesInputSchemaVersion,
		RulesPolicyVersion: RulesPolicyVersion,
		MatchID:            "match-1234",
		Version:            1,
		ControlEpoch:       1,
		StartingFEN:        initialFEN,
		PositionFEN:        initialFEN,
		ProposedMove:       "e2e4",
		TimeControl:        online.TimeControl{StartingTimeMs: 300000, IncrementMs: 2000},
		Moves:              []online.Move{},
	}
	input.InputHash = online.RulesInputHash(input)
	return input
}

func TestOnlineEvaluatorMapsWorkerCandidate(t *testing.T) {
	client := testClient(t, time.Second)
	evaluator, err := NewOnlineEvaluator(client)
	if err != nil {
		t.Fatalf("new evaluator: %v", err)
	}

	candidate, err := evaluator.Evaluate(context.Background(), onlineInput())
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if err := candidate.Validate(); err != nil {
		t.Fatalf("candidate does not validate: %v", err)
	}
	if candidate.EvaluatedVersion != 1 || candidate.ControlEpoch != 1 {
		t.Fatalf("candidate fencing = %+v", candidate)
	}
	if candidate.EvaluatedInputHash != onlineInput().InputHash {
		t.Fatalf("candidate hash = %q", candidate.EvaluatedInputHash)
	}
	if candidate.Move == nil || candidate.Move.Seat != online.SeatWhite || candidate.Move.UCI != "e2e4" {
		t.Fatalf("candidate move = %+v", candidate.Move)
	}
	if candidate.Move.SAN != "e4" || candidate.Move.ResultingFEN == "" {
		t.Fatalf("candidate details = %+v", candidate.Move)
	}
	if candidate.Result != nil {
		t.Fatalf("non-terminal candidate carried a result: %+v", candidate.Result)
	}
}

func TestOnlineEvaluatorRejectsInconsistentInputWithoutStartingTheWorker(t *testing.T) {
	client := testClient(t, time.Second)
	// Closing the client proves invalid input is rejected before any exchange.
	if err := client.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	evaluator, err := NewOnlineEvaluator(client)
	if err != nil {
		t.Fatalf("new evaluator: %v", err)
	}

	withMove := func(mutate func(*online.RulesInput)) online.RulesInput {
		input := onlineInput()
		input.Moves = []online.Move{{
			Version:      2,
			Seat:         online.SeatWhite,
			UCI:          "e2e4",
			SAN:          "e4",
			ResultingFEN: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
		}}
		input.PositionFEN = input.Moves[0].ResultingFEN
		input.Version = 2
		input.ProposedMove = "e7e5"
		input.ActiveSeat = seatPtr(online.SeatBlack)
		input.InputHash = online.RulesInputHash(input)
		mutate(&input)
		return input
	}

	otherFEN := "4k3/8/8/8/8/8/8/4K3 w - - 0 1"
	cases := map[string]online.RulesInput{
		"schema version": func() online.RulesInput {
			input := onlineInput()
			input.SchemaVersion = 2
			input.InputHash = online.RulesInputHash(input)
			return input
		}(),
		"rules policy": func() online.RulesInput {
			input := onlineInput()
			input.RulesPolicyVersion = "older-policy"
			input.InputHash = online.RulesInputHash(input)
			return input
		}(),
		"tampered hash": func() online.RulesInput {
			input := onlineInput()
			input.InputHash = strings.Repeat("a", 64)
			return input
		}(),
		"empty proposal": func() online.RulesInput {
			input := onlineInput()
			input.ProposedMove = ""
			input.InputHash = online.RulesInputHash(input)
			return input
		}(),
		"bad proposal": func() online.RulesInput {
			input := onlineInput()
			input.ProposedMove = "e2e9"
			input.InputHash = online.RulesInputHash(input)
			return input
		}(),
		"active seat": withMove(func(input *online.RulesInput) {
			input.ActiveSeat = seatPtr(online.SeatWhite)
			input.InputHash = online.RulesInputHash(*input)
		}),
		"position not last": withMove(func(input *online.RulesInput) {
			input.PositionFEN = otherFEN
			input.InputHash = online.RulesInputHash(*input)
		}),
		"out of order moves": func() online.RulesInput {
			input := inputWithTwoMoves()
			input.Moves[1].Version = input.Moves[0].Version
			input.InputHash = online.RulesInputHash(input)
			return input
		}(),
	}

	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			candidate, err := evaluator.Evaluate(context.Background(), input)
			if !errors.Is(err, ErrInvalidRulesInput) {
				t.Fatalf("error = %v, want ErrInvalidRulesInput", err)
			}
			if candidate.Move != nil || candidate.Result != nil {
				t.Fatalf("invalid input returned a candidate: %+v", candidate)
			}
		})
	}
}

func inputWithTwoMoves() online.RulesInput {
	first := "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"
	second := "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2"
	input := onlineInput()
	input.Moves = []online.Move{
		{Version: 2, Seat: online.SeatWhite, UCI: "e2e4", SAN: "e4", ResultingFEN: first},
		{Version: 3, Seat: online.SeatBlack, UCI: "e7e5", SAN: "e5", ResultingFEN: second},
	}
	input.PositionFEN = second
	input.Version = 3
	input.ProposedMove = "g1f3"
	input.ActiveSeat = seatPtr(online.SeatWhite)
	input.InputHash = online.RulesInputHash(input)
	return input
}

func TestResultForMapsPolicyEndings(t *testing.T) {
	cases := map[string]struct {
		kind   online.ResultKind
		winner *online.Seat
		reason online.ResultReason
	}{
		"checkmate":             {kind: online.ResultWin, winner: seatPtr(online.SeatWhite), reason: online.ReasonCheckmate},
		"stalemate":             {kind: online.ResultDraw, reason: online.ReasonStalemate},
		"insufficient-material": {kind: online.ResultDraw, reason: online.ReasonInsufficientMaterial},
		"threefold-repetition":  {kind: online.ResultDraw, reason: online.ReasonRepetition},
		"hundred-halfmoves":     {kind: online.ResultDraw, reason: online.ReasonFiftyMove},
	}
	for ending, want := range cases {
		t.Run(ending, func(t *testing.T) {
			result := resultFor(ending, online.SeatWhite)
			if result == nil {
				t.Fatalf("%s produced no result", ending)
			}
			if err := result.Validate(); err != nil {
				t.Fatalf("%s does not validate: %v", ending, err)
			}
			if result.Kind != want.kind || result.Reason != want.reason {
				t.Fatalf("result = %+v", result)
			}
			if want.winner == nil {
				if result.Winner != nil {
					t.Fatalf("draw named a winner: %+v", result)
				}
			} else if result.Winner == nil || *result.Winner != *want.winner {
				t.Fatalf("winner = %+v, want %v", result.Winner, *want.winner)
			}
		})
	}
	if resultFor("none", online.SeatWhite) != nil {
		t.Fatal("non-terminal ending produced a result")
	}
}

// TestOnlineEvaluatorWithBuiltWorker runs the adapter against the pinned bundle
// when KHA66_WORKER_ENTRY points at build/rules-worker/worker.mjs.
func TestOnlineEvaluatorWithBuiltWorker(t *testing.T) {
	entry := os.Getenv("KHA66_WORKER_ENTRY")
	if entry == "" {
		t.Skip("set KHA66_WORKER_ENTRY to a built build/rules-worker/worker.mjs")
	}
	client, err := New(Config{Entry: entry, RequestTimeout: 3 * time.Second})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	defer client.Close()
	evaluator, err := NewOnlineEvaluator(client)
	if err != nil {
		t.Fatalf("new evaluator: %v", err)
	}

	// Kxb2 removes the last black piece, so the worker must report a dead
	// position and Go must map it to a draw rather than a win.
	const bareCapture = "7k/8/8/8/8/8/1n6/K6N w - - 0 1"
	input := onlineInput()
	input.StartingFEN = bareCapture
	input.PositionFEN = bareCapture
	input.ProposedMove = "a1b2"
	input.InputHash = online.RulesInputHash(input)

	candidate, err := evaluator.Evaluate(context.Background(), input)
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if candidate.Move == nil || candidate.Move.SAN != "Kxb2" {
		t.Fatalf("candidate move = %+v", candidate.Move)
	}
	if candidate.Result == nil || candidate.Result.Kind != online.ResultDraw ||
		candidate.Result.Reason != online.ReasonInsufficientMaterial || candidate.Result.Winner != nil {
		t.Fatalf("result = %+v", candidate.Result)
	}
}

// A refused proposal stays a participant error, and an internal history
// disagreement is reported as an unavailable rules service instead of a
// conflict the participant can fix.
func TestTranslateRejectionSeparatesRefusalsFromInternalDisagreement(t *testing.T) {
	refused := map[string]error{
		"illegal-move":      online.ErrActionNotAllowed,
		"position-terminal": online.ErrActionNotAllowed,
		"invalid-fen":       online.ErrInvalidContract,
	}
	for code, want := range refused {
		err := translateRejection(&RejectionError{Code: code, Message: "refused"})
		if !errors.Is(err, want) {
			t.Errorf("%s error = %v, want %v", code, err, want)
		}
	}
	for _, code := range []string{"invalid-history", "history-mismatch"} {
		err := translateRejection(&RejectionError{Code: code, Message: "history"})
		if !errors.Is(err, online.ErrUnavailable) {
			t.Errorf("%s error = %v, want ErrUnavailable", code, err)
		}
		if errors.Is(err, online.ErrActionNotAllowed) || errors.Is(err, online.ErrStaleCandidate) || errors.Is(err, online.ErrConflict) {
			t.Errorf("%s error = %v, want an unavailable service instead of a participant error", code, err)
		}
	}
	other := translateRejection(&RejectionError{Code: "unknown-code", Message: "unknown"})
	var rejected *RejectionError
	if !errors.As(other, &rejected) {
		t.Errorf("an unknown refusal code = %v, want the rejection unchanged", other)
	}
}

func seatPtr(seat online.Seat) *online.Seat {
	return &seat
}
