package rulesworker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const fakeWorkerScript = `
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

function facts(timeoutWinner = null) {
  return {
    inCheck: false,
    hasLegalMoves: true,
    checkmate: false,
    stalemate: false,
    insufficientMaterial: false,
    repetitionCount: '1',
    thirdRepetition: false,
    hundredHalfmoves: false,
    deadness: 'not-assessed',
    ending: 'none',
    material: {
      white: { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 },
      black: { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 },
      total: 32,
    },
    timeoutWinner,
  };
}

// Mirrors inputFingerprint() in src/online-rules-worker/protocol.ts so the Go
// client's recomputation is checked against real JSON.stringify bytes.
function fingerprint(req, override = {}) {
  const intent = 'intent' in override ? override.intent : req.intent;
  const history = 'history' in override ? override.history : req.history;
  const canonicalIntent = intent == null ? null : intent.kind === 'move'
    ? { kind: 'move', from: intent.from, to: intent.to, promotion: intent.promotion ?? null }
    : { kind: 'timeout', expiredColor: intent.expiredColor };
  const canonical = JSON.stringify({
    protocolVersion: 1,
    rulesPolicyVersion: req.rulesPolicyVersion,
    matchVersion: req.matchVersion,
    fen: req.fen,
    history,
    intent: canonicalIntent,
  });
  return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function responseFor(req) {
  const isMove = req.intent && req.intent.kind === 'move';
  let candidate = null;
  if (isMove) {
    const move = { from: req.intent.from, to: req.intent.to };
    if (req.intent.promotion) move.promotion = req.intent.promotion;
    candidate = {
      move,
      san: 'e4',
      resultingFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      ending: facts(),
      repetition: { version: 1, entries: [{ identity: 'candidate', occurrences: '1' }] },
      material: facts().material,
    };
  }
  const isTimeout = req.intent && req.intent.kind === 'timeout';
  return {
    protocolVersion: 1,
    status: 'ok',
    requestId: req.requestId,
    matchVersion: req.matchVersion,
    rulesPolicyVersion: req.rulesPolicyVersion,
    inputFingerprint: fingerprint(req),
    engine: { name: 'chessops', version: '0.15.1' },
    input: { fen: req.fen, identity: (Array.isArray(req.history) && req.repetition === undefined) ? 'history-shape' : 'wrong-shape', repetitionCount: '1' },
    facts: facts(isTimeout ? 'white' : null),
    candidate,
  };
}

for await (const line of rl) {
  const req = JSON.parse(line);
  switch (req.requestId) {
    case 'crash':
      process.exit(9);
    case 'malformed':
      process.stdout.write('this is not json\n');
      continue;
    case 'slow':
      await new Promise((resolve) => setTimeout(resolve, 5000));
      break;
    case 'delay':
      await new Promise((resolve) => setTimeout(resolve, 700));
      break;
    case 'oversized':
      process.stdout.write('x'.repeat(2000000) + '\n');
      continue;
    case 'reject':
      process.stdout.write(JSON.stringify({
        protocolVersion: 1,
        status: 'rejected',
        requestId: req.requestId,
        code: 'illegal-move',
        message: 'The requested move is not legal in this position.',
      }) + '\n');
      continue;
  }

  const response = responseFor(req);
  switch (req.requestId) {
    case 'stale-request': response.requestId = 'different'; break;
    case 'stale-match': response.matchVersion += 1; break;
    case 'stale-policy': response.rulesPolicyVersion = 'older-policy'; break;
    case 'stale-fingerprint': {
      // Well-shaped digest, one hex digit off.
      const digest = response.inputFingerprint.slice('sha256:'.length);
      response.inputFingerprint = 'sha256:' + (digest[0] === 'a' ? 'b' : 'a') + digest.slice(1);
      break;
    }
    case 'history-drift': response.inputFingerprint = fingerprint(req, { history: [req.fen] }); break;
    case 'timeout-side-drift': response.inputFingerprint = fingerprint(req, { intent: { kind: 'timeout', expiredColor: 'b' } }); break;
    case 'stale-engine': response.engine = { name: 'chessops', version: '0.14.0' }; break;
    case 'stale-fen': response.input.fen = 'different'; break;
    case 'missing-candidate': response.candidate = null; break;
    case 'candidate-on-evaluate':
      if (!req.intent) response.candidate = responseFor({ ...req, intent: { kind: 'move', from: 'e2', to: 'e4' } }).candidate;
      break;
    case 'timeout-no-winner': response.facts.timeoutWinner = null; break;
    case 'malformed-facts': response.facts.ending = 'resigned'; break;
    case 'bad-candidate-fen': response.candidate.resultingFen = ''; break;
    case 'extra-field': response.extra = true; break;
  }
  process.stdout.write(JSON.stringify(response) + '\n');
}
`

const initialFEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

func testEntry(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "worker.mjs")
	if err := os.WriteFile(path, []byte(fakeWorkerScript), 0o600); err != nil {
		t.Fatalf("write fake worker: %v", err)
	}
	return path
}

func testClient(t *testing.T, timeout time.Duration) *Client {
	t.Helper()
	client, err := New(Config{Entry: testEntry(t), RequestTimeout: timeout})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func request(id string) Request {
	return Request{
		RequestID:    id,
		MatchVersion: 41,
		FEN:          initialFEN,
		History:      []string{initialFEN},
	}
}

func moveRequest(id string) Request {
	req := request(id)
	req.Intent = &Intent{Kind: "move", From: "e2", To: "e4"}
	return req
}

func TestEvaluateReturnsValidatedMoveCandidate(t *testing.T) {
	client := testClient(t, time.Second)
	response, err := client.Evaluate(context.Background(), moveRequest("ok"))
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if response.RequestID != "ok" || response.MatchVersion != 41 {
		t.Fatalf("correlation lost: %+v", response)
	}
	if response.RulesPolicyVersion != RulesPolicyVersion || response.Engine.Name != EngineName || response.Engine.Version != EngineVersion {
		t.Fatalf("version pins lost: %+v", response)
	}
	if !fingerprintShape.MatchString(response.InputFingerprint) {
		t.Fatalf("fingerprint = %q", response.InputFingerprint)
	}
	if response.Input.Identity != "history-shape" {
		t.Fatalf("request did not send FEN history: %q", response.Input.Identity)
	}
	if response.Candidate == nil || response.Candidate.Move.From != "e2" || response.Candidate.Move.To != "e4" {
		t.Fatalf("candidate = %+v", response.Candidate)
	}
	if response.Candidate.Repetition.Version != 1 || len(response.Candidate.Repetition.Entries) != 1 {
		t.Fatalf("candidate repetition = %+v", response.Candidate.Repetition)
	}
}

func TestEvaluateReturnsTimeoutWinnerWithoutCandidate(t *testing.T) {
	client := testClient(t, time.Second)
	req := request("timeout")
	req.Intent = &Intent{Kind: "timeout", ExpiredColor: "w"}
	response, err := client.Evaluate(context.Background(), req)
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if response.Facts.TimeoutWinner == nil || *response.Facts.TimeoutWinner != "white" {
		t.Fatalf("timeout winner = %+v", response.Facts.TimeoutWinner)
	}
	if response.Candidate != nil {
		t.Fatalf("timeout candidate = %+v", response.Candidate)
	}
}

func TestEvaluateSurfacesRejectionWithoutKillingTheWorker(t *testing.T) {
	client := testClient(t, time.Second)
	_, err := client.Evaluate(context.Background(), moveRequest("reject"))
	var rejection *RejectionError
	if !errors.As(err, &rejection) || rejection.Code != "illegal-move" {
		t.Fatalf("rejection = %v", err)
	}
	if _, err := client.Evaluate(context.Background(), request("ok")); err != nil {
		t.Fatalf("worker did not continue after rejection: %v", err)
	}
}

func TestRejectedOrMismatchedOutputCannotReturnACandidate(t *testing.T) {
	cases := map[string]error{
		"stale-request":         ErrCorrelation,
		"stale-match":           ErrCorrelation,
		"stale-policy":          ErrCorrelation,
		"stale-fingerprint":     ErrCorrelation,
		"history-drift":         ErrCorrelation,
		"timeout-side-drift":    ErrCorrelation,
		"stale-engine":          ErrCorrelation,
		"stale-fen":             ErrCorrelation,
		"missing-candidate":     ErrMalformed,
		"candidate-on-evaluate": ErrMalformed,
		"timeout-no-winner":     ErrMalformed,
		"malformed-facts":       ErrMalformed,
		"bad-candidate-fen":     ErrMalformed,
		"extra-field":           ErrMalformed,
	}
	for id, want := range cases {
		t.Run(id, func(t *testing.T) {
			client := testClient(t, time.Second)
			req := moveRequest(id)
			switch id {
			case "candidate-on-evaluate":
				req = request(id)
			case "timeout-no-winner", "timeout-side-drift":
				req.Intent = &Intent{Kind: "timeout", ExpiredColor: "w"}
			case "history-drift":
				// Same evaluated FEN, one extra entry in the ordered history.
				req.History = []string{initialFEN, initialFEN}
			}
			response, err := client.Evaluate(context.Background(), req)
			if !errors.Is(err, want) {
				t.Fatalf("error = %v, want %v", err, want)
			}
			if response.RequestID != "" || response.Candidate != nil || response.Facts.Ending != "" || response.InputFingerprint != "" {
				t.Fatalf("error returned a usable response: %+v", response)
			}
		})
	}
}

func TestTimeoutKillsTheWorkerAndTheNextRequestRestartsIt(t *testing.T) {
	// Include cold Node startup under CI load, while staying below the fake
	// worker's five-second stall and the two-second elapsed-time assertion.
	client := testClient(t, 500*time.Millisecond)
	started := time.Now()
	response, err := client.Evaluate(context.Background(), request("slow"))
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("error = %v, want timeout", err)
	}
	if response.RequestID != "" || response.Candidate != nil {
		t.Fatalf("timeout returned a usable response: %+v", response)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("timeout took %s", elapsed)
	}
	if _, err := client.Evaluate(context.Background(), request("ok")); err != nil {
		t.Fatalf("restart after timeout: %v", err)
	}
}

