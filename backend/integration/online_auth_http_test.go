package integration

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
)

// onlineHTTPFixture is the production composition of the online API: the real
// writer, the real authorization service, the real database, and the real
// CORS policy.
func onlineHTTPFixture(t *testing.T, fixture *onlineAuthFixture) http.Handler {
	t.Helper()
	return httpapi.CORSWithHeaders(
		[]string{authTestOrigin},
		httpapi.OnlineRequestHeaders,
		httpapi.NewOnline(fixture.service, fixture.authorizer, httpapi.OnlineOptions{AllowedOrigins: []string{authTestOrigin}}),
	)
}

func onlineHTTPRequest(handler http.Handler, method, path, origin, host string, headers map[string]string, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	if host != "" {
		request.Host = host
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestPostgresOnlineHTTPCompositionAuthorizesOnlyParticipants(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	issued := createGuestMatch(t, fixture, "match-http-guest")
	handler := onlineHTTPFixture(t, fixture)

	// The public completed replay is readable without a credential.
	public := onlineHTTPRequest(handler, http.MethodGet, "/v1/online/matches/match-http-guest/replay", "", "", nil, "")
	if public.Code != http.StatusNotFound && public.Code != http.StatusOK {
		t.Fatalf("public replay status=%d body=%s", public.Code, public.Body.String())
	}

	// A guest credential reads its own live state over HTTP.
	live := onlineHTTPRequest(handler, http.MethodGet, "/v1/online/matches/match-http-guest", authTestOrigin, "", map[string]string{httpapi.GuestCredentialHeader: issued.Credential.Secret}, "")
	if live.Code != http.StatusOK {
		t.Fatalf("guest live read status=%d body=%s", live.Code, live.Body.String())
	}
	if strings.Contains(live.Body.String(), authGuestID) || strings.Contains(live.Body.String(), "user_a") {
		t.Fatalf("live state leaked a participant reference: %s", live.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(live.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["yourSeat"] != "white" {
		t.Fatalf("your seat = %v, want white", payload["yourSeat"])
	}

	// The guest commands its own seat over HTTP.
	command := `{"schemaVersion":2,"matchId":"match-http-guest","operationId":"op-http-guest-1","expectedVersion":1,"seat":"white","controlEpoch":1,"action":{"kind":"submit_move","move":"e2e4"}}`
	accepted := onlineHTTPRequest(handler, http.MethodPost, "/v1/online/matches/match-http-guest/commands", authTestOrigin, "", map[string]string{httpapi.GuestCredentialHeader: issued.Credential.Secret}, command)
	if accepted.Code != http.StatusOK {
		t.Fatalf("guest command status=%d body=%s", accepted.Code, accepted.Body.String())
	}

	// The receipt is readable by the participant and hidden from others.
	receipt := onlineHTTPRequest(handler, http.MethodGet, "/v1/online/matches/match-http-guest/operations/op-http-guest-1", authTestOrigin, "", map[string]string{httpapi.GuestCredentialHeader: issued.Credential.Secret}, "")
	if receipt.Code != http.StatusOK {
		t.Fatalf("guest receipt status=%d body=%s", receipt.Code, receipt.Body.String())
	}
	foreign := onlineHTTPRequest(handler, http.MethodGet, "/v1/online/matches/match-http-guest/operations/op-http-guest-1", authTestOrigin, "", map[string]string{httpapi.GuestCredentialHeader: "kmgc1_not-a-real-credential"}, "")
	if foreign.Code != http.StatusUnauthorized {
		t.Fatalf("unknown credential receipt status=%d body=%s", foreign.Code, foreign.Body.String())
	}

	// A mutation without an explicit origin is never silently accepted.
	anonymous := onlineHTTPRequest(handler, http.MethodPost, "/v1/online/matches/match-http-guest/commands", "", "", map[string]string{httpapi.GuestCredentialHeader: issued.Credential.Secret}, command)
	if anonymous.Code != http.StatusForbidden {
		t.Fatalf("mutation without origin status=%d body=%s", anonymous.Code, anonymous.Body.String())
	}
	if !strings.Contains(anonymous.Body.String(), "origin_required") {
		t.Fatalf("body=%s", anonymous.Body.String())
	}

	// A foreign origin is refused by the origin policy.
	foreignOrigin := onlineHTTPRequest(handler, http.MethodGet, "/v1/online/matches/match-http-guest", "https://evil.example", "", map[string]string{httpapi.GuestCredentialHeader: issued.Credential.Secret}, "")
	if foreignOrigin.Code != http.StatusForbidden {
		t.Fatalf("foreign origin status=%d body=%s", foreignOrigin.Code, foreignOrigin.Body.String())
	}
}

func TestPostgresOnlineHTTPCompositionResolvesASameOriginReadWithoutOriginHeader(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	issued := createGuestMatch(t, fixture, "match-http-same-origin")
	handler := onlineHTTPFixture(t, fixture)
	response := onlineHTTPRequest(handler, http.MethodGet, "/v1/online/matches/match-http-same-origin", "", "app.example", map[string]string{httpapi.GuestCredentialHeader: issued.Credential.Secret}, "")
	if response.Code != http.StatusOK {
		t.Fatalf("same-origin read status=%d body=%s", response.Code, response.Body.String())
	}
	crossSite := onlineHTTPRequest(handler, http.MethodGet, "/v1/online/matches/match-http-same-origin", "", "app.example", map[string]string{
		httpapi.GuestCredentialHeader: issued.Credential.Secret,
		"Sec-Fetch-Site":              "cross-site",
	}, "")
	if crossSite.Code != http.StatusForbidden {
		t.Fatalf("cross-site read status=%d body=%s", crossSite.Code, crossSite.Body.String())
	}
}

func TestPostgresOnlineHTTPCompositionRevokedCredentialIsUnauthorized(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	issued := createGuestMatch(t, fixture, "match-http-revoked")
	handler := onlineHTTPFixture(t, fixture)
	if err := fixture.authorizer.RevokeSeatCredential(context.Background(), issued.Credential.CredentialID, "owner_request"); err != nil {
		t.Fatal(err)
	}
	response := onlineHTTPRequest(handler, http.MethodGet, "/v1/online/matches/match-http-revoked", authTestOrigin, "", map[string]string{httpapi.GuestCredentialHeader: issued.Credential.Secret}, "")
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("revoked credential status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestPostgresOnlineStreamGrantChecksScopeRevocationAndDuration(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	issued := createGuestMatch(t, fixture, "match-stream-grant")
	ctx := context.Background()
	principal := guestParticipant(t, fixture, issued)

	grant, err := fixture.authorizer.AuthorizeStream(ctx, principal, "match-stream-grant")
	if err != nil {
		t.Fatalf("authorize stream: %v", err)
	}
	if grant.ExpiresAt.After(time.Now().Add(onlineauth.DefaultStreamMaxDuration + time.Second)) {
		t.Fatalf("the stream window outlives the hard cap: %v", grant.ExpiresAt)
	}
	if grant.MatchID != "match-stream-grant" || grant.Seat != online.SeatWhite {
		t.Fatalf("grant = %+v", grant)
	}

	// A foreign match is never authorized.
	if _, err = fixture.authorizer.AuthorizeStream(ctx, principal, "match-other"); !errors.Is(err, online.ErrNotAuthorized) && !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("foreign match grant = %v", err)
	}

	// A renewal re-verifies the credential.
	renewed, err := fixture.authorizer.RenewStream(ctx, grant, onlineauth.Credential{GuestSecret: issued.Credential.Secret}, authTestOrigin)
	if err != nil {
		t.Fatalf("renew stream: %v", err)
	}
	if renewed.MatchID != grant.MatchID {
		t.Fatalf("renewed grant = %+v", renewed)
	}

	// A revoked credential ends the subscription instead of extending it.
	if err = fixture.authorizer.RevokeSeatCredential(ctx, issued.Credential.CredentialID, "owner_request"); err != nil {
		t.Fatal(err)
	}
	if _, err = fixture.authorizer.RenewStream(ctx, grant, onlineauth.Credential{GuestSecret: issued.Credential.Secret}, authTestOrigin); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("renew after revocation = %v, want ErrUnauthenticated", err)
	}
	if _, err = fixture.authorizer.AuthorizeStream(ctx, principal, "match-stream-grant"); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("authorize after revocation = %v, want ErrUnauthenticated", err)
	}
}

func TestPostgresOnlineStreamWindowIsHardCapped(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	issued := createGuestMatch(t, fixture, "match-stream-cap")
	ctx := context.Background()
	principal := guestParticipant(t, fixture, issued)
	longWindow, err := onlineauth.Open(ctx, fixture.pool, fixture.verifier, onlineauth.Options{StreamMaxDuration: 5 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	grant, err := longWindow.AuthorizeStream(ctx, principal, "match-stream-cap")
	if err != nil {
		t.Fatalf("authorize stream: %v", err)
	}
	if grant.ExpiresAt.After(time.Now().Add(onlineauth.DefaultStreamMaxDuration + time.Second)) {
		t.Fatalf("the configured window was not capped: %v", grant.ExpiresAt)
	}
}
