package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
)

const testOrigin = "https://app.example"

type stubOnlineService struct {
	projection    online.PublicProjection
	projectionErr error
	match         online.Match
	matchErr      error
	receipt       online.CommandResult
	receiptErr    error
	executed      []online.Command
	executeErr    error
	actor         online.ParticipantRef
}

func (s *stubOnlineService) Execute(ctx context.Context, actor online.ParticipantRef, cmd online.Command) (online.CommandResult, error) {
	s.executed = append(s.executed, cmd)
	s.actor = actor
	return s.receipt, s.executeErr
}

func (s *stubOnlineService) GetMatchForParticipant(context.Context, string, online.ParticipantRef) (online.Match, error) {
	return s.match, s.matchErr
}

func (s *stubOnlineService) GetReceiptForParticipant(context.Context, string, string, online.ParticipantRef) (online.CommandResult, error) {
	return s.receipt, s.receiptErr
}

func (s *stubOnlineService) GetPublicProjection(context.Context, string) (online.PublicProjection, error) {
	return s.projection, s.projectionErr
}

type stubAuthenticator struct {
	account map[string]onlineauth.Principal
	guest   map[string]onlineauth.Principal
}

func (s *stubAuthenticator) AuthenticateAccount(_ context.Context, token, origin string) (onlineauth.Principal, error) {
	principal, ok := s.account[token]
	if !ok || principal.Origin != origin {
		return onlineauth.Principal{}, onlineauth.ErrUnauthenticated
	}
	return principal, nil
}

func (s *stubAuthenticator) AuthenticateGuest(_ context.Context, secret, origin string) (onlineauth.Principal, error) {
	principal, ok := s.guest[secret]
	if !ok || principal.Origin != origin {
		return onlineauth.Principal{}, onlineauth.ErrUnauthenticated
	}
	return principal, nil
}

func accountParticipant(subject string) onlineauth.Principal {
	return onlineauth.NewAccountPrincipal(subject, "session-"+subject, testOrigin, time.Unix(1_900_000_000, 0))
}

func guestParticipant(guestID, matchID string, seat online.Seat) onlineauth.Principal {
	return onlineauth.Principal{
		Kind:         online.ParticipantGuest,
		Subject:      guestID,
		Participant:  online.ParticipantRef{Kind: online.ParticipantGuest, ID: guestID},
		CredentialID: "credential-" + guestID,
		MatchID:      matchID,
		Seat:         seat,
		Origin:       testOrigin,
		ExpiresAt:    time.Unix(1_900_000_000, 0),
	}
}

