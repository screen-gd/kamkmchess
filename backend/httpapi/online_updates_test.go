package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
)

// stubUpdatesService is a fake online service whose durable version can
// change while a stream is open.
//
// It implements the optional version reader, so the stream detects a change
// with a bounded read instead of loading the whole match on every poll.
type stubUpdatesService struct {
	mu            sync.Mutex
	match         online.Match
	matchErr      error
	versionErr    error
	current       int64
	versionReads  int
	snapshotReads int
	// versionFor answers a version read. It runs without the lock held, so
	// it may change the durable version of the service.
	versionFor func(read int, service *stubUpdatesService) (int64, error)
	// blockReads makes a snapshot read wait for the deadline of its
	// context, which is how a blocked database read behaves.
	blockReads bool
	// blockVersionReads makes a version read wait for the deadline of its
	// context, which is how a slow change detection behaves.
	blockVersionReads bool
}

func newStubUpdatesService(version int64) *stubUpdatesService {
	return &stubUpdatesService{
		current: version,
		match: online.Match{
			SchemaVersion: online.ContractsSchemaVersion,
			MatchID:       "match-live",
			Variant:       "orthodox",
			StartingFEN:   "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
			PositionFEN:   "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
			ControlEpoch:  1,
			Status:        online.MatchActive,
			Seats: []online.MatchSeat{
				{Seat: online.SeatWhite, Participant: online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_secret_1"}, PublicLabel: "Alice", Control: online.SeatControl{Kind: online.ControlHuman}, ControlEpoch: 1},
				{Seat: online.SeatBlack, Participant: online.ParticipantRef{Kind: online.ParticipantGuest, ID: "guest_secret_2"}, PublicLabel: "Guest", Control: online.SeatControl{Kind: online.ControlHuman}, ControlEpoch: 1},
			},
			Clock: online.ClockState{WhiteMs: 1000, BlackMs: 1000},
			Moves: []online.Move{},
		},
	}
}

func (s *stubUpdatesService) Execute(context.Context, online.ParticipantRef, online.Command) (online.CommandResult, error) {
	return online.CommandResult{}, errors.New("the updates route never commands")
}

func (s *stubUpdatesService) GetMatchForParticipant(ctx context.Context, _ string, _ online.ParticipantRef) (online.Match, error) {
	s.mu.Lock()
	s.snapshotReads++
	blocked := s.blockReads
	s.mu.Unlock()
	if blocked {
		// A blocked read waits for the deadline of the window.
		<-ctx.Done()
		return online.Match{}, ctx.Err()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.matchErr != nil {
		return online.Match{}, s.matchErr
	}
	match := s.match
	match.Version = s.current
	return match, nil
}

func (s *stubUpdatesService) GetReceiptForParticipant(context.Context, string, string, online.ParticipantRef) (online.CommandResult, error) {
	return online.CommandResult{}, errors.New("the updates route never reads a receipt")
}

func (s *stubUpdatesService) GetPublicProjection(context.Context, string) (online.PublicProjection, error) {
	return online.PublicProjection{}, errors.New("the updates route never reads a projection")
}

func (s *stubUpdatesService) MatchVersionForParticipant(ctx context.Context, _ string, _ online.ParticipantRef) (int64, error) {
	s.mu.Lock()
	s.versionReads++
	read := s.versionReads
	blocked := s.blockVersionReads
	s.mu.Unlock()
	if blocked {
		// A slow read waits for the deadline of the window.
		<-ctx.Done()
		return 0, ctx.Err()
	}
	if s.versionFor != nil {
		return s.versionFor(read, s)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.versionErr != nil {
		return 0, s.versionErr
	}
	return s.current, nil
}

func (s *stubUpdatesService) setVersion(version int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.current = version
}

func (s *stubUpdatesService) counts() (int, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.versionReads, s.snapshotReads
}

// newUpdatesHandler builds the online API with the fake updates service.
func newUpdatesHandler(t *testing.T, service OnlineService, options OnlineOptions) http.Handler {
	t.Helper()
	authenticator := &stubAuthenticator{
		account: map[string]onlineauth.Principal{"account-token": accountParticipant("user_secret_1")},
		guest:   map[string]onlineauth.Principal{"guest-token": guestParticipant("guest_secret_2", "match-live", online.SeatBlack)},
	}
	if options.AllowedOrigins == nil {
		options.AllowedOrigins = []string{testOrigin}
	}
	return NewOnline(service, authenticator, options)
}

// sseFrame is one parsed server-sent event.
type sseFrame struct {
	event   string
	id      string
	data    string
	comment string
}

// parseSSEFrames parses the frames of a recorded stream body.
func parseSSEFrames(t *testing.T, body string) []sseFrame {
	t.Helper()
	var frames []sseFrame
	for _, block := range strings.Split(body, "\n\n") {
		if strings.TrimSpace(block) == "" {
			continue
		}
		var frame sseFrame
		for _, line := range strings.Split(block, "\n") {
			if strings.HasPrefix(line, ":") {
				frame.comment = line
				continue
			}
			field, value, found := strings.Cut(line, ":")
			if !found {
				continue
			}
			value = strings.TrimPrefix(value, " ")
			switch field {
			case "event":
				frame.event = value
			case "id":
				frame.id = value
			case "data":
				frame.data = value
			}
		}
		frames = append(frames, frame)
	}
	return frames
}

// The polling fallback answers with the canonical envelope, and the cursor is
// the durable version of the snapshot it carries.
func TestOnlineUpdatesJSONPollReturnsTheCanonicalEnvelope(t *testing.T) {
	service := newStubUpdatesService(3)
	handler := newUpdatesHandler(t, service, OnlineOptions{})
	response := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live/updates", testOrigin, map[string]string{
		"Authorization": "Bearer account-token",
		"Accept":        "application/json",
	}, "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if contentType := response.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
		t.Fatalf("content type=%q", contentType)
	}
	if cache := response.Header().Get("Cache-Control"); cache != "no-store" {
		t.Fatalf("cache control=%q", cache)
	}
	var envelope onlineUpdatesEnvelope
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.SchemaVersion != OnlineUpdatesSchemaVersion {
		t.Fatalf("schema version=%d", envelope.SchemaVersion)
	}
	if envelope.Cursor != 3 || envelope.Cursor != envelope.Snapshot.Version {
		t.Fatalf("cursor=%d snapshot version=%d", envelope.Cursor, envelope.Snapshot.Version)
	}
	if envelope.Snapshot.MatchID != "match-live" {
		t.Fatalf("snapshot match=%q", envelope.Snapshot.MatchID)
	}
	for _, forbidden := range []string{"user_secret_1", "guest_secret_2", "participantId", "ownerId", "credential", "sessionId", "operationId"} {
		if strings.Contains(response.Body.String(), forbidden) {
			t.Fatalf("the envelope leaked %q: %s", forbidden, response.Body.String())
		}
	}
}

// A malformed or out-of-range cursor is a malformed request, never a silent
// reset.
func TestOnlineUpdatesRejectsAMalformedCursor(t *testing.T) {
	service := newStubUpdatesService(3)
	handler := newUpdatesHandler(t, service, OnlineOptions{})
	for name, cursor := range map[string]string{
		"letters":       "abc",
		"negative":      "-1",
		"decimal":       "1.5",
		"exponent":      "1e3",
		"hex":           "0x10",
		"signed":        "+5",
		"two values":    "5 5",
		"out of range":  "9007199254740992",
		"beyond int64":  "9223372036854775808",
		"leading space": " 5 5",
		"empty":         "",
		"blank":         "   ",
	} {
		t.Run(name, func(t *testing.T) {
			response := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live/updates", testOrigin, map[string]string{
				"Authorization": "Bearer account-token",
				"Accept":        "application/json",
				"Last-Event-ID": cursor,
			}, "")
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if !strings.Contains(response.Body.String(), "invalid_request") {
				t.Fatalf("body=%s", response.Body.String())
			}
		})
	}
}

