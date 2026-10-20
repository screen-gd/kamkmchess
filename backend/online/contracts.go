package online

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"
)

// Versioned wire contract versions. Bump these only with a matching Go/TypeScript
// contract change and an additive database migration.
//
// Version 2 replaces the abort action with cancel, adds the mutual draw and
// exact-version takeback actions, and adds the shared recovery budget record.
// The cancel action aborts before a side's first accepted move and resigns
// afterwards, so the old abort name no longer described the transition.
const (
	ContractsSchemaVersion        = 2
	RulesInputSchemaVersion       = 1
	PublicProjectionSchemaVersion = 1
	DefaultRulesPolicyVersion     = "online-rules/1"
)

// Shared turn budgets. They mirror the offline turn budgets so an online
// match spends the same recovery allowance.
const (
	// MaxIllegalMoveAttempts is the number of illegal attempts one turn
	// allows. The last one loses the match for that seat.
	MaxIllegalMoveAttempts = 4
	// MaxFormattingCorrections is the number of automatic formatting
	// corrections one turn allows. The budget is independent of the illegal
	// move budget; a further failure waits for owner recovery.
	MaxFormattingCorrections = 3
)

// OpeningReplyWindowMs is the time the responder of the opening move has to
// answer. The match aborts when the window closes without an accepted reply.
const OpeningReplyWindowMs = 15_000

type Seat string

const (
	SeatWhite Seat = "white"
	SeatBlack Seat = "black"
)

func (s Seat) Other() (Seat, bool) {
	switch s {
	case SeatWhite:
		return SeatBlack, true
	case SeatBlack:
		return SeatWhite, true
	default:
		return "", false
	}
}

type ParticipantKind string

const (
	ParticipantAccount ParticipantKind = "account"
	ParticipantGuest   ParticipantKind = "guest"
)

// ParticipantRef is an internal authorization identity. It never appears in a
// public projection and is only hashed into durable operation fingerprints.
type ParticipantRef struct {
	Kind ParticipantKind `json:"kind"`
	ID   string          `json:"id"`
}

type ControlKind string

const (
	ControlHuman  ControlKind = "human"
	ControlAgent  ControlKind = "agent"
	ControlEngine ControlKind = "engine"
)

// SeatControl is the declared controller. ModelLabel is a chosen public label,
// never a private routing ID, endpoint, credential, or provider conversation.
type SeatControl struct {
	Kind       ControlKind `json:"kind"`
	ModelLabel *string     `json:"modelLabel,omitempty"`
}

type TimeControl struct {
	StartingTimeMs int64 `json:"startingTimeMs"`
	IncrementMs    int64 `json:"incrementMs"`
}

type ClockState struct {
	WhiteMs     int64      `json:"whiteMs"`
	BlackMs     int64      `json:"blackMs"`
	ActiveSeat  *Seat      `json:"activeSeat"`
	ActiveSince *time.Time `json:"activeSince"`
	DeadlineAt  *time.Time `json:"deadlineAt"`
	WhiteMoved  bool       `json:"whiteMoved"`
	BlackMoved  bool       `json:"blackMoved"`
	TurnNumber  int64      `json:"turnNumber"`
	// ReplySeat is the seat that owes the opening reply. It is set only
	// between the first accepted move of the match and the responder's first
	// accepted reply. While it is set no main clock runs.
	ReplySeat *Seat `json:"replySeat"`
	// ReplyDeadlineAt ends the opening reply window. Missing it means no
	// opening reply is outstanding.
	ReplyDeadlineAt *time.Time `json:"replyDeadlineAt"`
}

func (c ClockState) Bank(seat Seat) int64 {
	switch seat {
	case SeatWhite:
		return c.WhiteMs
	case SeatBlack:
		return c.BlackMs
	default:
		return 0
	}
}

func (c ClockState) Moved(seat Seat) bool {
	switch seat {
	case SeatWhite:
		return c.WhiteMoved
	case SeatBlack:
		return c.BlackMoved
	default:
		return false
	}
}

// IsExpired reports whether the active clock deadline was reached at or before
// the supplied authoritative decision time. A nil deadline never expires.
func (c ClockState) IsExpired(at time.Time) bool {
	return c.DeadlineAt != nil && !at.Before(*c.DeadlineAt)
}

// ReplyExpired reports whether the opening reply window was reached at or
// before the supplied authoritative decision time. The window is the only
// deadline an unstarted or opening match has.
func (c ClockState) ReplyExpired(at time.Time) bool {
	return c.ReplyDeadlineAt != nil && !at.Before(*c.ReplyDeadlineAt)
}

// AwaitingOpeningReply reports whether the match owes an opening reply.
func (c ClockState) AwaitingOpeningReply() bool {
	return c.ReplySeat != nil
}

type MatchStatus string

const (
	MatchActive    MatchStatus = "active"
	MatchCompleted MatchStatus = "completed"
	MatchAborted   MatchStatus = "aborted"
)

type ResultKind string

const (
	ResultWin   ResultKind = "win"
	ResultDraw  ResultKind = "draw"
	ResultAbort ResultKind = "abort"
)

type ResultReason string

const (
	ReasonCheckmate            ResultReason = "checkmate"
	ReasonResignation          ResultReason = "resignation"
	ReasonTimeout              ResultReason = "timeout"
	ReasonAbandonment          ResultReason = "abandonment"
	ReasonStalemate            ResultReason = "stalemate"
	ReasonRepetition           ResultReason = "repetition"
	ReasonFiftyMove            ResultReason = "fifty_move"
	ReasonInsufficientMaterial ResultReason = "insufficient_material"
	ReasonAgreement            ResultReason = "agreement"
	ReasonAbort                ResultReason = "abort"
	// ReasonOpeningReplyTimeout marks the unscored abort that follows an
	// unanswered opening reply.
	ReasonOpeningReplyTimeout ResultReason = "opening_reply_timeout"
	// ReasonIllegalMove marks the loss a seat takes after spending its fourth
	// illegal move attempt in one turn.
	ReasonIllegalMove ResultReason = "illegal_move"
)

