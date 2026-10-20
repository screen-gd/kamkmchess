package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/profile"
)

// proofIDPattern is the shape of a guest ownership proof identifier. The
// browser contract parses the same shape, and both read the shared fixture in
// backend/profile/testdata.
var proofIDPattern = regexp.MustCompile(sharedProofIDPattern())

// sharedProofIDPattern reads the proof identifier shape from the shared
// contract fixture.
func sharedProofIDPattern() string {
	raw, err := os.ReadFile("../profile/testdata/public-profile-contract.json")
	if err != nil {
		return `^kgp_[A-Za-z0-9_-]{8,63}$`
	}
	var contract struct {
		ProofIDPattern string `json:"proofIdPattern"`
	}
	if err = json.Unmarshal(raw, &contract); err != nil || contract.ProofIDPattern == "" {
		return `^kgp_[A-Za-z0-9_-]{8,63}$`
	}
	return contract.ProofIDPattern
}

// profileHTTPFixture is the production composition of the public profile API:
// the real profile service, the real authorization service, the real
// database, and the real CORS policy.
func profileHTTPFixture(t *testing.T, fixture *onlineAuthFixture) http.Handler {
	t.Helper()
	service, err := profile.Open(context.Background(), fixture.pool, fixture.authorizer, profile.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return httpapi.CORSWithHeaders(
		[]string{authTestOrigin},
		httpapi.ProfileRequestHeaders,
		httpapi.NewProfile(service, fixture.allocator, fixture.authorizer, httpapi.OnlineOptions{AllowedOrigins: []string{authTestOrigin}}),
	)
}

// profileToken mints a Clerk session token for one account.
func profileToken(t *testing.T, fixture *onlineAuthFixture, subject, sessionID string) string {
	t.Helper()
	return signSession(t, fixture.key, subject, sessionID, time.Now().Add(time.Hour))
}

// profileGuestMatchCommand creates a match whose white seat belongs to a
// guest and whose black seat belongs to an account.
func profileGuestMatchCommand(matchID, operationID, guestID, accountID string) online.Command {
	command := guestMatchCommand(matchID, operationID)
	command.Action.CreateMatch.Seats.White = online.CreateSeat{
		Participant: online.ParticipantRef{Kind: online.ParticipantGuest, ID: guestID},
		PublicLabel: "Guest",
		Control:     online.SeatControl{Kind: online.ControlHuman},
	}
	command.Action.CreateMatch.Seats.Black = online.CreateSeat{
		Participant: online.ParticipantRef{Kind: online.ParticipantAccount, ID: accountID},
		PublicLabel: "Player",
		Control:     online.SeatControl{Kind: online.ControlHuman},
	}
	return command
}

// createProfileGuestMatch creates a match with a guest seat and issues the
// guest seat credential for it.
func createProfileGuestMatch(t *testing.T, fixture *onlineAuthFixture, matchID, guestID, accountID string) onlineauth.IssuedSeatCredentials {
	t.Helper()
	ctx := accountContext(accountID, "session-"+accountID)
	command := profileGuestMatchCommand(matchID, "op-create-"+matchID, guestID, accountID)
	command.Seat = online.SeatBlack
	if _, err := fixture.service.Execute(ctx, online.ParticipantRef{Kind: online.ParticipantAccount, ID: accountID}, command); err != nil {
		t.Fatalf("create guest match: %v", err)
	}
	issued, err := fixture.allocator.AcceptInvitation(ctx, onlineauth.AcceptInvitationRequest{
		MatchID: matchID,
		Seat:    online.SeatWhite,
		GuestID: guestID,
		Origin:  authTestOrigin,
	})
	if err != nil {
		t.Fatalf("accept invitation: %v", err)
	}
	return issued
}

// decodeProfile decodes a JSON body into a map.
func decodeProfile(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("decode body %q: %v", string(body), err)
	}
	return payload
}