// A stale, a future, or a gap cursor is accepted and the server still sends
// the current canonical snapshot.
func TestOnlineUpdatesAcceptsAStaleFutureOrGapCursor(t *testing.T) {
	service := newStubUpdatesService(3)
	handler := newUpdatesHandler(t, service, OnlineOptions{})
	for name, cursor := range map[string]string{
		"stale":  "1",
		"future": "99",
		"gap":    "7",
		"zero":   "0",
		"exact":  "3",
	} {
		t.Run(name, func(t *testing.T) {
			response := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live/updates", testOrigin, map[string]string{
				"Authorization": "Bearer account-token",
				"Accept":        "application/json",
				"Last-Event-ID": cursor,
			}, "")
			if response.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			var envelope onlineUpdatesEnvelope
			if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
				t.Fatal(err)
			}
			if envelope.Cursor != 3 {
				t.Fatalf("cursor=%d, want the current version", envelope.Cursor)
			}
		})
	}
}

// The stream begins with the current canonical snapshot, and the identifier of
// the event is the durable cursor.
func TestOnlineUpdatesStreamBeginsWithTheCanonicalSnapshot(t *testing.T) {
	service := newStubUpdatesService(3)
	handler := newUpdatesHandler(t, service, OnlineOptions{
		UpdatesStreamMaxDuration: 120 * time.Millisecond,
		UpdatesPollInterval:      20 * time.Millisecond,
	})
	response := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live/updates", testOrigin, map[string]string{
		"Authorization": "Bearer account-token",
		"Accept":        "text/event-stream",
	}, "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if contentType := response.Header().Get("Content-Type"); contentType != "text/event-stream" {
		t.Fatalf("content type=%q", contentType)
	}
	frames := parseSSEFrames(t, response.Body.String())
	if len(frames) == 0 {
		t.Fatalf("the stream carried no event: %q", response.Body.String())
	}
	first := frames[0]
	if first.event != "snapshot" {
		t.Fatalf("the first event is %q", first.event)
	}
	if first.id != "3" {
		t.Fatalf("the first event id is %q", first.id)
	}
	if strings.Contains(first.data, "\n") {
		t.Fatalf("the event data is not one line: %q", first.data)
	}
	var envelope onlineUpdatesEnvelope
	if err := json.Unmarshal([]byte(first.data), &envelope); err != nil {
		t.Fatalf("the event data is not the envelope: %v (%q)", err, first.data)
	}
	if envelope.SchemaVersion != OnlineUpdatesSchemaVersion || envelope.Cursor != 3 || envelope.Cursor != envelope.Snapshot.Version {
		t.Fatalf("envelope=%+v", envelope)
	}
}

