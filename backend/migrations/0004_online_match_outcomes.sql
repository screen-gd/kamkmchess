-- KHA-68 schema version 4. Authoritative opening clocks, mutual draw offers,
-- exact-version takeback targets and shared recovery budgets.
--
-- Additive only. Nothing in this file alters, rewrites, or re-grants the
-- private single-owner sync tables from 0001_storage.sql, and no existing
-- shared row is rewritten. The online tables keep no foreign keys into the
-- private archive and never store provider credentials, raw provider
-- requests, AI conversation, private endpoints, or owner archives.
--
-- Go is the only transaction writer. The kamkm_online_rules runtime role keeps
-- schema USAGE and no table privileges, so the private rules process cannot
-- read or write canonical online state.

-- The wire contract grew new actions, so a new match records the new schema
-- version. Existing rows keep the version they were created with.
ALTER TABLE online_matches DROP CONSTRAINT IF EXISTS online_matches_schema_version_check;
ALTER TABLE online_matches ADD CONSTRAINT online_matches_schema_version_check CHECK (schema_version IN (1, 2));

-- Opening clocks. A match has at most one armed deadline: either a main clock
-- or the opening reply window. reply_seat names the side that owes the reply.
ALTER TABLE online_clocks ADD COLUMN IF NOT EXISTS reply_seat text;
ALTER TABLE online_clocks ADD COLUMN IF NOT EXISTS reply_deadline_at timestamptz;
ALTER TABLE online_clocks DROP CONSTRAINT IF EXISTS online_clocks_reply_pair_check;
ALTER TABLE online_clocks ADD CONSTRAINT online_clocks_reply_pair_check CHECK ((reply_seat IS NULL) = (reply_deadline_at IS NULL));
ALTER TABLE online_clocks DROP CONSTRAINT IF EXISTS online_clocks_reply_seat_check;
ALTER TABLE online_clocks ADD CONSTRAINT online_clocks_reply_seat_check CHECK (reply_seat IS NULL OR reply_seat IN ('white', 'black'));
ALTER TABLE online_clocks DROP CONSTRAINT IF EXISTS online_clocks_one_deadline_check;
ALTER TABLE online_clocks ADD CONSTRAINT online_clocks_one_deadline_check CHECK (NOT (active_seat IS NOT NULL AND reply_seat IS NOT NULL));

-- The trusted deadline reconciliation scans the matches whose armed deadline
-- has passed. These partial indexes keep that bounded scan off a sequential
-- read of every stored clock. They add no constraint and rewrite no row.
CREATE INDEX IF NOT EXISTS online_clocks_deadline ON online_clocks(deadline_at) WHERE deadline_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS online_clocks_reply_deadline ON online_clocks(reply_deadline_at) WHERE reply_deadline_at IS NOT NULL;

-- Shared recovery budgets. The counters hold what the current turn has already
-- spent. The policy limits live in the versioned contract; the stored bounds
-- here are a hard ceiling only.
ALTER TABLE online_seats ADD COLUMN IF NOT EXISTS illegal_attempts_spent integer NOT NULL DEFAULT 0;
ALTER TABLE online_seats ADD COLUMN IF NOT EXISTS format_corrections_spent integer NOT NULL DEFAULT 0;
ALTER TABLE online_seats DROP CONSTRAINT IF EXISTS online_seats_illegal_attempts_check;
ALTER TABLE online_seats ADD CONSTRAINT online_seats_illegal_attempts_check CHECK (illegal_attempts_spent BETWEEN 0 AND 16);
ALTER TABLE online_seats DROP CONSTRAINT IF EXISTS online_seats_format_corrections_check;
ALTER TABLE online_seats ADD CONSTRAINT online_seats_format_corrections_check CHECK (format_corrections_spent BETWEEN 0 AND 16);