// sortedKeys returns the sorted key names of a decoded object.
func sortedKeys(payload map[string]any) []string {
	keys := make([]string, 0, len(payload))
	for key := range payload {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// ownProfileID reads the public identifier of the signed-in account.
func ownProfileID(t *testing.T, handler http.Handler, token string) string {
	t.Helper()
	response := onlineHTTPRequest(handler, http.MethodGet, "/v1/account/profile", authTestOrigin, "", map[string]string{"Authorization": "Bearer " + token}, "")
	if response.Code != http.StatusOK {
		t.Fatalf("own profile status=%d body=%s", response.Code, response.Body.String())
	}
	payload := decodeProfile(t, response.Body.Bytes())
	id, _ := payload["profileId"].(string)
	if id == "" {
		t.Fatalf("own profile has no profile id: %s", response.Body.String())
	}
	return id
}

func TestPostgresPublicProfileIsPublishedWithoutTheAccountIdentity(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	handler := profileHTTPFixture(t, fixture)
	token := profileToken(t, fixture, "user_a", "session-alice")

	own := onlineHTTPRequest(handler, http.MethodGet, "/v1/account/profile", authTestOrigin, "", map[string]string{"Authorization": "Bearer " + token}, "")
	if own.Code != http.StatusOK {
		t.Fatalf("own profile status=%d body=%s", own.Code, own.Body.String())
	}
	ownPayload := decodeProfile(t, own.Body.Bytes())
	profileID, _ := ownPayload["profileId"].(string)
	if !strings.HasPrefix(profileID, "kp_") {
		t.Fatalf("profile id = %q, want a kp_ identifier", profileID)
	}
	// A new profile publishes no name and no chosen avatar.
	if ownPayload["username"] != nil {
		t.Fatalf("a new profile published a name: %v", ownPayload["username"])
	}
	avatar, _ := ownPayload["avatar"].(map[string]any)
	if avatar["kind"] != "generated" {
		t.Fatalf("avatar = %v, want the generated default", ownPayload["avatar"])
	}
	// The private sign-in identity never reaches the caller.
	if strings.Contains(own.Body.String(), "user_a") {
		t.Fatalf("the profile leaked the account identity: %s", own.Body.String())
	}

	// The public read works without a credential.
	public := onlineHTTPRequest(handler, http.MethodGet, "/v1/profiles/"+profileID, "", "", nil, "")
	if public.Code != http.StatusOK {
		t.Fatalf("public profile status=%d body=%s", public.Code, public.Body.String())
	}
	publicPayload := decodeProfile(t, public.Body.Bytes())
	want := []string{"avatar", "createdAt", "profileId", "schemaVersion", "updatedAt", "username"}
	got := sortedKeys(publicPayload)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("public payload keys = %v, want %v", got, want)
	}
	for _, forbidden := range []string{"user_a", "accountId", "email", "sessionId", "clerk"} {
		if strings.Contains(strings.ToLower(public.Body.String()), strings.ToLower(forbidden)) {
			t.Fatalf("the public payload leaked %q: %s", forbidden, public.Body.String())
		}
	}

	// An unknown profile is a 404, not an empty object.
	missing := onlineHTTPRequest(handler, http.MethodGet, "/v1/profiles/kp_missingprofile", "", "", nil, "")
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing profile status=%d body=%s", missing.Code, missing.Body.String())
	}
}

func TestPostgresPublicUsernameLookupIsCaseInsensitive(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	handler := profileHTTPFixture(t, fixture)
	token := profileToken(t, fixture, "user_a", "session-alice")
	profileID := ownProfileID(t, handler, token)

	updated := onlineHTTPRequest(handler, http.MethodPut, "/v1/account/profile", authTestOrigin, "", map[string]string{"Authorization": "Bearer " + token}, `{"username":"Alice"}`)
	if updated.Code != http.StatusOK {
		t.Fatalf("update status=%d body=%s", updated.Code, updated.Body.String())
	}
	payload := decodeProfile(t, updated.Body.Bytes())
	if payload["username"] != "Alice" {
		t.Fatalf("username = %v, want Alice", payload["username"])
	}

	for _, spelling := range []string{"Alice", "alice", "ALICE"} {
		lookup := onlineHTTPRequest(handler, http.MethodGet, "/v1/profiles/username/"+spelling, "", "", nil, "")
		if lookup.Code != http.StatusOK {
			t.Fatalf("lookup %q status=%d body=%s", spelling, lookup.Code, lookup.Body.String())
		}
		found := decodeProfile(t, lookup.Body.Bytes())
		if found["profileId"] != profileID {
			t.Fatalf("lookup %q returned %v, want %s", spelling, found["profileId"], profileID)
		}
		if found["username"] != "Alice" {
			t.Fatalf("lookup %q changed the chosen name: %v", spelling, found["username"])
		}
	}

	// An unknown name is a 404.
	unknown := onlineHTTPRequest(handler, http.MethodGet, "/v1/profiles/username/nobody-here", "", "", nil, "")
	if unknown.Code != http.StatusNotFound {
		t.Fatalf("unknown name status=%d body=%s", unknown.Code, unknown.Body.String())
	}
}