// A change in the durable version produces a new snapshot event with the new
// cursor.
func TestOnlineUpdatesStreamSendsTheNextVersion(t *testing.T) {
	service := newStubUpdatesService(3)
	service.versionFor = func(read int, service *stubUpdatesService) (int64, error) {
		if read == 1 {
			service.setVersion(4)
		}
		return service.current, nil
	}
	handler := newUpdatesHandler(t, service, OnlineOptions{
		UpdatesStreamMaxDuration: 300 * time.Millisecond,
		UpdatesPollInterval:      20 * time.Millisecond,
	})
	response := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live/updates", testOrigin, map[string]string{
		"Authorization": "Bearer account-token",
		"Accept":        "text/event-stream",
	}, "")
	frames := parseSSEFrames(t, response.Body.String())
	var snapshots []sseFrame
	for _, frame := range frames {
		if frame.event == "snapshot" {
			snapshots = append(snapshots, frame)
		}
	}
	if len(snapshots) < 2 {
		t.Fatalf("the stream carried %d snapshot events: %q", len(snapshots), response.Body.String())
	}
	if snapshots[0].id != "3" || snapshots[1].id != "4" {
		t.Fatalf("the snapshot identifiers are %q and %q", snapshots[0].id, snapshots[1].id)
	}
	var envelope onlineUpdatesEnvelope
	if err := json.Unmarshal([]byte(snapshots[1].data), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Cursor != 4 || envelope.Cursor != envelope.Snapshot.Version {
		t.Fatalf("envelope=%+v", envelope)
	}
}

