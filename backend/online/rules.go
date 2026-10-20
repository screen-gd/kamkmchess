package online

import (
	"crypto/sha256"
	"encoding/json"
	"strings"
	"time"
)

func InitialClock(tc TimeControl) ClockState {
	return ClockState{
		WhiteMs: tc.StartingTimeMs,
		BlackMs: tc.StartingTimeMs,
	}
}

// ApplyAcceptedMove settles the clocks for one accepted move.
//
// The opening of a match is a distinct phase. Before the first accepted move
// no clock runs at all. That first accepted move does not start the other
// side's main clock either: it arms a 15 second reply window instead. The
// responder's accepted reply closes the window, and only then does the main
// clock of the side to move start. Every accepted move adds the configured
// increment exactly once, including the opening move.
//
// The mover's own bank is charged for the time that ran before this
// decision. A bank that never started running is never charged.
func ApplyAcceptedMove(clock ClockState, tc TimeControl, seat Seat, decision time.Time, terminal bool) ClockState {
	next := chargeActiveClock(clock, decision)
	next.setBank(seat, next.Bank(seat)+tc.IncrementMs)
	next.setMoved(seat)
	next.TurnNumber++
	if terminal {
		return stopClock(next)
	}
	opponent, ok := seat.Other()
	if !ok {
		return stopClock(next)
	}
	switch {
	case clock.AwaitingOpeningReply():
		// The responder answered inside the window. The window closes and the
		// side to move starts its main clock.
		next.ReplySeat = nil
		next.ReplyDeadlineAt = nil
		next.armMainClock(opponent, decision)
	case clock.ActiveSeat == nil:
		// The opening move. No main clock runs yet.
		next.armReplyWindow(opponent, decision)
	default:
		next.armMainClock(opponent, decision)
	}
	return next
}

// takebacksAllowed reports whether the match left the opening exchange.
//
// A takeback needs a completed opening exchange, so the fifteen second reply
// window, its deadline and the first-move flags of a match are never touched
// by a takeback request. The flags are historical: a takeback that restores
// the starting position does not reopen the opening phase.
func takebacksAllowed(clock ClockState) bool {
	return clock.Moved(SeatWhite) && clock.Moved(SeatBlack)
}

// armMainClock starts one side's main clock from the authoritative decision
// time. The deadline is absolute, so a later decision charges the whole
// elapsed time at once.
func (c *ClockState) armMainClock(seat Seat, decision time.Time) {
	since := decision.UTC()
	deadline := since.Add(time.Duration(c.Bank(seat)) * time.Millisecond)
	c.ActiveSeat = &seat
	c.ActiveSince = &since
	c.DeadlineAt = &deadline
}

// armReplyWindow starts the opening reply window instead of a main clock.
func (c *ClockState) armReplyWindow(seat Seat, decision time.Time) {
	since := decision.UTC()
	deadline := since.Add(time.Duration(OpeningReplyWindowMs) * time.Millisecond)
	c.ActiveSeat = nil
	c.ActiveSince = nil
	c.DeadlineAt = nil
	c.ReplySeat = &seat
	c.ReplyDeadlineAt = &deadline
}

// stopClock clears every armed deadline. It ends the match's clocks without
// changing the banks.
func stopClock(clock ClockState) ClockState {
	clock.ActiveSeat = nil
	clock.ActiveSince = nil
	clock.DeadlineAt = nil
	clock.ReplySeat = nil
	clock.ReplyDeadlineAt = nil
	return clock
}

// chargeActiveClock settles only elapsed playing time, without adding an
// increment or changing the turn. Both move and non-move endings use it.
func chargeActiveClock(clock ClockState, decision time.Time) ClockState {
	if clock.ActiveSeat != nil && clock.ActiveSince != nil {
		elapsed := max(int64(0), decision.Sub(*clock.ActiveSince).Milliseconds())
		bank := clock.Bank(*clock.ActiveSeat) - elapsed
		if clock.IsExpired(decision) {
			bank = 0
		}
		clock.setBank(*clock.ActiveSeat, bank)
	}
	return clock
}

func (c *ClockState) setBank(seat Seat, value int64) {
	if value < 0 {
		value = 0
	}
	switch seat {
	case SeatWhite:
		c.WhiteMs = value
	case SeatBlack:
		c.BlackMs = value
	}
}

func (c *ClockState) setMoved(seat Seat) {
	switch seat {
	case SeatWhite:
		c.WhiteMoved = true
	case SeatBlack:
		c.BlackMoved = true
	}
}

func BuildRulesInput(match Match, moves []Move, proposedMove string) RulesInput {
	if moves == nil {
		moves = []Move{}
	}
	in := RulesInput{
		SchemaVersion:      RulesInputSchemaVersion,
		RulesPolicyVersion: match.RulesPolicyVersion,
		MatchID:            match.MatchID,
		Version:            match.Version,
		ControlEpoch:       match.ControlEpoch,
		StartingFEN:        match.StartingFEN,
		PositionFEN:        match.PositionFEN,
		ProposedMove:       proposedMove,
		TimeControl:        match.TimeControl,
		Moves:              moves,
		ActiveSeat:         match.Clock.ActiveSeat,
	}
	in.InputHash = RulesInputHash(in)
	return in
}

// RulesInputHash covers every rule-relevant field plus the match version and
// control epoch. A candidate evaluated against any other value is rejected.
func RulesInputHash(in RulesInput) string {
	type payload struct {
		SchemaVersion      int         `json:"schemaVersion"`
		RulesPolicyVersion string      `json:"rulesPolicyVersion"`
		MatchID            string      `json:"matchId"`
		Version            int64       `json:"version"`
		ControlEpoch       int64       `json:"controlEpoch"`
		StartingFEN        string      `json:"startingFen"`
		PositionFEN        string      `json:"positionFen"`
		ProposedMove       string      `json:"proposedMove,omitempty"`
		TimeControl        TimeControl `json:"timeControl"`
		Moves              []Move      `json:"moves"`
		ActiveSeat         *Seat       `json:"activeSeat"`
	}
	if in.Moves == nil {
		in.Moves = []Move{}
	}
	raw, err := json.Marshal(payload{
		SchemaVersion:      in.SchemaVersion,
		RulesPolicyVersion: in.RulesPolicyVersion,
		MatchID:            in.MatchID,
		Version:            in.Version,
		ControlEpoch:       in.ControlEpoch,
		StartingFEN:        in.StartingFEN,
		PositionFEN:        in.PositionFEN,
		ProposedMove:       in.ProposedMove,
		TimeControl:        in.TimeControl,
		Moves:              in.Moves,
		ActiveSeat:         in.ActiveSeat,
	})
	if err != nil {
		// Fields are plain contract values; marshal cannot fail for validated input.
		panic("online: rules input marshal: " + err.Error())
	}
	hash := sha256.Sum256(raw)
	return hashHex(hash)
}

func ResultHash(result Result) ([32]byte, error) {
	if err := result.Validate(); err != nil {
		return [32]byte{}, err
	}
	raw, err := json.Marshal(result)
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(raw), nil
}

// fenSideToMove reads only the side-to-move field of a validated FEN. It carries
// no chess rules of its own: the rules process remains the sole legal-move and
// terminal-position authority, while the writer can still refuse a command for
// the seat that is not to move.
func fenSideToMove(fen string) (Seat, bool) {
	fields := strings.Fields(fen)
	if len(fields) < 6 {
		return "", false
	}
	switch fields[1] {
	case "w":
		return SeatWhite, true
	case "b":
		return SeatBlack, true
	default:
		return "", false
	}
}
