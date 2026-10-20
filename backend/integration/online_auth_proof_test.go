package integration

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
)

// createGuestSeatMatch creates a match whose white seat belongs to the guest
// and accepts no invitation. The caller chooses the allocator, so a test can
// pick the credential and proof lifetimes it needs.
func createGuestSeatMatch(t *testing.T, fixture *onlineAuthFixture, matchID string) {
	t.Helper()
	ctx := accountContext("user_a", "session-alice")
	if _, err := fixture.service.Execute(ctx, online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_a"}, guestMatchCommand(matchID, "op-create-"+matchID)); err != nil {
		t.Fatalf("create guest match: %v", err)
	}
}

// openAuthorizer opens an authorization service over the fixture database
// with explicit lifetimes and an explicit clock.
func openAuthorizer(t *testing.T, fixture *onlineAuthFixture, options onlineauth.Options) *onlineauth.Service {
	t.Helper()
	service, err := onlineauth.Open(context.Background(), fixture.pool, fixture.verifier, options)
	if err != nil {
		t.Fatal(err)
	}
	return service
}

// liveCredentialCount counts the credentials of one seat that are still usable.
func liveCredentialCount(t *testing.T, fixture *onlineAuthFixture, matchID string, seat online.Seat) int {
	t.Helper()
	var count int
	if err := fixture.pool.QueryRow(context.Background(), `SELECT count(*) FROM online_guest_seat_credentials WHERE match_id=$1 AND seat=$2 AND revoked_at IS NULL AND superseded_at IS NULL`, matchID, string(seat)).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

// acceptGuestInvitation issues the seat credential of the guest seat of a match.
func acceptGuestInvitation(t *testing.T, fixture *onlineAuthFixture, matchID string) onlineauth.IssuedSeatCredentials {
	t.Helper()
	issued, err := fixture.allocator.AcceptInvitation(context.Background(), onlineauth.AcceptInvitationRequest{
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

func TestPostgresGuestOwnershipProofDiesWithItsRevokedCredential(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	createGuestSeatMatch(t, fixture, "match-proof-revoked")
	ctx := context.Background()
	issued := acceptGuestInvitation(t, fixture, "match-proof-revoked")
	proof, err := fixture.allocator.IssueOwnershipProof(ctx, issued.Credential.Secret, authTestOrigin)
	if err != nil {
		t.Fatalf("issue ownership proof: %v", err)
	}
	if _, err := fixture.authorizer.VerifyOwnershipProof(ctx, proof.Secret, authTestOrigin); err != nil {
		t.Fatalf("verify ownership proof: %v", err)
	}
	// Revoking the credential kills every proof it issued.
	if err := fixture.authorizer.RevokeSeatCredential(ctx, issued.Credential.CredentialID, "owner_request"); err != nil {
		t.Fatalf("revoke credential: %v", err)
	}
	if _, err := fixture.authorizer.VerifyOwnershipProof(ctx, proof.Secret, authTestOrigin); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("a proof of a revoked credential still verifies: %v", err)
	}
	if _, err := fixture.authorizer.AuthorizeGuestLink(ctx, proof.Secret, authTestOrigin, accountPrincipal("user_a", "session-alice")); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("a proof of a revoked credential still authorizes a link: %v", err)
	}
}

func TestPostgresGuestOwnershipProofDiesWithItsRevokedSeat(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	createGuestSeatMatch(t, fixture, "match-proof-seat-revoked")
	ctx := context.Background()
	issued := acceptGuestInvitation(t, fixture, "match-proof-seat-revoked")
	proof, err := fixture.allocator.IssueOwnershipProof(ctx, issued.Credential.Secret, authTestOrigin)
	if err != nil {
		t.Fatalf("issue ownership proof: %v", err)
	}
	if err := fixture.authorizer.RevokeGuestSeat(ctx, "match-proof-seat-revoked", online.SeatWhite, "seat_removed"); err != nil {
		t.Fatalf("revoke guest seat: %v", err)
	}
	if _, err := fixture.authorizer.VerifyOwnershipProof(ctx, proof.Secret, authTestOrigin); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("a proof of a revoked seat still verifies: %v", err)
	}
	if _, err := fixture.authorizer.AuthorizeGuestLink(ctx, proof.Secret, authTestOrigin, accountPrincipal("user_a", "session-alice")); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("a proof of a revoked seat still authorizes a link: %v", err)
	}
}