// Result is a typed, terminal match outcome. The database rejects any update
// that changes a stored non-null result.
type Result struct {
	Kind   ResultKind   `json:"kind"`
	Winner *Seat        `json:"winner"`
	Reason ResultReason `json:"reason"`
}

func (r Result) Validate() error {
	switch r.Kind {
	case ResultWin:
		if r.Winner == nil || (*r.Winner != SeatWhite && *r.Winner != SeatBlack) {
			return fmt.Errorf("%w: win requires white or black winner", ErrInvalidContract)
		}
		switch r.Reason {
		case ReasonCheckmate, ReasonResignation, ReasonTimeout, ReasonAbandonment, ReasonIllegalMove:
			return nil
		default:
			return fmt.Errorf("%w: invalid win reason %q", ErrInvalidContract, r.Reason)
		}
	case ResultDraw:
		if r.Winner != nil {
			return fmt.Errorf("%w: draw cannot name a winner", ErrInvalidContract)
		}
		switch r.Reason {
		case ReasonStalemate, ReasonRepetition, ReasonFiftyMove, ReasonInsufficientMaterial, ReasonAgreement:
			return nil
		default:
			return fmt.Errorf("%w: invalid draw reason %q", ErrInvalidContract, r.Reason)
		}
	case ResultAbort:
		if r.Winner != nil {
			return fmt.Errorf("%w: abort outcome is unscored", ErrInvalidContract)
		}
		switch r.Reason {
		case ReasonAbort, ReasonOpeningReplyTimeout:
			return nil
		default:
			return fmt.Errorf("%w: invalid abort reason %q", ErrInvalidContract, r.Reason)
		}
	default:
		return fmt.Errorf("%w: invalid result kind %q", ErrInvalidContract, r.Kind)
	}
}

type Move struct {
	Version      int64  `json:"version"`
	Seat         Seat   `json:"seat"`
	UCI          string `json:"uci"`
	SAN          string `json:"san"`
	ResultingFEN string `json:"resultingFen"`
}

type EventKind string

const (
	EventMatchCreated   EventKind = "match_created"
	EventMove           EventKind = "move"
	EventResign         EventKind = "resign"
	EventAbort          EventKind = "abort"
	EventCancel         EventKind = "cancel"
	EventControlChange  EventKind = "control_change"
	EventTimeout        EventKind = "timeout"
	EventReplayRemoved  EventKind = "replay_removed"
	EventDrawAgreement  EventKind = "draw_agreement"
	EventTakebackAccept EventKind = "takeback_accepted"
	// EventOfferCreated records a pending offer. An offer is part of the
	// versioned match state, so the event carries the exact offer it created.
	EventOfferCreated EventKind = "offer_created"
	// EventRecoveryAttempt records one spent recovery attempt of a turn.
	EventRecoveryAttempt EventKind = "recovery_attempt"
	// EventIllegalMoveLoss ends the match after the fourth illegal attempt.
	EventIllegalMoveLoss EventKind = "illegal_move_loss"
)

type Event struct {
	SchemaVersion int          `json:"schemaVersion"`
	MatchID       string       `json:"matchId"`
	Version       int64        `json:"version"`
	Kind          EventKind    `json:"kind"`
	Seat          *Seat        `json:"seat,omitempty"`
	ControlEpoch  int64        `json:"controlEpoch"`
	DecisionAt    time.Time    `json:"decisionAt"`
	AcceptedAt    time.Time    `json:"acceptedAt"`
	Move          *Move        `json:"move,omitempty"`
	Result        *Result      `json:"result,omitempty"`
	Control       *SeatControl `json:"control,omitempty"`
	// Offer is the pending offer an offer_created event created. It is the
	// only payload of that event kind.
	Offer *Offer `json:"offer,omitempty"`
	// TakebackTargetVersion is the exact position an accepted takeback
	// restored.
	TakebackTargetVersion *int64 `json:"takebackTargetVersion,omitempty"`
	// RecoveryAttempt names the spent recovery attempt an event records.
	RecoveryAttempt *RecoveryAttemptKind `json:"recoveryAttempt,omitempty"`
}

type MatchSeat struct {
	Seat         Seat           `json:"seat"`
	Participant  ParticipantRef `json:"participant"`
	PublicLabel  string         `json:"publicLabel"`
	Control      SeatControl    `json:"control"`
	ControlEpoch int64          `json:"controlEpoch"`
	// IllegalAttemptsSpent and FormatCorrectionsSpent are the recovery
	// budget already spent in this seat's current turn. They reset only when
	// that seat's next move is accepted. A control change or a takeback never
	// resets them.
	IllegalAttemptsSpent   int `json:"illegalAttemptsSpent"`
	FormatCorrectionsSpent int `json:"formatCorrectionsSpent"`
}