func TestPostgresPublicUsernameUniquenessIsCaseInsensitiveAndRaceSafe(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	handler := profileHTTPFixture(t, fixture)
	tokenA := profileToken(t, fixture, "user_a", "session-alice")
	tokenB := profileToken(t, fixture, "user_b", "session-bob")
	ownProfileID(t, handler, tokenA)
	ownProfileID(t, handler, tokenB)

	first := onlineHTTPRequest(handler, http.MethodPut, "/v1/account/profile", authTestOrigin, "", map[string]string{"Authorization": "Bearer " + tokenA}, `{"username":"rookie"}`)
	if first.Code != http.StatusOK {
		t.Fatalf("first name status=%d body=%s", first.Code, first.Body.String())
	}

	// The same name in another spelling belongs to the same owner.
	second := onlineHTTPRequest(handler, http.MethodPut, "/v1/account/profile", authTestOrigin, "", map[string]string{"Authorization": "Bearer " + tokenB}, `{"username":"ROOKIE"}`)
	if second.Code != http.StatusConflict || !strings.Contains(second.Body.String(), "username_taken") {
		t.Fatalf("second name status=%d body=%s", second.Code, second.Body.String())
	}

	// Two accounts race for the same free name. Exactly one wins.
	type result struct {
		status int
		body   string
	}
	results := make([]result, 2)
	var group sync.WaitGroup
	group.Add(2)
	for index, token := range []string{tokenA, tokenB} {
		go func(index int, token string) {
			defer group.Done()
			response := onlineHTTPRequest(handler, http.MethodPut, "/v1/account/profile", authTestOrigin, "", map[string]string{"Authorization": "Bearer " + token}, `{"username":"sprinter"}`)
			results[index] = result{status: response.Code, body: response.Body.String()}
		}(index, token)
	}
	group.Wait()
	won, lost := 0, 0
	for _, outcome := range results {
		switch outcome.status {
		case http.StatusOK:
			won++
		case http.StatusConflict:
			lost++
			if !strings.Contains(outcome.body, "username_taken") {
				t.Fatalf("the losing race answered %s", outcome.body)
			}
		default:
			t.Fatalf("unexpected race status=%d body=%s", outcome.status, outcome.body)
		}
	}
	if won != 1 || lost != 1 {
		t.Fatalf("the name race produced %d winners and %d losers", won, lost)
	}

	// The winning name belongs to exactly one profile.
	var owners int
	if err := fixture.pool.QueryRow(context.Background(), `SELECT count(*) FROM online_public_profiles WHERE username_key='sprinter'`).Scan(&owners); err != nil {
		t.Fatal(err)
	}
	if owners != 1 {
		t.Fatalf("%d profiles own the name sprinter", owners)
	}
}

func TestPostgresPublicProfileNameCanBeRemoved(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	handler := profileHTTPFixture(t, fixture)
	token := profileToken(t, fixture, "user_a", "session-alice")
	ownProfileID(t, handler, token)

	named := onlineHTTPRequest(handler, http.MethodPut, "/v1/account/profile", authTestOrigin, "", map[string]string{"Authorization": "Bearer " + token}, `{"username":"Alice"}`)
	if named.Code != http.StatusOK {
		t.Fatalf("named status=%d body=%s", named.Code, named.Body.String())
	}
	if decodeProfile(t, named.Body.Bytes())["username"] != "Alice" {
		t.Fatalf("the chosen name was not published: %s", named.Body.String())
	}

	// An empty name removes the chosen name and returns the profile to the
	// generated default.
	cleared := onlineHTTPRequest(handler, http.MethodPut, "/v1/account/profile", authTestOrigin, "", map[string]string{"Authorization": "Bearer " + token}, `{"username":""}`)
	if cleared.Code != http.StatusOK {
		t.Fatalf("cleared status=%d body=%s", cleared.Code, cleared.Body.String())
	}
	payload := decodeProfile(t, cleared.Body.Bytes())
	if payload["username"] != nil {
		t.Fatalf("the chosen name was not removed: %v", payload["username"])
	}
	avatar, _ := payload["avatar"].(map[string]any)
	if avatar["kind"] != "generated" {
		t.Fatalf("avatar = %v, want the generated default", payload["avatar"])
	}

	// The removed name is free again.
	other := profileToken(t, fixture, "user_b", "session-bob")
	ownProfileID(t, handler, other)
	taken := onlineHTTPRequest(handler, http.MethodPut, "/v1/account/profile", authTestOrigin, "", map[string]string{"Authorization": "Bearer " + other}, `{"username":"alice"}`)
	if taken.Code != http.StatusOK {
		t.Fatalf("the removed name was not free: status=%d body=%s", taken.Code, taken.Body.String())
	}
}

func TestPostgresPublicProfileEditsAreOwnershipChecked(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	handler := profileHTTPFixture(t, fixture)
	tokenA := profileToken(t, fixture, "user_a", "session-alice")
	tokenB := profileToken(t, fixture, "user_b", "session-bob")
	profileA := ownProfileID(t, handler, tokenA)
	ownProfileID(t, handler, tokenB)

	// A body that names another profile, another account, or an owner is
	// refused as an unknown field.
	for _, body := range []string{
		`{"profileId":"` + profileA + `","username":"thief"}`,
		`{"accountId":"user_a","username":"thief"}`,
		`{"ownerId":"user_a","username":"thief"}`,
		`{"username":"thief","email":"someone@example.com"}`,
	} {
		response := onlineHTTPRequest(handler, http.MethodPut, "/v1/account/profile", authTestOrigin, "", map[string]string{"Authorization": "Bearer " + tokenB}, body)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("body %q status=%d body=%s", body, response.Code, response.Body.String())
		}
	}

	// The other account's profile is untouched.
	read := onlineHTTPRequest(handler, http.MethodGet, "/v1/profiles/"+profileA, "", "", nil, "")
	payload := decodeProfile(t, read.Body.Bytes())
	if payload["username"] != nil {
		t.Fatalf("a refused update changed the profile: %v", payload["username"])
	}

	// A guest credential never acts on an account route.
	issued := createProfileGuestMatch(t, fixture, "match-profile-guest", "guest_alpha", "user_a")
	guestRoute := onlineHTTPRequest(handler, http.MethodGet, "/v1/account/profile", authTestOrigin, "", map[string]string{httpapi.GuestCredentialHeader: issued.Credential.Secret}, "")
	if guestRoute.Code != http.StatusUnauthorized {
		t.Fatalf("guest on an account route status=%d body=%s", guestRoute.Code, guestRoute.Body.String())
	}
}