-- Discarded accepted moves. A takeback keeps the accepted move rows and their
-- private archives; it only records that the move left the current line.
CREATE TABLE IF NOT EXISTS online_discarded_moves (
  match_id text NOT NULL,
  move_version bigint NOT NULL,
  takeback_version bigint NOT NULL CHECK (takeback_version >= 1),
  discarded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (match_id, move_version),
  FOREIGN KEY (match_id, move_version) REFERENCES online_moves(match_id, version) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS online_discarded_moves_takeback ON online_discarded_moves(match_id, takeback_version);

-- Pending offers. An offer is a request, not a match transition: it never
-- changes the position, the turn or the clocks, so it carries no match
-- version of its own. The base version binds a takeback offer to the exact
-- position it was made against.
CREATE TABLE IF NOT EXISTS online_offers (
  offer_id text PRIMARY KEY CHECK (offer_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$'),
  match_id text NOT NULL REFERENCES online_matches(match_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('draw', 'takeback')),
  seat text NOT NULL CHECK (seat IN ('white', 'black')),
  target_version bigint CHECK (target_version IS NULL OR target_version >= 1),
  base_version bigint NOT NULL CHECK (base_version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  resolution text CHECK (resolution IS NULL OR resolution IN ('accepted', 'superseded', 'withdrawn')),
  CHECK ((kind = 'takeback') = (target_version IS NOT NULL)),
  CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS online_offers_one_pending ON online_offers(match_id, kind, seat) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS online_offers_match ON online_offers(match_id, kind, created_at DESC);

-- Event kinds for the new transitions.
ALTER TABLE online_events DROP CONSTRAINT IF EXISTS online_events_event_kind_check;
ALTER TABLE online_events ADD CONSTRAINT online_events_event_kind_check CHECK (event_kind IN ('match_created', 'move', 'resign', 'abort', 'cancel', 'control_change', 'timeout', 'replay_removed', 'draw_agreement', 'takeback_accepted', 'recovery_attempt', 'illegal_move_loss'));
ALTER TABLE online_events ADD COLUMN IF NOT EXISTS takeback_target_version bigint;
ALTER TABLE online_events ADD COLUMN IF NOT EXISTS recovery_attempt text;
ALTER TABLE online_events DROP CONSTRAINT IF EXISTS online_events_takeback_target_check;
ALTER TABLE online_events ADD CONSTRAINT online_events_takeback_target_check CHECK ((event_kind = 'takeback_accepted') = (takeback_target_version IS NOT NULL));
ALTER TABLE online_events DROP CONSTRAINT IF EXISTS online_events_recovery_attempt_check;
ALTER TABLE online_events ADD CONSTRAINT online_events_recovery_attempt_check CHECK (recovery_attempt IS NULL OR recovery_attempt IN ('illegal_move', 'formatting_correction'));
ALTER TABLE online_events DROP CONSTRAINT IF EXISTS online_events_result_scope_check;
-- The scope of an event that may carry a result was fixed by an auto-named
-- check in 0002. It is replaced here so the new terminal kinds may carry one.
DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid = 'online_events'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%resign%'
      AND pg_get_constraintdef(c.oid) LIKE '%result IS NULL%'
      AND pg_get_constraintdef(c.oid) NOT LIKE '%draw_agreement%'
  LOOP
    EXECUTE format('ALTER TABLE online_events DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END
$$;
ALTER TABLE online_events ADD CONSTRAINT online_events_result_scope_check CHECK (event_kind IN ('move', 'resign', 'abort', 'cancel', 'timeout', 'draw_agreement', 'illegal_move_loss') OR result IS NULL);

-- An offer is written once. Only its resolution may be recorded, and only
-- once, so a later offer cannot rewrite what was offered.
CREATE OR REPLACE FUNCTION online_guard_offer_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.offer_id <> OLD.offer_id OR NEW.match_id <> OLD.match_id OR NEW.kind <> OLD.kind
     OR NEW.seat <> OLD.seat OR NEW.created_at <> OLD.created_at
     OR NEW.target_version IS DISTINCT FROM OLD.target_version
     OR NEW.base_version <> OLD.base_version THEN
    RAISE EXCEPTION 'online offer identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'online offer resolution is final' USING ERRCODE = '55000';
  END IF;
  IF NEW.resolved_at IS NULL AND NEW.resolution IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.resolved_at IS NULL OR NEW.resolution IS NULL OR NEW.resolved_at < OLD.created_at THEN
    RAISE EXCEPTION 'online offer resolution is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_offers_guard ON online_offers;
CREATE TRIGGER online_offers_guard BEFORE UPDATE ON online_offers
FOR EACH ROW EXECUTE FUNCTION online_guard_offer_update();

DROP TRIGGER IF EXISTS online_offers_immutable_delete ON online_offers;
CREATE TRIGGER online_offers_immutable_delete BEFORE DELETE ON online_offers
FOR EACH ROW EXECUTE FUNCTION online_reject_mutation();

-- Runtime grants. Roles are cluster-scoped, so creation is best effort: a
-- migration role without CREATEROLE still applies the schema and skips grants.
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['kamkm_online_api', 'kamkm_online_rules'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'KHA-68: role % not created; runtime grants skipped', role_name;
      END;
    END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  schema_name text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_api') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_offers TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_discarded_moves TO kamkm_online_api', schema_name);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_rules') THEN
    -- USAGE without table privileges: the rules process receives versioned input
    -- over its private channel and has no independent database authority.
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO kamkm_online_rules', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM kamkm_online_rules', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM kamkm_online_rules', schema_name);
  END IF;
END
$$;

-- New shared tables never fall back to PUBLIC access.
REVOKE ALL PRIVILEGES ON TABLE online_offers FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_discarded_moves FROM PUBLIC;
