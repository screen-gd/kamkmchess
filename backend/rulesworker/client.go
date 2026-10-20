// Package rulesworker owns the private, versioned Node rules process used by the
// Go match authority. The process receives a position, ordered FEN history and
// optional move or timeout intent over stdin and returns deterministic facts.
// It has no database, HTTP, authentication or provider access. A caller must
// still hold the match lock and reconcile clocks before committing a candidate
// against the same match version.
package rulesworker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	ProtocolVersion    = 1
	RulesPolicyVersion = "online-rules/1"
	EngineName         = "chessops"
	EngineVersion      = "0.15.1"

	DefaultRequestTimeout   = 2 * time.Second
	DefaultMaxRequestBytes  = 256 << 10
	DefaultMaxResponseBytes = 1 << 20
	MaxFENLength            = 256
	MaxHistoryFENs          = 4096
	MaxLedgerEntries        = 4096
	MaxRequestIDLength      = 128
	MaxMatchVersion         = int64(1<<53 - 1)
)

var (
	ErrClosed         = errors.New("rules worker client is closed")
	ErrInvalidRequest = errors.New("invalid rules worker request")
	ErrTimeout        = errors.New("rules worker timed out")
	ErrCanceled       = errors.New("rules worker request was canceled")
	ErrCrashed        = errors.New("rules worker exited without a valid response")
	ErrMalformed      = errors.New("rules worker returned malformed output")
	ErrCorrelation    = errors.New("rules worker response does not match the request")
)

// RejectionError is a valid protocol response that refused the input. It never
// contains a candidate.
type RejectionError struct {
	Code    string
	Message string
}

func (e *RejectionError) Error() string {
	return "rules worker rejected request: " + e.Code
}

type Config struct {
	// Entry is the built worker bundle, normally build/rules-worker/worker.mjs.
	// It is private server code and deliberately outside the public dist/ output.
	Entry string
	// Node defaults to node from PATH.
	Node string
	// RequestTimeout bounds one request including process start. A timeout
	// terminates the process so a late reply cannot be mistaken for a newer one.
	RequestTimeout   time.Duration
	MaxRequestBytes  int
	MaxResponseBytes int
}

type CoordinateMove struct {
	From      string `json:"from"`
	To        string `json:"to"`
	Promotion string `json:"promotion,omitempty"`
}

type RepetitionEntry struct {
	Identity    string `json:"identity"`
	Occurrences string `json:"occurrences"`
}

type Repetition struct {
	Version int               `json:"version"`
	Entries []RepetitionEntry `json:"entries"`
}

type Intent struct {
	Kind         string
	From         string
	To           string
	Promotion    string
	ExpiredColor string
}

type Request struct {
	RequestID string
	// History is the ordered starting position followed by every accepted move's
	// resulting FEN. The last entry must equal FEN. The worker derives repetition
	// identity itself so Go carries no chess rules.
	History            []string
	MatchVersion       int64
	FEN                string
	Intent             *Intent
	RulesPolicyVersion string
}

type Engine struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type PieceCounts struct {
	Pawns   int `json:"p"`
	Knights int `json:"n"`
	Bishops int `json:"b"`
	Rooks   int `json:"r"`
	Queens  int `json:"q"`
	Kings   int `json:"k"`
}

type Material struct {
	White PieceCounts `json:"white"`
	Black PieceCounts `json:"black"`
	Total int         `json:"total"`
}

type Facts struct {
	InCheck              bool     `json:"inCheck"`
	HasLegalMoves        bool     `json:"hasLegalMoves"`
	Checkmate            bool     `json:"checkmate"`
	Stalemate            bool     `json:"stalemate"`
	InsufficientMaterial bool     `json:"insufficientMaterial"`
	RepetitionCount      string   `json:"repetitionCount"`
	ThirdRepetition      bool     `json:"thirdRepetition"`
	HundredHalfmoves     bool     `json:"hundredHalfmoves"`
	Deadness             string   `json:"deadness"`
	Ending               string   `json:"ending"`
	Material             Material `json:"material"`
	TimeoutWinner        *string  `json:"timeoutWinner"`
}

