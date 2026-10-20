package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/jackc/pgx/v5/pgxpool"
)

// KHA-68 corrections: the consent of an offer is bound to the exact offered
// identity, an offer is part of the versioned match state, a takeback keeps
// the recovery budget of the turn it restores, and the opening exchange
// cannot be taken back.

// clockStart reads the start of the running clock, so the charge of the next
// decision is exact.
func clockStart(t *testing.T, pool *pgxpool.Pool, matchID string) time.Time {
	t.Helper()
	var start time.Time
	if err := pool.QueryRow(context.Background(), `SELECT active_since FROM online_clocks WHERE match_id=$1`, matchID).Scan(&start); err != nil {
		t.Fatal(err)
	}
	return start.UTC()
}

// The consent of a takeback is bound to the exact offer the acceptor saw. A
// replaced offer is refused instead of accepting a different offer.
func TestPostgresOnlineTakebackConsentIsBoundToTheExactOffer(t *testing.T) {
	service, pool := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-takeback-consent"
	createOnlineMatch(t, service, matchID, "op-consent-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-consent-white-1", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-consent-black-1", online.SeatBlack, 2, "e7e5")); err != nil {
		t.Fatalf("opening reply: %v", err)
	}
	// White asks for the position after its own opening move back.
	if _, err := service.Execute(ctx, alice, offerTakebackOnlineCommand(matchID, "op-consent-offer-a", online.SeatWhite, 3, 2)); err != nil {
		t.Fatalf("takeback offer: %v", err)
	}
	first := pendingOffer(t, service, matchID, online.OfferTakeback)
	// White replaces the offer with one that rewinds further.
	if _, err := service.Execute(ctx, alice, offerTakebackOnlineCommand(matchID, "op-consent-offer-b", online.SeatWhite, 4, 1)); err != nil {
		t.Fatalf("replacement takeback offer: %v", err)
	}
	second := pendingOffer(t, service, matchID, online.OfferTakeback)
	if second.OfferID == first.OfferID {
		t.Fatal("the replacement offer reused the identity of the replaced offer")
	}
	before, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	// The consent of the replaced offer is refused, and the match does not
	// rewind.
	if _, err = service.Execute(ctx, bob, acceptTakebackOnlineCommand(matchID, "op-consent-accept-a", online.SeatBlack, 5, first.OfferID)); !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("the acceptance of a replaced offer = %v, want ErrActionNotAllowed", err)
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Version != before.Version || len(after.Moves) != len(before.Moves) || after.PositionFEN != before.PositionFEN {
		t.Fatalf("the replaced offer was applied: %+v", after)
	}
	// The consent of the live offer is applied, and it restores exactly the
	// position that offer named.
	accepted, err := service.Execute(ctx, bob, acceptTakebackOnlineCommand(matchID, "op-consent-accept-b", online.SeatBlack, 5, second.OfferID))
	if err != nil {
		t.Fatalf("takeback acceptance: %v", err)
	}
	if accepted.Receipt.Event == nil || accepted.Receipt.Event.TakebackTargetVersion == nil || *accepted.Receipt.Event.TakebackTargetVersion != 1 {
		t.Fatalf("the acceptance restored another offer: %+v", accepted.Receipt.Event)
	}
	restored, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if len(restored.Moves) != 0 {
		t.Fatalf("the takeback did not restore the line: moves=%d", len(restored.Moves))
	}
	if restored.PositionFEN != restored.StartingFEN {
		t.Fatalf("the restored position = %q, want the starting position", restored.PositionFEN)
	}
	// The accepted offer is resolved once, and the replaced offer keeps its
	// own resolution.
	var resolutions map[string]string
	rows, err := pool.Query(ctx, `SELECT offer_id,resolution FROM online_offers WHERE match_id=$1`, matchID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	resolutions = map[string]string{}
	for rows.Next() {
		var id, resolution string
		if err = rows.Scan(&id, &resolution); err != nil {
			t.Fatal(err)
		}
		resolutions[id] = resolution
	}
	if resolutions[second.OfferID] != string(online.OfferAccepted) {
		t.Fatalf("the accepted offer resolution = %q", resolutions[second.OfferID])
	}
	if resolutions[first.OfferID] != string(online.OfferSuperseded) {
		t.Fatalf("the replaced offer resolution = %q", resolutions[first.OfferID])
	}
}

// A consumed or unknown offer is refused. The acceptance never applies an
// offer that was not the one that was named.
func TestPostgresOnlineTakebackConsentRefusesAConsumedOrUnknownOffer(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-takeback-consumed"
	createOnlineMatch(t, service, matchID, "op-consumed-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-consumed-white-1", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-consumed-black-1", online.SeatBlack, 2, "e7e5")); err != nil {
		t.Fatalf("opening reply: %v", err)
	}
	if _, err := service.Execute(ctx, bob, offerTakebackOnlineCommand(matchID, "op-consumed-offer", online.SeatBlack, 3, 1)); err != nil {
		t.Fatalf("takeback offer: %v", err)
	}
	offer := pendingOffer(t, service, matchID, online.OfferTakeback)
	if _, err := service.Execute(ctx, alice, acceptTakebackOnlineCommand(matchID, "op-consumed-accept", online.SeatWhite, 4, offer.OfferID)); err != nil {
		t.Fatalf("takeback acceptance: %v", err)
	}
	accepted, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	// The consumed offer is refused a second time.
	if _, err = service.Execute(ctx, alice, acceptTakebackOnlineCommand(matchID, "op-consumed-accept-again", online.SeatWhite, accepted.Version, offer.OfferID)); !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("the acceptance of a consumed offer = %v, want ErrActionNotAllowed", err)
	}
	// An unknown offer identity is refused.
	if _, err = service.Execute(ctx, alice, acceptTakebackOnlineCommand(matchID, "op-consumed-accept-unknown", online.SeatWhite, accepted.Version, "offer-unknown-0001")); !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("the acceptance of an unknown offer = %v, want ErrActionNotAllowed", err)
	}
	// The offering seat cannot accept its own offer.
	if _, err = service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-consumed-white-2", online.SeatWhite, accepted.Version, "e2e4")); err != nil {
		t.Fatalf("white second move: %v", err)
	}
	offered, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.Execute(ctx, bob, offerTakebackOnlineCommand(matchID, "op-consumed-offer-own", online.SeatBlack, offered.Version, 1)); err != nil {
		t.Fatalf("takeback offer: %v", err)
	}
	own := pendingOffer(t, service, matchID, online.OfferTakeback)
	if _, err = service.Execute(ctx, bob, acceptTakebackOnlineCommand(matchID, "op-consumed-accept-own", online.SeatBlack, offered.Version+1, own.OfferID)); !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("the self acceptance = %v, want ErrActionNotAllowed", err)
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Version != offered.Version+1 || len(after.Moves) != len(offered.Moves) {
		t.Fatalf("a refused acceptance changed the match: %+v", after)
	}
}