// The cursor never regresses, so a reader that stores the newest cursor
// cannot be moved backwards by a late or repeated read.
func TestOnlineUpdatesStreamNeverRegressesTheCursor(t *testing.T) {
	service := newStubUpdatesService(5)
	service.versionFor = func(read int, service *stubUpdatesService) (int64, error) {
		if read == 1 {
			service.setVersion(3)
		}
		return service.current, nil
	}
	handler := newUpdatesHandler(t, service, OnlineOptions{
		UpdatesStreamMaxDuration: 250 * time.Millisecond,
		UpdatesPollInterval:      20 * time.Millisecond,
	})
	response := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live/updates", testOrigin, map[string]string{
		"Authorization": "Bearer account-token",
		"Accept":        "text/event-stream",
	}, "")
	frames := parseSSEFrames(t, response.Body.String())
	snapshots := 0
	for _, frame := range frames {
		if frame.event != "snapshot" {
			continue
		}
		snapshots++
		if frame.id != "5" {
			t.Fatalf("the stream sent a cursor of %q", frame.id)
		}
	}
	if snapshots != 1 {
		t.Fatalf("the stream sent %d snapshot events", snapshots)
	}
}

// The heartbeat is a comment, so it never looks like a state change, and it
// is observable by the consumer.
func TestOnlineUpdatesStreamWritesHeartbeatComments(t *testing.T) {
	service := newStubUpdatesService(3)
	handler := newUpdatesHandler(t, service, OnlineOptions{
		UpdatesStreamMaxDuration: 300 * time.Millisecond,
		UpdatesPollInterval:      20 * time.Millisecond,
		UpdatesHeartbeatInterval: 40 * time.Millisecond,
	})
	response := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live/updates", testOrigin, map[string]string{
		"Authorization": "Bearer account-token",
		"Accept":        "text/event-stream",
	}, "")
	frames := parseSSEFrames(t, response.Body.String())
	heartbeats := 0
	for _, frame := range frames {
		if frame.comment == "" {
			continue
		}
		if !strings.HasPrefix(frame.comment, ":") {
			t.Fatalf("the heartbeat is not a comment: %q", frame.comment)
		}
		heartbeats++
	}
	if heartbeats == 0 {
		t.Fatalf("the stream carried no heartbeat: %q", response.Body.String())
	}
	for _, frame := range frames {
		if frame.event == "snapshot" && frame.comment != "" {
			t.Fatalf("a snapshot event carried a comment: %q", frame.comment)
		}
	}
}

// The window is finite. The stream ends by itself instead of waiting for a
// consumer that never renews.
func TestOnlineUpdatesStreamClosesAtTheWindow(t *testing.T) {
	service := newStubUpdatesService(3)
	handler := newUpdatesHandler(t, service, OnlineOptions{
		UpdatesStreamMaxDuration: 150 * time.Millisecond,
		UpdatesPollInterval:      20 * time.Millisecond,
	})
	started := time.Now()
	response := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live/updates", testOrigin, map[string]string{
		"Authorization": "Bearer account-token",
		"Accept":        "text/event-stream",
	}, "")
	elapsed := time.Since(started)
	if elapsed < 150*time.Millisecond {
		t.Fatalf("the stream closed after %v", elapsed)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("the stream stayed open for %v", elapsed)
	}
	if !strings.Contains(response.Body.String(), "event: snapshot") {
		t.Fatalf("the closed stream carried no snapshot: %q", response.Body.String())
	}
}

