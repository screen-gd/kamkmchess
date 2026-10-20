package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type moveEvaluator struct{}

// Transaction fixtures trust their setup; strict setup conformance is covered
// separately with the actual pinned rules worker.
func (moveEvaluator) ValidateSetup(context.Context, online.RulesInput) error { return nil }

// fakePositionFEN mirrors what a real rules process returns: a valid FEN with
// the opponent of the accepted move to play.
func fakePositionFEN(sideToMove online.Seat) string {
	side := "w"
	if sideToMove == online.SeatBlack {
		side = "b"
	}
	return "8/8/8/8/8/8/8/K6k " + side + " - - 0 1"
}

func (moveEvaluator) Evaluate(_ context.Context, input online.RulesInput) (online.Candidate, error) {
	// The seat to move is read from the evaluated position, so a custom
	// position with Black to move starts with Black.
	seat := online.SeatWhite
	if fields := strings.Fields(input.PositionFEN); len(fields) > 1 && fields[1] == "b" {
		seat = online.SeatBlack
	}
	next, _ := seat.Other()
	return online.Candidate{
		SchemaVersion:      online.RulesInputSchemaVersion,
		EvaluatedVersion:   input.Version,
		EvaluatedInputHash: input.InputHash,
		ControlEpoch:       input.ControlEpoch,
		Move: &online.Move{
			Seat:         seat,
			UCI:          input.ProposedMove,
			SAN:          input.ProposedMove,
			ResultingFEN: fakePositionFEN(next),
		},
	}, nil
}

func seatPointer(seat online.Seat) *online.Seat { return &seat }

func opponentOf(seat online.Seat) online.Seat {
	other, _ := seat.Other()
	return other
}

// timeoutEvaluator applies the same bounded policy shape as the real rules
// process: a flag fall is either an opponent win or an insufficient-material
// draw. observe lets a test inject a concurrent state change between evaluation
// and the authoritative re-lock.
type timeoutEvaluator struct {
	moveEvaluator
	winnerFor func(expired online.Seat) *online.Seat
	observe   func(input online.RulesInput, expired online.Seat)
}

func timeoutWinForOpponent(expired online.Seat) *online.Seat {
	return seatPointer(opponentOf(expired))
}

func timeoutInsufficientMaterial(online.Seat) *online.Seat { return nil }

func (e timeoutEvaluator) EvaluateTimeout(_ context.Context, input online.RulesInput, expired online.Seat) (online.TimeoutFacts, error) {
	if e.observe != nil {
		e.observe(input, expired)
	}
	return online.TimeoutFacts{
		SchemaVersion:      online.RulesInputSchemaVersion,
		EvaluatedVersion:   input.Version,
		EvaluatedInputHash: input.InputHash,
		ControlEpoch:       input.ControlEpoch,
		ExpiredSeat:        expired,
		Winner:             e.winnerFor(expired),
	}, nil
}

func onlineService(t *testing.T, evaluator online.Evaluator) (*online.Service, *pgxpool.Pool) {
	t.Helper()
	pool := testPool(t)
	if err := migrations.Apply(context.Background(), pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	service, err := online.Open(context.Background(), pool, evaluator)
	if err != nil {
		t.Fatal(err)
	}
	return service, pool
}

func createOnlineCommand(matchID, operationID string) online.Command {
	return online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     operationID,
		ExpectedVersion: 0,
		Seat:            online.SeatWhite,
		ControlEpoch:    1,
		Action: online.Action{
			Kind: online.ActionCreateMatch,
			CreateMatch: &online.CreateMatchSetup{
				Variant:     "orthodox",
				StartingFEN: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
				TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000},
				Seats: online.CreateMatchSeats{
					White: online.CreateSeat{
						Participant: online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_a"},
						PublicLabel: "Alice",
						Control:     online.SeatControl{Kind: online.ControlHuman},
					},
					Black: online.CreateSeat{
						Participant: online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_b"},
						PublicLabel: "Bob",
						Control:     online.SeatControl{Kind: online.ControlHuman},
					},
				},
			},
		},
	}
}

func moveOnlineCommand(matchID, operationID string, seat online.Seat, version int64, uci string) online.Command {
	return moveOnlineCommandAt(matchID, operationID, seat, version, 1, uci)
}

func moveOnlineCommandAt(matchID, operationID string, seat online.Seat, version, controlEpoch int64, uci string) online.Command {
	return online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     operationID,
		ExpectedVersion: version,
		Seat:            seat,
		ControlEpoch:    controlEpoch,
		Action:          online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: uci}},
	}
}

// cancelOnlineCommand cancels a match for one seat. The writer aborts the
// match while that seat has never had an accepted move and resigns afterwards.
func cancelOnlineCommand(matchID, operationID string, seat online.Seat, version int64) online.Command {
	return online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     operationID,
		ExpectedVersion: version,
		Seat:            seat,
		ControlEpoch:    1,
		Action:          online.Action{Kind: online.ActionCancel},
	}
}

func offerDrawOnlineCommand(matchID, operationID string, seat online.Seat, version int64) online.Command {
	return online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     operationID,
		ExpectedVersion: version,
		Seat:            seat,
		ControlEpoch:    1,
		Action:          online.Action{Kind: online.ActionOfferDraw},
	}
}

func acceptDrawOnlineCommand(matchID, operationID string, seat online.Seat, version int64, offerID string) online.Command {
	return acceptDrawOnlineCommandAt(matchID, operationID, seat, version, 1, offerID)
}

func acceptDrawOnlineCommandAt(matchID, operationID string, seat online.Seat, version, controlEpoch int64, offerID string) online.Command {
	return online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     operationID,
		ExpectedVersion: version,
		Seat:            seat,
		ControlEpoch:    controlEpoch,
		Action:          online.Action{Kind: online.ActionAcceptDraw, AcceptOffer: &online.AcceptOfferAction{OfferID: offerID}},
	}
}

func offerTakebackOnlineCommand(matchID, operationID string, seat online.Seat, version int64, target int64) online.Command {
	return offerTakebackOnlineCommandAt(matchID, operationID, seat, version, 1, target)
}