type Candidate struct {
	Move         CoordinateMove `json:"move"`
	SAN          string         `json:"san"`
	ResultingFEN string         `json:"resultingFen"`
	Ending       Facts          `json:"ending"`
	Repetition   Repetition     `json:"repetition"`
	Material     Material       `json:"material"`
}

type Input struct {
	FEN             string `json:"fen"`
	Identity        string `json:"identity"`
	RepetitionCount string `json:"repetitionCount"`
}

// Response is returned only after protocol, version, engine, fingerprint,
// correlation and candidate-shape checks have passed.
type Response struct {
	ProtocolVersion    int        `json:"protocolVersion"`
	RequestID          string     `json:"requestId"`
	MatchVersion       int64      `json:"matchVersion"`
	RulesPolicyVersion string     `json:"rulesPolicyVersion"`
	InputFingerprint   string     `json:"inputFingerprint"`
	Engine             Engine     `json:"engine"`
	Input              Input      `json:"input"`
	Facts              Facts      `json:"facts"`
	Candidate          *Candidate `json:"candidate"`
}

type wireRequest struct {
	ProtocolVersion    int         `json:"protocolVersion"`
	RequestID          string      `json:"requestId"`
	RulesPolicyVersion string      `json:"rulesPolicyVersion"`
	MatchVersion       int64       `json:"matchVersion"`
	FEN                string      `json:"fen"`
	History            []string    `json:"history"`
	Intent             *wireIntent `json:"intent,omitempty"`
}

type wireIntent struct {
	Kind         string `json:"kind"`
	From         string `json:"from,omitempty"`
	To           string `json:"to,omitempty"`
	Promotion    string `json:"promotion,omitempty"`
	ExpiredColor string `json:"expiredColor,omitempty"`
}

type wireResponse struct {
	ProtocolVersion    int        `json:"protocolVersion"`
	Status             string     `json:"status"`
	RequestID          *string    `json:"requestId"`
	MatchVersion       int64      `json:"matchVersion"`
	RulesPolicyVersion string     `json:"rulesPolicyVersion"`
	InputFingerprint   string     `json:"inputFingerprint"`
	Engine             Engine     `json:"engine"`
	Input              Input      `json:"input"`
	Facts              *Facts     `json:"facts"`
	Candidate          *Candidate `json:"candidate"`
	Code               string     `json:"code"`
	Message            string     `json:"message"`
}

type Client struct {
	config Config

	// slot is a one-permit semaphore rather than a sync.Mutex so a queued
	// request can abandon the wait when its own deadline expires.
	slot   chan struct{}
	closed bool
	proc   *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
}

func New(config Config) (*Client, error) {
	normalized, err := normalizeConfig(config)
	if err != nil {
		return nil, err
	}
	return &Client{config: normalized, slot: make(chan struct{}, 1)}, nil
}

func normalizeConfig(config Config) (Config, error) {
	config.Entry = strings.TrimSpace(config.Entry)
	config.Node = strings.TrimSpace(config.Node)
	if config.Entry == "" {
		return Config{}, errors.New("rules worker entry is required")
	}
	details, err := os.Stat(config.Entry)
	if err != nil || !details.Mode().IsRegular() {
		return Config{}, errors.New("rules worker entry is not a readable file")
	}
	if config.Node == "" {
		config.Node = "node"
	}
	if runtime.GOOS == "windows" && strings.EqualFold(config.Node, "node") {
		// A Windows PATH may put a shell/cmd shim named node ahead of node.exe.
		// Killing that wrapper would leave the real worker running, so prefer
		// the executable when the default name is used.
		if executable, err := exec.LookPath("node.exe"); err == nil {
			config.Node = executable
		}
	}
	if config.RequestTimeout <= 0 {
		config.RequestTimeout = DefaultRequestTimeout
	}
	if config.MaxRequestBytes <= 0 {
		config.MaxRequestBytes = DefaultMaxRequestBytes
	}
	if config.MaxResponseBytes <= 0 {
		config.MaxResponseBytes = DefaultMaxResponseBytes
	}
	return config, nil
}

