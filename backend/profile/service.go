package profile

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Options configures the profile service.
type Options struct {
	// Now overrides the clock for tests.
	Now func() time.Time
}

// Service owns the public profiles and the explicit guest links.
//
// The service is the only writer of these tables. It never writes match
// state, and it never rewrites a seat owner: a guest link records an
// association next to the seat instead of taking the seat over.
type Service struct {
	db         *pgxpool.Pool
	authorizer *onlineauth.Service
	options    Options
}

// Open binds the profile service to a pool. It does not mutate the schema.
func Open(_ context.Context, db *pgxpool.Pool, authorizer *onlineauth.Service, options Options) (*Service, error) {
	if db == nil {
		return nil, errors.New("profile: nil database pool")
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &Service{db: db, authorizer: authorizer, options: options}, nil
}

func (s *Service) now() time.Time { return s.options.Now().UTC() }

// EnsureProfile returns the public profile of one account.
//
// The profile is created on first use, so an account never has to complete a
// setup step before it has a public identity. The identifier is random and
// independent of the account, so a public payload never leaks the
// authentication identifier.
//
// The write runs under the account lock and re-checks the account inside the
// transaction, so a session that was revoked while the request waited cannot
// create a profile.
//
// A concurrent first use creates one profile: the insert is a no-op when the
// account already has one, and the stored row is read back.
func (s *Service) EnsureProfile(ctx context.Context, account onlineauth.Principal, origin string) (Profile, error) {
	var record Profile
	err := s.withAccount(ctx, account, origin, func(ctx context.Context, tx pgx.Tx) error {
		if err := s.ensureProfileRow(ctx, tx, account.Subject); err != nil {
			return err
		}
		stored, err := s.readStoredProfile(ctx, tx, profileByAccount, account.Subject)
		if err != nil {
			return err
		}
		record = stored.profile()
		return nil
	})
	if err != nil {
		return Profile{}, err
	}
	return record, nil
}

// UpdateProfile applies an ownership-checked change to the account's own
// profile.
//
// The caller is the authenticated account. The service never accepts an
// account identifier, a profile identifier, or an owner from the request: the
// account is the one the server verified, and it can only change its own
// profile.
//
// The update runs in one transaction that takes the account lock and locks
// the profile row. Two concurrent edits of the same profile are therefore
// ordered and never produce a torn name and avatar pair, and a session that
// was revoked while the request waited cannot change the profile. A public
// name that another profile already owns is refused by the unique index,
// which makes the check race-safe: exactly one of two concurrent claims of
// the same name wins.
func (s *Service) UpdateProfile(ctx context.Context, account onlineauth.Principal, update Update, origin string) (Profile, error) {
	var (
		display *string
		key     *string
	)
	if update.Username != nil {
		if strings.TrimSpace(*update.Username) == "" {
			empty := ""
			display = &empty
		} else {
			normalized, comparison, err := NormalizeUsername(*update.Username)
			if err != nil {
				return Profile{}, err
			}
			display = &normalized
			key = &comparison
		}
	}
	avatar, err := normalizeOptionalAvatar(update.Avatar)
	if err != nil {
		return Profile{}, err
	}
	var updated Profile
	err = s.withAccount(ctx, account, origin, func(ctx context.Context, tx pgx.Tx) error {
		// The profile row is locked for the update, so two concurrent edits
		// of the same profile are ordered by the database.
		if err := s.ensureProfileRow(ctx, tx, account.Subject); err != nil {
			return err
		}
		row, err := s.readStoredProfile(ctx, tx, profileByAccount+" FOR UPDATE", account.Subject)
		if err != nil {
			return err
		}
		username := row.Username
		usernameKey := row.UsernameKey
		if display != nil {
			username = *display
			usernameKey = keyOrEmpty(key)
		}
		avatarKey := row.AvatarKey
		if avatar != nil {
			avatarKey = *avatar
		}
		if _, err = tx.Exec(ctx, `UPDATE online_public_profiles SET username=$1,username_key=$2,avatar_key=$3,updated_at=clock_timestamp() WHERE profile_id=$4`,
			nullable(username), nullableKey(usernameKey), avatarKey, row.ProfileID); err != nil {
			if isUniqueViolation(err, uniqueUsernameIndex) {
				return ErrUsernameTaken
			}
			return err
		}
		stored, err := s.readStoredProfile(ctx, tx, profileByAccount, account.Subject)
		if err != nil {
			return err
		}
		updated = stored.profile()
		return nil
	})
	if err != nil {
		return Profile{}, err
	}
	return updated, nil
}

// PublicProfile reads one profile by its public identifier.
//
// The read is public: it needs no credential, and it answers with the
// allowlisted public fields only.
func (s *Service) PublicProfile(ctx context.Context, profileID string) (Profile, error) {
	profileID = strings.TrimSpace(profileID)
	if profileID == "" {
		return Profile{}, ErrNotFound
	}
	return s.readProfileByID(ctx, s.db, profileID)
}

// ProfileByUsername reads one profile by its public name.
//
// The comparison is case-insensitive, so the lookup a named challenge needs
// finds the owner whichever spelling the challenger used.
func (s *Service) ProfileByUsername(ctx context.Context, username string) (Profile, error) {
	key, err := UsernameKey(username)
	if err != nil {
		return Profile{}, ErrNotFound
	}
	return s.readProfileByUsernameKey(ctx, s.db, key)
}

// LinkRequest describes one explicit guest link.
type LinkRequest struct {
	// ProofSecret is the guest ownership proof. It is the only accepted
	// proof of seat ownership: an invitation link is not a proof, and a
	// guest seat credential proves control, not the deliberate act of
	// linking.
	ProofSecret string
	// Origin is the browser origin the link was requested from.
	Origin string
	// MatchID is the match of the guest seat.
	MatchID string
	// Seat is the guest seat.
	Seat online.Seat
}

// LinkGuestSeat binds one verified guest seat to the account's profile.
//
// The link is explicit. It happens only because the account asked for it, and
// the account is the one the server verified: the request never names an
// account.
//
// The ownership proof is checked once before any lock is taken, so a request
// that does not name the seat cannot make the service serialise on somebody
// else's seat lock. The transaction then holds the account lock and the guest
// seat lock, the same locks the revocation paths hold, so a link is ordered
// against a session revocation, a credential rotation, and a seat removal
// instead of racing them. Every expiry is re-checked after those locks are
// held, because a lock can be held for an unbounded time.
//
// The ownership proof is consumed by this transaction. The ledger binds one
// proof to one profile, once, and the proof itself is marked spent, so a
// second link with the same proof is refused everywhere. The guest identity
// and the seat owner are left untouched, so the guest stays the actor of
// every accepted move and the accepted fingerprints keep their original
// value.
func (s *Service) LinkGuestSeat(ctx context.Context, account onlineauth.Principal, request LinkRequest) (GuestLink, error) {
	if s.authorizer == nil {
		return GuestLink{}, errors.New("profile: no link authorizer is configured")
	}
	if account.Kind != online.ParticipantAccount || account.Subject == "" {
		return GuestLink{}, ErrNotAuthorized
	}
	// The proof names the seat it proves. Reading it before the locks keeps
	// a request for somebody else's seat from taking that seat's lock.
	proof, err := s.authorizer.VerifyOwnershipProof(ctx, request.ProofSecret, request.Origin)
	if err != nil {
		return GuestLink{}, err
	}
	if proof.MatchID != request.MatchID || proof.Seat != request.Seat {
		return GuestLink{}, onlineauth.ErrUnauthenticated
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return GuestLink{}, err
	}
	defer tx.Rollback(ctx)
	// The account lock is taken before the seat lock. The revocation paths
	// take one lock at a time, so this order cannot deadlock.
	if err = onlineauth.LockAccountScope(ctx, tx, account.Subject); err != nil {
		return GuestLink{}, err
	}
	if err = onlineauth.LockSeatScope(ctx, tx, proof.MatchID, proof.Seat); err != nil {
		return GuestLink{}, err
	}
	// The proof, the parent credential, the seat ownership, the session
	// revocation, and every expiry are re-checked inside the transaction,
	// after the locks were held.
	authority, err := s.authorizer.VerifyLinkSeat(ctx, tx, request.ProofSecret, request.Origin, account, request.MatchID, request.Seat)
	if err != nil {
		return GuestLink{}, err
	}
	if err = s.ensureProfileRow(ctx, tx, authority.AccountID); err != nil {
		return GuestLink{}, err
	}
	profile, err := s.readStoredProfile(ctx, tx, profileByAccount, authority.AccountID)
	if err != nil {
		return GuestLink{}, err
	}
	linkID, err := newIdentifier("kl_")
	if err != nil {
		return GuestLink{}, err
	}
	linkedAt := s.now()
	if _, err = tx.Exec(ctx, `INSERT INTO online_profile_guest_links(link_id,profile_id,account_id,guest_id,match_id,seat,proof_id,linked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
		linkID, profile.ProfileID, authority.AccountID, authority.GuestID, authority.MatchID, string(authority.Seat), authority.ProofID, linkedAt); err != nil {
		if isUniqueViolation(err, uniqueProofIndex) {
			return GuestLink{}, ErrProofConsumed
		}
		if isUniqueViolation(err, uniqueSeatIndex) {
			return GuestLink{}, ErrSeatAlreadyLinked
		}
		return GuestLink{}, err
	}
	// The proof is spent. The proof table is append-only apart from its
	// one-way revocation columns, and the ledger keeps its own record, so
	// the proof can never be used a second time.
	spent, err := tx.Exec(ctx, `UPDATE online_guest_ownership_proofs SET revoked_at=clock_timestamp(),revoked_reason='proof_consumed' WHERE proof_id=$1 AND revoked_at IS NULL`, authority.ProofID)
	if err != nil {
		return GuestLink{}, err
	}
	if spent.RowsAffected() != 1 {
		return GuestLink{}, ErrProofConsumed
	}
	if err = tx.Commit(ctx); err != nil {
		return GuestLink{}, err
	}
	return GuestLink{
		LinkID:    linkID,
		ProfileID: profile.ProfileID,
		MatchID:   authority.MatchID,
		Seat:      authority.Seat,
		LinkedAt:  linkedAt,
	}, nil
}

// GuestLinks lists the guest seats bound to one account.
func (s *Service) GuestLinks(ctx context.Context, accountID string) ([]GuestLink, error) {
	accountID = strings.TrimSpace(accountID)
	if accountID == "" {
		return nil, ErrNotAuthorized
	}
	rows, err := s.db.Query(ctx, `SELECT l.link_id,l.profile_id,l.match_id,l.seat,l.linked_at FROM online_profile_guest_links l WHERE l.account_id=$1 AND l.revoked_at IS NULL ORDER BY l.linked_at DESC`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	links := make([]GuestLink, 0)
	for rows.Next() {
		var (
			link    GuestLink
			seat    string
			linked  time.Time
		)
		if err = rows.Scan(&link.LinkID, &link.ProfileID, &link.MatchID, &seat, &linked); err != nil {
			return nil, err
		}
		link.Seat = online.Seat(seat)
		link.LinkedAt = linked.UTC()
		links = append(links, link)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return links, nil
}

// The stored queries and the index names the service maps a unique
// violation onto a typed refusal. The index names belong to migration
// 0005; renaming an index there means renaming it here.
const (
	profileByAccount  = `SELECT profile_id,account_id,coalesce(username,''),coalesce(username_key,''),avatar_key,created_at,updated_at FROM online_public_profiles WHERE account_id=$1`
	profileByID       = `SELECT profile_id,account_id,coalesce(username,''),coalesce(username_key,''),avatar_key,created_at,updated_at FROM online_public_profiles WHERE profile_id=$1`
	profileByUsername = `SELECT profile_id,account_id,coalesce(username,''),coalesce(username_key,''),avatar_key,created_at,updated_at FROM online_public_profiles WHERE username_key=$1`

	uniqueUsernameIndex = "online_public_profiles_username"
	uniqueProofIndex    = "online_profile_guest_links_proof"
	uniqueSeatIndex     = "online_profile_guest_links_seat"
)

// storedProfile is the row shape of a public profile.
type storedProfile struct {
	ProfileID   string
	AccountID   string
	Username    string
	UsernameKey string
	AvatarKey   string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

func (p storedProfile) profile() Profile {
	avatar := Avatar{Kind: AvatarGenerated, Value: p.ProfileID}
	if p.AvatarKey != "" {
		avatar = Avatar{Kind: AvatarChosen, Value: p.AvatarKey}
	}
	return Profile{
		ProfileID: p.ProfileID,
		Username:  p.Username,
		Avatar:    avatar,
		CreatedAt: p.CreatedAt.UTC(),
		UpdatedAt: p.UpdatedAt.UTC(),
	}
}

// ensureProfileRow creates the profile of an account when it is missing.
//
// The insert is a no-op when the account already has a profile, so two
// concurrent first uses never create two identities for one person.
func (s *Service) ensureProfileRow(ctx context.Context, tx pgx.Tx, accountID string) error {
	profileID, err := newIdentifier("kp_")
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO online_public_profiles(profile_id,account_id) VALUES($1,$2) ON CONFLICT (account_id) DO NOTHING`, profileID, accountID); err != nil {
		return err
	}
	return nil
}

// withAccount runs a write under the account lock.
//
// The lock is the shared protocol of the participant command path, the
// revocation path, and the profile path, so a write is ordered against a
// session revocation instead of racing it. The account is re-checked inside
// the transaction, after the lock was held, so a revocation that committed
// while the caller waited is visible to the write.
func (s *Service) withAccount(ctx context.Context, account onlineauth.Principal, origin string, work func(ctx context.Context, tx pgx.Tx) error) error {
	if s.authorizer == nil {
		return errors.New("profile: no account authorizer is configured")
	}
	if account.Kind != online.ParticipantAccount || account.Subject == "" {
		return ErrNotAuthorized
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = onlineauth.LockAccountScope(ctx, tx, account.Subject); err != nil {
		return err
	}
	if err = s.authorizer.AuthorizeAccount(ctx, tx, account, origin); err != nil {
		return err
	}
	if err = work(ctx, tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) readProfileByID(ctx context.Context, q online.Querier, profileID string) (Profile, error) {
	return s.readProfile(ctx, q, profileByID, profileID)
}

func (s *Service) readProfileByUsernameKey(ctx context.Context, q online.Querier, key string) (Profile, error) {
	return s.readProfile(ctx, q, profileByUsername, key)
}

func (s *Service) readProfile(ctx context.Context, q online.Querier, query string, argument any) (Profile, error) {
	row, err := s.readStoredProfile(ctx, q, query, argument)
	if err != nil {
		return Profile{}, err
	}
	return row.profile(), nil
}

func (s *Service) readStoredProfile(ctx context.Context, q online.Querier, query string, argument any) (storedProfile, error) {
	var row storedProfile
	if err := q.QueryRow(ctx, query, argument).Scan(&row.ProfileID, &row.AccountID, &row.Username, &row.UsernameKey, &row.AvatarKey, &row.CreatedAt, &row.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return storedProfile{}, ErrNotFound
		}
		return storedProfile{}, err
	}
	return row, nil
}

// normalizeOptionalAvatar validates a requested avatar change.
func normalizeOptionalAvatar(value *string) (*string, error) {
	if value == nil {
		return nil, nil
	}
	normalized, err := NormalizeAvatar(*value)
	if err != nil {
		return nil, err
	}
	return &normalized, nil
}

func keyOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// nullable returns a nil argument for an unset public name, so the column
// stores SQL NULL instead of an empty string.
func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nullableKey(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// isUniqueViolation reports whether an error is the named unique violation.
func isUniqueViolation(err error, constraint string) bool {
	var pgError *pgconn.PgError
	if !errors.As(err, &pgError) {
		return false
	}
	return pgError.Code == "23505" && pgError.ConstraintName == constraint
}

// newIdentifier returns a random, non-secret identifier for a stored row.
func newIdentifier(prefix string) (string, error) {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("profile: secure random source unavailable")
	}
	return prefix + base64.RawURLEncoding.EncodeToString(raw), nil
}