func newOnlineHandler(t *testing.T) (http.Handler, *stubOnlineService, *stubAuthenticator) {
	t.Helper()
	service := &stubOnlineService{
		projection: online.PublicProjection{
			SchemaVersion: online.PublicProjectionSchemaVersion,
			MatchID:       "match-public",
			Variant:       "orthodox",
			Participants: []online.PublicParticipant{
				{Seat: online.SeatWhite, PublicLabel: "Alice", Control: online.SeatControl{Kind: online.ControlHuman}},
			},
			Result: online.Result{Kind: online.ResultWin, Winner: seatOf(online.SeatWhite), Reason: online.ReasonCheckmate},
		},
		match: online.Match{
			SchemaVersion: online.ContractsSchemaVersion,
			MatchID:       "match-live",
			Variant:       "orthodox",
			StartingFEN:   "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
			PositionFEN:   "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
			Version:       3,
			ControlEpoch:  1,
			Status:        online.MatchActive,
			Seats: []online.MatchSeat{
				{Seat: online.SeatWhite, Participant: online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_secret_1"}, PublicLabel: "Alice", Control: online.SeatControl{Kind: online.ControlHuman}, ControlEpoch: 1},
				{Seat: online.SeatBlack, Participant: online.ParticipantRef{Kind: online.ParticipantGuest, ID: "guest_secret_2"}, PublicLabel: "Guest", Control: online.SeatControl{Kind: online.ControlHuman}, ControlEpoch: 1},
			},
			Clock: online.ClockState{WhiteMs: 1000, BlackMs: 1000},
			Moves: []online.Move{},
		},
		receipt: online.CommandResult{Raw: []byte(`{"schemaVersion":2,"matchId":"match-live","operationId":"op-one-1","outcome":"accepted"}`)},
	}
	authenticator := &stubAuthenticator{
		account: map[string]onlineauth.Principal{"account-token": accountParticipant("user_secret_1")},
		guest:   map[string]onlineauth.Principal{"guest-token": guestParticipant("guest_secret_2", "match-live", online.SeatBlack)},
	}
	return NewOnline(service, authenticator, OnlineOptions{AllowedOrigins: []string{testOrigin}}), service, authenticator
}

func seatOf(seat online.Seat) *online.Seat { return &seat }

func int64Of(value int64) *int64 { return &value }

func onlineRequest(t *testing.T, handler http.Handler, method, path, origin string, headers map[string]string, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, path, reader)
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestOnlinePublicReplayIsReadableWithoutASession(t *testing.T) {
	handler, _, _ := newOnlineHandler(t)
	response := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-public/replay", "", nil, "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var projection online.PublicProjection
	if err := json.Unmarshal(response.Body.Bytes(), &projection); err != nil {
		t.Fatal(err)
	}
	if projection.MatchID != "match-public" || len(projection.Participants) != 1 {
		t.Fatalf("unexpected projection: %+v", projection)
	}
	for _, forbidden := range []string{"user_secret_1", "guest_secret_2", "participantId", "ownerId", "credential", "secretHash", "sessionId", "operationId"} {
		if strings.Contains(response.Body.String(), forbidden) {
			t.Fatalf("public replay leaked %q: %s", forbidden, response.Body.String())
		}
	}
}

func TestOnlineLiveStateRequiresAParticipantAndRedactsAuthorizationIdentities(t *testing.T) {
	handler, _, _ := newOnlineHandler(t)
	anonymous := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live", testOrigin, nil, "")
	if anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous live read status=%d body=%s", anonymous.Code, anonymous.Body.String())
	}
	authorized := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live", testOrigin, map[string]string{"Authorization": "Bearer account-token"}, "")
	if authorized.Code != http.StatusOK {
		t.Fatalf("participant live read status=%d body=%s", authorized.Code, authorized.Body.String())
	}
	body := authorized.Body.String()
	for _, forbidden := range []string{"user_secret_1", "guest_secret_2", "participantId", "ownerId", "credential", "sessionId"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("live state leaked %q: %s", forbidden, body)
		}
	}
	var payload map[string]any
	if err := json.Unmarshal(authorized.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["yourSeat"] != "white" {
		t.Fatalf("your seat = %v, want white", payload["yourSeat"])
	}
	seats, ok := payload["seats"].([]any)
	if !ok || len(seats) != 2 {
		t.Fatalf("seats = %v", payload["seats"])
	}
	first, _ := seats[0].(map[string]any)
	if _, leaked := first["participant"]; leaked {
		t.Fatalf("seat exposes a participant reference: %v", first)
	}
	if first["publicLabel"] != "Alice" {
		t.Fatalf("seat public label = %v", first["publicLabel"])
	}
}

