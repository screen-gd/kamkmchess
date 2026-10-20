// Package serverapp composes the storage and online APIs for local and hosted entry points.
package serverapp

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/auth"
	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/profile"
	"github.com/Kamkmgamer/kamkmchess/backend/rulesworker"
	"github.com/Kamkmgamer/kamkmchess/backend/storage"
	"github.com/jackc/pgx/v5/pgxpool"
)

// guestProofIssuer issues guest ownership proofs through the trusted
// allocator.
//
// The allocator is the only component that may mint a proof, and it mints one
// only from a live guest seat credential. The HTTP surface never receives the
// allocator itself.
type guestProofIssuer struct {
	allocator *onlineauth.Allocator
}

func (i guestProofIssuer) IssueOwnershipProof(ctx context.Context, seatSecret, origin string) (onlineauth.IssuedOwnershipProof, error) {
	return i.allocator.IssueOwnershipProof(ctx, seatSecret, origin)
}

type Config struct {
	DatabaseURL string
	Clerk       auth.Config
	Online      OnlineConfig
}

// OnlineConfig holds the shared online authorization settings.
type OnlineConfig struct {
	// GuestCredentialTTL bounds the lifetime of an issued guest seat
	// credential.
	GuestCredentialTTL time.Duration
	// OwnershipProofTTL bounds the lifetime of an issued ownership proof.
	OwnershipProofTTL time.Duration
	// StreamMaxDuration bounds one live subscription window.
	StreamMaxDuration time.Duration
	// RulesWorkerEntry is the private rules process. Without it the online
	// service still answers reads but rejects commands that need the rules
	// policy.
	RulesWorkerEntry string
	// DeadlineSweepInterval is how often the server reconciles the match
	// deadlines that have passed.
	DeadlineSweepInterval time.Duration
	// DeadlineSweepBatch bounds one reconciliation pass.
	DeadlineSweepBatch int
}

// Load reads only server configuration. Its errors never include configured values.
func Load(getenv func(string) string) (Config, error) {
	cfg := Config{
		DatabaseURL: strings.TrimSpace(getenv("DATABASE_URL")),
		Clerk: auth.Config{
			Issuer:            strings.TrimSpace(getenv("CLERK_ISSUER")),
			JWKSURL:           strings.TrimSpace(getenv("CLERK_JWKS_URL")),
			Audience:          strings.TrimSpace(getenv("CLERK_AUDIENCE")),
			AuthorizedParties: csv(getenv("CLERK_AUTHORIZED_PARTIES")),
			AllowedOrigins:    csv(getenv("APP_ALLOWED_ORIGINS")),
		},
		Online: OnlineConfig{
			GuestCredentialTTL:    duration(getenv, "ONLINE_GUEST_CREDENTIAL_TTL", onlineauth.DefaultGuestCredentialTTL),
			OwnershipProofTTL:     duration(getenv, "ONLINE_OWNERSHIP_PROOF_TTL", onlineauth.DefaultOwnershipProofTTL),
			StreamMaxDuration:     duration(getenv, "ONLINE_STREAM_MAX_DURATION", onlineauth.DefaultStreamMaxDuration),
			RulesWorkerEntry:      strings.TrimSpace(getenv("ONLINE_RULES_WORKER_ENTRY")),
			DeadlineSweepInterval: duration(getenv, "ONLINE_DEADLINE_SWEEP_INTERVAL", DefaultDeadlineSweepInterval),
			DeadlineSweepBatch:    positiveInt(getenv, "ONLINE_DEADLINE_SWEEP_BATCH", DefaultDeadlineSweepBatch),
		},
	}
	if cfg.DatabaseURL == "" || len(cfg.Clerk.AllowedOrigins) == 0 {
		return Config{}, errors.New("storage configuration incomplete")
	}
	if _, err := auth.NewVerifier(cfg.Clerk); err != nil {
		return Config{}, errors.New("invalid Clerk verifier configuration")
	}
	return cfg, nil
}