type Match struct {
	SchemaVersion      int         `json:"schemaVersion"`
	MatchID            string      `json:"matchId"`
	Variant            string      `json:"variant"`
	StartingFEN        string      `json:"startingFen"`
	PositionFEN        string      `json:"positionFen"`
	TimeControl        TimeControl `json:"timeControl"`
	Version            int64       `json:"version"`
	ControlEpoch       int64       `json:"controlEpoch"`
	RulesPolicyVersion string      `json:"rulesPolicyVersion"`
	Status             MatchStatus `json:"status"`
	Result             *Result     `json:"result"`
	Seats              []MatchSeat `json:"seats"`
	Clock              ClockState  `json:"clock"`
	Moves              []Move      `json:"moves"`
	Offers             []Offer     `json:"offers"`
	CreatedAt          time.Time   `json:"createdAt"`
	UpdatedAt          time.Time   `json:"updatedAt"`
	CompletedAt        *time.Time  `json:"completedAt"`
}

func (m Match) Seat(seat Seat) (MatchSeat, bool) {
	for _, s := range m.Seats {
		if s.Seat == seat {
			return s, true
		}
	}
	return MatchSeat{}, false
}

func (m Match) HasParticipant(participant ParticipantRef) bool {
	for _, seat := range m.Seats {
		if seat.Participant == participant {
			return true
		}
	}
	return false
}

type ActionKind string

const (
	ActionCreateMatch ActionKind = "create_match"
	ActionSubmitMove  ActionKind = "submit_move"
	ActionResign      ActionKind = "resign"
	// ActionCancel ends the match for its seat. It aborts while that seat has
	// never had an accepted move and resigns afterwards. The fact that a seat
	// once moved is historical: a takeback that removes the move from the
	// current line does not turn the later cancellation back into an abort.
	ActionCancel             ActionKind = "cancel"
	ActionSetControl         ActionKind = "set_control"
	ActionRemovePublicReplay ActionKind = "remove_public_replay"
	// ActionOfferDraw records a draw offer. It is a versioned transition: the
	// offer is part of the shared match state, so it advances the match
	// version without changing the position, the turn or the clocks.
	ActionOfferDraw ActionKind = "offer_draw"
	// ActionAcceptDraw accepts the opponent's pending draw offer. It names
	// the exact offer it consents to.
	ActionAcceptDraw ActionKind = "accept_draw"
	// ActionOfferTakeback records a takeback offer for an exact position.
	ActionOfferTakeback ActionKind = "offer_takeback"
	// ActionAcceptTakeback accepts the opponent's pending takeback offer. It
	// names the exact offer it consents to.
	ActionAcceptTakeback ActionKind = "accept_takeback"
	// ActionRecordRecoveryAttempt records one spent recovery attempt.
	ActionRecordRecoveryAttempt ActionKind = "record_recovery_attempt"
)

type CreateSeat struct {
	Participant ParticipantRef `json:"participant"`
	PublicLabel string         `json:"publicLabel"`
	Control     SeatControl    `json:"control"`
}

type CreateMatchSeats struct {
	White CreateSeat `json:"white"`
	Black CreateSeat `json:"black"`
}

type CreateMatchSetup struct {
	Variant     string           `json:"variant"`
	StartingFEN string           `json:"startingFen"`
	TimeControl TimeControl      `json:"timeControl"`
	Seats       CreateMatchSeats `json:"seats"`
}

type SubmitMoveAction struct {
	UCI string `json:"uci"`
}

type SetControlAction struct {
	Control SeatControl `json:"control"`
}

type RemovePublicReplayAction struct {
	Reason string `json:"reason"`
}

// OfferTakebackAction names the exact match version whose position a
// takeback offer would restore. The offer is stale as soon as the match
// version moves past the version the offer was made against.
type OfferTakebackAction struct {
	TargetVersion int64 `json:"targetVersion"`
}

// AcceptOfferAction names the exact offer a participant consents to.
//
// The consent is bound to the identity of the offer the other participant
// saw. A replaced, consumed or stale offer cannot be accepted in its place,
// so an acceptance never applies a different offer than the one that was
// offered.
type AcceptOfferAction struct {
	OfferID string `json:"offerId"`
}

// RecoveryAttemptKind names one spent recovery attempt.
type RecoveryAttemptKind string

const (
	// RecoveryIllegalMove spends one illegal move attempt of the current turn.
	RecoveryIllegalMove RecoveryAttemptKind = "illegal_move"
	// RecoveryFormattingCorrection spends one automatic formatting
	// correction of the current turn. The correction budget is independent of
	// the illegal move budget.
	RecoveryFormattingCorrection RecoveryAttemptKind = "formatting_correction"
)

// RecordRecoveryAttemptAction records one spent recovery attempt.
type RecordRecoveryAttemptAction struct {
	Attempt RecoveryAttemptKind `json:"attempt"`
}

// OfferKind names a pending offer.
type OfferKind string

const (
	OfferDraw     OfferKind = "draw"
	OfferTakeback OfferKind = "takeback"
)

// OfferResolution records how a pending offer ended.
type OfferResolution string

const (
	// OfferAccepted marks an offer the other participant acted on.
	OfferAccepted OfferResolution = "accepted"
	// OfferSuperseded marks an offer replaced by a newer offer from the
	// same seat.
	OfferSuperseded OfferResolution = "superseded"
	// OfferWithdrawn marks an offer that the continuation of the match ended.
	// An accepted move withdraws every pending draw offer, because play that
	// continues after an offer declines it.
	OfferWithdrawn OfferResolution = "withdrawn"
)

// Offer is one pending draw or takeback offer. An offer is part of the
// versioned match state: creating it advances the match version without
// changing the position, the turn or the clocks.
//
// BaseVersion is the match version the offer produced. The offer is
// actionable only while the match version still equals it, so any later
// transition makes it inapplicable and it is withdrawn.
type Offer struct {
	OfferID       string    `json:"offerId"`
	MatchID       string    `json:"matchId"`
	Kind          OfferKind `json:"kind"`
	Seat          Seat      `json:"seat"`
	TargetVersion *int64    `json:"targetVersion"`
	BaseVersion   int64     `json:"baseVersion"`
	CreatedAt     time.Time `json:"createdAt"`
}

