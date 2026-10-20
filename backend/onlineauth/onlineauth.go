// Package onlineauth authorizes the participants of shared online matches.
//
// It extends the existing Clerk session verification with the checks a shared
// match needs and the private single-owner sync API does not have: durable
// session revocation, match membership, seat binding, origin scope, and
// revocable guest seat credentials.
//
// Two credential kinds exist.
//
// An account participant presents a Clerk session token. The token proves
// identity, origin, and expiry. The durable revocation table proves that the
// session has not been revoked; a revoked session is rejected before its token
// would expire.
//
// A guest participant presents an opaque seat credential. The plaintext secret
// exists only in the response that issued it. The database stores its SHA-256
// hash, its match and seat binding, its origin scope, and its expiry.
//
// The package never writes match state. backend/online remains the only
// transaction writer, and it re-checks the credential inside the acceptance
// transaction through SeatAuthorizer.
package onlineauth

import (
	"context"
	"errors"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

var (
	// ErrUnauthenticated reports a missing, malformed, expired, revoked, or
	// wrong-origin credential. Every cause returns the same error so a caller
	// cannot learn whether a credential exists.
	ErrUnauthenticated = errors.New("onlineauth: unauthenticated")
	// ErrOriginRequired reports a request without an Origin header. The
	// online surface requires an explicit origin; the private sync API keeps
	// its own behavior.
	ErrOriginRequired = errors.New("onlineauth: origin required")
)

// Principal is the authenticated identity of one participant.
//
// The participant reference is an authorization identity. It never appears in
// a public projection, a log line, or an HTTP response body.
type Principal struct {
	// Kind is account or guest.
	Kind online.ParticipantKind
	// Subject is the Clerk user ID for an account, or the opaque guest ID.
	Subject string
	// Participant is the identity the online writer authorizes.
	Participant online.ParticipantRef
	// SessionID is the Clerk session ID. It scopes durable revocation.
	SessionID string
	// CredentialID is the guest seat credential ID. It scopes durable
	// revocation and seat binding for a guest.
	CredentialID string
	// MatchID is the match a guest credential is bound to.
	MatchID string
	// Seat is the seat a guest credential is bound to.
	Seat online.Seat
	// Origin is the request origin the credential was presented from.
	Origin string
	// ExpiresAt is the credential expiry. It is never later than the Clerk
	// session expiry for an account participant.
	ExpiresAt time.Time
}

// IsGuest reports whether the principal is a guest participant.
func (p Principal) IsGuest() bool { return p.Kind == online.ParticipantGuest }

type principalKey struct{}

// WithPrincipal attaches the authenticated participant to a request context.
// The online writer reads it back when it re-checks authorization inside the
// acceptance transaction.
func WithPrincipal(ctx context.Context, principal Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, principal)
}

// PrincipalFromContext returns the attached participant, if any.
func PrincipalFromContext(ctx context.Context) (Principal, bool) {
	principal, ok := ctx.Value(principalKey{}).(Principal)
	return principal, ok && principal.Participant.ID != ""
}

// NewAccountPrincipal builds a principal from verified Clerk claims. The
// claims must already have passed the Clerk verifier.
func NewAccountPrincipal(subject, sessionID, origin string, expiresAt time.Time) Principal {
	return Principal{
		Kind:        online.ParticipantAccount,
		Subject:     subject,
		Participant: online.ParticipantRef{Kind: online.ParticipantAccount, ID: subject},
		SessionID:   sessionID,
		Origin:      origin,
		ExpiresAt:   expiresAt.UTC(),
	}
}

// NewGuestPrincipal builds a principal from an issued guest credential.
func NewGuestPrincipal(issued IssuedSeatCredential) Principal {
	return Principal{
		Kind:         online.ParticipantGuest,
		Subject:      issued.GuestID,
		Participant:  online.ParticipantRef{Kind: online.ParticipantGuest, ID: issued.GuestID},
		CredentialID: issued.CredentialID,
		MatchID:      issued.MatchID,
		Seat:         issued.Seat,
		Origin:       issued.Origin,
		ExpiresAt:    issued.ExpiresAt.UTC(),
	}
}