// Open never migrates the database. Use cmd/migrate with a separate role first.
//
// It returns the composed API handler. The private single-owner sync API keeps
// its own origin and header policy; the online participant API is mounted
// under its own path with the guest seat credential header allowed.
func Open(ctx context.Context, cfg Config) (http.Handler, func(), error) {
	verifier, err := auth.NewVerifier(cfg.Clerk)
	if err != nil {
		return nil, nil, errors.New("invalid Clerk verifier configuration")
	}
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, nil, errors.New("database initialization failed")
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, nil, errors.New("database is unavailable")
	}
	store, err := storage.Open(ctx, pool)
	if err != nil {
		pool.Close()
		return nil, nil, errors.New("storage initialization failed")
	}
	evaluator, closeWorker, err := openEvaluator(cfg.Online.RulesWorkerEntry)
	if err != nil {
		pool.Close()
		return nil, nil, err
	}
	authorizer, err := onlineauth.Open(ctx, pool, verifier, onlineauth.Options{
		GuestCredentialTTL: cfg.Online.GuestCredentialTTL,
		OwnershipProofTTL:  cfg.Online.OwnershipProofTTL,
		StreamMaxDuration:  cfg.Online.StreamMaxDuration,
	})
	if err != nil {
		if closeWorker != nil {
			closeWorker()
		}
		pool.Close()
		return nil, nil, errors.New("online authorization initialization failed")
	}
	// The authorization service is the participant authorizer. The writer
	// re-checks it inside every acceptance transaction.
	onlineService, err := online.Open(ctx, pool, evaluator, online.WithSeatAuthorizer(authorizer))
	if err != nil {
		if closeWorker != nil {
			closeWorker()
		}
		pool.Close()
		return nil, nil, errors.New("online service initialization failed")
	}
	// The public profile service owns the stable public identity of an
	// account and the explicit guest link. It writes only its own tables.
	profileService, err := profile.Open(ctx, pool, authorizer, profile.Options{})
	if err != nil {
		if closeWorker != nil {
			closeWorker()
		}
		pool.Close()
		return nil, nil, errors.New("public profile initialization failed")
	}
	root := http.NewServeMux()
	root.Handle("/v1/online/", httpapi.CORSWithHeaders(cfg.Clerk.AllowedOrigins, httpapi.OnlineRequestHeaders, httpapi.NewOnline(onlineService, authorizer, httpapi.OnlineOptions{AllowedOrigins: cfg.Clerk.AllowedOrigins})))
	// The public profile API is mounted under its own prefixes so it never
	// widens the private single-owner sync API.
	profileHandler := httpapi.CORSWithMethods(cfg.Clerk.AllowedOrigins, httpapi.ProfileRequestHeaders, "GET, POST, PUT, OPTIONS", httpapi.NewProfile(profileService, guestProofIssuer{allocator: onlineauth.NewAllocator(authorizer)}, authorizer, httpapi.OnlineOptions{AllowedOrigins: cfg.Clerk.AllowedOrigins}))
	root.Handle("/v1/profiles/", profileHandler)
	root.Handle("/v1/account/", profileHandler)
	root.Handle("/v1/guest-seats/", profileHandler)
	root.Handle("/", httpapi.CORS(cfg.Clerk.AllowedOrigins, httpapi.NewAuthenticated(store, verifier)))
	// The trusted deadline reconciliation loop settles the matches whose
	// opening reply window or main clock has passed, without waiting for a
	// participant command. It is bound to the server context and to the
	// release function.
	stopDeadlines := StartDeadlineReconciler(ctx, onlineService, DeadlineSweepConfig{
		Interval: cfg.Online.DeadlineSweepInterval,
		Batch:    cfg.Online.DeadlineSweepBatch,
	})
	release := func() {
		// The deadline loop stops before the pool closes, so no background
		// sweep can use a closed connection.
		stopDeadlines()
		if closeWorker != nil {
			closeWorker()
		}
		pool.Close()
	}
	return root, release, nil
}

// openEvaluator starts the private rules process when one is configured.
func openEvaluator(entry string) (online.Evaluator, func(), error) {
	if entry == "" {
		return nil, nil, nil
	}
	client, err := rulesworker.New(rulesworker.Config{Entry: entry})
	if err != nil {
		return nil, nil, errors.New("online rules worker initialization failed")
	}
	evaluator, err := rulesworker.NewOnlineEvaluator(client)
	if err != nil {
		_ = client.Close()
		return nil, nil, errors.New("online rules worker initialization failed")
	}
	return evaluator, func() { _ = client.Close() }, nil
}

func csv(value string) []string {
	var result []string
	seen := map[string]bool{}
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part != "" && !seen[part] {
			seen[part] = true
			result = append(result, part)
		}
	}
	return result
}

// duration reads an optional duration setting. An unparsable or non-positive
// value falls back to the default instead of failing the whole boot.
func duration(getenv func(string) string, key string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}
