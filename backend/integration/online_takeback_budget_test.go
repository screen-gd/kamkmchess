package integration

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// KHA-68 correction: a takeback restores the recovery budget of the turn it
// restores. The budget belongs to a turn, so the allowance a turn had already
// spent survives the move that ended the turn and the takeback that restores
// it.

// A takeback restores the recovery budget of the turn it restores. The
// fourth illegal attempt of that turn still loses the match.
func TestPostgresOnlineTakebackRestoresTheSpentRecoveryBudget(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-takeback-budget"
	createOnlineMatch(t, service, matchID, "op-budget-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-budget-white-1", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-budget-black-1", online.SeatBlack, 2, "e7e5")); err != nil {
		t.Fatalf("opening reply: %v", err)
	}
	// White spends three attempts of its turn.
	for index := 0; index < 3; index++ {
		if _, err := service.Execute(ctx, alice, recoveryAttemptOnlineCommand(matchID, "op-budget-attempt-"+string(rune('a'+index)), online.SeatWhite, int64(3+index), online.RecoveryIllegalMove)); err != nil {
			t.Fatalf("illegal attempt %d: %v", index, err)
		}
	}
	spent, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	seat, _ := spent.Seat(online.SeatWhite)
	if seat.IllegalAttemptsSpent != 3 {
		t.Fatalf("the spent budget = %+v", seat)
	}
	// The accepted move of that seat starts the budget again.
	if _, err = service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-budget-white-2", online.SeatWhite, 6, "g1f3")); err != nil {
		t.Fatalf("accepted move: %v", err)
	}
	afterMove, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	seat, _ = afterMove.Seat(online.SeatWhite)
	if seat.IllegalAttemptsSpent != 0 {
		t.Fatalf("the accepted move did not start the budget again: %+v", seat)
	}
	if _, err = service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-budget-black-2", online.SeatBlack, 7, "b8c6")); err != nil {
		t.Fatalf("black second move: %v", err)
	}
	// The takeback restores the turn White spent the attempts in.
	if _, err = service.Execute(ctx, bob, offerTakebackOnlineCommand(matchID, "op-budget-offer", online.SeatBlack, 8, 3)); err != nil {
		t.Fatalf("takeback offer: %v", err)
	}
	offer := pendingOffer(t, service, matchID, online.OfferTakeback)
	if _, err = service.Execute(ctx, alice, acceptTakebackOnlineCommand(matchID, "op-budget-accept", online.SeatWhite, 9, offer.OfferID)); err != nil {
		t.Fatalf("takeback acceptance: %v", err)
	}
	restored, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	seat, _ = restored.Seat(online.SeatWhite)
	if seat.IllegalAttemptsSpent != 3 {
		t.Fatalf("the takeback did not restore the spent budget: %+v", seat)
	}
	// The next illegal attempt is the fourth of that turn, so it loses.
	lost, err := service.Execute(ctx, alice, recoveryAttemptOnlineCommand(matchID, "op-budget-attempt-final", online.SeatWhite, 10, online.RecoveryIllegalMove))
	if err != nil {
		t.Fatalf("the fourth illegal attempt: %v", err)
	}
	if lost.Receipt.Result == nil || lost.Receipt.Result.Kind != online.ResultWin ||
		lost.Receipt.Result.Winner == nil || *lost.Receipt.Result.Winner != online.SeatBlack ||
		lost.Receipt.Result.Reason != online.ReasonIllegalMove {
		t.Fatalf("the fourth illegal attempt = %+v, want a loss", lost.Receipt.Result)
	}
}

// A retried recovery report does not spend the allowance twice.
func TestPostgresOnlineRecoveryAttemptRetryDoesNotSpendTwice(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-recovery-retry"
	createOnlineMatch(t, service, matchID, "op-recovery-retry-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-recovery-retry-white", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-recovery-retry-black", online.SeatBlack, 2, "e7e5")); err != nil {
		t.Fatalf("opening reply: %v", err)
	}
	attempt := recoveryAttemptOnlineCommand(matchID, "op-recovery-retry-attempt", online.SeatWhite, 3, online.RecoveryIllegalMove)
	spent, err := service.Execute(ctx, alice, attempt)
	if err != nil {
		t.Fatalf("recovery attempt: %v", err)
	}
	retry, err := service.Execute(ctx, alice, attempt)
	if err != nil {
		t.Fatalf("recovery attempt retry: %v", err)
	}
	if !retry.Duplicate || !bytes.Equal(spent.Raw, retry.Raw) {
		t.Fatalf("the retried attempt did not return the original receipt: %+v", retry.Receipt)
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	seat, _ := after.Seat(online.SeatWhite)
	if seat.IllegalAttemptsSpent != 1 {
		t.Fatalf("the retried attempt spent the allowance twice: %+v", seat)
	}
	if after.Version != spent.Receipt.Version {
		t.Fatalf("the retried attempt advanced the match: %+v", after)
	}
}

// The automatic formatting allowance of a restored turn is restored too.
func TestPostgresOnlineTakebackRestoresTheFormattingAllowance(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-takeback-format"
	createOnlineMatch(t, service, matchID, "op-format-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-format-white-1", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-format-black-1", online.SeatBlack, 2, "e7e5")); err != nil {
		t.Fatalf("opening reply: %v", err)
	}
	for index := 0; index < 2; index++ {
		if _, err := service.Execute(ctx, alice, recoveryAttemptOnlineCommand(matchID, "op-format-attempt-"+string(rune('a'+index)), online.SeatWhite, int64(3+index), online.RecoveryFormattingCorrection)); err != nil {
			t.Fatalf("formatting correction %d: %v", index, err)
		}
	}
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-format-white-2", online.SeatWhite, 5, "g1f3")); err != nil {
		t.Fatalf("accepted move: %v", err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-format-black-2", online.SeatBlack, 6, "b8c6")); err != nil {
		t.Fatalf("black second move: %v", err)
	}
	if _, err := service.Execute(ctx, bob, offerTakebackOnlineCommand(matchID, "op-format-offer", online.SeatBlack, 7, 3)); err != nil {
		t.Fatalf("takeback offer: %v", err)
	}
	offer := pendingOffer(t, service, matchID, online.OfferTakeback)
	if _, err := service.Execute(ctx, alice, acceptTakebackOnlineCommand(matchID, "op-format-accept", online.SeatWhite, 8, offer.OfferID)); err != nil {
		t.Fatalf("takeback acceptance: %v", err)
	}
	restored, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	seat, _ := restored.Seat(online.SeatWhite)
	if seat.FormatCorrectionsSpent != 2 {
		t.Fatalf("the takeback did not restore the formatting allowance: %+v", seat)
	}
	// The third correction of the restored turn is allowed, the fourth is not.
	if _, err = service.Execute(ctx, alice, recoveryAttemptOnlineCommand(matchID, "op-format-attempt-third", online.SeatWhite, 9, online.RecoveryFormattingCorrection)); err != nil {
		t.Fatalf("the third formatting correction: %v", err)
	}
	if _, err = service.Execute(ctx, alice, recoveryAttemptOnlineCommand(matchID, "op-format-attempt-fourth", online.SeatWhite, 10, online.RecoveryFormattingCorrection)); !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("a correction beyond the restored allowance = %v, want ErrActionNotAllowed", err)
	}
}
