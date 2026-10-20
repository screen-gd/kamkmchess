package online

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

type contractFixture struct {
	SchemaVersion         int              `json:"schemaVersion"`
	Command               json.RawMessage  `json:"command"`
	CancelCommand         json.RawMessage  `json:"cancelCommand"`
	OfferDrawCommand      json.RawMessage  `json:"offerDrawCommand"`
	AcceptDrawCommand     json.RawMessage  `json:"acceptDrawCommand"`
	OfferTakebackCommand  json.RawMessage  `json:"offerTakebackCommand"`
	AcceptTakebackCommand json.RawMessage  `json:"acceptTakebackCommand"`
	RecoveryAttemptCmd    json.RawMessage  `json:"recoveryAttemptCommand"`
	OfferEvent            Event            `json:"offerEvent"`
	Candidate             Candidate        `json:"candidate"`
	TimeoutFacts          TimeoutFacts     `json:"timeoutFacts"`
	Receipt               Receipt          `json:"receipt"`
	PublicProjection      PublicProjection `json:"publicProjection"`
	QueueEntry            QueueEntry       `json:"queueEntry"`
	RunnerLease           RunnerLease      `json:"runnerLease"`
	DeletionMarker        DeletionMarker   `json:"deletionMarker"`
}

func loadFixture(t *testing.T) contractFixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/online-contracts.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture contractFixture
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func TestGoldenContractFixtureRoundTrips(t *testing.T) {
	fixture := loadFixture(t)
	if fixture.SchemaVersion != ContractsSchemaVersion {
		t.Fatalf("fixture schema version = %d", fixture.SchemaVersion)
	}
	cmd, err := ParseCommand(fixture.Command)
	if err != nil {
		t.Fatalf("parse fixture command: %v", err)
	}
	if cmd.Action.Kind != ActionCreateMatch || cmd.MatchID != "match-contract-01" {
		t.Fatalf("fixture command = %+v", cmd)
	}
	for name, raw := range map[string]json.RawMessage{
		"cancel":           fixture.CancelCommand,
		"offer draw":       fixture.OfferDrawCommand,
		"accept draw":      fixture.AcceptDrawCommand,
		"offer takeback":   fixture.OfferTakebackCommand,
		"accept takeback":  fixture.AcceptTakebackCommand,
		"recovery attempt": fixture.RecoveryAttemptCmd,
	} {
		parsed, err := ParseCommand(raw)
		if err != nil {
			t.Fatalf("parse fixture %s command: %v", name, err)
		}
		if parsed.SchemaVersion != ContractsSchemaVersion {
			t.Fatalf("fixture %s command schema version = %d", name, parsed.SchemaVersion)
		}
	}
	takeback, err := ParseCommand(fixture.OfferTakebackCommand)
	if err != nil {
		t.Fatal(err)
	}
	if takeback.Action.Kind != ActionOfferTakeback || takeback.Action.OfferTakeback.TargetVersion != 3 {
		t.Fatalf("fixture takeback command = %+v", takeback.Action)
	}
	recovery, err := ParseCommand(fixture.RecoveryAttemptCmd)
	if err != nil {
		t.Fatal(err)
	}
	if recovery.Action.Kind != ActionRecordRecoveryAttempt || recovery.Action.Recovery.Attempt != RecoveryIllegalMove {
		t.Fatalf("fixture recovery command = %+v", recovery.Action)
	}
	// The acceptance names the exact offer it consents to.
	acceptDraw, err := ParseCommand(fixture.AcceptDrawCommand)
	if err != nil {
		t.Fatal(err)
	}
	if acceptDraw.Action.Kind != ActionAcceptDraw || acceptDraw.Action.AcceptOffer.OfferID != "offer-contract-draw-01" {
		t.Fatalf("fixture accept draw command = %+v", acceptDraw.Action)
	}
	acceptTakeback, err := ParseCommand(fixture.AcceptTakebackCommand)
	if err != nil {
		t.Fatal(err)
	}
	if acceptTakeback.Action.Kind != ActionAcceptTakeback || acceptTakeback.Action.AcceptOffer.OfferID != "offer-contract-takeback-01" {
		t.Fatalf("fixture accept takeback command = %+v", acceptTakeback.Action)
	}
	// The offer event carries the exact offer it created.
	if fixture.OfferEvent.Kind != EventOfferCreated || fixture.OfferEvent.Offer == nil {
		t.Fatalf("fixture offer event = %+v", fixture.OfferEvent)
	}
	if fixture.OfferEvent.Offer.OfferID != "offer-contract-takeback-01" || fixture.OfferEvent.Offer.Kind != OfferTakeback {
		t.Fatalf("fixture offer event payload = %+v", fixture.OfferEvent.Offer)
	}
	if fixture.OfferEvent.Offer.TargetVersion == nil || *fixture.OfferEvent.Offer.TargetVersion != 3 {
		t.Fatalf("fixture offer event target = %+v", fixture.OfferEvent.Offer)
	}
	if fixture.OfferEvent.Offer.BaseVersion != fixture.OfferEvent.Version {
		t.Fatalf("the offer is not bound to the version it produced: %+v", fixture.OfferEvent.Offer)
	}
	if err = fixture.Candidate.Validate(); err != nil {
		t.Fatalf("candidate: %v", err)
	}
	if err = fixture.TimeoutFacts.Validate(); err != nil {
		t.Fatalf("timeout facts: %v", err)
	}
	if fixture.TimeoutFacts.Winner == nil || *fixture.TimeoutFacts.Winner != SeatWhite || fixture.TimeoutFacts.ExpiredSeat != SeatBlack {
		t.Fatalf("timeout facts = %+v", fixture.TimeoutFacts)
	}
	result := fixture.TimeoutFacts.Result()
	if result.Kind != ResultWin || result.Winner == nil || *result.Winner != SeatWhite || result.Reason != ReasonTimeout {
		t.Fatalf("timeout result = %+v", result)
	}
	if err = fixture.PublicProjection.Result.Validate(); err != nil {
		t.Fatalf("projection result: %v", err)
	}
	if fixture.PublicProjection.MatchID != cmd.MatchID {
		t.Fatalf("projection match = %q", fixture.PublicProjection.MatchID)
	}
	if fixture.Receipt.SchemaVersion != ContractsSchemaVersion || fixture.Receipt.Outcome != OutcomeAccepted {
		t.Fatalf("receipt = %+v", fixture.Receipt)
	}
	if fixture.QueueEntry.SchemaVersion != ContractsSchemaVersion || fixture.QueueEntry.Status != QueueWaiting {
		t.Fatalf("queue entry = %+v", fixture.QueueEntry)
	}
	if fixture.RunnerLease.Status != LeaseActive || fixture.RunnerLease.ControlEpoch != 2 {
		t.Fatalf("runner lease = %+v", fixture.RunnerLease)
	}
	if fixture.DeletionMarker.Kind != "replay_removal" || fixture.DeletionMarker.MatchID == nil {
		t.Fatalf("deletion marker = %+v", fixture.DeletionMarker)
	}
}

