package onlineauth

import (
	"context"
	"errors"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// StreamGrant authorizes one live subscription window.
//
// The window never outlives the presented credential and never outlives the
// configured maximum stream duration. A renewal re-verifies the presented
// credential, so a revoked credential ends the subscription instead of
// extending it.
type StreamGrant struct {
	// MatchID is the subscribed match.
	MatchID string
	// Seat is the caller's own seat, when the caller holds one.
	Seat online.Seat
	// Principal is the authenticated participant.
	Principal Principal
	// ExpiresAt is the deadline of this window.
	ExpiresAt time.Time
}

// Credential is the material a caller presents when it opens or renews a live
// subscription. Exactly one of the two fields is used.
type Credential struct {
	// Token is a Clerk session token for an account participant.
	Token string
	// GuestSecret is an opaque guest seat credential.
	GuestSecret string
}

// Authenticate verifies a presented credential and returns the participant it
// proves.
func (s *Service) Authenticate(ctx context.Context, credential Credential, origin string) (Principal, error) {
	switch {
	case credential.Token != "" && credential.GuestSecret != "":
		return Principal{}, ErrUnauthenticated
	case credential.Token != "":
		return s.AuthenticateAccount(ctx, credential.Token, origin)
	case credential.GuestSecret != "":
		return s.AuthenticateGuest(ctx, credential.GuestSecret, origin)
	default:
		return Principal{}, ErrUnauthenticated
	}
}

// AuthorizeStream authorizes a live subscription and returns its deadline.
//
// The check is the same one a live read performs: the presented credential
// must still be valid, it must be bound to this match, and the caller must
// still hold a seat in it. The durable revocation read shares one transaction
// with the membership read.
func (s *Service) AuthorizeStream(ctx context.Context, principal Principal, matchID string) (StreamGrant, error) {
	if principal.Participant.ID == "" || matchID == "" {
		return StreamGrant{}, ErrUnauthenticated
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return StreamGrant{}, err
	}
	defer tx.Rollback(ctx)
	// The authorization check reads the presented participant from the
	// context, so the verified principal is attached before it runs.
	if err = s.AuthorizeSeat(WithPrincipal(ctx, principal), tx, matchID, principal.Participant, ""); err != nil {
		return StreamGrant{}, err
	}
	var seats int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM online_seats WHERE match_id=$1 AND owner_kind=$2 AND owner_id=$3`,
		matchID, string(principal.Participant.Kind), principal.Participant.ID).Scan(&seats); err != nil {
		return StreamGrant{}, err
	}
	if seats == 0 {
		return StreamGrant{}, online.ErrNotAuthorized
	}
	if err = tx.Commit(ctx); err != nil {
		return StreamGrant{}, err
	}
	deadline := s.now().Add(s.options.StreamMaxDuration)
	if principal.ExpiresAt.Before(deadline) {
		deadline = principal.ExpiresAt
	}
	return StreamGrant{MatchID: matchID, Seat: principal.Seat, Principal: principal, ExpiresAt: deadline}, nil
}

// RenewStream re-verifies the presented credential and returns the next
// window.
//
// The renewal never trusts the principal carried by the previous grant. It
// verifies the credential again, so a revoked, expired, or foreign credential
// ends the subscription instead of extending it.
func (s *Service) RenewStream(ctx context.Context, grant StreamGrant, credential Credential, origin string) (StreamGrant, error) {
	if grant.MatchID == "" {
		return StreamGrant{}, ErrUnauthenticated
	}
	principal, err := s.Authenticate(ctx, credential, origin)
	if err != nil {
		return StreamGrant{}, err
	}
	if principal.Participant != grant.Principal.Participant {
		return StreamGrant{}, online.ErrNotAuthorized
	}
	return s.AuthorizeStream(ctx, principal, grant.MatchID)
}

// ErrStreamExpired reports a stream window that ended.
var ErrStreamExpired = errors.New("onlineauth: stream window expired")