// The stream never outlives the credential that opened it. The window ends
// strictly before the expiry of the credential, never at it.
func TestOnlineUpdatesStreamClosesAtTheCredentialExpiry(t *testing.T) {
	service := newStubUpdatesService(3)
	expiry := time.Now().Add(4 * time.Second)
	authenticator := &stubAuthenticator{
		account: map[string]onlineauth.Principal{
			"account-token": onlineauth.NewAccountPrincipal("user_secret_1", "session-secret", testOrigin, expiry),
		},
	}
	handler := NewOnline(service, authenticator, OnlineOptions{
		AllowedOrigins:           []string{testOrigin},
		UpdatesStreamMaxDuration: 30 * time.Second,
		UpdatesPollInterval:      20 * time.Millisecond,
	})
	started := time.Now()
	response := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live/updates", testOrigin, map[string]string{
		"Authorization": "Bearer account-token",
		"Accept":        "text/event-stream",
	}, "")
	elapsed := time.Since(started)
	if elapsed >= expiry.Sub(started) {
		t.Fatalf("the stream outlived the credential: %v", elapsed)
	}
	if elapsed < time.Second {
		t.Fatalf("the stream closed too early: %v", elapsed)
	}
	if !strings.Contains(response.Body.String(), "event: snapshot") {
		t.Fatalf("the closed stream carried no snapshot: %q", response.Body.String())
	}
}

// A read that blocks past the deadline of the window is cut off with the
// window. The handler answers with a status code and does not wait for the
// database.
func TestOnlineUpdatesCutsOffABlockedReadAtTheWindow(t *testing.T) {
	service := newStubUpdatesService(3)
	service.blockReads = true
	handler := newUpdatesHandler(t, service, OnlineOptions{
		UpdatesStreamMaxDuration: 150 * time.Millisecond,
		UpdatesPollInterval:      20 * time.Millisecond,
	})
	started := time.Now()
	response := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live/updates", testOrigin, map[string]string{
		"Authorization": "Bearer account-token",
		"Accept":        "text/event-stream",
	}, "")
	elapsed := time.Since(started)
	if elapsed > 3*time.Second {
		t.Fatalf("the handler waited %v for a blocked read", elapsed)
	}
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

// A write that blocks is bounded by the earlier of the write timeout and the
// end of the window. A blocked consumer can never hold a stream past its
// window.
func TestOnlineUpdatesCapsABlockedWriteAtTheWindow(t *testing.T) {
	service := newStubUpdatesService(3)
	handler := newUpdatesHandler(t, service, OnlineOptions{
		UpdatesStreamMaxDuration: 200 * time.Millisecond,
		UpdatesPollInterval:      20 * time.Millisecond,
		// The write timeout is much longer than the window, so only the
		// window can bound the write.
		UpdatesWriteTimeout: 5 * time.Second,
	})
	request := httptest.NewRequest(http.MethodGet, "/v1/online/matches/match-live/updates", nil)
	request.Header.Set("Origin", testOrigin)
	request.Header.Set("Authorization", "Bearer account-token")
	request.Header.Set("Accept", "text/event-stream")
	writer := &blockedWriter{}
	started := time.Now()
	handler.ServeHTTP(writer, request)
	elapsed := time.Since(started)
	if elapsed > 2*time.Second {
		t.Fatalf("the handler waited %v for a blocked consumer", elapsed)
	}
	if writer.writes() != 1 {
		t.Fatalf("the handler wrote %d frames to a blocked consumer", writer.writes())
	}
}

// The canonical snapshot has one shape for a new match and for a match with
// history. A list is never null, so a strict client parser reads the same
// structure every time.
func TestOnlineUpdatesEnvelopeUsesListsAndNotNull(t *testing.T) {
	service := newStubUpdatesService(1)
	service.match.Moves = nil
	service.match.Offers = nil
	handler := newUpdatesHandler(t, service, OnlineOptions{})
	response := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live/updates", testOrigin, map[string]string{
		"Authorization": "Bearer account-token",
		"Accept":        "application/json",
	}, "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	for _, field := range []string{`"moves":[]`, `"seats":[`, `"pendingOffers":[]`} {
		if !strings.Contains(body, field) {
			t.Fatalf("the envelope has no %s: %s", field, body)
		}
	}
	for _, field := range []string{`"moves":null`, `"seats":null`, `"pendingOffers":null`} {
		if strings.Contains(body, field) {
			t.Fatalf("the envelope has %s: %s", field, body)
		}
	}
}