func TestPostgresGuestOwnershipProofIsRenewedByACredentialRotation(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	createGuestSeatMatch(t, fixture, "match-proof-rotation")
	ctx := context.Background()
	first := acceptGuestInvitation(t, fixture, "match-proof-rotation")
	firstProof, err := fixture.allocator.IssueOwnershipProof(ctx, first.Credential.Secret, authTestOrigin)
	if err != nil {
		t.Fatalf("issue ownership proof: %v", err)
	}
	if _, err := fixture.authorizer.VerifyOwnershipProof(ctx, firstProof.Secret, authTestOrigin); err != nil {
		t.Fatalf("verify ownership proof: %v", err)
	}
	// A rotation supersedes the earlier credential of the seat.
	second := acceptGuestInvitation(t, fixture, "match-proof-rotation")
	if _, err := fixture.authorizer.AuthenticateGuest(ctx, first.Credential.Secret, authTestOrigin); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("a rotated credential still authenticates: %v", err)
	}
	if _, err := fixture.authorizer.VerifyOwnershipProof(ctx, firstProof.Secret, authTestOrigin); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("a proof of a rotated credential still verifies: %v", err)
	}
	if _, err := fixture.authorizer.VerifyOwnershipProof(ctx, first.OwnershipProof.Secret, authTestOrigin); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("the invitation proof of a rotated credential still verifies: %v", err)
	}
	// The guest renews its ownership proof from the new credential.
	secondProof, err := fixture.allocator.IssueOwnershipProof(ctx, second.Credential.Secret, authTestOrigin)
	if err != nil {
		t.Fatalf("renew ownership proof: %v", err)
	}
	verified, err := fixture.authorizer.VerifyOwnershipProof(ctx, secondProof.Secret, authTestOrigin)
	if err != nil {
		t.Fatalf("verify renewed ownership proof: %v", err)
	}
	if verified.GuestID != authGuestID || verified.Seat != online.SeatWhite || verified.MatchID != "match-proof-rotation" {
		t.Fatalf("renewed ownership proof = %+v", verified)
	}
	if liveCredentialCount(t, fixture, "match-proof-rotation", online.SeatWhite) != 1 {
		t.Fatal("the rotation left more than one live credential on the seat")
	}
}