// The consent of a draw offer is bound to the exact offered identity too.
func TestPostgresOnlineDrawConsentIsBoundToTheExactOffer(t *testing.T) {
	service, pool := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-draw-consent"
	createOnlineMatch(t, service, matchID, "op-draw-consent-create")
	if _, err := service.Execute(ctx, alice, offerDrawOnlineCommand(matchID, "op-draw-consent-offer", online.SeatWhite, 1)); err != nil {
		t.Fatalf("draw offer: %v", err)
	}
	offer := pendingOffer(t, service, matchID, online.OfferDraw)
	before, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	// A different offer identity is refused.
	if _, err = service.Execute(ctx, bob, acceptDrawOnlineCommand(matchID, "op-draw-consent-wrong", online.SeatBlack, before.Version, "offer-unknown-0001")); !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("the acceptance of another offer = %v, want ErrActionNotAllowed", err)
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != online.MatchActive || after.Version != before.Version {
		t.Fatalf("the refused acceptance changed the match: %+v", after)
	}
	// The named offer is accepted and resolved as accepted.
	if _, err = service.Execute(ctx, bob, acceptDrawOnlineCommand(matchID, "op-draw-consent-accept", online.SeatBlack, before.Version, offer.OfferID)); err != nil {
		t.Fatalf("draw acceptance: %v", err)
	}
	var resolution string
	if err = pool.QueryRow(ctx, `SELECT resolution FROM online_offers WHERE offer_id=$1`, offer.OfferID).Scan(&resolution); err != nil {
		t.Fatal(err)
	}
	if resolution != string(online.OfferAccepted) {
		t.Fatalf("the accepted offer resolution = %q", resolution)
	}
	finished, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if finished.Result == nil || finished.Result.Kind != online.ResultDraw {
		t.Fatalf("the accepted draw = %+v", finished.Result)
	}
	if len(finished.Offers) != 0 {
		t.Fatalf("the finished match still shows %d pending offers", len(finished.Offers))
	}
}

