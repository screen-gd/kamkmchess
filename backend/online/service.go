package online

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	db                 *pgxpool.Pool
	evaluator          Evaluator
	rulesPolicyVersion string
	authorizer         SeatAuthorizer
	deadlineScan       deadlineScan
}

// Open binds the online writer to a pool. It does not mutate schema.
func Open(_ context.Context, db *pgxpool.Pool, evaluator Evaluator, opts ...Option) (*Service, error) {
	if db == nil {
		return nil, ErrInvalidArgument
	}
	service := &Service{db: db, evaluator: evaluator, rulesPolicyVersion: DefaultRulesPolicyVersion}
	for _, opt := range opts {
		if opt != nil {
			opt(service)
		}
	}
	return service, nil
}

// SetRulesPolicyVersion pins the policy identifier stored with new matches and
// included in every rules-input hash. Historical rows keep their original value.
func (s *Service) SetRulesPolicyVersion(version string) error {
	if version == "" || len(version) > 64 {
		return ErrInvalidArgument
	}
	s.rulesPolicyVersion = version
	return nil
}

type queryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

const matchColumns = `match_id,schema_version,variant,starting_fen,position_fen,starting_time_ms,increment_ms,version,control_epoch,input_hash,rules_policy_version,status,result,result_version,completed_at,created_at,updated_at`

// Execute is the trusted command seam. The actor is supplied by the server's
// authenticated request handling, never by the command payload.
func (s *Service) Execute(ctx context.Context, actor ParticipantRef, cmd Command) (CommandResult, error) {
	if err := actor.Validate(); err != nil {
		return CommandResult{}, ErrInvalidArgument
	}
	if err := cmd.Validate(); err != nil {
		return CommandResult{}, err
	}
	switch cmd.Action.Kind {
	case ActionCreateMatch:
		return s.createMatch(ctx, actor, cmd)
	case ActionSubmitMove:
		return s.submitMove(ctx, actor, cmd)
	case ActionOfferDraw, ActionOfferTakeback:
		return s.executeOffer(ctx, actor, cmd)
	default:
		return s.executeMutation(ctx, actor, cmd)
	}
}

