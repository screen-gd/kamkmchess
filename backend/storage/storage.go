package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"reflect"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNotFound        = errors.New("storage: not found")
	ErrAlreadyExists   = errors.New("storage: already exists")
	ErrConflict        = errors.New("storage: revision or epoch conflict")
	ErrOperationReuse  = errors.New("storage: operation id reused")
	ErrInvalidDTO      = errors.New("storage: invalid DTO")
	ErrDeleted         = errors.New("storage: deleted")
	ErrInvalidArgument = errors.New("storage: invalid argument")
	ErrUnavailable     = errors.New("storage: unavailable")
)

type Store struct{ db *pgxpool.Pool }
type Game struct {
	ID             string     `json:"id"`
	OwnerID        string     `json:"ownerId"`
	Revision       int64      `json:"revision"`
	Epoch          int64      `json:"epoch"`
	CheckpointJSON []byte     `json:"checkpoint"`
	CreatedAt      time.Time  `json:"createdAt"`
	UpdatedAt      time.Time  `json:"updatedAt"`
	DeletedAt      *time.Time `json:"deletedAt,omitempty"`
}
type CreateGame struct {
	GameID         string
	CheckpointJSON []byte
}
type ArchiveChunk struct {
	Sequence int64
	RawJSON  []byte
	SHA256   string
}

// ArchiveEvent preserves the exact accepted versioned event DTO bytes.
type ArchiveEvent struct {
	Sequence int64
	RawJSON  []byte
}
type ArchiveSnapshot struct{ Chunks []ArchiveChunk }
type CommitRequest struct {
	GameID, OperationID             string
	ExpectedRevision, ExpectedEpoch int64
	CheckpointJSON                  []byte
	Archives                        []ArchiveChunk
	Events                          []ArchiveEvent
}
type CASRequest struct {
	GameID                          string
	ExpectedRevision, ExpectedEpoch int64
}
type Page struct {
	Limit int
	After string
}
type GamePage struct {
	Games []Game
	Next  string
}
type Operation struct {
	ID, GameID      string
	RequestHash     []byte
	Revision, Epoch int64
	AcceptedAt      time.Time
	ResultJSON      []byte
}
type CommitResult struct {
	Game      Game
	Operation Operation
	Duplicate bool
}

func Open(_ context.Context, db *pgxpool.Pool) (*Store, error) {
	if db == nil {
		return nil, ErrInvalidArgument
	}
	return &Store{db}, nil
}
func validateCheckpoint(raw []byte, gameID, owner string) error {
	if !validUniqueJSON(raw) {
		return ErrInvalidDTO
	}
	var v map[string]json.RawMessage
	d := json.NewDecoder(bytes.NewReader(raw))
	if err := d.Decode(&v); err != nil || v == nil {
		return ErrInvalidDTO
	}
	var extra any
	if d.Decode(&extra) == nil {
		return ErrInvalidDTO
	}
	keys := []string{"schemaVersion", "gameId", "namespace", "revision", "ownershipEpoch", "segmentId", "positionRevision", "requestGeneration", "analysisGeneration", "updatedAtMs", "rules", "history", "clocks", "budgets", "selections", "archive", "result", "practice", "extensions"}
	if len(v) != len(keys) {
		return ErrInvalidDTO
	}
	for _, k := range keys {
		if _, ok := v[k]; !ok {
			return ErrInvalidDTO
		}
	}
	var ver int
	var id string
	if json.Unmarshal(v["schemaVersion"], &ver) != nil || ver != 1 || json.Unmarshal(v["gameId"], &id) != nil || id != gameID {
		return ErrInvalidDTO
	}
	var ns struct {
		Kind      string `json:"kind"`
		AccountID string `json:"accountId"`
	}
	if json.Unmarshal(v["namespace"], &ns) != nil || ns.Kind != "account" || ns.AccountID != owner {
		return ErrInvalidDTO
	}
	var archive struct {
		EgressStatus string `json:"egressStatus"`
	}
	if json.Unmarshal(v["archive"], &archive) != nil || archive.EgressStatus != "eligible" {
		return ErrInvalidDTO
	}
	if !exactObjectKeys(v["archive"], []string{"egressStatus", "currentLine", "discardedLines"}) || !validResult(v["result"]) {
		return ErrInvalidDTO
	}
	if !validPractice(v["practice"]) || !validateCheckpointShape(v) {
		return ErrInvalidDTO
	}
	if !validCheckpointExtensions(v["extensions"]) {
		return ErrInvalidDTO
	}
	return nil
}

// Extension data belongs to the browser controller. Preserve versioned sections
// as opaque JSON, matching readExtensionSections, without interpreting them as
// server configuration. Credential-bearing fields must never enter storage.
func validCheckpointExtensions(raw json.RawMessage) bool {
	var sections map[string]json.RawMessage
	if json.Unmarshal(raw, &sections) != nil || sections == nil {
		return false
	}
	for _, section := range sections {
		if !exactObjectKeys(section, []string{"version", "data"}) {
			return false
		}
		var fields map[string]json.RawMessage
		if json.Unmarshal(section, &fields) != nil {
			return false
		}
		var version float64
		if json.Unmarshal(fields["version"], &version) != nil || version < 1 || version > 9007199254740991 || math.Trunc(version) != version {
			return false
		}
	}
	var value any
	return json.Unmarshal(raw, &value) == nil && !hasCredentialField(value)
}

var credentialField = regexp.MustCompile(`(?i)api.?key|authorization|access.?token|secret|credential`)

