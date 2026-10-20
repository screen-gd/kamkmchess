-- KHA-65 schema version 2. Shared, multiplayer online state.
--
-- Additive only. Nothing in this file alters, rewrites, or re-grants the private
-- single-owner sync tables from 0001_storage.sql. The online tables have no
-- foreign keys into the private archive and never store provider credentials,
-- raw provider requests, AI conversation, private endpoints, or owner archives.
--
-- Go is the only transaction writer. The kamkm_online_rules runtime role gets
-- schema USAGE and no table privileges at all, so the private rules process
-- cannot write or read canonical online state. The kamkm_online_api role gets
-- read/write access to the online tables only.

CREATE TABLE IF NOT EXISTS online_matches (
  match_id text PRIMARY KEY CHECK (match_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$'),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  variant text NOT NULL CHECK (variant IN ('orthodox')),
  starting_fen text NOT NULL CHECK (length(starting_fen) BETWEEN 4 AND 128),
  position_fen text NOT NULL CHECK (length(position_fen) BETWEEN 4 AND 128),
  starting_time_ms bigint NOT NULL CHECK (starting_time_ms BETWEEN 1 AND 86400000),
  increment_ms bigint NOT NULL CHECK (increment_ms BETWEEN 0 AND 60000),
  version bigint NOT NULL CHECK (version >= 1),
  control_epoch bigint NOT NULL CHECK (control_epoch >= 1),
  input_hash bytea NOT NULL CHECK (octet_length(input_hash) = 32),
  rules_policy_version text NOT NULL CHECK (length(rules_policy_version) BETWEEN 1 AND 64),
  status text NOT NULL CHECK (status IN ('active', 'completed', 'aborted')),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  result_version bigint CHECK (result_version IS NULL OR result_version >= 1),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'active') = (result IS NULL)),
  CHECK ((status = 'active') = (result_version IS NULL)),
  CHECK ((status = 'active') = (completed_at IS NULL)),
  CHECK (updated_at >= created_at)
);
CREATE INDEX IF NOT EXISTS online_matches_status_updated ON online_matches(status, updated_at DESC, match_id);