// Action is a closed, typed union. It has no free-form state or SQL field.
type Action struct {
	Kind          ActionKind
	CreateMatch   *CreateMatchSetup
	SubmitMove    *SubmitMoveAction
	SetControl    *SetControlAction
	RemoveReplay  *RemovePublicReplayAction
	OfferTakeback *OfferTakebackAction
	// AcceptOffer names the exact offer an acceptance consents to.
	AcceptOffer *AcceptOfferAction
	Recovery    *RecordRecoveryAttemptAction
}

func (a Action) MarshalJSON() ([]byte, error) {
	if err := a.Validate(); err != nil {
		return nil, err
	}
	switch a.Kind {
	case ActionCreateMatch:
		return json.Marshal(struct {
			Kind  ActionKind       `json:"kind"`
			Setup CreateMatchSetup `json:"setup"`
		}{a.Kind, *a.CreateMatch})
	case ActionSubmitMove:
		return json.Marshal(struct {
			Kind ActionKind `json:"kind"`
			Move string     `json:"move"`
		}{a.Kind, a.SubmitMove.UCI})
	case ActionSetControl:
		return json.Marshal(struct {
			Kind    ActionKind  `json:"kind"`
			Control SeatControl `json:"control"`
		}{a.Kind, a.SetControl.Control})
	case ActionRemovePublicReplay:
		return json.Marshal(struct {
			Kind   ActionKind `json:"kind"`
			Reason string     `json:"reason"`
		}{a.Kind, a.RemoveReplay.Reason})
	case ActionOfferTakeback:
		return json.Marshal(struct {
			Kind          ActionKind `json:"kind"`
			TargetVersion int64      `json:"targetVersion"`
		}{a.Kind, a.OfferTakeback.TargetVersion})
	case ActionAcceptDraw, ActionAcceptTakeback:
		return json.Marshal(struct {
			Kind    ActionKind `json:"kind"`
			OfferID string     `json:"offerId"`
		}{a.Kind, a.AcceptOffer.OfferID})
	case ActionRecordRecoveryAttempt:
		return json.Marshal(struct {
			Kind    ActionKind          `json:"kind"`
			Attempt RecoveryAttemptKind `json:"attempt"`
		}{a.Kind, a.Recovery.Attempt})
	case ActionResign, ActionCancel, ActionOfferDraw:
		return json.Marshal(struct {
			Kind ActionKind `json:"kind"`
		}{a.Kind})
	default:
		return nil, fmt.Errorf("%w: unknown action kind", ErrInvalidContract)
	}
}

func (a *Action) UnmarshalJSON(data []byte) error {
	var probe struct {
		Kind ActionKind `json:"kind"`
	}
	if err := json.Unmarshal(data, &probe); err != nil || probe.Kind == "" {
		return fmt.Errorf("%w: action kind", ErrInvalidContract)
	}
	*a = Action{Kind: probe.Kind}
	switch probe.Kind {
	case ActionCreateMatch:
		var v struct {
			Kind  ActionKind       `json:"kind"`
			Setup CreateMatchSetup `json:"setup"`
		}
		if err := decodeStrict(data, &v); err != nil {
			return fmt.Errorf("%w: create_match action", ErrInvalidContract)
		}
		a.CreateMatch = &v.Setup
	case ActionSubmitMove:
		var v struct {
			Kind ActionKind `json:"kind"`
			Move string     `json:"move"`
		}
		if err := decodeStrict(data, &v); err != nil {
			return fmt.Errorf("%w: submit_move action", ErrInvalidContract)
		}
		a.SubmitMove = &SubmitMoveAction{UCI: v.Move}
	case ActionResign, ActionCancel, ActionOfferDraw:
		var v struct {
			Kind ActionKind `json:"kind"`
		}
		if err := decodeStrict(data, &v); err != nil {
			return fmt.Errorf("%w: %s action", ErrInvalidContract, probe.Kind)
		}
	case ActionAcceptDraw, ActionAcceptTakeback:
		var v struct {
			Kind    ActionKind `json:"kind"`
			OfferID string     `json:"offerId"`
		}
		if err := decodeStrict(data, &v); err != nil {
			return fmt.Errorf("%w: %s action", ErrInvalidContract, probe.Kind)
		}
		a.AcceptOffer = &AcceptOfferAction{OfferID: v.OfferID}
	case ActionSetControl:
		var v struct {
			Kind    ActionKind  `json:"kind"`
			Control SeatControl `json:"control"`
		}
		if err := decodeStrict(data, &v); err != nil {
			return fmt.Errorf("%w: set_control action", ErrInvalidContract)
		}
		a.SetControl = &SetControlAction{Control: v.Control}
	case ActionOfferTakeback:
		var v struct {
			Kind          ActionKind `json:"kind"`
			TargetVersion int64      `json:"targetVersion"`
		}
		if err := decodeStrict(data, &v); err != nil {
			return fmt.Errorf("%w: offer_takeback action", ErrInvalidContract)
		}
		a.OfferTakeback = &OfferTakebackAction{TargetVersion: v.TargetVersion}
	case ActionRecordRecoveryAttempt:
		var v struct {
			Kind    ActionKind          `json:"kind"`
			Attempt RecoveryAttemptKind `json:"attempt"`
		}
		if err := decodeStrict(data, &v); err != nil {
			return fmt.Errorf("%w: record_recovery_attempt action", ErrInvalidContract)
		}
		a.Recovery = &RecordRecoveryAttemptAction{Attempt: v.Attempt}
	case ActionRemovePublicReplay:
		var v struct {
			Kind   ActionKind `json:"kind"`
			Reason string     `json:"reason"`
		}
		if err := decodeStrict(data, &v); err != nil {
			return fmt.Errorf("%w: remove_public_replay action", ErrInvalidContract)
		}
		a.RemoveReplay = &RemovePublicReplayAction{Reason: v.Reason}
	default:
		return fmt.Errorf("%w: unknown action kind %q", ErrInvalidContract, probe.Kind)
	}
	return a.Validate()
}

