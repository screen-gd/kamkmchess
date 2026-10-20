package integration

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/auth"
	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/storage"
	"github.com/jackc/pgx/v5/pgxpool"
)

const databaseEnv = "KHA41_TEST_DATABASE_URL"

// randomSchemaSuffix returns a short random suffix for an isolated test
// schema name.
func randomSchemaSuffix() string {
	var raw [4]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "fallback"
	}
	return hex.EncodeToString(raw[:])
}

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv(databaseEnv)
	if dsn == "" {
		if os.Getenv("KHA41_REQUIRE_POSTGRES") == "1" {
			t.Fatalf("%s is required", databaseEnv)
		}
		t.Skipf("PostgreSQL integration unavailable: set %s (set KHA41_REQUIRE_POSTGRES=1 to make this fatal)", databaseEnv)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect isolated PostgreSQL: %v", err)
	}
	if err = admin.Ping(ctx); err != nil {
		admin.Close()
		t.Fatalf("ping isolated PostgreSQL: %v", err)
	}
	// The isolated schema name must be unique even when two test processes
	// run against the same database at the same time. The host wall clock
	// has a coarse resolution on some systems, so the name carries a random
	// suffix instead of relying on the timestamp alone.
	schema := fmt.Sprintf("kha41_%d_%s", time.Now().UnixNano(), randomSchemaSuffix())
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatalf("create test schema: %v", err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE"); admin.Close() })
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	migration, err := os.ReadFile("../migrations/0001_storage.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range strings.Split(string(migration), ";") {
		if strings.TrimSpace(statement) == "" {
			continue
		}
		if _, err = pool.Exec(ctx, statement); err != nil {
			t.Fatalf("apply isolated migration: %v", err)
		}
	}
	return pool
}