// The live view exposes the identity of a pending offer, because a consent
// names the exact offer it accepts. The identity carries no private data.
func TestOnlineLiveStateExposesTheOfferIdentity(t *testing.T) {
	handler, service, _ := newOnlineHandler(t)
	service.match.Offers = []online.Offer{{
		OfferID:       "offer-live-0001",
		MatchID:       "match-live",
		Kind:          online.OfferTakeback,
		Seat:          online.SeatWhite,
		TargetVersion: int64Of(2),
		BaseVersion:   3,
		CreatedAt:     time.Unix(1_900_000_000, 0).UTC(),
	}}
	response := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live", testOrigin, map[string]string{"Authorization": "Bearer account-token"}, "")
	if response.Code != http.StatusOK {
		t.Fatalf("participant live read status=%d body=%s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	for _, forbidden := range []string{"user_secret_1", "guest_secret_2", "participantId", "ownerId", "credential"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("the pending offer leaked %q: %s", forbidden, body)
		}
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	offers, ok := payload["pendingOffers"].([]any)
	if !ok || len(offers) != 1 {
		t.Fatalf("pending offers = %v", payload["pendingOffers"])
	}
	offer, _ := offers[0].(map[string]any)
	if offer["offerId"] != "offer-live-0001" {
		t.Fatalf("the pending offer has no identity: %v", offer)
	}
	if offer["kind"] != "takeback" || offer["seat"] != "white" {
		t.Fatalf("the pending offer = %v", offer)
	}
}

// An acceptance names the exact offer it consents to, so a command without
// that identity is rejected before it reaches the writer.
func TestOnlineRejectsAnAcceptanceWithoutTheOfferIdentity(t *testing.T) {
	handler, service, _ := newOnlineHandler(t)
	body := `{"schemaVersion":2,"matchId":"match-live","operationId":"op-accept-1","expectedVersion":3,"seat":"white","controlEpoch":1,"action":{"kind":"accept_draw"}}`
	response := onlineRequest(t, handler, http.MethodPost, "/v1/online/matches/match-live/commands", testOrigin, map[string]string{"Authorization": "Bearer account-token"}, body)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if len(service.executed) != 0 {
		t.Fatalf("the malformed acceptance reached the writer: %+v", service.executed)
	}
	named := `{"schemaVersion":2,"matchId":"match-live","operationId":"op-accept-2","expectedVersion":3,"seat":"white","controlEpoch":1,"action":{"kind":"accept_draw","offerId":"offer-live-0001"}}`
	accepted := onlineRequest(t, handler, http.MethodPost, "/v1/online/matches/match-live/commands", testOrigin, map[string]string{"Authorization": "Bearer account-token"}, named)
	if accepted.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", accepted.Code, accepted.Body.String())
	}
	if len(service.executed) != 1 || service.executed[0].Action.AcceptOffer == nil || service.executed[0].Action.AcceptOffer.OfferID != "offer-live-0001" {
		t.Fatalf("the named acceptance did not reach the writer: %+v", service.executed)
	}
}

func TestOnlineRequiresAnExplicitOriginOnMutations(t *testing.T) {
	handler, _, _ := newOnlineHandler(t)
	body := `{"schemaVersion":2,"matchId":"match-live","operationId":"op-move-1","expectedVersion":3,"seat":"black","controlEpoch":1,"action":{"kind":"submit_move","move":"e2e4"}}`
	response := onlineRequest(t, handler, http.MethodPost, "/v1/online/matches/match-live/commands", "", map[string]string{GuestCredentialHeader: "guest-token"}, body)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "origin_required") {
		t.Fatalf("body=%s", response.Body.String())
	}
}

