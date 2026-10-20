package rulesworker

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync/atomic"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// ErrInvalidRulesInput marks a caller-supplied online.RulesInput that cannot be
// evaluated as-is. It never wraps a worker crash, timeout, or rejection.
var ErrInvalidRulesInput = errors.New("invalid online rules input")

var onlineUCI = regexp.MustCompile(`^[a-h][1-8][a-h][1-8][qrbn]?$`)

// OnlineEvaluator adapts the private rules process to online.Evaluator. It is
// the only intended bridge between the HTTP/match authority and this package:
// it forwards already-authorized match facts, verifies they are internally
// consistent, and never reads or writes the database itself.
type OnlineEvaluator struct {
	client   *Client
	sequence atomic.Uint64
}

func NewOnlineEvaluator(client *Client) (*OnlineEvaluator, error) {
	if client == nil {
		return nil, errors.New("rulesworker: nil rules client")
	}
	return &OnlineEvaluator{client: client}, nil
}

// ValidateSetup uses an evaluate-only request so Go does not duplicate FEN,
// counter or terminal-position rules. Finished positions cannot start matches.
func (e *OnlineEvaluator) ValidateSetup(ctx context.Context, input online.RulesInput) error {
	if input.SchemaVersion != online.RulesInputSchemaVersion || input.RulesPolicyVersion != RulesPolicyVersion ||
		input.Version != 1 || input.ControlEpoch != 1 || input.ProposedMove != "" ||
		input.ActiveSeat != nil || len(input.Moves) != 0 || input.StartingFEN != input.PositionFEN ||
		online.RulesInputHash(input) != input.InputHash {
		return ErrInvalidRulesInput
	}
	response, err := e.client.Evaluate(ctx, Request{
		RequestID:          fmt.Sprintf("setup.%d", e.sequence.Add(1)),
		MatchVersion:       input.Version,
		FEN:                input.StartingFEN,
		History:            []string{input.StartingFEN},
		RulesPolicyVersion: input.RulesPolicyVersion,
	})
	if err != nil {
		var rejected *RejectionError
		if errors.As(err, &rejected) && rejected.Code == "invalid-fen" {
			return fmt.Errorf("%w: starting FEN rejected by the rules policy", online.ErrInvalidContract)
		}
		return err
	}
	if response.Facts.Ending != "none" {
		return fmt.Errorf("%w: starting position is already terminal (%s)", online.ErrActionNotAllowed, response.Facts.Ending)
	}
	return nil
}

// EvaluateTimeout applies the same pinned material and bounded one-ply timeout
// policy outside the match transaction. The writer must re-lock and verify the
// returned version, input hash, epoch and expired seat before committing it.
func (e *OnlineEvaluator) EvaluateTimeout(ctx context.Context, input online.RulesInput, expired online.Seat) (online.TimeoutFacts, error) {
	if input.SchemaVersion != online.RulesInputSchemaVersion || input.RulesPolicyVersion != RulesPolicyVersion ||
		input.Version < 1 || input.Version > MaxMatchVersion || input.ControlEpoch < 1 || input.ProposedMove != "" ||
		online.RulesInputHash(input) != input.InputHash {
		return online.TimeoutFacts{}, ErrInvalidRulesInput
	}
	seat, ok := seatToMove(input.PositionFEN)
	if !ok || seat != expired || input.ActiveSeat == nil || *input.ActiveSeat != expired {
		return online.TimeoutFacts{}, fmt.Errorf("%w: expired seat differs from the active position", ErrInvalidRulesInput)
	}
	history, err := positionHistory(input)
	if err != nil {
		return online.TimeoutFacts{}, err
	}
	color := "w"
	if expired == online.SeatBlack {
		color = "b"
	}
	response, err := e.client.Evaluate(ctx, Request{
		RequestID:          fmt.Sprintf("timeout.%d.%d.%d", e.sequence.Add(1), input.Version, input.ControlEpoch),
		MatchVersion:       input.Version,
		FEN:                input.PositionFEN,
		History:            history,
		Intent:             &Intent{Kind: "timeout", ExpiredColor: color},
		RulesPolicyVersion: input.RulesPolicyVersion,
	})
	if err != nil {
		return online.TimeoutFacts{}, err
	}
	facts := online.TimeoutFacts{
		SchemaVersion: online.RulesInputSchemaVersion, EvaluatedVersion: input.Version,
		EvaluatedInputHash: input.InputHash, ControlEpoch: input.ControlEpoch, ExpiredSeat: expired,
	}
	if response.Facts.TimeoutWinner == nil {
		return online.TimeoutFacts{}, ErrMalformed
	}
	switch *response.Facts.TimeoutWinner {
	case "white", "black":
		winner := online.Seat(*response.Facts.TimeoutWinner)
		facts.Winner = &winner
	case "draw":
	default:
		return online.TimeoutFacts{}, ErrMalformed
	}
	if err := facts.Validate(); err != nil {
		return online.TimeoutFacts{}, err
	}
	return facts, nil
}

