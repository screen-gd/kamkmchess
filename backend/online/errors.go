// Package online owns the shared casual-online-match contract and the single
// PostgreSQL transaction writer for canonical online state.
//
// It is deliberately separate from package storage: private single-owner sync
// archives and shared online matches have different authorization, retention,
// and visibility rules. Nothing here reads or writes the private games,
// archive_chunks, archive_events, operations, or deletion_tombstones tables.
package online

import "errors"

var (
	// ErrInvalidArgument reports a malformed caller value before database work.
	ErrInvalidArgument = errors.New("online: invalid argument")
	// ErrInvalidContract reports a value that violates the versioned online contract.
	ErrInvalidContract = errors.New("online: invalid contract")
	// ErrNotFound reports an absent match, receipt, projection, queue entry, or lease.
	ErrNotFound = errors.New("online: not found")
	// ErrAlreadyExists reports a match ID that is already in use.
	ErrAlreadyExists = errors.New("online: already exists")
	// ErrConflict reports a stale expected version, seat, or control epoch.
	ErrConflict = errors.New("online: stale version or control epoch")
	// ErrOperationReuse reports a changed payload reusing an accepted operation ID.
	ErrOperationReuse = errors.New("online: operation id reused with changed payload")
	// ErrMatchEnded reports a command that cannot apply because the match is terminal.
	ErrMatchEnded = errors.New("online: match already ended")
	// ErrActionNotAllowed reports an action that the current match rules forbid.
	ErrActionNotAllowed = errors.New("online: action not allowed")
	// ErrStaleCandidate reports a worker candidate evaluated against other state.
	ErrStaleCandidate = errors.New("online: stale rules candidate")
	// ErrNotAuthorized reports a participant that does not own the claimed seat.
	ErrNotAuthorized = errors.New("online: participant does not control seat")
	// ErrUnavailable reports a missing or failed rules evaluator.
	ErrUnavailable = errors.New("online: rules evaluator unavailable")
	// ErrTimeoutPolicyUnavailable reports a flag fall that cannot be adjudicated
	// because no timeout-capable rules evaluator is configured. The writer fails
	// closed instead of manufacturing a win for the side that did not flag.
	ErrTimeoutPolicyUnavailable = errors.New("online: validated timeout policy unavailable")
)