func (a Action) Validate() error {
	set := 0
	if a.CreateMatch != nil {
		set++
	}
	if a.SubmitMove != nil {
		set++
	}
	if a.SetControl != nil {
		set++
	}
	if a.RemoveReplay != nil {
		set++
	}
	if a.OfferTakeback != nil {
		set++
	}
	if a.AcceptOffer != nil {
		set++
	}
	if a.Recovery != nil {
		set++
	}
	switch a.Kind {
	case ActionResign, ActionCancel, ActionOfferDraw:
		if set != 0 {
			return fmt.Errorf("%w: %s carries no payload", ErrInvalidContract, a.Kind)
		}
		return nil
	case ActionAcceptDraw, ActionAcceptTakeback:
		// The acceptance names the exact offer it consents to.
		if set != 1 || a.AcceptOffer == nil {
			return fmt.Errorf("%w: %s offer identity", ErrInvalidContract, a.Kind)
		}
		if !idPattern.MatchString(a.AcceptOffer.OfferID) {
			return fmt.Errorf("%w: %s offer id", ErrInvalidContract, a.Kind)
		}
		return nil
	case ActionCreateMatch:
		if set != 1 || a.CreateMatch == nil {
			return fmt.Errorf("%w: create_match payload", ErrInvalidContract)
		}
		return a.CreateMatch.Validate()
	case ActionSubmitMove:
		if set != 1 || a.SubmitMove == nil {
			return fmt.Errorf("%w: submit_move payload", ErrInvalidContract)
		}
		if !uciPattern.MatchString(a.SubmitMove.UCI) {
			return fmt.Errorf("%w: move must be lower-case UCI", ErrInvalidContract)
		}
		return nil
	case ActionSetControl:
		if set != 1 || a.SetControl == nil {
			return fmt.Errorf("%w: set_control payload", ErrInvalidContract)
		}
		return a.SetControl.Control.Validate()
	case ActionOfferTakeback:
		if set != 1 || a.OfferTakeback == nil {
			return fmt.Errorf("%w: offer_takeback payload", ErrInvalidContract)
		}
		if a.OfferTakeback.TargetVersion < 1 {
			return fmt.Errorf("%w: takeback target version", ErrInvalidContract)
		}
		return nil
	case ActionRecordRecoveryAttempt:
		if set != 1 || a.Recovery == nil {
			return fmt.Errorf("%w: record_recovery_attempt payload", ErrInvalidContract)
		}
		switch a.Recovery.Attempt {
		case RecoveryIllegalMove, RecoveryFormattingCorrection:
			return nil
		default:
			return fmt.Errorf("%w: recovery attempt kind", ErrInvalidContract)
		}
	case ActionRemovePublicReplay:
		if set != 1 || a.RemoveReplay == nil {
			return fmt.Errorf("%w: remove_public_replay payload", ErrInvalidContract)
		}
		switch a.RemoveReplay.Reason {
		case "owner_request", "erasure_request":
			return nil
		default:
			return fmt.Errorf("%w: replay removal reason", ErrInvalidContract)
		}
	default:
		return fmt.Errorf("%w: unknown action kind %q", ErrInvalidContract, a.Kind)
	}
}

func (s CreateMatchSetup) Validate() error {
	if s.Variant != "orthodox" {
		return fmt.Errorf("%w: variant", ErrInvalidContract)
	}
	if !fenShape(s.StartingFEN) {
		return fmt.Errorf("%w: starting fen", ErrInvalidContract)
	}
	if _, ok := fenSideToMove(s.StartingFEN); !ok {
		return fmt.Errorf("%w: starting fen side to move", ErrInvalidContract)
	}
	if s.TimeControl.StartingTimeMs < 1 || s.TimeControl.StartingTimeMs > 86_400_000 ||
		s.TimeControl.IncrementMs < 0 || s.TimeControl.IncrementMs > 60_000 {
		return fmt.Errorf("%w: time control", ErrInvalidContract)
	}
	if err := s.Seats.White.Validate(); err != nil {
		return err
	}
	if err := s.Seats.Black.Validate(); err != nil {
		return err
	}
	if s.Seats.White.Participant == s.Seats.Black.Participant {
		return fmt.Errorf("%w: both seats belong to the same participant", ErrInvalidContract)
	}
	return nil
}

func (s CreateSeat) Validate() error {
	if err := s.Participant.Validate(); err != nil {
		return err
	}
	if !publicLabelShape(s.PublicLabel) {
		return fmt.Errorf("%w: public label", ErrInvalidContract)
	}
	return s.Control.Validate()
}

func (p ParticipantRef) Validate() error {
	if p.Kind != ParticipantAccount && p.Kind != ParticipantGuest {
		return fmt.Errorf("%w: participant kind", ErrInvalidArgument)
	}
	if p.ID == "" || len(p.ID) > 128 || strings.ContainsAny(p.ID, "\x00\r\n") {
		return fmt.Errorf("%w: participant id", ErrInvalidArgument)
	}
	return nil
}