// An offer is part of the versioned match state. It advances the canonical
// version, records its own event, and leaves the clocks, the turn and the
// recovery budgets untouched.
func TestPostgresOnlineOfferAdvancesTheVersionAndRecordsAnEvent(t *testing.T) {
	service, pool := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-offer-version"
	create := createOnlineCommand(matchID, "op-offer-version-create")
	create.Action.CreateMatch.TimeControl = online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000}
	if _, err := service.Execute(ctx, alice, create); err != nil {
		t.Fatalf("create: %v", err)
	}
	before, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	offered, err := service.Execute(ctx, alice, offerDrawOnlineCommand(matchID, "op-offer-version-offer", online.SeatWhite, before.Version))
	if err != nil {
		t.Fatalf("draw offer: %v", err)
	}
	if offered.Receipt.Version != before.Version+1 {
		t.Fatalf("the offer version = %d, want %d", offered.Receipt.Version, before.Version+1)
	}
	if offered.Receipt.Event == nil || offered.Receipt.Event.Kind != online.EventOfferCreated {
		t.Fatalf("the offer receipt = %+v", offered.Receipt)
	}
	if offered.Receipt.Event.Offer == nil || offered.Receipt.Event.Offer.OfferID == "" {
		t.Fatalf("the offer event carries no offer: %+v", offered.Receipt.Event)
	}
	if offered.Receipt.Event.Offer.BaseVersion != offered.Receipt.Version {
		t.Fatalf("the offer is not bound to the version it produced: %+v", offered.Receipt.Event.Offer)
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Clock.WhiteMs != before.Clock.WhiteMs || after.Clock.BlackMs != before.Clock.BlackMs {
		t.Fatalf("the offer moved a bank: %+v -> %+v", before.Clock, after.Clock)
	}
	if after.Clock.ActiveSeat != before.Clock.ActiveSeat || after.Clock.DeadlineAt != before.Clock.DeadlineAt {
		t.Fatalf("the offer moved the running clock: %+v -> %+v", before.Clock, after.Clock)
	}
	if after.Clock.TurnNumber != before.Clock.TurnNumber {
		t.Fatalf("the offer moved the turn: %+v -> %+v", before.Clock, after.Clock)
	}
	if len(after.Moves) != len(before.Moves) {
		t.Fatalf("the offer changed the line: %+v", after)
	}
	// The event is durable and carries the offer.
	var kind string
	var payload []byte
	if err = pool.QueryRow(ctx, `SELECT event_kind,offer_json FROM online_events WHERE match_id=$1 AND version=$2`, matchID, after.Version).Scan(&kind, &payload); err != nil {
		t.Fatal(err)
	}
	if kind != string(online.EventOfferCreated) {
		t.Fatalf("the offer event kind = %q", kind)
	}
	var stored online.Offer
	if err = json.Unmarshal(payload, &stored); err != nil {
		t.Fatal(err)
	}
	if stored.OfferID != offered.Receipt.Event.Offer.OfferID || stored.Kind != online.OfferDraw {
		t.Fatalf("the offer event payload = %+v", stored)
	}
	if stored.BaseVersion != after.Version {
		t.Fatalf("the stored offer is not bound to the version it produced: %+v", stored)
	}
	// A late rules candidate evaluated before the offer cannot change the
	// position any more.
	stale := online.Candidate{
		SchemaVersion:      online.RulesInputSchemaVersion,
		EvaluatedVersion:   before.Version,
		EvaluatedInputHash: "b" + strings.Repeat("0", 63),
		ControlEpoch:       1,
		Move:               &online.Move{Seat: online.SeatWhite, UCI: "e2e4", SAN: "e4", ResultingFEN: fakePositionFEN(online.SeatBlack)},
	}
	if _, err = service.ApplyWorkerCandidate(ctx, alice, moveOnlineCommand(matchID, "op-offer-version-stale", online.SeatWhite, before.Version, "e2e4"), stale); !errors.Is(err, online.ErrConflict) && !errors.Is(err, online.ErrStaleCandidate) {
		t.Fatalf("a late candidate after an offer = %v, want a conflict or a stale candidate", err)
	}
	unchanged, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged.Version != after.Version || len(unchanged.Moves) != len(after.Moves) {
		t.Fatalf("the late candidate changed the match: %+v", unchanged)
	}
}

