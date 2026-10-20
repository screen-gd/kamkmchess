package serverapp

import (
	"context"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// The trusted deadline reconciliation loop.
//
// A match arms at most one deadline: the opening reply window or the main
// clock. When that deadline passes the match must end even if neither
// participant sends another command. The loop below realises those deadlines.
//
// The loop is a server capability and not a participant command. It settles a
// due match through the trusted online deadline seam, it never fabricates a
// participant identity, it never spends a participant-chosen operation ID,
// and no HTTP route can trigger it.

// DefaultDeadlineSweepInterval is how often the server reconciles the match
// deadlines that have passed.
const DefaultDeadlineSweepInterval = time.Second

// DefaultDeadlineSweepBatch bounds one reconciliation pass.
const DefaultDeadlineSweepBatch = online.DefaultDeadlineSweepBatch

// DeadlineSweepConfig configures the server's deadline reconciliation loop.
type DeadlineSweepConfig struct {
	// Interval is how often the loop runs one pass.
	Interval time.Duration
	// Batch bounds the number of matches one pass reconciles.
	Batch int
	// OnError receives the failure of a pass. It never stops the loop: an
	// expiry that could not be settled stays pending and a later pass retries
	// it.
	OnError func(error)
}

// StartDeadlineReconciler starts the trusted deadline reconciliation loop.
//
// The loop runs until the returned stop function is called or the context is
// cancelled. The stop function waits for the loop to finish, so the caller can
// close its database pool without a background sweep still using it.
func StartDeadlineReconciler(ctx context.Context, reconciler online.DeadlineReconciler, config DeadlineSweepConfig) func() {
	if reconciler == nil {
		return func() {}
	}
	interval := config.Interval
	if interval <= 0 {
		interval = DefaultDeadlineSweepInterval
	}
	batch := config.Batch
	if batch <= 0 {
		batch = DefaultDeadlineSweepBatch
	}
	runCtx, cancel := context.WithCancel(ctx)
	var done sync.WaitGroup
	done.Add(1)
	go func() {
		defer done.Done()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-ticker.C:
				sweepDeadlines(runCtx, reconciler, batch, config.OnError)
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			cancel()
			done.Wait()
		})
	}
}

// sweepDeadlines runs one bounded reconciliation pass.
//
// A failed pass is reported, never swallowed: an expiry that could not be
// settled stays pending and a later pass retries it.
func sweepDeadlines(ctx context.Context, reconciler online.DeadlineReconciler, batch int, onError func(error)) {
	if _, err := reconciler.ReconcileDeadlines(ctx, batch); err != nil {
		if onError != nil {
			onError(err)
			return
		}
		slog.Default().Error("online deadline reconciliation failed", "error", err)
	}
}

// positiveInt reads an optional positive integer setting of the deadline
// sweep. An unparsable or non-positive value falls back to the default
// instead of failing the whole boot.
func positiveInt(getenv func(string) string, key string, fallback int) int {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}