func openStore(t *testing.T) *storage.Store {
	t.Helper()
	s, err := storage.Open(context.Background(), testPool(t))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// checkpoint produces a complete GameCheckpointV1 fixture matching the browser
// storage fixture's public DTO, with an account namespace bound to the owner.
func checkpoint(id, owner string, revision, epoch int, result any) []byte {
	v := map[string]any{
		"schemaVersion": 1, "gameId": id, "namespace": map[string]any{"kind": "account", "accountId": owner},
		"revision": revision, "ownershipEpoch": epoch, "segmentId": "segment-1", "positionRevision": revision,
		"requestGeneration": 2, "analysisGeneration": 1, "updatedAtMs": 100,
		"rules": map[string]any{
			"variant": "orthodox", "startingFen": "start-fen", "currentFen": "current-fen", "sideToMove": "white",
			"castlingRights": "KQkq", "enPassantSquare": nil, "halfmoveClock": "0", "fullmoveNumber": "1",
			"repetitionLedger": map[string]any{"version": 1, "positions": []any{map[string]any{"identity": "position:full-state", "occurrences": "1"}}},
			"moves":            []any{},
		},
		"history": map[string]any{"currentSegmentId": "segment-1", "segments": []any{}, "messages": []any{}},
		"clocks": map[string]any{"schemaVersion": 1, "timeControl": map[string]any{"startingTimeMs": 900000, "incrementMs": 0},
			"banksAtAnchor": map[string]any{"whiteMs": 900000, "blackMs": 900000}, "activeSide": nil, "anchor": nil, "lastReconciledAtMs": 100},
		"budgets":    map[string]any{"formattingCorrectionsRemaining": 1, "illegalMoveAttemptsRemaining": map[string]any{"white": 3, "black": 3}, "manualRetriesBySide": map[string]any{"white": 0, "black": 0}},
		"selections": map[string]any{"players": map[string]any{"white": map[string]any{"kind": "human"}, "black": map[string]any{"kind": "human"}}},
		"archive":    map[string]any{"egressStatus": "eligible", "currentLine": map[string]any{"lineId": "line-current", "eventIds": []any{}}, "discardedLines": []any{}},
		"result":     result,
		"practice":   map[string]any{"mode": "ordinary", "scored": true, "sourceGameId": nil, "sourcePositionFen": nil, "originalResult": nil},
		"extensions": map[string]any{},
	}
	b, _ := json.Marshal(v)
	return b
}

func newGame(t *testing.T, s *storage.Store, id, owner string) storage.Game {
	t.Helper()
	g, err := s.Create(context.Background(), owner, storage.CreateGame{GameID: id, CheckpointJSON: checkpoint(id, owner, 1, 1, map[string]any{"kind": "unresolved"})})
	if err != nil {
		t.Fatal(err)
	}
	return g
}
func commitReq(id, owner, op string, rev, epoch int, localRevision int, result any, chunks ...storage.ArchiveChunk) storage.CommitRequest {
	return storage.CommitRequest{GameID: id, OperationID: op, ExpectedRevision: int64(rev), ExpectedEpoch: int64(epoch), CheckpointJSON: checkpoint(id, owner, localRevision, 1, result), Archives: chunks}
}

func archiveChunkDTO(gameID string, sequence int, body string) storage.ArchiveChunk {
	data := []byte(body)
	inner := sha256.Sum256(data)
	dto, _ := json.Marshal(map[string]any{
		"chunkId": fmt.Sprintf("chunk-%d", sequence), "gameId": gameID, "sequence": sequence,
		"receivedAtMs": 120 + sequence, "isFinal": true, "egressStatus": "eligible",
		"bytesBase64": base64.StdEncoding.EncodeToString(data), "sha256": fmt.Sprintf("%x", inner[:]),
	})
	outer := sha256.Sum256(dto)
	return storage.ArchiveChunk{Sequence: int64(sequence), RawJSON: dto, SHA256: fmt.Sprintf("%x", outer[:])}
}

func archiveEventDTO(gameID string, sequence int, chunkID string) storage.ArchiveEvent {
	chunkIDs := []string{}
	if chunkID != "" {
		chunkIDs = append(chunkIDs, chunkID)
	}
	dto, _ := json.Marshal(map[string]any{"eventId": fmt.Sprintf("event-%d", sequence), "gameId": gameID, "sequence": sequence, "segmentId": "segment-1", "kind": "provider-response", "occurredAtMs": 123, "receiveState": "complete", "egressStatus": "eligible", "payload": map[string]any{"token": "untrusted provider content"}, "chunkIds": chunkIDs})
	return storage.ArchiveEvent{Sequence: int64(sequence), RawJSON: dto}
}

func TestPostgresAuthenticatedArchiveBatchExactRoundTripAndValidation(t *testing.T) {
	pool := testPool(t)
	s, err := storage.Open(context.Background(), pool)
	if err != nil {
		t.Fatal(err)
	}
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	jwks := fmt.Sprintf(`{"keys":[{"kty":"RSA","kid":"test-key","use":"sig","alg":"RS256","n":"%s","e":"AQAB"}]}`, base64.RawURLEncoding.EncodeToString(priv.N.Bytes()))
	verifier, err := auth.NewVerifier(auth.Config{Issuer: "https://clerk.example", JWKSURL: "https://clerk.example/.well-known/jwks.json", AuthorizedParties: []string{"https://app.example"}, AllowedOrigins: []string{"https://app.example"}, HTTPClient: &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(jwks)), Header: make(http.Header)}, nil
	})}})
	if err != nil {
		t.Fatal(err)
	}
	handler := httpapi.NewAuthenticated(s, verifier)
	gameID, owner := "batch-game", "user_a"
	created := requestAPI(t, handler, http.MethodPost, "/v1/games", sign(t, priv, owner), fmt.Sprintf(`{"gameId":%q,"checkpoint":%s}`, gameID, checkpoint(gameID, owner, 1, 1, map[string]any{"kind": "unresolved"})))
	if created.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	chunk := archiveChunkDTO(gameID, 0, "provider bytes \x00\xff")
	event := archiveEventDTO(gameID, 0, "chunk-0")
	// The event's arbitrary payload is untrusted content; a field named token is not configuration.
	cp := checkpoint(gameID, owner, 2, 1, map[string]any{"kind": "unresolved"})
	var cpObj map[string]any
	_ = json.Unmarshal(cp, &cpObj)
	archive := cpObj["archive"].(map[string]any)
	archive["currentLine"].(map[string]any)["eventIds"] = []string{"event-0"}
	cp, _ = json.Marshal(cpObj)
	batch := fmt.Sprintf(`{"format":"kamkmchess.cloud-archive-batch","schemaVersion":1,"gameId":%q,"baseRevision":1,"baseOwnershipEpoch":1,"checkpointRevision":2,"eventsAfterSequence":null,"eventsThroughSequence":0,"chunksAfterSequence":null,"chunksThroughSequence":0,"events":[%s],"chunks":[%s]}`, gameID, event.RawJSON, chunk.RawJSON)
	commitBody := fmt.Sprintf(`{"operationId":"batch-op","expectedRevision":1,"expectedEpoch":1,"checkpoint":%s,"archiveBatch":%s}`, cp, batch)
	foreignCheckpoint := checkpoint(gameID, "user_b", 2, 1, map[string]any{"kind": "unresolved"})
	foreignBody := fmt.Sprintf(`{"operationId":"foreign-op","expectedRevision":1,"expectedEpoch":1,"checkpoint":%s,"archiveBatch":%s}`, foreignCheckpoint, batch)
	for _, action := range []struct{ method, path, body string }{{http.MethodPost, "/v1/games/" + gameID + "/commit", foreignBody}, {http.MethodPost, "/v1/games/" + gameID + "/takeover", `{"expectedRevision":1,"expectedEpoch":1}`}, {http.MethodDelete, "/v1/games/" + gameID, `{"expectedRevision":1,"expectedEpoch":1}`}} {
		w := requestAPI(t, handler, action.method, action.path, sign(t, priv, "user_b"), action.body)
		if w.Code != http.StatusNotFound {
			t.Errorf("foreign owner %s %s status=%d body=%s", action.method, action.path, w.Code, w.Body.String())
		}
	}
	committed := requestAPI(t, handler, http.MethodPost, "/v1/games/"+gameID+"/commit", sign(t, priv, owner), commitBody)
	if committed.Code != http.StatusOK {
		t.Fatalf("commit status=%d body=%s", committed.Code, committed.Body.String())
	}
	got := requestAPI(t, handler, http.MethodGet, "/v1/games/"+gameID+"/archive-batch", sign(t, priv, owner), "")
	if got.Code != http.StatusOK {
		t.Fatalf("archive fetch status=%d body=%s", got.Code, got.Body.String())
	}
	var envelope struct {
		Format string            `json:"format"`
		Events []json.RawMessage `json:"events"`
		Chunks []json.RawMessage `json:"chunks"`
	}
	if err = json.Unmarshal(got.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Format != "kamkmchess.cloud-archive-batch" {
		t.Fatalf("unexpected archive format %q: %s", envelope.Format, got.Body.String())
	}
	if len(envelope.Events) != 1 || !bytes.Equal(envelope.Events[0], event.RawJSON) || len(envelope.Chunks) != 1 || !bytes.Equal(envelope.Chunks[0], chunk.RawJSON) {
		t.Fatalf("archive DTO bytes changed: events=%q chunks=%q", envelope.Events, envelope.Chunks)
	}
	for _, path := range []string{"/v1/games/" + gameID, "/v1/games/" + gameID + "/archives", "/v1/games/" + gameID + "/events", "/v1/games/" + gameID + "/archive-batch", "/v1/games/" + gameID + "/operations/batch-op"} {
		w := requestAPI(t, handler, http.MethodGet, path, sign(t, priv, "user_b"), "")
		if w.Code != http.StatusNotFound {
			t.Errorf("foreign owner GET %s status=%d", path, w.Code)
		}
	}
	// A separate event reference that has no matching accepted event must reject creation.
	danglingID := "dangling-game"
	dangling := checkpoint(danglingID, owner, 1, 1, map[string]any{"kind": "unresolved"})
	_ = json.Unmarshal(dangling, &cpObj)
	cpObj["archive"].(map[string]any)["currentLine"].(map[string]any)["eventIds"] = []any{"missing-event"}
	dangling, _ = json.Marshal(cpObj)
	w := requestAPI(t, handler, http.MethodPost, "/v1/games", sign(t, priv, owner), fmt.Sprintf(`{"gameId":%q,"checkpoint":%s}`, danglingID, dangling))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("create imported dangling event refs: status=%d body=%s", w.Code, w.Body.String())
	}
	// Configuration secrets remain forbidden in checkpoint data.
	secretID := "secret-game"
	secret := checkpoint(secretID, owner, 1, 1, map[string]any{"kind": "unresolved"})
	_ = json.Unmarshal(secret, &cpObj)
	cpObj["apiKey"] = "secret"
	secret, _ = json.Marshal(cpObj)
	w = requestAPI(t, handler, http.MethodPost, "/v1/games", sign(t, priv, owner), fmt.Sprintf(`{"gameId":%q,"checkpoint":%s}`, secretID, secret))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("create imported config secret: status=%d", w.Code)
	}
	deleted := requestAPI(t, handler, http.MethodDelete, "/v1/games/"+gameID, sign(t, priv, owner), `{"expectedRevision":2,"expectedEpoch":1}`)
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("owner delete status=%d body=%s", deleted.Code, deleted.Body.String())
	}
	for _, path := range []string{"/v1/games/" + gameID + "/archives", "/v1/games/" + gameID + "/events", "/v1/games/" + gameID + "/archive-batch"} {
		w := requestAPI(t, handler, http.MethodGet, path, sign(t, priv, owner), "")
		if w.Code != http.StatusNotFound {
			t.Errorf("read deleted payload %s status=%d body=%s", path, w.Code, w.Body.String())
		}
	}
	receipt := requestAPI(t, handler, http.MethodGet, "/v1/games/"+gameID+"/operations/batch-op", sign(t, priv, owner), "")
	if receipt.Code != http.StatusOK || strings.Contains(receipt.Body.String(), "checkpoint") || strings.Contains(receipt.Body.String(), "provider bytes") {
		t.Fatalf("deleted receipt leaked payload: status=%d body=%s", receipt.Code, receipt.Body.String())
	}
	repeated := requestAPI(t, handler, http.MethodDelete, "/v1/games/"+gameID, sign(t, priv, owner), `{"expectedRevision":2,"expectedEpoch":1}`)
	if repeated.Code != http.StatusNoContent {
		t.Fatalf("repeated owner delete status=%d", repeated.Code)
	}
}