func TestPostgresGuestOwnershipProofExpiresWithItsCredential(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	createGuestSeatMatch(t, fixture, "match-proof-expiry")
	ctx := context.Background()
	base := time.Date(2026, time.March, 1, 12, 0, 0, 0, time.UTC)
	shortLived := openAuthorizer(t, fixture, onlineauth.Options{
		GuestCredentialTTL: time.Minute,
		OwnershipProofTTL:  24 * time.Hour,
		Now:                func() time.Time { return base },
	})
	allocator := onlineauth.NewAllocator(shortLived)
	issued, err := allocator.AcceptInvitation(ctx, onlineauth.AcceptInvitationRequest{
		MatchID: "match-proof-expiry",
		Seat:    online.SeatWhite,
		GuestID: authGuestID,
		Origin:  authTestOrigin,
	})
	if err != nil {
		t.Fatalf("accept invitation: %v", err)
	}
	proof, err := allocator.IssueOwnershipProof(ctx, issued.Credential.Secret, authTestOrigin)
	if err != nil {
		t.Fatalf("issue ownership proof: %v", err)
	}
	var credentialExpires, proofExpires time.Time
	if err := fixture.pool.QueryRow(ctx, `SELECT expires_at FROM online_guest_seat_credentials WHERE credential_id=$1`, issued.Credential.CredentialID).Scan(&credentialExpires); err != nil {
		t.Fatal(err)
	}
	if err := fixture.pool.QueryRow(ctx, `SELECT expires_at FROM online_guest_ownership_proofs WHERE proof_id=$1`, proof.ProofID).Scan(&proofExpires); err != nil {
		t.Fatal(err)
	}
	if !proofExpires.After(credentialExpires) {
		t.Fatalf("the proof does not outlive its credential on paper: proof=%s credential=%s", proofExpires, credentialExpires)
	}
	// The credential is dead one minute later. The proof is not, and it must
	// still be rejected because its parent credential no longer lives.
	later := openAuthorizer(t, fixture, onlineauth.Options{
		GuestCredentialTTL: time.Minute,
		OwnershipProofTTL:  24 * time.Hour,
		Now:                func() time.Time { return base.Add(2 * time.Minute) },
	})
	if _, err := later.VerifyOwnershipProof(ctx, proof.Secret, authTestOrigin); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("a proof of an expired credential still verifies: %v", err)
	}
	// The proof's own expiry ends it as well.
	ended := openAuthorizer(t, fixture, onlineauth.Options{
		GuestCredentialTTL: time.Minute,
		OwnershipProofTTL:  24 * time.Hour,
		Now:                func() time.Time { return base.Add(25 * time.Hour) },
	})
	if _, err := ended.VerifyOwnershipProof(ctx, proof.Secret, authTestOrigin); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("an expired proof still verifies: %v", err)
	}
}

func TestPostgresGuestOwnershipProofIsScopedToItsOrigin(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	createGuestSeatMatch(t, fixture, "match-proof-origin")
	ctx := context.Background()
	issued := acceptGuestInvitation(t, fixture, "match-proof-origin")
	proof, err := fixture.allocator.IssueOwnershipProof(ctx, issued.Credential.Secret, authTestOrigin)
	if err != nil {
		t.Fatalf("issue ownership proof: %v", err)
	}
	if _, err := fixture.authorizer.VerifyOwnershipProof(ctx, proof.Secret, "https://other.example"); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("a proof verifies from another origin: %v", err)
	}
	if _, err := fixture.authorizer.AuthorizeGuestLink(ctx, proof.Secret, "https://other.example", accountPrincipal("user_a", "session-alice")); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("a proof authorizes a link from another origin: %v", err)
	}
	if _, err := fixture.authorizer.VerifyOwnershipProof(ctx, issued.Credential.Secret, authTestOrigin); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("a seat credential verifies as an ownership proof: %v", err)
	}
}

