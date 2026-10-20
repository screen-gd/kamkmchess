// Package migrations applies the application's explicitly versioned PostgreSQL schema.
package migrations

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed *.sql
var files embed.FS

type migration struct {
	version int
	name    string
}

// Apply applies migrations in order. Callers opt in explicitly; Open storage does not mutate schema.
func Apply(ctx context.Context, pool *pgxpool.Pool) error {
	if pool == nil {
		return fmt.Errorf("migrations: nil pool")
	}
	all, err := list()
	if err != nil {
		return err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS kamkmchess_schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return err
	}
	for _, m := range all {
		applied, err := isApplied(ctx, tx, m.version)
		if err != nil {
			return err
		}
		if applied {
			continue
		}
		sql, err := files.ReadFile(m.name)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, string(sql)); err != nil {
			return fmt.Errorf("migrations: apply %s: %w", m.name, err)
		}
		if _, err = tx.Exec(ctx, `INSERT INTO kamkmchess_schema_migrations(version) VALUES($1)`, m.version); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func list() ([]migration, error) {
	names, err := fs.Glob(files, "*.sql")
	if err != nil {
		return nil, err
	}
	out := make([]migration, 0, len(names))
	for _, name := range names {
		prefix, _, ok := strings.Cut(name, "_")
		if !ok {
			return nil, fmt.Errorf("migrations: %s has no version prefix", name)
		}
		version, err := strconv.Atoi(prefix)
		if err != nil || version < 1 {
			return nil, fmt.Errorf("migrations: %s has invalid version prefix", name)
		}
		out = append(out, migration{version: version, name: name})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	for i := 1; i < len(out); i++ {
		if out[i].version == out[i-1].version {
			return nil, fmt.Errorf("migrations: duplicate version %d", out[i].version)
		}
	}
	return out, nil
}

type queryRower interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func isApplied(ctx context.Context, q queryRower, version int) (bool, error) {
	var applied bool
	err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM kamkmchess_schema_migrations WHERE version=$1)`, version).Scan(&applied)
	return applied, err
}