func TestPostgresCheckpointAcceptsRetainedAndDiscardedModelHistory(t *testing.T) {
	s := openStore(t)
	id, owner := "history-game", "history-owner"
	var cp map[string]any
	if err := json.Unmarshal(checkpoint(id, owner, 1, 1, map[string]any{"kind": "unresolved"}), &cp); err != nil {
		t.Fatal(err)
	}
	cp["history"] = map[string]any{
		"currentSegmentId": "segment-1",
		"segments":         []any{map[string]any{"segmentId": "segment-1", "providerId": "openai", "modelRoutingId": "model-x", "connectionRevision": 1, "startedAtMs": 100, "messageIds": []any{"retained-message", "discarded-message"}}},
		"messages": []any{
			map[string]any{"messageId": "retained-message", "segmentId": "segment-1", "lineId": "line-current", "role": "assistant", "content": "Model transcript mentions token as ordinary text.", "eventIds": []any{}, "disposition": "retained"},
			map[string]any{"messageId": "discarded-message", "segmentId": "segment-1", "lineId": "line-old", "role": "user", "content": "A prior user message.", "eventIds": []any{}, "disposition": "discarded"},
		},
	}
	archive := cp["archive"].(map[string]any)
	archive["discardedLines"] = []any{map[string]any{"lineId": "line-old", "eventIds": []any{}, "discardedAtRevision": 1, "reason": "undo"}}
	raw, err := json.Marshal(cp)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Create(context.Background(), owner, storage.CreateGame{GameID: id, CheckpointJSON: raw}); err != nil {
		t.Fatalf("create valid model history: %v", err)
	}
}

