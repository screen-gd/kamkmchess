package integration

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

func TestPostgresOnlineTakebackDeadlineUsesTheBankAfterDiscardedIncrements(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-takeback-deadline-bank"
	createOnlineMatch(t, service, matchID, "op-deadline-bank-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-deadline-bank-white", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-deadline-bank-black", online.SeatBlack, 2, "e7e5")); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Execute(ctx, bob, offerTakebackOnlineCommand(matchID, "op-deadline-bank-offer", online.SeatBlack, 3, 1)); err != nil {
		t.Fatal(err)
	}
	offer := pendingOffer(t, service, matchID, online.OfferTakeback)
	accepted, err := service.Execute(ctx, alice, acceptTakebackOnlineCommand(matchID, "op-deadline-bank-accept", online.SeatWhite, 4, offer.OfferID))
	if err != nil {
		t.Fatal(err)
	}
	restored, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Clock.BlackMs != 300_000 || restored.Clock.WhiteMs > 300_000 {
		t.Fatalf("discarded increments remain in the banks: %+v", restored.Clock)
	}
	want := accepted.Receipt.DecidedAt.Add(time.Duration(restored.Clock.WhiteMs) * time.Millisecond)
	if restored.Clock.DeadlineAt == nil || !restored.Clock.DeadlineAt.Equal(want) {
		t.Fatalf("restored deadline = %v, want %v for the remaining bank %d", restored.Clock.DeadlineAt, want, restored.Clock.WhiteMs)
	}
}

func TestPostgresOnlineTakebackCannotEraseTheCurrentTurnsSpentBudget(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-takeback-current-budget"
	createOnlineMatch(t, service, matchID, "op-current-budget-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-current-budget-white", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-current-budget-black", online.SeatBlack, 2, "e7e5")); err != nil {
		t.Fatal(err)
	}
	for index := range 3 {
		if _, err := service.Execute(ctx, alice, recoveryAttemptOnlineCommand(matchID, fmt.Sprintf("op-current-budget-attempt-%d", index), online.SeatWhite, int64(3+index), online.RecoveryIllegalMove)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := service.Execute(ctx, bob, offerTakebackOnlineCommand(matchID, "op-current-budget-offer", online.SeatBlack, 6, 1)); err != nil {
		t.Fatal(err)
	}
	offer := pendingOffer(t, service, matchID, online.OfferTakeback)
	if _, err := service.Execute(ctx, alice, acceptTakebackOnlineCommand(matchID, "op-current-budget-accept", online.SeatWhite, 7, offer.OfferID)); err != nil {
		t.Fatal(err)
	}
	restored, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	seat, _ := restored.Seat(online.SeatWhite)
	if seat.IllegalAttemptsSpent != 3 {
		t.Fatalf("takeback erased the current turn's spent budget: %+v", seat)
	}
	lost, err := service.Execute(ctx, alice, recoveryAttemptOnlineCommand(matchID, "op-current-budget-fourth", online.SeatWhite, 8, online.RecoveryIllegalMove))
	if err != nil {
		t.Fatal(err)
	}
	if lost.Receipt.Result == nil || lost.Receipt.Result.Reason != online.ReasonIllegalMove {
		t.Fatalf("the fourth illegal attempt did not lose: %+v", lost.Receipt.Result)
	}
}
