package integration

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/rulesworker"
)

// KHA-68 evidence for the shared match authority: opening clocks, the
// fifteen second opening reply abort, first-move cancellation, mutual draw
// offers, exact-version takeback targets, shared recovery budgets and
// immutable final results.

// blackToMoveFEN is a custom position with Black to move. Black is the
// starting side there, so the opening reply window belongs to White.
const blackToMoveFEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"

// MAT-01: no main bank runs before its side's first accepted move, the first
// accepted move arms a fifteen second reply window, and the reply starts the
// next side's main clock.
func TestPostgresOnlineOpeningClockRunsNoMainBankBeforeTheFirstMove(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-opening-clock"
	create := createOnlineCommand(matchID, "op-opening-create")
	create.Action.CreateMatch.TimeControl = online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000}
	if _, err := service.Execute(ctx, alice, create); err != nil {
		t.Fatalf("create: %v", err)
	}
	created, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if created.Clock.ActiveSeat != nil || created.Clock.DeadlineAt != nil || created.Clock.ReplySeat != nil {
		t.Fatalf("a new match armed a deadline: %+v", created.Clock)
	}
	if created.Clock.WhiteMs != 300_000 || created.Clock.BlackMs != 300_000 {
		t.Fatalf("starting banks = %+v", created.Clock)
	}
	opened, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-opening-white", online.SeatWhite, 1, "e2e4"))
	if err != nil {
		t.Fatalf("opening move: %v", err)
	}
	if opened.Receipt.Version != 2 {
		t.Fatalf("the opening receipt version = %d", opened.Receipt.Version)
	}
	opening, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	// The opening move adds the increment once and starts no main clock.
	if opening.Clock.WhiteMs != 302_000 {
		t.Fatalf("the opening move did not add the increment once: %d", opening.Clock.WhiteMs)
	}
	if opening.Clock.BlackMs != 300_000 {
		t.Fatalf("the responder's bank ran before its first move: %d", opening.Clock.BlackMs)
	}
	if opening.Clock.ActiveSeat != nil || opening.Clock.ActiveSince != nil || opening.Clock.DeadlineAt != nil {
		t.Fatalf("the opening move started a main clock: %+v", opening.Clock)
	}
	if opening.Clock.ReplySeat == nil || *opening.Clock.ReplySeat != online.SeatBlack {
		t.Fatalf("the reply window names the wrong seat: %+v", opening.Clock)
	}
	if opening.Clock.ReplyDeadlineAt == nil {
		t.Fatal("the opening move armed no reply window")
	}
	window := opening.Clock.ReplyDeadlineAt.Sub(opened.Receipt.DecidedAt)
	if window < 14*time.Second || window > 16*time.Second {
		t.Fatalf("the reply window is %s, want about fifteen seconds", window)
	}
	// The reply closes the window and starts the next side's main clock.
	if _, err = service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-opening-black", online.SeatBlack, 2, "e7e5")); err != nil {
		t.Fatalf("opening reply: %v", err)
	}
	afterReply, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if afterReply.Clock.ReplySeat != nil || afterReply.Clock.ReplyDeadlineAt != nil {
		t.Fatalf("the reply left the window armed: %+v", afterReply.Clock)
	}
	if afterReply.Clock.ActiveSeat == nil || *afterReply.Clock.ActiveSeat != online.SeatWhite {
		t.Fatalf("the reply did not start the next side's clock: %+v", afterReply.Clock)
	}
	if afterReply.Clock.BlackMs != 302_000 {
		t.Fatalf("the reply charged the responder's bank: %d", afterReply.Clock.BlackMs)
	}
	if afterReply.Clock.WhiteMs != 302_000 {
		t.Fatalf("the responder's reply changed the starter's bank: %d", afterReply.Clock.WhiteMs)
	}
	if afterReply.Clock.TurnNumber != 2 {
		t.Fatalf("turn number = %d, want one accepted move per turn", afterReply.Clock.TurnNumber)
	}
}

// MAT-01: the opening rule applies by the side to move, so a custom position
// with Black to move makes Black the starting side.
func TestPostgresOnlineOpeningClockAppliesToBlackToMovePositions(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-opening-black"
	create := createOnlineCommand(matchID, "op-opening-black-create")
	create.Action.CreateMatch.StartingFEN = blackToMoveFEN
	if _, err := service.Execute(ctx, alice, create); err != nil {
		t.Fatalf("create: %v", err)
	}
	// Black is to move in the created position, so Black owns the opening
	// move and White owes the reply.
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-opening-black-black", online.SeatBlack, 1, "e7e5")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	opening, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if opening.Clock.ReplySeat == nil || *opening.Clock.ReplySeat != online.SeatWhite {
		t.Fatalf("the reply window names the wrong seat: %+v", opening.Clock)
	}
	if opening.Clock.ActiveSeat != nil || opening.Clock.DeadlineAt != nil {
		t.Fatalf("the opening move started a main clock: %+v", opening.Clock)
	}
	if _, err = service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-opening-black-reply", online.SeatWhite, 2, "g8f6")); err != nil {
		t.Fatalf("opening reply: %v", err)
	}
	afterReply, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if afterReply.Clock.ActiveSeat == nil || *afterReply.Clock.ActiveSeat != online.SeatBlack {
		t.Fatalf("the reply did not start the next side's clock: %+v", afterReply.Clock)
	}
}

