-- KHA-72 public profiles and explicit guest linking. Additive only.
--
-- A public profile is the stable public identity of one signed-in account. It
-- has its own opaque identifier, so the public payload never carries the
-- authentication identifier, the Clerk email, or the legal name.
--
-- The username is chosen deliberately by the owner. It is unique across all
-- profiles, compared case-insensitively, and it starts empty: nothing is
-- published until the owner picks one. The avatar is a bounded choice from a
-- fixed catalog; until the owner chooses one, the avatar is generated from
-- the profile identifier.
--
-- A guest seat is linked to an account by an explicit action. The link records
-- the association in its own append-only ledger. It never rewrites the seat
-- owner, never discards an operation receipt, and never invalidates an
-- accepted fingerprint: the guest stays the actor of every accepted move.
--
-- The link consumes one guest ownership proof. The proof identifier is unique
-- across the ledger, so a proof can never bind two profiles, and a guest seat
-- can be linked to at most one profile at a time.

CREATE TABLE IF NOT EXISTS online_public_profiles (
  profile_id text PRIMARY KEY CHECK (profile_id ~ '^kp_[A-Za-z0-9_-]{8,63}$'),
  account_id text NOT NULL CHECK (length(account_id) BETWEEN 1 AND 128),
  -- The chosen display form. It is empty until the owner deliberately picks
  -- one, so a profile never publishes a name it did not choose.
  username text CHECK (username IS NULL OR (length(username) BETWEEN 3 AND 24 AND username ~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,22}[A-Za-z0-9]$')),
  -- The comparison form. Uniqueness is case-insensitive, so "Alice" and
  -- "alice" are the same public name.
  username_key text CHECK (username_key IS NULL OR (length(username_key) BETWEEN 3 AND 24 AND username_key ~ '^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$')),
  -- The chosen avatar. An empty value is the generated default, which is
  -- derived from the profile identifier and stored nowhere.
  avatar_key text NOT NULL DEFAULT '' CHECK (avatar_key = '' OR avatar_key IN ('ember', 'harbor', 'meadow', 'orchid', 'slate', 'sunrise', 'tide', 'violet')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((username IS NULL) = (username_key IS NULL)),
  CHECK (username IS NULL OR username_key = lower(username))
);
-- One profile per account. The account identifier stays private: it is an
-- authorization identity and never appears in a public payload.
CREATE UNIQUE INDEX IF NOT EXISTS online_public_profiles_account ON online_public_profiles(account_id);
-- One owner per public name. The index is partial so that the many profiles
-- that have not chosen a name yet never collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS online_public_profiles_username ON online_public_profiles(username_key) WHERE username_key IS NOT NULL;
-- A public name that would impersonate a participant label or a reserved
-- account name is refused.
ALTER TABLE online_public_profiles DROP CONSTRAINT IF EXISTS online_public_profiles_reserved;
ALTER TABLE online_public_profiles ADD CONSTRAINT online_public_profiles_reserved CHECK (
  username_key IS NULL OR username_key NOT IN (
    'guest', 'guests', 'anonymous', 'deleted', 'admin', 'administrator', 'system',
    'moderator', 'support', 'staff', 'official', 'root', 'null', 'undefined'
  )
);

CREATE TABLE IF NOT EXISTS online_profile_guest_links (
  link_id text PRIMARY KEY CHECK (link_id ~ '^kl_[A-Za-z0-9_-]{8,63}$'),
  profile_id text NOT NULL REFERENCES online_public_profiles(profile_id) ON DELETE RESTRICT,
  account_id text NOT NULL CHECK (length(account_id) BETWEEN 1 AND 128),
  -- The guest that owned the seat. The seat owner itself is immutable, so this
  -- column records the original actor and never replaces it.
  guest_id text NOT NULL CHECK (length(guest_id) BETWEEN 1 AND 128),
  match_id text NOT NULL CHECK (match_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$'),
  seat text NOT NULL CHECK (seat IN ('white', 'black')),
  -- The consumed ownership proof. One proof binds one profile, once.
  proof_id text NOT NULL REFERENCES online_guest_ownership_proofs(proof_id) ON DELETE RESTRICT,
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  revoked_reason text,
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
-- A guest seat is linked to at most one live profile. A revoked link frees
-- the seat again for a later explicit link.
CREATE UNIQUE INDEX IF NOT EXISTS online_profile_guest_links_seat ON online_profile_guest_links(match_id, seat) WHERE revoked_at IS NULL;
-- One proof is consumed once.
CREATE UNIQUE INDEX IF NOT EXISTS online_profile_guest_links_proof ON online_profile_guest_links(proof_id);
CREATE INDEX IF NOT EXISTS online_profile_guest_links_profile ON online_profile_guest_links(profile_id, linked_at DESC);

-- A link may only name a seat that the guest actually owns. The seat owner in
-- online_seats is immutable, so a link can never take over a seat that belongs
-- to another participant.
CREATE OR REPLACE FUNCTION online_guard_profile_guest_link_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  seat_owner_kind text;
  seat_owner_id text;
BEGIN
  SELECT s.owner_kind, s.owner_id INTO seat_owner_kind, seat_owner_id
    FROM online_seats s
    WHERE s.match_id = NEW.match_id AND s.seat = NEW.seat;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'online profile guest link requires an existing seat' USING ERRCODE = '55000';
  END IF;
  IF seat_owner_kind <> 'guest' OR seat_owner_id <> NEW.guest_id THEN
    RAISE EXCEPTION 'online profile guest link must name the seat owner' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_profile_guest_links_insert_guard ON online_profile_guest_links;
CREATE TRIGGER online_profile_guest_links_insert_guard BEFORE INSERT ON online_profile_guest_links
  FOR EACH ROW EXECUTE FUNCTION online_guard_profile_guest_link_insert();

-- A link keeps its identity. Only the one-way revocation columns can change,
-- and only once.
CREATE OR REPLACE FUNCTION online_guard_profile_guest_link_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.link_id <> OLD.link_id
     OR NEW.profile_id <> OLD.profile_id
     OR NEW.account_id <> OLD.account_id
     OR NEW.guest_id <> OLD.guest_id
     OR NEW.match_id <> OLD.match_id
     OR NEW.seat <> OLD.seat
     OR NEW.proof_id <> OLD.proof_id
     OR NEW.linked_at <> OLD.linked_at THEN
    RAISE EXCEPTION 'online profile guest link identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'online profile guest link revocation is final' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_profile_guest_links_guard ON online_profile_guest_links;
CREATE TRIGGER online_profile_guest_links_guard BEFORE UPDATE ON online_profile_guest_links
  FOR EACH ROW EXECUTE FUNCTION online_guard_profile_guest_link_update();

-- The link ledger is append-only.
DROP TRIGGER IF EXISTS online_profile_guest_links_immutable_delete ON online_profile_guest_links;
CREATE TRIGGER online_profile_guest_links_immutable_delete BEFORE DELETE ON online_profile_guest_links
  FOR EACH ROW EXECUTE FUNCTION online_reject_mutation();

-- A profile keeps its identity. The chosen name, the chosen avatar and the
-- update time are the only values an owner may change.
CREATE OR REPLACE FUNCTION online_guard_public_profile_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.profile_id <> OLD.profile_id
     OR NEW.account_id <> OLD.account_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'online public profile identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_public_profiles_guard ON online_public_profiles;
CREATE TRIGGER online_public_profiles_guard BEFORE UPDATE ON online_public_profiles
  FOR EACH ROW EXECUTE FUNCTION online_guard_public_profile_update();

-- A profile that still owns a guest link must not disappear, because the link
-- is the durable record of a verified association.
DROP TRIGGER IF EXISTS online_public_profiles_immutable_delete ON online_public_profiles;
CREATE TRIGGER online_public_profiles_immutable_delete BEFORE DELETE ON online_public_profiles
  FOR EACH ROW EXECUTE FUNCTION online_reject_mutation();

-- Runtime grants follow the KHA-65 pattern: the API role gets the new tables,
-- the private rules process keeps no table privileges at all.
DO $$
DECLARE
  schema_name text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_api') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_public_profiles TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_profile_guest_links TO kamkm_online_api', schema_name);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_rules') THEN
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.online_public_profiles FROM kamkm_online_rules', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.online_profile_guest_links FROM kamkm_online_rules', schema_name);
  END IF;
END
$$;

-- New shared tables never fall back to PUBLIC access.
REVOKE ALL PRIVILEGES ON TABLE online_public_profiles FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_profile_guest_links FROM PUBLIC;
