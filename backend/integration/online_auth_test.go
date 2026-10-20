package integration

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/auth"
	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	authTestOrigin = "https://app.example"
	authGuestID    = "guest_alpha"
)

// onlineAuthFixture wires the real writer, the real authorization service,
// and a Clerk verifier that serves a fixed key.
type onlineAuthFixture struct {
	service    *online.Service
	authorizer *onlineauth.Service
	allocator  *onlineauth.Allocator
	pool       *pgxpool.Pool
	key        *rsa.PrivateKey
	verifier   *auth.Verifier
}

func newOnlineAuthFixture(t *testing.T, evaluator online.Evaluator) *onlineAuthFixture {
	t.Helper()
	ctx := context.Background()
	pool := testPool(t)
	if err := migrations.Apply(ctx, pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	jwks := fmt.Sprintf(`{"keys":[{"kty":"RSA","kid":"test-key","use":"sig","alg":"RS256","n":"%s","e":"AQAB"}]}`, base64.RawURLEncoding.EncodeToString(key.N.Bytes()))
	verifier, err := auth.NewVerifier(auth.Config{
		Issuer:            "https://clerk.example",
		JWKSURL:           "https://clerk.example/.well-known/jwks.json",
		AuthorizedParties: []string{authTestOrigin},
		AllowedOrigins:    []string{authTestOrigin},
		HTTPClient: &http.Client{Transport: roundTrip(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(jwks)), Header: make(http.Header)}, nil
		})},
	})
	if err != nil {
		t.Fatal(err)
	}
	authorizer, err := onlineauth.Open(ctx, pool, verifier, onlineauth.Options{GuestCredentialTTL: time.Hour, OwnershipProofTTL: 10 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	service, err := online.Open(ctx, pool, evaluator, online.WithSeatAuthorizer(authorizer))
	if err != nil {
		t.Fatal(err)
	}
	return &onlineAuthFixture{service: service, authorizer: authorizer, allocator: onlineauth.NewAllocator(authorizer), pool: pool, key: key, verifier: verifier}
}

// accountPrincipal builds the principal a verified Clerk session produces.
func accountPrincipal(subject, sessionID string) onlineauth.Principal {
	return onlineauth.NewAccountPrincipal(subject, sessionID, authTestOrigin, time.Now().Add(time.Hour))
}

// accountContext returns a context that carries the account principal.
func accountContext(subject, sessionID string) context.Context {
	return onlineauth.WithPrincipal(context.Background(), accountPrincipal(subject, sessionID))
}

// signSession mints a Clerk session token with an explicit session ID.
func signSession(t *testing.T, key *rsa.PrivateKey, subject, sessionID string, expiresAt time.Time) string {
	t.Helper()
	encode := func(data []byte) string { return base64.RawURLEncoding.EncodeToString(data) }
	header := encode([]byte(`{"alg":"RS256","kid":"test-key","typ":"JWT"}`))
	payload := encode([]byte(fmt.Sprintf(`{"iss":"https://clerk.example","sub":%q,"sid":%q,"azp":%q,"exp":%d,"token_use":"session"}`, subject, sessionID, authTestOrigin, expiresAt.Unix())))
	input := header + "." + payload
	digest := sha256.Sum256([]byte(input))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return input + "." + encode(signature)
}

// guestMatchCommand creates a match whose white seat is a guest.
func guestMatchCommand(matchID, operationID string) online.Command {
	return online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     operationID,
		ExpectedVersion: 0,
		Seat:            online.SeatBlack,
		ControlEpoch:    1,
		Action: online.Action{
			Kind: online.ActionCreateMatch,
			CreateMatch: &online.CreateMatchSetup{
				Variant:     "orthodox",
				StartingFEN: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
				TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000},
				Seats: online.CreateMatchSeats{
					White: online.CreateSeat{
						Participant: online.ParticipantRef{Kind: online.ParticipantGuest, ID: authGuestID},
						PublicLabel: "Guest",
						Control:     online.SeatControl{Kind: online.ControlHuman},
					},
					Black: online.CreateSeat{
						Participant: online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_a"},
						PublicLabel: "Alice",
						Control:     online.SeatControl{Kind: online.ControlHuman},
					},
				},
			},
		},
	}
}

