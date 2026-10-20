-- KHA-67 participant authorization. Additive only.
--
-- Durable session revocation, revocable seat-scoped guest credentials, and
-- append-only guest ownership proofs. Nothing in this file alters, rewrites, or
-- re-grants the private single-owner sync tables from 0001_storage.sql or the
-- shared online match tables from 0002_online.sql.
--
-- The guest secrets never reach the database. Only the SHA-256 hash of each
-- secret is stored, so a database copy cannot be replayed as a seat credential.
--
-- The credential rows carry no foreign key to online_matches or online_seats
-- on purpose: a trusted invitation allocator mints the credential in the same
-- flow that creates the match and the seat row. The seat binding is
-- re-verified against online_seats on every use, and an insert guard refuses
-- a credential whose seat does not exist or is owned by somebody else, so a
-- credential that names a match or seat that was never created grants nothing.

CREATE TABLE IF NOT EXISTS online_session_revocations (
  subject_id text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 128),
  session_id text NOT NULL CHECK (length(session_id) BETWEEN 1 AND 128),
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason text NOT NULL CHECK (reason IN ('owner_request', 'erasure_request', 'account_deletion', 'session_ended', 'seat_removed', 'admin')),
  PRIMARY KEY (subject_id, session_id)
);
CREATE INDEX IF NOT EXISTS online_session_revocations_revoked ON online_session_revocations(revoked_at DESC, subject_id);
-- The wildcard session revokes every session of a subject, including later
-- ones. It is never a real Clerk session identifier.