// Evaluate sends one request and returns a validated response. Timeouts,
// cancellation, crashes, malformed output and mismatched correlation all
// terminate the process and return a zero Response.
//
// One deadline covers queueing behind another request, process start, retries
// and the exchange, so a request that waits for the worker cannot consume a
// fresh budget once it is admitted.
func (c *Client) Evaluate(ctx context.Context, request Request) (Response, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	deadline := ctx
	if c.config.RequestTimeout > 0 {
		var cancel context.CancelFunc
		deadline, cancel = context.WithTimeout(ctx, c.config.RequestTimeout)
		defer cancel()
	}

	line, err := c.buildRequest(request)
	if err != nil {
		return Response{}, err
	}
	if err := c.acquire(deadline); err != nil {
		return Response{}, err
	}
	defer c.release()

	if err := deadline.Err(); err != nil {
		return Response{}, contextError(deadline)
	}
	if c.closed {
		return Response{}, ErrClosed
	}

	for attempt := 0; ; attempt++ {
		if err := deadline.Err(); err != nil {
			return Response{}, contextError(deadline)
		}
		if c.proc == nil {
			if err := c.start(); err != nil {
				return Response{}, fmt.Errorf("%w: %v", ErrCrashed, err)
			}
		}
		response, retry, err := c.exchange(deadline, line, request)
		if err == nil {
			return response, nil
		}
		c.stop()
		var rejection *RejectionError
		if errors.As(err, &rejection) {
			return Response{}, rejection
		}
		if !retry || attempt >= 1 {
			return Response{}, err
		}
	}
}

// acquire takes the single worker slot without ignoring the caller's deadline.
// Running out of budget while queued returns immediately and leaves the
// in-flight request and process untouched.
func (c *Client) acquire(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return contextError(ctx)
	}
	select {
	case c.slot <- struct{}{}:
		return nil
	default:
	}
	select {
	case c.slot <- struct{}{}:
		return nil
	case <-ctx.Done():
		return contextError(ctx)
	}
}

func (c *Client) release() {
	<-c.slot
}

// Close terminates a running worker. It is safe to call more than once.
func (c *Client) Close() error {
	if err := c.acquire(context.Background()); err != nil {
		return err
	}
	defer c.release()
	if c.closed {
		return nil
	}
	c.closed = true
	c.stop()
	return nil
}

func (c *Client) buildRequest(request Request) ([]byte, error) {
	if request.RequestID == "" || len(request.RequestID) > MaxRequestIDLength || !requestIDPattern.MatchString(request.RequestID) {
		return nil, fmt.Errorf("%w: requestId must be a bounded correlation token", ErrInvalidRequest)
	}
	if request.MatchVersion < 1 || request.MatchVersion > MaxMatchVersion {
		return nil, fmt.Errorf("%w: matchVersion must be a positive safe integer", ErrInvalidRequest)
	}
	if request.FEN == "" || len(request.FEN) > MaxFENLength || strings.ContainsAny(request.FEN, "\r\n\x00") {
		return nil, fmt.Errorf("%w: fen must be one bounded line", ErrInvalidRequest)
	}
	if len(request.History) < 1 || len(request.History) > MaxHistoryFENs {
		return nil, fmt.Errorf("%w: position history is outside the supported bounds", ErrInvalidRequest)
	}
	for _, entry := range request.History {
		if entry == "" || len(entry) > MaxFENLength || strings.ContainsAny(entry, "\r\n\x00") {
			return nil, fmt.Errorf("%w: position history contains a malformed FEN", ErrInvalidRequest)
		}
	}
	if request.History[len(request.History)-1] != request.FEN {
		return nil, fmt.Errorf("%w: position history must end at the evaluated FEN", ErrInvalidRequest)
	}
	policy := strings.TrimSpace(request.RulesPolicyVersion)
	if policy == "" {
		policy = RulesPolicyVersion
	}

	wire := wireRequest{
		ProtocolVersion:    ProtocolVersion,
		RequestID:          request.RequestID,
		RulesPolicyVersion: policy,
		MatchVersion:       request.MatchVersion,
		FEN:                request.FEN,
		History:            request.History,
	}
	if request.Intent != nil {
		converted, err := convertIntent(*request.Intent)
		if err != nil {
			return nil, err
		}
		wire.Intent = converted
	}
	encoded, err := json.Marshal(wire)
	if err != nil {
		return nil, fmt.Errorf("%w: request could not be encoded", ErrInvalidRequest)
	}
	if len(encoded)+1 > c.config.MaxRequestBytes {
		return nil, fmt.Errorf("%w: request exceeds the worker size limit", ErrInvalidRequest)
	}
	return encoded, nil
}