// The increment of a discarded accepted move is removed again, so a
// replacement move receives exactly one increment and a repeated takeback
// cannot inflate a bank.
func TestPostgresOnlineTakebackRemovesTheDiscardedIncrement(t *testing.T) {
	service, pool := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-takeback-increment"
	create := createOnlineCommand(matchID, "op-increment-create")
	create.Action.CreateMatch.TimeControl = online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000}
	if _, err := service.Execute(ctx, alice, create); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-increment-white-1", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-increment-black-1", online.SeatBlack, 2, "e7e5")); err != nil {
		t.Fatalf("opening reply: %v", err)
	}
	// The reply starts White's main clock, so its start is read to make the
	// charge of the takeback exact.
	whiteStart := clockStart(t, pool, matchID)
	if _, err := service.Execute(ctx, alice, offerTakebackOnlineCommand(matchID, "op-increment-offer", online.SeatWhite, 3, 1)); err != nil {
		t.Fatalf("takeback offer: %v", err)
	}
	offer := pendingOffer(t, service, matchID, online.OfferTakeback)
	accepted, err := service.Execute(ctx, bob, acceptTakebackOnlineCommand(matchID, "op-increment-accept", online.SeatBlack, 4, offer.OfferID))
	if err != nil {
		t.Fatalf("takeback acceptance: %v", err)
	}
	// Both discarded moves credited one increment each. They are removed
	// again, while the elapsed time that was already charged stays charged.
	charge := accepted.Receipt.DecidedAt.Sub(whiteStart).Milliseconds()
	wantWhite := int64(300_000) - charge
	wantBlack := int64(300_000)
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Clock.WhiteMs != wantWhite {
		t.Fatalf("white bank = %d, want %d", after.Clock.WhiteMs, wantWhite)
	}
	if after.Clock.BlackMs != wantBlack {
		t.Fatalf("black bank = %d, want %d", after.Clock.BlackMs, wantBlack)
	}
	// The replacement move is a new accepted move and receives exactly one
	// increment.
	replayStart := clockStart(t, pool, matchID)
	replayed, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-increment-replay", online.SeatWhite, 5, "e2e4"))
	if err != nil {
		t.Fatalf("replacement move: %v", err)
	}
	replayCharge := replayed.Receipt.DecidedAt.Sub(replayStart).Milliseconds()
	wantReplay := wantWhite - replayCharge + 2_000
	afterReplay, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if afterReplay.Clock.WhiteMs != wantReplay {
		t.Fatalf("white bank after the replacement = %d, want %d", afterReplay.Clock.WhiteMs, wantReplay)
	}
	if afterReplay.Clock.BlackMs != wantBlack {
		t.Fatalf("black bank after the replacement = %d, want %d", afterReplay.Clock.BlackMs, wantBlack)
	}
	// A repeated takeback removes the increment of every discarded move again,
	// so the banks never grow above the line without a takeback.
	blackStart := clockStart(t, pool, matchID)
	blackMove, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-increment-black-2", online.SeatBlack, 6, "b8c6"))
	if err != nil {
		t.Fatalf("black second move: %v", err)
	}
	blackCharge := blackMove.Receipt.DecidedAt.Sub(blackStart).Milliseconds()
	if _, err = service.Execute(ctx, alice, offerTakebackOnlineCommand(matchID, "op-increment-offer-2", online.SeatWhite, 7, 1)); err != nil {
		t.Fatalf("second takeback offer: %v", err)
	}
	second := pendingOffer(t, service, matchID, online.OfferTakeback)
	// After Black's second move it is White's turn, so the takeback charges
	// White's clock.
	secondStart := clockStart(t, pool, matchID)
	acceptedAgain, err := service.Execute(ctx, bob, acceptTakebackOnlineCommand(matchID, "op-increment-accept-2", online.SeatBlack, 8, second.OfferID))
	if err != nil {
		t.Fatalf("second takeback acceptance: %v", err)
	}
	secondCharge := acceptedAgain.Receipt.DecidedAt.Sub(secondStart).Milliseconds()
	// The replacement move and Black's second move are discarded, so both
	// increments are removed again.
	wantAgain := wantReplay - secondCharge - 2_000
	wantBlackAgain := wantBlack - blackCharge
	afterAgain, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if afterAgain.Clock.WhiteMs != wantAgain {
		t.Fatalf("white bank after the repeated takeback = %d, want %d", afterAgain.Clock.WhiteMs, wantAgain)
	}
	if afterAgain.Clock.BlackMs != wantBlackAgain {
		t.Fatalf("black bank after the repeated takeback = %d, want %d", afterAgain.Clock.BlackMs, wantBlackAgain)
	}
}

