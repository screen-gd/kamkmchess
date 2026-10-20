package integration

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
)

// onlineUpdatesServer serves the participant API over a real HTTP server, so
// the wire behaviour of the stream is exercised and not only the handler.
func onlineUpdatesServer(t *testing.T, fixture *onlineAuthFixture, options httpapi.OnlineOptions) *httptest.Server {
	t.Helper()
	options.AllowedOrigins = []string{authTestOrigin}
	handler := httpapi.CORSWithHeaders(
		[]string{authTestOrigin},
		httpapi.OnlineRequestHeaders,
		httpapi.NewOnline(fixture.service, fixture.authorizer, options),
	)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server
}

// updatesStreamRequest opens one live update stream.
func updatesStreamRequest(t *testing.T, server *httptest.Server, path string, headers map[string]string) *http.Response {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, server.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", authTestOrigin)
	request.Header.Set("Accept", "text/event-stream")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("open the update stream: %v", err)
	}
	return response
}

// updatesPollRequest asks for the canonical envelope once.
func updatesPollRequest(t *testing.T, server *httptest.Server, path string, headers map[string]string) *http.Response {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, server.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", authTestOrigin)
	request.Header.Set("Accept", "application/json")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("poll the updates: %v", err)
	}
	return response
}

// liveSSEFrame is one parsed frame of a live stream.
type liveSSEFrame struct {
	event   string
	id      string
	data    string
	comment string
}

// readLiveSSEFrame reads the next frame of a live stream.
//
// A comment frame is a heartbeat. The read returns as soon as the bytes
// arrive, so a frame that is read before the stream ends proves that the
// server flushed it.
func readLiveSSEFrame(reader *bufio.Reader) (liveSSEFrame, error) {
	var frame liveSSEFrame
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return frame, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			if frame.comment != "" || frame.event != "" || frame.data != "" {
				return frame, nil
			}
			continue
		}
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
}

// The polling fallback answers with the canonical envelope of the real
// match, and it never exposes a participant identity.
func TestPostgresOnlineUpdatesPollReturnsTheCanonicalEnvelope(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	issued := createGuestMatch(t, fixture, "match-updates-poll")
	server := onlineUpdatesServer(t, fixture, httpapi.OnlineOptions{})

	response := updatesPollRequest(t, server, "/v1/online/matches/match-updates-poll/updates", map[string]string{
		httpapi.GuestCredentialHeader: issued.Credential.Secret,
	})
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("poll status=%d", response.StatusCode)
	}
	var envelope struct {
		SchemaVersion int `json:"schemaVersion"`
		Cursor        int64
		Snapshot      struct {
			MatchID string `json:"matchId"`
			Version int64  `json:"version"`
			Moves   []any  `json:"moves"`
			Seats   []any  `json:"seats"`
		} `json:"snapshot"`
	}
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.SchemaVersion != httpapi.OnlineUpdatesSchemaVersion {
		t.Fatalf("schema version=%d", envelope.SchemaVersion)
	}
	if envelope.Cursor != 1 || envelope.Cursor != envelope.Snapshot.Version {
		t.Fatalf("cursor=%d snapshot version=%d", envelope.Cursor, envelope.Snapshot.Version)
	}
	if envelope.Snapshot.MatchID != "match-updates-poll" {
		t.Fatalf("snapshot match=%q", envelope.Snapshot.MatchID)
	}
	if envelope.Snapshot.Moves == nil || envelope.Snapshot.Seats == nil {
		t.Fatalf("the snapshot carries a null list: %+v", envelope.Snapshot)
	}
	body := make([]byte, 0)
	buffer := make([]byte, 4096)
	for {
		read, err := response.Body.Read(buffer)
		body = append(body, buffer[:read]...)
		if err != nil {
			break
		}
	}
	for _, forbidden := range []string{authGuestID, "user_a", "participantId", "ownerId", "credential", "sessionId"} {
		if strings.Contains(string(body), forbidden) {
			t.Fatalf("the envelope leaked %q: %s", forbidden, string(body))
		}
	}
}