func convertIntent(intent Intent) (*wireIntent, error) {
	switch intent.Kind {
	case "move":
		if !squarePattern.MatchString(intent.From) || !squarePattern.MatchString(intent.To) {
			return nil, fmt.Errorf("%w: move intent needs board coordinates", ErrInvalidRequest)
		}
		if intent.Promotion != "" && !strings.Contains("qrbn", intent.Promotion) {
			return nil, fmt.Errorf("%w: promotion must be q, r, b, or n", ErrInvalidRequest)
		}
		if intent.ExpiredColor != "" {
			return nil, fmt.Errorf("%w: move intent cannot carry a timeout colour", ErrInvalidRequest)
		}
		return &wireIntent{Kind: "move", From: intent.From, To: intent.To, Promotion: intent.Promotion}, nil
	case "timeout":
		if intent.ExpiredColor != "w" && intent.ExpiredColor != "b" {
			return nil, fmt.Errorf("%w: timeout intent needs a w or b expired colour", ErrInvalidRequest)
		}
		if intent.From != "" || intent.To != "" || intent.Promotion != "" {
			return nil, fmt.Errorf("%w: timeout intent cannot carry a move", ErrInvalidRequest)
		}
		return &wireIntent{Kind: "timeout", ExpiredColor: intent.ExpiredColor}, nil
	default:
		return nil, fmt.Errorf("%w: intent kind must be move or timeout", ErrInvalidRequest)
	}
}

func (c *Client) start() error {
	command := exec.Command(c.config.Node, c.config.Entry)
	command.Env = workerEnvironment(os.Environ())
	stdin, err := command.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return err
	}
	command.Stderr = &boundedBuffer{limit: 4096}
	if err := command.Start(); err != nil {
		_ = stdin.Close()
		return err
	}
	c.proc = command
	c.stdin = stdin
	c.stdout = bufio.NewReaderSize(stdout, 64<<10)
	return nil
}

type readResult struct {
	line []byte
	err  error
}

// exchange performs one bounded write/read round trip. The caller's deadline
// already covers this call; a timeout must terminate the process so a late
// reply can never be read against a newer request.
func (c *Client) exchange(ctx context.Context, line []byte, request Request) (Response, bool, error) {
	writeDone := make(chan error, 1)
	stdin := c.stdin
	go func() {
		_, err := stdin.Write(append(line, '\n'))
		writeDone <- err
	}()
	select {
	case err := <-writeDone:
		if err != nil {
			return Response{}, true, fmt.Errorf("%w: write failed", ErrCrashed)
		}
	case <-ctx.Done():
		c.kill()
		return Response{}, false, contextError(ctx)
	}

	readDone := make(chan readResult, 1)
	stdout := c.stdout
	go func() {
		payload, err := readLimitedLine(stdout, c.config.MaxResponseBytes)
		readDone <- readResult{line: payload, err: err}
	}()
	select {
	case <-ctx.Done():
		c.kill()
		return Response{}, false, contextError(ctx)
	case result := <-readDone:
		if result.err != nil {
			if errors.Is(result.err, errLineTooLong) {
				return Response{}, false, fmt.Errorf("%w: response exceeds the size limit", ErrMalformed)
			}
			if errors.Is(result.err, io.EOF) {
				return Response{}, true, ErrCrashed
			}
			return Response{}, true, fmt.Errorf("%w: %v", ErrCrashed, result.err)
		}
		return c.interpret(result.line, request)
	}
}