// The opening exchange cannot be taken back. The reply window, its deadline
// and the clocks are never touched by a takeback request.
func TestPostgresOnlineTakebackIsRefusedDuringTheOpeningExchange(t *testing.T) {
	service, pool := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-takeback-opening"
	createOnlineMatch(t, service, matchID, "op-opening-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-opening-white", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	before, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if before.Clock.ReplySeat == nil || before.Clock.ReplyDeadlineAt == nil {
		t.Fatalf("the opening reply window is not armed: %+v", before.Clock)
	}
	// The offer is refused while the reply window is open.
	if _, err = service.Execute(ctx, bob, offerTakebackOnlineCommand(matchID, "op-opening-offer", online.SeatBlack, 2, 1)); !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("a takeback offer during the opening exchange = %v, want ErrActionNotAllowed", err)
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Version != before.Version || len(after.Offers) != 0 {
		t.Fatalf("the refused offer changed the match: %+v", after)
	}
	if after.Clock.ReplyDeadlineAt == nil || !after.Clock.ReplyDeadlineAt.Equal(*before.Clock.ReplyDeadlineAt) {
		t.Fatalf("the refused offer moved the reply deadline: %+v", after.Clock)
	}
	if after.Clock.WhiteMs != before.Clock.WhiteMs || after.Clock.BlackMs != before.Clock.BlackMs {
		t.Fatalf("the refused offer moved a bank: %+v -> %+v", before.Clock, after.Clock)
	}
	// The acceptance is refused as well, even when an offer is placed in the
	// match by a trusted fixture.
	if _, err = pool.Exec(ctx, `INSERT INTO online_offers(offer_id,match_id,kind,seat,target_version,base_version,created_at) VALUES($1,$2,'takeback','black',1,$3,clock_timestamp())`,
		"offer-opening-fixture", matchID, after.Version); err != nil {
		t.Fatal(err)
	}
	if _, err = service.Execute(ctx, alice, acceptTakebackOnlineCommand(matchID, "op-opening-accept", online.SeatWhite, after.Version, "offer-opening-fixture")); !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("a takeback acceptance during the opening exchange = %v, want ErrActionNotAllowed", err)
	}
	unchanged, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged.Version != after.Version || len(unchanged.Moves) != len(after.Moves) {
		t.Fatalf("the refused acceptance changed the match: %+v", unchanged)
	}
	if unchanged.Clock.ReplyDeadlineAt == nil || !unchanged.Clock.ReplyDeadlineAt.Equal(*before.Clock.ReplyDeadlineAt) {
		t.Fatalf("the refused acceptance moved the reply deadline: %+v", unchanged.Clock)
	}
	// The expiry still takes precedence over the refusal.
	expireReplyWindow(t, pool, matchID)
	expired, err := service.Execute(ctx, bob, offerTakebackOnlineCommand(matchID, "op-opening-offer-expired", online.SeatBlack, after.Version, 1))
	if err != nil {
		t.Fatalf("the offer after the reply window closed: %v", err)
	}
	if expired.Receipt.Outcome != online.OutcomeOpeningExpired {
		t.Fatalf("the outcome = %q, want opening_expired", expired.Receipt.Outcome)
	}
	aborted, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if aborted.Status != online.MatchAborted {
		t.Fatalf("the status = %q, want aborted", aborted.Status)
	}
}

