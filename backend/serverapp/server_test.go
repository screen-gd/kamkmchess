package serverapp

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// fakeDeadlineReconciler counts the reconciliation passes of the server loop.
type fakeDeadlineReconciler struct {
	mu    sync.Mutex
	calls int
}

func (f *fakeDeadlineReconciler) ReconcileDeadlines(context.Context, int) (online.DeadlineSweep, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return online.DeadlineSweep{}, nil
}

func (f *fakeDeadlineReconciler) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func TestLoadFailsClosedAndDoesNotEchoValues(t *testing.T) {
	_, err := Load(func(string) string { return "secret-canary" })
	if err == nil || strings.Contains(err.Error(), "secret-canary") {
		t.Fatal("invalid configuration was accepted or disclosed")
	}
}

func TestLoadNormalizesOriginLists(t *testing.T) {
	values := map[string]string{
		"DATABASE_URL":             "postgres://local/fixture",
		"CLERK_ISSUER":             "https://fixture.clerk.accounts.dev",
		"CLERK_JWKS_URL":           "https://fixture.clerk.accounts.dev/.well-known/jwks.json",
		"CLERK_AUTHORIZED_PARTIES": " https://chess.example,https://chess.example ",
		"APP_ALLOWED_ORIGINS":      "https://chess.example,,https://staging.example",
	}
	cfg, err := Load(func(key string) string { return values[key] })
	if err != nil || len(cfg.Clerk.AuthorizedParties) != 1 || len(cfg.Clerk.AllowedOrigins) != 2 {
		t.Fatalf("normalization failed: %v", err)
	}
}

func TestLoadReadsTheDeadlineSweepSettings(t *testing.T) {
	values := map[string]string{
		"DATABASE_URL":                   "postgres://local/fixture",
		"CLERK_ISSUER":                   "https://fixture.clerk.accounts.dev",
		"CLERK_JWKS_URL":                 "https://fixture.clerk.accounts.dev/.well-known/jwks.json",
		"CLERK_AUTHORIZED_PARTIES":       "https://chess.example",
		"APP_ALLOWED_ORIGINS":            "https://chess.example",
		"ONLINE_DEADLINE_SWEEP_INTERVAL": "250ms",
		"ONLINE_DEADLINE_SWEEP_BATCH":    "7",
	}
	cfg, err := Load(func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Online.DeadlineSweepInterval != 250*time.Millisecond || cfg.Online.DeadlineSweepBatch != 7 {
		t.Fatalf("the deadline sweep settings = %s/%d", cfg.Online.DeadlineSweepInterval, cfg.Online.DeadlineSweepBatch)
	}
	// An unparsable value falls back to the default instead of failing the boot.
	values["ONLINE_DEADLINE_SWEEP_INTERVAL"] = "not-a-duration"
	values["ONLINE_DEADLINE_SWEEP_BATCH"] = "0"
	cfg, err = Load(func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Online.DeadlineSweepInterval != DefaultDeadlineSweepInterval || cfg.Online.DeadlineSweepBatch != DefaultDeadlineSweepBatch {
		t.Fatalf("the fallback deadline sweep settings = %s/%d", cfg.Online.DeadlineSweepInterval, cfg.Online.DeadlineSweepBatch)
	}
}

// The deadline loop runs while the server lives and stops when it is
// released.
func TestStartDeadlineReconcilerRunsAndStopsOnRelease(t *testing.T) {
	reconciler := &fakeDeadlineReconciler{}
	stop := StartDeadlineReconciler(context.Background(), reconciler, DeadlineSweepConfig{Interval: 5 * time.Millisecond})
	deadline := time.Now().Add(5 * time.Second)
	for reconciler.count() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if reconciler.count() == 0 {
		t.Fatal("the deadline loop never ran")
	}
	stop()
	after := reconciler.count()
	time.Sleep(100 * time.Millisecond)
	if reconciler.count() != after {
		t.Fatalf("the released deadline loop kept running: %d passes after the release", reconciler.count()-after)
	}
	// The stop function is idempotent.
	stop()
}

// The deadline loop stops with the server context.
func TestStartDeadlineReconcilerStopsWithTheContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	reconciler := &fakeDeadlineReconciler{}
	stop := StartDeadlineReconciler(ctx, reconciler, DeadlineSweepConfig{Interval: 5 * time.Millisecond})
	deadline := time.Now().Add(5 * time.Second)
	for reconciler.count() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if reconciler.count() == 0 {
		t.Fatal("the deadline loop never ran")
	}
	cancel()
	stop()
	after := reconciler.count()
	time.Sleep(100 * time.Millisecond)
	if reconciler.count() != after {
		t.Fatalf("the cancelled deadline loop kept running: %d passes after the cancel", reconciler.count()-after)
	}
}

// A composition without a deadline reconciler starts no background work.
func TestStartDeadlineReconcilerWithoutAReconcilerStartsNothing(t *testing.T) {
	stop := StartDeadlineReconciler(context.Background(), nil, DeadlineSweepConfig{Interval: time.Millisecond})
	stop()
}