func (c *Client) interpret(line []byte, request Request) (Response, bool, error) {
	wire, err := decodeResponse(line)
	if err != nil {
		return Response{}, false, err
	}
	if wire.Status == "rejected" {
		if wire.ProtocolVersion != ProtocolVersion {
			return Response{}, false, fmt.Errorf("%w: rejection protocol version differs", ErrCorrelation)
		}
		if wire.RequestID != nil && *wire.RequestID != request.RequestID {
			return Response{}, false, fmt.Errorf("%w: rejection requestId differs", ErrCorrelation)
		}
		if wire.Code == "" {
			return Response{}, false, fmt.Errorf("%w: rejection has no code", ErrMalformed)
		}
		message := wire.Message
		if len(message) > 240 {
			message = message[:240]
		}
		return Response{}, false, &RejectionError{Code: wire.Code, Message: message}
	}
	if wire.Status != "ok" {
		return Response{}, false, fmt.Errorf("%w: unknown response status", ErrMalformed)
	}
	response, err := validateResponse(wire, request)
	if err != nil {
		return Response{}, false, err
	}
	return response, false, nil
}

func decodeResponse(line []byte) (*wireResponse, error) {
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	var wire wireResponse
	if err := decoder.Decode(&wire); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%w: trailing response data", ErrMalformed)
	}
	return &wire, nil
}

func validateResponse(wire *wireResponse, request Request) (Response, error) {
	correlation := func(message string) (Response, error) {
		return Response{}, fmt.Errorf("%w: %s", ErrCorrelation, message)
	}
	if wire.ProtocolVersion != ProtocolVersion {
		return correlation("protocol version differs")
	}
	if wire.RequestID == nil || *wire.RequestID != request.RequestID {
		return correlation("requestId differs")
	}
	if wire.MatchVersion != request.MatchVersion {
		return correlation("match version differs")
	}
	if wire.RulesPolicyVersion != policyFor(request) {
		return correlation("rules policy version differs")
	}
	if !fingerprintShape.MatchString(wire.InputFingerprint) {
		return correlation("input fingerprint is malformed")
	}
	expectedFingerprint, err := semanticInputFingerprint(request)
	if err != nil {
		return Response{}, err
	}
	if wire.InputFingerprint != expectedFingerprint {
		return correlation("input fingerprint does not match the request")
	}
	if wire.Engine.Name != EngineName || wire.Engine.Version != EngineVersion {
		return correlation("rules engine version differs")
	}
	if wire.Input.FEN != request.FEN {
		return correlation("input FEN differs")
	}
	if wire.Input.Identity == "" || len(wire.Input.Identity) > MaxFENLength {
		return Response{}, fmt.Errorf("%w: input identity is malformed", ErrMalformed)
	}
	if wire.Facts == nil {
		return Response{}, fmt.Errorf("%w: facts are missing", ErrMalformed)
	}
	if err := validateFacts(*wire.Facts); err != nil {
		return Response{}, err
	}
	if wire.Facts.RepetitionCount != wire.Input.RepetitionCount {
		return Response{}, fmt.Errorf("%w: repetition count differs from input", ErrMalformed)
	}
	if err := validateIntentOutcome(request.Intent, wire.Facts, wire.Candidate); err != nil {
		return Response{}, err
	}
	if wire.Candidate != nil {
		if err := validateCandidate(*wire.Candidate); err != nil {
			return Response{}, err
		}
	}
	return Response{
		ProtocolVersion:    wire.ProtocolVersion,
		RequestID:          *wire.RequestID,
		MatchVersion:       wire.MatchVersion,
		RulesPolicyVersion: wire.RulesPolicyVersion,
		InputFingerprint:   wire.InputFingerprint,
		Engine:             wire.Engine,
		Input:              wire.Input,
		Facts:              *wire.Facts,
		Candidate:          wire.Candidate,
	}, nil
}