func requestAPI(t *testing.T, h http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Origin", "https://app.example")
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

func TestPostgresOwnerIsolationAndAuthenticatedHTTP(t *testing.T) {
	pool := testPool(t)
	s, err := storage.Open(context.Background(), pool)
	if err != nil {
		t.Fatal(err)
	}
	newGame(t, s, "owner-game", "user_a")
	if _, err := s.Create(context.Background(), "user_a", storage.CreateGame{GameID: "wrong-namespace", CheckpointJSON: checkpoint("wrong-namespace", "user_b", 1, 1, map[string]any{"kind": "unresolved"})}); !errors.Is(err, storage.ErrInvalidDTO) {
		t.Fatalf("mismatched checkpoint owner=%v, want ErrInvalidDTO", err)
	}
	var secretCheckpoint map[string]any
	if err := json.Unmarshal(checkpoint("secret-field", "user_a", 1, 1, map[string]any{"kind": "unresolved"}), &secretCheckpoint); err != nil {
		t.Fatal(err)
	}
	secretCheckpoint["apiKey"] = "must-not-persist"
	secretJSON, _ := json.Marshal(secretCheckpoint)
	if _, err := s.Create(context.Background(), "user_a", storage.CreateGame{GameID: "secret-field", CheckpointJSON: secretJSON}); !errors.Is(err, storage.ErrInvalidDTO) {
		t.Fatalf("secret-bearing checkpoint field=%v, want ErrInvalidDTO", err)
	}
	if _, err := s.Get(context.Background(), "user_b", "owner-game"); !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("other owner get = %v, want ErrNotFound", err)
	}
	if _, err := s.List(context.Background(), "user_b", storage.Page{Limit: 20}); err != nil {
		t.Fatal(err)
	}
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	jwks := fmt.Sprintf(`{"keys":[{"kty":"RSA","kid":"test-key","use":"sig","alg":"RS256","n":"%s","e":"AQAB"}]}`, base64.RawURLEncoding.EncodeToString(priv.N.Bytes()))
	transport := roundTrip(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(jwks)), Header: make(http.Header)}, nil
	})
	verifier, err := auth.NewVerifier(auth.Config{Issuer: "https://clerk.example", JWKSURL: "https://clerk.example/.well-known/jwks.json", AuthorizedParties: []string{"https://app.example"}, AllowedOrigins: []string{"https://app.example"}, HTTPClient: &http.Client{Transport: transport}})
	if err != nil {
		t.Fatal(err)
	}
	handler := httpapi.NewAuthenticated(s, verifier)
	for _, tc := range []struct {
		name, token string
		want        int
	}{
		{"unauthenticated", "", http.StatusUnauthorized},
		{"foreign owner", sign(t, priv, "user_b"), http.StatusNotFound},
		{"actual owner", sign(t, priv, "user_a"), http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/v1/games/owner-game", nil)
			if tc.token != "" {
				req.Header.Set("Authorization", "Bearer "+tc.token)
			}
			req.Header.Set("Origin", "https://app.example")
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)
			if w.Code != tc.want {
				t.Fatalf("GET status=%d want=%d body=%s", w.Code, tc.want, w.Body.String())
			}
			if strings.Contains(strings.ToLower(w.Body.String()), "ownerid") {
				t.Fatalf("HTTP DTO exposed owner: %s", w.Body.String())
			}
		})
	}
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func sign(t *testing.T, key *rsa.PrivateKey, sub string) string {
	t.Helper()
	enc := func(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }
	h := enc([]byte(`{"alg":"RS256","kid":"test-key","typ":"JWT"}`))
	p := enc([]byte(fmt.Sprintf(`{"iss":"https://clerk.example","sub":%q,"sid":"session_test","azp":"https://app.example","exp":%d,"token_use":"session"}`, sub, time.Now().Add(time.Hour).Unix())))
	input := h + "." + p
	digest := sha256.Sum256([]byte(input))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return input + "." + enc(sig)
}