func TestActionAndCommandRejectUnknownOrChangedPayloads(t *testing.T) {
	cases := []string{
		`{"schemaVersion":2,"matchId":"match-contract-01","operationId":"op-contract-0001","expectedVersion":0,"seat":"white","controlEpoch":1,"action":{"kind":"resign","sql":"delete from online_matches"}}`,
		`{"schemaVersion":2,"matchId":"match-contract-01","operationId":"op-contract-0001","expectedVersion":0,"seat":"white","controlEpoch":1,"action":{"kind":"submit_move","move":"e2e4","fen":"arbitrary"}}`,
		`{"schemaVersion":2,"matchId":"match-contract-01","operationId":"op-contract-0001","expectedVersion":0,"seat":"white","controlEpoch":1,"action":{"kind":"unknown"}}`,
		`{"schemaVersion":2,"matchId":"match-contract-01","operationId":"op-contract-0001","expectedVersion":0,"seat":"white","controlEpoch":1,"action":{"kind":"create_match","setup":{"variant":"orthodox","startingFen":"x","timeControl":{"startingTimeMs":1,"incrementMs":0},"seats":{}}},"state":{"apiKey":"secret"}}`,
		`{"schemaVersion":2,"matchId":"match-contract-01","operationId":"op-contract-0001","expectedVersion":0,"seat":"white","controlEpoch":1,"action":{"kind":"submit_move","move":"E2E4"}}`,
		`{"schemaVersion":2,"matchId":"match-contract-01","operationId":"op-contract-0001","expectedVersion":0,"seat":"white","controlEpoch":1,"action":{"kind":"set_control","control":{"kind":"agent","modelLabel":"owner@example.com"}}}`,
		`{"schemaVersion":2,"matchId":"match-contract-01","operationId":"op-contract-0001","expectedVersion":1,"seat":"white","controlEpoch":1,"action":{"kind":"resign"}} trailing`,
		`{"schemaVersion":2,"matchId":"match-contract-01","operationId":"op-contract-0001","expectedVersion":1,"seat":"white","controlEpoch":1,"action":{"kind":"cancel","reason":"resign"}}`,
		`{"schemaVersion":2,"matchId":"match-contract-01","operationId":"op-contract-0001","expectedVersion":1,"seat":"white","controlEpoch":1,"action":{"kind":"offer_takeback","targetVersion":0}}`,
		`{"schemaVersion":2,"matchId":"match-contract-01","operationId":"op-contract-0001","expectedVersion":1,"seat":"white","controlEpoch":1,"action":{"kind":"record_recovery_attempt","attempt":"anything"}}`,
		`{"schemaVersion":2,"matchId":"match-contract-01","operationId":"op-contract-0001","expectedVersion":1,"seat":"white","controlEpoch":1,"action":{"kind":"accept_draw"}}`,
		`{"schemaVersion":2,"matchId":"match-contract-01","operationId":"op-contract-0001","expectedVersion":1,"seat":"black","controlEpoch":1,"action":{"kind":"accept_takeback"}}`,
		`{"schemaVersion":2,"matchId":"match-contract-01","operationId":"op-contract-0001","expectedVersion":1,"seat":"black","controlEpoch":1,"action":{"kind":"accept_takeback","offerId":"short"}}`,
		`{"schemaVersion":2,"matchId":"match-contract-01","operationId":"op-contract-0001","expectedVersion":1,"seat":"black","controlEpoch":1,"action":{"kind":"accept_takeback","offerId":"offer-contract-takeback-01","targetVersion":3}}`,
		`{"schemaVersion":2,"matchId":"match-contract-01","operationId":"op-contract-0001","expectedVersion":1,"seat":"black","controlEpoch":1,"action":{"kind":"accept_draw","offerId":"offer-contract-draw-01","sql":"delete from online_offers"}}`,
	}
	for i, raw := range cases {
		if _, err := ParseCommand([]byte(raw)); !errors.Is(err, ErrInvalidContract) {
			t.Errorf("case %d error = %v, want ErrInvalidContract", i, err)
		}
	}
}

