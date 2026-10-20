package online

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// MatchVersionForParticipant returns the durable version of a match for one
// participant.
//
// The read is bounded. It verifies the presented credential and the match
// membership with short pooled statements and then reads the durable version.
// It holds no transaction and no database connection while the caller waits,
// so a live update stream can poll it without occupying the pool.
//
// The version only advances, so a caller that polls it observes every
// accepted transition. A later snapshot read can only return the same or a
// newer version, so a poll that races a transition never hides it.
//
// A missing match and a match the participant does not belong to share
// ErrNotFound, so a caller cannot learn whether a match exists.
func (s *Service) MatchVersionForParticipant(ctx context.Context, matchID string, participant ParticipantRef) (int64, error) {
	if err := participant.Validate(); err != nil || !idPattern.MatchString(matchID) {
		return 0, ErrInvalidArgument
	}
	// The credential is re-checked with the same call the writer uses, so a
	// revoked session or a revoked guest seat ends the read exactly like it
	// ends an accepted write.
	if err := s.authorizeCredential(ctx, s.db, matchID, participant); err != nil {
		return 0, err
	}
	var version int64
	err := s.db.QueryRow(ctx, `SELECT version FROM online_matches WHERE match_id=$1`, matchID).Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	var seats int
	if err = s.db.QueryRow(ctx, `SELECT count(*) FROM online_seats WHERE match_id=$1 AND owner_kind=$2 AND owner_id=$3`,
		matchID, string(participant.Kind), participant.ID).Scan(&seats); err != nil {
		return 0, err
	}
	if seats == 0 {
		return 0, ErrNotFound
	}
	return version, nil
}