func (c SeatControl) Validate() error {
	switch c.Kind {
	case ControlHuman:
		if c.ModelLabel != nil {
			return fmt.Errorf("%w: human control cannot declare a model", ErrInvalidContract)
		}
		return nil
	case ControlAgent, ControlEngine:
		if c.ModelLabel == nil || !publicLabelShape(*c.ModelLabel) {
			return fmt.Errorf("%w: declared model public label", ErrInvalidContract)
		}
		return nil
	default:
		return fmt.Errorf("%w: control kind", ErrInvalidContract)
	}
}

type Command struct {
	SchemaVersion   int    `json:"schemaVersion"`
	MatchID         string `json:"matchId"`
	OperationID     string `json:"operationId"`
	ExpectedVersion int64  `json:"expectedVersion"`
	Seat            Seat   `json:"seat"`
	ControlEpoch    int64  `json:"controlEpoch"`
	Action          Action `json:"action"`
}

// ParseCommand decodes a strict command envelope. Unknown fields, trailing
// data, unknown action payloads, and contract violations are rejected.
func ParseCommand(raw []byte) (Command, error) {
	var c Command
	if err := decodeStrict(raw, &c); err != nil {
		return Command{}, fmt.Errorf("%w: command envelope: %v", ErrInvalidContract, err)
	}
	if err := c.Validate(); err != nil {
		return Command{}, err
	}
	return c, nil
}

func (c Command) Validate() error {
	if c.SchemaVersion != ContractsSchemaVersion {
		return fmt.Errorf("%w: command schema version", ErrInvalidContract)
	}
	if !idPattern.MatchString(c.MatchID) || !idPattern.MatchString(c.OperationID) {
		return fmt.Errorf("%w: match or operation id", ErrInvalidContract)
	}
	if c.ExpectedVersion < 0 {
		return fmt.Errorf("%w: expected version", ErrInvalidContract)
	}
	if c.Seat != SeatWhite && c.Seat != SeatBlack {
		return fmt.Errorf("%w: seat", ErrInvalidContract)
	}
	if c.ControlEpoch < 1 {
		return fmt.Errorf("%w: control epoch", ErrInvalidContract)
	}
	if err := c.Action.Validate(); err != nil {
		return err
	}
	if c.Action.Kind == ActionCreateMatch {
		if c.ExpectedVersion != 0 {
			return fmt.Errorf("%w: create_match expects version 0", ErrInvalidContract)
		}
		setup := c.Action.CreateMatch
		creator := setup.Seats.White.Participant
		if c.Seat == SeatBlack {
			creator = setup.Seats.Black.Participant
		}
		if creator.Kind == "" {
			return fmt.Errorf("%w: creator seat", ErrInvalidContract)
		}
	}
	if c.Action.Kind != ActionCreateMatch && c.ExpectedVersion < 1 {
		return fmt.Errorf("%w: expected version", ErrInvalidContract)
	}
	return nil
}

type ReceiptOutcome string

const (
	OutcomeAccepted        ReceiptOutcome = "accepted"
	OutcomeDeadlineExpired ReceiptOutcome = "deadline_expired"
	OutcomeReplayRemoved   ReceiptOutcome = "replay_removed"
	// OutcomeOpeningExpired marks the unscored abort that follows an
	// unanswered opening reply.
	OutcomeOpeningExpired ReceiptOutcome = "opening_expired"
)

// Receipt is the durable, payload-free outcome of one accepted operation.
// Identical retries return the original stored bytes unchanged.
type Receipt struct {
	SchemaVersion int            `json:"schemaVersion"`
	MatchID       string         `json:"matchId"`
	OperationID   string         `json:"operationId"`
	Outcome       ReceiptOutcome `json:"outcome"`
	Version       int64          `json:"version"`
	ControlEpoch  int64          `json:"controlEpoch"`
	DecidedAt     time.Time      `json:"decidedAt"`
	Event         *Event         `json:"event,omitempty"`
	Result        *Result        `json:"result,omitempty"`
}

type CommandResult struct {
	Receipt   Receipt
	Raw       []byte
	Duplicate bool
}

// RulesInput is the versioned, private input sent to the rules process. It has
// no provider credentials, conversation, private endpoint, or owner archive.
type RulesInput struct {
	SchemaVersion      int         `json:"schemaVersion"`
	RulesPolicyVersion string      `json:"rulesPolicyVersion"`
	MatchID            string      `json:"matchId"`
	Version            int64       `json:"version"`
	ControlEpoch       int64       `json:"controlEpoch"`
	InputHash          string      `json:"inputHash"`
	StartingFEN        string      `json:"startingFen"`
	PositionFEN        string      `json:"positionFen"`
	ProposedMove       string      `json:"proposedMove,omitempty"`
	TimeControl        TimeControl `json:"timeControl"`
	Moves              []Move      `json:"moves"`
	ActiveSeat         *Seat       `json:"activeSeat"`
}

// Candidate is the worker's deterministic evaluation. Go accepts it only when
// it was evaluated against the currently locked version, input hash, and
// control epoch.
type Candidate struct {
	SchemaVersion      int     `json:"schemaVersion"`
	EvaluatedVersion   int64   `json:"evaluatedVersion"`
	EvaluatedInputHash string  `json:"evaluatedInputHash"`
	ControlEpoch       int64   `json:"controlEpoch"`
	Move               *Move   `json:"move,omitempty"`
	Result             *Result `json:"result,omitempty"`
}

