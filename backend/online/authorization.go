package online

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// Querier is the read surface shared by the connection pool and by a single
// transaction. Authorization checks run through it so a durable revocation
// read, and the lock that serializes it with an accepted write, can share the
// acceptance transaction.
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// SeatAuthorizer re-checks participant authorization inside the writer.
//
// The writer calls it before every stored-receipt return and before every
// accepted write, inside the transaction that performs the write. A credential
// that was revoked while the rules process was working is therefore rejected
// instead of racing the accepted state change.
//
// The implementation must take the same lock the revocation path takes, so a
// revocation and an accepted write are ordered instead of racing.
//
// An empty seat checks the presented credential only. A named seat also
// requires the actor to still hold that seat in the match.
type SeatAuthorizer interface {
	AuthorizeSeat(ctx context.Context, q Querier, matchID string, actor ParticipantRef, seat Seat) error
}

// Option configures a Service.
type Option func(*Service)

// WithSeatAuthorizer installs the participant authorization check. Without one
// the writer keeps only its built-in seat ownership checks.
func WithSeatAuthorizer(authorizer SeatAuthorizer) Option {
	return func(s *Service) { s.authorizer = authorizer }
}

// authorizeCredential re-checks the presented credential inside the caller's
// transaction. It runs before a stored receipt is returned so a revoked
// participant can neither read nor replay an accepted operation.
func (s *Service) authorizeCredential(ctx context.Context, q Querier, matchID string, actor ParticipantRef) error {
	if s.authorizer == nil {
		return nil
	}
	return s.authorizer.AuthorizeSeat(ctx, q, matchID, actor, "")
}

// authorizeSeat re-checks the presented credential and the seat binding.
func (s *Service) authorizeSeat(ctx context.Context, q Querier, matchID string, actor ParticipantRef, seat Seat) error {
	if s.authorizer == nil {
		return nil
	}
	return s.authorizer.AuthorizeSeat(ctx, q, matchID, actor, seat)
}