// createGuestMatch creates a match and issues the guest seat credential for
// its white seat.
func createGuestMatch(t *testing.T, fixture *onlineAuthFixture, matchID string) onlineauth.IssuedSeatCredentials {
	t.Helper()
	ctx := accountContext("user_a", "session-alice")
	if _, err := fixture.service.Execute(ctx, online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_a"}, guestMatchCommand(matchID, "op-create-"+matchID)); err != nil {
		t.Fatalf("create guest match: %v", err)
	}
	issued, err := fixture.allocator.AcceptInvitation(ctx, onlineauth.AcceptInvitationRequest{
		MatchID: matchID,
		Seat:    online.SeatWhite,
		GuestID: authGuestID,
		Origin:  authTestOrigin,
	})
	if err != nil {
		t.Fatalf("accept invitation: %v", err)
	}
	return issued
}

func guestParticipant(t *testing.T, fixture *onlineAuthFixture, issued onlineauth.IssuedSeatCredentials) onlineauth.Principal {
	t.Helper()
	principal, err := fixture.authorizer.AuthenticateGuest(context.Background(), issued.Credential.Secret, authTestOrigin)
	if err != nil {
		t.Fatalf("authenticate guest: %v", err)
	}
	return principal
}

func TestPostgresOnlineGuestCredentialAuthorizesItsSeatAndReconnects(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	issued := createGuestMatch(t, fixture, "match-guest-auth")
	ctx := context.Background()
	principal := guestParticipant(t, fixture, issued)
	if principal.Participant != (online.ParticipantRef{Kind: online.ParticipantGuest, ID: authGuestID}) {
		t.Fatalf("guest participant = %+v", principal.Participant)
	}
	if principal.Seat != online.SeatWhite || principal.MatchID != "match-guest-auth" {
		t.Fatalf("guest binding = %+v", principal)
	}

	// The guest commands its own seat.
	guestCtx := onlineauth.WithPrincipal(ctx, principal)
	move := online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         "match-guest-auth",
		OperationID:     "op-guest-move-1",
		ExpectedVersion: 1,
		Seat:            online.SeatWhite,
		ControlEpoch:    1,
		Action:          online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}},
	}
	if _, err := fixture.service.Execute(guestCtx, principal.Participant, move); err != nil {
		t.Fatalf("guest move: %v", err)
	}

	// A reconnect presents the same credential again.
	reconnected := guestParticipant(t, fixture, issued)
	if reconnected.CredentialID != principal.CredentialID {
		t.Fatalf("reconnect changed the credential: %+v", reconnected)
	}
	reconnectCtx := onlineauth.WithPrincipal(ctx, reconnected)
	live, err := fixture.service.GetMatchForParticipant(reconnectCtx, "match-guest-auth", reconnected.Participant)
	if err != nil || live.Version != 2 {
		t.Fatalf("reconnect live read: %+v, %v", live, err)
	}
	receipt, err := fixture.service.GetReceiptForParticipant(reconnectCtx, "match-guest-auth", "op-guest-move-1", reconnected.Participant)
	if err != nil || !receipt.Duplicate {
		t.Fatalf("reconnect receipt read: %+v, %v", receipt, err)
	}

	// The guest credential never becomes another seat's control.
	other := move
	other.OperationID = "op-guest-move-2"
	other.Seat = online.SeatBlack
	other.ExpectedVersion = 2
	if _, err := fixture.service.Execute(guestCtx, principal.Participant, other); !errors.Is(err, online.ErrNotAuthorized) {
		t.Fatalf("guest command for the other seat = %v, want ErrNotAuthorized", err)
	}
}

func TestPostgresOnlineRevokedGuestCredentialStopsEveryAccess(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	issued := createGuestMatch(t, fixture, "match-guest-revoke")
	ctx := context.Background()
	principal := guestParticipant(t, fixture, issued)
	guestCtx := onlineauth.WithPrincipal(ctx, principal)
	move := online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         "match-guest-revoke",
		OperationID:     "op-guest-revoke-1",
		ExpectedVersion: 1,
		Seat:            online.SeatWhite,
		ControlEpoch:    1,
		Action:          online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}},
	}
	if _, err := fixture.service.Execute(guestCtx, principal.Participant, move); err != nil {
		t.Fatalf("guest move: %v", err)
	}
	if err := fixture.authorizer.RevokeSeatCredential(ctx, issued.Credential.CredentialID, "owner_request"); err != nil {
		t.Fatalf("revoke credential: %v", err)
	}
	if _, err := fixture.authorizer.AuthenticateGuest(ctx, issued.Credential.Secret, authTestOrigin); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("revoked credential still authenticates: %v", err)
	}
	// A revoked participant can no longer replay an accepted operation.
	if _, err := fixture.service.Execute(guestCtx, principal.Participant, move); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("revoked guest replay = %v, want ErrUnauthenticated", err)
	}
	if _, err := fixture.service.GetReceiptForParticipant(guestCtx, "match-guest-revoke", "op-guest-revoke-1", principal.Participant); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("revoked guest receipt read = %v, want ErrUnauthenticated", err)
	}
	if _, err := fixture.service.GetMatchForParticipant(guestCtx, "match-guest-revoke", principal.Participant); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("revoked guest live read = %v, want ErrUnauthenticated", err)
	}
}