// MAT-01 and MAT-04: an unanswered opening reply aborts the match, and a late
// intent cannot become a move.
func TestPostgresOnlineUnansweredOpeningReplyAbortsTheMatch(t *testing.T) {
	service, pool := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-opening-abort"
	create := createOnlineCommand(matchID, "op-opening-abort-create")
	create.Action.CreateMatch.TimeControl = online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000}
	if _, err := service.Execute(ctx, alice, create); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-opening-abort-white", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	expireReplyWindow(t, pool, matchID)
	late, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-opening-abort-late", online.SeatBlack, 2, "e7e5"))
	if err != nil {
		t.Fatalf("late reply: %v", err)
	}
	if late.Receipt.Outcome != online.OutcomeOpeningExpired {
		t.Fatalf("outcome = %q, want opening_expired", late.Receipt.Outcome)
	}
	if late.Receipt.Result == nil || late.Receipt.Result.Kind != online.ResultAbort || late.Receipt.Result.Reason != online.ReasonOpeningReplyTimeout {
		t.Fatalf("opening abort result = %+v", late.Receipt.Result)
	}
	match, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.Status != online.MatchAborted || len(match.Moves) != 1 {
		t.Fatalf("the late reply became a move: status=%q moves=%d", match.Status, len(match.Moves))
	}
	// The responder's bank never ran, so the abort did not charge it.
	if match.Clock.BlackMs != 300_000 {
		t.Fatalf("the opening abort charged the responder's bank: %d", match.Clock.BlackMs)
	}
	projection, err := service.GetPublicProjection(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if projection.Result.Kind != online.ResultAbort || projection.Result.Reason != online.ReasonOpeningReplyTimeout {
		t.Fatalf("public opening abort = %+v", projection.Result)
	}
	// A later intent cannot revive the match.
	if _, err = service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-opening-abort-later", online.SeatBlack, 3, "e7e5")); !errors.Is(err, online.ErrMatchEnded) {
		t.Fatalf("a move after the opening abort = %v, want ErrMatchEnded", err)
	}
}