func TestPostgresRevisionEpochCASAndConcurrentTakeover(t *testing.T) {
	s := openStore(t)
	newGame(t, s, "cas-game", "owner")
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.Takeover(context.Background(), "owner", storage.CASRequest{GameID: "cas-game", ExpectedRevision: 1, ExpectedEpoch: 1})
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	successes, conflicts := 0, 0
	for err := range errs {
		if err == nil {
			successes++
		} else if errors.Is(err, storage.ErrConflict) {
			conflicts++
		} else {
			t.Fatalf("Takeover error: %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("CAS outcomes success=%d conflicts=%d; want 1 each", successes, conflicts)
	}
	if _, err := s.Commit(context.Background(), "owner", commitReq("cas-game", "owner", "stale", 1, 1, 9, map[string]any{"kind": "unresolved"})); !errors.Is(err, storage.ErrConflict) {
		t.Fatalf("old revision+epoch commit=%v, want ErrConflict", err)
	}
	if _, err := s.Commit(context.Background(), "owner", commitReq("cas-game", "owner", "stale-revision", 1, 2, 9, map[string]any{"kind": "unresolved"})); !errors.Is(err, storage.ErrConflict) {
		t.Fatalf("stale revision with current epoch=%v, want ErrConflict", err)
	}
	if _, err := s.Commit(context.Background(), "owner", commitReq("cas-game", "owner", "stale-epoch", 2, 1, 9, map[string]any{"kind": "unresolved"})); !errors.Is(err, storage.ErrConflict) {
		t.Fatalf("stale epoch with current revision=%v, want ErrConflict", err)
	}
	g, err := s.Get(context.Background(), "owner", "cas-game")
	if err != nil {
		t.Fatal(err)
	}
	if g.Revision != 2 || g.Epoch != 2 {
		t.Fatalf("takeover cloud metadata revision=%d epoch=%d", g.Revision, g.Epoch)
	}
	var checkpointEpoch int
	var checkpointRevision int
	_ = json.Unmarshal(g.CheckpointJSON, &struct {
		Revision       *int `json:"revision"`
		OwnershipEpoch *int `json:"ownershipEpoch"`
	}{Revision: &checkpointRevision, OwnershipEpoch: &checkpointEpoch})
	if checkpointRevision != 1 || checkpointEpoch != 1 {
		t.Fatalf("takeover rewrote acknowledged checkpoint revision/epoch to %d/%d", checkpointRevision, checkpointEpoch)
	}
}

func TestPostgresIdempotentRetryLookupAndOperationIDReuse(t *testing.T) {
	s := openStore(t)
	newGame(t, s, "retry-game", "owner")
	r := commitReq("retry-game", "owner", "op-1", 1, 1, 41, map[string]any{"kind": "unresolved"})
	var wg sync.WaitGroup
	results := make(chan storage.CommitResult, 2)
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); v, e := s.Commit(context.Background(), "owner", r); results <- v; errs <- e }()
	}
	wg.Wait()
	close(results)
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatalf("same-operation concurrent retry: %v", e)
		}
	}
	accepted := 0
	duplicate := 0
	var receipt *storage.Operation
	for v := range results {
		if v.Duplicate {
			duplicate++
		} else {
			accepted++
		}
		if receipt == nil {
			receipt = &v.Operation
		} else if v.Operation.ID != receipt.ID || v.Operation.GameID != receipt.GameID || v.Operation.Revision != receipt.Revision || v.Operation.Epoch != receipt.Epoch || !v.Operation.AcceptedAt.Equal(receipt.AcceptedAt) || !bytes.Equal(v.Operation.RequestHash, receipt.RequestHash) || !bytes.Equal(v.Operation.ResultJSON, receipt.ResultJSON) {
			t.Fatal("concurrent identical retries returned different accepted receipts")
		}
	}
	if accepted != 1 || duplicate != 1 {
		t.Fatalf("retry outcomes accepted=%d duplicate=%d", accepted, duplicate)
	}
	lookup, err := s.LookupOperation(context.Background(), "owner", "retry-game", "op-1")
	if err != nil {
		t.Fatal(err)
	}
	if lookup.Revision != 2 || len(lookup.ResultJSON) == 0 {
		t.Fatalf("lookup missing receipt: revision=%d epoch=%d resultBytes=%d", lookup.Revision, lookup.Epoch, len(lookup.ResultJSON))
	}
	conflicting := commitReq("retry-game", "owner", "op-1", 1, 1, 42, map[string]any{"kind": "final", "winner": "draw", "reason": "stalemate", "eventId": "e", "decidedAtMs": 2})
	if _, err = s.Commit(context.Background(), "owner", conflicting); !errors.Is(err, storage.ErrOperationReuse) {
		t.Fatalf("conflicting operation reuse=%v", err)
	}
}

