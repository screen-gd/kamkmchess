package httpapi

import (
	"encoding/json"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// The TypeScript parser reads this same fixture. Compare the actual HTTP
// projection, including its private-identity redaction, with that wire contract.
func TestOnlineUpdatesSharedWireContract(t *testing.T) {
	handler, service, _ := newOnlineHandler(t)
	at := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	replyDeadline := at.Add(15 * time.Second)
	modelLabel := "Public model"
	const position = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
	service.match.MatchID = "match-wire"
	service.match.PositionFEN = position
	service.match.TimeControl = online.TimeControl{StartingTimeMs: 60000, IncrementMs: 1000}
	service.match.RulesPolicyVersion = online.DefaultRulesPolicyVersion
	service.match.Seats[1].Control = online.SeatControl{Kind: online.ControlAgent, ModelLabel: &modelLabel}
	service.match.Seats[1].IllegalAttemptsSpent = 1
	service.match.Seats[1].FormatCorrectionsSpent = 2
	service.match.Clock = online.ClockState{
		WhiteMs: 61000, BlackMs: 60000, WhiteMoved: true, TurnNumber: 2,
		ReplySeat: seatOf(online.SeatBlack), ReplyDeadlineAt: &replyDeadline,
	}
	service.match.Moves = []online.Move{{Version: 2, Seat: online.SeatWhite, UCI: "e2e4", SAN: "e4", ResultingFEN: position}}
	service.match.Offers = []online.Offer{{
		OfferID: "offer-wire", MatchID: "match-wire", Kind: online.OfferDraw,
		Seat: online.SeatWhite, BaseVersion: 3, CreatedAt: at.Add(time.Second),
	}}
	service.match.CreatedAt = at
	service.match.UpdatedAt = at.Add(time.Second)
	w := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-wire/updates", testOrigin,
		map[string]string{"Authorization": "Bearer account-token", "Accept": "application/json"}, "")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	wantRaw, err := os.ReadFile("testdata/online-updates.json")
	if err != nil {
		t.Fatal(err)
	}
	var got, want any
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(wantRaw, &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("HTTP snapshot differs from the Go/TypeScript wire fixture:\n%s", w.Body.String())
	}
	for _, private := range []string{"user_secret_1", "guest_secret_2", "participant", "credential", "account-token"} {
		if strings.Contains(w.Body.String(), private) {
			t.Fatalf("HTTP snapshot leaked %q", private)
		}
	}
}