// The cursor is a safe integer. A version beyond the safe range would be
// rounded by a browser client, so it is refused instead of published.
func TestOnlineUpdatesRefusesACursorBeyondTheSafeRange(t *testing.T) {
	service := newStubUpdatesService(3)
	handler := newUpdatesHandler(t, service, OnlineOptions{})
	service.setVersion(maxUpdatesCursor)
	safe := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live/updates", testOrigin, map[string]string{
		"Authorization": "Bearer account-token",
		"Accept":        "application/json",
	}, "")
	if safe.Code != http.StatusOK {
		t.Fatalf("the largest safe cursor status=%d body=%s", safe.Code, safe.Body.String())
	}
	var envelope onlineUpdatesEnvelope
	if err := json.Unmarshal(safe.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Cursor != maxUpdatesCursor {
		t.Fatalf("the cursor is %d", envelope.Cursor)
	}
	service.setVersion(maxUpdatesCursor + 1)
	unsafe := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live/updates", testOrigin, map[string]string{
		"Authorization": "Bearer account-token",
		"Accept":        "application/json",
	}, "")
	if unsafe.Code != http.StatusServiceUnavailable {
		t.Fatalf("an unsafe cursor status=%d body=%s", unsafe.Code, unsafe.Body.String())
	}
	stream := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live/updates", testOrigin, map[string]string{
		"Authorization": "Bearer account-token",
		"Accept":        "text/event-stream",
	}, "")
	if stream.Code != http.StatusServiceUnavailable {
		t.Fatalf("an unsafe cursor stream status=%d body=%s", stream.Code, stream.Body.String())
	}
	if strings.Contains(stream.Body.String(), "event: snapshot") {
		t.Fatalf("the stream published an unsafe cursor: %s", stream.Body.String())
	}
}

// A busy match still proves that the stream is alive. The heartbeat is
// unconditional, so a stream that carries snapshots every poll still writes
// its comments.
func TestOnlineUpdatesWritesHeartbeatsOnABusyMatch(t *testing.T) {
	service := newStubUpdatesService(3)
	service.versionFor = func(read int, service *stubUpdatesService) (int64, error) {
		// The match advances on every poll, so the stream carries a
		// snapshot on every tick.
		service.setVersion(service.current + 1)
		return service.current, nil
	}
	handler := newUpdatesHandler(t, service, OnlineOptions{
		UpdatesStreamMaxDuration: 600 * time.Millisecond,
		UpdatesPollInterval:      10 * time.Millisecond,
		UpdatesHeartbeatInterval: 100 * time.Millisecond,
	})
	response := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live/updates", testOrigin, map[string]string{
		"Authorization": "Bearer account-token",
		"Accept":        "text/event-stream",
	}, "")
	frames := parseSSEFrames(t, response.Body.String())
	heartbeats := 0
	snapshots := 0
	for _, frame := range frames {
		if frame.comment != "" {
			heartbeats++
		}
		if frame.event == "snapshot" {
			snapshots++
		}
	}
	if snapshots < 5 {
		t.Fatalf("the busy stream carried %d snapshots", snapshots)
	}
	if heartbeats < 3 {
		t.Fatalf("the busy stream carried %d heartbeats", heartbeats)
	}
}