func offerTakebackOnlineCommandAt(matchID, operationID string, seat online.Seat, version, controlEpoch, target int64) online.Command {
	return online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     operationID,
		ExpectedVersion: version,
		Seat:            seat,
		ControlEpoch:    controlEpoch,
		Action:          online.Action{Kind: online.ActionOfferTakeback, OfferTakeback: &online.OfferTakebackAction{TargetVersion: target}},
	}
}

func acceptTakebackOnlineCommand(matchID, operationID string, seat online.Seat, version int64, offerID string) online.Command {
	return acceptTakebackOnlineCommandAt(matchID, operationID, seat, version, 1, offerID)
}

func acceptTakebackOnlineCommandAt(matchID, operationID string, seat online.Seat, version, controlEpoch int64, offerID string) online.Command {
	return online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     operationID,
		ExpectedVersion: version,
		Seat:            seat,
		ControlEpoch:    controlEpoch,
		Action:          online.Action{Kind: online.ActionAcceptTakeback, AcceptOffer: &online.AcceptOfferAction{OfferID: offerID}},
	}
}

// pendingOffer returns the pending offer of one kind. A consent names the
// exact offer it accepts, so the fixture reads the identity it was given.
func pendingOffer(t *testing.T, service *online.Service, matchID string, kind online.OfferKind) online.Offer {
	t.Helper()
	match, err := service.GetMatch(context.Background(), matchID)
	if err != nil {
		t.Fatal(err)
	}
	for _, offer := range match.Offers {
		if offer.Kind == kind {
			return offer
		}
	}
	t.Fatalf("match %s has no pending %s offer", matchID, kind)
	return online.Offer{}
}

func recoveryAttemptOnlineCommand(matchID, operationID string, seat online.Seat, version int64, attempt online.RecoveryAttemptKind) online.Command {
	return recoveryAttemptOnlineCommandAt(matchID, operationID, seat, version, 1, attempt)
}

func recoveryAttemptOnlineCommandAt(matchID, operationID string, seat online.Seat, version, controlEpoch int64, attempt online.RecoveryAttemptKind) online.Command {
	return online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     operationID,
		ExpectedVersion: version,
		Seat:            seat,
		ControlEpoch:    controlEpoch,
		Action:          online.Action{Kind: online.ActionRecordRecoveryAttempt, Recovery: &online.RecordRecoveryAttemptAction{Attempt: attempt}},
	}
}

func setControlOnlineCommand(matchID, operationID string, seat online.Seat, version int64, control online.SeatControl) online.Command {
	return online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     operationID,
		ExpectedVersion: version,
		Seat:            seat,
		ControlEpoch:    1,
		Action:          online.Action{Kind: online.ActionSetControl, SetControl: &online.SetControlAction{Control: control}},
	}
}

func resignOnlineCommand(matchID, operationID string, seat online.Seat, version int64) online.Command {
	return online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     operationID,
		ExpectedVersion: version,
		Seat:            seat,
		ControlEpoch:    1,
		Action:          online.Action{Kind: online.ActionResign},
	}
}

func removeReplayCommand(matchID, operationID string, seat online.Seat, version int64) online.Command {
	return online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     operationID,
		ExpectedVersion: version,
		Seat:            seat,
		ControlEpoch:    1,
		Action: online.Action{
			Kind:         online.ActionRemovePublicReplay,
			RemoveReplay: &online.RemovePublicReplayAction{Reason: "owner_request"},
		},
	}
}

var (
	alice = online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_a"}
	bob   = online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_b"}
)

func createOnlineMatch(t *testing.T, service *online.Service, matchID, operationID string) online.CommandResult {
	t.Helper()
	result, err := service.Execute(context.Background(), alice, createOnlineCommand(matchID, operationID))
	if err != nil {
		t.Fatalf("create match %s: %v", matchID, err)
	}
	if result.Receipt.Version != 1 || result.Receipt.Outcome != online.OutcomeAccepted {
		t.Fatalf("create receipt = %+v", result.Receipt)
	}
	return result
}

