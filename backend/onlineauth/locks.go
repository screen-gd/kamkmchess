package onlineauth

import (
	"context"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// LockAccountScope takes the account advisory lock inside a transaction.
//
// The lock is the shared protocol between the participant command path, the
// revocation path, and the explicit account-link path. Taking it in a
// transaction orders a link against a session revocation instead of racing
// it.
//
// Outside a real transaction the call is a no-op, because a pooled statement
// cannot hold a lock that orders it against a concurrent revocation.
func LockAccountScope(ctx context.Context, q online.Querier, subject string) error {
	if subject == "" {
		return ErrUnauthenticated
	}
	return lockScope(ctx, q, accountLockKey(subject))
}

// LockSeatScope takes the guest seat advisory lock inside a transaction.
//
// The lock is the shared protocol between the participant command path, the
// credential rotation path, the seat revocation path, and the explicit
// account-link path.
func LockSeatScope(ctx context.Context, q online.Querier, matchID string, seat online.Seat) error {
	if matchID == "" || (seat != online.SeatWhite && seat != online.SeatBlack) {
		return ErrUnauthenticated
	}
	return lockScope(ctx, q, seatLockKey(matchID, seat))
}