func TestPostgresPublicAvatarIsABoundedChoice(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	handler := profileHTTPFixture(t, fixture)
	token := profileToken(t, fixture, "user_a", "session-alice")
	ownProfileID(t, handler, token)

	// An avatar outside the catalog is refused.
	refused := onlineHTTPRequest(handler, http.MethodPut, "/v1/account/profile", authTestOrigin, "", map[string]string{"Authorization": "Bearer " + token}, `{"avatar":"https://tracker.example/pixel.png"}`)
	if refused.Code != http.StatusBadRequest || !strings.Contains(refused.Body.String(), "invalid_avatar") {
		t.Fatalf("avatar status=%d body=%s", refused.Code, refused.Body.String())
	}

	// A chosen avatar is published as a bounded key.
	chosen := onlineHTTPRequest(handler, http.MethodPut, "/v1/account/profile", authTestOrigin, "", map[string]string{"Authorization": "Bearer " + token}, `{"avatar":"harbor"}`)
	if chosen.Code != http.StatusOK {
		t.Fatalf("chosen avatar status=%d body=%s", chosen.Code, chosen.Body.String())
	}
	payload := decodeProfile(t, chosen.Body.Bytes())
	avatar, _ := payload["avatar"].(map[string]any)
	if avatar["kind"] != "chosen" || avatar["value"] != "harbor" {
		t.Fatalf("avatar = %v, want the chosen harbor avatar", payload["avatar"])
	}

	// Clearing the choice returns the generated default.
	cleared := onlineHTTPRequest(handler, http.MethodPut, "/v1/account/profile", authTestOrigin, "", map[string]string{"Authorization": "Bearer " + token}, `{"avatar":""}`)
	if cleared.Code != http.StatusOK {
		t.Fatalf("cleared avatar status=%d body=%s", cleared.Code, cleared.Body.String())
	}
	payload = decodeProfile(t, cleared.Body.Bytes())
	avatar, _ = payload["avatar"].(map[string]any)
	if avatar["kind"] != "generated" {
		t.Fatalf("avatar = %v, want the generated default", payload["avatar"])
	}

	// A rejected avatar never changed the stored choice.
	final := onlineHTTPRequest(handler, http.MethodGet, "/v1/account/profile", authTestOrigin, "", map[string]string{"Authorization": "Bearer " + token}, "")
	payload = decodeProfile(t, final.Body.Bytes())
	avatar, _ = payload["avatar"].(map[string]any)
	if avatar["kind"] != "generated" {
		t.Fatalf("avatar = %v, want the generated default", payload["avatar"])
	}
}