// A read that is too slow is cut off, and it never delays the heartbeat. The
// consumer keeps receiving comments while the change detection is stuck, and
// the stream ends at its window.
func TestOnlineUpdatesKeepsTheHeartbeatWhileAReadIsTooSlow(t *testing.T) {
	service := newStubUpdatesService(3)
	handler := newUpdatesHandler(t, service, OnlineOptions{
		UpdatesStreamMaxDuration: 600 * time.Millisecond,
		UpdatesPollInterval:      10 * time.Millisecond,
		UpdatesHeartbeatInterval: 100 * time.Millisecond,
	})
	// The first snapshot is delivered, and then the change detection
	// blocks.
	service.blockVersionReads = true
	started := time.Now()
	response := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live/updates", testOrigin, map[string]string{
		"Authorization": "Bearer account-token",
		"Accept":        "text/event-stream",
	}, "")
	elapsed := time.Since(started)
	if elapsed < 400*time.Millisecond {
		t.Fatalf("the stream ended after %v, before its window", elapsed)
	}
	if elapsed > 3*time.Second {
		t.Fatalf("the stream waited %v", elapsed)
	}
	frames := parseSSEFrames(t, response.Body.String())
	heartbeats := 0
	for _, frame := range frames {
		if frame.comment != "" {
			heartbeats++
		}
	}
	if heartbeats < 3 {
		t.Fatalf("the stream carried %d heartbeats while the read was stuck", heartbeats)
	}
	if !strings.Contains(response.Body.String(), "event: snapshot") {
		t.Fatalf("the stream carried no snapshot: %q", response.Body.String())
	}
}

// The route works with a service that does not implement the optional
// version reader. The reader is an extension, so an existing online service
// implementation keeps working without a change.
func TestOnlineUpdatesWorkWithAServiceWithoutTheVersionReader(t *testing.T) {
	_, service, authenticator := newOnlineHandler(t)
	handler := NewOnline(service, authenticator, OnlineOptions{
		AllowedOrigins:           []string{testOrigin},
		UpdatesStreamMaxDuration: 100 * time.Millisecond,
		UpdatesPollInterval:      20 * time.Millisecond,
	})
	poll := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live/updates", testOrigin, map[string]string{
		"Authorization": "Bearer account-token",
		"Accept":        "application/json",
	}, "")
	if poll.Code != http.StatusOK {
		t.Fatalf("poll status=%d body=%s", poll.Code, poll.Body.String())
	}
	var envelope onlineUpdatesEnvelope
	if err := json.Unmarshal(poll.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Cursor != 3 || envelope.Cursor != envelope.Snapshot.Version {
		t.Fatalf("envelope=%+v", envelope)
	}
	stream := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live/updates", testOrigin, map[string]string{
		"Authorization": "Bearer account-token",
		"Accept":        "text/event-stream",
	}, "")
	if stream.Code != http.StatusOK {
		t.Fatalf("stream status=%d body=%s", stream.Code, stream.Body.String())
	}
	frames := parseSSEFrames(t, stream.Body.String())
	if len(frames) == 0 || frames[0].event != "snapshot" || frames[0].id != "3" {
		t.Fatalf("the stream carried no snapshot: %q", stream.Body.String())
	}
}

// The route authenticates the caller and keeps a non-participant out.
func TestOnlineUpdatesRequiresAParticipant(t *testing.T) {
	service := newStubUpdatesService(3)
	handler := newUpdatesHandler(t, service, OnlineOptions{})
	anonymous := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live/updates", testOrigin, map[string]string{"Accept": "application/json"}, "")
	if anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous status=%d body=%s", anonymous.Code, anonymous.Body.String())
	}
	service.matchErr = online.ErrNotFound
	outsider := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live/updates", testOrigin, map[string]string{
		"Authorization": "Bearer account-token",
		"Accept":        "application/json",
	}, "")
	if outsider.Code != http.StatusNotFound {
		t.Fatalf("outsider status=%d body=%s", outsider.Code, outsider.Body.String())
	}
}