func (c Candidate) Validate() error {
	if c.SchemaVersion != RulesInputSchemaVersion {
		return fmt.Errorf("%w: candidate schema version", ErrInvalidContract)
	}
	if c.Move == nil {
		return fmt.Errorf("%w: candidate move", ErrInvalidContract)
	}
	if len(c.EvaluatedInputHash) != 64 || !isLowerHex(c.EvaluatedInputHash) {
		return fmt.Errorf("%w: candidate input hash", ErrInvalidContract)
	}
	if c.Move.Seat != SeatWhite && c.Move.Seat != SeatBlack {
		return fmt.Errorf("%w: candidate seat", ErrInvalidContract)
	}
	if !uciPattern.MatchString(c.Move.UCI) || !sanShape(c.Move.SAN) || !fenShape(c.Move.ResultingFEN) {
		return fmt.Errorf("%w: candidate move shape", ErrInvalidContract)
	}
	opponent, _ := c.Move.Seat.Other()
	if side, ok := fenSideToMove(c.Move.ResultingFEN); !ok || side != opponent {
		return fmt.Errorf("%w: candidate resulting position must leave the opponent to move", ErrInvalidContract)
	}
	if c.Result != nil {
		if err := c.Result.Validate(); err != nil {
			return err
		}
		if err := validateMoveResult(c.Move.Seat, *c.Result); err != nil {
			return err
		}
	}
	return nil
}

// validateMoveResult constrains a result produced by an accepted move: a mate
// can only be delivered to the opponent, and resignation, timeout, abandonment,
// agreement, and abort outcomes can never arise from a legal move.
func validateMoveResult(mover Seat, result Result) error {
	_, ok := mover.Other()
	if !ok {
		return fmt.Errorf("%w: move seat", ErrInvalidContract)
	}
	switch result.Kind {
	case ResultWin:
		if result.Reason != ReasonCheckmate || result.Winner == nil || *result.Winner != mover {
			return fmt.Errorf("%w: a move can only win by checkmating the opponent", ErrInvalidContract)
		}
		return nil
	case ResultDraw:
		switch result.Reason {
		case ReasonStalemate, ReasonRepetition, ReasonFiftyMove, ReasonInsufficientMaterial:
			return nil
		default:
			return fmt.Errorf("%w: invalid draw reason %q from a move", ErrInvalidContract, result.Reason)
		}
	default:
		return fmt.Errorf("%w: a move cannot produce a %q result", ErrInvalidContract, result.Kind)
	}
}

// TimeoutFacts is the trusted rules process's bounded adjudication of a flag
// fall. Winner is nil when the position has insufficient mating material, which
// is a draw rather than a manufactured win. The facts are bound to the evaluated
// rules input so the writer can reject them after any concurrent change.
type TimeoutFacts struct {
	SchemaVersion      int    `json:"schemaVersion"`
	EvaluatedVersion   int64  `json:"evaluatedVersion"`
	EvaluatedInputHash string `json:"evaluatedInputHash"`
	ControlEpoch       int64  `json:"controlEpoch"`
	ExpiredSeat        Seat   `json:"expiredSeat"`
	Winner             *Seat  `json:"winner"`
}

func (f TimeoutFacts) Validate() error {
	if f.SchemaVersion != RulesInputSchemaVersion {
		return fmt.Errorf("%w: timeout facts schema version", ErrInvalidContract)
	}
	if f.EvaluatedVersion < 1 {
		return fmt.Errorf("%w: timeout facts version", ErrInvalidContract)
	}
	if len(f.EvaluatedInputHash) != 64 || !isLowerHex(f.EvaluatedInputHash) {
		return fmt.Errorf("%w: timeout facts input hash", ErrInvalidContract)
	}
	if f.ControlEpoch < 1 {
		return fmt.Errorf("%w: timeout facts control epoch", ErrInvalidContract)
	}
	if f.ExpiredSeat != SeatWhite && f.ExpiredSeat != SeatBlack {
		return fmt.Errorf("%w: timeout facts expired seat", ErrInvalidContract)
	}
	if f.Winner != nil {
		if *f.Winner != SeatWhite && *f.Winner != SeatBlack {
			return fmt.Errorf("%w: timeout facts winner", ErrInvalidContract)
		}
		// A flag fall can never be awarded to the side that flagged.
		if *f.Winner == f.ExpiredSeat {
			return fmt.Errorf("%w: timeout cannot win for the flagged seat", ErrInvalidContract)
		}
	}
	return nil
}

// Result converts validated facts into the terminal match result. A draw
// adjudication is always an insufficient-material draw.
func (f TimeoutFacts) Result() *Result {
	if f.Winner == nil {
		return &Result{Kind: ResultDraw, Reason: ReasonInsufficientMaterial}
	}
	winner := *f.Winner
	return &Result{Kind: ResultWin, Winner: &winner, Reason: ReasonTimeout}
}

type Evaluator interface {
	// ValidateSetup checks an unstarted position through the pinned rules policy.
	// Invalid FEN/counters return ErrInvalidContract; terminal starting positions
	// return ErrActionNotAllowed. The writer must not create either kind of match.
	ValidateSetup(ctx context.Context, input RulesInput) error
	Evaluate(ctx context.Context, input RulesInput) (Candidate, error)
}

// TimeoutEvaluator is the optional rules seam for a flag fall. It must apply the
// same bounded material and one-ply policy as normal rules evaluation. Without
// it the writer fails closed with ErrTimeoutPolicyUnavailable rather than
// awarding a win the policy has not established.
type TimeoutEvaluator interface {
	EvaluateTimeout(ctx context.Context, input RulesInput, expired Seat) (TimeoutFacts, error)
}

type PublicParticipant struct {
	Seat        Seat        `json:"seat"`
	PublicLabel string      `json:"publicLabel"`
	Control     SeatControl `json:"control"`
}

type PublicMove struct {
	Version int64  `json:"version"`
	Seat    Seat   `json:"seat"`
	UCI     string `json:"uci"`
	SAN     string `json:"san"`
}