func TestPostgresOnlineMigrationTablesTriggersAndIsolation(t *testing.T) {
	pool := testPool(t)
	if err := migrations.Apply(context.Background(), pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	ctx := context.Background()
	for _, table := range []string{"online_matches", "online_seats", "online_clocks", "online_moves", "online_events", "online_operation_receipts", "online_queue_entries", "online_runner_leases", "online_public_projections", "online_deletion_markers", "online_session_revocations", "online_guest_seat_credentials", "online_guest_ownership_proofs", "online_offers", "online_discarded_moves", "online_turn_budgets"} {
		var exists bool
		if err := pool.QueryRow(ctx, `SELECT to_regclass($1) IS NOT NULL`, table).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists {
			t.Fatalf("migration did not create %s", table)
		}
	}
	var versions int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM kamkmchess_schema_migrations WHERE version IN (1,2,3,4,5,6)`).Scan(&versions); err != nil {
		t.Fatal(err)
	}
	if versions != 6 {
		t.Fatalf("applied migration versions = %d, want 1, 2, 3, 4, 5 and 6", versions)
	}
	var triggers int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname=current_schema() AND t.tgname IN ('online_moves_immutable','online_events_immutable','online_receipts_immutable','online_matches_guard','online_matches_immutable_delete','online_seats_guard','online_projections_guard')`).Scan(&triggers); err != nil {
		t.Fatal(err)
	}
	if triggers != 7 {
		t.Fatalf("online guard triggers = %d, want 7", triggers)
	}
	// Online state never references the private single-owner archive.
	var crossReferences int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_constraint c WHERE c.contype='f' AND c.conrelid::regclass::text LIKE 'online_%' AND c.confrelid::regclass::text IN ('games','archive_chunks','archive_events','operations','deletion_tombstones')`).Scan(&crossReferences); err != nil {
		t.Fatal(err)
	}
	if crossReferences != 0 {
		t.Fatalf("online tables reference private archive tables: %d", crossReferences)
	}

	var rulesExists, apiExists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='kamkm_online_rules')`).Scan(&rulesExists); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='kamkm_online_api')`).Scan(&apiExists); err != nil {
		t.Fatal(err)
	}
	if !rulesExists || !apiExists {
		t.Skipf("runtime roles unavailable (migration role cannot CREATE ROLE); set KHA41_TEST_DATABASE_URL to a role with CREATEROLE for the ARCH-02 grant assertion")
	}
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if _, err = conn.Exec(ctx, `SET ROLE kamkm_online_rules`); err != nil {
		t.Skipf("cannot SET ROLE kamkm_online_rules: %v", err)
	}
	_, err = conn.Exec(ctx, `INSERT INTO online_matches(match_id,schema_version,variant,starting_fen,position_fen,starting_time_ms,increment_ms,version,control_epoch,input_hash,rules_policy_version,status) VALUES('rules-write-01',1,'orthodox','8/8/8/8/8/8/8/8 w - - 0 1','8/8/8/8/8/8/8/8 w - - 0 1',1000,0,1,1,decode(repeat('00',32),'hex'),'online-rules/1','active')`)
	if !hasPgCode(err, "42501") {
		t.Fatalf("rules role write error = %v, want permission denied 42501", err)
	}
	_, err = conn.Exec(ctx, `SELECT count(*) FROM games`)
	if !hasPgCode(err, "42501") {
		t.Fatalf("rules role private archive read error = %v, want permission denied 42501", err)
	}
	if _, err = conn.Exec(ctx, `RESET ROLE`); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, `SET ROLE kamkm_online_api`); err != nil {
		t.Skipf("cannot SET ROLE kamkm_online_api: %v", err)
	}
	if _, err = conn.Exec(ctx, `SELECT count(*) FROM online_matches`); err != nil {
		t.Fatalf("online API role cannot read online state: %v", err)
	}
	if _, err = conn.Exec(ctx, `SELECT count(*) FROM games`); !hasPgCode(err, "42501") {
		t.Fatalf("online API role private archive read error = %v, want 42501", err)
	}
	if _, err = conn.Exec(ctx, `RESET ROLE`); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresOnlineLostAcknowledgementAndPayloadMismatch(t *testing.T) {
	service, pool := onlineService(t, moveEvaluator{})
	matchID, opCreate := "match-ack-01", "op-ack-create"
	createOnlineMatch(t, service, matchID, opCreate)
	move := moveOnlineCommand(matchID, "op-ack-move", online.SeatWhite, 1, "e2e4")
	first, err := service.Execute(context.Background(), alice, move)
	if err != nil {
		t.Fatalf("first move: %v", err)
	}
	if first.Duplicate || first.Receipt.Version != 2 || first.Receipt.Event == nil || first.Receipt.Event.Kind != online.EventMove {
		t.Fatalf("first move receipt = %+v", first.Receipt)
	}
	// Simulate a lost acknowledgement: the caller retries the identical payload.
	retried, err := service.Execute(context.Background(), alice, move)
	if err != nil {
		t.Fatalf("retry identical payload: %v", err)
	}
	if !retried.Duplicate {
		t.Fatal("identical retry was not marked duplicate")
	}
	if !bytes.Equal(first.Raw, retried.Raw) {
		t.Fatalf("identical retry changed receipt bytes:\nfirst=%s\nretry=%s", first.Raw, retried.Raw)
	}
	stored, err := service.GetReceipt(context.Background(), matchID, "op-ack-move")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first.Raw, stored.Raw) || !stored.Duplicate {
		t.Fatal("receipt lookup did not return the original bytes")
	}
	match, err := service.GetMatch(context.Background(), matchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.Version != 2 || len(match.Moves) != 1 || match.Moves[0].UCI != "e2e4" {
		t.Fatalf("retry mutated match: version=%d moves=%+v", match.Version, match.Moves)
	}

	changed := move
	changed.Action = online.Action{Kind: online.ActionResign}
	if _, err = service.Execute(context.Background(), alice, changed); !errors.Is(err, online.ErrOperationReuse) {
		t.Fatalf("changed payload with same operation ID = %v, want ErrOperationReuse", err)
	}
	if _, err = service.Execute(context.Background(), bob, move); !errors.Is(err, online.ErrOperationReuse) {
		t.Fatalf("different actor with same operation ID = %v, want ErrOperationReuse", err)
	}
	var receipts int
	if err = pool.QueryRow(context.Background(), `SELECT count(*) FROM online_operation_receipts WHERE scope_id=$1`, matchID).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if receipts != 2 {
		t.Fatalf("receipt rows = %d, want create and move only", receipts)
	}
}

func TestPostgresOnlineCompetingVersionedWriters(t *testing.T) {
	service, pool := onlineService(t, moveEvaluator{})
	matchID := "match-race-01"
	createOnlineMatch(t, service, matchID, "op-race-create")
	first := moveOnlineCommand(matchID, "op-race-a", online.SeatWhite, 1, "e2e4")
	second := moveOnlineCommand(matchID, "op-race-b", online.SeatWhite, 1, "d2d4")
	var wg sync.WaitGroup
	results := make(chan online.CommandResult, 2)
	errs := make(chan error, 2)
	for _, cmd := range []online.Command{first, second} {
		cmd := cmd
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := service.Execute(context.Background(), alice, cmd)
			results <- result
			errs <- err
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	successes, conflicts := 0, 0
	for err := range errs {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, online.ErrConflict):
			conflicts++
		default:
			t.Fatalf("competing writer error = %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("competing writers success=%d conflict=%d, want 1 each", successes, conflicts)
	}
	match, err := service.GetMatch(context.Background(), matchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.Version != 2 || len(match.Moves) != 1 {
		t.Fatalf("competing writers version=%d moves=%d", match.Version, len(match.Moves))
	}
	if _, err = service.Execute(context.Background(), bob, resignOnlineCommand(matchID, "op-race-resign", online.SeatBlack, 2)); err != nil {
		t.Fatalf("resign: %v", err)
	}
	// A stored final result cannot be rewritten by direct SQL either.
	_, err = pool.Exec(context.Background(), `UPDATE online_matches SET result='{"kind":"draw","winner":null,"reason":"agreement"}'::jsonb WHERE match_id=$1`, matchID)
	if !hasPgCode(err, "55000") {
		t.Fatalf("rewriting final result error = %v, want SQLSTATE 55000", err)
	}
	// The accepted match and its result cannot be removed by direct SQL.
	_, err = pool.Exec(context.Background(), `DELETE FROM online_matches WHERE match_id=$1`, matchID)
	if !hasPgCode(err, "55000") {
		t.Fatalf("deleting accepted match error = %v, want SQLSTATE 55000", err)
	}
	// The version that latched the result cannot be rewritten either.
	_, err = pool.Exec(context.Background(), `UPDATE online_matches SET version=version+1,result_version=1 WHERE match_id=$1`, matchID)
	if !hasPgCode(err, "55000") {
		t.Fatalf("rewriting result version error = %v, want SQLSTATE 55000", err)
	}
}

func TestPostgresOnlineAbortAndControlEpoch(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()

	// A side that has not moved may cancel even after the opponent moved. The
	// cancellation aborts the match.
	abortMatch := "match-abort-01"
	createOnlineMatch(t, service, abortMatch, "op-abort-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(abortMatch, "op-abort-white", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("white move: %v", err)
	}
	aborted, err := service.Execute(ctx, bob, cancelOnlineCommand(abortMatch, "op-abort-black", online.SeatBlack, 2))
	if err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if aborted.Receipt.Result == nil || aborted.Receipt.Result.Kind != online.ResultAbort || aborted.Receipt.Result.Reason != online.ReasonAbort {
		t.Fatalf("abort receipt = %+v", aborted.Receipt)
	}
	match, err := service.GetMatch(ctx, abortMatch)
	if err != nil {
		t.Fatal(err)
	}
	if match.Status != online.MatchAborted || len(match.Moves) != 1 {
		t.Fatalf("match after abort = status %q moves %d", match.Status, len(match.Moves))
	}
	projection, err := service.GetPublicProjection(ctx, abortMatch)
	if err != nil {
		t.Fatalf("abort projection: %v", err)
	}
	if projection.Result.Kind != online.ResultAbort {
		t.Fatalf("abort projection result = %+v", projection.Result)
	}

	// A control change advances the control epoch; old-epoch intents conflict.
	controlMatch := "match-control-01"
	createOnlineMatch(t, service, controlMatch, "op-control-create")
	label := "Declared Model"
	changed, err := service.Execute(ctx, alice, setControlOnlineCommand(controlMatch, "op-control-set", online.SeatWhite, 1, online.SeatControl{Kind: online.ControlAgent, ModelLabel: &label}))
	if err != nil {
		t.Fatalf("set control: %v", err)
	}
	if changed.Receipt.ControlEpoch != 2 || changed.Receipt.Version != 2 {
		t.Fatalf("control receipt = %+v", changed.Receipt)
	}
	match, err = service.GetMatch(ctx, controlMatch)
	if err != nil {
		t.Fatal(err)
	}
	seat, ok := match.Seat(online.SeatWhite)
	if !ok || seat.Control.Kind != online.ControlAgent || seat.Control.ModelLabel == nil || *seat.Control.ModelLabel != label || seat.ControlEpoch != 2 {
		t.Fatalf("seat after control change = %+v", seat)
	}
	if match.ControlEpoch != 2 {
		t.Fatalf("match control epoch = %d, want 2", match.ControlEpoch)
	}
	if _, err = service.Execute(ctx, alice, moveOnlineCommand(controlMatch, "op-control-stale", online.SeatWhite, 2, "e2e4")); !errors.Is(err, online.ErrConflict) {
		t.Fatalf("old-epoch move error = %v, want ErrConflict", err)
	}
	accepted, err := service.Execute(ctx, alice, moveOnlineCommandAt(controlMatch, "op-control-move", online.SeatWhite, 2, 2, "e2e4"))
	if err != nil {
		t.Fatalf("current-epoch move: %v", err)
	}
	if accepted.Receipt.Version != 3 || accepted.Receipt.ControlEpoch != 2 {
		t.Fatalf("current-epoch receipt = %+v", accepted.Receipt)
	}
}

func TestPostgresOnlineLockWaitCrossesClockExpiry(t *testing.T) {
	service, pool := onlineService(t, timeoutEvaluator{winnerFor: timeoutWinForOpponent})
	matchID := "match-lock-01"
	create := createOnlineCommand(matchID, "op-lock-create")
	create.Action.CreateMatch.TimeControl = online.TimeControl{StartingTimeMs: 500, IncrementMs: 0}
	if _, err := service.Execute(context.Background(), alice, create); err != nil {
		t.Fatal(err)
	}
	playOpeningExchange(t, service, matchID, "op-lock")
	before, err := service.GetMatch(context.Background(), matchID)
	if err != nil {
		t.Fatal(err)
	}
	if before.Clock.DeadlineAt == nil || before.Clock.ActiveSeat == nil || *before.Clock.ActiveSeat != online.SeatWhite {
		t.Fatalf("the opening reply did not start White's main clock: %+v", before.Clock)
	}

	holder, err := pool.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Release()
	tx, err := holder.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var locked string
	if err = tx.QueryRow(context.Background(), `SELECT match_id FROM online_matches WHERE match_id=$1 FOR UPDATE`, matchID).Scan(&locked); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	type outcome struct {
		result online.CommandResult
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		close(started)
		result, err := service.Execute(context.Background(), alice, moveOnlineCommand(matchID, "op-lock-white-again", online.SeatWhite, 3, "g1f3"))
		done <- outcome{result: result, err: err}
	}()
	<-started
	// The deadline passes while the command waits for the match row. The wait
	// follows the database clock and reaches past the deadline, so the
	// fixture does not depend on the host wall clock, and a step of the
	// database clock cannot take the deadline back.
	waitForDatabaseTime(t, pool, (*before.Clock.DeadlineAt).Add(2*time.Second))
	if err = tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := <-done
	if got.err != nil {
		t.Fatalf("blocked command: %v", got.err)
	}
	if got.result.Receipt.Outcome != online.OutcomeDeadlineExpired {
		t.Fatalf("outcome = %q, want deadline_expired", got.result.Receipt.Outcome)
	}
	if got.result.Receipt.Result == nil || got.result.Receipt.Result.Reason != online.ReasonTimeout {
		t.Fatalf("timeout result = %+v", got.result.Receipt.Result)
	}
	if got.result.Receipt.DecidedAt.Before(*before.Clock.DeadlineAt) {
		t.Fatalf("decision time %s predates deadline %s", got.result.Receipt.DecidedAt, before.Clock.DeadlineAt)
	}
	match, err := service.GetMatch(context.Background(), matchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.Status != online.MatchCompleted || match.Result == nil || match.Result.Reason != online.ReasonTimeout {
		t.Fatalf("match after lock wait = %+v", match)
	}
	if len(match.Moves) != 2 {
		t.Fatalf("late move was accepted after expiry: moves=%d", len(match.Moves))
	}
	retried, err := service.Execute(context.Background(), alice, moveOnlineCommand(matchID, "op-lock-white-again", online.SeatWhite, 3, "g1f3"))
	if err != nil {
		t.Fatalf("retry expired command: %v", err)
	}
	if !bytes.Equal(got.result.Raw, retried.Raw) {
		t.Fatal("expired receipt changed on retry")
	}
}

func TestPostgresOnlineWorkerMoveSideMustMatchPosition(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	matchID := "match-side-01"
	createOnlineMatch(t, service, matchID, "op-side-create")
	// The position is Black to move after White's accepted move; White cannot
	// submit another move even with an internally valid-looking candidate.
	if _, err := service.Execute(context.Background(), alice, moveOnlineCommand(matchID, "op-side-white", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatal(err)
	}
	candidate := online.Candidate{
		SchemaVersion:      online.RulesInputSchemaVersion,
		EvaluatedVersion:   2,
		EvaluatedInputHash: strings.Repeat("a", 64),
		ControlEpoch:       1,
		Move:               &online.Move{Seat: online.SeatWhite, UCI: "d2d4", SAN: "d4", ResultingFEN: fakePositionFEN(online.SeatBlack)},
	}
	if _, err := service.ApplyWorkerCandidate(context.Background(), alice, moveOnlineCommand(matchID, "op-side-double", online.SeatWhite, 2, "d2d4"), candidate); !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("white moving twice = %v, want ErrActionNotAllowed", err)
	}
	match, err := service.GetMatch(context.Background(), matchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.Version != 2 || len(match.Moves) != 1 {
		t.Fatalf("wrong-side move changed match: version=%d moves=%d", match.Version, len(match.Moves))
	}
}

func TestPostgresOnlineWorkerCandidateFencing(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	matchID := "match-fence-01"
	createOnlineMatch(t, service, matchID, "op-fence-create")
	cmd := moveOnlineCommand(matchID, "op-fence-move", online.SeatWhite, 1, "e2e4")
	valid := online.Candidate{
		SchemaVersion:      online.RulesInputSchemaVersion,
		EvaluatedVersion:   1,
		EvaluatedInputHash: strings.Repeat("a", 64),
		ControlEpoch:       1,
		Move:               &online.Move{Seat: online.SeatWhite, UCI: "e2e4", SAN: "e4", ResultingFEN: "8/8/8/8/8/8/8/8 b - - 0 1"},
	}
	for name, mutate := range map[string]func(*online.Candidate){
		"stale version":       func(c *online.Candidate) { c.EvaluatedVersion = 0 },
		"stale control epoch": func(c *online.Candidate) { c.ControlEpoch = 2 },
		"stale input hash":    func(c *online.Candidate) { c.EvaluatedInputHash = strings.Repeat("b", 64) },
	} {
		candidate := valid
		move := *valid.Move
		candidate.Move = &move
		mutate(&candidate)
		if _, err := service.ApplyWorkerCandidate(context.Background(), alice, cmd, candidate); !errors.Is(err, online.ErrStaleCandidate) {
			t.Fatalf("%s candidate error = %v, want ErrStaleCandidate", name, err)
		}
	}
	match, err := service.GetMatch(context.Background(), matchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.Version != 1 || len(match.Moves) != 0 {
		t.Fatalf("rejected candidates changed match: version=%d moves=%d", match.Version, len(match.Moves))
	}
}

// playOpeningExchange accepts the opening move and its reply. The match then
// runs a main clock for the side to move.
func playOpeningExchange(t *testing.T, service *online.Service, matchID, prefix string) {
	t.Helper()
	ctx := context.Background()
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, prefix+"-white", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, prefix+"-black", online.SeatBlack, 2, "e7e5")); err != nil {
		t.Fatalf("opening reply: %v", err)
	}
}

// expireMainClock moves the armed main clock deadline into the past so the
// next intent reconciles a real expiry without waiting for wall-clock time.
func expireMainClock(t *testing.T, pool *pgxpool.Pool, matchID string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `UPDATE online_clocks SET active_since=active_since-$1::interval,deadline_at=deadline_at-$1::interval WHERE match_id=$2 AND deadline_at IS NOT NULL`, "1 hour", matchID); err != nil {
		t.Fatal(err)
	}
}

// expireReplyWindow moves the opening reply window into the past.
func expireReplyWindow(t *testing.T, pool *pgxpool.Pool, matchID string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `UPDATE online_clocks SET reply_deadline_at=reply_deadline_at-$1::interval WHERE match_id=$2 AND reply_deadline_at IS NOT NULL`, "1 minute", matchID); err != nil {
		t.Fatal(err)
	}
}

func expireOnlineMatch(t *testing.T, service *online.Service, pool *pgxpool.Pool, matchID, prefix, startingFEN, whiteUCI string) {
	t.Helper()
	ctx := context.Background()
	create := createOnlineCommand(matchID, prefix+"-create")
	create.Action.CreateMatch.TimeControl = online.TimeControl{StartingTimeMs: 60_000}
	if startingFEN != "" {
		create.Action.CreateMatch.StartingFEN = startingFEN
	}
	if _, err := service.Execute(ctx, alice, create); err != nil {
		t.Fatalf("create expiring match: %v", err)
	}
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, prefix+"-white", online.SeatWhite, 1, whiteUCI)); err != nil {
		t.Fatalf("white move: %v", err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, prefix+"-black", online.SeatBlack, 2, "e7e5")); err != nil {
		t.Fatalf("black reply: %v", err)
	}
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, prefix+"-white-again", online.SeatWhite, 3, whiteUCI)); err != nil {
		t.Fatalf("second white move: %v", err)
	}
	expireMainClock(t, pool, matchID)
}

func TestPostgresOnlineTimeoutFailsClosedWithoutPolicy(t *testing.T) {
	service, pool := onlineService(t, moveEvaluator{})
	matchID := "match-timeout-closed"
	expireOnlineMatch(t, service, pool, matchID, "op-closed", "", "e2e4")
	ctx := context.Background()
	_, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-closed-move", online.SeatBlack, 4, "e7e5"))
	if !errors.Is(err, online.ErrTimeoutPolicyUnavailable) {
		t.Fatalf("flag fall without timeout policy = %v, want ErrTimeoutPolicyUnavailable", err)
	}
	match, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.Status != online.MatchActive || match.Result != nil || match.Version != 4 || len(match.Moves) != 3 {
		t.Fatalf("fail-closed flag fall changed match: status=%q version=%d moves=%d result=%+v", match.Status, match.Version, len(match.Moves), match.Result)
	}
	var receipts, timeoutEvents int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM online_operation_receipts WHERE scope_id=$1`, matchID).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if receipts != 4 {
		t.Fatalf("receipts after fail-closed flag fall = %d, want create and three moves only", receipts)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM online_events WHERE match_id=$1 AND event_kind='timeout'`, matchID).Scan(&timeoutEvents); err != nil {
		t.Fatal(err)
	}
	if timeoutEvents != 0 {
		t.Fatalf("fail-closed flag fall wrote %d timeout events", timeoutEvents)
	}
}

func TestPostgresOnlineTimeoutWithInsufficientMaterialIsDraw(t *testing.T) {
	service, pool := onlineService(t, timeoutEvaluator{winnerFor: timeoutInsufficientMaterial})
	matchID := "match-timeout-draw"
	// Bare kings: the sleeping side has no mating material, so a flag fall is a
	// draw rather than a win for the side that did not flag.
	expireOnlineMatch(t, service, pool, matchID, "op-draw", "8/8/8/8/8/8/8/K6k w - - 0 1", "a1a2")
	ctx := context.Background()
	result, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-draw-late", online.SeatBlack, 4, "h1h2"))
	if err != nil {
		t.Fatalf("insufficient-material flag fall: %v", err)
	}
	if result.Receipt.Outcome != online.OutcomeDeadlineExpired {
		t.Fatalf("outcome = %q, want deadline_expired", result.Receipt.Outcome)
	}
	if result.Receipt.Result == nil || result.Receipt.Result.Kind != online.ResultDraw || result.Receipt.Result.Reason != online.ReasonInsufficientMaterial || result.Receipt.Result.Winner != nil {
		t.Fatalf("insufficient-material timeout result = %+v, want an unscored draw", result.Receipt.Result)
	}
	match, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.Status != online.MatchCompleted || match.Result == nil || match.Result.Kind != online.ResultDraw || len(match.Moves) != 3 {
		t.Fatalf("match after insufficient-material timeout = status %q result %+v moves %d", match.Status, match.Result, len(match.Moves))
	}
	projection, err := service.GetPublicProjection(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if projection.Result.Kind != online.ResultDraw || projection.Result.Reason != online.ReasonInsufficientMaterial {
		t.Fatalf("public timeout adjudication = %+v", projection.Result)
	}
}

func TestPostgresOnlineTimeoutFactsAreFencedByRelock(t *testing.T) {
	var pool *pgxpool.Pool
	service, opened := onlineService(t, timeoutEvaluator{
		winnerFor: timeoutWinForOpponent,
		observe: func(input online.RulesInput, _ online.Seat) {
			// Simulate a concurrent committed change between the outside-lock
			// evaluation and the authoritative re-lock.
			if _, err := pool.Exec(context.Background(), `UPDATE online_matches SET version=version+1,updated_at=clock_timestamp() WHERE match_id=$1`, input.MatchID); err != nil {
				t.Errorf("concurrent state change: %v", err)
			}
		},
	})
	pool = opened
	matchID := "match-timeout-fence"
	expireOnlineMatch(t, service, pool, matchID, "op-timeout-fence", "", "e2e4")
	ctx := context.Background()
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-timeout-fence-late", online.SeatBlack, 4, "e7e5")); !errors.Is(err, online.ErrStaleCandidate) {
		t.Fatalf("timeout facts evaluated before a concurrent change = %v, want ErrStaleCandidate", err)
	}
	var receipts, timeoutEvents int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM online_operation_receipts WHERE operation_id='op-timeout-fence-late'`).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if receipts != 0 {
		t.Fatalf("stale timeout facts wrote %d receipts", receipts)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM online_events WHERE match_id=$1 AND event_kind='timeout'`, matchID).Scan(&timeoutEvents); err != nil {
		t.Fatal(err)
	}
	if timeoutEvents != 0 {
		t.Fatalf("stale timeout facts wrote %d timeout events", timeoutEvents)
	}
}

func TestPostgresOnlineUnauthorizedActorCannotTriggerTimeout(t *testing.T) {
	service, pool := onlineService(t, timeoutEvaluator{winnerFor: timeoutWinForOpponent})
	matchID := "match-timeout-auth"
	expireOnlineMatch(t, service, pool, matchID, "op-timeout-auth", "", "e2e4")
	ctx := context.Background()
	charlie := online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_c"}
	if _, err := service.Execute(ctx, charlie, moveOnlineCommand(matchID, "op-intruder-move", online.SeatWhite, 4, "d2d4")); !errors.Is(err, online.ErrNotAuthorized) {
		t.Fatalf("intruder move = %v, want ErrNotAuthorized", err)
	}
	if _, err := service.Execute(ctx, charlie, resignOnlineCommand(matchID, "op-intruder-resign", online.SeatWhite, 4)); !errors.Is(err, online.ErrNotAuthorized) {
		t.Fatalf("intruder resign = %v, want ErrNotAuthorized", err)
	}
	candidate := online.Candidate{
		SchemaVersion:      online.RulesInputSchemaVersion,
		EvaluatedVersion:   4,
		EvaluatedInputHash: strings.Repeat("a", 64),
		ControlEpoch:       1,
		Move:               &online.Move{Seat: online.SeatWhite, UCI: "d2d4", SAN: "d4", ResultingFEN: fakePositionFEN(online.SeatBlack)},
	}
	if _, err := service.ApplyWorkerCandidate(ctx, charlie, moveOnlineCommand(matchID, "op-intruder-candidate", online.SeatWhite, 4, "d2d4"), candidate); !errors.Is(err, online.ErrNotAuthorized) {
		t.Fatalf("intruder candidate = %v, want ErrNotAuthorized", err)
	}
	var receipts, timeoutEvents int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM online_operation_receipts WHERE scope_id=$1`, matchID).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if receipts != 4 {
		t.Fatalf("intruder wrote receipts: %d rows, want create and three moves only", receipts)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM online_events WHERE match_id=$1 AND event_kind='timeout'`, matchID).Scan(&timeoutEvents); err != nil {
		t.Fatal(err)
	}
	if timeoutEvents != 0 {
		t.Fatalf("intruder triggered %d timeout events", timeoutEvents)
	}
	match, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.Status != online.MatchActive || match.Version != 4 {
		t.Fatalf("intruder changed match: status=%q version=%d", match.Status, match.Version)
	}
	// The seat owner can still adjudicate the same expired clock.
	authorized, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-timeout-auth-late", online.SeatBlack, 4, "e7e5"))
	if err != nil {
		t.Fatalf("authorized flag fall: %v", err)
	}
	if authorized.Receipt.Result == nil || authorized.Receipt.Result.Winner == nil || *authorized.Receipt.Result.Winner != online.SeatWhite || authorized.Receipt.Result.Reason != online.ReasonTimeout {
		t.Fatalf("authorized timeout result = %+v", authorized.Receipt.Result)
	}
}

func TestPostgresOnlineGetMatchReturnsConsistentSnapshot(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-snapshot-01"
	createOnlineMatch(t, service, matchID, "op-snapshot-create")
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for index := 0; index < 30; index++ {
			seat := online.SeatWhite
			actor := alice
			if index%2 == 1 {
				seat = online.SeatBlack
				actor = bob
			}
			command := moveOnlineCommand(matchID, fmt.Sprintf("op-snapshot-%03d", index), seat, int64(index+1), "e2e4")
			if _, err := service.Execute(ctx, actor, command); err != nil {
				t.Errorf("snapshot writer move %d: %v", index, err)
				return
			}
		}
	}()
	for read := 0; read < 200; read++ {
		match, err := service.GetMatch(ctx, matchID)
		if err != nil {
			t.Fatal(err)
		}
		if match.Version != int64(len(match.Moves)+1) {
			t.Fatalf("mixed snapshot: version=%d moves=%d", match.Version, len(match.Moves))
		}
		if match.Clock.TurnNumber != int64(len(match.Moves)) {
			t.Fatalf("mixed clock snapshot: turn=%d moves=%d", match.Clock.TurnNumber, len(match.Moves))
		}
		for index, move := range match.Moves {
			if move.Version != int64(index+2) {
				t.Fatalf("mixed move snapshot at %d: version=%d", index, move.Version)
			}
		}
		if len(match.Moves) > 0 && match.PositionFEN != match.Moves[len(match.Moves)-1].ResultingFEN {
			t.Fatalf("position %q does not match final move %q", match.PositionFEN, match.Moves[len(match.Moves)-1].ResultingFEN)
		}
	}
	wg.Wait()
}

func TestPostgresOnlineParticipantReadsHideNonMembers(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	create := createOnlineCommand("match-participant-read", "op-create-participant-read")
	if _, err := service.Execute(ctx, create.Action.CreateMatch.Seats.White.Participant, create); err != nil {
		t.Fatal(err)
	}
	outsider := online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_outsider"}
	if _, err := service.GetMatchForParticipant(ctx, create.MatchID, outsider); !errors.Is(err, online.ErrNotFound) {
		t.Fatalf("outsider match read error = %v, want ErrNotFound", err)
	}
	if _, err := service.GetMatchForParticipant(ctx, create.MatchID, create.Action.CreateMatch.Seats.White.Participant); err != nil {
		t.Fatalf("participant match read: %v", err)
	}
	if _, err := service.GetReceiptForParticipant(ctx, create.MatchID, create.OperationID, outsider); !errors.Is(err, online.ErrNotFound) {
		t.Fatalf("outsider receipt read error = %v, want ErrNotFound", err)
	}
	if _, err := service.GetReceiptForParticipant(ctx, create.MatchID, create.OperationID, create.Action.CreateMatch.Seats.Black.Participant); err != nil {
		t.Fatalf("participant receipt read: %v", err)
	}
}

func TestPostgresOnlineAnonymizationAndReplayRedaction(t *testing.T) {
	service, pool := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-anon-01"
	createOnlineMatch(t, service, matchID, "op-anon-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-anon-white", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Execute(ctx, bob, resignOnlineCommand(matchID, "op-anon-resign", online.SeatBlack, 2)); err != nil {
		t.Fatal(err)
	}
	redact := `UPDATE online_public_projections SET projection_json=jsonb_set(projection_json,'{participants,0,publicLabel}','"Deleted player"') WHERE match_id=$1`
	if _, err := pool.Exec(ctx, redact, matchID); !hasPgCode(err, "55000") {
		t.Fatalf("projection redaction without a marker = %v, want SQLSTATE 55000", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE online_seats SET owner_id='user_c' WHERE match_id=$1 AND seat='white'`, matchID); !hasPgCode(err, "55000") {
		t.Fatalf("live owner rewrite = %v, want SQLSTATE 55000", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE online_seats SET owner_id='anonymized',public_label='Deleted player' WHERE match_id=$1 AND seat='white'`, matchID); !hasPgCode(err, "55000") {
		t.Fatalf("anonymization without a marker = %v, want SQLSTATE 55000", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO online_deletion_markers(marker_id,marker_kind,subject_kind,subject_id,match_id,reason,requested_at,applied_at) VALUES('op-anon-marker','account_anonymization','account','user_a',$1,'account_deletion',now(),now())`, matchID); err != nil {
		t.Fatalf("record anonymization marker: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE online_seats SET owner_id='anonymized',public_label='Deleted player' WHERE match_id=$1 AND seat='white'`, matchID); err != nil {
		t.Fatalf("anonymize retained seat: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE online_seats SET owner_id='user_a' WHERE match_id=$1 AND seat='white'`, matchID); !hasPgCode(err, "55000") {
		t.Fatalf("reverse anonymization = %v, want SQLSTATE 55000", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE online_seats SET seat='black' WHERE match_id=$1 AND seat='white'`, matchID); !hasPgCode(err, "55000") {
		t.Fatalf("seat identity rewrite = %v, want SQLSTATE 55000", err)
	}
	if _, err := pool.Exec(ctx, redact, matchID); err != nil {
		t.Fatalf("projection redaction after marker: %v", err)
	}
	projection, err := service.GetPublicProjection(ctx, matchID)
	if err != nil {
		t.Fatalf("public projection after anonymization: %v", err)
	}
	if projection.Participants[0].PublicLabel != "Deleted player" {
		t.Fatalf("anonymized public label = %q", projection.Participants[0].PublicLabel)
	}
	raw, err := json.Marshal(projection)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "Alice") {
		t.Fatalf("anonymized projection retained the old public label: %s", raw)
	}
	// The game itself is retained for aggregate history.
	match, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.Status != online.MatchCompleted || len(match.Moves) != 1 || match.Result == nil {
		t.Fatalf("anonymization did not retain the completed game: %+v", match)
	}
	seat, ok := match.Seat(online.SeatWhite)
	if !ok || seat.Participant.ID != "anonymized" || seat.PublicLabel != "Deleted player" {
		t.Fatalf("anonymized seat = %+v", seat)
	}
}

func TestPostgresOnlinePublicProjectionAndReplayRemoval(t *testing.T) {
	service, pool := onlineService(t, moveEvaluator{})
	matchID := "match-public-01"
	createOnlineMatch(t, service, matchID, "op-public-create")
	if _, err := service.Execute(context.Background(), alice, moveOnlineCommand(matchID, "op-public-white", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Execute(context.Background(), bob, resignOnlineCommand(matchID, "op-public-resign", online.SeatBlack, 2)); err != nil {
		t.Fatal(err)
	}
	projection, err := service.GetPublicProjection(context.Background(), matchID)
	if err != nil {
		t.Fatalf("public projection: %v", err)
	}
	if projection.MatchID != matchID || len(projection.Moves) != 1 || projection.Result.Reason != online.ReasonResignation {
		t.Fatalf("projection = %+v", projection)
	}
	// The allowlisted projection must not carry internal identities or operation IDs.
	raw, _ := jsonBytes(projection)
	for _, forbidden := range []string{"user_a", "user_b", "ownerId", "operationId", "op-public"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("projection leaked %q: %s", forbidden, raw)
		}
	}
	var resultVersionBefore int64
	if err = pool.QueryRow(context.Background(), `SELECT result_version FROM online_matches WHERE match_id=$1`, matchID).Scan(&resultVersionBefore); err != nil {
		t.Fatal(err)
	}
	if resultVersionBefore != 3 {
		t.Fatalf("result version before removal = %d, want 3", resultVersionBefore)
	}
	removed, err := service.Execute(context.Background(), bob, removeReplayCommand(matchID, "op-public-remove", online.SeatBlack, 3))
	if err != nil {
		t.Fatalf("remove replay: %v", err)
	}
	var resultVersionAfter int64
	if err = pool.QueryRow(context.Background(), `SELECT result_version FROM online_matches WHERE match_id=$1`, matchID).Scan(&resultVersionAfter); err != nil {
		t.Fatal(err)
	}
	if resultVersionAfter != resultVersionBefore {
		t.Fatalf("replay removal moved result version from %d to %d", resultVersionBefore, resultVersionAfter)
	}
	if removed.Receipt.Outcome != online.OutcomeReplayRemoved {
		t.Fatalf("removal outcome = %q", removed.Receipt.Outcome)
	}
	if _, err = service.GetPublicProjection(context.Background(), matchID); !errors.Is(err, online.ErrNotFound) {
		t.Fatalf("removed projection lookup = %v, want ErrNotFound", err)
	}
	var markers int
	if err = pool.QueryRow(context.Background(), `SELECT count(*) FROM online_deletion_markers WHERE match_id=$1 AND marker_kind='replay_removal' AND subject_id=$1`, matchID).Scan(&markers); err != nil {
		t.Fatal(err)
	}
	if markers != 1 {
		t.Fatalf("deletion markers = %d", markers)
	}
	retried, err := service.Execute(context.Background(), bob, removeReplayCommand(matchID, "op-public-remove", online.SeatBlack, 3))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(removed.Raw, retried.Raw) {
		t.Fatal("removal receipt changed on retry")
	}
}

func TestPostgresOnlineQueueAndLeaseFoundation(t *testing.T) {
	service, pool := onlineService(t, moveEvaluator{})
	matchID := "match-lease-01"
	createOnlineMatch(t, service, matchID, "op-lease-create")
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO online_queue_entries(entry_id,owner_kind,owner_id,seat_control_kind,seat_control_model_label,starting_time_ms,increment_ms,status,version,ready_at,cutoff_at) VALUES('queue-lease-01','account','user_a','agent','Declared Model',180000,0,'waiting',1,clock_timestamp(),clock_timestamp()+interval '10 seconds')`); err != nil {
		t.Fatalf("insert queue entry: %v", err)
	}
	queue, err := service.GetQueueEntry(ctx, "queue-lease-01")
	if err != nil {
		t.Fatal(err)
	}
	if queue.Owner != alice || queue.Status != online.QueueWaiting || queue.Control.ModelLabel == nil {
		t.Fatalf("queue entry = %+v", queue)
	}
	leaseAt := time.Now().UTC()
	if _, err = pool.Exec(ctx, `INSERT INTO online_runner_leases(lease_id,match_id,seat,control_epoch,generation,runner_id,status,acquired_at,expires_at) VALUES('lease-lease-01',$1,'white',1,1,'runner-tab', 'active', $2, $3)`, matchID, leaseAt, leaseAt.Add(15*time.Second)); err != nil {
		t.Fatalf("insert lease: %v", err)
	}
	lease, err := service.GetRunnerLease(ctx, "lease-lease-01")
	if err != nil {
		t.Fatal(err)
	}
	if lease.MatchID != matchID || lease.Status != online.LeaseActive || lease.Seat != online.SeatWhite {
		t.Fatalf("lease = %+v", lease)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO online_runner_leases(lease_id,match_id,seat,control_epoch,generation,runner_id,status,acquired_at,expires_at) VALUES('lease-lease-02',$1,'white',1,2,'runner-tab-2','active',$2,$3)`, matchID, leaseAt, leaseAt.Add(15*time.Second)); !hasPgCode(err, "23505") {
		t.Fatalf("second active seat lease error = %v, want unique violation", err)
	}
}

func jsonBytes(value any) ([]byte, error) {
	return json.Marshal(value)
}

func hasPgCode(err error, code string) bool {
	if err == nil {
		return false
	}
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == code
}