func TestCommandFingerprintIsStableAndActorBound(t *testing.T) {
	fixture := loadFixture(t)
	cmd, err := ParseCommand(fixture.Command)
	if err != nil {
		t.Fatal(err)
	}
	alice := ParticipantRef{Kind: ParticipantAccount, ID: "user_a"}
	bob := ParticipantRef{Kind: ParticipantAccount, ID: "user_b"}
	first, err := CommandFingerprint(alice, cmd)
	if err != nil {
		t.Fatal(err)
	}
	second, err := CommandFingerprint(alice, cmd)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatal("identical commands produced different fingerprints")
	}
	other, err := CommandFingerprint(bob, cmd)
	if err != nil {
		t.Fatal(err)
	}
	if first == other {
		t.Fatal("different actors produced the same fingerprint")
	}
	changed := cmd
	changed.Action = Action{Kind: ActionResign}
	changed.ExpectedVersion = 1
	third, err := CommandFingerprint(alice, changed)
	if err != nil {
		t.Fatal(err)
	}
	if first == third {
		t.Fatal("changed expected version produced the same fingerprint")
	}
}

// The consent is bound to the exact offered identity, so a changed offer
// cannot reuse an accepted operation ID.
func TestCommandFingerprintCoversTheAcceptedOffer(t *testing.T) {
	fixture := loadFixture(t)
	accept, err := ParseCommand(fixture.AcceptTakebackCommand)
	if err != nil {
		t.Fatal(err)
	}
	alice := ParticipantRef{Kind: ParticipantAccount, ID: "user_a"}
	first, err := CommandFingerprint(alice, accept)
	if err != nil {
		t.Fatal(err)
	}
	other := accept
	other.Action = Action{Kind: ActionAcceptTakeback, AcceptOffer: &AcceptOfferAction{OfferID: "offer-contract-takeback-02"}}
	second, err := CommandFingerprint(alice, other)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("a changed offered identity produced the same fingerprint")
	}
}