// A live stream delivers the canonical snapshot on the wire, and it delivers
// the next version when the match advances. The first frame is read while
// the stream is still open, which proves that the server flushed it.
func TestPostgresOnlineUpdatesStreamDeliversTheCanonicalSnapshotAndTheNextVersion(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	issued := createGuestMatch(t, fixture, "match-updates-stream")
	server := onlineUpdatesServer(t, fixture, httpapi.OnlineOptions{
		UpdatesStreamMaxDuration: 5 * time.Second,
		UpdatesPollInterval:      50 * time.Millisecond,
	})
	response := updatesStreamRequest(t, server, "/v1/online/matches/match-updates-stream/updates", map[string]string{
		httpapi.GuestCredentialHeader: issued.Credential.Secret,
	})
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("stream status=%d", response.StatusCode)
	}
	if contentType := response.Header.Get("Content-Type"); contentType != "text/event-stream" {
		t.Fatalf("content type=%q", contentType)
	}
	reader := bufio.NewReader(response.Body)
	started := time.Now()
	first, err := readLiveSSEFrame(reader)
	if err != nil {
		t.Fatalf("read the first frame: %v", err)
	}
	if time.Since(started) > 2*time.Second {
		t.Fatalf("the first frame took %v, so the server buffered the stream", time.Since(started))
	}
	if first.event != "snapshot" || first.id != "1" {
		t.Fatalf("the first frame is %+v", first)
	}
	var envelope struct {
		SchemaVersion int `json:"schemaVersion"`
		Cursor        int64
		Snapshot      struct {
			Version int64 `json:"version"`
		} `json:"snapshot"`
	}
	if err = json.Unmarshal([]byte(first.data), &envelope); err != nil {
		t.Fatalf("the frame data is not the envelope: %v", err)
	}
	if envelope.SchemaVersion != httpapi.OnlineUpdatesSchemaVersion || envelope.Cursor != 1 || envelope.Cursor != envelope.Snapshot.Version {
		t.Fatalf("envelope=%+v", envelope)
	}

	// The other participant accepts a move. The stream reports the new
	// version with a replacement snapshot.
	principal := guestParticipant(t, fixture, issued)
	guestCtx := onlineauth.WithPrincipal(context.Background(), principal)
	if _, err = fixture.service.Execute(guestCtx, principal.Participant, moveOnlineCommand("match-updates-stream", "op-updates-move-1", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("submit the move: %v", err)
	}
	second, err := readLiveSSEFrame(reader)
	if err != nil {
		t.Fatalf("read the second frame: %v", err)
	}
	if second.event != "snapshot" || second.id != "2" {
		t.Fatalf("the second frame is %+v", second)
	}
	if err = json.Unmarshal([]byte(second.data), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Cursor != 2 || envelope.Cursor != envelope.Snapshot.Version {
		t.Fatalf("envelope=%+v", envelope)
	}
}

// A client that missed events converges on the current canonical snapshot.
// The missed event is not replayed, and the cursor never regresses.
func TestPostgresOnlineUpdatesConvergesAfterMissedEvents(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	issued := createGuestMatch(t, fixture, "match-updates-gap")
	server := onlineUpdatesServer(t, fixture, httpapi.OnlineOptions{
		UpdatesStreamMaxDuration: 2 * time.Second,
		UpdatesPollInterval:      50 * time.Millisecond,
	})
	credential := map[string]string{httpapi.GuestCredentialHeader: issued.Credential.Secret}

	first := updatesPollRequest(t, server, "/v1/online/matches/match-updates-gap/updates", credential)
	var envelope struct {
		Cursor   int64 `json:"cursor"`
		Snapshot struct {
			Version int64 `json:"version"`
			Moves   []any `json:"moves"`
		} `json:"snapshot"`
	}
	if err := json.NewDecoder(first.Body).Decode(&envelope); err != nil {
		t.Fatal(err)
	}
	first.Body.Close()
	if envelope.Cursor != 1 {
		t.Fatalf("the first cursor is %d", envelope.Cursor)
	}

	// Two moves are accepted while the client is away.
	principal := guestParticipant(t, fixture, issued)
	guestCtx := onlineauth.WithPrincipal(context.Background(), principal)
	if _, err := fixture.service.Execute(guestCtx, principal.Participant, moveOnlineCommand("match-updates-gap", "op-gap-move-1", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("submit the first move: %v", err)
	}

	// The client reconnects with its old cursor and receives the current
	// canonical snapshot, not a replay of the event it missed.
	reconnected := updatesPollRequest(t, server, "/v1/online/matches/match-updates-gap/updates", map[string]string{
		httpapi.GuestCredentialHeader: issued.Credential.Secret,
		"Last-Event-ID":               "1",
	})
	var converged struct {
		Cursor   int64 `json:"cursor"`
		Snapshot struct {
			Version int64 `json:"version"`
			Moves   []any `json:"moves"`
		} `json:"snapshot"`
	}
	if err := json.NewDecoder(reconnected.Body).Decode(&converged); err != nil {
		t.Fatal(err)
	}
	reconnected.Body.Close()
	if converged.Cursor != 2 || converged.Cursor != converged.Snapshot.Version {
		t.Fatalf("the converged cursor is %d", converged.Cursor)
	}
	if len(converged.Snapshot.Moves) != 1 {
		t.Fatalf("the replacement snapshot carries %d moves", len(converged.Snapshot.Moves))
	}
}

// A revoked credential ends the live stream, and the next request reports the
// refusal with a status code.
func TestPostgresOnlineUpdatesStreamEndsWhenTheCredentialIsRevoked(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	issued := createGuestMatch(t, fixture, "match-updates-revoked")
	server := onlineUpdatesServer(t, fixture, httpapi.OnlineOptions{
		UpdatesStreamMaxDuration: 5 * time.Second,
		UpdatesPollInterval:      50 * time.Millisecond,
	})
	response := updatesStreamRequest(t, server, "/v1/online/matches/match-updates-revoked/updates", map[string]string{
		httpapi.GuestCredentialHeader: issued.Credential.Secret,
	})
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	if _, err := readLiveSSEFrame(reader); err != nil {
		t.Fatalf("read the first frame: %v", err)
	}
	if err := fixture.authorizer.RevokeSeatCredential(context.Background(), issued.Credential.CredentialID, "owner_request"); err != nil {
		t.Fatal(err)
	}
	// The stream ends by itself. The reader sees the end of the body.
	ended := make(chan error, 1)
	go func() {
		for {
			_, err := readLiveSSEFrame(reader)
			if err != nil {
				ended <- err
				return
			}
		}
	}()
	select {
	case <-ended:
	case <-time.After(4 * time.Second):
		t.Fatal("the stream outlived the revoked credential")
	}
	// The next request is refused.
	refused := updatesPollRequest(t, server, "/v1/online/matches/match-updates-revoked/updates", map[string]string{
		httpapi.GuestCredentialHeader: issued.Credential.Secret,
	})
	defer refused.Body.Close()
	if refused.StatusCode != http.StatusUnauthorized {
		t.Fatalf("the revoked credential status=%d", refused.StatusCode)
	}
}

// The stream ends strictly before the expiry of the credential that opened
// it.
func TestPostgresOnlineUpdatesStreamEndsBeforeTheCredentialExpiry(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	ctx := accountContext("user_a", "session-alice")
	if _, err := fixture.service.Execute(ctx, online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_a"}, createOnlineCommand("match-updates-expiry", "op-updates-expiry-create")); err != nil {
		t.Fatalf("create the match: %v", err)
	}
	expiry := time.Now().Add(4 * time.Second)
	token := signSession(t, fixture.key, "user_a", "session-alice", expiry)
	server := onlineUpdatesServer(t, fixture, httpapi.OnlineOptions{
		UpdatesStreamMaxDuration: 30 * time.Second,
		UpdatesPollInterval:      50 * time.Millisecond,
	})
	started := time.Now()
	response := updatesStreamRequest(t, server, "/v1/online/matches/match-updates-expiry/updates", map[string]string{
		"Authorization": "Bearer " + token,
	})
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("stream status=%d", response.StatusCode)
	}
	reader := bufio.NewReader(response.Body)
	if _, err := readLiveSSEFrame(reader); err != nil {
		t.Fatalf("read the first frame: %v", err)
	}
	ended := make(chan error, 1)
	go func() {
		for {
			_, err := readLiveSSEFrame(reader)
			if err != nil {
				ended <- err
				return
			}
		}
	}()
	select {
	case <-ended:
	case <-time.After(expiry.Sub(time.Now()) + 2*time.Second):
		t.Fatal("the stream outlived the credential")
	}
	if elapsed := time.Since(started); elapsed >= expiry.Sub(started) {
		t.Fatalf("the stream ran for %v, which is not shorter than the credential", elapsed)
	}
}

// An idle stream holds no database connection. The pool is free while the
// stream waits for a change.
func TestPostgresOnlineUpdatesIdleStreamHoldsNoDatabaseConnection(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	issued := createGuestMatch(t, fixture, "match-updates-idle")
	server := onlineUpdatesServer(t, fixture, httpapi.OnlineOptions{
		UpdatesStreamMaxDuration: 600 * time.Millisecond,
		UpdatesPollInterval:      2 * time.Second,
		UpdatesHeartbeatInterval: 100 * time.Millisecond,
	})
	response := updatesStreamRequest(t, server, "/v1/online/matches/match-updates-idle/updates", map[string]string{
		httpapi.GuestCredentialHeader: issued.Credential.Secret,
	})
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	if _, err := readLiveSSEFrame(reader); err != nil {
		t.Fatalf("read the first frame: %v", err)
	}
	// No probe runs before the stream ends. Each assertion is during a
	// known idle wait, so it cannot race a brief pooled database read.
	for i := 0; i < 3; i++ {
		if acquired := fixture.pool.Stat().AcquiredConns(); acquired != 0 {
			t.Fatalf("the idle stream retained %d connections", acquired)
		}
		frame, err := readLiveSSEFrame(reader)
		if err != nil || frame.comment == "" {
			t.Fatalf("idle heartbeat %d: frame=%+v err=%v", i, frame, err)
		}
	}
	// The stream ends, and the pool is free again.
	for {
		_, err := readLiveSSEFrame(reader)
		if err != nil {
			break
		}
	}
	if acquired := int(fixture.pool.Stat().AcquiredConns()); acquired != 0 {
		t.Fatalf("the pool kept %d connections after the stream ended", acquired)
	}
}

// A duplicate acknowledgement never applies a move twice and never moves the
// cursor.
func TestPostgresOnlineUpdatesDuplicateAcknowledgementDoesNotAdvanceTheCursor(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	issued := createGuestMatch(t, fixture, "match-updates-duplicate")
	principal := guestParticipant(t, fixture, issued)
	guestCtx := onlineauth.WithPrincipal(context.Background(), principal)
	move := moveOnlineCommand("match-updates-duplicate", "op-updates-duplicate-1", online.SeatWhite, 1, "e2e4")
	if _, err := fixture.service.Execute(guestCtx, principal.Participant, move); err != nil {
		t.Fatalf("submit the move: %v", err)
	}
	duplicate, err := fixture.service.Execute(guestCtx, principal.Participant, move)
	if err != nil {
		t.Fatalf("repeat the move: %v", err)
	}
	if !duplicate.Duplicate {
		t.Fatal("the repeated move was not a duplicate")
	}
	server := onlineUpdatesServer(t, fixture, httpapi.OnlineOptions{
		UpdatesStreamMaxDuration: 1 * time.Second,
		UpdatesPollInterval:      50 * time.Millisecond,
	})
	response := updatesStreamRequest(t, server, "/v1/online/matches/match-updates-duplicate/updates", map[string]string{
		httpapi.GuestCredentialHeader: issued.Credential.Secret,
	})
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	first, err := readLiveSSEFrame(reader)
	if err != nil {
		t.Fatalf("read the first frame: %v", err)
	}
	if first.id != "2" {
		t.Fatalf("the cursor is %q, want the version after the move", first.id)
	}
	// The repeated move produced no second version, so the stream sends no
	// second snapshot.
	snapshots := 1
	for {
		frame, err := readLiveSSEFrame(reader)
		if err != nil {
			break
		}
		if frame.event == "snapshot" {
			snapshots++
			if frame.id != "2" {
				t.Fatalf("the stream sent the cursor %q", frame.id)
			}
		}
	}
	if snapshots != 1 {
		t.Fatalf("the stream sent %d snapshot events", snapshots)
	}
}

// The heartbeat is observable by a consumer on the wire, and it is a comment
// that never looks like a state change.
func TestPostgresOnlineUpdatesHeartbeatIsObservableOnTheWire(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	issued := createGuestMatch(t, fixture, "match-updates-heartbeat")
	server := onlineUpdatesServer(t, fixture, httpapi.OnlineOptions{
		UpdatesStreamMaxDuration: 2 * time.Second,
		UpdatesPollInterval:      100 * time.Millisecond,
		UpdatesHeartbeatInterval: 200 * time.Millisecond,
	})
	response := updatesStreamRequest(t, server, "/v1/online/matches/match-updates-heartbeat/updates", map[string]string{
		httpapi.GuestCredentialHeader: issued.Credential.Secret,
	})
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	first, err := readLiveSSEFrame(reader)
	if err != nil {
		t.Fatalf("read the first frame: %v", err)
	}
	if first.event != "snapshot" || first.comment != "" {
		t.Fatalf("the first frame is %+v", first)
	}
	heartbeat := false
	for {
		frame, err := readLiveSSEFrame(reader)
		if err != nil {
			break
		}
		if frame.comment == "" {
			continue
		}
		if !strings.HasPrefix(frame.comment, ":") {
			t.Fatalf("the heartbeat is not a comment: %q", frame.comment)
		}
		if frame.event != "" || frame.data != "" {
			t.Fatalf("the heartbeat carries an event: %+v", frame)
		}
		heartbeat = true
		break
	}
	if !heartbeat {
		t.Fatal("the consumer never saw a heartbeat")
	}
}

// The heartbeat keeps the stream observable on the wire. The gap between two
// consecutive frames never exceeds the heartbeat interval and a tolerance.
func TestPostgresOnlineUpdatesHeartbeatGapStaysBounded(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	issued := createGuestMatch(t, fixture, "match-updates-heartbeat-gap")
	const heartbeat = 300 * time.Millisecond
	server := onlineUpdatesServer(t, fixture, httpapi.OnlineOptions{
		UpdatesStreamMaxDuration: 2 * time.Second,
		UpdatesPollInterval:      100 * time.Millisecond,
		UpdatesHeartbeatInterval: heartbeat,
	})
	response := updatesStreamRequest(t, server, "/v1/online/matches/match-updates-heartbeat-gap/updates", map[string]string{
		httpapi.GuestCredentialHeader: issued.Credential.Secret,
	})
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	last := time.Now()
	longest := time.Duration(0)
	frames := 0
	for {
		_, err := readLiveSSEFrame(reader)
		if err != nil {
			break
		}
		now := time.Now()
		if gap := now.Sub(last); gap > longest {
			longest = gap
		}
		last = now
		frames++
	}
	if frames < 4 {
		t.Fatalf("the stream carried %d frames", frames)
	}
	if longest > 2*heartbeat {
		t.Fatalf("the longest gap between frames was %v, want at most %v", longest, 2*heartbeat)
	}
}

// A member that presents a cursor it cannot state exactly is refused, and a
// member that presents a stale cursor still receives the current snapshot.
func TestPostgresOnlineUpdatesCursorValidation(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	issued := createGuestMatch(t, fixture, "match-updates-cursor")
	server := onlineUpdatesServer(t, fixture, httpapi.OnlineOptions{})

	malformed := updatesPollRequest(t, server, "/v1/online/matches/match-updates-cursor/updates", map[string]string{
		httpapi.GuestCredentialHeader: issued.Credential.Secret,
		"Last-Event-ID":               "not-a-cursor",
	})
	malformed.Body.Close()
	if malformed.StatusCode != http.StatusBadRequest {
		t.Fatalf("a malformed cursor status=%d", malformed.StatusCode)
	}
	stale := updatesPollRequest(t, server, "/v1/online/matches/match-updates-cursor/updates", map[string]string{
		httpapi.GuestCredentialHeader: issued.Credential.Secret,
		"Last-Event-ID":               "1",
	})
	defer stale.Body.Close()
	if stale.StatusCode != http.StatusOK {
		t.Fatalf("a stale cursor status=%d", stale.StatusCode)
	}
	var envelope struct {
		Cursor int64 `json:"cursor"`
	}
	if err := json.NewDecoder(stale.Body).Decode(&envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Cursor != 1 {
		t.Fatalf("the cursor is %d", envelope.Cursor)
	}
}

// A participant that is not a member of the match cannot open a stream.
func TestPostgresOnlineUpdatesKeepsForeignParticipantsOut(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	createGuestMatch(t, fixture, "match-updates-foreign")
	server := onlineUpdatesServer(t, fixture, httpapi.OnlineOptions{})
	foreign := updatesPollRequest(t, server, "/v1/online/matches/match-updates-foreign/updates", map[string]string{
		httpapi.GuestCredentialHeader: "kmgc1_not-a-real-credential",
	})
	defer foreign.Body.Close()
	if foreign.StatusCode != http.StatusUnauthorized {
		t.Fatalf("an unknown credential status=%d", foreign.StatusCode)
	}
	anonymous := updatesPollRequest(t, server, "/v1/online/matches/match-updates-foreign/updates", nil)
	defer anonymous.Body.Close()
	if anonymous.StatusCode != http.StatusUnauthorized {
		t.Fatalf("an anonymous request status=%d", anonymous.StatusCode)
	}
}

// The error of a refused stream is a status code and never a body that leaks
// a detail.
func TestPostgresOnlineUpdatesRefusalCarriesNoDetail(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	createGuestMatch(t, fixture, "match-updates-detail")
	server := onlineUpdatesServer(t, fixture, httpapi.OnlineOptions{})
	response := updatesPollRequest(t, server, "/v1/online/matches/match-updates-detail/updates", map[string]string{
		httpapi.GuestCredentialHeader: "kmgc1_not-a-real-credential",
	})
	defer response.Body.Close()
	body := make([]byte, 512)
	read, _ := response.Body.Read(body)
	text := string(body[:read])
	if strings.Contains(text, "kmgc1") || strings.Contains(text, "postgres") {
		t.Fatalf("the refusal leaked a detail: %s", text)
	}
	if !strings.Contains(text, "unauthorized") {
		t.Fatalf("the refusal body is %s", text)
	}
}