func TestCancellationKillsTheWorker(t *testing.T) {
	client := testClient(t, 5*time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	response, err := client.Evaluate(ctx, request("slow"))
	if !errors.Is(err, ErrCanceled) {
		t.Fatalf("error = %v, want canceled", err)
	}
	if response.RequestID != "" || response.Candidate != nil {
		t.Fatalf("cancellation returned a usable response: %+v", response)
	}
}

func TestCanceledRequestDoesNotAttemptToStartWorker(t *testing.T) {
	entry := filepath.Join(t.TempDir(), "unused.mjs")
	if err := os.WriteFile(entry, []byte("process.exit(0)"), 0600); err != nil {
		t.Fatal(err)
	}
	client, err := New(Config{Entry: entry, Node: "kha66-worker-must-not-start"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := client.Evaluate(ctx, request("ok")); !errors.Is(err, ErrCanceled) {
		t.Fatalf("already-canceled request attempted to start a process: %v", err)
	}
}

func TestCrashAndMalformedOutputAreBoundedAndRecoverable(t *testing.T) {
	client := testClient(t, time.Second)
	if _, err := client.Evaluate(context.Background(), request("crash")); !errors.Is(err, ErrCrashed) {
		t.Fatalf("crash error = %v", err)
	}
	if _, err := client.Evaluate(context.Background(), request("ok")); err != nil {
		t.Fatalf("restart after crash: %v", err)
	}
	if _, err := client.Evaluate(context.Background(), request("malformed")); !errors.Is(err, ErrMalformed) {
		t.Fatalf("malformed error = %v", err)
	}
	if _, err := client.Evaluate(context.Background(), request("ok")); err != nil {
		t.Fatalf("restart after malformed output: %v", err)
	}
	if _, err := client.Evaluate(context.Background(), request("oversized")); !errors.Is(err, ErrMalformed) {
		t.Fatalf("oversized error = %v", err)
	}
}

func TestInvalidRequestsNeverStartTheWorker(t *testing.T) {
	entry := testEntry(t)
	client, err := New(Config{Entry: entry, RequestTimeout: time.Second})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	cases := map[string]func(*Request){
		"empty id":        func(req *Request) { req.RequestID = "" },
		"space id":        func(req *Request) { req.RequestID = "two words" },
		"zero version":    func(req *Request) { req.MatchVersion = 0 },
		"unsafe version":  func(req *Request) { req.MatchVersion = MaxMatchVersion + 1 },
		"long fen":        func(req *Request) { req.FEN = strings.Repeat("x", MaxFENLength+1) },
		"newline fen":     func(req *Request) { req.FEN = initialFEN + "\n" },
		"empty history":   func(req *Request) { req.History = nil },
		"long history":    func(req *Request) { req.History = []string{strings.Repeat("x", MaxFENLength+1)} },
		"newline history": func(req *Request) { req.History = []string{initialFEN + "\n"} },
		"stale history":   func(req *Request) { req.History = []string{"4k3/8/8/8/8/8/8/4K3 w - - 0 1"} },
		"large history": func(req *Request) {
			req.History = make([]string, MaxHistoryFENs+1)
			for index := range req.History {
				req.History[index] = initialFEN
			}
		},
		"bad intent": func(req *Request) { req.Intent = &Intent{Kind: "resign"} },
		"bad squares": func(req *Request) {
			req.Intent = &Intent{Kind: "move", From: "e2", To: "e9"}
		},
		"bad promotion": func(req *Request) {
			req.Intent = &Intent{Kind: "move", From: "a7", To: "a8", Promotion: "k"}
		},
		"mixed timeout": func(req *Request) {
			req.Intent = &Intent{Kind: "timeout", ExpiredColor: "w", From: "e2"}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			req := request("ok")
			mutate(&req)
			response, err := client.Evaluate(context.Background(), req)
			if !errors.Is(err, ErrInvalidRequest) {
				t.Fatalf("error = %v", err)
			}
			if response.RequestID != "" || response.Candidate != nil {
				t.Fatalf("invalid request returned a candidate: %+v", response)
			}
		})
	}
}

func TestConcurrentEvaluationsAreSerialized(t *testing.T) {
	client := testClient(t, 2*time.Second)
	var wait sync.WaitGroup
	errorsSeen := make(chan error, 6)
	for index := 0; index < 6; index += 1 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			if _, err := client.Evaluate(context.Background(), moveRequest("ok")); err != nil {
				errorsSeen <- err
			}
		}()
	}
	wait.Wait()
	close(errorsSeen)
	for err := range errorsSeen {
		t.Fatalf("concurrent evaluate: %v", err)
	}
}