// MAT-03: duplicate, stale, wrong-seat and illegal intents advance nothing and
// mint no increment.
func TestPostgresOnlineRejectedIntentsDoNotAdvanceStateOrMintIncrements(t *testing.T) {
	service, pool := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-rejected-intents"
	create := createOnlineCommand(matchID, "op-rejected-create")
	create.Action.CreateMatch.TimeControl = online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000}
	if _, err := service.Execute(ctx, alice, create); err != nil {
		t.Fatalf("create: %v", err)
	}
	opening := moveOnlineCommand(matchID, "op-rejected-white", online.SeatWhite, 1, "e2e4")
	accepted, err := service.Execute(ctx, alice, opening)
	if err != nil {
		t.Fatalf("opening move: %v", err)
	}
	afterOpening, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	// A duplicate returns the original receipt and changes nothing.
	duplicate, err := service.Execute(ctx, alice, opening)
	if err != nil {
		t.Fatalf("duplicate: %v", err)
	}
	if !duplicate.Duplicate || !bytes.Equal(accepted.Raw, duplicate.Raw) {
		t.Fatalf("the duplicate did not return the original receipt: %+v", duplicate.Receipt)
	}
	// A stale expected version conflicts.
	if _, err = service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-rejected-stale", online.SeatBlack, 1, "e7e5")); !errors.Is(err, online.ErrConflict) {
		t.Fatalf("a stale move = %v, want ErrConflict", err)
	}
	// The wrong seat cannot move.
	if _, err = service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-rejected-wrong-seat", online.SeatWhite, 2, "d2d4")); !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("a wrong-seat move = %v, want ErrActionNotAllowed", err)
	}
	// A foreign participant cannot move.
	charlie := online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_c"}
	if _, err = service.Execute(ctx, charlie, moveOnlineCommand(matchID, "op-rejected-foreign", online.SeatBlack, 2, "e7e5")); !errors.Is(err, online.ErrNotAuthorized) {
		t.Fatalf("a foreign move = %v, want ErrNotAuthorized", err)
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Version != afterOpening.Version || len(after.Moves) != len(afterOpening.Moves) {
		t.Fatalf("a rejected intent advanced the match: %+v", after)
	}
	if after.Clock.WhiteMs != afterOpening.Clock.WhiteMs || after.Clock.BlackMs != afterOpening.Clock.BlackMs {
		t.Fatalf("a rejected intent minted an increment: %+v -> %+v", afterOpening.Clock, after.Clock)
	}
	var receipts int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM online_operation_receipts WHERE scope_id=$1`, matchID).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if receipts != 2 {
		t.Fatalf("receipts = %d, want the creation and the accepted move only", receipts)
	}
}

// MAT-03: the private rules process refuses an illegal move, and the refusal
// advances nothing and mints no increment.
func TestPostgresOnlineIllegalMoveIsRefusedByTheRulesProcess(t *testing.T) {
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
	matchID := "match-illegal-move"
	create := createOnlineCommand(matchID, "op-illegal-create")
	create.Action.CreateMatch.TimeControl = online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000}
	if _, err = service.Execute(ctx, alice, create); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err = service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-illegal-white", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	before, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	// e2e5 is not a legal reply to e4.
	if _, err = service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-illegal-black", online.SeatBlack, 2, "e2e5")); !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("an illegal move = %v, want ErrActionNotAllowed", err)
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Version != before.Version || len(after.Moves) != len(before.Moves) {
		t.Fatalf("the illegal move advanced the match: %+v", after)
	}
	if after.Clock.WhiteMs != before.Clock.WhiteMs || after.Clock.BlackMs != before.Clock.BlackMs {
		t.Fatalf("the illegal move minted an increment: %+v -> %+v", before.Clock, after.Clock)
	}
}

// MAT-02: a cancellation before the seat's own first accepted move aborts the
// match, and a cancellation after it resigns.
func TestPostgresOnlineCancellationAbortsBeforeTheFirstMoveAndResignsAfter(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()

	// The seat that never moved cancels after the opponent moved: the match
	// aborts and stays unscored.
	abortMatch := "match-cancel-abort"
	createOnlineMatch(t, service, abortMatch, "op-cancel-abort-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(abortMatch, "op-cancel-abort-white", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	aborted, err := service.Execute(ctx, bob, cancelOnlineCommand(abortMatch, "op-cancel-abort-black", online.SeatBlack, 2))
	if err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if aborted.Receipt.Result == nil || aborted.Receipt.Result.Kind != online.ResultAbort || aborted.Receipt.Result.Reason != online.ReasonAbort {
		t.Fatalf("cancel receipt = %+v", aborted.Receipt)
	}
	abortedMatch, err := service.GetMatch(ctx, abortMatch)
	if err != nil {
		t.Fatal(err)
	}
	if abortedMatch.Status != online.MatchAborted {
		t.Fatalf("status = %q, want aborted", abortedMatch.Status)
	}
	projection, err := service.GetPublicProjection(ctx, abortMatch)
	if err != nil {
		t.Fatal(err)
	}
	if projection.Result.Kind != online.ResultAbort || projection.Result.Winner != nil {
		t.Fatalf("an aborted match must stay unscored: %+v", projection.Result)
	}

	// The seat that already moved cancels: the match is a resignation.
	resignMatch := "match-cancel-resign"
	createOnlineMatch(t, service, resignMatch, "op-cancel-resign-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(resignMatch, "op-cancel-resign-white", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(resignMatch, "op-cancel-resign-black", online.SeatBlack, 2, "e7e5")); err != nil {
		t.Fatalf("opening reply: %v", err)
	}
	resigned, err := service.Execute(ctx, alice, cancelOnlineCommand(resignMatch, "op-cancel-resign-white-cancel", online.SeatWhite, 3))
	if err != nil {
		t.Fatalf("cancel after a move: %v", err)
	}
	if resigned.Receipt.Result == nil || resigned.Receipt.Result.Kind != online.ResultWin ||
		resigned.Receipt.Result.Winner == nil || *resigned.Receipt.Result.Winner != online.SeatBlack ||
		resigned.Receipt.Result.Reason != online.ReasonResignation {
		t.Fatalf("cancel after a move = %+v, want a resignation", resigned.Receipt.Result)
	}
}

// MAT-02: a takeback that removes a seat's move from the current line does not
// erase the fact that the seat once moved, so the later cancellation resigns.
func TestPostgresOnlineCancellationAfterATakebackStillResigns(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-cancel-takeback"
	createOnlineMatch(t, service, matchID, "op-cancel-takeback-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-cancel-takeback-white", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-cancel-takeback-black", online.SeatBlack, 2, "e7e5")); err != nil {
		t.Fatalf("opening reply: %v", err)
	}
	// White offers a takeback of the position after its own opening move, so
	// Black's reply leaves the current line.
	if _, err := service.Execute(ctx, alice, offerTakebackOnlineCommand(matchID, "op-cancel-takeback-offer", online.SeatWhite, 3, 2)); err != nil {
		t.Fatalf("takeback offer: %v", err)
	}
	offer := pendingOffer(t, service, matchID, online.OfferTakeback)
	if _, err := service.Execute(ctx, bob, acceptTakebackOnlineCommand(matchID, "op-cancel-takeback-accept", online.SeatBlack, 4, offer.OfferID)); err != nil {
		t.Fatalf("takeback acceptance: %v", err)
	}
	afterTakeback, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if len(afterTakeback.Moves) != 1 {
		t.Fatalf("the takeback did not shorten the line: moves=%d", len(afterTakeback.Moves))
	}
	if !afterTakeback.Clock.WhiteMoved {
		t.Fatal("the takeback erased the historical first move of White")
	}
	// White cancels after the takeback. The seat once had an accepted move,
	// so the cancellation resigns instead of aborting.
	cancelled, err := service.Execute(ctx, alice, cancelOnlineCommand(matchID, "op-cancel-takeback-cancel", online.SeatWhite, 5))
	if err != nil {
		t.Fatalf("cancel after a takeback: %v", err)
	}
	if cancelled.Receipt.Result == nil || cancelled.Receipt.Result.Kind != online.ResultWin ||
		cancelled.Receipt.Result.Winner == nil || *cancelled.Receipt.Result.Winner != online.SeatBlack ||
		cancelled.Receipt.Result.Reason != online.ReasonResignation {
		t.Fatalf("cancel after a takeback = %+v, want a resignation", cancelled.Receipt.Result)
	}
}

// MAT-11: a draw offer needs the other participant's acceptance, and an offer
// never pauses the clocks.
func TestPostgresOnlineDrawOfferNeedsMutualConsent(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-draw-offer"
	create := createOnlineCommand(matchID, "op-draw-create")
	create.Action.CreateMatch.TimeControl = online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000}
	if _, err := service.Execute(ctx, alice, create); err != nil {
		t.Fatalf("create: %v", err)
	}
	before, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	// A seat without an offer cannot accept a draw.
	if _, err = service.Execute(ctx, bob, acceptDrawOnlineCommand(matchID, "op-draw-no-offer", online.SeatBlack, 1, "offer-missing-0001")); !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("acceptance without an offer = %v, want ErrActionNotAllowed", err)
	}
	offered, err := service.Execute(ctx, alice, offerDrawOnlineCommand(matchID, "op-draw-offer", online.SeatWhite, 1))
	if err != nil {
		t.Fatalf("draw offer: %v", err)
	}
	// The offer is part of the versioned match state, so it advances the
	// canonical version without touching the clocks.
	if offered.Receipt.Version != before.Version+1 {
		t.Fatalf("the offer version = %d, want %d", offered.Receipt.Version, before.Version+1)
	}
	afterOffer, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if afterOffer.Status != online.MatchActive || afterOffer.Result != nil {
		t.Fatalf("the offer ended the match: %+v", afterOffer)
	}
	if afterOffer.Clock.WhiteMs != before.Clock.WhiteMs || afterOffer.Clock.BlackMs != before.Clock.BlackMs {
		t.Fatalf("the offer moved a clock: %+v -> %+v", before.Clock, afterOffer.Clock)
	}
	if afterOffer.Clock.TurnNumber != before.Clock.TurnNumber {
		t.Fatalf("the offer moved the turn: %+v -> %+v", before.Clock, afterOffer.Clock)
	}
	if len(afterOffer.Offers) != 1 || afterOffer.Offers[0].Kind != online.OfferDraw || afterOffer.Offers[0].Seat != online.SeatWhite {
		t.Fatalf("pending offers = %+v", afterOffer.Offers)
	}
	drawOffer := afterOffer.Offers[0]
	if drawOffer.BaseVersion != afterOffer.Version {
		t.Fatalf("the offer is not bound to the version it produced: %+v", drawOffer)
	}
	// The offering seat cannot accept its own offer.
	if _, err = service.Execute(ctx, alice, acceptDrawOnlineCommand(matchID, "op-draw-self-accept", online.SeatWhite, afterOffer.Version, drawOffer.OfferID)); !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("self acceptance = %v, want ErrActionNotAllowed", err)
	}
	accepted, err := service.Execute(ctx, bob, acceptDrawOnlineCommand(matchID, "op-draw-accept", online.SeatBlack, afterOffer.Version, drawOffer.OfferID))
	if err != nil {
		t.Fatalf("draw acceptance: %v", err)
	}
	if accepted.Receipt.Result == nil || accepted.Receipt.Result.Kind != online.ResultDraw || accepted.Receipt.Result.Reason != online.ReasonAgreement {
		t.Fatalf("draw result = %+v", accepted.Receipt.Result)
	}
	match, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.Status != online.MatchCompleted || match.Result == nil || match.Result.Kind != online.ResultDraw {
		t.Fatalf("match after the draw agreement = %+v", match)
	}
}

// MAT-11: an exact-version takeback restores the position without refunding
// time or minting an increment, and the increment that was credited to a
// discarded move is removed again. The discarded accepted moves stay in the
// table.
func TestPostgresOnlineTakebackRestoresThePositionWithoutRefunding(t *testing.T) {
	service, pool := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-takeback"
	create := createOnlineCommand(matchID, "op-takeback-create")
	create.Action.CreateMatch.TimeControl = online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000}
	if _, err := service.Execute(ctx, alice, create); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-takeback-white-1", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-takeback-black-1", online.SeatBlack, 2, "e7e5")); err != nil {
		t.Fatalf("opening reply: %v", err)
	}
	// The reply starts White's main clock. Its start is read so the charge of
	// the next accepted move is exact.
	var whiteClockStart time.Time
	if err := pool.QueryRow(ctx, `SELECT active_since FROM online_clocks WHERE match_id=$1`, matchID).Scan(&whiteClockStart); err != nil {
		t.Fatal(err)
	}
	second, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-takeback-white-2", online.SeatWhite, 3, "g1f3"))
	if err != nil {
		t.Fatalf("second white move: %v", err)
	}
	before, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if len(before.Moves) != 3 {
		t.Fatalf("moves before the takeback = %d", len(before.Moves))
	}
	// White's bank lost the thinking time of its own move and gained the
	// increment once. The opening move already credited one increment.
	whiteCharge := second.Receipt.DecidedAt.Sub(whiteClockStart).Milliseconds()
	whiteBefore := int64(302_000) - whiteCharge + 2_000
	if before.Clock.WhiteMs != whiteBefore {
		t.Fatalf("white bank = %d, want %d", before.Clock.WhiteMs, whiteBefore)
	}
	if before.Clock.BlackMs != 302_000 {
		t.Fatalf("black bank = %d, want 302000", before.Clock.BlackMs)
	}
	// White asks for the position after its own opening move back.
	if _, err = service.Execute(ctx, alice, offerTakebackOnlineCommand(matchID, "op-takeback-offer", online.SeatWhite, 4, 2)); err != nil {
		t.Fatalf("takeback offer: %v", err)
	}
	offer := pendingOffer(t, service, matchID, online.OfferTakeback)
	// Black's clock runs from White's second move, and the takeback charges
	// it. Its start is read so the charge is exact.
	var blackClockStart time.Time
	if err := pool.QueryRow(ctx, `SELECT active_since FROM online_clocks WHERE match_id=$1`, matchID).Scan(&blackClockStart); err != nil {
		t.Fatal(err)
	}
	accepted, err := service.Execute(ctx, bob, acceptTakebackOnlineCommand(matchID, "op-takeback-accept", online.SeatBlack, 5, offer.OfferID))
	if err != nil {
		t.Fatalf("takeback acceptance: %v", err)
	}
	if accepted.Receipt.Event == nil || accepted.Receipt.Event.Kind != online.EventTakebackAccept {
		t.Fatalf("takeback receipt = %+v", accepted.Receipt)
	}
	if accepted.Receipt.Event.TakebackTargetVersion == nil || *accepted.Receipt.Event.TakebackTargetVersion != 2 {
		t.Fatalf("takeback event = %+v", accepted.Receipt.Event)
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Moves) != 1 {
		t.Fatalf("the takeback did not restore the line: moves=%d", len(after.Moves))
	}
	if after.PositionFEN != before.Moves[0].ResultingFEN {
		t.Fatalf("the restored position = %q, want %q", after.PositionFEN, before.Moves[0].ResultingFEN)
	}
	if after.Clock.TurnNumber != int64(len(after.Moves)) {
		t.Fatalf("the turn number did not follow the accepted line: %d", after.Clock.TurnNumber)
	}
	// The elapsed time stays charged and the increment of every discarded
	// accepted move is removed again, so a replacement move receives exactly
	// one increment.
	blackCharge := accepted.Receipt.DecidedAt.Sub(blackClockStart).Milliseconds()
	if want := whiteBefore - 2_000; after.Clock.WhiteMs != want {
		t.Fatalf("white bank = %d, want %d", after.Clock.WhiteMs, want)
	}
	if want := int64(302_000) - blackCharge - 2_000; after.Clock.BlackMs != want {
		t.Fatalf("black bank = %d, want %d", after.Clock.BlackMs, want)
	}
	// The discarded accepted moves stay in the table and are marked discarded.
	var discarded int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM online_discarded_moves WHERE match_id=$1`, matchID).Scan(&discarded); err != nil {
		t.Fatal(err)
	}
	if discarded != 2 {
		t.Fatalf("discarded move records = %d, want the two moves after the target", discarded)
	}
	var kept int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM online_moves WHERE match_id=$1`, matchID).Scan(&kept); err != nil {
		t.Fatal(err)
	}
	if kept != 3 {
		t.Fatalf("accepted move records = %d, want the discarded moves preserved", kept)
	}
	// The discarded private archives of the moves survive in the same rows.
	var archive string
	if err = pool.QueryRow(ctx, `SELECT san FROM online_moves WHERE match_id=$1 AND version=4`, matchID).Scan(&archive); err != nil {
		t.Fatalf("the discarded move record is gone: %v", err)
	}
}

// MAT-11: a stale takeback offer cannot rewind later play, and it is no
// longer published as pending once the play made it inapplicable.
func TestPostgresOnlineStaleTakebackOfferCannotRewindLaterPlay(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-takeback-stale"
	createOnlineMatch(t, service, matchID, "op-takeback-stale-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-takeback-stale-white-1", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-takeback-stale-black-1", online.SeatBlack, 2, "e7e5")); err != nil {
		t.Fatalf("opening reply: %v", err)
	}
	if _, err := service.Execute(ctx, alice, offerTakebackOnlineCommand(matchID, "op-takeback-stale-offer", online.SeatWhite, 3, 2)); err != nil {
		t.Fatalf("takeback offer: %v", err)
	}
	offer := pendingOffer(t, service, matchID, online.OfferTakeback)
	// Play advances, so the offer no longer names the current position.
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-takeback-stale-white-2", online.SeatWhite, 4, "g1f3")); err != nil {
		t.Fatalf("white second move: %v", err)
	}
	before, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	// The inapplicable offer is no longer published as pending.
	if len(before.Offers) != 0 {
		t.Fatalf("the stale offer is still pending: %+v", before.Offers)
	}
	if _, err = service.Execute(ctx, bob, acceptTakebackOnlineCommand(matchID, "op-takeback-stale-accept", online.SeatBlack, 5, offer.OfferID)); !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("a stale takeback acceptance = %v, want ErrActionNotAllowed", err)
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Version != before.Version || len(after.Moves) != len(before.Moves) || after.PositionFEN != before.PositionFEN {
		t.Fatalf("the stale offer rewound the match: %+v", after)
	}
}

// MAT-11: a takeback offer must name a position in the current line.
func TestPostgresOnlineTakebackOfferRejectsAPositionOutsideTheLine(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-takeback-target"
	createOnlineMatch(t, service, matchID, "op-takeback-target-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-takeback-target-white-1", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-takeback-target-black-1", online.SeatBlack, 2, "e7e5")); err != nil {
		t.Fatalf("opening reply: %v", err)
	}
	// Version 2 is the position after the opening move, so it is a valid
	// target. Version 3 is the position after the reply, which would discard
	// nothing, and version 9 was never a position.
	if _, err := service.Execute(ctx, alice, offerTakebackOnlineCommand(matchID, "op-takeback-target-none", online.SeatWhite, 3, 3)); !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("a takeback offer without a move to discard = %v, want ErrActionNotAllowed", err)
	}
	if _, err := service.Execute(ctx, alice, offerTakebackOnlineCommand(matchID, "op-takeback-target-unknown", online.SeatWhite, 3, 9)); !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("a takeback offer for an unknown position = %v, want ErrActionNotAllowed", err)
	}
}

// MAT-11: the recovery budget of a turn survives a control change and a
// takeback that restores the turn, and only an accepted move of that seat
// starts it again.
func TestPostgresOnlineRecoveryBudgetsSurviveControlChangesAndTakebacks(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-recovery-budget"
	createOnlineMatch(t, service, matchID, "op-recovery-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-recovery-white-1", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-recovery-black-1", online.SeatBlack, 2, "e7e5")); err != nil {
		t.Fatalf("opening reply: %v", err)
	}
	// White is to move and spends an attempt.
	if _, err := service.Execute(ctx, alice, recoveryAttemptOnlineCommand(matchID, "op-recovery-attempt-1", online.SeatWhite, 3, online.RecoveryIllegalMove)); err != nil {
		t.Fatalf("recovery attempt: %v", err)
	}
	spent, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	seat, ok := spent.Seat(online.SeatWhite)
	if !ok || seat.IllegalAttemptsSpent != 1 {
		t.Fatalf("the spent budget was not recorded: %+v", seat)
	}
	// A control change does not reset the budget.
	label := "Declared Model"
	if _, err = service.Execute(ctx, alice, setControlOnlineCommand(matchID, "op-recovery-control", online.SeatWhite, 4, online.SeatControl{Kind: online.ControlAgent, ModelLabel: &label})); err != nil {
		t.Fatalf("control change: %v", err)
	}
	afterControl, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	seat, _ = afterControl.Seat(online.SeatWhite)
	if seat.IllegalAttemptsSpent != 1 {
		t.Fatalf("the control change reset the spent budget: %+v", seat)
	}
	// The accepted move of that seat starts the budget again. The control
	// change raised the control epoch, so the commands carry it.
	if _, err = service.Execute(ctx, alice, moveOnlineCommandAt(matchID, "op-recovery-white-2", online.SeatWhite, 5, 2, "g1f3")); err != nil {
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
	if _, err = service.Execute(ctx, bob, moveOnlineCommandAt(matchID, "op-recovery-black-2", online.SeatBlack, 6, 2, "b8c6")); err != nil {
		t.Fatalf("black second move: %v", err)
	}
	// A takeback of the position before White's own turn restores the turn it
	// spent the attempt in, so the budget is not reset either.
	if _, err = service.Execute(ctx, bob, offerTakebackOnlineCommandAt(matchID, "op-recovery-offer", online.SeatBlack, 7, 2, 3)); err != nil {
		t.Fatalf("takeback offer: %v", err)
	}
	offer := pendingOffer(t, service, matchID, online.OfferTakeback)
	if _, err = service.Execute(ctx, alice, acceptTakebackOnlineCommandAt(matchID, "op-recovery-accept", online.SeatWhite, 8, 2, offer.OfferID)); err != nil {
		t.Fatalf("takeback acceptance: %v", err)
	}
	afterTakeback, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	seat, _ = afterTakeback.Seat(online.SeatWhite)
	if seat.IllegalAttemptsSpent != 1 {
		t.Fatalf("the takeback reset the spent budget: %+v", seat)
	}
	// The restored turn is the one White spent the attempt in, so the next
	// attempt continues that turn instead of starting a fresh allowance.
	if _, err = service.Execute(ctx, alice, recoveryAttemptOnlineCommandAt(matchID, "op-recovery-attempt-2", online.SeatWhite, 9, 2, online.RecoveryIllegalMove)); err != nil {
		t.Fatalf("recovery attempt after the takeback: %v", err)
	}
	afterAttempt, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	seat, _ = afterAttempt.Seat(online.SeatWhite)
	if seat.IllegalAttemptsSpent != 2 {
		t.Fatalf("the restored turn did not keep its spent budget: %+v", seat)
	}
}

// MAT-10 boundary: the fourth illegal attempt of a turn loses the match for
// that seat, and the formatting budget is independent of it.
func TestPostgresOnlineFourthIllegalAttemptLosesTheMatch(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-illegal-loss"
	createOnlineMatch(t, service, matchID, "op-illegal-loss-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-illegal-loss-white-1", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-illegal-loss-black-1", online.SeatBlack, 2, "e7e5")); err != nil {
		t.Fatalf("opening reply: %v", err)
	}
	// The formatting budget is separate from the illegal move budget.
	for index := 0; index < online.MaxFormattingCorrections; index++ {
		if _, err := service.Execute(ctx, alice, recoveryAttemptOnlineCommand(matchID, fmt.Sprintf("op-illegal-loss-format-%d", index), online.SeatWhite, int64(3+index), online.RecoveryFormattingCorrection)); err != nil {
			t.Fatalf("formatting correction %d: %v", index, err)
		}
	}
	if _, err := service.Execute(ctx, alice, recoveryAttemptOnlineCommand(matchID, "op-illegal-loss-format-spent", online.SeatWhite, 6, online.RecoveryFormattingCorrection)); !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("a correction beyond the budget = %v, want ErrActionNotAllowed", err)
	}
	// The fourth illegal attempt loses the match.
	for index := 0; index < online.MaxIllegalMoveAttempts-1; index++ {
		version := int64(6 + index)
		if _, err := service.Execute(ctx, alice, recoveryAttemptOnlineCommand(matchID, fmt.Sprintf("op-illegal-loss-attempt-%d", index), online.SeatWhite, version, online.RecoveryIllegalMove)); err != nil {
			t.Fatalf("illegal attempt %d: %v", index, err)
		}
	}
	lost, err := service.Execute(ctx, alice, recoveryAttemptOnlineCommand(matchID, "op-illegal-loss-final", online.SeatWhite, 9, online.RecoveryIllegalMove))
	if err != nil {
		t.Fatalf("the fourth illegal attempt: %v", err)
	}
	if lost.Receipt.Result == nil || lost.Receipt.Result.Kind != online.ResultWin ||
		lost.Receipt.Result.Winner == nil || *lost.Receipt.Result.Winner != online.SeatBlack ||
		lost.Receipt.Result.Reason != online.ReasonIllegalMove {
		t.Fatalf("the fourth illegal attempt = %+v, want a loss", lost.Receipt.Result)
	}
	match, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.Status != online.MatchCompleted || match.Result == nil {
		t.Fatalf("match after the illegal move loss = %+v", match)
	}
}

// MAT-08: a control change does not pause or refund the chess clock.
func TestPostgresOnlineControlChangeKeepsTheClockRunning(t *testing.T) {
	service, pool := onlineService(t, timeoutEvaluator{winnerFor: timeoutWinForOpponent})
	ctx := context.Background()
	matchID := "match-clock-continuity"
	create := createOnlineCommand(matchID, "op-clock-create")
	create.Action.CreateMatch.TimeControl = online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000}
	if _, err := service.Execute(ctx, alice, create); err != nil {
		t.Fatalf("create: %v", err)
	}
	playOpeningExchange(t, service, matchID, "op-clock")
	before, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if before.Clock.ActiveSeat == nil || before.Clock.DeadlineAt == nil {
		t.Fatalf("the opening reply did not start a main clock: %+v", before.Clock)
	}
	label := "Declared Model"
	if _, err = service.Execute(ctx, alice, setControlOnlineCommand(matchID, "op-clock-control", online.SeatWhite, 3, online.SeatControl{Kind: online.ControlAgent, ModelLabel: &label})); err != nil {
		t.Fatalf("control change: %v", err)
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Clock.ActiveSeat == nil || *after.Clock.ActiveSeat != *before.Clock.ActiveSeat {
		t.Fatalf("the control change moved the active seat: %+v", after.Clock)
	}
	if after.Clock.ActiveSince == nil || !after.Clock.ActiveSince.Equal(*before.Clock.ActiveSince) {
		t.Fatalf("the control change restarted the clock: %+v", after.Clock)
	}
	if after.Clock.DeadlineAt == nil || !after.Clock.DeadlineAt.Equal(*before.Clock.DeadlineAt) {
		t.Fatalf("the control change moved the deadline: %+v", after.Clock)
	}
	if after.Clock.WhiteMs != before.Clock.WhiteMs || after.Clock.BlackMs != before.Clock.BlackMs {
		t.Fatalf("the control change refunded a bank: %+v -> %+v", before.Clock, after.Clock)
	}
	// The clock still expires on its own deadline.
	expireMainClock(t, pool, matchID)
	late, err := service.Execute(ctx, alice, moveOnlineCommandAt(matchID, "op-clock-late", online.SeatWhite, 4, 2, "g1f3"))
	if err != nil {
		t.Fatalf("the late intent: %v", err)
	}
	if late.Receipt.Outcome != online.OutcomeDeadlineExpired {
		t.Fatalf("outcome = %q, want deadline_expired", late.Receipt.Outcome)
	}
	afterExpiry, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if afterExpiry.Clock.WhiteMs != 0 {
		t.Fatalf("the expired bank = %d, want zero", afterExpiry.Clock.WhiteMs)
	}
}

// MAT-08: the clock keeps running while no intent arrives. The deadline is
// absolute, so the elapsed time is charged at the next accepted move.
func TestPostgresOnlineClockKeepsRunningWhileNoIntentArrives(t *testing.T) {
	service, pool := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-clock-running"
	create := createOnlineCommand(matchID, "op-clock-running-create")
	create.Action.CreateMatch.TimeControl = online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000}
	if _, err := service.Execute(ctx, alice, create); err != nil {
		t.Fatalf("create: %v", err)
	}
	playOpeningExchange(t, service, matchID, "op-clock-running")
	before, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if before.Clock.ActiveSeat == nil || *before.Clock.ActiveSeat != online.SeatWhite {
		t.Fatalf("the opening reply did not start White's main clock: %+v", before.Clock)
	}
	// White thinks for ten seconds without sending an intent.
	if _, err = pool.Exec(ctx, `UPDATE online_clocks SET active_since=active_since-$1::interval WHERE match_id=$2`, "10 seconds", matchID); err != nil {
		t.Fatal(err)
	}
	if _, err = service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-clock-running-white-second", online.SeatWhite, 3, "g1f3")); err != nil {
		t.Fatalf("accepted move: %v", err)
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	// The bank lost the thinking time and gained the increment once.
	if after.Clock.WhiteMs > before.Clock.WhiteMs-10_000+2_000 {
		t.Fatalf("the bank = %d, want at least the ten seconds of thinking deducted", after.Clock.WhiteMs)
	}
	if after.Clock.WhiteMs < before.Clock.WhiteMs-11_000+2_000 {
		t.Fatalf("the bank = %d, want the ten seconds of thinking deducted and one increment added", after.Clock.WhiteMs)
	}
}

// MAT-11: play that continues after a draw offer declines it, so the offer
// never survives an accepted move.
func TestPostgresOnlineAcceptedMoveWithdrawsAPendingDrawOffer(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-draw-withdrawn"
	createOnlineMatch(t, service, matchID, "op-draw-withdrawn-create")
	if _, err := service.Execute(ctx, alice, offerDrawOnlineCommand(matchID, "op-draw-withdrawn-offer", online.SeatWhite, 1)); err != nil {
		t.Fatalf("draw offer: %v", err)
	}
	offer := pendingOffer(t, service, matchID, online.OfferDraw)
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-draw-withdrawn-white", online.SeatWhite, 2, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Offers) != 0 {
		t.Fatalf("the accepted move left %d pending offers", len(after.Offers))
	}
	if _, err = service.Execute(ctx, bob, acceptDrawOnlineCommand(matchID, "op-draw-withdrawn-accept", online.SeatBlack, 3, offer.OfferID)); !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("accepting a withdrawn offer = %v, want ErrActionNotAllowed", err)
	}
	match, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.Status != online.MatchActive || match.Result != nil {
		t.Fatalf("the withdrawn offer ended the match: %+v", match)
	}
}

// MAT-12: a finished match has no pending offer.
func TestPostgresOnlineFinishedMatchHasNoPendingOffer(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-offer-finished"
	createOnlineMatch(t, service, matchID, "op-offer-finished-create")
	if _, err := service.Execute(ctx, alice, offerDrawOnlineCommand(matchID, "op-offer-finished-offer", online.SeatWhite, 1)); err != nil {
		t.Fatalf("draw offer: %v", err)
	}
	if _, err := service.Execute(ctx, bob, resignOnlineCommand(matchID, "op-offer-finished-resign", online.SeatBlack, 2)); err != nil {
		t.Fatalf("resign: %v", err)
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != online.MatchCompleted {
		t.Fatalf("status = %q, want completed", after.Status)
	}
	if len(after.Offers) != 0 {
		t.Fatalf("the finished match still shows %d pending offers", len(after.Offers))
	}
}

// MAT-04: the expiry is reconciled before any other refusal, so a late,
// stale or wrong-seat intent settles the match the same way as a late legal
// move.
func TestPostgresOnlineExpiredClockSettlesEvenWhenTheIntentIsRefused(t *testing.T) {
	service, pool := onlineService(t, timeoutEvaluator{winnerFor: timeoutWinForOpponent})
	ctx := context.Background()
	matchID := "match-expired-refusal"
	createOnlineMatch(t, service, matchID, "op-expired-refusal-create")
	playOpeningExchange(t, service, matchID, "op-expired-refusal")
	expireMainClock(t, pool, matchID)
	// Black is not the side to move, so the intent is refused, but the expired
	// clock still settles the match.
	late, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-expired-refusal-late", online.SeatBlack, 3, "e7e5"))
	if err != nil {
		t.Fatalf("the late intent: %v", err)
	}
	if late.Receipt.Outcome != online.OutcomeDeadlineExpired {
		t.Fatalf("outcome = %q, want deadline_expired", late.Receipt.Outcome)
	}
	match, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.Status != online.MatchCompleted || match.Result == nil || match.Result.Reason != online.ReasonTimeout {
		t.Fatalf("match after the refused intent = %+v", match)
	}
	if len(match.Moves) != 2 {
		t.Fatalf("the refused intent became a move: moves=%d", len(match.Moves))
	}
}

// MAT-02: the cancellation is recorded as its own event, so the audit trail
// separates it from an explicit resignation.
func TestPostgresOnlineCancellationIsRecordedAsItsOwnEvent(t *testing.T) {
	service, pool := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-cancel-event"
	createOnlineMatch(t, service, matchID, "op-cancel-event-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-cancel-event-white", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	if _, err := service.Execute(ctx, bob, cancelOnlineCommand(matchID, "op-cancel-event-black", online.SeatBlack, 2)); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	var kind string
	if err := pool.QueryRow(ctx, `SELECT event_kind FROM online_events WHERE match_id=$1 AND version=3`, matchID).Scan(&kind); err != nil {
		t.Fatal(err)
	}
	if kind != "cancel" {
		t.Fatalf("the cancellation event = %q, want cancel", kind)
	}
}

// MAT-12: a final result cannot be overwritten by later intents.
func TestPostgresOnlineFinalResultCannotBeOverwritten(t *testing.T) {
	service, pool := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-final-result"
	createOnlineMatch(t, service, matchID, "op-final-create")
	if _, err := service.Execute(ctx, alice, resignOnlineCommand(matchID, "op-final-resign", online.SeatWhite, 1)); err != nil {
		t.Fatalf("resign: %v", err)
	}
	final, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if final.Status != online.MatchCompleted || final.Result == nil || final.Result.Reason != online.ReasonResignation {
		t.Fatalf("match after the resignation = %+v", final)
	}
	for name, command := range map[string]online.Command{
		"move":            moveOnlineCommand(matchID, "op-final-move", online.SeatBlack, 2, "e7e5"),
		"cancel":          cancelOnlineCommand(matchID, "op-final-cancel", online.SeatBlack, 2),
		"offer draw":      offerDrawOnlineCommand(matchID, "op-final-offer", online.SeatBlack, 2),
		"accept draw":     acceptDrawOnlineCommand(matchID, "op-final-accept", online.SeatBlack, 2, "offer-final-0001"),
		"accept takeback": acceptTakebackOnlineCommand(matchID, "op-final-takeback", online.SeatBlack, 2, "offer-final-0001"),
		"recovery":        recoveryAttemptOnlineCommand(matchID, "op-final-recovery", online.SeatBlack, 2, online.RecoveryIllegalMove),
	} {
		if _, err = service.Execute(ctx, bob, command); !errors.Is(err, online.ErrMatchEnded) {
			t.Fatalf("%s after the final result = %v, want ErrMatchEnded", name, err)
		}
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != final.Status || after.Result == nil || after.Result.Kind != final.Result.Kind ||
		after.Result.Reason != final.Result.Reason || (after.Result.Winner == nil) != (final.Result.Winner == nil) ||
		(after.Result.Winner != nil && *after.Result.Winner != *final.Result.Winner) {
		t.Fatalf("the final result changed: %+v -> %+v", final.Result, after.Result)
	}
	if after.Version != final.Version {
		t.Fatalf("the final match version changed to %d", after.Version)
	}
	// The stored result is immutable in the database as well.
	if _, err = pool.Exec(ctx, `UPDATE online_matches SET result='{"kind":"draw","winner":null,"reason":"agreement"}'::jsonb WHERE match_id=$1`, matchID); err == nil {
		t.Fatal("the stored final result was rewritten")
	}
}

// MAT-11 and MAT-12: a late rules candidate evaluated against a position
// before a takeback cannot change the later position.
func TestPostgresOnlineLateRulesCandidateCannotChangeThePositionAfterATakeback(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-late-candidate"
	createOnlineMatch(t, service, matchID, "op-late-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-late-white-1", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-late-black-1", online.SeatBlack, 2, "e7e5")); err != nil {
		t.Fatalf("opening reply: %v", err)
	}
	// A candidate evaluated against the position before the takeback.
	stale := online.Candidate{
		SchemaVersion:      online.RulesInputSchemaVersion,
		EvaluatedVersion:   3,
		EvaluatedInputHash: "b" + strings.Repeat("0", 63),
		ControlEpoch:       1,
		Move:               &online.Move{Seat: online.SeatWhite, UCI: "g1f3", SAN: "Nf3", ResultingFEN: fakePositionFEN(online.SeatBlack)},
	}
	if _, err := service.ApplyWorkerCandidate(ctx, alice, moveOnlineCommand(matchID, "op-late-candidate", online.SeatWhite, 3, "g1f3"), stale); !errors.Is(err, online.ErrStaleCandidate) {
		t.Fatalf("a stale candidate = %v, want ErrStaleCandidate", err)
	}
	match, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.Version != 3 || len(match.Moves) != 2 {
		t.Fatalf("the stale candidate changed the match: %+v", match)
	}
}

// ARC-04: a retried offer returns the original receipt, and a changed payload
// with the same operation ID fails.
func TestPostgresOnlineOfferReceiptsAreIdempotent(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-offer-receipt"
	createOnlineMatch(t, service, matchID, "op-offer-receipt-create")
	offer := offerDrawOnlineCommand(matchID, "op-offer-receipt", online.SeatWhite, 1)
	accepted, err := service.Execute(ctx, alice, offer)
	if err != nil {
		t.Fatalf("draw offer: %v", err)
	}
	retry, err := service.Execute(ctx, alice, offer)
	if err != nil {
		t.Fatalf("draw offer retry: %v", err)
	}
	if !retry.Duplicate || !bytes.Equal(accepted.Raw, retry.Raw) {
		t.Fatalf("the retried offer did not return the original receipt: %+v", retry.Receipt)
	}
	changed := offer
	changed.Action = online.Action{Kind: online.ActionResign}
	if _, err = service.Execute(ctx, alice, changed); !errors.Is(err, online.ErrOperationReuse) {
		t.Fatalf("a changed payload with the same operation ID = %v, want ErrOperationReuse", err)
	}
	stored, err := service.GetReceipt(ctx, matchID, "op-offer-receipt")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accepted.Raw, stored.Raw) {
		t.Fatal("the stored receipt changed")
	}
}

// The pending offers of a match are readable by both participants, carry the
// identity a consent names, and carry no private identity.
func TestPostgresOnlinePendingOffersAreVisibleToBothParticipants(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-offer-visible"
	createOnlineMatch(t, service, matchID, "op-offer-visible-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-offer-visible-white", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-offer-visible-black", online.SeatBlack, 2, "e7e5")); err != nil {
		t.Fatalf("opening reply: %v", err)
	}
	if _, err := service.Execute(ctx, alice, offerTakebackOnlineCommand(matchID, "op-offer-visible-offer", online.SeatWhite, 3, 1)); err != nil {
		t.Fatalf("takeback offer: %v", err)
	}
	for name, participant := range map[string]online.ParticipantRef{"white": alice, "black": bob} {
		view, err := service.GetMatchForParticipant(ctx, matchID, participant)
		if err != nil {
			t.Fatalf("%s participant read: %v", name, err)
		}
		if len(view.Offers) != 1 {
			t.Fatalf("%s participant sees %d offers", name, len(view.Offers))
		}
		offer := view.Offers[0]
		if offer.Kind != online.OfferTakeback || offer.Seat != online.SeatWhite || offer.TargetVersion == nil || *offer.TargetVersion != 1 {
			t.Fatalf("%s participant sees %+v", name, offer)
		}
		if offer.OfferID == "" {
			t.Fatalf("%s participant sees an offer without an identity", name)
		}
		if offer.BaseVersion != view.Version {
			t.Fatalf("%s participant sees base version %d, want the version the offer produced %d", name, offer.BaseVersion, view.Version)
		}
	}
}