func TestPostgresExplicitGuestLinkBindsTheSeatAndKeepsTheOriginalActor(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	handler := profileHTTPFixture(t, fixture)
	token := profileToken(t, fixture, "user_a", "session-alice")
	issued := createProfileGuestMatch(t, fixture, "match-link-one", "guest_alpha", "user_a")
	profileID := ownProfileID(t, handler, token)

	// The guest moves before the link, so the accepted fingerprint exists.
	guest := guestParticipant(t, fixture, issued)
	guestCtx := onlineauth.WithPrincipal(context.Background(), guest)
	move := online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         "match-link-one",
		OperationID:     "op-guest-move-1",
		ExpectedVersion: 1,
		Seat:            online.SeatWhite,
		ControlEpoch:    1,
		Action:          online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}},
	}
	if _, err := fixture.service.Execute(guestCtx, guest.Participant, move); err != nil {
		t.Fatalf("guest move: %v", err)
	}

	// Signing in does not link the guest seat.
	before := onlineHTTPRequest(handler, http.MethodGet, "/v1/account/profile", authTestOrigin, "", map[string]string{"Authorization": "Bearer " + token}, "")
	beforePayload := decodeProfile(t, before.Body.Bytes())
	links, _ := beforePayload["guestLinks"].([]any)
	if len(links) != 0 {
		t.Fatalf("signing in linked %d guest seats", len(links))
	}

	// The guest mints an ownership proof from its own seat credential.
	minted := onlineHTTPRequest(handler, http.MethodPost, "/v1/guest-seats/ownership-proof", authTestOrigin, "", map[string]string{httpapi.GuestCredentialHeader: issued.Credential.Secret}, "")
	if minted.Code != http.StatusOK {
		t.Fatalf("ownership proof status=%d body=%s", minted.Code, minted.Body.String())
	}
	mintedPayload := decodeProfile(t, minted.Body.Bytes())
	proofSecret, _ := mintedPayload["secret"].(string)
	if proofSecret == "" {
		t.Fatalf("the ownership proof carries no secret: %s", minted.Body.String())
	}
	// The proof identifier has the shape the browser contract parses.
	proofID, _ := mintedPayload["proofId"].(string)
	if !proofIDPattern.MatchString(proofID) {
		t.Fatalf("the proof identifier %q does not match the browser contract", proofID)
	}

	// The account links the seat explicitly.
	linked := onlineHTTPRequest(handler, http.MethodPost, "/v1/account/profile/guest-links", authTestOrigin, "", map[string]string{
		"Authorization":                "Bearer " + token,
		httpapi.GuestOwnershipProofHeader: proofSecret,
	}, `{"matchId":"match-link-one","seat":"white"}`)
	if linked.Code != http.StatusOK {
		t.Fatalf("guest link status=%d body=%s", linked.Code, linked.Body.String())
	}
	linkedPayload := decodeProfile(t, linked.Body.Bytes())
	if linkedPayload["matchId"] != "match-link-one" || linkedPayload["seat"] != "white" {
		t.Fatalf("guest link = %s", linked.Body.String())
	}
	if linkedPayload["profileId"] != profileID {
		t.Fatalf("guest link profile = %v, want %s", linkedPayload["profileId"], profileID)
	}

	// The seat owner is untouched: the guest stays the actor.
	var (
		ownerKind string
		ownerID   string
	)
	if err := fixture.pool.QueryRow(context.Background(), `SELECT owner_kind,owner_id FROM online_seats WHERE match_id='match-link-one' AND seat='white'`).Scan(&ownerKind, &ownerID); err != nil {
		t.Fatal(err)
	}
	if ownerKind != "guest" || ownerID != "guest_alpha" {
		t.Fatalf("the link rewrote the seat owner: %s/%s", ownerKind, ownerID)
	}

	// The accepted receipt is still there, and the same operation still
	// returns it.
	receipt, err := fixture.service.GetReceiptForParticipant(guestCtx, "match-link-one", "op-guest-move-1", guest.Participant)
	if err != nil {
		t.Fatalf("the link invalidated the accepted receipt: %v", err)
	}
	if receipt.Duplicate != true {
		t.Fatalf("the stored receipt is not a duplicate: %+v", receipt)
	}

	// The link is listed on the account's profile.
	after := onlineHTTPRequest(handler, http.MethodGet, "/v1/account/profile", authTestOrigin, "", map[string]string{"Authorization": "Bearer " + token}, "")
	afterPayload := decodeProfile(t, after.Body.Bytes())
	links, _ = afterPayload["guestLinks"].([]any)
	if len(links) != 1 {
		t.Fatalf("the account has %d linked guest seats, want 1", len(links))
	}

	// The proof is spent. The same proof never links a second profile.
	reused := onlineHTTPRequest(handler, http.MethodPost, "/v1/account/profile/guest-links", authTestOrigin, "", map[string]string{
		"Authorization":                "Bearer " + token,
		httpapi.GuestOwnershipProofHeader: proofSecret,
	}, `{"matchId":"match-link-one","seat":"white"}`)
	if reused.Code != http.StatusUnauthorized {
		t.Fatalf("reused proof status=%d body=%s", reused.Code, reused.Body.String())
	}
	// The spent proof is dead everywhere, not only in the link ledger.
	if _, err := fixture.authorizer.VerifyOwnershipProof(context.Background(), proofSecret, authTestOrigin); err == nil {
		t.Fatal("the spent proof still verifies")
	}
	var linkCount int
	if err := fixture.pool.QueryRow(context.Background(), `SELECT count(*) FROM online_profile_guest_links`).Scan(&linkCount); err != nil {
		t.Fatal(err)
	}
	if linkCount != 1 {
		t.Fatalf("%d links exist, want 1", linkCount)
	}
}