func TestPostgresOnlineAccountSessionRevocationRejectsBeforeTokenExpiry(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	ctx := context.Background()
	expiresAt := time.Now().Add(time.Hour)
	token := signSession(t, fixture.key, "user_a", "session-alice", expiresAt)
	principal, err := fixture.authorizer.AuthenticateAccount(ctx, token, authTestOrigin)
	if err != nil {
		t.Fatalf("authenticate account: %v", err)
	}
	if principal.SessionID != "session-alice" || principal.ExpiresAt.Unix() != expiresAt.Unix() {
		t.Fatalf("account principal = %+v", principal)
	}
	accountCtx := onlineauth.WithPrincipal(ctx, principal)
	move := online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         "match-account-revoke",
		OperationID:     "op-account-move-1",
		ExpectedVersion: 1,
		Seat:            online.SeatWhite,
		ControlEpoch:    1,
		Action:          online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}},
	}
	if _, err := fixture.service.Execute(accountCtx, principal.Participant, createOnlineCommand("match-account-revoke", "op-account-create-1")); err != nil {
		t.Fatalf("create account match: %v", err)
	}
	if _, err := fixture.service.Execute(accountCtx, principal.Participant, move); err != nil {
		t.Fatalf("account move: %v", err)
	}
	if err := fixture.authorizer.RevokeAccountSession(ctx, "user_a", "session-alice", "session_ended"); err != nil {
		t.Fatalf("revoke session: %v", err)
	}
	// The token is still inside its lifetime. The durable revocation is what
	// rejects it.
	if time.Now().Before(expiresAt) == false {
		t.Fatal("the fixture token expired early")
	}
	if _, err := fixture.authorizer.AuthenticateAccount(ctx, token, authTestOrigin); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("revoked session still authenticates: %v", err)
	}
	retry := move
	if _, err := fixture.service.Execute(accountCtx, principal.Participant, retry); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("revoked session command = %v, want ErrUnauthenticated", err)
	}
}

func TestPostgresOnlineNonMemberCannotReadOrCommand(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	createGuestMatch(t, fixture, "match-non-member")
	ctx := context.Background()
	intruder := onlineauth.NewAccountPrincipal("user_intruder", "session-intruder", authTestOrigin, time.Now().Add(time.Hour))
	intruderCtx := onlineauth.WithPrincipal(ctx, intruder)
	if _, err := fixture.service.GetMatchForParticipant(intruderCtx, "match-non-member", intruder.Participant); !errors.Is(err, online.ErrNotFound) {
		t.Fatalf("non-member live read = %v, want ErrNotFound", err)
	}
	if _, err := fixture.service.GetReceiptForParticipant(intruderCtx, "match-non-member", "op-create-match-non-member", intruder.Participant); !errors.Is(err, online.ErrNotFound) {
		t.Fatalf("non-member receipt read = %v, want ErrNotFound", err)
	}
	command := online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         "match-non-member",
		OperationID:     "op-intruder-move-1",
		ExpectedVersion: 1,
		Seat:            online.SeatWhite,
		ControlEpoch:    1,
		Action:          online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}},
	}
	if _, err := fixture.service.Execute(intruderCtx, intruder.Participant, command); !errors.Is(err, online.ErrNotAuthorized) {
		t.Fatalf("non-member command = %v, want ErrNotAuthorized", err)
	}
}