CREATE TABLE IF NOT EXISTS online_seats (
  match_id text NOT NULL REFERENCES online_matches(match_id) ON DELETE CASCADE,
  seat text NOT NULL CHECK (seat IN ('white', 'black')),
  owner_kind text NOT NULL CHECK (owner_kind IN ('account', 'guest')),
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  public_label text NOT NULL CHECK (length(public_label) BETWEEN 1 AND 64 AND public_label !~ '[[:cntrl:]]' AND public_label !~ '[@]' AND position('://' in public_label) = 0),
  control_kind text NOT NULL CHECK (control_kind IN ('human', 'agent', 'engine')),
  model_label text CHECK (model_label IS NULL OR (length(model_label) BETWEEN 1 AND 64 AND model_label !~ '[[:cntrl:]]' AND model_label !~ '[@]' AND position('://' in model_label) = 0)),
  control_epoch bigint NOT NULL CHECK (control_epoch >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (match_id, seat),
  CHECK ((control_kind = 'human') = (model_label IS NULL))
);
CREATE INDEX IF NOT EXISTS online_seats_owner ON online_seats(owner_kind, owner_id, match_id);

CREATE TABLE IF NOT EXISTS online_clocks (
  match_id text PRIMARY KEY REFERENCES online_matches(match_id) ON DELETE CASCADE,
  white_ms bigint NOT NULL CHECK (white_ms >= 0),
  black_ms bigint NOT NULL CHECK (black_ms >= 0),
  active_seat text CHECK (active_seat IS NULL OR active_seat IN ('white', 'black')),
  active_since timestamptz,
  deadline_at timestamptz,
  white_moved boolean NOT NULL DEFAULT false,
  black_moved boolean NOT NULL DEFAULT false,
  turn_number bigint NOT NULL DEFAULT 0 CHECK (turn_number >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((active_seat IS NULL) = (active_since IS NULL)),
  CHECK ((active_seat IS NULL) = (deadline_at IS NULL)),
  CHECK (deadline_at IS NULL OR deadline_at >= active_since)
);

CREATE TABLE IF NOT EXISTS online_moves (
  match_id text NOT NULL REFERENCES online_matches(match_id) ON DELETE CASCADE,
  version bigint NOT NULL CHECK (version >= 2),
  seat text NOT NULL CHECK (seat IN ('white', 'black')),
  uci text NOT NULL CHECK (uci ~ '^[a-h][1-8][a-h][1-8][qrbn]?$'),
  san text NOT NULL CHECK (length(san) BETWEEN 1 AND 16 AND san !~ '[[:cntrl:]]'),
  resulting_fen text NOT NULL CHECK (length(resulting_fen) BETWEEN 4 AND 128),
  decision_at timestamptz NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (match_id, version)
);

CREATE TABLE IF NOT EXISTS online_events (
  match_id text NOT NULL REFERENCES online_matches(match_id) ON DELETE CASCADE,
  version bigint NOT NULL CHECK (version >= 1),
  event_kind text NOT NULL CHECK (event_kind IN ('match_created', 'move', 'resign', 'abort', 'control_change', 'timeout', 'replay_removed')),
  seat text CHECK (seat IS NULL OR seat IN ('white', 'black')),
  control_epoch bigint NOT NULL CHECK (control_epoch >= 1),
  decision_at timestamptz NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  move_uci text CHECK (move_uci IS NULL OR move_uci ~ '^[a-h][1-8][a-h][1-8][qrbn]?$'),
  move_san text CHECK (move_san IS NULL OR (length(move_san) BETWEEN 1 AND 16 AND move_san !~ '[[:cntrl:]]')),
  resulting_fen text CHECK (resulting_fen IS NULL OR length(resulting_fen) BETWEEN 4 AND 128),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  control_kind text CHECK (control_kind IS NULL OR control_kind IN ('human', 'agent', 'engine')),
  control_model_label text CHECK (control_model_label IS NULL OR (length(control_model_label) BETWEEN 1 AND 64 AND control_model_label !~ '[[:cntrl:]]' AND control_model_label !~ '[@]' AND position('://' in control_model_label) = 0)),
  PRIMARY KEY (match_id, version),
  CHECK ((event_kind = 'move') = (move_uci IS NOT NULL)),
  CHECK ((event_kind = 'move') = (move_san IS NOT NULL)),
  CHECK ((event_kind = 'move') = (resulting_fen IS NOT NULL)),
  CHECK ((event_kind = 'control_change') = (control_kind IS NOT NULL)),
  CHECK ((control_kind = 'human') = (control_model_label IS NULL) OR control_kind IS NULL),
  CHECK (event_kind IN ('move', 'resign', 'abort', 'timeout') OR result IS NULL)
);
CREATE INDEX IF NOT EXISTS online_events_kind ON online_events(match_id, event_kind, version);

CREATE TABLE IF NOT EXISTS online_operation_receipts (
  scope_kind text NOT NULL CHECK (scope_kind IN ('match', 'queue', 'lease', 'replay')),
  scope_id text NOT NULL CHECK (length(scope_id) BETWEEN 1 AND 64),
  operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$'),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  result_json bytea NOT NULL CHECK (octet_length(result_json) > 0),
  version bigint NOT NULL CHECK (version >= 1),
  control_epoch bigint NOT NULL CHECK (control_epoch >= 1),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope_kind, scope_id, operation_id)
);

CREATE TABLE IF NOT EXISTS online_queue_entries (
  entry_id text PRIMARY KEY CHECK (entry_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$'),
  owner_kind text NOT NULL CHECK (owner_kind IN ('account', 'guest')),
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  seat_control_kind text NOT NULL CHECK (seat_control_kind IN ('human', 'agent')),
  seat_control_model_label text CHECK (seat_control_model_label IS NULL OR (length(seat_control_model_label) BETWEEN 1 AND 64 AND seat_control_model_label !~ '[[:cntrl:]]' AND seat_control_model_label !~ '[@]' AND position('://' in seat_control_model_label) = 0)),
  starting_time_ms bigint NOT NULL CHECK (starting_time_ms BETWEEN 1 AND 86400000),
  increment_ms bigint NOT NULL CHECK (increment_ms BETWEEN 0 AND 60000),
  status text NOT NULL CHECK (status IN ('waiting', 'cancelled', 'assigned')),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  ready_at timestamptz,
  cutoff_at timestamptz,
  assigned_match_id text REFERENCES online_matches(match_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((seat_control_kind = 'human') = (seat_control_model_label IS NULL)),
  CHECK ((status = 'assigned') = (assigned_match_id IS NOT NULL)),
  CHECK (cutoff_at IS NULL OR ready_at IS NOT NULL),
  CHECK (cutoff_at IS NULL OR cutoff_at >= ready_at)
);
CREATE INDEX IF NOT EXISTS online_queue_ready_bucket ON online_queue_entries(status, starting_time_ms, increment_ms, ready_at, entry_id);

CREATE TABLE IF NOT EXISTS online_runner_leases (
  lease_id text PRIMARY KEY CHECK (lease_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$'),
  match_id text NOT NULL REFERENCES online_matches(match_id) ON DELETE CASCADE,
  seat text NOT NULL CHECK (seat IN ('white', 'black')),
  control_epoch bigint NOT NULL CHECK (control_epoch >= 1),
  generation bigint NOT NULL CHECK (generation >= 1),
  runner_id text NOT NULL CHECK (length(runner_id) BETWEEN 1 AND 128),
  status text NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  acquired_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > acquired_at),
  CHECK ((status = 'active') = (revoked_at IS NULL)),
  UNIQUE (match_id, seat, generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS online_runner_leases_one_active ON online_runner_leases(match_id, seat) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS online_runner_leases_expiry ON online_runner_leases(status, expires_at);

CREATE TABLE IF NOT EXISTS online_public_projections (
  match_id text PRIMARY KEY REFERENCES online_matches(match_id) ON DELETE CASCADE,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  projection_json jsonb NOT NULL CHECK (jsonb_typeof(projection_json) = 'object'),
  result_hash bytea NOT NULL CHECK (octet_length(result_hash) = 32),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  revocation_marker_id text,
  CHECK ((revoked_at IS NULL) = (revocation_marker_id IS NULL))
);

CREATE TABLE IF NOT EXISTS online_deletion_markers (
  marker_id text PRIMARY KEY CHECK (marker_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$'),
  marker_kind text NOT NULL CHECK (marker_kind IN ('replay_removal', 'account_anonymization', 'match_removal')),
  subject_kind text NOT NULL CHECK (subject_kind IN ('account', 'guest', 'match')),
  subject_id text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 128),
  match_id text REFERENCES online_matches(match_id),
  reason text NOT NULL CHECK (reason IN ('owner_request', 'erasure_request', 'account_deletion')),
  requested_at timestamptz NOT NULL,
  applied_at timestamptz NOT NULL,
  CHECK (applied_at >= requested_at)
);
CREATE INDEX IF NOT EXISTS online_deletion_markers_subject ON online_deletion_markers(subject_kind, subject_id, applied_at DESC);
CREATE INDEX IF NOT EXISTS online_deletion_markers_match ON online_deletion_markers(match_id, applied_at DESC);

-- Accepted online history is append-only. Results and terminal status never change.
CREATE OR REPLACE FUNCTION online_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'online record is immutable' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS online_moves_immutable ON online_moves;
CREATE TRIGGER online_moves_immutable BEFORE UPDATE OR DELETE ON online_moves
FOR EACH ROW EXECUTE FUNCTION online_reject_mutation();

DROP TRIGGER IF EXISTS online_events_immutable ON online_events;
CREATE TRIGGER online_events_immutable BEFORE UPDATE OR DELETE ON online_events
FOR EACH ROW EXECUTE FUNCTION online_reject_mutation();

DROP TRIGGER IF EXISTS online_receipts_immutable ON online_operation_receipts;
CREATE TRIGGER online_receipts_immutable BEFORE UPDATE OR DELETE ON online_operation_receipts
FOR EACH ROW EXECUTE FUNCTION online_reject_mutation();

DROP TRIGGER IF EXISTS online_markers_immutable ON online_deletion_markers;
CREATE TRIGGER online_markers_immutable BEFORE UPDATE OR DELETE ON online_deletion_markers
FOR EACH ROW EXECUTE FUNCTION online_reject_mutation();

CREATE OR REPLACE FUNCTION online_guard_match_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.match_id <> OLD.match_id OR NEW.schema_version <> OLD.schema_version THEN
    RAISE EXCEPTION 'online match identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'online match version must advance' USING ERRCODE = '55000';
  END IF;
  IF OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result THEN
    RAISE EXCEPTION 'online final result is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.result IS NOT NULL AND NEW.result_version IS DISTINCT FROM OLD.result_version THEN
    RAISE EXCEPTION 'online result version is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.result IS NOT NULL AND NEW.result IS NULL THEN
    RAISE EXCEPTION 'online final result cannot be cleared' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'active' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'online terminal status is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
    RAISE EXCEPTION 'online completion time is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'online creation time is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_matches_guard ON online_matches;
CREATE TRIGGER online_matches_guard BEFORE UPDATE ON online_matches
FOR EACH ROW EXECUTE FUNCTION online_guard_match_update();

DROP TRIGGER IF EXISTS online_matches_immutable_delete ON online_matches;
CREATE TRIGGER online_matches_immutable_delete BEFORE DELETE ON online_matches
FOR EACH ROW EXECUTE FUNCTION online_reject_mutation();

-- A seat's owner is never reassigned to another live participant. The one-way
-- exception is the documented anonymization path: replace the owner reference
-- with the reserved 'anonymized' sentinel and the public label with
-- 'Deleted player' after recording an account/guest deletion marker. This keeps
-- retained history truthful without keeping a deleted person's identity forever.
CREATE OR REPLACE FUNCTION online_guard_seat_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.match_id <> OLD.match_id OR NEW.seat <> OLD.seat OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'online seat identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.owner_kind IS DISTINCT FROM OLD.owner_kind THEN
    IF OLD.owner_id = 'anonymized' THEN
      RAISE EXCEPTION 'online seat anonymization is final' USING ERRCODE = '55000';
    END IF;
    IF NEW.owner_kind <> OLD.owner_kind OR NEW.owner_id <> 'anonymized' OR NEW.public_label <> 'Deleted player' THEN
      RAISE EXCEPTION 'online seat ownership may only be anonymized' USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM online_deletion_markers
      WHERE marker_kind = 'account_anonymization'
        AND subject_kind = OLD.owner_kind
        AND subject_id = OLD.owner_id
        AND reason IN ('account_deletion', 'erasure_request')
    ) THEN
      RAISE EXCEPTION 'online seat anonymization needs a deletion marker' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_seats_guard ON online_seats;
CREATE TRIGGER online_seats_guard BEFORE UPDATE ON online_seats
FOR EACH ROW EXECUTE FUNCTION online_guard_seat_update();

CREATE OR REPLACE FUNCTION online_guard_projection_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'online public projection removal is final' USING ERRCODE = '55000';
  END IF;
  IF NEW.published_at <> OLD.published_at OR NEW.result_hash <> OLD.result_hash OR NEW.schema_version <> OLD.schema_version THEN
    RAISE EXCEPTION 'online public projection identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.revoked_at IS NOT NULL AND (NEW.projection_json <> '{}'::jsonb OR NEW.revocation_marker_id IS NULL) THEN
    RAISE EXCEPTION 'online public projection removal must clear its payload' USING ERRCODE = '55000';
  END IF;
  IF NEW.revoked_at IS NULL AND NEW.projection_json IS DISTINCT FROM OLD.projection_json THEN
    -- The only payload rewrite is public-label anonymization, and it must follow
    -- a recorded account/guest anonymization marker for this match.
    IF NOT EXISTS (
      SELECT 1 FROM online_deletion_markers
      WHERE match_id = OLD.match_id AND marker_kind = 'account_anonymization'
    ) THEN
      RAISE EXCEPTION 'online public projection payload is immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_projections_guard ON online_public_projections;
CREATE TRIGGER online_projections_guard BEFORE UPDATE ON online_public_projections
FOR EACH ROW EXECUTE FUNCTION online_guard_projection_update();

DROP TRIGGER IF EXISTS online_projections_immutable_delete ON online_public_projections;
CREATE TRIGGER online_projections_immutable_delete BEFORE DELETE ON online_public_projections
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
        RAISE NOTICE 'KHA-65: role % not created; runtime grants skipped', role_name;
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
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_matches TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_seats TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_clocks TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_moves TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_events TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_operation_receipts TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_queue_entries TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_runner_leases TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_public_projections TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_deletion_markers TO kamkm_online_api', schema_name);
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
REVOKE ALL PRIVILEGES ON TABLE online_matches FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_seats FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_clocks FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_moves FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_events FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_operation_receipts FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_queue_entries FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_runner_leases FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_public_projections FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_deletion_markers FROM PUBLIC;
