package integration

import (
	"context"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

func TestPostgresOnlineDecisionTimeNeverPrecedesAcceptedState(t *testing.T) {
	service, pool := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	createOnlineMatch(t, service, "clock-step-game", "clock-create-op")
	// Simulate the database wall clock stepping backwards after an accepted
	// event by placing its last accepted timestamp ahead of the current sample.
	var previous time.Time
	if err := pool.QueryRow(ctx, `UPDATE online_matches SET version=2,updated_at=clock_timestamp()+interval '1 second' WHERE match_id='clock-step-game' RETURNING updated_at`).Scan(&previous); err != nil {
		t.Fatal(err)
	}
	result, err := service.Execute(ctx, alice, resignOnlineCommand("clock-step-game", "clock-resign-op", online.SeatWhite, 2))
	if err != nil {
		t.Fatal(err)
	}
	if result.Receipt.DecidedAt.Before(previous) {
		t.Fatalf("decision %s precedes the last accepted state at %s", result.Receipt.DecidedAt, previous)
	}
}
