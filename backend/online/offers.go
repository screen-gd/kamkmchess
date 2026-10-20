package online

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// offerColumns is the stored shape of one offer row.
const offerColumns = `offer_id,kind,seat,target_version,base_version,created_at`

// storedOffer is one offer row together with its resolution. A resolved offer
// stays in the table as the record of what was offered.
type storedOffer struct {
	Offer
	Resolved bool
}

// loadOfferByID reads one offer of a match whatever its resolution is. An
// acceptance reads the offer it names so it can tell a live offer from a
// consumed or replaced one instead of accepting a different offer.
func loadOfferByID(ctx context.Context, q queryer, matchID, offerID string) (storedOffer, error) {
	var row storedOffer
	var kind string
	var resolvedAt *time.Time
	err := q.QueryRow(ctx, `SELECT `+offerColumns+`,resolved_at FROM online_offers WHERE match_id=$1 AND offer_id=$2`, matchID, offerID).
		Scan(&row.OfferID, &kind, &row.Seat, &row.TargetVersion, &row.BaseVersion, &row.CreatedAt, &resolvedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return storedOffer{}, ErrActionNotAllowed
	}
	if err != nil {
		return storedOffer{}, err
	}
	row.MatchID = matchID
	row.Kind = OfferKind(kind)
	row.CreatedAt = row.CreatedAt.UTC()
	row.Resolved = resolvedAt != nil
	return row, nil
}

// consentOffer resolves the exact offer an acceptance consents to.
//
// The offer must exist in this match, must still be pending, must be the kind
// the action accepts, must come from the opponent, and must be bound to the
// current match version. A replaced, consumed or stale offer is refused, so an
// acceptance never applies a different offer than the one that was offered.
func consentOffer(ctx context.Context, q queryer, match Match, kind OfferKind, accepting Seat, offerID string) (Offer, error) {
	row, err := loadOfferByID(ctx, q, match.MatchID, offerID)
	if err != nil {
		return Offer{}, err
	}
	if row.Resolved {
		return Offer{}, ErrActionNotAllowed
	}
	if row.Kind != kind {
		return Offer{}, ErrActionNotAllowed
	}
	if row.Seat != opponentSeat(accepting) {
		return Offer{}, ErrActionNotAllowed
	}
	// The offer is bound to the version it produced, so it is actionable only
	// while the match version still equals it.
	if row.BaseVersion != match.Version {
		return Offer{}, ErrConflict
	}
	return row.Offer, nil
}

// supersedeSeatOffer ends the pending offer of one kind that the same seat
// replaces. The row stays in the table as the record of what was offered.
func supersedeSeatOffer(ctx context.Context, tx pgx.Tx, matchID string, kind OfferKind, seat Seat, at time.Time) error {
	_, err := tx.Exec(ctx, `UPDATE online_offers SET resolved_at=$1,resolution='superseded' WHERE match_id=$2 AND kind=$3 AND seat=$4 AND resolved_at IS NULL`,
		at.UTC(), matchID, string(kind), string(seat))
	return err
}

// withdrawStaleOffers ends every pending offer that a version transition made
// inapplicable. An offer lives from the version it produced until the next
// transition of the match, so the pending offers of a match are exactly the
// ones that can still be accepted.
func withdrawStaleOffers(ctx context.Context, tx pgx.Tx, matchID string, version int64, at time.Time) error {
	_, err := tx.Exec(ctx, `UPDATE online_offers SET resolved_at=$1,resolution='withdrawn' WHERE match_id=$2 AND resolved_at IS NULL AND base_version<>$3`,
		at.UTC(), matchID, version)
	return err
}