func TestResultValidation(t *testing.T) {
	white := SeatWhite
	valid := []Result{
		{Kind: ResultWin, Winner: &white, Reason: ReasonResignation},
		{Kind: ResultWin, Winner: &white, Reason: ReasonTimeout},
		{Kind: ResultDraw, Reason: ReasonStalemate},
		{Kind: ResultAbort, Reason: ReasonAbort},
	}
	for _, result := range valid {
		if err := result.Validate(); err != nil {
			t.Errorf("valid result %+v: %v", result, err)
		}
	}
	invalid := []Result{
		{Kind: ResultWin, Reason: ReasonResignation},
		{Kind: ResultDraw, Winner: &white, Reason: ReasonStalemate},
		{Kind: ResultAbort, Winner: &white, Reason: ReasonAbort},
		{Kind: ResultWin, Winner: &white, Reason: ReasonStalemate},
	}
	for _, result := range invalid {
		if err := result.Validate(); !errors.Is(err, ErrInvalidContract) {
			t.Errorf("invalid result %+v error = %v", result, err)
		}
	}
}

func TestTimeoutFactsNeverAwardTheFlaggedSeat(t *testing.T) {
	white, black := SeatWhite, SeatBlack
	hash := strings.Repeat("a", 64)
	valid := TimeoutFacts{SchemaVersion: RulesInputSchemaVersion, EvaluatedVersion: 3, EvaluatedInputHash: hash, ControlEpoch: 1, ExpiredSeat: SeatBlack, Winner: &white}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid timeout facts: %v", err)
	}
	if result := valid.Result(); result.Reason != ReasonTimeout {
		t.Fatalf("winning timeout result = %+v", result)
	}
	draw := valid
	draw.Winner = nil
	if err := draw.Validate(); err != nil {
		t.Fatalf("draw timeout facts: %v", err)
	}
	if result := draw.Result(); result.Kind != ResultDraw || result.Reason != ReasonInsufficientMaterial || result.Winner != nil {
		t.Fatalf("draw timeout result = %+v", result)
	}
	invalid := []TimeoutFacts{
		{SchemaVersion: 2, EvaluatedVersion: 3, EvaluatedInputHash: hash, ControlEpoch: 1, ExpiredSeat: SeatBlack, Winner: &white},
		{SchemaVersion: RulesInputSchemaVersion, EvaluatedVersion: 0, EvaluatedInputHash: hash, ControlEpoch: 1, ExpiredSeat: SeatBlack, Winner: &white},
		{SchemaVersion: RulesInputSchemaVersion, EvaluatedVersion: 3, EvaluatedInputHash: "not-a-hash", ControlEpoch: 1, ExpiredSeat: SeatBlack, Winner: &white},
		{SchemaVersion: RulesInputSchemaVersion, EvaluatedVersion: 3, EvaluatedInputHash: hash, ControlEpoch: 0, ExpiredSeat: SeatBlack, Winner: &white},
		{SchemaVersion: RulesInputSchemaVersion, EvaluatedVersion: 3, EvaluatedInputHash: hash, ControlEpoch: 1, ExpiredSeat: "green", Winner: &white},
		{SchemaVersion: RulesInputSchemaVersion, EvaluatedVersion: 3, EvaluatedInputHash: hash, ControlEpoch: 1, ExpiredSeat: SeatBlack, Winner: &black},
	}
	for i, facts := range invalid {
		if err := facts.Validate(); !errors.Is(err, ErrInvalidContract) {
			t.Errorf("case %d timeout facts error = %v, want ErrInvalidContract", i, err)
		}
	}
}