// Evaluate maps one authoritative RulesInput to a correlated worker request and
// maps the deterministic reply back to an online.Candidate. Version, input hash,
// control epoch, seat, and proposed move are carried through unchanged so the
// service can reject a candidate evaluated against any other state.
func (e *OnlineEvaluator) Evaluate(ctx context.Context, input online.RulesInput) (online.Candidate, error) {
	if input.SchemaVersion != online.RulesInputSchemaVersion {
		return online.Candidate{}, fmt.Errorf("%w: schema version %d", ErrInvalidRulesInput, input.SchemaVersion)
	}
	if input.RulesPolicyVersion != RulesPolicyVersion {
		return online.Candidate{}, fmt.Errorf("%w: rules policy %q", ErrInvalidRulesInput, input.RulesPolicyVersion)
	}
	if input.Version < 1 || input.Version > MaxMatchVersion {
		return online.Candidate{}, fmt.Errorf("%w: match version %d", ErrInvalidRulesInput, input.Version)
	}
	if input.ControlEpoch < 1 {
		return online.Candidate{}, fmt.Errorf("%w: control epoch %d", ErrInvalidRulesInput, input.ControlEpoch)
	}
	if got := online.RulesInputHash(input); got != input.InputHash {
		return online.Candidate{}, fmt.Errorf("%w: input hash does not match the supplied state", ErrInvalidRulesInput)
	}
	if input.ProposedMove == "" || !onlineUCI.MatchString(input.ProposedMove) {
		return online.Candidate{}, fmt.Errorf("%w: proposed move must be UCI", ErrInvalidRulesInput)
	}

	seat, ok := seatToMove(input.PositionFEN)
	if !ok {
		return online.Candidate{}, fmt.Errorf("%w: position FEN has no valid side to move", ErrInvalidRulesInput)
	}
	if input.ActiveSeat != nil && *input.ActiveSeat != seat {
		return online.Candidate{}, fmt.Errorf("%w: active seat differs from the position", ErrInvalidRulesInput)
	}

	history, err := positionHistory(input)
	if err != nil {
		return online.Candidate{}, err
	}

	requestID := fmt.Sprintf("online.%d.%d.%d", e.sequence.Add(1), input.Version, input.ControlEpoch)
	response, err := e.client.Evaluate(ctx, Request{
		RequestID:          requestID,
		MatchVersion:       input.Version,
		FEN:                input.PositionFEN,
		History:            history,
		Intent:             &Intent{Kind: "move", From: input.ProposedMove[0:2], To: input.ProposedMove[2:4], Promotion: input.ProposedMove[4:]},
		RulesPolicyVersion: input.RulesPolicyVersion,
	})
	if err != nil {
		return online.Candidate{}, translateRejection(err)
	}
	if response.Candidate == nil {
		return online.Candidate{}, fmt.Errorf("%w: move response has no candidate", ErrInvalidRulesInput)
	}

	move := online.Move{
		Seat:         seat,
		UCI:          input.ProposedMove,
		SAN:          response.Candidate.SAN,
		ResultingFEN: response.Candidate.ResultingFEN,
	}
	candidate := online.Candidate{
		SchemaVersion:      online.RulesInputSchemaVersion,
		EvaluatedVersion:   input.Version,
		EvaluatedInputHash: input.InputHash,
		ControlEpoch:       input.ControlEpoch,
		Move:               &move,
		Result:             resultFor(response.Candidate.Ending.Ending, seat),
	}
	if err := candidate.Validate(); err != nil {
		return online.Candidate{}, err
	}
	return candidate, nil
}