func hasCredentialField(value any) bool {
	switch value := value.(type) {
	case map[string]any:
		for key, nested := range value {
			if credentialField.MatchString(key) || hasCredentialField(nested) {
				return true
			}
		}
	case []any:
		for _, nested := range value {
			if hasCredentialField(nested) {
				return true
			}
		}
	}
	return false
}

func exactObjectKeys(raw json.RawMessage, keys []string) bool {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil || len(m) != len(keys) {
		return false
	}
	for _, k := range keys {
		if _, ok := m[k]; !ok {
			return false
		}
	}
	return true
}
func validResult(raw json.RawMessage) bool {
	var r map[string]json.RawMessage
	if json.Unmarshal(raw, &r) != nil {
		return false
	}
	var kind string
	if json.Unmarshal(r["kind"], &kind) != nil {
		return false
	}
	switch kind {
	case "unresolved":
		return exactObjectKeys(raw, []string{"kind"})
	case "pending-adjudication":
		if !exactObjectKeys(raw, []string{"kind", "reason", "eventId", "eventAtMs", "activeClockDeadlineMs"}) {
			return false
		}
		var x struct {
			Reason   string          `json:"reason"`
			EventID  string          `json:"eventId"`
			At       json.Number     `json:"eventAtMs"`
			Deadline json.RawMessage `json:"activeClockDeadlineMs"`
		}
		if json.Unmarshal(raw, &x) != nil || x.EventID == "" || !validFiniteNumber(x.At) || (string(x.Deadline) != "null" && !validFiniteNumber(json.Number(string(x.Deadline)))) {
			return false
		}
		return oneOf(x.Reason, "checkmate", "timeout", "dead-position", "threefold-repetition", "fifty-move-rule")
	case "final":
		if !exactObjectKeys(raw, []string{"kind", "winner", "reason", "eventId", "decidedAtMs"}) {
			return false
		}
		var x struct {
			Winner  string      `json:"winner"`
			Reason  string      `json:"reason"`
			EventID string      `json:"eventId"`
			At      json.Number `json:"decidedAtMs"`
		}
		if json.Unmarshal(raw, &x) != nil || x.EventID == "" || !validFiniteNumber(x.At) || !oneOf(x.Winner, "white", "black", "draw") || !oneOf(x.Reason, "checkmate", "timeout", "dead-position", "threefold-repetition", "fifty-move-rule", "resignation", "illegal-move", "stalemate", "draw-agreement") {
			return false
		}
		return (x.Reason != "stalemate" && x.Reason != "draw-agreement") || x.Winner == "draw"
	default:
		return false
	}
}

