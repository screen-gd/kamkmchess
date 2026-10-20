package onlineauth

import (
	"context"
	"errors"
	"hash/fnv"
	"strings"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/auth"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DefaultGuestCredentialTTL is the lifetime of an issued guest seat
// credential. A guest credential outlives a browser session so a guest can
// reconnect, and it can be revoked before it expires.
const DefaultGuestCredentialTTL = 12 * time.Hour

// DefaultOwnershipProofTTL is the lifetime of an issued ownership proof. A
// proof is a short-lived, single-purpose ownership statement.
const DefaultOwnershipProofTTL = 15 * time.Minute

// DefaultStreamMaxDuration is the longest window one live subscription may
// stay open before it must be renewed with a fresh authorization check.
const DefaultStreamMaxDuration = 20 * time.Second

// Lock namespaces. The same key is taken by the participant command path and
// by the revocation path, so a revocation and an accepted write are ordered
// instead of racing.
const (
	lockAccount = "account"
	lockSeat    = "guest-seat"
)

// Options configures the authorization service.
type Options struct {
	// GuestCredentialTTL bounds the lifetime of an issued guest credential.
	GuestCredentialTTL time.Duration
	// OwnershipProofTTL bounds the lifetime of an issued ownership proof.
	OwnershipProofTTL time.Duration
	// StreamMaxDuration bounds one live subscription window.
	StreamMaxDuration time.Duration
	// Now overrides the clock for tests.
	Now func() time.Time
}

// Service verifies participant credentials and re-checks them.
type Service struct {
	db       *pgxpool.Pool
	verifier *auth.Verifier
	options  Options
}

// Open binds the authorization service to a pool. It does not mutate schema.
func Open(_ context.Context, db *pgxpool.Pool, verifier *auth.Verifier, options Options) (*Service, error) {
	if db == nil {
		return nil, errors.New("onlineauth: nil database pool")
	}
	if options.GuestCredentialTTL <= 0 {
		options.GuestCredentialTTL = DefaultGuestCredentialTTL
	}
	if options.OwnershipProofTTL <= 0 {
		options.OwnershipProofTTL = DefaultOwnershipProofTTL
	}
	if options.StreamMaxDuration <= 0 {
		options.StreamMaxDuration = DefaultStreamMaxDuration
	}
	// The window is hard capped. A longer configured window would let one
	// subscription outlive the credential checks it depends on.
	if options.StreamMaxDuration > DefaultStreamMaxDuration {
		options.StreamMaxDuration = DefaultStreamMaxDuration
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &Service{db: db, verifier: verifier, options: options}, nil
}

func (s *Service) now() time.Time { return s.options.Now().UTC() }

// AuthenticateAccount verifies a Clerk session token and returns the account
// participant it proves.
//
// The token proves identity, origin, and expiry. The durable revocation table
// proves that the session has not been revoked, so a revoked session is
// rejected before its token would expire.
func (s *Service) AuthenticateAccount(ctx context.Context, token, origin string) (Principal, error) {
	if strings.TrimSpace(token) == "" {
		return Principal{}, ErrUnauthenticated
	}
	if origin == "" {
		return Principal{}, ErrOriginRequired
	}
	if s.verifier == nil {
		return Principal{}, ErrUnauthenticated
	}
	claims, err := s.verifier.Verify(ctx, token, origin)
	if err != nil {
		return Principal{}, ErrUnauthenticated
	}
	revoked, err := s.sessionRevoked(ctx, s.db, claims.Subject, claims.SessionID)
	if err != nil {
		return Principal{}, err
	}
	if revoked {
		return Principal{}, ErrUnauthenticated
	}
	return NewAccountPrincipal(claims.Subject, claims.SessionID, origin, claims.ExpiresAt), nil
}

// AuthenticateGuest verifies an opaque guest seat credential.
//
// The credential is bound to one match and one seat, is scoped to the origin
// it was issued for, and stops working when it is revoked, superseded, or
// expired.
func (s *Service) AuthenticateGuest(ctx context.Context, secret, origin string) (Principal, error) {
	if !secretShape(secret, credentialPrefix) {
		return Principal{}, ErrUnauthenticated
	}
	if origin == "" {
		return Principal{}, ErrOriginRequired
	}
	row := s.db.QueryRow(ctx, `SELECT credential_id,guest_id,match_id,seat,origin,expires_at,revoked_at,superseded_at FROM online_guest_seat_credentials WHERE secret_hash=$1`, hashSecret("seat-control", secret))
	var (
		credentialID string
		guestID      string
		matchID      string
		seat         string
		boundOrigin  string
		expiresAt    time.Time
		revokedAt    *time.Time
		supersededAt *time.Time
	)
	if err := row.Scan(&credentialID, &guestID, &matchID, &seat, &boundOrigin, &expiresAt, &revokedAt, &supersededAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Principal{}, ErrUnauthenticated
		}
		return Principal{}, err
	}
	if revokedAt != nil || supersededAt != nil || !s.now().Before(expiresAt.UTC()) {
		return Principal{}, ErrUnauthenticated
	}
	// The credential is origin scoped. A request from another origin is not
	// authenticated by it.
	if boundOrigin != origin {
		return Principal{}, ErrUnauthenticated
	}
	return Principal{
		Kind:         online.ParticipantGuest,
		Subject:      guestID,
		Participant:  online.ParticipantRef{Kind: online.ParticipantGuest, ID: guestID},
		CredentialID: credentialID,
		MatchID:      matchID,
		Seat:         online.Seat(seat),
		Origin:       origin,
		ExpiresAt:    expiresAt.UTC(),
	}, nil
}

// AuthorizeSeat re-checks a presented participant inside the caller's
// transaction.
//
// It implements online.SeatAuthorizer. The check takes the same transaction
// advisory lock the revocation path takes, so a revocation and an accepted
// write are ordered: either the revocation is visible before the write, or
// the revocation waits for the write to commit.
//
// The lock is only taken when the querier is a real transaction. A
// pool-level check is a pre-check and cannot serialize with a revocation.
//
// The credential expiry is checked again after the lock is held. A lock can
// be held for an unbounded time by a concurrent revocation, and a credential
// that expires while the command waits is no longer usable. Both expiry
// checks read the same clock source, so the earlier one can only ever be the
// more permissive of the two.
//
// An empty seat checks the credential only. A named seat also requires the
// actor to still hold that seat in the match.
func (s *Service) AuthorizeSeat(ctx context.Context, q online.Querier, matchID string, actor online.ParticipantRef, seat online.Seat) error {
	if q == nil {
		return ErrUnauthenticated
	}
	principal, ok := PrincipalFromContext(ctx)
	if !ok {
		return ErrUnauthenticated
	}
	if principal.Participant != actor {
		return online.ErrNotAuthorized
	}
	// Cheap pre-check. It fails fast on an already expired credential.
	if !s.now().Before(principal.ExpiresAt) {
		return ErrUnauthenticated
	}
	switch principal.Kind {
	case online.ParticipantAccount:
		if principal.SessionID == "" {
			return ErrUnauthenticated
		}
		// Serialize against a concurrent session revocation.
		if err := lockScope(ctx, q, accountLockKey(principal.Subject)); err != nil {
			return err
		}
		// The lock may have been held for a long time. The expiry is
		// re-checked before the session is accepted.
		if !s.now().Before(principal.ExpiresAt) {
			return ErrUnauthenticated
		}
		revoked, err := s.sessionRevoked(ctx, q, principal.Subject, principal.SessionID)
		if err != nil {
			return err
		}
		if revoked {
			return ErrUnauthenticated
		}
	case online.ParticipantGuest:
		if principal.CredentialID == "" || principal.MatchID == "" || principal.Seat == "" {
			return ErrUnauthenticated
		}
		// Serialize against a concurrent seat revocation or credential
		// rotation. The lock is keyed by the credential's own binding, so a
		// command for another seat can never slip past it.
		if err := lockScope(ctx, q, seatLockKey(principal.MatchID, principal.Seat)); err != nil {
			return err
		}
		// The lock may have been held for a long time. The expiry is
		// re-checked before the stored credential is accepted.
		if !s.now().Before(principal.ExpiresAt) {
			return ErrUnauthenticated
		}
		var (
			credentialMatch string
			credentialSeat  string
			expiresAt       time.Time
			revokedAt       *time.Time
			supersededAt    *time.Time
		)
		err := q.QueryRow(ctx, `SELECT match_id,seat,expires_at,revoked_at,superseded_at FROM online_guest_seat_credentials WHERE credential_id=$1`, principal.CredentialID).
			Scan(&credentialMatch, &credentialSeat, &expiresAt, &revokedAt, &supersededAt)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrUnauthenticated
			}
			return err
		}
		if revokedAt != nil || supersededAt != nil || !s.now().Before(expiresAt.UTC()) {
			return ErrUnauthenticated
		}
		if matchID != "" && credentialMatch != matchID {
			return online.ErrNotAuthorized
		}
		if seat != "" && credentialSeat != string(seat) {
			return online.ErrNotAuthorized
		}
	default:
		return ErrUnauthenticated
	}
	if seat == "" {
		return nil
	}
	var (
		ownerKind string
		ownerID   string
	)
	err := q.QueryRow(ctx, `SELECT owner_kind,owner_id FROM online_seats WHERE match_id=$1 AND seat=$2`, matchID, string(seat)).Scan(&ownerKind, &ownerID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return online.ErrNotAuthorized
		}
		return err
	}
	if ownerKind != string(actor.Kind) || ownerID != actor.ID {
		return online.ErrNotAuthorized
	}
	return nil
}