// PublicProjection is the allowlisted, shareable view of a completed match. It
// intentionally has no owner IDs, operation IDs, private routes, credentials,
// conversation, raw provider data, or archive references.
type PublicProjection struct {
	SchemaVersion      int                 `json:"schemaVersion"`
	MatchID            string              `json:"matchId"`
	Variant            string              `json:"variant"`
	StartingFEN        string              `json:"startingFen"`
	TimeControl        TimeControl         `json:"timeControl"`
	Participants       []PublicParticipant `json:"participants"`
	Moves              []PublicMove        `json:"moves"`
	Result             Result              `json:"result"`
	RulesPolicyVersion string              `json:"rulesPolicyVersion"`
	CompletedAt        time.Time           `json:"completedAt"`
}

type QueueStatus string

const (
	QueueWaiting   QueueStatus = "waiting"
	QueueCancelled QueueStatus = "cancelled"
	QueueAssigned  QueueStatus = "assigned"
)

type QueueEntry struct {
	SchemaVersion   int            `json:"schemaVersion"`
	EntryID         string         `json:"entryId"`
	Owner           ParticipantRef `json:"owner"`
	Control         SeatControl    `json:"control"`
	TimeControl     TimeControl    `json:"timeControl"`
	Status          QueueStatus    `json:"status"`
	Version         int64          `json:"version"`
	ReadyAt         *time.Time     `json:"readyAt"`
	CutoffAt        *time.Time     `json:"cutoffAt"`
	AssignedMatchID *string        `json:"assignedMatchId"`
	CreatedAt       time.Time      `json:"createdAt"`
	UpdatedAt       time.Time      `json:"updatedAt"`
}

type LeaseStatus string

const (
	LeaseActive  LeaseStatus = "active"
	LeaseRevoked LeaseStatus = "revoked"
	LeaseExpired LeaseStatus = "expired"
)

type RunnerLease struct {
	SchemaVersion int         `json:"schemaVersion"`
	LeaseID       string      `json:"leaseId"`
	MatchID       string      `json:"matchId"`
	Seat          Seat        `json:"seat"`
	ControlEpoch  int64       `json:"controlEpoch"`
	Generation    int64       `json:"generation"`
	RunnerID      string      `json:"runnerId"`
	Status        LeaseStatus `json:"status"`
	AcquiredAt    time.Time   `json:"acquiredAt"`
	ExpiresAt     time.Time   `json:"expiresAt"`
	RevokedAt     *time.Time  `json:"revokedAt"`
}

type DeletionMarker struct {
	SchemaVersion int       `json:"schemaVersion"`
	MarkerID      string    `json:"markerId"`
	Kind          string    `json:"kind"`
	SubjectKind   string    `json:"subjectKind"`
	SubjectID     string    `json:"subjectId"`
	MatchID       *string   `json:"matchId"`
	Reason        string    `json:"reason"`
	RequestedAt   time.Time `json:"requestedAt"`
	AppliedAt     time.Time `json:"appliedAt"`
}

var (
	idPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$`)
	uciPattern = regexp.MustCompile(`^[a-h][1-8][a-h][1-8][qrbn]?$`)
)

func fenShape(fen string) bool {
	if len(fen) < 4 || len(fen) > 128 {
		return false
	}
	for _, r := range fen {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return strings.Count(fen, " ") >= 5
}

func publicLabelShape(label string) bool {
	if label == "" || len(label) > 64 || strings.TrimSpace(label) != label {
		return false
	}
	for _, r := range label {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	// Public labels are chosen names, not email addresses or URLs. This blocks
	// accidental publication of Clerk emails and private endpoints.
	return !strings.Contains(label, "@") && !strings.Contains(label, "://")
}

func sanShape(san string) bool {
	if len(san) == 0 || len(san) > 16 {
		return false
	}
	for _, r := range san {
		if !((r >= 'a' && r <= 'h') || (r >= 'A' && r <= 'Z') ||
			(r >= '1' && r <= '8') || strings.ContainsRune("=+#x-O", r)) {
			return false
		}
	}
	return true
}

func isLowerHex(value string) bool {
	for _, r := range value {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}

func decodeStrict(raw []byte, dst any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		if err == nil {
			return fmt.Errorf("trailing data")
		}
		return err
	}
	return nil
}

// CommandFingerprint hashes the authenticated intent, including the actor and
// the typed action, so a changed payload or a different participant reusing an
// operation ID is detected.
func CommandFingerprint(actor ParticipantRef, c Command) ([32]byte, error) {
	if err := actor.Validate(); err != nil {
		return [32]byte{}, err
	}
	if err := c.Validate(); err != nil {
		return [32]byte{}, err
	}
	action, err := json.Marshal(c.Action)
	if err != nil {
		return [32]byte{}, err
	}
	type payload struct {
		SchemaVersion   int             `json:"schemaVersion"`
		MatchID         string          `json:"matchId"`
		OperationID     string          `json:"operationId"`
		ExpectedVersion int64           `json:"expectedVersion"`
		Seat            Seat            `json:"seat"`
		ControlEpoch    int64           `json:"controlEpoch"`
		Actor           ParticipantRef  `json:"actor"`
		Action          json.RawMessage `json:"action"`
	}
	raw, err := json.Marshal(payload{
		SchemaVersion:   c.SchemaVersion,
		MatchID:         c.MatchID,
		OperationID:     c.OperationID,
		ExpectedVersion: c.ExpectedVersion,
		Seat:            c.Seat,
		ControlEpoch:    c.ControlEpoch,
		Actor:           actor,
		Action:          action,
	})
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(raw), nil
}

func hashHex(hash [32]byte) string { return hex.EncodeToString(hash[:]) }