func validFiniteNumber(n json.Number) bool {
	f, e := n.Float64()
	return e == nil && !math.IsInf(f, 0) && !math.IsNaN(f)
}
func oneOf(v string, choices ...string) bool {
	for _, c := range choices {
		if v == c {
			return true
		}
	}
	return false
}
func validPractice(raw json.RawMessage) bool {
	if !exactObjectKeys(raw, []string{"mode", "scored", "sourceGameId", "sourcePositionFen", "originalResult"}) {
		return false
	}
	var p struct {
		Mode       string          `json:"mode"`
		Scored     *bool           `json:"scored"`
		SourceGame *string         `json:"sourceGameId"`
		SourceFen  *string         `json:"sourcePositionFen"`
		Original   json.RawMessage `json:"originalResult"`
	}
	if json.Unmarshal(raw, &p) != nil || !oneOf(p.Mode, "ordinary", "practice") || p.Scored == nil {
		return false
	}
	var x map[string]json.RawMessage
	if json.Unmarshal(raw, &x) != nil {
		return false
	}
	if !validNullableString(x["sourceGameId"]) || !validNullableString(x["sourcePositionFen"]) {
		return false
	}
	return isNullJSON(p.Original) || validResult(p.Original) && func() bool {
		var x map[string]json.RawMessage
		_ = json.Unmarshal(p.Original, &x)
		var kind string
		_ = json.Unmarshal(x["kind"], &kind)
		return kind == "final"
	}()
}
func validateCheckpointShape(v map[string]json.RawMessage) bool {
	keys := func(raw json.RawMessage, want []string) bool { return exactObjectKeys(raw, want) }
	var rules, history, clocks, budgets, selections, archive map[string]json.RawMessage
	for raw, dst := range map[string]*map[string]json.RawMessage{"rules": &rules, "history": &history, "clocks": &clocks, "budgets": &budgets, "selections": &selections, "archive": &archive} {
		_ = json.Unmarshal(v[raw], dst)
	}
	if !keys(v["rules"], []string{"variant", "startingFen", "currentFen", "sideToMove", "castlingRights", "enPassantSquare", "halfmoveClock", "fullmoveNumber", "repetitionLedger", "moves"}) || !keys(v["history"], []string{"currentSegmentId", "segments", "messages"}) || !keys(v["clocks"], []string{"schemaVersion", "timeControl", "banksAtAnchor", "activeSide", "anchor", "lastReconciledAtMs"}) || !keys(v["budgets"], []string{"formattingCorrectionsRemaining", "illegalMoveAttemptsRemaining", "manualRetriesBySide"}) || !keys(v["selections"], []string{"players"}) {
		return false
	}
	if !jsonArray(rules["moves"]) || !jsonArray(history["segments"]) || !jsonArray(history["messages"]) || !jsonArray(archive["discardedLines"]) {
		return false
	}
	if !isNonemptyString(v["segmentId"]) || !validNumber(v["updatedAtMs"]) {
		return false
	}
	var ledger, tc, banks, budgetIllegal, budgetRetries, players map[string]json.RawMessage
	_ = json.Unmarshal(rules["repetitionLedger"], &ledger)
	_ = json.Unmarshal(clocks["timeControl"], &tc)
	_ = json.Unmarshal(clocks["banksAtAnchor"], &banks)
	_ = json.Unmarshal(budgets["illegalMoveAttemptsRemaining"], &budgetIllegal)
	_ = json.Unmarshal(budgets["manualRetriesBySide"], &budgetRetries)
	_ = json.Unmarshal(selections["players"], &players)
	if !keys(rules["repetitionLedger"], []string{"version", "positions"}) || !jsonArray(ledger["positions"]) || !keys(clocks["timeControl"], []string{"startingTimeMs", "incrementMs"}) || !keys(clocks["banksAtAnchor"], []string{"whiteMs", "blackMs"}) || !keys(budgets["illegalMoveAttemptsRemaining"], []string{"white", "black"}) || !keys(budgets["manualRetriesBySide"], []string{"white", "black"}) || !keys(selections["players"], []string{"white", "black"}) {
		return false
	}
	if !validSelection(players["white"]) || !validSelection(players["black"]) {
		return false
	}
	var ver int
	if json.Unmarshal(ledger["version"], &ver) != nil || ver != 1 {
		return false
	}
	var side string
	if json.Unmarshal(rules["sideToMove"], &side) != nil || !oneOf(side, "white", "black") {
		return false
	}
	var variant string
	if json.Unmarshal(rules["variant"], &variant) != nil || variant != "orthodox" {
		return false
	}
	for _, field := range []string{"revision", "ownershipEpoch", "positionRevision", "requestGeneration", "analysisGeneration"} {
		var n json.Number
		d := json.NewDecoder(bytes.NewReader(v[field]))
		d.UseNumber()
		if d.Decode(&n) != nil {
			return false
		}
		f, e := n.Float64()
		if e != nil || f < 0 || math.Trunc(f) != f || f > 9007199254740991 {
			return false
		}
		if field == "revision" && f < 1 {
			return false
		}
	}
	for _, side := range []string{"white", "black"} {
		var b json.Number
		d := json.NewDecoder(bytes.NewReader(budgetIllegal[side]))
		d.UseNumber()
		if d.Decode(&b) != nil {
			return false
		}
		f, e := b.Float64()
		if e != nil || f < 0 || math.Trunc(f) != f || f > 9007199254740991 {
			return false
		}
	}
	for _, f := range []string{"startingFen", "currentFen", "castlingRights", "halfmoveClock", "fullmoveNumber"} {
		if !isString(rules[f]) {
			return false
		}
	}
	if !isNullJSON(rules["enPassantSquare"]) && !isString(rules["enPassantSquare"]) {
		return false
	}
	if !validDecimal(rules["halfmoveClock"], false) || !validDecimal(rules["fullmoveNumber"], true) {
		return false
	}
	if !validNumber(clocks["lastReconciledAtMs"]) || !validNumber(tc["startingTimeMs"]) || !validNumber(tc["incrementMs"]) || !validNumber(banks["whiteMs"]) || !validNumber(banks["blackMs"]) {
		return false
	}
	var clockVersion int
	_ = json.Unmarshal(clocks["schemaVersion"], &clockVersion)
	if clockVersion != 1 {
		return false
	}
	if !validNullableSide(clocks["activeSide"]) || !validAnchor(clocks["anchor"]) {
		return false
	}
	for _, side := range []string{"white", "black"} {
		if !validNonnegativeInt(budgetRetries[side]) {
			return false
		}
	}
	if !validNonnegativeInt(budgets["formattingCorrectionsRemaining"]) {
		return false
	}
	var moveList, segmentList, messageList, positions, discardedList []json.RawMessage
	_ = json.Unmarshal(rules["moves"], &moveList)
	_ = json.Unmarshal(history["segments"], &segmentList)
	_ = json.Unmarshal(history["messages"], &messageList)
	_ = json.Unmarshal(ledger["positions"], &positions)
	_ = json.Unmarshal(archive["discardedLines"], &discardedList)
	for _, raw := range moveList {
		var x map[string]json.RawMessage
		_ = json.Unmarshal(raw, &x)
		if !exactObjectKeys(raw, []string{"moveId", "from", "to", "promotion", "san", "fenBefore", "fenAfter", "eventId"}) {
			return false
		}
		for _, k := range []string{"moveId", "from", "to", "san", "fenBefore", "fenAfter", "eventId"} {
			if !isString(x[k]) {
				return false
			}
		}
		if !isNullJSON(x["promotion"]) && !isString(x["promotion"]) {
			return false
		}
	}
	for _, raw := range positions {
		var x map[string]json.RawMessage
		_ = json.Unmarshal(raw, &x)
		if !exactObjectKeys(raw, []string{"identity", "occurrences"}) || !isNonemptyString(x["identity"]) || !validDecimal(x["occurrences"], true) {
			return false
		}
	}
	segmentIDs := map[string]bool{}
	for _, raw := range segmentList {
		var x map[string]json.RawMessage
		_ = json.Unmarshal(raw, &x)
		if !exactObjectKeys(raw, []string{"segmentId", "providerId", "modelRoutingId", "connectionRevision", "startedAtMs", "messageIds"}) || !isNonemptyString(x["segmentId"]) || !validHistoryBinding(x) || !validNumber(x["startedAtMs"]) || !stringArray(x["messageIds"]) {
			return false
		}
		var id string
		_ = json.Unmarshal(x["segmentId"], &id)
		if segmentIDs[id] {
			return false
		}
		segmentIDs[id] = true
	}
	lineIDs := map[string]bool{}
	lineEventIDs := map[string]map[string]bool{}
	var current map[string]json.RawMessage
	_ = json.Unmarshal(archive["currentLine"], &current)
	if !validLine(archive["currentLine"], false) || !isNonemptyString(current["lineId"]) {
		return false
	}
	var currentLineID string
	if json.Unmarshal(current["lineId"], &currentLineID) != nil {
		return false
	}
	lineIDs[currentLineID] = true
	lineEventIDs[currentLineID] = rawStringSet(current["eventIds"])
	for _, raw := range discardedList {
		var x map[string]json.RawMessage
		_ = json.Unmarshal(raw, &x)
		if !validLine(raw, true) || !validPositiveInt(x["discardedAtRevision"]) || !validReason(x["reason"], "undo", "branch", "replacement") {
			return false
		}
		var lineID string
		if json.Unmarshal(x["lineId"], &lineID) != nil {
			return false
		}
		if lineIDs[lineID] {
			return false
		}
		lineIDs[lineID] = true
		lineEventIDs[lineID] = rawStringSet(x["eventIds"])
	}
	messageIDs := map[string]bool{}
	for _, raw := range messageList {
		var x map[string]json.RawMessage
		_ = json.Unmarshal(raw, &x)
		if !exactObjectKeys(raw, []string{"messageId", "segmentId", "lineId", "role", "content", "eventIds", "disposition"}) || !isNonemptyString(x["messageId"]) || !isNonemptyString(x["segmentId"]) || !isNonemptyString(x["lineId"]) || !isString(x["content"]) || !stringArray(x["eventIds"]) || !validReason(x["role"], "system", "developer", "user", "assistant", "tool", "function") || !validReason(x["disposition"], "retained", "discarded") {
			return false
		}
		var mid, seg, line, disposition string
		_ = json.Unmarshal(x["messageId"], &mid)
		_ = json.Unmarshal(x["segmentId"], &seg)
		_ = json.Unmarshal(x["lineId"], &line)
		_ = json.Unmarshal(x["disposition"], &disposition)
		if messageIDs[mid] || lineEventIDs[line] == nil || (disposition == "discarded") != (line != currentLineID) {
			return false
		}
		messageIDs[mid] = true
		var refs []string
		_ = json.Unmarshal(x["eventIds"], &refs)
		for _, id := range refs {
			if !lineEventIDs[line][id] {
				return false
			}
		}
	}
	return true
}

