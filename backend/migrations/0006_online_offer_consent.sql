-- KHA-68 correction schema version 6. Exact offer consent, versioned offer
-- transitions and the durable turn budget journal.
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

-- An offer is part of the versioned match state, so the event that records
-- it carries the exact offer it created. The payload is the offer itself: its
-- identity, kind, seat, target and the version it produced. It never carries
-- a participant reference, a credential or a private route.
ALTER TABLE online_events ADD COLUMN IF NOT EXISTS offer_json jsonb;

ALTER TABLE online_events DROP CONSTRAINT IF EXISTS online_events_event_kind_check;
ALTER TABLE online_events ADD CONSTRAINT online_events_event_kind_check CHECK (event_kind IN ('match_created', 'move', 'resign', 'abort', 'cancel', 'control_change', 'timeout', 'replay_removed', 'draw_agreement', 'takeback_accepted', 'offer_created', 'recovery_attempt', 'illegal_move_loss'));

ALTER TABLE online_events DROP CONSTRAINT IF EXISTS online_events_offer_check;
ALTER TABLE online_events ADD CONSTRAINT online_events_offer_check CHECK ((event_kind = 'offer_created') = (offer_json IS NOT NULL));

ALTER TABLE online_events DROP CONSTRAINT IF EXISTS online_events_offer_payload_check;
ALTER TABLE online_events ADD CONSTRAINT online_events_offer_payload_check CHECK (offer_json IS NULL OR jsonb_typeof(offer_json) = 'object');

-- The turn budget journal.
--
-- A recovery budget belongs to a turn, not to the seat row alone. The seat
-- counters hold what the current turn has already spent and are reset when
-- that seat's own move is accepted. The journal keeps the spent budget of
-- every turn, keyed by the accepted-move prefix the turn starts from, so a
-- takeback that restores a turn restores the allowance that turn had already
-- spent instead of handing the seat a fresh one.
--
-- The journal is append-only per turn: a row is written when an attempt is
-- spent and updated while that same turn is still in progress. A turn that
-- was never spent has no row, which means a zero budget.
CREATE TABLE IF NOT EXISTS online_turn_budgets (
  match_id text NOT NULL REFERENCES online_matches(match_id) ON DELETE CASCADE,
  seat text NOT NULL CHECK (seat IN ('white', 'black')),
  turn_number bigint NOT NULL CHECK (turn_number >= 0),
  prefix_hash text NOT NULL CHECK (prefix_hash ~ '^[0-9a-f]{64}$'),
  illegal_attempts_spent integer NOT NULL DEFAULT 0 CHECK (illegal_attempts_spent BETWEEN 0 AND 16),
  format_corrections_spent integer NOT NULL DEFAULT 0 CHECK (format_corrections_spent BETWEEN 0 AND 16),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (match_id, seat, prefix_hash)
);
CREATE INDEX IF NOT EXISTS online_turn_budgets_turn ON online_turn_budgets(match_id, turn_number, seat);

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
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_turn_budgets TO kamkm_online_api', schema_name);
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
REVOKE ALL PRIVILEGES ON TABLE online_turn_budgets FROM PUBLIC;