func TestPostgresGuestLinkRequiresAVerifiedAccountIdentity(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	createGuestSeatMatch(t, fixture, "match-proof-account")
	ctx := context.Background()
	issued := acceptGuestInvitation(t, fixture, "match-proof-account")
	proof, err := fixture.allocator.IssueOwnershipProof(ctx, issued.Credential.Secret, authTestOrigin)
	if err != nil {
		t.Fatalf("issue ownership proof: %v", err)
	}
	// A guest is authenticated, but a guest is never an account identity.
	guest := guestParticipant(t, fixture, issued)
	if _, err := fixture.authorizer.AuthorizeGuestLink(ctx, proof.Secret, authTestOrigin, guest); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("a guest principal authorized an account link: %v", err)
	}
	// A revoked account session authorizes nothing.
	if err := fixture.authorizer.RevokeAccountSession(ctx, "user_a", "session-link", "session_ended"); err != nil {
		t.Fatalf("revoke session: %v", err)
	}
	revoked := accountPrincipal("user_a", "session-link")
	if _, err := fixture.authorizer.AuthorizeGuestLink(ctx, proof.Secret, authTestOrigin, revoked); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("a revoked account session authorized an account link: %v", err)
	}
	// An account identity from another origin authorizes nothing.
	foreign := onlineauth.NewAccountPrincipal("user_a", "session-alice", "https://other.example", time.Now().Add(time.Hour))
	if _, err := fixture.authorizer.AuthorizeGuestLink(ctx, proof.Secret, authTestOrigin, foreign); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("a foreign account origin authorized an account link: %v", err)
	}
	// An expired account identity authorizes nothing.
	expired := onlineauth.NewAccountPrincipal("user_a", "session-alice", authTestOrigin, time.Now().Add(-time.Minute))
	if _, err := fixture.authorizer.AuthorizeGuestLink(ctx, proof.Secret, authTestOrigin, expired); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("an expired account session authorized an account link: %v", err)
	}
	// A hand-built identity that does not match its own subject authorizes
	// nothing. Only a verified session produces a usable account principal.
	inconsistent := accountPrincipal("user_a", "session-alice")
	inconsistent.Participant = online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_b"}
	if _, err := fixture.authorizer.AuthorizeGuestLink(ctx, proof.Secret, authTestOrigin, inconsistent); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("an inconsistent account identity authorized an account link: %v", err)
	}
	// A verified account authorizes the link.
	link, err := fixture.authorizer.AuthorizeGuestLink(ctx, proof.Secret, authTestOrigin, accountPrincipal("user_a", "session-alice"))
	if err != nil {
		t.Fatalf("authorize guest link: %v", err)
	}
	if link.AccountID != "user_a" || link.GuestID != authGuestID || link.Seat != online.SeatWhite || link.MatchID != "match-proof-account" {
		t.Fatalf("link authorization = %+v", link)
	}
	// The authorization is read-only. The proof is not consumed here: KHA-72
	// consumes it inside its own linking transaction.
	if _, err := fixture.authorizer.VerifyOwnershipProof(ctx, proof.Secret, authTestOrigin); err != nil {
		t.Fatalf("the link authorization consumed the proof: %v", err)
	}
	// The seat owner is untouched.
	match, err := fixture.service.GetMatch(ctx, "match-proof-account")
	if err != nil {
		t.Fatal(err)
	}
	seat, ok := match.Seat(online.SeatWhite)
	if !ok || seat.Participant.ID != authGuestID || seat.Participant.Kind != online.ParticipantGuest {
		t.Fatalf("the link authorization changed the seat owner: %+v", seat.Participant)
	}
}

func TestPostgresGuestSeatKeepsOneLiveCredentialAndOneOwner(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	createGuestSeatMatch(t, fixture, "match-proof-live")
	ctx := context.Background()
	first := acceptGuestInvitation(t, fixture, "match-proof-live")
	if liveCredentialCount(t, fixture, "match-proof-live", online.SeatWhite) != 1 {
		t.Fatal("the accepted invitation did not leave exactly one live credential")
	}
	second := acceptGuestInvitation(t, fixture, "match-proof-live")
	if liveCredentialCount(t, fixture, "match-proof-live", online.SeatWhite) != 1 {
		t.Fatal("the rotation left more than one live credential on the seat")
	}
	if _, err := fixture.authorizer.AuthenticateGuest(ctx, first.Credential.Secret, authTestOrigin); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("the superseded credential still authenticates: %v", err)
	}
	// The seat owner is immutable. An invitation never moves a seat.
	if _, err := fixture.allocator.AcceptInvitation(ctx, onlineauth.AcceptInvitationRequest{
		MatchID: "match-proof-live",
		Seat:    online.SeatWhite,
		GuestID: "guest_beta",
		Origin:  authTestOrigin,
	}); err == nil {
		t.Fatal("an invitation reassigned the seat to another guest")
	}
	// An account seat never carries a guest credential.
	if _, err := fixture.allocator.AcceptInvitation(ctx, onlineauth.AcceptInvitationRequest{
		MatchID: "match-proof-live",
		Seat:    online.SeatBlack,
		GuestID: authGuestID,
		Origin:  authTestOrigin,
	}); err == nil {
		t.Fatal("a guest credential was minted for an account seat")
	}
	// A seat that does not exist carries no credential.
	if _, err := fixture.allocator.AcceptInvitation(ctx, onlineauth.AcceptInvitationRequest{
		MatchID: "match-proof-absent",
		Seat:    online.SeatWhite,
		GuestID: authGuestID,
		Origin:  authTestOrigin,
	}); err == nil {
		t.Fatal("a guest credential was minted for a seat that does not exist")
	}
	// The database refuses a second live credential for the same seat.
	digest := sha256.Sum256([]byte("match-proof-live-manual-credential"))
	if _, err := fixture.pool.Exec(ctx, `INSERT INTO online_guest_seat_credentials(credential_id,guest_id,match_id,seat,secret_hash,origin,issued_at,expires_at) VALUES('kgmanual-credential',$1,'match-proof-live','white',$2,$3,clock_timestamp(),clock_timestamp()+interval '1 hour')`,
		authGuestID, digest[:], authTestOrigin); !hasPgCode(err, "23505") {
		t.Fatalf("a second live credential for one seat = %v, want SQLSTATE 23505", err)
	}
	// A proof never names another seat than the credential it was minted from.
	proofDigest := sha256.Sum256([]byte("match-proof-live-manual-proof"))
	if _, err := fixture.pool.Exec(ctx, `INSERT INTO online_guest_ownership_proofs(proof_id,credential_id,guest_id,match_id,seat,proof_hash,issued_at,expires_at) VALUES('kgmanual-proof',$1,$2,'match-proof-live','black',$3,clock_timestamp(),clock_timestamp()+interval '1 hour')`,
		second.Credential.CredentialID, authGuestID, proofDigest[:]); !hasPgCode(err, "55000") {
		t.Fatalf("a proof for another seat = %v, want SQLSTATE 55000", err)
	}
}