func policyFor(request Request) string {
	if policy := strings.TrimSpace(request.RulesPolicyVersion); policy != "" {
		return policy
	}
	return RulesPolicyVersion
}

// validateIntentOutcome keeps a timeout or evaluate-only reply from carrying a
// move candidate, and requires a move candidate for a move request.
func validateIntentOutcome(intent *Intent, facts *Facts, candidate *Candidate) error {
	if intent == nil {
		if candidate != nil || facts.TimeoutWinner != nil {
			return fmt.Errorf("%w: evaluate-only response carried a terminal outcome", ErrMalformed)
		}
		return nil
	}
	switch intent.Kind {
	case "move":
		if candidate == nil {
			return fmt.Errorf("%w: move response has no candidate", ErrMalformed)
		}
		if candidate.Move.From != intent.From || candidate.Move.To != intent.To || candidate.Move.Promotion != intent.Promotion {
			return fmt.Errorf("%w: candidate move differs from the request", ErrCorrelation)
		}
		if facts.TimeoutWinner != nil {
			return fmt.Errorf("%w: move response carried a timeout winner", ErrMalformed)
		}
	case "timeout":
		if candidate != nil {
			return fmt.Errorf("%w: timeout response carried a move candidate", ErrMalformed)
		}
		if facts.TimeoutWinner == nil {
			return fmt.Errorf("%w: timeout response has no winner", ErrMalformed)
		}
	default:
		return fmt.Errorf("%w: unknown intent kind", ErrInvalidRequest)
	}
	return nil
}

func validateFacts(facts Facts) error {
	if !endingPattern.MatchString(facts.Ending) {
		return fmt.Errorf("%w: unknown ending", ErrMalformed)
	}
	if facts.Deadness != "not-assessed" {
		return fmt.Errorf("%w: unknown deadness value", ErrMalformed)
	}
	if !occurrencesPattern.MatchString(facts.RepetitionCount) {
		return fmt.Errorf("%w: repetition count is malformed", ErrMalformed)
	}
	if !validMaterial(facts.Material) {
		return fmt.Errorf("%w: material counts are malformed", ErrMalformed)
	}
	if facts.TimeoutWinner != nil && !timeoutWinnerPattern.MatchString(*facts.TimeoutWinner) {
		return fmt.Errorf("%w: timeout winner is unknown", ErrMalformed)
	}
	return nil
}

func validMaterial(material Material) bool {
	valid := func(counts PieceCounts) bool {
		return counts.Pawns >= 0 && counts.Knights >= 0 && counts.Bishops >= 0 &&
			counts.Rooks >= 0 && counts.Queens >= 0 && counts.Kings >= 0
	}
	return material.Total >= 0 && valid(material.White) && valid(material.Black)
}

