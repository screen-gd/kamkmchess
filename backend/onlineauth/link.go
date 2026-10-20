package onlineauth

import (
	"context"
	"errors"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/jackc/pgx/v5"
)

// AuthorizeAccount re-checks a verified account principal inside the
// caller's transaction.
//
// The check runs against the caller's querier, so a caller that holds the
// account lock sees a session revocation that committed while it waited for
// the lock. The account expiry is checked again here, because a lock can be
// held for an unbounded time.
//
// Every failure returns the same error, so a caller cannot learn which part
// of the account identity failed.
func (s *Service) AuthorizeAccount(ctx context.Context, q online.Querier, account Principal, origin string) error {
	if q == nil {
		return ErrUnauthenticated
	}
	return s.authorizeAccountPrincipal(ctx, q, account, origin)
}

// LinkAuthority is the verified authority to bind one guest seat to one
// account.
//
// It is a statement, not an action. The link that consumes it lives in the
// profile service, and that service performs it inside the transaction that
// holds the account lock and the guest seat lock.
type LinkAuthority struct {
	// ProofID is the ownership proof that was verified.
	ProofID string
	// GuestID is the guest that owns the seat.
	GuestID string
	// MatchID is the match of the guest seat.
	MatchID string
	// Seat is the guest seat.
	Seat online.Seat
	// AccountID is the verified account the link would attach to.
	AccountID string
}

// VerifyLinkSeat re-verifies an ownership proof for an explicit account link.
//
// The proof is the only accepted proof of seat ownership. An invitation URL
// is not a proof: it is a shareable link that anybody can hold, and it never
// proves that the requester controlled the seat. A guest seat credential
// proves control of the seat, but it is not the deliberate act of linking
// either, so it is not accepted here.
//
// The account must be a verified account identity. A guest principal is an
// authenticated participant but never an account identity, so a guest can
// never link a seat to an account it merely knows the name of. The session
// must also still be unrevoked, and the request must come from the origin the
// session was issued for.
//
// The requested seat must be the seat the proof names. A proof for another
// seat, or for another person's seat, is refused, and the refusal is the same
// for every cause so a caller cannot learn which seats exist.
//
// Every check runs against the caller's transaction, so the caller can hold
// the account lock and the guest seat lock while the proof, the parent
// credential, the seat ownership, the session revocation, and every expiry
// are checked. The lock can be held for an unbounded time, so an expiry that
// was checked before the lock is checked again here.
func (s *Service) VerifyLinkSeat(
	ctx context.Context,
	q online.Querier,
	secret, origin string,
	account Principal,
	matchID string,
	seat online.Seat,
) (LinkAuthority, error) {
	if q == nil {
		return LinkAuthority{}, ErrUnauthenticated
	}
	if origin == "" {
		return LinkAuthority{}, ErrOriginRequired
	}
	if !matchIDShape(matchID) {
		return LinkAuthority{}, ErrUnauthenticated
	}
	if seat != online.SeatWhite && seat != online.SeatBlack {
		return LinkAuthority{}, ErrUnauthenticated
	}
	if err := s.authorizeAccountPrincipal(ctx, q, account, origin); err != nil {
		return LinkAuthority{}, err
	}
	proof, err := s.readLiveProof(ctx, q, secret, origin)
	if err != nil {
		return LinkAuthority{}, err
	}
	// The proof must name the seat the caller asked to link. A proof for a
	// different seat never links this one.
	if proof.MatchID != matchID || proof.Seat != seat {
		return LinkAuthority{}, ErrUnauthenticated
	}
	return LinkAuthority{
		ProofID:   proof.ProofID,
		GuestID:   proof.GuestID,
		MatchID:   proof.MatchID,
		Seat:      proof.Seat,
		AccountID: account.Subject,
	}, nil
}

// readLiveProof verifies an ownership proof against a querier.
//
// The proof is only valid while the seat credential it was minted from is
// still live. A revoked, superseded, or expired credential invalidates every
// proof it issued, so an old proof never links a seat after the guest
// credential was revoked or rotated. The proof must name the seat and the
// guest of its credential, the seat must still exist, and the guest must
// still own it.
//
// The read never consumes the proof. The explicit account link that consumes
// or binds it runs in its own transaction, so a proof stays usable until that
// transaction commits.
func (s *Service) readLiveProof(ctx context.Context, q online.Querier, secret, origin string) (OwnershipProof, error) {
	if !secretShape(secret, proofPrefix) {
		return OwnershipProof{}, ErrUnauthenticated
	}
	if origin == "" {
		return OwnershipProof{}, ErrOriginRequired
	}
	var (
		proofID                string
		guestID                string
		matchID                string
		seat                   string
		issuedAt               time.Time
		expiresAt              time.Time
		proofRevokedAt         *time.Time
		credentialGuestID      string
		credentialMatchID      string
		credentialSeat         string
		credentialOrigin       string
		credentialExpiresAt    time.Time
		credentialRevokedAt    *time.Time
		credentialSupersededAt *time.Time
		seatOwnerKind          string
		seatOwnerID            string
	)
	// The seat join makes a proof for a seat that no longer exists fail the
	// same way an unknown proof fails.
	err := q.QueryRow(ctx, `SELECT p.proof_id,p.guest_id,p.match_id,p.seat,p.issued_at,p.expires_at,p.revoked_at,c.guest_id,c.match_id,c.seat,c.origin,c.expires_at,c.revoked_at,c.superseded_at,s.owner_kind,s.owner_id FROM online_guest_ownership_proofs p JOIN online_guest_seat_credentials c ON c.credential_id=p.credential_id JOIN online_seats s ON s.match_id=p.match_id AND s.seat=p.seat WHERE p.proof_hash=$1`,
		hashSecret("ownership-proof", secret)).Scan(&proofID, &guestID, &matchID, &seat, &issuedAt, &expiresAt, &proofRevokedAt, &credentialGuestID, &credentialMatchID, &credentialSeat, &credentialOrigin, &credentialExpiresAt, &credentialRevokedAt, &credentialSupersededAt, &seatOwnerKind, &seatOwnerID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return OwnershipProof{}, ErrUnauthenticated
		}
		return OwnershipProof{}, err
	}
	if proofRevokedAt != nil || !s.now().Before(expiresAt.UTC()) {
		return OwnershipProof{}, ErrUnauthenticated
	}
	// The parent credential must still be live. A dead credential invalidates
	// every proof it issued.
	if credentialRevokedAt != nil || credentialSupersededAt != nil || !s.now().Before(credentialExpiresAt.UTC()) {
		return OwnershipProof{}, ErrUnauthenticated
	}
	// The proof must name the seat and the guest of its credential.
	if credentialGuestID != guestID || credentialMatchID != matchID || credentialSeat != seat {
		return OwnershipProof{}, ErrUnauthenticated
	}
	// The credential is origin scoped.
	if credentialOrigin != origin {
		return OwnershipProof{}, ErrUnauthenticated
	}
	// The seat must still belong to the guest the proof names.
	if seatOwnerKind != string(online.ParticipantGuest) || seatOwnerID != guestID {
		return OwnershipProof{}, ErrUnauthenticated
	}
	return OwnershipProof{ProofID: proofID, GuestID: guestID, MatchID: matchID, Seat: online.Seat(seat), IssuedAt: issuedAt.UTC(), ExpiresAt: expiresAt.UTC()}, nil
}