func TestPostgresGuestProofIssuanceRacesTheSeatRevocation(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	ctx := context.Background()
	for attempt := 0; attempt < 3; attempt++ {
		matchID := fmt.Sprintf("match-proof-race-%d", attempt)
		createGuestSeatMatch(t, fixture, matchID)
		issued := acceptGuestInvitation(t, fixture, matchID)
		start := make(chan struct{})
		var (
			wait      sync.WaitGroup
			proof     onlineauth.IssuedOwnershipProof
			proofErr  error
			revokeErr error
		)
		wait.Add(2)
		go func() {
			defer wait.Done()
			<-start
			proof, proofErr = fixture.allocator.IssueOwnershipProof(ctx, issued.Credential.Secret, authTestOrigin)
		}()
		go func() {
			defer wait.Done()
			<-start
			revokeErr = fixture.authorizer.RevokeGuestSeat(ctx, matchID, online.SeatWhite, "seat_removed")
		}()
		close(start)
		wait.Wait()
		if revokeErr != nil {
			t.Fatalf("attempt %d: revoke guest seat: %v", attempt, revokeErr)
		}
		if proofErr != nil && !errors.Is(proofErr, onlineauth.ErrUnauthenticated) {
			t.Fatalf("attempt %d: issue ownership proof: %v", attempt, proofErr)
		}
		// Whether the proof was minted before or after the revocation, it
		// never survives it.
		if proofErr == nil {
			if _, err := fixture.authorizer.VerifyOwnershipProof(ctx, proof.Secret, authTestOrigin); !errors.Is(err, onlineauth.ErrUnauthenticated) {
				t.Fatalf("attempt %d: a proof survived a concurrent seat revocation: %v", attempt, err)
			}
		}
		if liveCredentialCount(t, fixture, matchID, online.SeatWhite) != 0 {
			t.Fatalf("attempt %d: the revoked seat still has a live credential", attempt)
		}
		var liveProofs int
		if err := fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_guest_ownership_proofs WHERE match_id=$1 AND seat=$2 AND revoked_at IS NULL`, matchID, string(online.SeatWhite)).Scan(&liveProofs); err != nil {
			t.Fatal(err)
		}
		if liveProofs != 0 {
			t.Fatalf("attempt %d: the revoked seat still has %d unrevoked proofs", attempt, liveProofs)
		}
	}
}