func validHistoryBinding(segment map[string]json.RawMessage) bool {
	providerNull := isNullJSON(segment["providerId"])
	modelNull := isNullJSON(segment["modelRoutingId"])
	revisionNull := isNullJSON(segment["connectionRevision"])
	if providerNull || modelNull || revisionNull {
		return providerNull && modelNull && revisionNull
	}
	return isString(segment["providerId"]) && isString(segment["modelRoutingId"]) && validNonnegativeInt(segment["connectionRevision"])
}

func isString(r json.RawMessage) bool { var s string; return json.Unmarshal(r, &s) == nil }
func isNonemptyString(r json.RawMessage) bool {
	var s string
	return json.Unmarshal(r, &s) == nil && s != ""
}
func stringArray(r json.RawMessage) bool {
	var a []string
	return jsonArray(r) && json.Unmarshal(r, &a) == nil
}
func rawStringSet(r json.RawMessage) map[string]bool {
	out := map[string]bool{}
	var a []string
	_ = json.Unmarshal(r, &a)
	for _, s := range a {
		out[s] = true
	}
	return out
}
func validNumber(r json.RawMessage) bool {
	var n json.Number
	d := json.NewDecoder(bytes.NewReader(r))
	d.UseNumber()
	if d.Decode(&n) != nil {
		return false
	}
	f, e := n.Float64()
	return e == nil && !math.IsInf(f, 0) && !math.IsNaN(f)
}
func validNonnegativeInt(r json.RawMessage) bool {
	var n json.Number
	d := json.NewDecoder(bytes.NewReader(r))
	d.UseNumber()
	if d.Decode(&n) != nil {
		return false
	}
	f, e := n.Float64()
	return e == nil && f >= 0 && f <= 9007199254740991 && math.Trunc(f) == f
}
func validPositiveInt(r json.RawMessage) bool { return validNonnegativeInt(r) && string(r) != "0" }
func validDecimal(r json.RawMessage, minOne bool) bool {
	var s string
	if json.Unmarshal(r, &s) != nil || s == "" {
		return false
	}
	for i, c := range s {
		if c < '0' || c > '9' || (i == 0 && c == '0' && len(s) > 1) {
			return false
		}
	}
	return !minOne || s != "0"
}
func validReason(r json.RawMessage, values ...string) bool {
	var s string
	if json.Unmarshal(r, &s) != nil {
		return false
	}
	return oneOf(s, values...)
}
func validLine(r json.RawMessage, discarded bool) bool {
	var x map[string]json.RawMessage
	_ = json.Unmarshal(r, &x)
	keys := []string{"lineId", "eventIds"}
	if discarded {
		keys = append(keys, "discardedAtRevision", "reason")
	}
	return exactObjectKeys(r, keys) && isNonemptyString(x["lineId"]) && stringArray(x["eventIds"])
}
func validNullableSide(r json.RawMessage) bool {
	if isNullJSON(r) {
		return true
	}
	return validReason(r, "white", "black")
}
func validNullableString(r json.RawMessage) bool { return isNullJSON(r) || isString(r) }
func isNullJSON(r json.RawMessage) bool          { return bytes.Equal(bytes.TrimSpace(r), []byte("null")) }
func validSelection(r json.RawMessage) bool {
	var x map[string]json.RawMessage
	_ = json.Unmarshal(r, &x)
	var kind string
	if json.Unmarshal(x["kind"], &kind) != nil {
		return false
	}
	if kind == "human" {
		return exactObjectKeys(r, []string{"kind"})
	}
	if kind != "model" || !exactObjectKeys(r, []string{"kind", "providerId", "connectionId", "configurationRevision", "modelRoutingId", "protocol", "diagnostic"}) {
		return false
	}
	return isString(x["providerId"]) && isNonemptyString(x["connectionId"]) && validNonnegativeInt(x["configurationRevision"]) && isNonemptyString(x["modelRoutingId"]) && validReason(x["protocol"], "chat-completions", "responses", "messages", "custom") && validReason(x["diagnostic"], "not-run", "passed-current-session", "failed", "unknown")
}
func validAnchor(r json.RawMessage) bool {
	if isNullJSON(r) {
		return true
	}
	var x map[string]json.RawMessage
	if json.Unmarshal(r, &x) != nil {
		return false
	}
	keys := []string{"monotonicMs", "wallTimeMs"}
	if _, ok := x["hostOffsetMs"]; ok {
		keys = append(keys, "hostOffsetMs")
	}
	return exactObjectKeys(r, keys) && validNumber(x["monotonicMs"]) && validNumber(x["wallTimeMs"]) && (x["hostOffsetMs"] == nil || validNumber(x["hostOffsetMs"]))
}
func jsonArray(raw json.RawMessage) bool {
	var x []json.RawMessage
	return json.Unmarshal(raw, &x) == nil
}
func mustMapJSON(v map[string]json.RawMessage) []byte { b, _ := json.Marshal(v); return b }