func TestPostgresFinalResultImmutableAndDeleteTombstone(t *testing.T) {
	s := openStore(t)
	newGame(t, s, "final-game", "owner")
	final := map[string]any{"kind": "final", "winner": "white", "reason": "resignation", "eventId": "result-1", "decidedAtMs": 10}
	finalRequest := commitReq("final-game", "owner", "final", 1, 1, 41, final, archiveChunkDTO("final-game", 2, "remove on owner deletion"))
	if _, err := s.Commit(context.Background(), "owner", finalRequest); err != nil {
		t.Fatal(err)
	}
	changed := map[string]any{"kind": "final", "winner": "black", "reason": "resignation", "eventId": "result-2", "decidedAtMs": 11}
	if _, err := s.Commit(context.Background(), "owner", commitReq("final-game", "owner", "rewrite", 2, 1, 44, changed)); !errors.Is(err, storage.ErrInvalidDTO) {
		t.Fatalf("rewrite final result=%v, want ErrInvalidDTO", err)
	}
	if err := s.Delete(context.Background(), "owner", storage.CASRequest{GameID: "final-game", ExpectedRevision: 2, ExpectedEpoch: 1}); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(context.Background(), "owner", storage.CASRequest{GameID: "final-game", ExpectedRevision: 2, ExpectedEpoch: 1}); err != nil {
		t.Fatalf("idempotent repeated delete: %v", err)
	}
	if _, err := s.Create(context.Background(), "owner", storage.CreateGame{GameID: "final-game", CheckpointJSON: checkpoint("final-game", "owner", 1, 1, map[string]any{"kind": "unresolved"})}); !errors.Is(err, storage.ErrDeleted) {
		t.Fatalf("stale create resurrected game: %v", err)
	}
	if _, err := s.Commit(context.Background(), "owner", commitReq("final-game", "owner", "stale-delete", 2, 1, 45, final)); !errors.Is(err, storage.ErrDeleted) {
		t.Fatalf("stale commit after delete=%v", err)
	}
	if _, err := s.Get(context.Background(), "owner", "final-game"); !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("deleted game fetch=%v", err)
	}
	if chunks, err := s.ReadArchives(context.Background(), "owner", "final-game", -1, 10); !errors.Is(err, storage.ErrNotFound) || len(chunks) != 0 {
		t.Fatalf("deleted archive read returned %d chunks, err=%v", len(chunks), err)
	}
	if receipt, err := s.LookupOperation(context.Background(), "owner", "final-game", "final"); err == nil && len(receipt.ResultJSON) != 0 && strings.Contains(string(receipt.ResultJSON), "checkpoint") {
		t.Fatal("deleted operation receipt retained checkpoint payload")
	}
	if _, err := s.Commit(context.Background(), "owner", finalRequest); !errors.Is(err, storage.ErrDeleted) {
		t.Fatalf("retry after deletion must not return old game: %v", err)
	}
}