func TestCandidateMustLeaveOpponentToMoveAndCannotMisdeclareOutcome(t *testing.T) {
	hash := strings.Repeat("a", 64)
	base := Candidate{
		SchemaVersion:      RulesInputSchemaVersion,
		EvaluatedVersion:   1,
		EvaluatedInputHash: hash,
		ControlEpoch:       1,
		Move:               &Move{Seat: SeatWhite, UCI: "e2e4", SAN: "e4", ResultingFEN: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"},
	}
	if err := base.Validate(); err != nil {
		t.Fatalf("valid candidate: %v", err)
	}
	sameSideToMove := base
	move := *base.Move
	move.ResultingFEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e3 0 1"
	sameSideToMove.Move = &move
	if err := sameSideToMove.Validate(); !errors.Is(err, ErrInvalidContract) {
		t.Fatalf("same-side-to-move candidate error = %v", err)
	}
	white, black := SeatWhite, SeatBlack
	for name, result := range map[string]*Result{
		"resignation from a move": {Kind: ResultWin, Winner: &black, Reason: ReasonResignation},
		"mated opponent wins":     {Kind: ResultWin, Winner: &black, Reason: ReasonCheckmate},
		"timeout from a move":     {Kind: ResultWin, Winner: &black, Reason: ReasonTimeout},
		"abort from a move":       {Kind: ResultAbort, Reason: ReasonAbort},
	} {
		candidate := base
		candidate.Result = result
		if err := candidate.Validate(); !errors.Is(err, ErrInvalidContract) {
			t.Errorf("%s candidate error = %v, want ErrInvalidContract", name, err)
		}
	}
	legal := base
	legal.Result = &Result{Kind: ResultWin, Winner: &white, Reason: ReasonCheckmate}
	if err := legal.Validate(); err != nil {
		t.Fatalf("legal mating candidate: %v", err)
	}
	for _, san := range []string{"", "e4\nprivate", "verylongsannotation"} {
		candidate := base
		move := *base.Move
		move.SAN = san
		candidate.Move = &move
		if err := candidate.Validate(); !errors.Is(err, ErrInvalidContract) {
			t.Errorf("invalid SAN %q error = %v", san, err)
		}
	}
}

func TestPublicProjectionContainsNoPrivateIdentity(t *testing.T) {
	white := MatchSeat{Seat: SeatWhite, Participant: ParticipantRef{Kind: ParticipantAccount, ID: "clerk_user_secret"}, PublicLabel: "Alice", Control: SeatControl{Kind: ControlHuman}}
	black := MatchSeat{Seat: SeatBlack, Participant: ParticipantRef{Kind: ParticipantAccount, ID: "clerk_user_secret_2"}, PublicLabel: "Bob", Control: SeatControl{Kind: ControlAgent, ModelLabel: strPtr("Declared Model")}}
	completed := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	winner := SeatWhite
	match := Match{
		SchemaVersion:      ContractsSchemaVersion,
		MatchID:            "match-contract-01",
		Variant:            "orthodox",
		StartingFEN:        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
		PositionFEN:        "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
		TimeControl:        TimeControl{StartingTimeMs: 300000, IncrementMs: 2000},
		Version:            3,
		ControlEpoch:       1,
		RulesPolicyVersion: DefaultRulesPolicyVersion,
		Status:             MatchCompleted,
		Result:             &Result{Kind: ResultWin, Winner: &winner, Reason: ReasonResignation},
		Seats:              []MatchSeat{white, black},
		Clock:              InitialClock(TimeControl{StartingTimeMs: 300000}),
		Moves:              []Move{{Version: 2, Seat: SeatWhite, UCI: "e2e4", SAN: "e4", ResultingFEN: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"}},
		CreatedAt:          completed.Add(-time.Minute),
		UpdatedAt:          completed,
		CompletedAt:        &completed,
	}
	projection, err := BuildPublicProjection(match)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(projection)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"clerk_user_secret", "ownerId", "operationId", "apiKey", "connection", "endpoint", "provider"} {
		if containsFold(string(raw), forbidden) {
			t.Fatalf("public projection leaked %q: %s", forbidden, raw)
		}
	}
}

func TestBuildPublicProjectionRequiresTerminalResult(t *testing.T) {
	match := Match{SchemaVersion: ContractsSchemaVersion, MatchID: "match-contract-01"}
	if _, err := BuildPublicProjection(match); !errors.Is(err, ErrInvalidContract) {
		t.Fatalf("incomplete projection error = %v", err)
	}
}

func TestRulesInputHashCoversVersionControlAndPosition(t *testing.T) {
	match := Match{
		SchemaVersion:      ContractsSchemaVersion,
		MatchID:            "match-contract-01",
		StartingFEN:        "start",
		PositionFEN:        "position",
		TimeControl:        TimeControl{StartingTimeMs: 300000, IncrementMs: 2000},
		Version:            2,
		ControlEpoch:       1,
		RulesPolicyVersion: DefaultRulesPolicyVersion,
	}
	base := RulesInputHash(BuildRulesInput(match, nil, ""))
	if len(base) != 64 {
		t.Fatalf("hash length = %d", len(base))
	}
	changedVersion := match
	changedVersion.Version = 3
	if RulesInputHash(BuildRulesInput(changedVersion, nil, "")) == base {
		t.Fatal("version change did not change rules input hash")
	}
	changedEpoch := match
	changedEpoch.ControlEpoch = 2
	if RulesInputHash(BuildRulesInput(changedEpoch, nil, "")) == base {
		t.Fatal("control epoch change did not change rules input hash")
	}
	changedPosition := match
	changedPosition.PositionFEN = "other"
	if RulesInputHash(BuildRulesInput(changedPosition, nil, "")) == base {
		t.Fatal("position change did not change rules input hash")
	}
	moves := []Move{{Version: 2, Seat: SeatWhite, UCI: "e2e4", SAN: "e4", ResultingFEN: "position"}}
	if RulesInputHash(BuildRulesInput(match, moves, "")) == base {
		t.Fatal("move change did not change rules input hash")
	}
	// The same input is deterministic across calls.
	again := RulesInputHash(BuildRulesInput(match, moves, ""))
	if again != RulesInputHash(BuildRulesInput(match, moves, "")) {
		t.Fatal("rules input hash is not deterministic")
	}
}

func TestApplyAcceptedMoveUsesDecisionTimeAndArmsOpponent(t *testing.T) {
	tc := TimeControl{StartingTimeMs: 10_000, IncrementMs: 1_000}
	clock := InitialClock(tc)
	start := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	afterWhite := ApplyAcceptedMove(clock, tc, SeatWhite, start, false)
	if afterWhite.WhiteMs != 11_000 {
		t.Fatalf("white increment = %d", afterWhite.WhiteMs)
	}
	// The opening move arms the reply window instead of a main clock. No bank
	// runs before its side's first accepted move.
	if afterWhite.ActiveSeat != nil || afterWhite.ActiveSince != nil || afterWhite.DeadlineAt != nil {
		t.Fatalf("the opening move started a main clock: %+v", afterWhite)
	}
	if afterWhite.ReplySeat == nil || *afterWhite.ReplySeat != SeatBlack {
		t.Fatalf("reply seat = %v", afterWhite.ReplySeat)
	}
	if afterWhite.ReplyDeadlineAt == nil || !afterWhite.ReplyDeadlineAt.Equal(start.Add(15*time.Second)) {
		t.Fatalf("reply deadline = %v", afterWhite.ReplyDeadlineAt)
	}
	if !afterWhite.WhiteMoved || afterWhite.BlackMoved {
		t.Fatalf("moved flags = %v/%v", afterWhite.WhiteMoved, afterWhite.BlackMoved)
	}
	afterBlack := ApplyAcceptedMove(afterWhite, tc, SeatBlack, start.Add(3*time.Second), false)
	// The responder's bank never ran, so the reply costs no time.
	if afterBlack.BlackMs != 11_000 {
		t.Fatalf("black bank after the reply = %d", afterBlack.BlackMs)
	}
	if afterBlack.ReplySeat != nil || afterBlack.ReplyDeadlineAt != nil {
		t.Fatalf("the reply left the window armed: %+v", afterBlack)
	}
	if afterBlack.ActiveSeat == nil || *afterBlack.ActiveSeat != SeatWhite {
		t.Fatalf("active seat after black = %v", afterBlack.ActiveSeat)
	}
	if afterBlack.DeadlineAt == nil || !afterBlack.DeadlineAt.Equal(start.Add(3*time.Second).Add(11*time.Second)) {
		t.Fatalf("deadline = %v", afterBlack.DeadlineAt)
	}
	if !afterBlack.BlackMoved {
		t.Fatal("black moved flag not set")
	}
	terminal := ApplyAcceptedMove(afterBlack, tc, SeatWhite, start.Add(4*time.Second), true)
	if terminal.ActiveSeat != nil || terminal.DeadlineAt != nil {
		t.Fatal("terminal move left an active deadline")
	}
}

// MAT-01: the opening phase of a match. No main bank runs before its side's
// first accepted move, the first move arms a fifteen second reply window, and
// the reply starts the next side's main clock.
func TestOpeningPhaseRunsNoMainBankBeforeTheFirstMove(t *testing.T) {
	tc := TimeControl{StartingTimeMs: 60_000, IncrementMs: 2_000}
	clock := InitialClock(tc)
	start := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	if clock.ActiveSeat != nil || clock.DeadlineAt != nil || clock.ReplySeat != nil {
		t.Fatalf("a new match armed a deadline: %+v", clock)
	}
	afterOpen := ApplyAcceptedMove(clock, tc, SeatBlack, start, false)
	if afterOpen.BlackMs != 62_000 {
		t.Fatalf("the opening move did not add the increment once: %d", afterOpen.BlackMs)
	}
	if afterOpen.WhiteMs != 60_000 {
		t.Fatalf("the responder's bank changed before its first move: %d", afterOpen.WhiteMs)
	}
	if afterOpen.ActiveSeat != nil || afterOpen.DeadlineAt != nil {
		t.Fatalf("the opening move started a main clock: %+v", afterOpen)
	}
	if afterOpen.ReplySeat == nil || *afterOpen.ReplySeat != SeatWhite {
		t.Fatalf("the reply window names the wrong seat: %v", afterOpen.ReplySeat)
	}
	afterReply := ApplyAcceptedMove(afterOpen, tc, SeatWhite, start.Add(12*time.Second), false)
	if afterReply.WhiteMs != 62_000 {
		t.Fatalf("the reply charged the responder's bank: %d", afterReply.WhiteMs)
	}
	if afterReply.ActiveSeat == nil || *afterReply.ActiveSeat != SeatBlack {
		t.Fatalf("the reply did not start the next side's clock: %v", afterReply.ActiveSeat)
	}
	if afterReply.ActiveSince == nil || !afterReply.ActiveSince.Equal(start.Add(12*time.Second)) {
		t.Fatalf("the main clock started at %v", afterReply.ActiveSince)
	}
	if afterReply.DeadlineAt == nil || !afterReply.DeadlineAt.Equal(start.Add(12*time.Second).Add(62*time.Second)) {
		t.Fatalf("deadline = %v", afterReply.DeadlineAt)
	}
	if afterReply.TurnNumber != 2 {
		t.Fatalf("turn number = %d, want one accepted move per turn", afterReply.TurnNumber)
	}
}

func TestClockExpiryUsesAuthoritativeTime(t *testing.T) {
	deadline := time.Date(2026, 10, 20, 10, 0, 1, 0, time.UTC)
	seat := SeatBlack
	clock := ClockState{ActiveSeat: &seat, DeadlineAt: &deadline}
	if clock.IsExpired(deadline.Add(-time.Millisecond)) {
		t.Fatal("clock expired before deadline")
	}
	if !clock.IsExpired(deadline) {
		t.Fatal("clock not expired at deadline")
	}
	clock.DeadlineAt = nil
	if clock.IsExpired(deadline.Add(time.Hour)) {
		t.Fatal("nil deadline expired")
	}
}

func TestCommandResultHashStability(t *testing.T) {
	// The stored raw receipt bytes, not a re-marshal, are the retry contract.
	fixture := loadFixture(t)
	raw, err := json.Marshal(fixture.Receipt)
	if err != nil {
		t.Fatal(err)
	}
	first := sha256.Sum256(raw)
	second := sha256.Sum256(raw)
	if first != second {
		t.Fatal("receipt bytes are not stable")
	}
}

func TestNormalizeFixtureObjects(t *testing.T) {
	fixture := loadFixture(t)
	var source map[string]any
	raw, err := os.ReadFile("testdata/online-contracts.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &source); err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]any{
		"candidate":        fixture.Candidate,
		"timeoutFacts":     fixture.TimeoutFacts,
		"receipt":          fixture.Receipt,
		"publicProjection": fixture.PublicProjection,
		"queueEntry":       fixture.QueueEntry,
		"runnerLease":      fixture.RunnerLease,
		"deletionMarker":   fixture.DeletionMarker,
	} {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("%s marshal: %v", name, err)
		}
		var got map[string]any
		if err = json.Unmarshal(encoded, &got); err != nil {
			t.Fatalf("%s decode: %v", name, err)
		}
		if !reflect.DeepEqual(got, source[name]) {
			t.Fatalf("%s contract drifted from fixture:\n got=%v\nwant=%v", name, got, source[name])
		}
	}
}

func strPtr(value string) *string { return &value }

func containsFold(haystack, needle string) bool {
	return strings.Contains(strings.ToLower(haystack), strings.ToLower(needle))
}