func validUniqueJSON(raw []byte) bool {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if !consumeJSONValue(d) {
		return false
	}
	_, err := d.Token()
	return errors.Is(err, io.EOF)
}
func consumeJSONValue(d *json.Decoder) bool {
	t, err := d.Token()
	if err != nil {
		return false
	}
	switch v := t.(type) {
	case json.Delim:
		switch v {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				k, e := d.Token()
				if e != nil {
					return false
				}
				key, ok := k.(string)
				if !ok || seen[key] {
					return false
				}
				seen[key] = true
				if !consumeJSONValue(d) {
					return false
				}
			}
			end, e := d.Token()
			return e == nil && end == json.Delim('}')
		case '[':
			for d.More() {
				if !consumeJSONValue(d) {
					return false
				}
			}
			end, e := d.Token()
			return e == nil && end == json.Delim(']')
		default:
			return false
		}
	default:
		return true
	}
}

func (s *Store) Create(ctx context.Context, owner string, in CreateGame) (Game, error) {
	if owner == "" || in.GameID == "" || validateCheckpoint(in.CheckpointJSON, in.GameID, owner) != nil {
		return Game{}, ErrInvalidDTO
	}
	var initial struct {
		Revision int64 `json:"revision"`
		Epoch    int64 `json:"ownershipEpoch"`
	}
	if json.Unmarshal(in.CheckpointJSON, &initial) != nil || initial.Revision != 1 || initial.Epoch != 1 {
		return Game{}, ErrInvalidDTO
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Game{}, err
	}
	defer tx.Rollback(ctx)
	var g Game
	err = tx.QueryRow(ctx, `INSERT INTO games(game_id,owner_id,revision,ownership_epoch,checkpoint_json) VALUES($1,$2,1,1,$3) ON CONFLICT DO NOTHING RETURNING game_id,owner_id,revision,ownership_epoch,checkpoint_json,created_at,updated_at,deleted_at`, in.GameID, owner, in.CheckpointJSON).Scan(&g.ID, &g.OwnerID, &g.Revision, &g.Epoch, &g.CheckpointJSON, &g.CreatedAt, &g.UpdatedAt, &g.DeletedAt)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return Game{}, err
		}
		var exists bool
		_ = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM deletion_tombstones WHERE game_id=$1)`, in.GameID).Scan(&exists)
		if exists {
			return Game{}, ErrDeleted
		}
		return Game{}, ErrAlreadyExists
	}
	if err = validateArchiveReferences(ctx, tx, in.GameID, in.CheckpointJSON); err != nil {
		return Game{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Game{}, err
	}
	return g, nil
}
func scanGame(row pgx.Row) (Game, error) {
	var g Game
	err := row.Scan(&g.ID, &g.OwnerID, &g.Revision, &g.Epoch, &g.CheckpointJSON, &g.CreatedAt, &g.UpdatedAt, &g.DeletedAt)
	return g, err
}

const gameCols = `game_id,owner_id,revision,ownership_epoch,checkpoint_json,created_at,updated_at,deleted_at`

func (s *Store) Get(ctx context.Context, owner, id string) (Game, error) {
	g, e := scanGame(s.db.QueryRow(ctx, `SELECT `+gameCols+` FROM games WHERE owner_id=$1 AND game_id=$2 AND deleted_at IS NULL`, owner, id))
	if errors.Is(e, pgx.ErrNoRows) {
		return Game{}, ErrNotFound
	}
	return g, e
}
func (s *Store) List(ctx context.Context, owner string, p Page) (GamePage, error) {
	if p.Limit <= 0 || p.Limit > 200 {
		p.Limit = 50
	}
	rows, e := s.db.Query(ctx, `SELECT `+gameCols+` FROM games WHERE owner_id=$1 AND deleted_at IS NULL AND game_id>$2 ORDER BY game_id LIMIT $3`, owner, p.After, p.Limit+1)
	if e != nil {
		return GamePage{}, e
	}
	defer rows.Close()
	out := GamePage{Games: []Game{}}
	for rows.Next() {
		g, x := scanGame(rows)
		if x != nil {
			return GamePage{}, x
		}
		out.Games = append(out.Games, g)
	}
	if len(out.Games) > p.Limit {
		out.Games = out.Games[:p.Limit]
		out.Next = out.Games[len(out.Games)-1].ID
	}
	return out, rows.Err()
}
func hashRequest(r CommitRequest) []byte {
	h := sha256.New()
	put := func(b []byte) {
		var n [8]byte
		binary.BigEndian.PutUint64(n[:], uint64(len(b)))
		_, _ = h.Write(n[:])
		_, _ = h.Write(b)
	}
	put([]byte(r.GameID))
	put([]byte(r.OperationID))
	var fence [16]byte
	binary.BigEndian.PutUint64(fence[:8], uint64(r.ExpectedRevision))
	binary.BigEndian.PutUint64(fence[8:], uint64(r.ExpectedEpoch))
	put(fence[:])
	put(r.CheckpointJSON)
	var count [8]byte
	binary.BigEndian.PutUint64(count[:], uint64(len(r.Archives)))
	put(count[:])
	for _, a := range r.Archives {
		var seq [8]byte
		binary.BigEndian.PutUint64(seq[:], uint64(a.Sequence))
		put(seq[:])
		put(a.RawJSON)
		put([]byte(a.SHA256))
	}
	for _, a := range r.Events {
		var seq [8]byte
		binary.BigEndian.PutUint64(seq[:], uint64(a.Sequence))
		put(seq[:])
		put(a.RawJSON)
	}
	return h.Sum(nil)
}

func validateArchiveChunk(raw []byte, gameID string, sequence int64) error {
	if !validUniqueJSON(raw) {
		return ErrInvalidDTO
	}
	var obj map[string]json.RawMessage
	d := json.NewDecoder(bytes.NewReader(raw))
	if d.Decode(&obj) != nil {
		return ErrInvalidDTO
	}
	keys := []string{"chunkId", "gameId", "sequence", "receivedAtMs", "isFinal", "egressStatus", "bytesBase64", "sha256"}
	if len(obj) != len(keys) {
		return ErrInvalidDTO
	}
	for _, k := range keys {
		if _, ok := obj[k]; !ok {
			return ErrInvalidDTO
		}
	}
	var chunk struct {
		ID       string      `json:"chunkId"`
		Game     string      `json:"gameId"`
		Sequence int64       `json:"sequence"`
		Received json.Number `json:"receivedAtMs"`
		Final    *bool       `json:"isFinal"`
		Egress   string      `json:"egressStatus"`
		Encoded  string      `json:"bytesBase64"`
		Digest   string      `json:"sha256"`
	}
	if json.Unmarshal(raw, &chunk) != nil || chunk.ID == "" || chunk.Game != gameID || chunk.Sequence != sequence || chunk.Egress != "eligible" || chunk.Final == nil || !validFiniteNumber(chunk.Received) {
		return ErrInvalidDTO
	}
	b, err := base64.StdEncoding.DecodeString(chunk.Encoded)
	if err != nil {
		return ErrInvalidDTO
	}
	sum := sha256.Sum256(b)
	if chunk.Digest != hex.EncodeToString(sum[:]) {
		return ErrInvalidDTO
	}
	return nil
}
func validateArchiveEvent(raw []byte, gameID string, sequence int64) error {
	if !validUniqueJSON(raw) {
		return ErrInvalidDTO
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil || len(m) != 10 {
		return ErrInvalidDTO
	}
	for _, k := range []string{"eventId", "gameId", "sequence", "segmentId", "kind", "occurredAtMs", "receiveState", "egressStatus", "payload", "chunkIds"} {
		if _, ok := m[k]; !ok {
			return ErrInvalidDTO
		}
	}
	var e struct {
		ID       string          `json:"eventId"`
		Game     string          `json:"gameId"`
		Segment  string          `json:"segmentId"`
		Kind     string          `json:"kind"`
		Receive  string          `json:"receiveState"`
		Egress   string          `json:"egressStatus"`
		Sequence int64           `json:"sequence"`
		ChunkIDs []string        `json:"chunkIds"`
		Occurred json.Number     `json:"occurredAtMs"`
		Payload  json.RawMessage `json:"payload"`
	}
	if json.Unmarshal(raw, &e) != nil || e.ID == "" || e.Game != gameID || e.Sequence != sequence || e.Segment == "" || e.Kind == "" || (e.Receive != "complete" && e.Receive != "partial") || e.Egress != "eligible" || !validFiniteNumber(e.Occurred) || !json.Valid(e.Payload) || !jsonArray(m["chunkIds"]) {
		return ErrInvalidDTO
	}
	return nil
}
func (s *Store) Commit(ctx context.Context, owner string, r CommitRequest) (CommitResult, error) {
	if owner == "" || r.OperationID == "" || validateCheckpoint(r.CheckpointJSON, r.GameID, owner) != nil {
		return CommitResult{}, ErrInvalidDTO
	}
	h := hashRequest(r)
	tx, e := s.db.Begin(ctx)
	if e != nil {
		return CommitResult{}, e
	}
	defer tx.Rollback(ctx)
	// Serialize retries on the game row before consulting the operation ledger.
	g, e := scanGame(tx.QueryRow(ctx, `SELECT `+gameCols+` FROM games WHERE owner_id=$1 AND game_id=$2 FOR UPDATE`, owner, r.GameID))
	if errors.Is(e, pgx.ErrNoRows) {
		return CommitResult{}, ErrNotFound
	}
	if e != nil {
		return CommitResult{}, e
	}
	var old Operation
	e = tx.QueryRow(ctx, `SELECT operation_id,game_id,request_hash,revision,ownership_epoch,accepted_at,result_json FROM operations WHERE owner_id=$1 AND game_id=$2 AND operation_id=$3`, owner, r.GameID, r.OperationID).Scan(&old.ID, &old.GameID, &old.RequestHash, &old.Revision, &old.Epoch, &old.AcceptedAt, &old.ResultJSON)
	if e == nil {
		if g.DeletedAt != nil {
			return CommitResult{}, ErrDeleted
		}
		if !bytes.Equal(old.RequestHash, h) {
			return CommitResult{}, ErrOperationReuse
		}
		var g Game
		_ = json.Unmarshal(old.ResultJSON, &g)
		return CommitResult{Game: g, Operation: old, Duplicate: true}, nil
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return CommitResult{}, e
	}
	if g.DeletedAt != nil {
		return CommitResult{}, ErrDeleted
	}
	if g.Revision != r.ExpectedRevision || g.Epoch != r.ExpectedEpoch {
		return CommitResult{}, ErrConflict
	}
	if err := validateCheckpoint(r.CheckpointJSON, r.GameID, owner); err != nil {
		return CommitResult{}, err
	}
	var incoming struct {
		Revision int64 `json:"revision"`
		Epoch    int64 `json:"ownershipEpoch"`
	}
	var prior struct {
		Revision int64 `json:"revision"`
	}
	_ = json.Unmarshal(g.CheckpointJSON, &prior)
	if json.Unmarshal(r.CheckpointJSON, &incoming) != nil || incoming.Revision <= prior.Revision || incoming.Epoch != g.Epoch {
		return CommitResult{}, ErrInvalidDTO
	}
	var maxEvent, maxChunk int64
	_ = tx.QueryRow(ctx, `SELECT COALESCE(max(sequence),-1) FROM archive_events WHERE game_id=$1`, r.GameID).Scan(&maxEvent)
	_ = tx.QueryRow(ctx, `SELECT COALESCE(max(sequence),-1) FROM archive_chunks WHERE game_id=$1`, r.GameID).Scan(&maxChunk)
	for i, a := range r.Events {
		if a.Sequence <= maxEvent || (i > 0 && a.Sequence <= r.Events[i-1].Sequence) {
			return CommitResult{}, ErrInvalidDTO
		}
	}
	for i, a := range r.Archives {
		if a.Sequence <= maxChunk || (i > 0 && a.Sequence <= r.Archives[i-1].Sequence) {
			return CommitResult{}, ErrInvalidDTO
		}
	}
	var current map[string]any
	_ = json.Unmarshal(g.CheckpointJSON, &current)
	if fin, ok := current["result"].(map[string]any); ok && fin["kind"] == "final" {
		var prev, next any
		_ = json.Unmarshal(mustRawField(g.CheckpointJSON, "result"), &prev)
		_ = json.Unmarshal(mustRawField(r.CheckpointJSON, "result"), &next)
		if !reflect.DeepEqual(prev, next) {
			return CommitResult{}, ErrInvalidDTO
		}
	}
	nr := g.Revision + 1
	ne := g.Epoch
	if _, e = tx.Exec(ctx, `UPDATE games SET revision=$1,checkpoint_json=$2,updated_at=now() WHERE game_id=$3`, nr, r.CheckpointJSON, r.GameID); e != nil {
		return CommitResult{}, e
	}
	for _, a := range r.Archives {
		sum := sha256.Sum256(a.RawJSON)
		if a.Sequence < 0 || a.SHA256 == "" || a.SHA256 != hex.EncodeToString(sum[:]) || validateArchiveChunk(a.RawJSON, r.GameID, a.Sequence) != nil {
			return CommitResult{}, ErrInvalidDTO
		}
		var chunkID string
		var chunkObj map[string]json.RawMessage
		_ = json.Unmarshal(a.RawJSON, &chunkObj)
		_ = json.Unmarshal(chunkObj["chunkId"], &chunkID)
		if _, e = tx.Exec(ctx, `INSERT INTO archive_chunks(game_id,sequence,item_id,raw_json,sha256) VALUES($1,$2,$3,$4,$5)`, r.GameID, a.Sequence, chunkID, a.RawJSON, hex.EncodeToString(sum[:])); e != nil {
			var pgErr *pgconn.PgError
			if errors.As(e, &pgErr) && pgErr.Code == "23505" {
				return CommitResult{}, ErrInvalidDTO
			}
			return CommitResult{}, e
		}
	}
	for _, a := range r.Events {
		if a.Sequence < 0 || validateArchiveEvent(a.RawJSON, r.GameID, a.Sequence) != nil {
			return CommitResult{}, ErrInvalidDTO
		}
		var eventObj map[string]json.RawMessage
		_ = json.Unmarshal(a.RawJSON, &eventObj)
		var eventID string
		_ = json.Unmarshal(eventObj["eventId"], &eventID)
		if _, e = tx.Exec(ctx, `INSERT INTO archive_events(game_id,sequence,item_id,raw_json) VALUES($1,$2,$3,$4)`, r.GameID, a.Sequence, eventID, a.RawJSON); e != nil {
			var pgErr *pgconn.PgError
			if errors.As(e, &pgErr) && pgErr.Code == "23505" {
				return CommitResult{}, ErrInvalidDTO
			}
			return CommitResult{}, e
		}
	}
	if e = validateArchiveReferences(ctx, tx, r.GameID, r.CheckpointJSON); e != nil {
		return CommitResult{}, e
	}
	g.Revision = nr
	g.CheckpointJSON = append([]byte(nil), r.CheckpointJSON...)
	g.UpdatedAt = time.Now().UTC()
	res, _ := json.Marshal(g)
	op := Operation{ID: r.OperationID, GameID: r.GameID, RequestHash: h, Revision: nr, Epoch: ne, ResultJSON: res}
	e = tx.QueryRow(ctx, `INSERT INTO operations(owner_id,game_id,operation_id,request_hash,revision,ownership_epoch,result_json) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING accepted_at`, owner, r.GameID, r.OperationID, h, nr, ne, res).Scan(&op.AcceptedAt)
	if e != nil {
		return CommitResult{}, e
	}
	if e = tx.Commit(ctx); e != nil {
		return CommitResult{}, e
	}
	return CommitResult{Game: g, Operation: op}, nil
}

func validateArchiveReferences(ctx context.Context, tx pgx.Tx, gameID string, checkpoint []byte) error {
	var cp map[string]json.RawMessage
	if json.Unmarshal(checkpoint, &cp) != nil {
		return ErrInvalidDTO
	}
	var rules, history, archive map[string]json.RawMessage
	_ = json.Unmarshal(cp["rules"], &rules)
	_ = json.Unmarshal(cp["history"], &history)
	_ = json.Unmarshal(cp["archive"], &archive)
	ids := map[string]bool{}
	add := func(raw json.RawMessage) {
		var xs []string
		if json.Unmarshal(raw, &xs) == nil {
			for _, x := range xs {
				ids[x] = true
			}
		}
	}
	var moves []map[string]json.RawMessage
	_ = json.Unmarshal(rules["moves"], &moves)
	for _, m := range moves {
		var id string
		_ = json.Unmarshal(m["eventId"], &id)
		ids[id] = true
	}
	var messages []map[string]json.RawMessage
	_ = json.Unmarshal(history["messages"], &messages)
	for _, m := range messages {
		add(m["eventIds"])
	}
	var current map[string]json.RawMessage
	_ = json.Unmarshal(archive["currentLine"], &current)
	add(current["eventIds"])
	var lines []map[string]json.RawMessage
	_ = json.Unmarshal(archive["discardedLines"], &lines)
	for _, l := range lines {
		add(l["eventIds"])
	}
	rows, err := tx.Query(ctx, `SELECT item_id,raw_json FROM archive_events WHERE game_id=$1`, gameID)
	if err != nil {
		return err
	}
	eventIDs := map[string]bool{}
	eventChunks := map[string][]string{}
	eventReceive := map[string]string{}
	for rows.Next() {
		var id string
		var raw []byte
		if err = rows.Scan(&id, &raw); err != nil {
			rows.Close()
			return err
		}
		eventIDs[id] = true
		var dto struct {
			ChunkIDs []string `json:"chunkIds"`
			Receive  string   `json:"receiveState"`
		}
		if json.Unmarshal(raw, &dto) != nil {
			rows.Close()
			return ErrInvalidDTO
		}
		eventChunks[id] = dto.ChunkIDs
		eventReceive[id] = dto.Receive
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for id := range ids {
		if id != "" && !eventIDs[id] {
			return ErrInvalidDTO
		}
	}
	rows, err = tx.Query(ctx, `SELECT item_id,raw_json FROM archive_chunks WHERE game_id=$1`, gameID)
	if err != nil {
		return err
	}
	chunkIDs := map[string]bool{}
	type chunkMeta struct {
		Sequence int64 `json:"sequence"`
		Final    bool  `json:"isFinal"`
	}
	chunkMetaByID := map[string]chunkMeta{}
	for rows.Next() {
		var id string
		var raw []byte
		if err = rows.Scan(&id, &raw); err != nil {
			rows.Close()
			return err
		}
		chunkIDs[id] = true
		var meta chunkMeta
		if json.Unmarshal(raw, &meta) != nil {
			rows.Close()
			return ErrInvalidDTO
		}
		chunkMetaByID[id] = meta
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for eventID, refs := range eventChunks {
		var previous int64 = -1
		var last chunkMeta
		for _, id := range refs {
			if !chunkIDs[id] {
				return ErrInvalidDTO
			}
			last = chunkMetaByID[id]
			if last.Sequence <= previous {
				return ErrInvalidDTO
			}
			previous = last.Sequence
		}
		if len(refs) > 0 && ((eventReceive[eventID] == "complete" && !last.Final) || (eventReceive[eventID] == "partial" && last.Final)) {
			return ErrInvalidDTO
		}
	}
	return nil
}

func mustRawField(raw []byte, key string) json.RawMessage {
	var obj map[string]json.RawMessage
	_ = json.Unmarshal(raw, &obj)
	return obj[key]
}