func TestPostgresInvalidArchiveRollsBackCheckpointAndReceipt(t *testing.T) {
	s := openStore(t)
	newGame(t, s, "rollback-game", "owner")
	chunk := archiveChunkDTO("rollback-game", 1, "exact archive bytes")
	r := commitReq("rollback-game", "owner", "rollback-op", 1, 1, 42, map[string]any{"kind": "unresolved"}, chunk, chunk)
	if _, err := s.Commit(context.Background(), "owner", r); err == nil {
		t.Fatal("duplicate archive sequence accepted")
	}
	g, err := s.Get(context.Background(), "owner", "rollback-game")
	if err != nil {
		t.Fatal(err)
	}
	if g.Revision != 1 {
		t.Fatalf("failed archive advanced cloud revision to %d", g.Revision)
	}
	if _, err := s.LookupOperation(context.Background(), "owner", "rollback-game", "rollback-op"); !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("failed transaction left operation receipt: %v", err)
	}
	if chunks, err := s.ReadArchives(context.Background(), "owner", "rollback-game", -1, 10); err != nil || len(chunks) != 0 {
		t.Fatalf("failed transaction left %d archive chunks, err=%v", len(chunks), err)
	}
}

func TestPostgresArchiveReadPreservesExactChunkDTOBytes(t *testing.T) {
	s := openStore(t)
	newGame(t, s, "archive-game", "owner")
	first := archiveChunkDTO("archive-game", 4, "first raw provider chunk\x00\xff")
	second := archiveChunkDTO("archive-game", 9, "second raw provider chunk")
	request := commitReq("archive-game", "owner", "archive-op", 1, 1, 42, map[string]any{"kind": "unresolved"}, first, second)
	if _, err := s.Commit(context.Background(), "owner", request); err != nil {
		t.Fatalf("accept complete ArchiveChunkV1 DTOs: %v", err)
	}
	got, err := s.ReadArchives(context.Background(), "owner", "archive-game", -1, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Sequence != first.Sequence || got[1].Sequence != second.Sequence {
		t.Fatalf("archive read sequence/order = %#v", got)
	}
	for i, want := range []storage.ArchiveChunk{first, second} {
		if !bytes.Equal(got[i].RawJSON, want.RawJSON) || got[i].SHA256 != want.SHA256 {
			t.Fatalf("archive %d changed on read: rawEqual=%v hash=%q wantHash=%q", i, bytes.Equal(got[i].RawJSON, want.RawJSON), got[i].SHA256, want.SHA256)
		}
	}
	if _, err := s.ReadArchives(context.Background(), "another-owner", "archive-game", -1, 10); !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("archive read for non-owner = %v, want ErrNotFound", err)
	}
}