func TestPostgresGuestLinkRejectsAnotherSeatAndAnotherOwner(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	handler := profileHTTPFixture(t, fixture)
	tokenA := profileToken(t, fixture, "user_a", "session-alice")
	tokenB := profileToken(t, fixture, "user_b", "session-bob")
	ownProfileID(t, handler, tokenA)
	ownProfileID(t, handler, tokenB)

	// Two separate guest seats, owned by two different guests.
	alpha := createProfileGuestMatch(t, fixture, "match-owner-alpha", "guest_alpha", "user_a")
	beta := createProfileGuestMatch(t, fixture, "match-owner-beta", "guest_beta", "user_b")

	alphaProof := onlineHTTPRequest(handler, http.MethodPost, "/v1/guest-seats/ownership-proof", authTestOrigin, "", map[string]string{httpapi.GuestCredentialHeader: alpha.Credential.Secret}, "")
	if alphaProof.Code != http.StatusOK {
		t.Fatalf("alpha proof status=%d body=%s", alphaProof.Code, alphaProof.Body.String())
	}
	betaProof := onlineHTTPRequest(handler, http.MethodPost, "/v1/guest-seats/ownership-proof", authTestOrigin, "", map[string]string{httpapi.GuestCredentialHeader: beta.Credential.Secret}, "")
	if betaProof.Code != http.StatusOK {
		t.Fatalf("beta proof status=%d body=%s", betaProof.Code, betaProof.Body.String())
	}
	alphaSecret, _ := decodeProfile(t, alphaProof.Body.Bytes())["secret"].(string)
	betaSecret, _ := decodeProfile(t, betaProof.Body.Bytes())["secret"].(string)

	// A proof for another person's seat never links this one.
	otherSeat := onlineHTTPRequest(handler, http.MethodPost, "/v1/account/profile/guest-links", authTestOrigin, "", map[string]string{
		"Authorization":                "Bearer " + tokenB,
		httpapi.GuestOwnershipProofHeader: betaSecret,
	}, `{"matchId":"match-owner-alpha","seat":"white"}`)
	if otherSeat.Code != http.StatusUnauthorized {
		t.Fatalf("another account linked a foreign seat: status=%d body=%s", otherSeat.Code, otherSeat.Body.String())
	}

	// The same refusal, seen from the other side.
	otherProof := onlineHTTPRequest(handler, http.MethodPost, "/v1/account/profile/guest-links", authTestOrigin, "", map[string]string{
		"Authorization":                "Bearer " + tokenA,
		httpapi.GuestOwnershipProofHeader: betaSecret,
	}, `{"matchId":"match-owner-alpha","seat":"white"}`)
	if otherProof.Code != http.StatusUnauthorized {
		t.Fatalf("a foreign proof linked a seat: status=%d body=%s", otherProof.Code, otherProof.Body.String())
	}

	// A guest seat credential is not an ownership proof.
	credential := onlineHTTPRequest(handler, http.MethodPost, "/v1/account/profile/guest-links", authTestOrigin, "", map[string]string{
		"Authorization":                "Bearer " + tokenA,
		httpapi.GuestOwnershipProofHeader: alpha.Credential.Secret,
	}, `{"matchId":"match-owner-alpha","seat":"white"}`)
	if credential.Code != http.StatusUnauthorized {
		t.Fatalf("a seat credential linked a seat: status=%d body=%s", credential.Code, credential.Body.String())
	}

	// A request without a proof is refused.
	missing := onlineHTTPRequest(handler, http.MethodPost, "/v1/account/profile/guest-links", authTestOrigin, "", map[string]string{"Authorization": "Bearer " + tokenA}, `{"matchId":"match-owner-alpha","seat":"white"}`)
	if missing.Code != http.StatusUnauthorized {
		t.Fatalf("a proofless link status=%d body=%s", missing.Code, missing.Body.String())
	}

	// A guest never links a seat to an account.
	guestLink := onlineHTTPRequest(handler, http.MethodPost, "/v1/account/profile/guest-links", authTestOrigin, "", map[string]string{
		httpapi.GuestCredentialHeader:     alpha.Credential.Secret,
		httpapi.GuestOwnershipProofHeader: alphaSecret,
	}, `{"matchId":"match-owner-alpha","seat":"white"}`)
	if guestLink.Code != http.StatusUnauthorized {
		t.Fatalf("a guest linked a seat: status=%d body=%s", guestLink.Code, guestLink.Body.String())
	}

	// Nothing was linked by any of the refused requests.
	var links int
	if err := fixture.pool.QueryRow(context.Background(), `SELECT count(*) FROM online_profile_guest_links`).Scan(&links); err != nil {
		t.Fatal(err)
	}
	if links != 0 {
		t.Fatalf("%d links were created by refused requests", links)
	}

	// The owner of the seat can still link it.
	owner := onlineHTTPRequest(handler, http.MethodPost, "/v1/account/profile/guest-links", authTestOrigin, "", map[string]string{
		"Authorization":                "Bearer " + tokenA,
		httpapi.GuestOwnershipProofHeader: alphaSecret,
	}, `{"matchId":"match-owner-alpha","seat":"white"}`)
	if owner.Code != http.StatusOK {
		t.Fatalf("the owner could not link the seat: status=%d body=%s", owner.Code, owner.Body.String())
	}

	// The seat now belongs to that account. A second account is refused,
	// even with a fresh valid proof of the same seat.
	secondProof := onlineHTTPRequest(handler, http.MethodPost, "/v1/guest-seats/ownership-proof", authTestOrigin, "", map[string]string{httpapi.GuestCredentialHeader: alpha.Credential.Secret}, "")
	if secondProof.Code != http.StatusOK {
		t.Fatalf("second ownership proof status=%d body=%s", secondProof.Code, secondProof.Body.String())
	}
	secondSecret, _ := decodeProfile(t, secondProof.Body.Bytes())["secret"].(string)
	second := onlineHTTPRequest(handler, http.MethodPost, "/v1/account/profile/guest-links", authTestOrigin, "", map[string]string{
		"Authorization":                "Bearer " + tokenB,
		httpapi.GuestOwnershipProofHeader: secondSecret,
	}, `{"matchId":"match-owner-alpha","seat":"white"}`)
	if second.Code != http.StatusConflict || !strings.Contains(second.Body.String(), "seat_already_linked") {
		t.Fatalf("a second account linked a bound seat: status=%d body=%s", second.Code, second.Body.String())
	}
}