func TestOnlineResolvesASameOriginReadWithoutAnOriginHeader(t *testing.T) {
	handler, _, _ := newOnlineHandler(t)
	request := httptest.NewRequest(http.MethodGet, "/v1/online/matches/match-live", nil)
	request.Host = "app.example"
	request.Header.Set("Authorization", "Bearer account-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("same-origin read status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestOnlineRejectsACrossSiteReadWithoutAnOriginHeader(t *testing.T) {
	handler, _, _ := newOnlineHandler(t)
	request := httptest.NewRequest(http.MethodGet, "/v1/online/matches/match-live", nil)
	request.Host = "app.example"
	request.Header.Set("Sec-Fetch-Site", "cross-site")
	request.Header.Set("Authorization", "Bearer account-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("cross-site read status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestOnlineRejectsAReadForAHostOutsideTheAllowedOrigins(t *testing.T) {
	handler, _, _ := newOnlineHandler(t)
	request := httptest.NewRequest(http.MethodGet, "/v1/online/matches/match-live", nil)
	request.Host = "other.example"
	request.Header.Set("Authorization", "Bearer account-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("unknown host read status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestOnlineRejectsForeignOriginAndUnknownCredentials(t *testing.T) {
	handler, _, _ := newOnlineHandler(t)
	foreign := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live", "https://evil.example", map[string]string{"Authorization": "Bearer account-token"}, "")
	if foreign.Code != http.StatusUnauthorized {
		t.Fatalf("foreign origin status=%d body=%s", foreign.Code, foreign.Body.String())
	}
	unknown := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live", testOrigin, map[string]string{GuestCredentialHeader: "kmgc1_unknown"}, "")
	if unknown.Code != http.StatusUnauthorized {
		t.Fatalf("unknown guest credential status=%d body=%s", unknown.Code, unknown.Body.String())
	}
}

func TestOnlineRejectsAmbiguousCredentials(t *testing.T) {
	handler, _, _ := newOnlineHandler(t)
	response := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live", testOrigin, map[string]string{
		"Authorization":       "Bearer account-token",
		GuestCredentialHeader: "guest-token",
	}, "")
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestOnlineHasNoPublicMatchCreationRoute(t *testing.T) {
	handler, service, _ := newOnlineHandler(t)
	for _, path := range []string{"/v1/online/matches", "/v1/online/matches/match-live"} {
		response := onlineRequest(t, handler, http.MethodPost, path, testOrigin, map[string]string{"Authorization": "Bearer account-token"}, `{"matchId":"match-live"}`)
		if response.Code != http.StatusNotFound && response.Code != http.StatusMethodNotAllowed {
			t.Fatalf("POST %s status=%d body=%s", path, response.Code, response.Body.String())
		}
	}
	if len(service.executed) != 0 {
		t.Fatalf("a public route reached the writer: %+v", service.executed)
	}
}

func TestOnlineRejectsCreateMatchCommands(t *testing.T) {
	handler, service, _ := newOnlineHandler(t)
	body := `{"schemaVersion":2,"matchId":"match-live","operationId":"op-create","expectedVersion":0,"seat":"white","controlEpoch":1,"action":{"kind":"create_match","setup":{"variant":"orthodox","startingFEN":"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1","timeControl":{"startingTimeMs":60000,"incrementMs":0},"seats":{"white":{"participant":{"kind":"account","id":"user_secret_1"},"publicLabel":"Alice","control":{"kind":"human"}},"black":{"participant":{"kind":"guest","id":"guest_secret_2"},"publicLabel":"Guest","control":{"kind":"human"}}}}}}`
	response := onlineRequest(t, handler, http.MethodPost, "/v1/online/matches/match-live/commands", testOrigin, map[string]string{"Authorization": "Bearer account-token"}, body)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "command_not_allowed") {
		t.Fatalf("body=%s", response.Body.String())
	}
	if len(service.executed) != 0 {
		t.Fatalf("a create_match command reached the writer: %+v", service.executed)
	}
}

func TestOnlineRejectsCommandsForAnotherSeat(t *testing.T) {
	handler, service, _ := newOnlineHandler(t)
	body := `{"schemaVersion":2,"matchId":"match-live","operationId":"op-move-1","expectedVersion":3,"seat":"white","controlEpoch":1,"action":{"kind":"submit_move","move":"e2e4"}}`
	response := onlineRequest(t, handler, http.MethodPost, "/v1/online/matches/match-live/commands", testOrigin, map[string]string{GuestCredentialHeader: "guest-token"}, body)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if len(service.executed) != 0 {
		t.Fatalf("a foreign seat command reached the writer: %+v", service.executed)
	}
}

func TestOnlineCommandUsesTheAuthenticatedActorAndReturnsTheStoredReceipt(t *testing.T) {
	handler, service, _ := newOnlineHandler(t)
	body := `{"schemaVersion":2,"matchId":"match-live","operationId":"op-move-1","expectedVersion":3,"seat":"black","controlEpoch":1,"action":{"kind":"submit_move","move":"e2e4"}}`
	response := onlineRequest(t, handler, http.MethodPost, "/v1/online/matches/match-live/commands", testOrigin, map[string]string{GuestCredentialHeader: "guest-token"}, body)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if len(service.executed) != 1 {
		t.Fatalf("executed = %+v", service.executed)
	}
	if service.actor != (online.ParticipantRef{Kind: online.ParticipantGuest, ID: "guest_secret_2"}) {
		t.Fatalf("actor = %+v", service.actor)
	}
	if !strings.Contains(response.Body.String(), `"outcome":"accepted"`) {
		t.Fatalf("body=%s", response.Body.String())
	}
}

func TestOnlineMapsServiceFailuresWithoutLeakingDetails(t *testing.T) {
	handler, service, _ := newOnlineHandler(t)
	service.executeErr = online.ErrNotAuthorized
	body := `{"schemaVersion":2,"matchId":"match-live","operationId":"op-move-1","expectedVersion":3,"seat":"black","controlEpoch":1,"action":{"kind":"submit_move","move":"e2e4"}}`
	response := onlineRequest(t, handler, http.MethodPost, "/v1/online/matches/match-live/commands", testOrigin, map[string]string{GuestCredentialHeader: "guest-token"}, body)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	service.executeErr = errors.New("connection refused: postgres://user:secret@host")
	response = onlineRequest(t, handler, http.MethodPost, "/v1/online/matches/match-live/commands", testOrigin, map[string]string{GuestCredentialHeader: "guest-token"}, body)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "secret") || strings.Contains(response.Body.String(), "postgres://") {
		t.Fatalf("error body leaked a detail: %s", response.Body.String())
	}
}

func TestOnlineRejectsMalformedCommandBodies(t *testing.T) {
	handler, service, _ := newOnlineHandler(t)
	for name, body := range map[string]string{
		"duplicate fields": `{"schemaVersion":2,"schemaVersion":2,"matchId":"match-live","operationId":"op-one-1","expectedVersion":3,"seat":"black","controlEpoch":1,"action":{"kind":"submit_move","move":"e2e4"}}`,
		"unknown field":    `{"schemaVersion":2,"matchId":"match-live","operationId":"op-one-1","expectedVersion":3,"seat":"black","controlEpoch":1,"apiKey":"canary","action":{"kind":"submit_move","move":"e2e4"}}`,
		"wrong match":      `{"schemaVersion":2,"matchId":"other-match","operationId":"op-one-1","expectedVersion":3,"seat":"black","controlEpoch":1,"action":{"kind":"submit_move","move":"e2e4"}}`,
	} {
		t.Run(name, func(t *testing.T) {
			response := onlineRequest(t, handler, http.MethodPost, "/v1/online/matches/match-live/commands", testOrigin, map[string]string{GuestCredentialHeader: "guest-token"}, body)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if strings.Contains(response.Body.String(), "canary") {
				t.Fatalf("rejected request echoed a secret: %s", response.Body.String())
			}
		})
	}
	if len(service.executed) != 0 {
		t.Fatalf("a malformed command reached the writer: %+v", service.executed)
	}
}

func TestOnlineRequestHeadersIncludeTheGuestCredentialOnly(t *testing.T) {
	found := false
	for _, header := range OnlineRequestHeaders {
		if header == GuestCredentialHeader {
			found = true
		}
	}
	if !found {
		t.Fatalf("the guest credential header is not allowed: %v", OnlineRequestHeaders)
	}
}
