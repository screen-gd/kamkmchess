package onlineauth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/jackc/pgx/v5"
)

// AcceptInvitationRequest describes the seat an accepted invitation binds.
//
// The guest ID, match ID, seat, and origin are supplied by the trusted
// allocator that accepted the invitation. The request carries no invitation
// token: possession of a shareable invitation link never authorizes a seat.
type AcceptInvitationRequest struct {
	// MatchID is the match the seat belongs to.
	MatchID string
	// Seat is the seat the guest takes.
	Seat online.Seat
	// GuestID is the opaque identity recorded for the guest participant.
	GuestID string
	// Origin is the browser origin the credential is scoped to.
	Origin string
	// TTL bounds the credential lifetime. Zero uses the configured default.
	TTL time.Duration
}

// IssuedSeatCredentials is the result of one accepted invitation.
type IssuedSeatCredentials struct {
	// Credential is the seat-control credential.
	Credential IssuedSeatCredential
	// OwnershipProof proves ownership of the seat for a later explicit
	// account link. It grants no seat control.
	OwnershipProof IssuedOwnershipProof
}

// Allocator issues guest seat credentials.
//
// It is the trusted service method for invitation acceptance. Only the server
// composition that owns an invitation allocator holds one. The public HTTP
// surface never receives an Allocator, so no request can make itself a seat
// holder, and no invitation token can be exchanged for seat control.
type Allocator struct {
	service *Service
}

// NewAllocator binds a trusted allocator to the authorization service.
func NewAllocator(service *Service) *Allocator {
	return &Allocator{service: service}
}