CREATE TABLE IF NOT EXISTS online_guest_seat_credentials (
  credential_id text PRIMARY KEY CHECK (credential_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$'),
  guest_id text NOT NULL CHECK (length(guest_id) BETWEEN 1 AND 128),
  match_id text NOT NULL CHECK (match_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$'),
  seat text NOT NULL CHECK (seat IN ('white', 'black')),
  secret_hash bytea NOT NULL CHECK (octet_length(secret_hash) = 32),
  origin text NOT NULL CHECK (length(origin) BETWEEN 1 AND 255 AND origin !~ '[[:cntrl:]]'),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  superseded_at timestamptz,
  CHECK (expires_at > issued_at),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
-- A seat has at most one live credential. The index covers the seat alone, so
-- a second live credential for the same seat is rejected even when it names a
-- different guest. A trusted rotation supersedes every earlier credential of
-- that seat instead of leaving two usable secrets behind, and it never changes
-- the seat owner: the owner in online_seats is immutable.
DROP INDEX IF EXISTS online_guest_seat_credentials_live;
CREATE UNIQUE INDEX online_guest_seat_credentials_live ON online_guest_seat_credentials(match_id, seat) WHERE revoked_at IS NULL AND superseded_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS online_guest_seat_credentials_secret ON online_guest_seat_credentials(secret_hash);
CREATE INDEX IF NOT EXISTS online_guest_seat_credentials_guest ON online_guest_seat_credentials(guest_id, issued_at DESC);

-- Ownership proofs are append-only. A proof states that its holder controls a
-- guest seat; it grants no seat control and it never mutates the guest actor,
-- the seat row, or an accepted operation fingerprint.
--
-- A proof is only valid while the credential it was minted from is still live.
-- The stored expires_at is the proof's own lifetime; the effective lifetime of
-- the proof is the shorter of that value and the lifetime of its credential,
-- because a revoked, superseded, or expired credential invalidates every
-- proof it issued.
--
-- A proof is not consumed by reading it. The explicit account link that
-- consumes or binds a proof runs in the link transaction of KHA-72, never in a
-- read-only authorization check.
CREATE TABLE IF NOT EXISTS online_guest_ownership_proofs (
  proof_id text PRIMARY KEY CHECK (proof_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$'),
  credential_id text NOT NULL REFERENCES online_guest_seat_credentials(credential_id) ON DELETE CASCADE,
  guest_id text NOT NULL CHECK (length(guest_id) BETWEEN 1 AND 128),
  match_id text NOT NULL CHECK (match_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$'),
  seat text NOT NULL CHECK (seat IN ('white', 'black')),
  proof_hash bytea NOT NULL CHECK (octet_length(proof_hash) = 32),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  CHECK (expires_at > issued_at),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS online_guest_ownership_proofs_secret ON online_guest_ownership_proofs(proof_hash);
CREATE INDEX IF NOT EXISTS online_guest_ownership_proofs_guest ON online_guest_ownership_proofs(guest_id, issued_at DESC);

-- A credential is minted for one seat, and it belongs to the seat's owner.
-- The seat owner in online_seats is immutable, so a credential can never be
-- minted for another participant and a rotation can never move a seat to a
-- new guest. The check runs on insert only: the owner may later be
-- anonymized by the erasure flow, and that never rewrites a stored
-- credential.
CREATE OR REPLACE FUNCTION online_guard_guest_credential_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  seat_owner_kind text;
  seat_owner_id text;
BEGIN
  SELECT s.owner_kind, s.owner_id INTO seat_owner_kind, seat_owner_id
    FROM online_seats s
    WHERE s.match_id = NEW.match_id AND s.seat = NEW.seat;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'online guest credential requires an existing seat' USING ERRCODE = '55000';
  END IF;
  IF seat_owner_kind <> 'guest' OR seat_owner_id <> NEW.guest_id THEN
    RAISE EXCEPTION 'online guest credential must belong to the seat owner' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_guest_credentials_insert_guard ON online_guest_seat_credentials;
CREATE TRIGGER online_guest_credentials_insert_guard BEFORE INSERT ON online_guest_seat_credentials
  FOR EACH ROW EXECUTE FUNCTION online_guard_guest_credential_insert();

-- A proof never names another seat than the credential it was minted from.
-- The credential's own binding is immutable, so the proof follows it.
CREATE OR REPLACE FUNCTION online_guard_guest_proof_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  credential_guest_id text;
  credential_match_id text;
  credential_seat text;
BEGIN
  SELECT c.guest_id, c.match_id, c.seat INTO credential_guest_id, credential_match_id, credential_seat
    FROM online_guest_seat_credentials c
    WHERE c.credential_id = NEW.credential_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'online guest ownership proof requires its credential' USING ERRCODE = '55000';
  END IF;
  IF credential_guest_id <> NEW.guest_id
     OR credential_match_id <> NEW.match_id
     OR credential_seat <> NEW.seat THEN
    RAISE EXCEPTION 'online guest ownership proof must match its credential' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_guest_proofs_insert_guard ON online_guest_ownership_proofs;
CREATE TRIGGER online_guest_proofs_insert_guard BEFORE INSERT ON online_guest_ownership_proofs
  FOR EACH ROW EXECUTE FUNCTION online_guard_guest_proof_insert();

-- A credential keeps its identity and its hash. Only the one-way revocation
-- and supersession columns can change.
CREATE OR REPLACE FUNCTION online_guard_guest_credential_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.credential_id <> OLD.credential_id
     OR NEW.guest_id <> OLD.guest_id
     OR NEW.match_id <> OLD.match_id
     OR NEW.seat <> OLD.seat
     OR NEW.secret_hash IS DISTINCT FROM OLD.secret_hash
     OR NEW.origin <> OLD.origin
     OR NEW.issued_at <> OLD.issued_at
     OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'online guest credential identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'online guest credential revocation is final' USING ERRCODE = '55000';
  END IF;
  IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'online guest credential supersession is final' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_guest_credentials_guard ON online_guest_seat_credentials;
CREATE TRIGGER online_guest_credentials_guard BEFORE UPDATE ON online_guest_seat_credentials
FOR EACH ROW EXECUTE FUNCTION online_guard_guest_credential_update();

DROP TRIGGER IF EXISTS online_guest_credentials_immutable_delete ON online_guest_seat_credentials;
CREATE TRIGGER online_guest_credentials_immutable_delete BEFORE DELETE ON online_guest_seat_credentials
FOR EACH ROW EXECUTE FUNCTION online_reject_mutation();

-- A proof is append-only. Only the one-way revocation columns can change, and
-- only once.
CREATE OR REPLACE FUNCTION online_guard_guest_proof_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.proof_id <> OLD.proof_id
     OR NEW.credential_id <> OLD.credential_id
     OR NEW.guest_id <> OLD.guest_id
     OR NEW.match_id <> OLD.match_id
     OR NEW.seat <> OLD.seat
     OR NEW.proof_hash IS DISTINCT FROM OLD.proof_hash
     OR NEW.issued_at <> OLD.issued_at
     OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'online guest ownership proof identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'online guest ownership proof revocation is final' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_guest_proofs_guard ON online_guest_ownership_proofs;
CREATE TRIGGER online_guest_proofs_guard BEFORE UPDATE ON online_guest_ownership_proofs
FOR EACH ROW EXECUTE FUNCTION online_guard_guest_proof_update();

DROP TRIGGER IF EXISTS online_guest_proofs_immutable_delete ON online_guest_ownership_proofs;
CREATE TRIGGER online_guest_proofs_immutable_delete BEFORE DELETE ON online_guest_ownership_proofs
FOR EACH ROW EXECUTE FUNCTION online_reject_mutation();

-- Session revocations are append-only. A revoked session stays revoked.
CREATE OR REPLACE FUNCTION online_guard_session_revocation_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'online session revocation is append-only' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS online_session_revocations_immutable ON online_session_revocations;
CREATE TRIGGER online_session_revocations_immutable BEFORE UPDATE ON online_session_revocations
FOR EACH ROW EXECUTE FUNCTION online_guard_session_revocation_update();

DROP TRIGGER IF EXISTS online_session_revocations_immutable_delete ON online_session_revocations;
CREATE TRIGGER online_session_revocations_immutable_delete BEFORE DELETE ON online_session_revocations
FOR EACH ROW EXECUTE FUNCTION online_reject_mutation();

-- Runtime grants follow the KHA-65 pattern: the API role gets the new tables,
-- the private rules process keeps no table privileges at all.
DO $$
DECLARE
  schema_name text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_api') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_session_revocations TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_guest_seat_credentials TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_guest_ownership_proofs TO kamkm_online_api', schema_name);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_rules') THEN
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.online_session_revocations FROM kamkm_online_rules', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.online_guest_seat_credentials FROM kamkm_online_rules', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.online_guest_ownership_proofs FROM kamkm_online_rules', schema_name);
  END IF;
END
$$;

-- New shared tables never fall back to PUBLIC access.
REVOKE ALL PRIVILEGES ON TABLE online_session_revocations FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_guest_seat_credentials FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_guest_ownership_proofs FROM PUBLIC;