func validateCandidate(candidate Candidate) error {
	if !squarePattern.MatchString(candidate.Move.From) || !squarePattern.MatchString(candidate.Move.To) {
		return fmt.Errorf("%w: candidate move coordinates are malformed", ErrMalformed)
	}
	if candidate.Move.Promotion != "" && !strings.Contains("qrbn", candidate.Move.Promotion) {
		return fmt.Errorf("%w: candidate promotion is malformed", ErrMalformed)
	}
	if candidate.SAN == "" || len(candidate.SAN) > 32 {
		return fmt.Errorf("%w: candidate SAN is missing or too long", ErrMalformed)
	}
	if candidate.ResultingFEN == "" || len(candidate.ResultingFEN) > MaxFENLength || strings.ContainsAny(candidate.ResultingFEN, "\r\n\x00") {
		return fmt.Errorf("%w: candidate FEN is malformed", ErrMalformed)
	}
	if err := validateFacts(candidate.Ending); err != nil {
		return err
	}
	if candidate.Ending.TimeoutWinner != nil {
		return fmt.Errorf("%w: move candidate cannot carry a timeout winner", ErrMalformed)
	}
	if candidate.Repetition.Version != 1 || len(candidate.Repetition.Entries) < 1 || len(candidate.Repetition.Entries) > MaxLedgerEntries {
		return fmt.Errorf("%w: candidate repetition history is outside the supported bounds", ErrMalformed)
	}
	for _, entry := range candidate.Repetition.Entries {
		if entry.Identity == "" || len(entry.Identity) > MaxFENLength || !occurrencesPattern.MatchString(entry.Occurrences) {
			return fmt.Errorf("%w: candidate repetition entry is malformed", ErrMalformed)
		}
	}
	return nil
}

var (
	requestIDPattern     = regexp.MustCompile(`^[A-Za-z0-9._:-]+$`)
	squarePattern        = regexp.MustCompile(`^[a-h][1-8]$`)
	occurrencesPattern   = regexp.MustCompile(`^[1-9][0-9]*$`)
	fingerprintShape     = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	endingPattern        = regexp.MustCompile(`^(checkmate|stalemate|insufficient-material|threefold-repetition|hundred-halfmoves|none)$`)
	timeoutWinnerPattern = regexp.MustCompile(`^(white|black|draw)$`)
)

var errLineTooLong = errors.New("rules worker line exceeds the size limit")

func readLimitedLine(reader *bufio.Reader, limit int) ([]byte, error) {
	var line []byte
	for {
		fragment, err := reader.ReadSlice('\n')
		if len(line)+len(fragment) > limit {
			return nil, errLineTooLong
		}
		line = append(line, fragment...)
		if err == nil {
			return bytes.TrimSpace(line), nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, io.EOF) {
			return line, io.EOF
		}
		return nil, err
	}
}

func (c *Client) kill() {
	if c.proc != nil && c.proc.Process != nil {
		_ = c.proc.Process.Kill()
	}
}

func (c *Client) stop() {
	if c.proc == nil {
		return
	}
	if c.stdin != nil {
		_ = c.stdin.Close()
	}
	_ = c.proc.Process.Kill()
	_ = c.proc.Wait()
	c.proc = nil
	c.stdin = nil
	c.stdout = nil
}

func contextError(parent context.Context) error {
	if errors.Is(parent.Err(), context.DeadlineExceeded) {
		return ErrTimeout
	}
	if errors.Is(parent.Err(), context.Canceled) {
		return ErrCanceled
	}
	return ErrTimeout
}

type boundedBuffer struct {
	mu    sync.Mutex
	data  []byte
	limit int
}

func (b *boundedBuffer) Write(payload []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if remaining := b.limit - len(b.data); remaining > 0 {
		if len(payload) <= remaining {
			b.data = append(b.data, payload...)
		} else {
			b.data = append(b.data, payload[:remaining]...)
		}
	}
	return len(payload), nil
}

func workerEnvironment(environ []string) []string {
	allowed := map[string]bool{
		"PATH": true, "PATHEXT": true, "SYSTEMROOT": true, "SYSTEMDRIVE": true,
		"WINDIR": true, "COMSPEC": true, "TEMP": true, "TMP": true, "TMPDIR": true,
		"LANG": true, "LC_ALL": true,
	}
	result := make([]string, 0, len(environ)+2)
	for _, entry := range environ {
		key := entry
		if index := strings.IndexByte(entry, '='); index >= 0 {
			key = entry[:index]
		}
		if allowed[strings.ToUpper(key)] {
			result = append(result, entry)
		}
	}
	return append(result, "NODE_ENV=production", "NODE_NO_WARNINGS=1")
}