// TestSemanticInputFingerprintMatchesTheWorkerCanonicalJSON pins the exact
// canonical bytes the Go client hashes, so the recomputation cannot drift from
// inputFingerprint() in the JavaScript worker. The fake worker below hashes the
// same canonical form with JSON.stringify as an end-to-end parity check.
func TestSemanticInputFingerprintMatchesTheWorkerCanonicalJSON(t *testing.T) {
	movedFEN := "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"
	prefix := `{"protocolVersion":1,"rulesPolicyVersion":"online-rules/1","matchVersion":`
	cases := []struct {
		name    string
		request Request
		payload string
	}{
		{
			name:    "evaluate only",
			request: request("fingerprint"),
			payload: prefix + `41,"fen":"` + initialFEN + `","history":["` + initialFEN + `"],"intent":null}`,
		},
		{
			name:    "move intent without promotion",
			request: moveRequest("fingerprint"),
			payload: prefix + `41,"fen":"` + initialFEN + `","history":["` + initialFEN + `"],"intent":{"kind":"move","from":"e2","to":"e4","promotion":null}}`,
		},
		{
			name: "move intent with promotion over an ordered history",
			request: Request{
				RequestID:    "fingerprint",
				MatchVersion: 9,
				FEN:          movedFEN,
				History:      []string{initialFEN, movedFEN},
				Intent:       &Intent{Kind: "move", From: "a7", To: "a8", Promotion: "q"},
			},
			payload: `{"protocolVersion":1,"rulesPolicyVersion":"online-rules/1","matchVersion":9,"fen":"` + movedFEN +
				`","history":["` + initialFEN + `","` + movedFEN + `"],"intent":{"kind":"move","from":"a7","to":"a8","promotion":"q"}}`,
		},
		{
			name: "timeout intent names the expired side",
			request: Request{
				RequestID:    "fingerprint",
				MatchVersion: 41,
				FEN:          initialFEN,
				History:      []string{initialFEN},
				Intent:       &Intent{Kind: "timeout", ExpiredColor: "b"},
			},
			payload: prefix + `41,"fen":"` + initialFEN + `","history":["` + initialFEN + `"],"intent":{"kind":"timeout","expiredColor":"b"}}`,
		},
		{
			name: "policy override",
			request: Request{
				RequestID:          "fingerprint",
				MatchVersion:       41,
				FEN:                initialFEN,
				History:            []string{initialFEN},
				RulesPolicyVersion: "online-rules/2",
			},
			payload: `{"protocolVersion":1,"rulesPolicyVersion":"online-rules/2","matchVersion":41,"fen":"` + initialFEN +
				`","history":["` + initialFEN + `"],"intent":null}`,
		},
	}

	seen := make(map[string]string, len(cases))
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			digest := sha256.Sum256([]byte(testCase.payload))
			want := "sha256:" + hex.EncodeToString(digest[:])
			got, err := semanticInputFingerprint(testCase.request)
			if err != nil {
				t.Fatalf("fingerprint: %v", err)
			}
			if got != want {
				t.Fatalf("fingerprint = %s, want %s for canonical %s", got, want, testCase.payload)
			}
			if previous, duplicate := seen[got]; duplicate {
				t.Fatalf("%s shares a fingerprint with %s", testCase.name, previous)
			}
			seen[got] = testCase.name
		})
	}
}