// pausingEvaluator blocks inside the rules evaluation so a test can act while
// the writer holds no database lock.
type pausingEvaluator struct {
	moveEvaluator
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (e *pausingEvaluator) Evaluate(ctx context.Context, input online.RulesInput) (online.Candidate, error) {
	e.once.Do(func() { close(e.entered) })
	select {
	case <-e.release:
	case <-ctx.Done():
		return online.Candidate{}, ctx.Err()
	}
	return e.moveEvaluator.Evaluate(ctx, input)
}

func TestPostgresOnlineRevocationDuringRulesEvaluationRejectsTheCommand(t *testing.T) {
	evaluator := &pausingEvaluator{entered: make(chan struct{}), release: make(chan struct{})}
	fixture := newOnlineAuthFixture(t, evaluator)
	issued := createGuestMatch(t, fixture, "match-guest-race")
	ctx := context.Background()
	principal := guestParticipant(t, fixture, issued)
	guestCtx := onlineauth.WithPrincipal(ctx, principal)
	move := online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         "match-guest-race",
		OperationID:     "op-guest-race-1",
		ExpectedVersion: 1,
		Seat:            online.SeatWhite,
		ControlEpoch:    1,
		Action:          online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}},
	}
	result := make(chan error, 1)
	go func() {
		_, err := fixture.service.Execute(guestCtx, principal.Participant, move)
		result <- err
	}()
	<-evaluator.entered
	// The rules process is working. The writer holds no database lock, so the
	// revocation completes immediately.
	revoked := make(chan error, 1)
	go func() {
		revoked <- fixture.authorizer.RevokeSeatCredential(ctx, issued.Credential.CredentialID, "owner_request")
	}()
	select {
	case err := <-revoked:
		if err != nil {
			t.Fatalf("revoke during evaluation: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the revocation blocked on a lock held during rules evaluation")
	}
	close(evaluator.release)
	if err := <-result; !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("command after revocation = %v, want ErrUnauthenticated", err)
	}
	match, err := fixture.service.GetMatch(ctx, "match-guest-race")
	if err != nil || match.Version != 1 || len(match.Moves) != 0 {
		t.Fatalf("revoked command changed the match: %+v, %v", match, err)
	}
}

// receiptWriteTracer fires once when the writer is about to store a receipt.
// The acceptance transaction already holds the participant lock at that point.
type receiptWriteTracer struct {
	fire  func()
	once  sync.Once
	armed bool
}

func (tr *receiptWriteTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if tr.armed && strings.Contains(data.SQL, "INSERT INTO online_operation_receipts") {
		tr.once.Do(tr.fire)
	}
	return ctx
}

func (tr *receiptWriteTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestPostgresOnlineRevocationIsSerializedWithTheAcceptedWrite(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	issued := createGuestMatch(t, fixture, "match-guest-serialized")
	ctx := context.Background()
	principal := guestParticipant(t, fixture, issued)
	guestCtx := onlineauth.WithPrincipal(ctx, principal)

	// A second pool carries the tracer so the command transaction can be
	// paused after its authorization check and before its commit.
	cfg := fixture.pool.Config()
	tracer := &receiptWriteTracer{armed: true}
	cfg.ConnConfig.Tracer = tracer
	tracedPool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer tracedPool.Close()
	traced, err := online.Open(ctx, tracedPool, moveEvaluator{}, online.WithSeatAuthorizer(fixture.authorizer))
	if err != nil {
		t.Fatal(err)
	}

	var (
		mu     sync.Mutex
		events []string
	)
	record := func(event string) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, event)
	}
	revokeStarted := make(chan struct{})
	revokeDone := make(chan error, 1)
	tracer.fire = func() {
		go func() {
			record("revoke-start")
			close(revokeStarted)
			err := fixture.authorizer.RevokeSeatCredential(ctx, issued.Credential.CredentialID, "owner_request")
			record("revoke-end")
			revokeDone <- err
		}()
		<-revokeStarted
		mu.Lock()
		finished := len(events) > 1 && events[1] == "revoke-end"
		mu.Unlock()
		if finished {
			t.Error("the revocation completed while the acceptance transaction was still open")
		}
	}
	move := online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         "match-guest-serialized",
		OperationID:     "op-guest-serialized-1",
		ExpectedVersion: 1,
		Seat:            online.SeatWhite,
		ControlEpoch:    1,
		Action:          online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}},
	}
	if _, err := traced.Execute(guestCtx, principal.Participant, move); err != nil {
		t.Fatalf("traced command: %v", err)
	}
	record("command-end")
	select {
	case err := <-revokeDone:
		if err != nil {
			t.Fatalf("revoke: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the revocation never completed")
	}
	mu.Lock()
	ordered := append([]string(nil), events...)
	mu.Unlock()
	if len(ordered) != 3 || ordered[0] != "revoke-start" || ordered[1] != "command-end" || ordered[2] != "revoke-end" {
		t.Fatalf("the revocation did not wait for the accepted write: %v", ordered)
	}
	match, err := fixture.service.GetMatch(ctx, "match-guest-serialized")
	if err != nil || match.Version != 2 || len(match.Moves) != 1 {
		t.Fatalf("the accepted write did not land: %+v, %v", match, err)
	}
}