func TestPostgresGuestLinkRejectsADeadProofAndADeadCredential(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	handler := profileHTTPFixture(t, fixture)
	token := profileToken(t, fixture, "user_a", "session-alice")
	ownProfileID(t, handler, token)
	issued := createProfileGuestMatch(t, fixture, "match-dead-proof", "guest_alpha", "user_a")

	minted := onlineHTTPRequest(handler, http.MethodPost, "/v1/guest-seats/ownership-proof", authTestOrigin, "", map[string]string{httpapi.GuestCredentialHeader: issued.Credential.Secret}, "")
	if minted.Code != http.StatusOK {
		t.Fatalf("ownership proof status=%d body=%s", minted.Code, minted.Body.String())
	}
	proofSecret, _ := decodeProfile(t, minted.Body.Bytes())["secret"].(string)

	// A revoked seat credential kills every proof it issued.
	principal := guestParticipant(t, fixture, issued)
	if err := fixture.authorizer.RevokeSeatCredential(context.Background(), principal.CredentialID, "owner_request"); err != nil {
		t.Fatalf("revoke credential: %v", err)
	}
	dead := onlineHTTPRequest(handler, http.MethodPost, "/v1/account/profile/guest-links", authTestOrigin, "", map[string]string{
		"Authorization":                "Bearer " + token,
		httpapi.GuestOwnershipProofHeader: proofSecret,
	}, `{"matchId":"match-dead-proof","seat":"white"}`)
	if dead.Code != http.StatusUnauthorized {
		t.Fatalf("a dead proof linked a seat: status=%d body=%s", dead.Code, dead.Body.String())
	}
}

func TestPostgresGuestLinkRejectsARevokedAccountSession(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	handler := profileHTTPFixture(t, fixture)
	token := profileToken(t, fixture, "user_a", "session-alice")
	ownProfileID(t, handler, token)
	issued := createProfileGuestMatch(t, fixture, "match-revoked-session", "guest_alpha", "user_a")

	minted := onlineHTTPRequest(handler, http.MethodPost, "/v1/guest-seats/ownership-proof", authTestOrigin, "", map[string]string{httpapi.GuestCredentialHeader: issued.Credential.Secret}, "")
	if minted.Code != http.StatusOK {
		t.Fatalf("ownership proof status=%d body=%s", minted.Code, minted.Body.String())
	}
	proofSecret, _ := decodeProfile(t, minted.Body.Bytes())["secret"].(string)

	if err := fixture.authorizer.RevokeAccountSession(context.Background(), "user_a", "session-alice", "owner_request"); err != nil {
		t.Fatalf("revoke session: %v", err)
	}
	revoked := onlineHTTPRequest(handler, http.MethodPost, "/v1/account/profile/guest-links", authTestOrigin, "", map[string]string{
		"Authorization":                "Bearer " + token,
		httpapi.GuestOwnershipProofHeader: proofSecret,
	}, `{"matchId":"match-revoked-session","seat":"white"}`)
	if revoked.Code != http.StatusUnauthorized {
		t.Fatalf("a revoked session linked a seat: status=%d body=%s", revoked.Code, revoked.Body.String())
	}
	var links int
	if err := fixture.pool.QueryRow(context.Background(), `SELECT count(*) FROM online_profile_guest_links`).Scan(&links); err != nil {
		t.Fatal(err)
	}
	if links != 0 {
		t.Fatalf("%d links were created by a revoked session", links)
	}
}