// RevokeAccountSession revokes one Clerk session. A revoked session is
// rejected before its token would expire.
//
// The revocation takes the same advisory lock the participant command path
// takes, so it is ordered against accepted writes.
//
// An empty reason is recorded as "owner_request".
func (s *Service) RevokeAccountSession(ctx context.Context, subject, sessionID, reason string) error {
	if strings.TrimSpace(subject) == "" || strings.TrimSpace(sessionID) == "" {
		return errors.New("onlineauth: subject and session are required")
	}
	reason, err := normalizeReason(reason)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = lockScope(ctx, tx, accountLockKey(subject)); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO online_session_revocations(subject_id,session_id,revoked_at,reason) VALUES($1,$2,clock_timestamp(),$3) ON CONFLICT (subject_id,session_id) DO NOTHING`, subject, sessionID, reason); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RevokeAccountSessions revokes every session of one subject, including
// sessions that are created later.
//
// An empty reason is recorded as "owner_request".
func (s *Service) RevokeAccountSessions(ctx context.Context, subject, reason string) error {
	if strings.TrimSpace(subject) == "" {
		return errors.New("onlineauth: subject is required")
	}
	reason, err := normalizeReason(reason)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = lockScope(ctx, tx, accountLockKey(subject)); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO online_session_revocations(subject_id,session_id,revoked_at,reason) VALUES($1,'*',clock_timestamp(),$2) ON CONFLICT (subject_id,session_id) DO NOTHING`, subject, reason); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RevokeSeatCredential revokes one guest seat credential. A revoked