func TestPostgresOnlineGuestOwnershipProofIsAppendOnlyAndGrantsNoControl(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	issued := createGuestMatch(t, fixture, "match-guest-proof")
	ctx := context.Background()
	proof, err := fixture.allocator.IssueOwnershipProof(ctx, issued.Credential.Secret, authTestOrigin)
	if err != nil {
		t.Fatalf("issue ownership proof: %v", err)
	}
	verified, err := fixture.authorizer.VerifyOwnershipProof(ctx, proof.Secret, authTestOrigin)
	if err != nil {
		t.Fatalf("verify ownership proof: %v", err)
	}
	if verified.GuestID != authGuestID || verified.Seat != online.SeatWhite || verified.MatchID != "match-guest-proof" {
		t.Fatalf("ownership proof = %+v", verified)
	}
	link, err := fixture.authorizer.AuthorizeGuestLink(ctx, proof.Secret, authTestOrigin, accountPrincipal("user_a", "session-alice"))
	if err != nil {
		t.Fatalf("authorize guest link: %v", err)
	}
	if link.GuestID != authGuestID || link.AccountID != "user_a" || link.Seat != online.SeatWhite {
		t.Fatalf("link authorization = %+v", link)
	}
	// The proof never changes the seat owner or the guest actor.
	match, err := fixture.service.GetMatch(ctx, "match-guest-proof")
	if err != nil {
		t.Fatal(err)
	}
	seat, ok := match.Seat(online.SeatWhite)
	if !ok || seat.Participant.ID != authGuestID || seat.Participant.Kind != online.ParticipantGuest {
		t.Fatalf("the ownership proof changed the seat owner: %+v", seat.Participant)
	}
	// A proof is not a seat credential.
	if _, err := fixture.authorizer.AuthenticateGuest(ctx, proof.Secret, authTestOrigin); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("an ownership proof authenticated as a seat credential: %v", err)
	}
}

func TestPostgresOnlineGuestCredentialAndProofRecordsAreAppendOnly(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	issued := createGuestMatch(t, fixture, "match-append-only")
	ctx := context.Background()
	proof, err := fixture.allocator.IssueOwnershipProof(ctx, issued.Credential.Secret, authTestOrigin)
	if err != nil {
		t.Fatal(err)
	}
	// A proof record is append-only. It cannot be rewritten or deleted.
	if _, err = fixture.pool.Exec(ctx, `UPDATE online_guest_ownership_proofs SET guest_id='other_guest' WHERE proof_id=$1`, proof.ProofID); !hasPgCode(err, "55000") {
		t.Fatalf("rewrite an ownership proof = %v, want SQLSTATE 55000", err)
	}
	if _, err = fixture.pool.Exec(ctx, `DELETE FROM online_guest_ownership_proofs WHERE proof_id=$1`, proof.ProofID); !hasPgCode(err, "55000") {
		t.Fatalf("delete an ownership proof = %v, want SQLSTATE 55000", err)
	}
	// A credential keeps its identity and its stored hash.
	if _, err = fixture.pool.Exec(ctx, `UPDATE online_guest_seat_credentials SET secret_hash=$1 WHERE credential_id=$2`, make([]byte, 32), issued.Credential.CredentialID); !hasPgCode(err, "55000") {
		t.Fatalf("rewrite a credential hash = %v, want SQLSTATE 55000", err)
	}
	if _, err = fixture.pool.Exec(ctx, `DELETE FROM online_guest_seat_credentials WHERE credential_id=$1`, issued.Credential.CredentialID); !hasPgCode(err, "55000") {
		t.Fatalf("delete a credential = %v, want SQLSTATE 55000", err)
	}
	// A session revocation cannot be un-revoked.
	if err = fixture.authorizer.RevokeAccountSession(ctx, "user_a", "session-append", "session_ended"); err != nil {
		t.Fatal(err)
	}
	if _, err = fixture.pool.Exec(ctx, `UPDATE online_session_revocations SET reason='admin' WHERE subject_id='user_a' AND session_id='session-append'`); !hasPgCode(err, "55000") {
		t.Fatalf("rewrite a session revocation = %v, want SQLSTATE 55000", err)
	}
}