func TestPostgresProfileLinkLedgerRefusesAForeignSeat(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	handler := profileHTTPFixture(t, fixture)
	token := profileToken(t, fixture, "user_a", "session-alice")
	profileID := ownProfileID(t, handler, token)
	issued := createProfileGuestMatch(t, fixture, "match-ledger-guard", "guest_alpha", "user_a")

	// A link that names somebody else's seat is refused by the database
	// guard, even when it is written directly.
	_, err := fixture.pool.Exec(context.Background(), `INSERT INTO online_profile_guest_links(link_id,profile_id,account_id,guest_id,match_id,seat,proof_id,linked_at) VALUES('kl_guardlink01',$1,'user_a','guest_beta','match-ledger-guard','white',$2,clock_timestamp())`,
		profileID, issued.OwnershipProof.ProofID)
	if err == nil {
		t.Fatal("the ledger accepted a link to a foreign seat")
	}
	if !hasPgCode(err, "55000") {
		t.Fatalf("the ledger refused a foreign seat with %v", err)
	}
}

func TestPostgresProfileUpdateRacesAreSerialized(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	handler := profileHTTPFixture(t, fixture)
	token := profileToken(t, fixture, "user_a", "session-alice")
	profileID := ownProfileID(t, handler, token)

	// Two edits of the same profile at the same time never produce a torn
	// name and avatar pair.
	type result struct {
		status int
		body   string
	}
	results := make([]result, 2)
	var group sync.WaitGroup
	group.Add(2)
	go func() {
		defer group.Done()
		response := onlineHTTPRequest(handler, http.MethodPut, "/v1/account/profile", authTestOrigin, "", map[string]string{"Authorization": "Bearer " + token}, `{"username":"steady","avatar":"tide"}`)
		results[0] = result{status: response.Code, body: response.Body.String()}
	}()
	go func() {
		defer group.Done()
		response := onlineHTTPRequest(handler, http.MethodPut, "/v1/account/profile", authTestOrigin, "", map[string]string{"Authorization": "Bearer " + token}, `{"username":"steady","avatar":"ember"}`)
		results[1] = result{status: response.Code, body: response.Body.String()}
	}()
	group.Wait()
	for _, outcome := range results {
		if outcome.status != http.StatusOK {
			t.Fatalf("a serialized edit failed: status=%d body=%s", outcome.status, outcome.body)
		}
	}
	final := onlineHTTPRequest(handler, http.MethodGet, "/v1/profiles/"+profileID, "", "", nil, "")
	payload := decodeProfile(t, final.Body.Bytes())
	if payload["username"] != "steady" {
		t.Fatalf("username = %v, want steady", payload["username"])
	}
	avatar, _ := payload["avatar"].(map[string]any)
	if avatar["kind"] != "chosen" {
		t.Fatalf("avatar = %v, want a chosen avatar", payload["avatar"])
	}
	switch avatar["value"] {
	case "tide", "ember":
	default:
		t.Fatalf("avatar = %v, want tide or ember", avatar["value"])
	}
}

func TestPostgresProfileUsernameRulesRejectReservedAndUnsafeNames(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	handler := profileHTTPFixture(t, fixture)
	token := profileToken(t, fixture, "user_a", "session-alice")
	ownProfileID(t, handler, token)

	for _, name := range []string{"guest", "GUEST", "admin", "deleted", "ab", "has space", "a@name.com", "-leading", "toolongusername-toolongusername"} {
		body, err := json.Marshal(map[string]string{"username": name})
		if err != nil {
			t.Fatal(err)
		}
		response := onlineHTTPRequest(handler, http.MethodPut, "/v1/account/profile", authTestOrigin, "", map[string]string{"Authorization": "Bearer " + token}, string(body))
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "invalid_username") {
			t.Fatalf("name %q status=%d body=%s", name, response.Code, response.Body.String())
		}
	}

	// A refused name never became the published name.
	final := onlineHTTPRequest(handler, http.MethodGet, "/v1/account/profile", authTestOrigin, "", map[string]string{"Authorization": "Bearer " + token}, "")
	payload := decodeProfile(t, final.Body.Bytes())
	if payload["username"] != nil {
		t.Fatalf("a refused name was published: %v", payload["username"])
	}
}

func TestPostgresProfileTablesHoldNoPrivateIdentity(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	handler := profileHTTPFixture(t, fixture)
	token := profileToken(t, fixture, "user_a", "session-alice")
	profileID := ownProfileID(t, handler, token)
	// The public read carries no private value of any kind.
	public := onlineHTTPRequest(handler, http.MethodGet, "/v1/profiles/"+profileID, "", "", nil, "")
	body := public.Body.String()
	for _, forbidden := range []string{"user_a", "session-alice", "clerk", "@"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("the public payload leaked %q: %s", forbidden, body)
		}
	}
	// The stored row keeps the account identifier on the server only.
	var accountID string
	if err := fixture.pool.QueryRow(context.Background(), `SELECT account_id FROM online_public_profiles WHERE profile_id=$1`, profileID).Scan(&accountID); err != nil {
		t.Fatal(err)
	}
	if accountID != "user_a" {
		t.Fatalf("stored account = %q", accountID)
	}
	if !strings.HasPrefix(profileID, "kp_") || strings.Contains(profileID, "user_a") {
		t.Fatalf("the public identifier leaks the account: %q", profileID)
	}
}