// credential stops working immediately, including for a reconnect.
//
// An empty reason is recorded as "owner_request".
func (s *Service) RevokeSeatCredential(ctx context.Context, credentialID, reason string) error {
	if strings.TrimSpace(credentialID) == "" {
		return errors.New("onlineauth: credential is required")
	}
	reason, err := normalizeReason(reason)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var (
		matchID string
		seat    string
	)
	err = tx.QueryRow(ctx, `SELECT match_id,seat FROM online_guest_seat_credentials WHERE credential_id=$1`, credentialID).Scan(&matchID, &seat)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errors.New("onlineauth: unknown credential")
		}
		return err
	}
	if err = lockScope(ctx, tx, seatLockKey(matchID, online.Seat(seat))); err != nil {
		return err
	}
	command, err := tx.Exec(ctx, `UPDATE online_guest_seat_credentials SET revoked_at=clock_timestamp(),revoked_reason=$1 WHERE credential_id=$2 AND revoked_at IS NULL`, reason, credentialID)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return errors.New("onlineauth: unknown or already revoked credential")
	}
	return tx.Commit(ctx)
}

// RevokeGuestSeat revokes every credential and ownership proof of one seat.
// This is the authority a verified removal request uses.
//
// It revokes only credentials. It does not anonymize the participant, remove
// a replay, or change the seat owner: that lifecycle belongs to the removal
// flow, not to this authorization slice.
//
// An empty reason is recorded as "owner_request".
func (s *Service) RevokeGuestSeat(ctx context.Context, matchID string, seat online.Seat, reason string) error {
	if strings.TrimSpace(matchID) == "" || seat == "" {
		return errors.New("onlineauth: match and seat are required")
	}
	reason, err := normalizeReason(reason)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = lockScope(ctx, tx, seatLockKey(matchID, seat)); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE online_guest_seat_credentials SET revoked_at=clock_timestamp(),revoked_reason=$1 WHERE match_id=$2 AND seat=$3 AND revoked_at IS NULL`, reason, matchID, string(seat)); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE online_guest_ownership_proofs SET revoked_at=clock_timestamp(),revoked_reason=$1 WHERE match_id=$2 AND seat=$3 AND revoked_at IS NULL`, reason, matchID, string(seat)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// sessionRevoked reports whether a session was durably revoked. The wildcard
// session revokes every session of the subject, including later ones.
func (s *Service) sessionRevoked(ctx context.Context, q online.Querier, subject, sessionID string) (bool, error) {
	if subject == "" || sessionID == "" {
		return false, nil
	}
	var revoked bool
	err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM online_session_revocations WHERE subject_id=$1 AND session_id IN ($2,'*'))`, subject, sessionID).Scan(&revoked)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return revoked, nil
}

// normalizeReason validates a revocation reason and returns the value that is
// stored.
//
// An empty reason is normalized to "owner_request". The stored column only
// accepts the allowed reasons, so an empty string would fail the database
// constraint instead of recording the request that was actually made. Every
// caller stores the returned value, so the recorded reason is always one the
// database accepts and always one the caller was told about.
func normalizeReason(reason string) (string, error) {
	if reason == "" {
		reason = "owner_request"
	}
	if !allowedRevocationReason(reason) {
		return "", errors.New("onlineauth: unsupported revocation reason")
	}
	return reason, nil
}

func allowedRevocationReason(reason string) bool {
	switch reason {
	case "owner_request", "erasure_request", "account_deletion", "session_ended", "seat_removed", "admin":
		return true
	default:
		return false
	}
}

// accountLockKey is the advisory lock key for one account subject.
func accountLockKey(subject string) int64 {
	return advisoryKey(lockAccount, subject)
}

// seatLockKey is the advisory lock key for one guest seat.
func seatLockKey(matchID string, seat online.Seat) int64 {
	return advisoryKey(lockSeat, matchID, string(seat))
}

// advisoryKey derives a stable 64-bit advisory lock key.
func advisoryKey(parts ...string) int64 {
	hash := fnv.New64a()
	for _, part := range parts {
		_, _ = hash.Write([]byte(part))
		_, _ = hash.Write([]byte{0})
	}
	return int64(hash.Sum64() & 0x7fffffffffffffff)
}

// lockScope takes a transaction advisory lock. It is a no-op outside a real
// transaction because a pooled statement cannot hold a lock that orders it
// against a concurrent revocation.
//
// The lock is the shared protocol between the participant command path and the
// revocation path. Both take the same key, so a revocation and an accepted
// write are ordered instead of racing.
func lockScope(ctx context.Context, q online.Querier, key int64) error {
	tx, ok := q.(pgx.Tx)
	if !ok {
		return nil
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, key); err != nil {
		return err
	}
	return nil
}