func TestPostgresOnlineStoredStateNeverContainsTheCredentialSecret(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	issued := createGuestMatch(t, fixture, "match-no-secret")
	ctx := context.Background()
	principal := guestParticipant(t, fixture, issued)
	guestCtx := onlineauth.WithPrincipal(ctx, principal)
	move := online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         "match-no-secret",
		OperationID:     "op-no-secret-1",
		ExpectedVersion: 1,
		Seat:            online.SeatWhite,
		ControlEpoch:    1,
		Action:          online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}},
	}
	if _, err := fixture.service.Execute(guestCtx, principal.Participant, move); err != nil {
		t.Fatalf("guest move: %v", err)
	}
	for _, table := range []string{"online_matches", "online_seats", "online_clocks", "online_moves", "online_events", "online_operation_receipts", "online_public_projections", "online_guest_seat_credentials", "online_guest_ownership_proofs"} {
		var leaked int
		if err := fixture.pool.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE `+columnFor(table)+`::text LIKE '%'||$1||'%'`, issued.Credential.Secret).Scan(&leaked); err != nil {
			t.Fatalf("scan %s: %v", table, err)
		}
		if leaked != 0 {
			t.Fatalf("%s stored the guest credential secret", table)
		}
	}
}

func columnFor(table string) string {
	switch table {
	case "online_matches":
		return "match_id"
	case "online_seats":
		return "owner_id"
	case "online_clocks":
		return "match_id"
	case "online_moves":
		return "match_id"
	case "online_events":
		return "match_id"
	case "online_operation_receipts":
		return "scope_id"
	case "online_public_projections":
		return "match_id"
	case "online_guest_seat_credentials":
		return "credential_id"
	case "online_guest_ownership_proofs":
		return "proof_id"
	default:
		return "match_id"
	}
}

func TestPostgresOnlinePublicReplayIsPublicAndLiveStateIsNot(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	issued := createGuestMatch(t, fixture, "match-replay-public")
	aliceCtx := accountContext("user_a", "session-alice")
	resign := online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         "match-replay-public",
		OperationID:     "op-replay-resign-1",
		ExpectedVersion: 1,
		Seat:            online.SeatBlack,
		ControlEpoch:    1,
		Action:          online.Action{Kind: online.ActionResign},
	}
	if _, err := fixture.service.Execute(aliceCtx, online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_a"}, resign); err != nil {
		t.Fatalf("resign: %v", err)
	}
	handler := httpapi.NewOnline(fixture.service, fixture.authorizer, httpapi.OnlineOptions{AllowedOrigins: []string{authTestOrigin}})
	projection := httptest.NewRecorder()
	handler.ServeHTTP(projection, httptest.NewRequest(http.MethodGet, "/v1/online/matches/match-replay-public/replay", nil))
	if projection.Code != http.StatusOK {
		t.Fatalf("public replay status=%d body=%s", projection.Code, projection.Body.String())
	}
	body := projection.Body.String()
	for _, forbidden := range []string{authGuestID, "user_a", "credential", "session"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("public replay leaked %q: %s", forbidden, body)
		}
	}
	live := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/v1/online/matches/match-replay-public", nil)
	request.Header.Set("Origin", authTestOrigin)
	handler.ServeHTTP(live, request)
	if live.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous live read status=%d body=%s", live.Code, live.Body.String())
	}
	live = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/v1/online/matches/match-replay-public", nil)
	request.Header.Set("Origin", authTestOrigin)
	request.Header.Set(httpapi.GuestCredentialHeader, issued.Credential.Secret)
	handler.ServeHTTP(live, request)
	if live.Code != http.StatusOK {
		t.Fatalf("participant live read status=%d body=%s", live.Code, live.Body.String())
	}
	if strings.Contains(live.Body.String(), authGuestID) {
		t.Fatalf("live state leaked the participant reference: %s", live.Body.String())
	}
}