// The opening rule follows the side to move, so a custom position that starts
// with Black to move keeps its own reply window.
func TestPostgresOnlineTakebackIsRefusedDuringTheBlackStartOpening(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-takeback-opening-black"
	create := createOnlineCommand(matchID, "op-opening-black-create")
	create.Action.CreateMatch.StartingFEN = blackToMoveFEN
	if _, err := service.Execute(ctx, alice, create); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-opening-black-move", online.SeatBlack, 1, "e7e5")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	before, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if before.Clock.ReplySeat == nil || *before.Clock.ReplySeat != online.SeatWhite {
		t.Fatalf("the reply window names the wrong seat: %+v", before.Clock)
	}
	if _, err = service.Execute(ctx, alice, offerTakebackOnlineCommand(matchID, "op-opening-black-offer", online.SeatWhite, 2, 1)); !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("a takeback offer during the opening exchange = %v, want ErrActionNotAllowed", err)
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Version != before.Version || len(after.Offers) != 0 {
		t.Fatalf("the refused offer changed the match: %+v", after)
	}
	if after.Clock.ReplyDeadlineAt == nil || !after.Clock.ReplyDeadlineAt.Equal(*before.Clock.ReplyDeadlineAt) {
		t.Fatalf("the refused offer moved the reply deadline: %+v", after.Clock)
	}
}

// A takeback that restores the starting position does not reopen the opening
// phase. The first-move flags stay historical and the normal clocks and the
// cancellation stay in place.
func TestPostgresOnlineTakebackDoesNotReopenTheOpeningPhase(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-takeback-start"
	createOnlineMatch(t, service, matchID, "op-reopen-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-reopen-white-1", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-reopen-black-1", online.SeatBlack, 2, "e7e5")); err != nil {
		t.Fatalf("opening reply: %v", err)
	}
	if _, err := service.Execute(ctx, alice, offerTakebackOnlineCommand(matchID, "op-reopen-offer", online.SeatWhite, 3, 1)); err != nil {
		t.Fatalf("takeback offer: %v", err)
	}
	offer := pendingOffer(t, service, matchID, online.OfferTakeback)
	if _, err := service.Execute(ctx, bob, acceptTakebackOnlineCommand(matchID, "op-reopen-accept", online.SeatBlack, 4, offer.OfferID)); err != nil {
		t.Fatalf("takeback acceptance: %v", err)
	}
	restored, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if restored.PositionFEN != restored.StartingFEN {
		t.Fatalf("the restored position = %q, want the starting position", restored.PositionFEN)
	}
	// The opening phase is a historical fact, so the reply window is not
	// armed again and the first-move flags stay set.
	if restored.Clock.ReplySeat != nil || restored.Clock.ReplyDeadlineAt != nil {
		t.Fatalf("the takeback reopened the reply window: %+v", restored.Clock)
	}
	if !restored.Clock.WhiteMoved || !restored.Clock.BlackMoved {
		t.Fatalf("the takeback cleared the first-move flags: %+v", restored.Clock)
	}
	if restored.Clock.ActiveSeat == nil || *restored.Clock.ActiveSeat != online.SeatWhite {
		t.Fatalf("the takeback did not arm the normal clock: %+v", restored.Clock)
	}
	// A cancellation after the takeback is a resignation, not an abort.
	cancelled, err := service.Execute(ctx, alice, cancelOnlineCommand(matchID, "op-reopen-cancel", online.SeatWhite, 5))
	if err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if cancelled.Receipt.Result == nil || cancelled.Receipt.Result.Kind != online.ResultWin ||
		cancelled.Receipt.Result.Winner == nil || *cancelled.Receipt.Result.Winner != online.SeatBlack {
		t.Fatalf("the cancellation after the takeback = %+v, want a resignation", cancelled.Receipt.Result)
	}
}