func (s *Service) createMatch(ctx context.Context, actor ParticipantRef, cmd Command) (CommandResult, error) {
	setup := cmd.Action.CreateMatch
	if err := setup.Validate(); err != nil {
		return CommandResult{}, err
	}
	creator := setup.Seats.White.Participant
	if cmd.Seat == SeatBlack {
		creator = setup.Seats.Black.Participant
	}
	if creator != actor || cmd.ControlEpoch != 1 {
		return CommandResult{}, ErrNotAuthorized
	}
	fingerprint, err := CommandFingerprint(actor, cmd)
	if err != nil {
		return CommandResult{}, err
	}
	// The credential is re-checked and an already accepted operation is
	// resolved inside one transaction that holds the participant lock. The
	// lock is what orders a duplicate return against a concurrent
	// revocation, and resolving the duplicate before the rules worker runs
	// keeps an accepted create retry free of a worker call.
	preflight, err := s.db.Begin(ctx)
	if err != nil {
		return CommandResult{}, err
	}
	if err = s.authorizeCredential(ctx, preflight, cmd.MatchID, actor); err != nil {
		_ = preflight.Rollback(ctx)
		return CommandResult{}, err
	}
	duplicate, duplicateErr := loadReceipt(ctx, preflight, cmd.MatchID, cmd.OperationID, fingerprint[:])
	// The lock is released before the rules worker runs. The acceptance
	// transaction takes it again and re-checks the credential.
	_ = preflight.Rollback(ctx)
	if duplicateErr == nil {
		return duplicate, nil
	}
	if !errors.Is(duplicateErr, ErrNotFound) {
		return CommandResult{}, duplicateErr
	}
	match := Match{
		SchemaVersion:      ContractsSchemaVersion,
		MatchID:            cmd.MatchID,
		Variant:            setup.Variant,
		StartingFEN:        setup.StartingFEN,
		PositionFEN:        setup.StartingFEN,
		TimeControl:        setup.TimeControl,
		Version:            1,
		ControlEpoch:       1,
		RulesPolicyVersion: s.rulesPolicyVersion,
		Status:             MatchActive,
		Seats: []MatchSeat{
			{Seat: SeatWhite, Participant: setup.Seats.White.Participant, PublicLabel: setup.Seats.White.PublicLabel, Control: setup.Seats.White.Control, ControlEpoch: 1},
			{Seat: SeatBlack, Participant: setup.Seats.Black.Participant, PublicLabel: setup.Seats.Black.PublicLabel, Control: setup.Seats.Black.Control, ControlEpoch: 1},
		},
		Clock:  InitialClock(setup.TimeControl),
		Moves:  []Move{},
		Offers: []Offer{},
	}
	if s.evaluator == nil {
		return CommandResult{}, ErrUnavailable
	}
	// Validate the immutable setup with no transaction or database lock held.
	if err = s.evaluator.ValidateSetup(ctx, BuildRulesInput(match, match.Moves, "")); err != nil {
		if errors.Is(err, ErrInvalidContract) || errors.Is(err, ErrActionNotAllowed) {
			return CommandResult{}, err
		}
		return CommandResult{}, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return CommandResult{}, err
	}
	defer tx.Rollback(ctx)
	// The credential is re-checked inside the acceptance transaction so a
	// revocation committed while the rules process was working cannot spend
	// this operation ID.
	if err = s.authorizeCredential(ctx, tx, cmd.MatchID, actor); err != nil {
		return CommandResult{}, err
	}
	if duplicate, err := loadReceipt(ctx, tx, cmd.MatchID, cmd.OperationID, fingerprint[:]); err == nil {
		return duplicate, nil
	} else if !errors.Is(err, ErrNotFound) {
		return CommandResult{}, err
	}
	var decision time.Time
	if err = tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&decision); err != nil {
		return CommandResult{}, err
	}
	decision = decision.UTC()
	match.CreatedAt = decision
	match.UpdatedAt = decision
	inputHash := RulesInputHash(BuildRulesInput(match, match.Moves, ""))
	if _, err = tx.Exec(ctx, `INSERT INTO online_matches(match_id,schema_version,variant,starting_fen,position_fen,starting_time_ms,increment_ms,version,control_epoch,input_hash,rules_policy_version,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
		match.MatchID, match.SchemaVersion, match.Variant, match.StartingFEN, match.PositionFEN, match.TimeControl.StartingTimeMs, match.TimeControl.IncrementMs, match.Version, match.ControlEpoch, mustHashBytes(inputHash), match.RulesPolicyVersion, string(match.Status), decision, decision); err != nil {
		if isUniqueViolation(err) {
			// A concurrent or earlier create may have committed this
			// operation. The duplicate is resolved in a transaction that
			// holds the participant lock, so the return is ordered against
			// a concurrent revocation instead of racing it.
			_ = tx.Rollback(ctx)
			return s.resolveCreateConflict(ctx, actor, cmd, fingerprint)
		}
		return CommandResult{}, err
	}
	for _, seat := range match.Seats {
		if _, err = tx.Exec(ctx, `INSERT INTO online_seats(match_id,seat,owner_kind,owner_id,public_label,control_kind,model_label,control_epoch,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
			match.MatchID, string(seat.Seat), string(seat.Participant.Kind), seat.Participant.ID, seat.PublicLabel, string(seat.Control.Kind), seat.Control.ModelLabel, seat.ControlEpoch, decision); err != nil {
			return CommandResult{}, err
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO online_clocks(match_id,white_ms,black_ms,active_seat,active_since,deadline_at,white_moved,black_moved,turn_number,reply_seat,reply_deadline_at,updated_at) VALUES($1,$2,$3,NULL,NULL,NULL,false,false,0,NULL,NULL,$4)`,
		match.MatchID, match.Clock.WhiteMs, match.Clock.BlackMs, decision); err != nil {
		return CommandResult{}, err
	}
	event := &Event{SchemaVersion: ContractsSchemaVersion, MatchID: match.MatchID, Version: 1, Kind: EventMatchCreated, ControlEpoch: 1, DecisionAt: decision, AcceptedAt: decision}
	if err = insertEvent(ctx, tx, *event); err != nil {
		return CommandResult{}, err
	}
	receipt := Receipt{SchemaVersion: ContractsSchemaVersion, MatchID: match.MatchID, OperationID: cmd.OperationID, Outcome: OutcomeAccepted, Version: 1, ControlEpoch: 1, DecidedAt: decision, Event: event}
	raw, err := marshalReceipt(receipt)
	if err != nil {
		return CommandResult{}, err
	}
	if err = insertReceipt(ctx, tx, cmd, fingerprint[:], raw, 1, 1, decision); err != nil {
		return CommandResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return CommandResult{}, err
	}
	return CommandResult{Receipt: receipt, Raw: raw}, nil
}

// resolveCreateConflict resolves a create that lost the race for the match
// row. The stored receipt is looked up inside a transaction that holds the
// participant lock, so a duplicate return is ordered against a concurrent
// revocation instead of racing it.
func (s *Service) resolveCreateConflict(ctx context.Context, actor ParticipantRef, cmd Command, fingerprint [32]byte) (CommandResult, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return CommandResult{}, err
	}
	defer tx.Rollback(ctx)
	if err = s.authorizeCredential(ctx, tx, cmd.MatchID, actor); err != nil {
		return CommandResult{}, err
	}
	duplicate, err := loadReceipt(ctx, tx, cmd.MatchID, cmd.OperationID, fingerprint[:])
	if err == nil {
		return duplicate, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return CommandResult{}, err
	}
	return CommandResult{}, ErrAlreadyExists
}

func (s *Service) submitMove(ctx context.Context, actor ParticipantRef, cmd Command) (CommandResult, error) {
	fingerprint, err := CommandFingerprint(actor, cmd)
	if err != nil {
		return CommandResult{}, err
	}
	// The consistent snapshot also resolves an already accepted operation and
	// re-checks the presented credential, so a revoked participant never
	// receives a stored receipt.
	snapshot, duplicate, sampled, err := s.preflightMove(ctx, cmd, actor, fingerprint)
	if err != nil {
		return CommandResult{}, err
	}
	if duplicate != nil {
		return *duplicate, nil
	}

	seat, ok := snapshot.Seat(cmd.Seat)
	if !ok || seat.Participant != actor {
		return CommandResult{}, ErrNotAuthorized
	}
	// The expiry is reconciled before any other refusal, so a late, stale or
	// wrong-seat intent settles the match the same way as a late legal move.
	// The reconciliation re-checks the deadline under the match lock, so the
	// snapshot reading is only a hint.
	if snapshot.Status == MatchActive {
		if snapshot.Clock.ReplyExpired(sampled) {
			return s.resolveOpeningExpired(ctx, actor, cmd, fingerprint, snapshot)
		}
		if snapshot.Clock.IsExpired(sampled) {
			return s.resolveExpiredMatch(ctx, actor, cmd, fingerprint, snapshot)
		}
	}
	if snapshot.Status != MatchActive {
		return CommandResult{}, ErrMatchEnded
	}
	if snapshot.Version != cmd.ExpectedVersion || snapshot.ControlEpoch != cmd.ControlEpoch {
		return CommandResult{}, ErrConflict
	}
	// Fast pre-check only. The authoritative side-to-move check repeats under
	// the match lock in applyWorkerCandidate.
	if err = requireSideToMove(snapshot.PositionFEN, snapshot.Clock, cmd.Seat); err != nil {
		return CommandResult{}, err
	}
	if s.evaluator == nil {
		return CommandResult{}, ErrUnavailable
	}
	input := BuildRulesInput(snapshot, snapshot.Moves, cmd.Action.SubmitMove.UCI)
	// External rules evaluation happens with no database lock or transaction held.
	candidate, err := s.evaluator.Evaluate(ctx, input)
	if err != nil {
		// A refused proposal is a contract outcome, not an unavailable
		// service. The refusal reason decides the answer.
		if errors.Is(err, ErrActionNotAllowed) || errors.Is(err, ErrStaleCandidate) || errors.Is(err, ErrInvalidContract) {
			return CommandResult{}, err
		}
		return CommandResult{}, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if err = candidate.Validate(); err != nil {
		return CommandResult{}, err
	}
	return s.applyWorkerCandidate(ctx, actor, cmd, fingerprint, candidate)
}

// preflightMove reads one consistent snapshot of the match, re-checks the
// presented credential, and resolves an already accepted operation. The
// duplicate receipt is only returned after the credential check, so a revoked
// participant cannot replay an accepted move.
//
// The returned time is the database clock read inside the same snapshot, so
// it is never older than the state it describes.
func (s *Service) preflightMove(ctx context.Context, cmd Command, actor ParticipantRef, fingerprint [32]byte) (Match, *CommandResult, time.Time, error) {
	var duplicate *CommandResult
	var sampled time.Time
	snapshot, err := loadMatchSnapshot(ctx, s.db, cmd.MatchID, func(ctx context.Context, tx pgx.Tx, match Match) error {
		if err := s.authorizeCredential(ctx, tx, cmd.MatchID, actor); err != nil {
			return err
		}
		receipt, err := lookupReceipt(ctx, tx, cmd.MatchID, cmd.OperationID, fingerprint[:])
		if err == nil {
			duplicate = &receipt
			return nil
		}
		if !errors.Is(err, ErrNotFound) {
			return err
		}
		if err = tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&sampled); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return Match{}, nil, time.Time{}, err
	}
	return snapshot, duplicate, sampled.UTC(), nil
}

// ApplyWorkerCandidate is the only path that commits a rules candidate. It
// re-locks, samples a fresh clock_timestamp(), reconciles expiry, then verifies
// the candidate's evaluated version, input hash, control epoch, and move.
func (s *Service) ApplyWorkerCandidate(ctx context.Context, actor ParticipantRef, cmd Command, candidate Candidate) (CommandResult, error) {
	if cmd.Action.Kind != ActionSubmitMove {
		return CommandResult{}, ErrInvalidArgument
	}
	fingerprint, err := CommandFingerprint(actor, cmd)
	if err != nil {
		return CommandResult{}, err
	}
	return s.applyWorkerCandidate(ctx, actor, cmd, fingerprint, candidate)
}

func (s *Service) applyWorkerCandidate(ctx context.Context, actor ParticipantRef, cmd Command, fingerprint [32]byte, candidate Candidate) (CommandResult, error) {
	if err := candidate.Validate(); err != nil {
		return CommandResult{}, err
	}
	if candidate.Move.Seat != cmd.Seat || candidate.Move.UCI != cmd.Action.SubmitMove.UCI {
		return CommandResult{}, ErrStaleCandidate
	}
	if candidate.EvaluatedVersion != cmd.ExpectedVersion || candidate.ControlEpoch != cmd.ControlEpoch {
		return CommandResult{}, ErrStaleCandidate
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return CommandResult{}, err
	}
	defer tx.Rollback(ctx)

	match, clock, decision, err := lockMatch(ctx, tx, cmd.MatchID)
	if err != nil {
		return CommandResult{}, err
	}
	// The credential is re-checked after the rules worker returned and before
	// any stored receipt is returned or any state is written. A revocation
	// committed while the worker was busy therefore rejects the command
	// instead of racing the accepted move.
	if err = s.authorizeCredential(ctx, tx, cmd.MatchID, actor); err != nil {
		return CommandResult{}, err
	}
	if duplicate, err := loadReceipt(ctx, tx, cmd.MatchID, cmd.OperationID, fingerprint[:]); err == nil {
		return duplicate, nil
	} else if !errors.Is(err, ErrNotFound) {
		return CommandResult{}, err
	}
	match.Clock = clock
	match.Moves, err = loadMoves(ctx, tx, cmd.MatchID)
	if err != nil {
		return CommandResult{}, err
	}
	// Authorization is checked before expiry reconciliation. An unrelated actor
	// must never be able to spend an operation ID on a match it does not own,
	// even when the match clock has already run out.
	seat, ok := match.Seat(cmd.Seat)
	if !ok || seat.Participant != actor {
		return CommandResult{}, ErrNotAuthorized
	}
	if err = s.authorizeSeat(ctx, tx, cmd.MatchID, actor, cmd.Seat); err != nil {
		return CommandResult{}, err
	}
	// The decision time is re-sampled after every participant lock is held.
	// The first sample happened before the authorization lock, so a command
	// that waited for a revocation, or for a busy seat, must not be judged
	// against a clock reading from before that wait.
	if decision, err = sampleDecision(ctx, tx, match.UpdatedAt); err != nil {
		return CommandResult{}, err
	}
	// The opening reply window is reconciled before any other deadline. An
	// unanswered reply ends the match, so a late intent cannot become a move.
	if clock.ReplyExpired(decision) && match.Status == MatchActive {
		return s.commitOpeningAbort(ctx, tx, cmd, fingerprint, match, clock, decision)
	}
	if clock.IsExpired(decision) && match.Status == MatchActive {
		_ = tx.Rollback(ctx)
		return s.resolveExpiredMatch(ctx, actor, cmd, fingerprint, match)
	}
	if match.Status != MatchActive {
		return CommandResult{}, ErrMatchEnded
	}
	if match.Version != cmd.ExpectedVersion || match.ControlEpoch != cmd.ControlEpoch {
		return CommandResult{}, ErrConflict
	}
	if err = requireSideToMove(match.PositionFEN, match.Clock, cmd.Seat); err != nil {
		return CommandResult{}, err
	}
	input := BuildRulesInput(match, match.Moves, cmd.Action.SubmitMove.UCI)
	if candidate.EvaluatedVersion != match.Version ||
		candidate.EvaluatedInputHash != input.InputHash ||
		candidate.ControlEpoch != match.ControlEpoch ||
		candidate.Move.Seat != cmd.Seat ||
		candidate.Move.UCI != cmd.Action.SubmitMove.UCI {
		return CommandResult{}, ErrStaleCandidate
	}
	if candidate.Result != nil {
		if err := candidate.Result.Validate(); err != nil {
			return CommandResult{}, err
		}
	}
	nextVersion := match.Version + 1
	move := *candidate.Move
	move.Version = nextVersion
	clock = ApplyAcceptedMove(clock, match.TimeControl, cmd.Seat, decision, candidate.Result != nil)
	if _, err = tx.Exec(ctx, `INSERT INTO online_moves(match_id,version,seat,uci,san,resulting_fen,decision_at,accepted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,
		match.MatchID, move.Version, string(move.Seat), move.UCI, move.SAN, move.ResultingFEN, decision); err != nil {
		return CommandResult{}, err
	}
	// An accepted move ends the mover's turn, so the mover's recovery budget
	// starts again. No other seat's budget changes.
	if _, err = tx.Exec(ctx, `UPDATE online_seats SET illegal_attempts_spent=0,format_corrections_spent=0,updated_at=$1 WHERE match_id=$2 AND seat=$3`,
		decision, match.MatchID, string(cmd.Seat)); err != nil {
		return CommandResult{}, err
	}
	match.PositionFEN = move.ResultingFEN
	match.Version = nextVersion
	match.Clock = clock
	match.Moves = append(match.Moves, move)
	match.UpdatedAt = decision
	if candidate.Result != nil {
		match.Status = terminalStatus(candidate.Result)
		match.Result = candidate.Result
		completed := decision
		match.CompletedAt = &completed
	}
	if err = s.updateMatch(ctx, tx, match, decision); err != nil {
		return CommandResult{}, err
	}
	event := &Event{SchemaVersion: ContractsSchemaVersion, MatchID: match.MatchID, Version: nextVersion, Kind: EventMove, Seat: &cmd.Seat, ControlEpoch: match.ControlEpoch, DecisionAt: decision, AcceptedAt: decision, Move: &move, Result: candidate.Result}
	if err = insertEvent(ctx, tx, *event); err != nil {
		return CommandResult{}, err
	}
	if candidate.Result != nil {
		if err = s.publishProjection(ctx, tx, match); err != nil {
			return CommandResult{}, err
		}
	}
	receipt := Receipt{SchemaVersion: ContractsSchemaVersion, MatchID: match.MatchID, OperationID: cmd.OperationID, Outcome: OutcomeAccepted, Version: nextVersion, ControlEpoch: match.ControlEpoch, DecidedAt: decision, Event: event, Result: candidate.Result}
	raw, err := marshalReceipt(receipt)
	if err != nil {
		return CommandResult{}, err
	}
	if err = insertReceipt(ctx, tx, cmd, fingerprint[:], raw, nextVersion, match.ControlEpoch, decision); err != nil {
		return CommandResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return CommandResult{}, err
	}
	return CommandResult{Receipt: receipt, Raw: raw}, nil
}

// executeOffer records a pending draw or takeback offer.
//
// An offer is part of the shared match state: it advances the match version
// and is recorded as its own event, so a durable event stream can rebuild
// which offer is pending. It never changes the position, the turn or the
// clocks. An in-flight candidate must still use the new canonical version.
// The offer is written under the match lock, after the same authorization and
// expiry checks every other intent passes, and it is bound to the version it
// produces.
func (s *Service) executeOffer(ctx context.Context, actor ParticipantRef, cmd Command) (CommandResult, error) {
	fingerprint, err := CommandFingerprint(actor, cmd)
	if err != nil {
		return CommandResult{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return CommandResult{}, err
	}
	defer tx.Rollback(ctx)

	match, clock, decision, err := lockMatch(ctx, tx, cmd.MatchID)
	if err != nil {
		return CommandResult{}, err
	}
	if err = s.authorizeCredential(ctx, tx, cmd.MatchID, actor); err != nil {
		return CommandResult{}, err
	}
	if duplicate, err := loadReceipt(ctx, tx, cmd.MatchID, cmd.OperationID, fingerprint[:]); err == nil {
		return duplicate, nil
	} else if !errors.Is(err, ErrNotFound) {
		return CommandResult{}, err
	}
	match.Clock = clock
	if match.Moves, err = loadMoves(ctx, tx, cmd.MatchID); err != nil {
		return CommandResult{}, err
	}
	seat, ok := match.Seat(cmd.Seat)
	if !ok || seat.Participant != actor {
		return CommandResult{}, ErrNotAuthorized
	}
	if err = s.authorizeSeat(ctx, tx, cmd.MatchID, actor, cmd.Seat); err != nil {
		return CommandResult{}, err
	}
	if decision, err = sampleDecision(ctx, tx, match.UpdatedAt); err != nil {
		return CommandResult{}, err
	}
	if clock.ReplyExpired(decision) && match.Status == MatchActive {
		return s.commitOpeningAbort(ctx, tx, cmd, fingerprint, match, clock, decision)
	}
	if clock.IsExpired(decision) && match.Status == MatchActive {
		_ = tx.Rollback(ctx)
		return s.resolveExpiredMatch(ctx, actor, cmd, fingerprint, match)
	}
	if match.Status != MatchActive {
		return CommandResult{}, ErrMatchEnded
	}
	if match.Version != cmd.ExpectedVersion || match.ControlEpoch != cmd.ControlEpoch {
		return CommandResult{}, ErrConflict
	}

	var kind OfferKind
	var target *int64
	switch cmd.Action.Kind {
	case ActionOfferDraw:
		kind = OfferDraw
	case ActionOfferTakeback:
		kind = OfferTakeback
		version := cmd.Action.OfferTakeback.TargetVersion
		// A takeback needs a completed opening exchange. The reply window
		// and its deadline are never touched by a takeback request.
		if !takebacksAllowed(match.Clock) {
			return CommandResult{}, ErrActionNotAllowed
		}
		if _, _, err = takebackTarget(match, version); err != nil {
			return CommandResult{}, err
		}
		target = &version
	default:
		return CommandResult{}, ErrInvalidContract
	}

	// The offer advances the canonical version and is bound to it, so the
	// offer is actionable only while the match version still equals it.
	nextVersion := match.Version + 1
	offer := Offer{
		OfferID:       hashHex(fingerprint),
		MatchID:       match.MatchID,
		Kind:          kind,
		Seat:          cmd.Seat,
		TargetVersion: target,
		BaseVersion:   nextVersion,
		CreatedAt:     decision,
	}
	// A seat has one outstanding offer per kind. A newer offer replaces the
	// older one, which stays in the table as a record of what was offered.
	if err = supersedeSeatOffer(ctx, tx, match.MatchID, kind, cmd.Seat, decision); err != nil {
		return CommandResult{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO online_offers(offer_id,match_id,kind,seat,target_version,base_version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
		offer.OfferID, offer.MatchID, string(offer.Kind), string(offer.Seat), offer.TargetVersion, offer.BaseVersion, offer.CreatedAt); err != nil {
		return CommandResult{}, err
	}
	match.Version = nextVersion
	match.UpdatedAt = decision
	if err = s.updateMatch(ctx, tx, match, decision); err != nil {
		return CommandResult{}, err
	}
	event := &Event{SchemaVersion: ContractsSchemaVersion, MatchID: match.MatchID, Version: nextVersion, Kind: EventOfferCreated, Seat: &cmd.Seat, ControlEpoch: match.ControlEpoch, DecisionAt: decision, AcceptedAt: decision, Offer: &offer}
	if err = insertEvent(ctx, tx, *event); err != nil {
		return CommandResult{}, err
	}
	receipt := Receipt{SchemaVersion: ContractsSchemaVersion, MatchID: match.MatchID, OperationID: cmd.OperationID, Outcome: OutcomeAccepted, Version: nextVersion, ControlEpoch: match.ControlEpoch, DecidedAt: decision, Event: event}
	raw, err := marshalReceipt(receipt)
	if err != nil {
		return CommandResult{}, err
	}
	if err = insertReceipt(ctx, tx, cmd, fingerprint[:], raw, nextVersion, match.ControlEpoch, decision); err != nil {
		return CommandResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return CommandResult{}, err
	}
	return CommandResult{Receipt: receipt, Raw: raw}, nil
}

// takebackTarget resolves the exact position a takeback offer names. The
// target version is the match version of the position that would be restored.
// It must be a position in the current line and it must leave at least one
// accepted move to discard.
func takebackTarget(match Match, target int64) (int, string, error) {
	if target < 1 {
		return 0, "", ErrActionNotAllowed
	}
	for index := range match.Moves {
		previous := int64(1)
		if index > 0 {
			previous = match.Moves[index-1].Version
		}
		if previous != target {
			continue
		}
		position := match.StartingFEN
		if index > 0 {
			position = match.Moves[index-1].ResultingFEN
		}
		return index, position, nil
	}
	return 0, "", ErrActionNotAllowed
}

func (s *Service) executeMutation(ctx context.Context, actor ParticipantRef, cmd Command) (CommandResult, error) {
	fingerprint, err := CommandFingerprint(actor, cmd)
	if err != nil {
		return CommandResult{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return CommandResult{}, err
	}
	defer tx.Rollback(ctx)

	match, clock, decision, err := lockMatch(ctx, tx, cmd.MatchID)
	if err != nil {
		return CommandResult{}, err
	}
	// The credential is re-checked inside the acceptance transaction before a
	// stored receipt is returned and before any state change.
	if err = s.authorizeCredential(ctx, tx, cmd.MatchID, actor); err != nil {
		return CommandResult{}, err
	}
	if duplicate, err := loadReceipt(ctx, tx, cmd.MatchID, cmd.OperationID, fingerprint[:]); err == nil {
		return duplicate, nil
	} else if !errors.Is(err, ErrNotFound) {
		return CommandResult{}, err
	}
	match.Clock = clock
	match.Moves, err = loadMoves(ctx, tx, cmd.MatchID)
	if err != nil {
		return CommandResult{}, err
	}
	// Authorization precedes expiry reconciliation so an unrelated actor cannot
	// write a timeout receipt for a match it does not own.
	seat, ok := match.Seat(cmd.Seat)
	if !ok || seat.Participant != actor {
		return CommandResult{}, ErrNotAuthorized
	}
	if err = s.authorizeSeat(ctx, tx, cmd.MatchID, actor, cmd.Seat); err != nil {
		return CommandResult{}, err
	}
	// The decision time is re-sampled after every participant lock is held.
	// The first sample happened before the authorization lock, so a command
	// that waited for a revocation, or for a busy seat, must not be judged
	// against a clock reading from before that wait.
	if decision, err = sampleDecision(ctx, tx, match.UpdatedAt); err != nil {
		return CommandResult{}, err
	}
	// The opening reply window is reconciled before any other deadline. An
	// unanswered reply ends the match, so a late intent cannot become a move.
	if clock.ReplyExpired(decision) && match.Status == MatchActive {
		return s.commitOpeningAbort(ctx, tx, cmd, fingerprint, match, clock, decision)
	}
	if clock.IsExpired(decision) && match.Status == MatchActive {
		_ = tx.Rollback(ctx)
		return s.resolveExpiredMatch(ctx, actor, cmd, fingerprint, match)
	}
	if match.Status != MatchActive && cmd.Action.Kind != ActionRemovePublicReplay {
		return CommandResult{}, ErrMatchEnded
	}
	if match.Version != cmd.ExpectedVersion || match.ControlEpoch != cmd.ControlEpoch {
		return CommandResult{}, ErrConflict
	}

	nextVersion := match.Version + 1
	event := &Event{SchemaVersion: ContractsSchemaVersion, MatchID: match.MatchID, Version: nextVersion, Seat: &cmd.Seat, ControlEpoch: match.ControlEpoch, DecisionAt: decision, AcceptedAt: decision}
	receipt := Receipt{SchemaVersion: ContractsSchemaVersion, MatchID: match.MatchID, OperationID: cmd.OperationID, Outcome: OutcomeAccepted, Version: nextVersion, ControlEpoch: match.ControlEpoch, DecidedAt: decision}
	switch cmd.Action.Kind {
	case ActionResign:
		other, _ := cmd.Seat.Other()
		result := &Result{Kind: ResultWin, Winner: &other, Reason: ReasonResignation}
		match.Status = MatchCompleted
		match.Result = result
		match.CompletedAt = &decision
		clock = terminalClock(clock, decision)
		event.Kind = EventResign
		event.Result = result
		receipt.Result = result
	case ActionCancel:
		// The fact that a seat once had an accepted move is historical. A
		// takeback that removes that move from the current line does not
		// turn a later cancellation back into an abort.
		if clock.Moved(cmd.Seat) {
			other, _ := cmd.Seat.Other()
			result := &Result{Kind: ResultWin, Winner: &other, Reason: ReasonResignation}
			match.Status = MatchCompleted
			match.Result = result
			match.CompletedAt = &decision
			clock = terminalClock(clock, decision)
			event.Kind = EventCancel
			event.Result = result
			receipt.Result = result
		} else {
			result := &Result{Kind: ResultAbort, Reason: ReasonAbort}
			match.Status = MatchAborted
			match.Result = result
			match.CompletedAt = &decision
			clock = terminalClock(clock, decision)
			event.Kind = EventCancel
			event.Result = result
			receipt.Result = result
		}
	case ActionAcceptDraw:
		offer, err := consentOffer(ctx, tx, match, OfferDraw, cmd.Seat, cmd.Action.AcceptOffer.OfferID)
		if err != nil {
			return CommandResult{}, err
		}
		result := &Result{Kind: ResultDraw, Reason: ReasonAgreement}
		match.Status = MatchCompleted
		match.Result = result
		match.CompletedAt = &decision
		clock = terminalClock(clock, decision)
		event.Kind = EventDrawAgreement
		event.Result = result
		receipt.Result = result
		if err = resolveOffer(ctx, tx, offer, decision, OfferAccepted); err != nil {
			return CommandResult{}, err
		}
	case ActionAcceptTakeback:
		offer, err := consentOffer(ctx, tx, match, OfferTakeback, cmd.Seat, cmd.Action.AcceptOffer.OfferID)
		if err != nil {
			return CommandResult{}, err
		}
		// A takeback needs a completed opening exchange. The reply window
		// and its deadline are never touched by a takeback request.
		if !takebacksAllowed(match.Clock) {
			return CommandResult{}, ErrActionNotAllowed
		}
		index, position, err := takebackTarget(match, *offer.TargetVersion)
		if err != nil {
			return CommandResult{}, err
		}
		// The discarded accepted moves stay in the table. Only the current
		// line changes, so the discarded private archives survive.
		discarded := match.Moves[index:]
		for _, discardedMove := range discarded {
			if _, err = tx.Exec(ctx, `INSERT INTO online_discarded_moves(match_id,move_version,takeback_version,discarded_at) VALUES($1,$2,$3,$4)`,
				match.MatchID, discardedMove.Version, nextVersion, decision); err != nil {
				return CommandResult{}, err
			}
		}
		match.Moves = match.Moves[:index]
		match.PositionFEN = position
		// The clock keeps running. The side that was thinking is charged and
		// the restored side to move takes over. No time is refunded and no
		// increment is minted.
		clock = chargeActiveClock(clock, decision)
		clock = stopClock(clock)
		sideToMove, ok := fenSideToMove(position)
		if !ok {
			return CommandResult{}, ErrInvalidContract
		}
		clock.TurnNumber = int64(len(match.Moves))
		// The increment that was credited to every discarded accepted move
		// is removed again. The elapsed time that was already charged stays
		// charged, and the replacement move is a new accepted move that
		// receives exactly one increment.
		for _, discardedMove := range discarded {
			clock.setBank(discardedMove.Seat, clock.Bank(discardedMove.Seat)-match.TimeControl.IncrementMs)
		}
		clock.armMainClock(sideToMove, decision)
		// The restored turn keeps the recovery budget it had already spent,
		// so a takeback never hands a seat a fresh attempt allowance.
		if err = restoreTurnBudgets(ctx, tx, match, turnPrefixKey(match.Moves), decision); err != nil {
			return CommandResult{}, err
		}
		event.Kind = EventTakebackAccept
		event.TakebackTargetVersion = offer.TargetVersion
		if err = resolveOffer(ctx, tx, offer, decision, OfferAccepted); err != nil {
			return CommandResult{}, err
		}
	case ActionRecordRecoveryAttempt:
		if err := requireSideToMove(match.PositionFEN, match.Clock, cmd.Seat); err != nil {
			return CommandResult{}, err
		}
		seat, ok := match.Seat(cmd.Seat)
		if !ok {
			return CommandResult{}, ErrNotAuthorized
		}
		switch cmd.Action.Recovery.Attempt {
		case RecoveryIllegalMove:
			seat.IllegalAttemptsSpent++
			if seat.IllegalAttemptsSpent >= MaxIllegalMoveAttempts {
				other, _ := cmd.Seat.Other()
				result := &Result{Kind: ResultWin, Winner: &other, Reason: ReasonIllegalMove}
				match.Status = MatchCompleted
				match.Result = result
				match.CompletedAt = &decision
				clock = terminalClock(clock, decision)
				event.Kind = EventIllegalMoveLoss
				event.Result = result
				event.RecoveryAttempt = &cmd.Action.Recovery.Attempt
				receipt.Result = result
			} else {
				event.Kind = EventRecoveryAttempt
				event.RecoveryAttempt = &cmd.Action.Recovery.Attempt
			}
		case RecoveryFormattingCorrection:
			if seat.FormatCorrectionsSpent >= MaxFormattingCorrections {
				// The automatic correction budget is spent. Only owner
				// recovery remains, so no further automatic correction is
				// recorded.
				return CommandResult{}, ErrActionNotAllowed
			}
			seat.FormatCorrectionsSpent++
			event.Kind = EventRecoveryAttempt
			event.RecoveryAttempt = &cmd.Action.Recovery.Attempt
		default:
			return CommandResult{}, ErrInvalidContract
		}
		if _, err = tx.Exec(ctx, `UPDATE online_seats SET illegal_attempts_spent=$1,format_corrections_spent=$2,updated_at=$3 WHERE match_id=$4 AND seat=$5`,
			seat.IllegalAttemptsSpent, seat.FormatCorrectionsSpent, decision, match.MatchID, string(cmd.Seat)); err != nil {
			return CommandResult{}, err
		}
		// The spent budget of this turn is journalled. The seat counters are
		// reset when that seat's own move is accepted, so the journal is what
		// a takeback that restores the turn reads back.
		if err = recordTurnBudget(ctx, tx, match.MatchID, cmd.Seat, clock.TurnNumber, turnPrefixKey(match.Moves), TurnBudget{
			IllegalAttemptsSpent:   seat.IllegalAttemptsSpent,
			FormatCorrectionsSpent: seat.FormatCorrectionsSpent,
		}, decision); err != nil {
			return CommandResult{}, err
		}
	case ActionSetControl:
		control := cmd.Action.SetControl.Control
		if err := control.Validate(); err != nil {
			return CommandResult{}, err
		}
		match.ControlEpoch++
		clock = match.Clock
		for i := range match.Seats {
			if match.Seats[i].Seat == cmd.Seat {
				match.Seats[i].Control = control
				match.Seats[i].ControlEpoch = match.ControlEpoch
			}
		}
		if _, err = tx.Exec(ctx, `UPDATE online_seats SET control_kind=$1,model_label=$2,control_epoch=$3,updated_at=$4 WHERE match_id=$5 AND seat=$6`,
			string(control.Kind), control.ModelLabel, match.ControlEpoch, decision, match.MatchID, string(cmd.Seat)); err != nil {
			return CommandResult{}, err
		}
		event.Kind = EventControlChange
		event.ControlEpoch = match.ControlEpoch
		event.Control = &control
		receipt.ControlEpoch = match.ControlEpoch
	case ActionRemovePublicReplay:
		if match.Status == MatchActive {
			return CommandResult{}, ErrActionNotAllowed
		}
		// The fingerprint includes the match scope, so different matches can use
		// the same operation ID without colliding in the global removal ledger.
		markerID := hashHex(fingerprint)
		var revoked *time.Time
		if err = tx.QueryRow(ctx, `UPDATE online_public_projections SET projection_json='{}'::jsonb,revoked_at=$1,revocation_marker_id=$2 WHERE match_id=$3 AND revoked_at IS NULL RETURNING revoked_at`, decision, markerID, match.MatchID).Scan(&revoked); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return CommandResult{}, ErrNotFound
			}
			return CommandResult{}, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO online_deletion_markers(marker_id,marker_kind,subject_kind,subject_id,match_id,reason,requested_at,applied_at) VALUES($1,'replay_removal','match',$2,$2,$3,$4,$4)`,
			markerID, match.MatchID, cmd.Action.RemoveReplay.Reason, decision); err != nil {
			return CommandResult{}, err
		}
		event.Kind = EventReplayRemoved
		receipt.Outcome = OutcomeReplayRemoved
	default:
		return CommandResult{}, ErrInvalidContract
	}
	match.Version = nextVersion
	match.Clock = clock
	match.UpdatedAt = decision
	if err = s.updateMatch(ctx, tx, match, decision); err != nil {
		return CommandResult{}, err
	}
	if err = insertEvent(ctx, tx, *event); err != nil {
		return CommandResult{}, err
	}
	if match.Result != nil && cmd.Action.Kind != ActionRemovePublicReplay {
		if err = s.publishProjection(ctx, tx, match); err != nil {
			return CommandResult{}, err
		}
	}
	receipt.Event = event
	raw, err := marshalReceipt(receipt)
	if err != nil {
		return CommandResult{}, err
	}
	if err = insertReceipt(ctx, tx, cmd, fingerprint[:], raw, nextVersion, match.ControlEpoch, decision); err != nil {
		return CommandResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return CommandResult{}, err
	}
	return CommandResult{Receipt: receipt, Raw: raw}, nil
}

// requireSideToMove refuses a move command from the seat that is not to move.
// The FEN side-to-move field is authoritative for the first move; afterwards the
// stored active seat must agree. This carries no chess rules beyond reading the
// already-validated FEN field, and it prevents a trusted-but-buggy candidate
// from letting one seat move twice.
func requireSideToMove(positionFEN string, clock ClockState, seat Seat) error {
	side, ok := fenSideToMove(positionFEN)
	if !ok {
		return ErrInvalidContract
	}
	if side != seat {
		return ErrActionNotAllowed
	}
	if clock.ActiveSeat != nil && *clock.ActiveSeat != seat {
		return ErrActionNotAllowed
	}
	return nil
}

// resolveExpiredMatch adjudicates a deadline that was already reached under the
// locked snapshot. The bounded timeout policy needs chess rules, so it is
// evaluated outside every transaction and then fenced by re-locking and
// re-checking the identical position, version, control epoch, and active seat.
// When no timeout-capable evaluator exists the writer fails closed: a flag fall
// never manufactures a win for the side that did not flag.
func (s *Service) resolveExpiredMatch(ctx context.Context, actor ParticipantRef, cmd Command, fingerprint [32]byte, snapshot Match) (CommandResult, error) {
	if snapshot.Clock.ActiveSeat == nil {
		return CommandResult{}, ErrConflict
	}
	expired := *snapshot.Clock.ActiveSeat
	evaluator, ok := s.evaluator.(TimeoutEvaluator)
	if !ok {
		return CommandResult{}, ErrTimeoutPolicyUnavailable
	}
	input := BuildRulesInput(snapshot, snapshot.Moves, "")
	facts, err := evaluator.EvaluateTimeout(ctx, input, expired)
	if err != nil {
		return CommandResult{}, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if err = facts.Validate(); err != nil {
		return CommandResult{}, err
	}
	if facts.EvaluatedVersion != input.Version ||
		facts.EvaluatedInputHash != input.InputHash ||
		facts.ControlEpoch != input.ControlEpoch ||
		facts.ExpiredSeat != expired {
		return CommandResult{}, ErrStaleCandidate
	}
	result := facts.Result()
	if err = result.Validate(); err != nil {
		return CommandResult{}, err
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return CommandResult{}, err
	}
	defer tx.Rollback(ctx)
	match, clock, decision, err := lockMatch(ctx, tx, cmd.MatchID)
	if err != nil {
		return CommandResult{}, err
	}
	// The credential is re-checked after the timeout policy was evaluated and
	// before any stored receipt is returned.
	if err = s.authorizeCredential(ctx, tx, cmd.MatchID, actor); err != nil {
		return CommandResult{}, err
	}
	if duplicate, dupErr := loadReceipt(ctx, tx, cmd.MatchID, cmd.OperationID, fingerprint[:]); dupErr == nil {
		return duplicate, nil
	} else if !errors.Is(dupErr, ErrNotFound) {
		return CommandResult{}, dupErr
	}
	match.Clock = clock
	if match.Moves, err = loadMoves(ctx, tx, cmd.MatchID); err != nil {
		return CommandResult{}, err
	}
	if seat, ok := match.Seat(cmd.Seat); !ok || seat.Participant != actor {
		return CommandResult{}, ErrNotAuthorized
	}
	if err = s.authorizeSeat(ctx, tx, cmd.MatchID, actor, cmd.Seat); err != nil {
		return CommandResult{}, err
	}
	// The decision time is re-sampled after every participant lock is held.
	// The first sample happened before the authorization lock, so a command
	// that waited for a revocation, or for a busy seat, must not be judged
	// against a clock reading from before that wait.
	if decision, err = sampleDecision(ctx, tx, match.UpdatedAt); err != nil {
		return CommandResult{}, err
	}
	if match.Status != MatchActive {
		return CommandResult{}, ErrMatchEnded
	}
	if clock.ActiveSeat == nil || *clock.ActiveSeat != expired || !clock.IsExpired(decision) {
		return CommandResult{}, ErrStaleCandidate
	}
	if match.Version != facts.EvaluatedVersion || match.ControlEpoch != facts.ControlEpoch {
		return CommandResult{}, ErrStaleCandidate
	}
	if BuildRulesInput(match, match.Moves, "").InputHash != facts.EvaluatedInputHash {
		return CommandResult{}, ErrStaleCandidate
	}
	return s.commitTimeout(ctx, tx, cmd, fingerprint, match, expired, decision, result)
}

// resolveOpeningExpired adjudicates an opening reply window that was already
// reached under the locked snapshot. The abort needs no chess rules, so the
// decision is taken under a fresh lock and a freshly sampled decision time.
func (s *Service) resolveOpeningExpired(ctx context.Context, actor ParticipantRef, cmd Command, fingerprint [32]byte, snapshot Match) (CommandResult, error) {
	if snapshot.Clock.ReplySeat == nil {
		return CommandResult{}, ErrConflict
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return CommandResult{}, err
	}
	defer tx.Rollback(ctx)
	match, clock, decision, err := lockMatch(ctx, tx, cmd.MatchID)
	if err != nil {
		return CommandResult{}, err
	}
	// The credential is re-checked after the snapshot and before any stored
	// receipt is returned.
	if err = s.authorizeCredential(ctx, tx, cmd.MatchID, actor); err != nil {
		return CommandResult{}, err
	}
	if duplicate, err := loadReceipt(ctx, tx, cmd.MatchID, cmd.OperationID, fingerprint[:]); err == nil {
		return duplicate, nil
	} else if !errors.Is(err, ErrNotFound) {
		return CommandResult{}, err
	}
	match.Clock = clock
	// The accepted line belongs to the terminal state, to the stored rules
	// input hash and to the published projection, so it is read under the
	// same lock.
	if match.Moves, err = loadMoves(ctx, tx, cmd.MatchID); err != nil {
		return CommandResult{}, err
	}
	seat, ok := match.Seat(cmd.Seat)
	if !ok || seat.Participant != actor {
		return CommandResult{}, ErrNotAuthorized
	}
	if err = s.authorizeSeat(ctx, tx, cmd.MatchID, actor, cmd.Seat); err != nil {
		return CommandResult{}, err
	}
	if decision, err = sampleDecision(ctx, tx, match.UpdatedAt); err != nil {
		return CommandResult{}, err
	}
	if match.Status != MatchActive {
		return CommandResult{}, ErrMatchEnded
	}
	if !clock.ReplyExpired(decision) {
		return CommandResult{}, ErrStaleCandidate
	}
	return s.commitOpeningAbort(ctx, tx, cmd, fingerprint, match, clock, decision)
}

// applyDeadlineResult ends a match with a deadline outcome.
//
// The caller holds the match row lock and has sampled a decision time at or
// after the deadline. The terminal state, the append-only event and the public
// projection are written in the caller's transaction, so the transition is
// atomic. The match row lock also makes it idempotent: a second sweep of the
// same match finds the terminal result and writes nothing.
//
// The transition is shared by the participant path and by the trusted
// deadline reconciliation, so both produce the same event, the same result
// and the same projection.
func (s *Service) applyDeadlineResult(ctx context.Context, tx pgx.Tx, match Match, clock ClockState, decision time.Time, kind EventKind, seat Seat, result *Result) (Event, error) {
	nextVersion := match.Version + 1
	match.Version = nextVersion
	match.Status = terminalStatus(result)
	match.Result = result
	completed := decision
	match.CompletedAt = &completed
	match.Clock = terminalClock(clock, decision)
	match.UpdatedAt = decision
	if err := s.updateMatch(ctx, tx, match, decision); err != nil {
		return Event{}, err
	}
	event := Event{SchemaVersion: ContractsSchemaVersion, MatchID: match.MatchID, Version: nextVersion, Kind: kind, Seat: &seat, ControlEpoch: match.ControlEpoch, DecisionAt: decision, AcceptedAt: decision, Result: result}
	if err := insertEvent(ctx, tx, event); err != nil {
		return Event{}, err
	}
	if err := s.publishProjection(ctx, tx, match); err != nil {
		return Event{}, err
	}
	return event, nil
}

// commitOpeningAbort ends the match because the opening reply window closed
// without an accepted reply.
//
// The window needs no chess rules, so the abort is committed in the same
// transaction that reconciled it. The caller holds the match row lock and has
// sampled a decision time at or after the reply deadline.
func (s *Service) commitOpeningAbort(ctx context.Context, tx pgx.Tx, cmd Command, fingerprint [32]byte, match Match, clock ClockState, decision time.Time) (CommandResult, error) {
	if clock.ReplySeat == nil {
		return CommandResult{}, ErrConflict
	}
	expired := *clock.ReplySeat
	result := &Result{Kind: ResultAbort, Reason: ReasonOpeningReplyTimeout}
	event, err := s.applyDeadlineResult(ctx, tx, match, clock, decision, EventAbort, expired, result)
	if err != nil {
		return CommandResult{}, err
	}
	receipt := Receipt{SchemaVersion: ContractsSchemaVersion, MatchID: match.MatchID, OperationID: cmd.OperationID, Outcome: OutcomeOpeningExpired, Version: event.Version, ControlEpoch: match.ControlEpoch, DecidedAt: decision, Event: &event, Result: result}
	raw, err := marshalReceipt(receipt)
	if err != nil {
		return CommandResult{}, err
	}
	if err := insertReceipt(ctx, tx, cmd, fingerprint[:], raw, event.Version, match.ControlEpoch, decision); err != nil {
		return CommandResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CommandResult{}, err
	}
	return CommandResult{Receipt: receipt, Raw: raw}, nil
}

// commitTimeout applies an already-validated timeout adjudication. The caller
// holds the match row lock and has confirmed the decision time is past the
// deadline for the expired seat.
func (s *Service) commitTimeout(ctx context.Context, tx pgx.Tx, cmd Command, fingerprint [32]byte, match Match, expired Seat, decision time.Time, result *Result) (CommandResult, error) {
	event, err := s.applyDeadlineResult(ctx, tx, match, match.Clock, decision, EventTimeout, expired, result)
	if err != nil {
		return CommandResult{}, err
	}
	receipt := Receipt{SchemaVersion: ContractsSchemaVersion, MatchID: match.MatchID, OperationID: cmd.OperationID, Outcome: OutcomeDeadlineExpired, Version: event.Version, ControlEpoch: match.ControlEpoch, DecidedAt: decision, Event: &event, Result: result}
	raw, err := marshalReceipt(receipt)
	if err != nil {
		return CommandResult{}, err
	}
	if err := insertReceipt(ctx, tx, cmd, fingerprint[:], raw, event.Version, match.ControlEpoch, decision); err != nil {
		return CommandResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CommandResult{}, err
	}
	return CommandResult{Receipt: receipt, Raw: raw}, nil
}

func (s *Service) updateMatch(ctx context.Context, tx pgx.Tx, match Match, decision time.Time) error {
	input := BuildRulesInput(match, match.Moves, "")
	var resultJSON any
	if match.Result != nil {
		raw, err := json.Marshal(match.Result)
		if err != nil {
			return err
		}
		resultJSON = string(raw)
	}
	var resultVersion any
	if match.Result != nil {
		resultVersion = match.Version
	}
	var completed any
	if match.CompletedAt != nil {
		completed = match.CompletedAt.UTC()
	}
	// result_version is latched when the terminal result is first accepted. A
	// later non-scoring event (for example replay removal) must not move it.
	_, err := tx.Exec(ctx, `UPDATE online_matches SET position_fen=$1,version=$2,control_epoch=$3,input_hash=$4,status=$5,result=$6::jsonb,result_version=COALESCE(result_version,$7),completed_at=$8,updated_at=$9 WHERE match_id=$10`,
		match.PositionFEN, match.Version, match.ControlEpoch, mustHashBytes(input.InputHash), string(match.Status), resultJSON, resultVersion, completed, decision, match.MatchID)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE online_clocks SET white_ms=$1,black_ms=$2,active_seat=$3,active_since=$4,deadline_at=$5,white_moved=$6,black_moved=$7,turn_number=$8,reply_seat=$9,reply_deadline_at=$10,updated_at=$11 WHERE match_id=$12`,
		match.Clock.WhiteMs, match.Clock.BlackMs, seatValue(match.Clock.ActiveSeat), match.Clock.ActiveSince, match.Clock.DeadlineAt, match.Clock.WhiteMoved, match.Clock.BlackMoved, match.Clock.TurnNumber, seatValue(match.Clock.ReplySeat), match.Clock.ReplyDeadlineAt, decision, match.MatchID)
	if err != nil {
		return err
	}
	// A version transition makes every offer that is bound to an earlier
	// version inapplicable, so the pending offers of a match are exactly the
	// ones that can still be accepted.
	if err = withdrawStaleOffers(ctx, tx, match.MatchID, match.Version, decision); err != nil {
		return err
	}
	if match.Result != nil {
		// A finished match has no pending offer.
		if _, err = tx.Exec(ctx, `UPDATE online_offers SET resolved_at=$1,resolution='withdrawn' WHERE match_id=$2 AND resolved_at IS NULL`, decision, match.MatchID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) publishProjection(ctx context.Context, tx pgx.Tx, match Match) error {
	projection, err := BuildPublicProjection(match)
	if err != nil {
		return err
	}
	if match.Result == nil {
		return ErrInvalidContract
	}
	hash, err := ResultHash(*match.Result)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(projection)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO online_public_projections(match_id,schema_version,projection_json,result_hash,published_at) VALUES($1,$2,$3::jsonb,$4,$5)`,
		match.MatchID, PublicProjectionSchemaVersion, string(raw), hash[:], match.CompletedAt.UTC())
	return err
}

// BuildPublicProjection constructs only allowlisted public fields.
func BuildPublicProjection(match Match) (PublicProjection, error) {
	if match.Result == nil || match.CompletedAt == nil {
		return PublicProjection{}, ErrInvalidContract
	}
	if err := match.Result.Validate(); err != nil {
		return PublicProjection{}, err
	}
	participants := make([]PublicParticipant, 0, 2)
	for _, seat := range []Seat{SeatWhite, SeatBlack} {
		found, ok := match.Seat(seat)
		if !ok {
			return PublicProjection{}, ErrInvalidContract
		}
		if !publicLabelShape(found.PublicLabel) {
			return PublicProjection{}, ErrInvalidContract
		}
		if err := found.Control.Validate(); err != nil {
			return PublicProjection{}, err
		}
		participants = append(participants, PublicParticipant{Seat: seat, PublicLabel: found.PublicLabel, Control: found.Control})
	}
	moves := make([]PublicMove, 0, len(match.Moves))
	for _, move := range match.Moves {
		moves = append(moves, PublicMove{Version: move.Version, Seat: move.Seat, UCI: move.UCI, SAN: move.SAN})
	}
	return PublicProjection{
		SchemaVersion:      PublicProjectionSchemaVersion,
		MatchID:            match.MatchID,
		Variant:            match.Variant,
		StartingFEN:        match.StartingFEN,
		TimeControl:        match.TimeControl,
		Participants:       participants,
		Moves:              moves,
		Result:             *match.Result,
		RulesPolicyVersion: match.RulesPolicyVersion,
		CompletedAt:        match.CompletedAt.UTC(),
	}, nil
}

func (s *Service) GetMatch(ctx context.Context, matchID string) (Match, error) {
	if !idPattern.MatchString(matchID) {
		return Match{}, ErrInvalidArgument
	}
	return loadMatchConsistent(ctx, s.db, matchID)
}

// GetMatchForParticipant returns the live match only to one of its participants.
// Missing and non-member matches share ErrNotFound to avoid existence leaks.
// The presented credential is re-checked inside the same snapshot.
func (s *Service) GetMatchForParticipant(ctx context.Context, matchID string, participant ParticipantRef) (Match, error) {
	if err := participant.Validate(); err != nil || !idPattern.MatchString(matchID) {
		return Match{}, ErrInvalidArgument
	}
	return loadMatchSnapshot(ctx, s.db, matchID, func(ctx context.Context, tx pgx.Tx, match Match) error {
		if err := s.authorizeCredential(ctx, tx, matchID, participant); err != nil {
			return err
		}
		if !match.HasParticipant(participant) {
			return ErrNotFound
		}
		return nil
	})
}

func (s *Service) GetReceipt(ctx context.Context, matchID, operationID string) (CommandResult, error) {
	if !idPattern.MatchString(matchID) || !idPattern.MatchString(operationID) {
		return CommandResult{}, ErrInvalidArgument
	}
	return loadReceiptWithoutHash(ctx, s.db, matchID, operationID)
}

// GetReceiptForParticipant avoids exposing receipt bytes to unrelated callers.
// The presented credential is re-checked inside the same snapshot that reads
// the receipt.
func (s *Service) GetReceiptForParticipant(ctx context.Context, matchID, operationID string, participant ParticipantRef) (CommandResult, error) {
	if err := participant.Validate(); err != nil || !idPattern.MatchString(matchID) || !idPattern.MatchString(operationID) {
		return CommandResult{}, ErrInvalidArgument
	}
	var result CommandResult
	_, err := loadMatchSnapshot(ctx, s.db, matchID, func(ctx context.Context, tx pgx.Tx, match Match) error {
		if err := s.authorizeCredential(ctx, tx, matchID, participant); err != nil {
			return err
		}
		if !match.HasParticipant(participant) {
			return ErrNotFound
		}
		receipt, err := lookupReceipt(ctx, tx, matchID, operationID, nil)
		if err != nil {
			return err
		}
		result = receipt
		return nil
	})
	if err != nil {
		return CommandResult{}, err
	}
	return result, nil
}

func (s *Service) GetPublicProjection(ctx context.Context, matchID string) (PublicProjection, error) {
	if !idPattern.MatchString(matchID) {
		return PublicProjection{}, ErrInvalidArgument
	}
	var raw []byte
	var revoked *time.Time
	var storedHash []byte
	err := s.db.QueryRow(ctx, `SELECT projection_json,result_hash,revoked_at FROM online_public_projections WHERE match_id=$1`, matchID).Scan(&raw, &storedHash, &revoked)
	if errors.Is(err, pgx.ErrNoRows) {
		return PublicProjection{}, ErrNotFound
	}
	if err != nil {
		return PublicProjection{}, err
	}
	if revoked != nil {
		return PublicProjection{}, ErrNotFound
	}
	var projection PublicProjection
	if err = json.Unmarshal(raw, &projection); err != nil {
		return PublicProjection{}, ErrInvalidContract
	}
	if projection.SchemaVersion != PublicProjectionSchemaVersion {
		return PublicProjection{}, ErrInvalidContract
	}
	if projection.MatchID != matchID {
		return PublicProjection{}, ErrInvalidContract
	}
	hash, err := ResultHash(projection.Result)
	if err != nil || !bytes.Equal(storedHash, hash[:]) {
		return PublicProjection{}, ErrInvalidContract
	}
	return projection, nil
}

func (s *Service) GetQueueEntry(ctx context.Context, entryID string) (QueueEntry, error) {
	if !idPattern.MatchString(entryID) {
		return QueueEntry{}, ErrInvalidArgument
	}
	var v QueueEntry
	err := s.db.QueryRow(ctx, `SELECT owner_kind,owner_id,seat_control_kind,seat_control_model_label,starting_time_ms,increment_ms,status,version,ready_at,cutoff_at,assigned_match_id,created_at,updated_at FROM online_queue_entries WHERE entry_id=$1`, entryID).
		Scan(&v.Owner.Kind, &v.Owner.ID, &v.Control.Kind, &v.Control.ModelLabel, &v.TimeControl.StartingTimeMs, &v.TimeControl.IncrementMs, &v.Status, &v.Version, &v.ReadyAt, &v.CutoffAt, &v.AssignedMatchID, &v.CreatedAt, &v.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return QueueEntry{}, ErrNotFound
	}
	if err != nil {
		return QueueEntry{}, err
	}
	v.SchemaVersion = ContractsSchemaVersion
	v.EntryID = entryID
	v.CreatedAt = v.CreatedAt.UTC()
	v.UpdatedAt = v.UpdatedAt.UTC()
	return v, nil
}

func (s *Service) GetRunnerLease(ctx context.Context, leaseID string) (RunnerLease, error) {
	if !idPattern.MatchString(leaseID) {
		return RunnerLease{}, ErrInvalidArgument
	}
	var v RunnerLease
	err := s.db.QueryRow(ctx, `SELECT match_id,seat,control_epoch,generation,runner_id,status,acquired_at,expires_at,revoked_at FROM online_runner_leases WHERE lease_id=$1`, leaseID).
		Scan(&v.MatchID, &v.Seat, &v.ControlEpoch, &v.Generation, &v.RunnerID, &v.Status, &v.AcquiredAt, &v.ExpiresAt, &v.RevokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return RunnerLease{}, ErrNotFound
	}
	if err != nil {
		return RunnerLease{}, err
	}
	v.SchemaVersion = ContractsSchemaVersion
	v.LeaseID = leaseID
	v.AcquiredAt = v.AcquiredAt.UTC()
	v.ExpiresAt = v.ExpiresAt.UTC()
	if v.RevokedAt != nil {
		t := v.RevokedAt.UTC()
		v.RevokedAt = &t
	}
	return v, nil
}

// loadMatchConsistent reads the match row, seats, clock, and moves from one
// repeatable-read snapshot. Independent statements under READ COMMITTED could
// otherwise observe a match version from one commit with moves from another.
//
// This is the unrestricted read. It is never used where a participant
// credential is checked, because a repeatable-read snapshot is fixed before
// the authorization lock is taken.
func loadMatchConsistent(ctx context.Context, db *pgxpool.Pool, matchID string) (Match, error) {
	tx, err := db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Match{}, err
	}
	defer tx.Rollback(ctx)
	match, err := loadMatch(ctx, tx, matchID)
	if err != nil {
		return Match{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Match{}, err
	}
	return match, nil
}

// loadMatchSnapshot reads a match and runs the authorization callback inside
// one transaction.
//
// The transaction is READ COMMITTED and it holds a shared lock on the match row
// until it ends.
//
// READ COMMITTED is deliberate. A repeatable-read snapshot is fixed by the
// first statement of the transaction, which is the match read, before the
// callback takes the participant lock. A revocation that commits while the
// callback waits for that lock would stay invisible to that snapshot, so the
// callback would authorize a credential that is already revoked.
//
// The shared lock is what keeps the read consistent. The only writer of a
// match takes the same row exclusively before every transition, so no writer
// can commit between the match read and the receipt read. The reader and the
// writer take their locks in the same order: the match row first, the
// participant lock second.
func loadMatchSnapshot(ctx context.Context, db *pgxpool.Pool, matchID string, within func(context.Context, pgx.Tx, Match) error) (Match, error) {
	tx, err := db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted, AccessMode: pgx.ReadWrite})
	if err != nil {
		return Match{}, err
	}
	defer tx.Rollback(ctx)
	match, err := loadMatchForShare(ctx, tx, matchID)
	if err != nil {
		return Match{}, err
	}
	if within != nil {
		if err = within(ctx, tx, match); err != nil {
			return Match{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Match{}, err
	}
	return match, nil
}

// loadMatch loads one match and its children from a single connection. When q is
// a writer transaction that already holds the match row lock the result is
// internally consistent. Read-only callers must use loadMatchConsistent.
func loadMatch(ctx context.Context, q queryer, matchID string) (Match, error) {
	return loadMatchWithLock(ctx, q, matchID, "")
}

// loadMatchForShare loads one match while holding a shared lock on its row.
//
// The shared lock blocks every state transition of that match, so the seats,
// clock, and moves read after it belong to the same committed version.
func loadMatchForShare(ctx context.Context, q queryer, matchID string) (Match, error) {
	return loadMatchWithLock(ctx, q, matchID, " FOR SHARE")
}

func loadMatchWithLock(ctx context.Context, q queryer, matchID, lockClause string) (Match, error) {
	match, err := scanMatch(q.QueryRow(ctx, `SELECT `+matchColumns+` FROM online_matches WHERE match_id=$1`+lockClause, matchID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Match{}, ErrNotFound
	}
	if err != nil {
		return Match{}, err
	}
	if match.Seats, err = loadSeats(ctx, q, matchID); err != nil {
		return Match{}, err
	}
	if match.Clock, err = loadClock(ctx, q, matchID); err != nil {
		return Match{}, err
	}
	if match.Moves, err = loadMoves(ctx, q, matchID); err != nil {
		return Match{}, err
	}
	if match.Offers, err = loadOffers(ctx, q, matchID); err != nil {
		return Match{}, err
	}
	return match, nil
}

// lockMatch acquires the match row lock first and samples clock_timestamp() in
// a separate statement afterwards. A single SELECT ... FOR UPDATE with
// clock_timestamp() could evaluate the clock expression before a lock wait, so
// it is deliberately not used.
func lockMatch(ctx context.Context, tx pgx.Tx, matchID string) (Match, ClockState, time.Time, error) {
	match, err := scanMatch(tx.QueryRow(ctx, `SELECT `+matchColumns+` FROM online_matches WHERE match_id=$1 FOR UPDATE`, matchID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Match{}, ClockState{}, time.Time{}, ErrNotFound
	}
	if err != nil {
		return Match{}, ClockState{}, time.Time{}, err
	}
	decision, err := sampleDecision(ctx, tx, match.UpdatedAt)
	if err != nil {
		return Match{}, ClockState{}, time.Time{}, err
	}
	clock, err := loadClock(ctx, tx, matchID)
	if err != nil {
		return Match{}, ClockState{}, time.Time{}, err
	}
	seats, err := loadSeats(ctx, tx, matchID)
	if err != nil {
		return Match{}, ClockState{}, time.Time{}, err
	}
	match.Seats = seats
	return match, clock, decision, nil
}

// sampleDecision samples the authoritative database clock.
//
// The reading is taken from the database, not from the host wall clock, so
// every writer of a match judges a deadline against the same clock. The match
// update time is the floor, so an accepted event time never moves backwards.
//
// The reading must be taken after the participant locks are held. A command
// that waited for a revocation, or for a busy seat, is judged against the time
// it actually acquired those locks and not against a reading from before the
// wait.
func sampleDecision(ctx context.Context, tx pgx.Tx, floor time.Time) (time.Time, error) {
	var decision time.Time
	if err := tx.QueryRow(ctx, `SELECT GREATEST(clock_timestamp(), $1::timestamptz)`, floor).Scan(&decision); err != nil {
		return time.Time{}, err
	}
	return decision.UTC(), nil
}

func scanMatch(row pgx.Row) (Match, error) {
	var m Match
	var resultRaw []byte
	var resultVersion *int64
	var inputHash []byte
	err := row.Scan(&m.MatchID, &m.SchemaVersion, &m.Variant, &m.StartingFEN, &m.PositionFEN, &m.TimeControl.StartingTimeMs, &m.TimeControl.IncrementMs, &m.Version, &m.ControlEpoch, &inputHash, &m.RulesPolicyVersion, &m.Status, &resultRaw, &resultVersion, &m.CompletedAt, &m.CreatedAt, &m.UpdatedAt)
	if err != nil {
		return Match{}, err
	}
	if len(inputHash) != 32 {
		return Match{}, ErrInvalidContract
	}
	if resultRaw != nil {
		if err = json.Unmarshal(resultRaw, &m.Result); err != nil {
			return Match{}, ErrInvalidContract
		}
	}
	m.CreatedAt = m.CreatedAt.UTC()
	m.UpdatedAt = m.UpdatedAt.UTC()
	if m.CompletedAt != nil {
		t := m.CompletedAt.UTC()
		m.CompletedAt = &t
	}
	return m, nil
}

func loadSeats(ctx context.Context, q queryer, matchID string) ([]MatchSeat, error) {
	rows, err := q.Query(ctx, `SELECT seat,owner_kind,owner_id,public_label,control_kind,model_label,control_epoch,illegal_attempts_spent,format_corrections_spent FROM online_seats WHERE match_id=$1 ORDER BY CASE seat WHEN 'white' THEN 0 ELSE 1 END`, matchID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]MatchSeat, 0, 2)
	for rows.Next() {
		var s MatchSeat
		if err = rows.Scan(&s.Seat, &s.Participant.Kind, &s.Participant.ID, &s.PublicLabel, &s.Control.Kind, &s.Control.ModelLabel, &s.ControlEpoch, &s.IllegalAttemptsSpent, &s.FormatCorrectionsSpent); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func loadClock(ctx context.Context, q queryer, matchID string) (ClockState, error) {
	var c ClockState
	var activeSeat *string
	var replySeat *string
	err := q.QueryRow(ctx, `SELECT white_ms,black_ms,active_seat,active_since,deadline_at,white_moved,black_moved,turn_number,reply_seat,reply_deadline_at FROM online_clocks WHERE match_id=$1`, matchID).
		Scan(&c.WhiteMs, &c.BlackMs, &activeSeat, &c.ActiveSince, &c.DeadlineAt, &c.WhiteMoved, &c.BlackMoved, &c.TurnNumber, &replySeat, &c.ReplyDeadlineAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ClockState{}, ErrNotFound
	}
	if err != nil {
		return ClockState{}, err
	}
	if activeSeat != nil {
		seat := Seat(*activeSeat)
		if seat != SeatWhite && seat != SeatBlack {
			return ClockState{}, ErrInvalidContract
		}
		c.ActiveSeat = &seat
	}
	if replySeat != nil {
		seat := Seat(*replySeat)
		if seat != SeatWhite && seat != SeatBlack {
			return ClockState{}, ErrInvalidContract
		}
		c.ReplySeat = &seat
	}
	if c.ActiveSince != nil {
		t := c.ActiveSince.UTC()
		c.ActiveSince = &t
	}
	if c.DeadlineAt != nil {
		t := c.DeadlineAt.UTC()
		c.DeadlineAt = &t
	}
	if c.ReplyDeadlineAt != nil {
		t := c.ReplyDeadlineAt.UTC()
		c.ReplyDeadlineAt = &t
	}
	return c, nil
}

// loadMoves returns the current line of accepted moves. A takeback keeps the
// discarded accepted moves in the table, so the current line is the accepted
// moves that no takeback discarded.
func loadMoves(ctx context.Context, q queryer, matchID string) ([]Move, error) {
	rows, err := q.Query(ctx, `SELECT m.version,m.seat,m.uci,m.san,m.resulting_fen FROM online_moves m WHERE m.match_id=$1 AND NOT EXISTS (SELECT 1 FROM online_discarded_moves d WHERE d.match_id=m.match_id AND d.move_version=m.version) ORDER BY m.version`, matchID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Move, 0)
	for rows.Next() {
		var m Move
		if err = rows.Scan(&m.Version, &m.Seat, &m.UCI, &m.SAN, &m.ResultingFEN); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// loadOffers returns the pending offers of a match. A resolved offer stays in
// the table as a record of what was offered.
func loadOffers(ctx context.Context, q queryer, matchID string) ([]Offer, error) {
	rows, err := q.Query(ctx, `SELECT offer_id,kind,seat,target_version,base_version,created_at FROM online_offers WHERE match_id=$1 AND resolved_at IS NULL ORDER BY created_at,offer_id`, matchID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Offer, 0, 2)
	for rows.Next() {
		var o Offer
		var kind string
		if err = rows.Scan(&o.OfferID, &kind, &o.Seat, &o.TargetVersion, &o.BaseVersion, &o.CreatedAt); err != nil {
			return nil, err
		}
		o.MatchID = matchID
		o.Kind = OfferKind(kind)
		o.CreatedAt = o.CreatedAt.UTC()
		out = append(out, o)
	}
	return out, rows.Err()
}

// resolveOffer records how a pending offer ended. The resolution is written
// once and never rewritten.
func resolveOffer(ctx context.Context, tx pgx.Tx, offer Offer, at time.Time, resolution OfferResolution) error {
	_, err := tx.Exec(ctx, `UPDATE online_offers SET resolved_at=$1,resolution=$2 WHERE offer_id=$3 AND resolved_at IS NULL`, at.UTC(), string(resolution), offer.OfferID)
	return err
}

func insertEvent(ctx context.Context, tx pgx.Tx, e Event) error {
	var moveUCI, moveSAN, fen *string
	if e.Move != nil {
		moveUCI, moveSAN, fen = &e.Move.UCI, &e.Move.SAN, &e.Move.ResultingFEN
	}
	var resultJSON any
	if e.Result != nil {
		raw, err := json.Marshal(e.Result)
		if err != nil {
			return err
		}
		resultJSON = string(raw)
	}
	var controlKind, controlLabel any
	if e.Control != nil {
		controlKind = string(e.Control.Kind)
		if e.Control.ModelLabel != nil {
			controlLabel = *e.Control.ModelLabel
		}
	}
	var recoveryAttempt any
	if e.RecoveryAttempt != nil {
		recoveryAttempt = string(*e.RecoveryAttempt)
	}
	var offerJSON any
	if e.Offer != nil {
		raw, err := json.Marshal(e.Offer)
		if err != nil {
			return err
		}
		offerJSON = string(raw)
	}
	_, err := tx.Exec(ctx, `INSERT INTO online_events(match_id,version,event_kind,seat,control_epoch,decision_at,accepted_at,move_uci,move_san,resulting_fen,result,control_kind,control_model_label,takeback_target_version,recovery_attempt,offer_json) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15::jsonb)`,
		e.MatchID, e.Version, string(e.Kind), seatValue(e.Seat), e.ControlEpoch, e.DecisionAt.UTC(), moveUCI, moveSAN, fen, resultJSON, controlKind, controlLabel, e.TakebackTargetVersion, recoveryAttempt, offerJSON)
	return err
}

func insertReceipt(ctx context.Context, tx pgx.Tx, cmd Command, hash []byte, raw []byte, version, controlEpoch int64, at time.Time) error {
	_, err := tx.Exec(ctx, `INSERT INTO online_operation_receipts(scope_kind,scope_id,operation_id,request_hash,result_json,version,control_epoch,accepted_at) VALUES('match',$1,$2,$3,$4,$5,$6,$7)`,
		cmd.MatchID, cmd.OperationID, hash, raw, version, controlEpoch, at.UTC())
	return err
}

func loadReceipt(ctx context.Context, q queryer, matchID, operationID string, wantHash []byte) (CommandResult, error) {
	return lookupReceipt(ctx, q, matchID, operationID, wantHash)
}

func loadReceiptWithoutHash(ctx context.Context, q queryer, matchID, operationID string) (CommandResult, error) {
	return lookupReceipt(ctx, q, matchID, operationID, nil)
}

func lookupReceipt(ctx context.Context, q queryer, matchID, operationID string, wantHash []byte) (CommandResult, error) {
	var hash, raw []byte
	err := q.QueryRow(ctx, `SELECT request_hash,result_json FROM online_operation_receipts WHERE scope_kind='match' AND scope_id=$1 AND operation_id=$2`, matchID, operationID).Scan(&hash, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return CommandResult{}, ErrNotFound
	}
	if err != nil {
		return CommandResult{}, err
	}
	if wantHash != nil && !bytes.Equal(hash, wantHash) {
		return CommandResult{}, ErrOperationReuse
	}
	var receipt Receipt
	if err = json.Unmarshal(raw, &receipt); err != nil {
		return CommandResult{}, ErrInvalidContract
	}
	copied := append([]byte(nil), raw...)
	return CommandResult{Receipt: receipt, Raw: copied, Duplicate: true}, nil
}

func marshalReceipt(receipt Receipt) ([]byte, error) {
	receipt.DecidedAt = receipt.DecidedAt.UTC()
	if receipt.Event != nil {
		receipt.Event.DecisionAt = receipt.Event.DecisionAt.UTC()
		receipt.Event.AcceptedAt = receipt.Event.AcceptedAt.UTC()
	}
	return json.Marshal(receipt)
}

func terminalStatus(result *Result) MatchStatus {
	if result != nil && result.Kind == ResultAbort {
		return MatchAborted
	}
	return MatchCompleted
}

func terminalClock(clock ClockState, decision time.Time) ClockState {
	clock = chargeActiveClock(clock, decision)
	return stopClock(clock)
}

// opponentSeat returns the other seat of the match.
func opponentSeat(seat Seat) Seat {
	other, _ := seat.Other()
	return other
}

func seatValue(seat *Seat) any {
	if seat == nil {
		return nil
	}
	return string(*seat)
}

func mustHashBytes(hexHash string) []byte {
	raw, err := hex.DecodeString(hexHash)
	if err != nil || len(raw) != 32 {
		panic("online: invalid internal hash")
	}
	return raw
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