// TestQueuedRequestHonoursItsOwnDeadline covers the regression where a request
// waited on the client mutex outside its timeout budget. The queued request must
// give up on schedule and leave the in-flight exchange running.
func TestQueuedRequestHonoursItsOwnDeadline(t *testing.T) {
	client := testClient(t, 3*time.Second)
	type outcome struct {
		response Response
		err      error
	}
	active := make(chan outcome, 1)
	go func() {
		response, err := client.Evaluate(context.Background(), request("delay"))
		active <- outcome{response: response, err: err}
	}()
	// Let the first request take the worker slot before queueing behind it.
	time.Sleep(150 * time.Millisecond)

	queuedCtx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	queued, err := client.Evaluate(queuedCtx, request("ok"))
	elapsed := time.Since(started)
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("queued error = %v, want timeout", err)
	}
	if queued.RequestID != "" || queued.Candidate != nil || queued.Facts.Ending != "" {
		t.Fatalf("queued timeout returned a usable response: %+v", queued)
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("queued request waited %s for the worker instead of its own deadline", elapsed)
	}

	result := <-active
	if result.err != nil {
		t.Fatalf("active request was interrupted by the queued timeout: %v", result.err)
	}
	if result.response.RequestID != "delay" || result.response.Facts.Ending != "none" {
		t.Fatalf("active response = %+v", result.response)
	}
}

func TestCancelingAQueuedRequestLeavesTheActiveRequestAlone(t *testing.T) {
	client := testClient(t, 3*time.Second)
	active := make(chan error, 1)
	go func() {
		_, err := client.Evaluate(context.Background(), request("delay"))
		active <- err
	}()
	time.Sleep(150 * time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(80 * time.Millisecond)
		cancel()
	}()
	started := time.Now()
	if _, err := client.Evaluate(ctx, request("ok")); !errors.Is(err, ErrCanceled) {
		t.Fatalf("queued error = %v, want canceled", err)
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("canceled queued request waited %s", elapsed)
	}
	if err := <-active; err != nil {
		t.Fatalf("active request was interrupted by the queued cancellation: %v", err)
	}
}

func TestCloseRejectsFurtherRequests(t *testing.T) {
	client := testClient(t, time.Second)
	if err := client.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := client.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}
	if _, err := client.Evaluate(context.Background(), request("ok")); !errors.Is(err, ErrClosed) {
		t.Fatalf("error = %v", err)
	}
}

func TestWorkerEnvironmentIsNarrow(t *testing.T) {
	environment := workerEnvironment([]string{
		"PATH=C:\\node",
		"SystemRoot=C:\\Windows",
		"DATABASE_URL=postgres://private",
		"CLERK_SECRET_KEY=clerk",
		"OPENAI_API_KEY=provider",
		"HTTPS_PROXY=http://proxy",
	})
	joined := strings.Join(environment, "\n")
	for _, forbidden := range []string{"DATABASE_URL", "CLERK_SECRET_KEY", "OPENAI_API_KEY", "HTTPS_PROXY"} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("worker environment leaked %s", forbidden)
		}
	}
	if !strings.Contains(joined, "PATH=C:\\node") || !strings.Contains(joined, "SystemRoot=C:\\Windows") {
		t.Fatalf("worker environment lost required entries: %v", environment)
	}
	if !strings.Contains(joined, "NODE_ENV=production") {
		t.Fatalf("worker environment has no fixed Node environment: %v", environment)
	}
}

// TestBuiltWorkerIntegration exercises the real pinned bundle when it has been
// built. It is skipped in the normal suite so the parent does not depend on a
// build artifact; set KHA66_WORKER_ENTRY to build/rules-worker/worker.mjs to run
// the packaging check.
func TestBuiltWorkerIntegration(t *testing.T) {
	entry := os.Getenv("KHA66_WORKER_ENTRY")
	if entry == "" {
		t.Skip("set KHA66_WORKER_ENTRY to a built build/rules-worker/worker.mjs")
	}
	client, err := New(Config{Entry: entry, RequestTimeout: 3 * time.Second})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	defer client.Close()

	response, err := client.Evaluate(context.Background(), moveRequest("built-worker"))
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if response.Engine.Version != EngineVersion || response.RulesPolicyVersion != RulesPolicyVersion {
		t.Fatalf("versions = %+v", response)
	}
	if response.Candidate == nil || response.Candidate.SAN != "e4" {
		t.Fatalf("candidate = %+v", response.Candidate)
	}
	if response.Candidate.ResultingFEN != "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1" {
		t.Fatalf("resulting fen = %q", response.Candidate.ResultingFEN)
	}
}