// A retried acceptance returns the stored receipt and never applies the
// takeback a second time.
func TestPostgresOnlineAcceptanceRetryReturnsTheStoredReceipt(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-takeback-retry"
	createOnlineMatch(t, service, matchID, "op-retry-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-retry-white-1", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-retry-black-1", online.SeatBlack, 2, "e7e5")); err != nil {
		t.Fatalf("opening reply: %v", err)
	}
	if _, err := service.Execute(ctx, bob, offerTakebackOnlineCommand(matchID, "op-retry-offer", online.SeatBlack, 3, 1)); err != nil {
		t.Fatalf("takeback offer: %v", err)
	}
	offer := pendingOffer(t, service, matchID, online.OfferTakeback)
	accept := acceptTakebackOnlineCommand(matchID, "op-retry-accept", online.SeatWhite, 4, offer.OfferID)
	accepted, err := service.Execute(ctx, alice, accept)
	if err != nil {
		t.Fatalf("takeback acceptance: %v", err)
	}
	retry, err := service.Execute(ctx, alice, accept)
	if err != nil {
		t.Fatalf("takeback acceptance retry: %v", err)
	}
	if !retry.Duplicate || !bytes.Equal(accepted.Raw, retry.Raw) {
		t.Fatalf("the retried acceptance did not return the original receipt: %+v", retry.Receipt)
	}
	after, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Version != accepted.Receipt.Version || len(after.Moves) != 0 {
		t.Fatalf("the retried acceptance changed the match: %+v", after)
	}
}

// The offered identity is part of the operation fingerprint, so a changed
// consent cannot reuse an accepted operation ID.
func TestPostgresOnlineAcceptanceFingerprintCoversTheOfferIdentity(t *testing.T) {
	service, _ := onlineService(t, moveEvaluator{})
	ctx := context.Background()
	matchID := "match-takeback-fingerprint"
	createOnlineMatch(t, service, matchID, "op-fingerprint-create")
	if _, err := service.Execute(ctx, alice, moveOnlineCommand(matchID, "op-fingerprint-white-1", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("opening move: %v", err)
	}
	if _, err := service.Execute(ctx, bob, moveOnlineCommand(matchID, "op-fingerprint-black-1", online.SeatBlack, 2, "e7e5")); err != nil {
		t.Fatalf("opening reply: %v", err)
	}
	if _, err := service.Execute(ctx, alice, offerTakebackOnlineCommand(matchID, "op-fingerprint-offer-a", online.SeatWhite, 3, 2)); err != nil {
		t.Fatalf("takeback offer: %v", err)
	}
	first := pendingOffer(t, service, matchID, online.OfferTakeback)
	if _, err := service.Execute(ctx, alice, offerTakebackOnlineCommand(matchID, "op-fingerprint-offer-b", online.SeatWhite, 4, 1)); err != nil {
		t.Fatalf("replacement takeback offer: %v", err)
	}
	second := pendingOffer(t, service, matchID, online.OfferTakeback)
	if _, err := service.Execute(ctx, bob, acceptTakebackOnlineCommand(matchID, "op-fingerprint-accept", online.SeatBlack, 5, second.OfferID)); err != nil {
		t.Fatalf("takeback acceptance: %v", err)
	}
	// The same operation ID with another offered identity is refused.
	if _, err := service.Execute(ctx, bob, acceptTakebackOnlineCommand(matchID, "op-fingerprint-accept", online.SeatBlack, 6, first.OfferID)); !errors.Is(err, online.ErrOperationReuse) {
		t.Fatalf("a changed consent with the same operation ID = %v, want ErrOperationReuse", err)
	}
}