// translateRejection maps a rules-process refusal to the shared online
// contract. An illegal or terminal proposal is a refused intent, not an
// unavailable service.
//
// A history that does not match the evaluated position is different: the
// writer and the rules process disagree about the position itself. That is an
// internal consistency failure, not a conflict the participant can fix, so it
// is reported as an unavailable rules service instead of a user-fixable
// stale candidate.
func translateRejection(err error) error {
	var rejected *RejectionError
	if !errors.As(err, &rejected) {
		return err
	}
	switch rejected.Code {
	case "illegal-move", "position-terminal":
		return fmt.Errorf("%w: %s", online.ErrActionNotAllowed, rejected.Message)
	case "invalid-history", "history-mismatch":
		return fmt.Errorf("%w: %s", online.ErrUnavailable, rejected.Message)
	case "invalid-fen":
		return fmt.Errorf("%w: %s", online.ErrInvalidContract, rejected.Message)
	default:
		return err
	}
}

// positionHistory builds the ordered FEN history the worker needs to derive
// repetition and fifty-move facts. Every move must advance the stored version
// and the final resulting FEN must be the evaluated position.
func positionHistory(input online.RulesInput) ([]string, error) {
	if input.StartingFEN == "" || input.PositionFEN == "" {
		return nil, fmt.Errorf("%w: starting and position FEN are required", ErrInvalidRulesInput)
	}
	if len(input.Moves)+1 > MaxHistoryFENs {
		return nil, fmt.Errorf("%w: match history is too long", ErrInvalidRulesInput)
	}
	history := make([]string, 0, len(input.Moves)+1)
	history = append(history, input.StartingFEN)
	previousVersion := int64(0)
	for index, move := range input.Moves {
		if move.Version <= previousVersion {
			return nil, fmt.Errorf("%w: move %d is out of order", ErrInvalidRulesInput, index)
		}
		if move.ResultingFEN == "" {
			return nil, fmt.Errorf("%w: move %d has no resulting FEN", ErrInvalidRulesInput, index)
		}
		previousVersion = move.Version
		history = append(history, move.ResultingFEN)
	}
	if history[len(history)-1] != input.PositionFEN {
		return nil, fmt.Errorf("%w: position FEN must be the last history entry", ErrInvalidRulesInput)
	}
	return history, nil
}

func seatToMove(fen string) (online.Seat, bool) {
	fields := strings.Fields(fen)
	if len(fields) < 2 {
		return "", false
	}
	switch fields[1] {
	case "w":
		return online.SeatWhite, true
	case "b":
		return online.SeatBlack, true
	default:
		return "", false
	}
}

// resultFor maps the worker's resolved terminal ending to the shared contract.
// nil means play continues.
func resultFor(ending string, mover online.Seat) *online.Result {
	draw := func(reason online.ResultReason) *online.Result {
		return &online.Result{Kind: online.ResultDraw, Reason: reason}
	}
	switch ending {
	case "checkmate":
		// mover is the side that made the candidate move and therefore wins.
		return &online.Result{Kind: online.ResultWin, Winner: &mover, Reason: online.ReasonCheckmate}
	case "stalemate":
		return draw(online.ReasonStalemate)
	case "insufficient-material":
		return draw(online.ReasonInsufficientMaterial)
	case "threefold-repetition":
		return draw(online.ReasonRepetition)
	case "hundred-halfmoves":
		return draw(online.ReasonFiftyMove)
	default:
		return nil
	}
}