// The representation is negotiated. The stream is explicit, and a request
// that accepts neither representation is refused.
func TestOnlineUpdatesNegotiatesTheRepresentation(t *testing.T) {
	service := newStubUpdatesService(3)
	handler := newUpdatesHandler(t, service, OnlineOptions{UpdatesStreamMaxDuration: 80 * time.Millisecond})
	for name, tc := range map[string]struct {
		accept string
		want   string
		status int
	}{
		"explicit stream": {accept: "text/event-stream", want: "text/event-stream", status: http.StatusOK},
		"explicit json":   {accept: "application/json", want: "application/json", status: http.StatusOK},
		"wildcard":        {accept: "*/*", want: "application/json", status: http.StatusOK},
		"absent":          {accept: "", want: "application/json", status: http.StatusOK},
		"refused":         {accept: "text/plain", want: "", status: http.StatusNotAcceptable},
		"stream refused":  {accept: "text/event-stream;q=0", want: "", status: http.StatusNotAcceptable},
	} {
		t.Run(name, func(t *testing.T) {
			headers := map[string]string{"Authorization": "Bearer account-token"}
			if tc.accept != "" {
				headers["Accept"] = tc.accept
			}
			response := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live/updates", testOrigin, headers, "")
			if response.Code != tc.status {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if tc.want == "" {
				return
			}
			if contentType := response.Header().Get("Content-Type"); !strings.HasPrefix(contentType, tc.want) {
				t.Fatalf("content type=%q want=%q", contentType, tc.want)
			}
		})
	}
}

// A consumer that stopped reading fails the write, and the stream ends. The
// handler fails closed instead of keeping a stream nobody receives.
func TestOnlineUpdatesFailsClosedOnABlockedConsumer(t *testing.T) {
	service := newStubUpdatesService(3)
	handler := newUpdatesHandler(t, service, OnlineOptions{
		UpdatesStreamMaxDuration: 5 * time.Second,
		UpdatesPollInterval:      20 * time.Millisecond,
		UpdatesWriteTimeout:      60 * time.Millisecond,
	})
	request := httptest.NewRequest(http.MethodGet, "/v1/online/matches/match-live/updates", nil)
	request.Header.Set("Origin", testOrigin)
	request.Header.Set("Authorization", "Bearer account-token")
	request.Header.Set("Accept", "text/event-stream")
	writer := &blockedWriter{}
	started := time.Now()
	handler.ServeHTTP(writer, request)
	elapsed := time.Since(started)
	if elapsed > 3*time.Second {
		t.Fatalf("the handler waited %v for a blocked consumer", elapsed)
	}
	if writer.writes() != 1 {
		t.Fatalf("the handler wrote %d frames to a blocked consumer", writer.writes())
	}
}

// A failed credential check ends the stream. The next request reports the
// refusal with a status code.
func TestOnlineUpdatesStreamEndsWhenTheCredentialIsRefused(t *testing.T) {
	service := newStubUpdatesService(3)
	handler := newUpdatesHandler(t, service, OnlineOptions{
		UpdatesStreamMaxDuration: 2 * time.Second,
		UpdatesPollInterval:      20 * time.Millisecond,
	})
	service.versionErr = onlineauth.ErrUnauthenticated
	response := onlineRequest(t, handler, http.MethodGet, "/v1/online/matches/match-live/updates", testOrigin, map[string]string{
		"Authorization": "Bearer account-token",
		"Accept":        "text/event-stream",
	}, "")
	if !strings.Contains(response.Body.String(), "event: snapshot") {
		t.Fatalf("the stream carried no snapshot: %q", response.Body.String())
	}
	_, snapshots := service.counts()
	if snapshots != 1 {
		t.Fatalf("the stream read %d snapshots after the refusal", snapshots)
	}
}

// blockedWriter simulates a consumer that stopped reading.
//
// Its write blocks until the write deadline the handler set and then fails,
// which is how a real server observes a slow reader.
type blockedWriter struct {
	mu       sync.Mutex
	deadline time.Time
	header   http.Header
	status   int
	count    int
}

func (w *blockedWriter) Header() http.Header {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}

func (w *blockedWriter) Write(payload []byte) (int, error) {
	w.mu.Lock()
	w.count++
	deadline := w.deadline
	w.mu.Unlock()
	if deadline.IsZero() {
		deadline = time.Now().Add(time.Second)
	}
	if wait := time.Until(deadline); wait > 0 {
		time.Sleep(wait)
	}
	return 0, os.ErrDeadlineExceeded
}

func (w *blockedWriter) WriteHeader(status int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.status = status
}

func (w *blockedWriter) Flush() {}

func (w *blockedWriter) SetWriteDeadline(deadline time.Time) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.deadline = deadline
	return nil
}

func (w *blockedWriter) writes() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.count
}
