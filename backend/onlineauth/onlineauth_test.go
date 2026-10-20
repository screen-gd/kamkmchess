package onlineauth

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

func TestGuestSecretsAreOpaqueUniqueAndDomainSeparated(t *testing.T) {
	first, err := newSecret(credentialPrefix)
	if err != nil {
		t.Fatal(err)
	}
	second, err := newSecret(credentialPrefix)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("two issued secrets are identical")
	}
	if !strings.HasPrefix(first, credentialPrefix) || len(first) != len(credentialPrefix)+43 {
		t.Fatalf("unexpected secret shape: %q", first)
	}
	if !secretShape(first, credentialPrefix) {
		t.Fatal("a freshly issued secret failed its own shape check")
	}
	if secretShape(first, proofPrefix) {
		t.Fatal("a seat credential passed the ownership proof shape check")
	}
	if secretShape("kmgc1_short", credentialPrefix) {
		t.Fatal("a malformed secret passed the shape check")
	}
	if string(hashSecret("seat-control", first)) == string(hashSecret("ownership-proof", first)) {
		t.Fatal("the stored hash is not domain separated")
	}
	if len(hashSecret("seat-control", first)) != 32 {
		t.Fatal("the stored hash is not a 32 byte digest")
	}
}

func TestIssuedCredentialsRedactTheirSecret(t *testing.T) {
	credential := IssuedSeatCredential{
		CredentialID: "kgcredential",
		GuestID:      "guest_alpha",
		MatchID:      "match-example",
		Seat:         online.SeatWhite,
		Origin:       "https://app.example",
		Secret:       "kmgc1_canary_secret_value_that_must_not_leak",
	}
	encoded, err := json.Marshal(credential)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "canary_secret_value") {
		t.Fatalf("the issued credential leaked its secret: %s", encoded)
	}
	var logged strings.Builder
	logger := slog.New(slog.NewTextHandler(&logged, nil))
	logger.Info("issued", "credential", credential)
	if strings.Contains(logged.String(), "canary_secret_value") {
		t.Fatalf("the issued credential leaked its secret into a log line: %s", logged.String())
	}
	proof := IssuedOwnershipProof{ProofID: "kgproof", GuestID: "guest_alpha", MatchID: "match-example", Seat: online.SeatWhite, Secret: "kmgp1_canary_proof_value"}
	encodedProof, err := json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encodedProof), "canary_proof_value") {
		t.Fatalf("the issued proof leaked its secret: %s", encodedProof)
	}
}

func TestAuthorizationServiceCannotIssueCredentials(t *testing.T) {
	// The public HTTP surface only ever holds the service. It must not be
	// able to mint a seat credential, so it has no issuance method at all.
	service := reflect.TypeOf(&Service{})
	for index := 0; index < service.NumMethod(); index++ {
		name := service.Method(index).Name
		for _, forbidden := range []string{"Accept", "Issue", "Mint", "Create", "New", "Grant"} {
			if strings.Contains(name, forbidden) {
				t.Fatalf("the authorization service exposes an issuance method: %s", name)
			}
		}
	}
	allocator := reflect.TypeOf(&Allocator{})
	found := false
	for index := 0; index < allocator.NumMethod(); index++ {
		if allocator.Method(index).Name == "AcceptInvitation" {
			found = true
		}
	}
	if !found {
		t.Fatal("the trusted allocator does not expose the invitation acceptance method")
	}
}

func TestPrincipalContextRoundTrip(t *testing.T) {
	if _, ok := PrincipalFromContext(context.Background()); ok {
		t.Fatal("an empty context returned a principal")
	}
	principal := NewAccountPrincipal("user_a", "session-a", "https://app.example", time.Now().Add(time.Hour))
	restored, ok := PrincipalFromContext(WithPrincipal(context.Background(), principal))
	if !ok {
		t.Fatal("the attached principal was not restored")
	}
	if restored.Participant != principal.Participant || restored.SessionID != principal.SessionID {
		t.Fatalf("restored principal = %+v", restored)
	}
}

func TestAdvisoryLocksAreStableAndSeparateNamespaces(t *testing.T) {
	if accountLockKey("user_a") != accountLockKey("user_a") {
		t.Fatal("the account lock key is not stable")
	}
	if accountLockKey("user_a") == accountLockKey("user_b") {
		t.Fatal("two accounts share a lock key")
	}
	if seatLockKey("match-a", online.SeatWhite) == seatLockKey("match-a", online.SeatBlack) {
		t.Fatal("two seats share a lock key")
	}
	if seatLockKey("match-a", online.SeatWhite) == accountLockKey("match-a") {
		t.Fatal("the account and seat namespaces collide")
	}
}

func TestAuthorizeSeatFailsClosedWithoutAPresentedPrincipal(t *testing.T) {
	service := &Service{}
	err := service.AuthorizeSeat(context.Background(), nil, "match-example", online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_a"}, "")
	if !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("authorize without a principal = %v, want ErrUnauthenticated", err)
	}
}