// AcceptInvitation issues a seat-scoped guest credential and an ownership
// proof for an accepted invitation.
//
// The caller is the trusted invitation allocator. The credential is bound to
// one match and one seat, is scoped to one origin, and can be revoked before
// it expires. The plaintext secrets exist only in the returned value.
//
// The issuance takes the same advisory lock the participant command path and
// the revocation path take, so a rotation is ordered against an accepted
// write and against a seat revocation.
//
// The seat must already exist and must still belong to the invited guest. The
// seat owner is immutable, so an invitation never moves a seat to another
// participant. A rotation supersedes every earlier credential of that seat,
// so a seat never carries two usable secrets at once.
//
// The credential is minted in its own transaction, so the seat row is read
// from committed state. An allocator that creates the match and the seat has
// to commit them before it accepts the invitation.
func (a *Allocator) AcceptInvitation(ctx context.Context, request AcceptInvitationRequest) (IssuedSeatCredentials, error) {
	if a == nil || a.service == nil {
		return IssuedSeatCredentials{}, errors.New("onlineauth: no allocator is configured")
	}
	if !matchIDShape(request.MatchID) {
		return IssuedSeatCredentials{}, errors.New("onlineauth: invalid match id")
	}
	if request.Seat != online.SeatWhite && request.Seat != online.SeatBlack {
		return IssuedSeatCredentials{}, errors.New("onlineauth: invalid seat")
	}
	if !participantIDShape(request.GuestID) {
		return IssuedSeatCredentials{}, errors.New("onlineauth: invalid guest id")
	}
	if !originShape(request.Origin) {
		return IssuedSeatCredentials{}, errors.New("onlineauth: invalid origin")
	}
	ttl := request.TTL
	if ttl <= 0 {
		ttl = a.service.options.GuestCredentialTTL
	}
	secret, err := newSecret(credentialPrefix)
	if err != nil {
		return IssuedSeatCredentials{}, err
	}
	proofSecret, err := newSecret(proofPrefix)
	if err != nil {
		return IssuedSeatCredentials{}, err
	}
	credentialID, err := newIdentifier("kg")
	if err != nil {
		return IssuedSeatCredentials{}, err
	}
	proofID, err := newIdentifier("kgp_")
	if err != nil {
		return IssuedSeatCredentials{}, err
	}
	issuedAt := a.service.now()
	expiresAt := issuedAt.Add(ttl)
	proofExpiresAt := issuedAt.Add(a.service.options.OwnershipProofTTL)

	credential := IssuedSeatCredential{
		CredentialID: credentialID,
		GuestID:      request.GuestID,
		MatchID:      request.MatchID,
		Seat:         request.Seat,
		Origin:       request.Origin,
		Secret:       secret,
		IssuedAt:     issuedAt,
		ExpiresAt:    expiresAt,
	}
	proof := IssuedOwnershipProof{
		ProofID:   proofID,
		GuestID:   request.GuestID,
		MatchID:   request.MatchID,
		Seat:      request.Seat,
		Secret:    proofSecret,
		IssuedAt:  issuedAt,
		ExpiresAt: proofExpiresAt,
	}
	tx, err := a.service.db.Begin(ctx)
	if err != nil {
		return IssuedSeatCredentials{}, err
	}
	defer tx.Rollback(ctx)
	if err = lockScope(ctx, tx, seatLockKey(request.MatchID, request.Seat)); err != nil {
		return IssuedSeatCredentials{}, err
	}
	// The seat must exist and must still belong to the invited guest. The
	// owner is immutable, so an invitation never reassigns a seat.
	owned, err := seatOwnedByGuest(ctx, tx, request.MatchID, request.Seat, request.GuestID)
	if err != nil {
		return IssuedSeatCredentials{}, err
	}
	if !owned {
		return IssuedSeatCredentials{}, errors.New("onlineauth: the seat does not belong to the invited guest")
	}
	// A seat has at most one live credential. A rotation supersedes every
	// earlier credential of the seat, so two usable secrets never coexist.
	if _, err = tx.Exec(ctx, `UPDATE online_guest_seat_credentials SET superseded_at=clock_timestamp() WHERE match_id=$1 AND seat=$2 AND revoked_at IS NULL AND superseded_at IS NULL`,
		request.MatchID, string(request.Seat)); err != nil {
		return IssuedSeatCredentials{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO online_guest_seat_credentials(credential_id,guest_id,match_id,seat,secret_hash,origin,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
		credential.CredentialID, credential.GuestID, credential.MatchID, string(credential.Seat), hashSecret("seat-control", credential.Secret), credential.Origin, credential.IssuedAt, credential.ExpiresAt); err != nil {
		return IssuedSeatCredentials{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO online_guest_ownership_proofs(proof_id,credential_id,guest_id,match_id,seat,proof_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
		proof.ProofID, credential.CredentialID, proof.GuestID, proof.MatchID, string(proof.Seat), hashSecret("ownership-proof", proof.Secret), proof.IssuedAt, proof.ExpiresAt); err != nil {
		return IssuedSeatCredentials{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return IssuedSeatCredentials{}, err
	}
	return IssuedSeatCredentials{Credential: credential, OwnershipProof: proof}, nil
}

// IssueOwnershipProof mints a fresh ownership proof for a guest seat.
//
// It requires the guest's seat credential, so possession of an invitation
// link can never produce a proof. The proof is an append-only record: it
// never mutates the guest actor, the seat row, or an accepted fingerprint.
//
// The proof grants no seat control. It only states that its holder controls a
// guest seat, so an explicit account link can be authorized later.
//
// The mint runs inside one transaction that holds the seat advisory lock the
// revocation path holds, and it re-checks the credential and the seat
// membership after the lock is held. A revocation that commits first is
// therefore visible to the mint, and a mint that commits first is revoked by
// the revocation that follows it. A proof can never survive a concurrent seat
// revocation.
//
// The transaction performs no network call. The seat lock is never held
// across a request to another service.
func (a *Allocator) IssueOwnershipProof(ctx context.Context, seatSecret, origin string) (IssuedOwnershipProof, error) {
	if a == nil || a.service == nil {
		return IssuedOwnershipProof{}, errors.New("onlineauth: no allocator is configured")
	}
	if !secretShape(seatSecret, credentialPrefix) {
		return IssuedOwnershipProof{}, ErrUnauthenticated
	}
	if origin == "" {
		return IssuedOwnershipProof{}, ErrOriginRequired
	}
	secret, err := newSecret(proofPrefix)
	if err != nil {
		return IssuedOwnershipProof{}, err
	}
	proofID, err := newIdentifier("kgp_")
	if err != nil {
		return IssuedOwnershipProof{}, err
	}
	issuedAt := a.service.now()

	tx, err := a.service.db.Begin(ctx)
	if err != nil {
		return IssuedOwnershipProof{}, err
	}
	defer tx.Rollback(ctx)

	// The credential is read first to learn which seat lock orders this mint
	// against a revocation. The read binds nothing and holds no lock.
	credential, err := readSeatCredentialByHash(ctx, tx, hashSecret("seat-control", seatSecret))
	if err != nil {
		return IssuedOwnershipProof{}, err
	}
	if credential.origin != origin {
		return IssuedOwnershipProof{}, ErrUnauthenticated
	}
	if err = lockScope(ctx, tx, seatLockKey(credential.matchID, credential.seat)); err != nil {
		return IssuedOwnershipProof{}, err
	}
	// The credential is re-read under the lock. A revocation that committed
	// while this call waited for the lock is visible here.
	credential, err = readSeatCredentialByID(ctx, tx, credential.credentialID)
	if err != nil {
		return IssuedOwnershipProof{}, err
	}
	if credential.origin != origin || !a.service.credentialLive(credential) {
		return IssuedOwnershipProof{}, ErrUnauthenticated
	}
	// The guest must still own the seat it proves.
	owned, err := seatOwnedByGuest(ctx, tx, credential.matchID, credential.seat, credential.guestID)
	if err != nil {
		return IssuedOwnershipProof{}, err
	}
	if !owned {
		return IssuedOwnershipProof{}, online.ErrNotAuthorized
	}
	proof := IssuedOwnershipProof{
		ProofID:   proofID,
		GuestID:   credential.guestID,
		MatchID:   credential.matchID,
		Seat:      credential.seat,
		Secret:    secret,
		IssuedAt:  issuedAt,
		ExpiresAt: issuedAt.Add(a.service.options.OwnershipProofTTL),
	}
	if _, err = tx.Exec(ctx, `INSERT INTO online_guest_ownership_proofs(proof_id,credential_id,guest_id,match_id,seat,proof_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
		proof.ProofID, credential.credentialID, proof.GuestID, proof.MatchID, string(proof.Seat), hashSecret("ownership-proof", proof.Secret), proof.IssuedAt, proof.ExpiresAt); err != nil {
		return IssuedOwnershipProof{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return IssuedOwnershipProof{}, err
	}
	return proof, nil
}

// VerifyOwnershipProof verifies an ownership proof and returns it.
//
// A verified proof authorizes an explicit account-link operation. It grants no
// seat control and it performs no merge by itself.
//
// The proof is only valid while the seat credential it was minted from is
// still live. A revoked, superseded, or expired credential invalidates every
// proof it issued, so an old proof never links a seat after the guest
// credential was revoked or rotated. The proof must name the seat and the
// guest of its credential, the seat must still exist, and the guest must
// still own it.
//
// The check is read-only. It never consumes the proof. KHA-72 owns the
// explicit account link and must consume or bind the proof inside its own
// linking transaction, so a proof stays usable until that transaction
// commits.
func (s *Service) VerifyOwnershipProof(ctx context.Context, secret, origin string) (OwnershipProof, error) {
	return s.readLiveProof(ctx, s.db, secret, origin)
}

// AuthorizeGuestLink verifies an ownership proof for an explicit account link.
//
// The account must be a verified account identity. The principal is the one a
// verified Clerk session produced, and the method re-checks that the session
// is still current, still unrevoked, and bound to the same origin as the
// request. A guest principal is never an account identity, so a guest can
// never link a seat to an account it merely knows the name of.
//
// The result is the typed port an account-link flow composes. Nothing here
// changes the seat owner, the guest actor, or any accepted fingerprint, and no
// guest is merged into an account silently.
//
// The check is read-only. It never consumes the proof. KHA-72 owns the
// explicit account link and must consume or bind the proof inside its own
// linking transaction, and it must keep the original guest actor in the
// accepted fingerprints.
func (s *Service) AuthorizeGuestLink(ctx context.Context, proofSecret, origin string, account Principal) (GuestLinkAuthorization, error) {
	if origin == "" {
		return GuestLinkAuthorization{}, ErrOriginRequired
	}
	if err := s.authorizeAccountPrincipal(ctx, s.db, account, origin); err != nil {
		return GuestLinkAuthorization{}, err
	}
	proof, err := s.VerifyOwnershipProof(ctx, proofSecret, origin)
	if err != nil {
		return GuestLinkAuthorization{}, err
	}
	return GuestLinkAuthorization{
		ProofID:   proof.ProofID,
		GuestID:   proof.GuestID,
		MatchID:   proof.MatchID,
		Seat:      proof.Seat,
		AccountID: account.Subject,
		IssuedAt:  proof.IssuedAt,
		ExpiresAt: proof.ExpiresAt,
	}, nil
}

// authorizeAccountPrincipal checks that the presented principal is a verified
// account identity that is still usable for this origin.
//
// The principal alone is not enough: a guest principal is an authenticated
// participant but never an account identity, and an account session that was
// revoked must not authorize a link even when its token would still verify.
// Every failure returns the same error so a caller cannot learn which part of
// the account identity failed.
//
// The revocation read runs against the caller's querier, so a caller that
// holds the account lock checks the revocation inside the same transaction
// that performs the action. A revocation that commits while the caller waits
// for the lock is therefore visible to this check.
func (s *Service) authorizeAccountPrincipal(ctx context.Context, q online.Querier, account Principal, origin string) error {
	if account.Kind != online.ParticipantAccount {
		return ErrUnauthenticated
	}
	if account.Subject == "" || account.SessionID == "" {
		return ErrUnauthenticated
	}
	// The principal must be the identity of the account it claims: the
	// participant reference and the subject are one value.
	if account.Participant.Kind != online.ParticipantAccount || account.Participant.ID != account.Subject {
		return ErrUnauthenticated
	}
	if account.Origin != origin {
		return ErrUnauthenticated
	}
	if !s.now().Before(account.ExpiresAt.UTC()) {
		return ErrUnauthenticated
	}
	revoked, err := s.sessionRevoked(ctx, q, account.Subject, account.SessionID)
	if err != nil {
		return err
	}
	if revoked {
		return ErrUnauthenticated
	}
	return nil
}

// GuestLinkAuthorization is the verified authority to link one guest seat to
// one account. It is a statement, not an action: applying it belongs to the
// explicit account-link flow.
type GuestLinkAuthorization struct {
	ProofID   string
	GuestID   string
	MatchID   string
	Seat      online.Seat
	AccountID string
	IssuedAt  time.Time
	ExpiresAt time.Time
}

// seatCredential is the stored state of one guest seat credential.
type seatCredential struct {
	credentialID string
	guestID      string
	matchID      string
	seat         online.Seat
	origin       string
	expiresAt    time.Time
	revokedAt    *time.Time
	supersededAt *time.Time
}

// credentialLive reports whether a stored credential can still be used.
func (s *Service) credentialLive(credential seatCredential) bool {
	return credential.revokedAt == nil &&
		credential.supersededAt == nil &&
		s.now().Before(credential.expiresAt.UTC())
}

// readSeatCredentialByHash loads the credential a presented secret proves.
func readSeatCredentialByHash(ctx context.Context, q online.Querier, hash []byte) (seatCredential, error) {
	var credential seatCredential
	var seat string
	err := q.QueryRow(ctx, `SELECT credential_id,guest_id,match_id,seat,origin,expires_at,revoked_at,superseded_at FROM online_guest_seat_credentials WHERE secret_hash=$1`, hash).
		Scan(&credential.credentialID, &credential.guestID, &credential.matchID, &seat, &credential.origin, &credential.expiresAt, &credential.revokedAt, &credential.supersededAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return seatCredential{}, ErrUnauthenticated
		}
		return seatCredential{}, err
	}
	credential.seat = online.Seat(seat)
	return credential, nil
}

// readSeatCredentialByID loads one stored credential by its identifier.
func readSeatCredentialByID(ctx context.Context, q online.Querier, credentialID string) (seatCredential, error) {
	var credential seatCredential
	var seat string
	err := q.QueryRow(ctx, `SELECT credential_id,guest_id,match_id,seat,origin,expires_at,revoked_at,superseded_at FROM online_guest_seat_credentials WHERE credential_id=$1`, credentialID).
		Scan(&credential.credentialID, &credential.guestID, &credential.matchID, &seat, &credential.origin, &credential.expiresAt, &credential.revokedAt, &credential.supersededAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return seatCredential{}, ErrUnauthenticated
		}
		return seatCredential{}, err
	}
	credential.seat = online.Seat(seat)
	return credential, nil
}

// seatOwnedByGuest reports whether the seat exists and still belongs to the
// guest. A seat that does not exist is never owned by anybody.
func seatOwnedByGuest(ctx context.Context, q online.Querier, matchID string, seat online.Seat, guestID string) (bool, error) {
	var (
		ownerKind string
		ownerID   string
	)
	err := q.QueryRow(ctx, `SELECT owner_kind,owner_id FROM online_seats WHERE match_id=$1 AND seat=$2`, matchID, string(seat)).Scan(&ownerKind, &ownerID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return ownerKind == string(online.ParticipantGuest) && ownerID == guestID, nil
}

// newIdentifier returns a random, non-secret identifier for a stored row.
//
// The prefix separates the identifier kinds, so a proof identifier can never
// be mistaken for a seat credential identifier.
func newIdentifier(prefix string) (string, error) {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return "", errors.New("onlineauth: secure random source unavailable")
	}
	return prefix + base64.RawURLEncoding.EncodeToString(raw), nil
}

func matchIDShape(value string) bool {
	if len(value) < 8 || len(value) > 64 {
		return false
	}
	for index, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '_' || r == '-':
			if index == 0 {
				return false
			}
		default:
			return false
		}
	}
	return true
}

func participantIDShape(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 {
		return false
	}
	return !strings.ContainsAny(value, "\x00\r\n")
}

func originShape(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 255 {
		return false
	}
	return !strings.ContainsAny(value, "\x00\r\n")
}
