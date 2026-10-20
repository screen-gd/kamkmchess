// Package profile owns the public identity of a signed-in account.
//
// A public profile is a stable, public identity that is independent of the
// editable name and avatar it carries, and independent of the private sign-in
// identity of the account behind it. The authentication identifier, the
// sign-in email, and the legal name stay on the server: they are never part
// of a public payload, and they are never a default.
//
// A guest seat has no profile. A guest is labelled Guest, and a guest seat is
// attached to an account only by an explicit action that proves ownership of
// that seat. The link records the association in its own ledger; it never
// rewrites the seat owner, never discards an operation receipt, and never
// invalidates an accepted fingerprint.
package profile

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// SchemaVersion is the version of the public profile wire contract.
const SchemaVersion = 1

// Errors reported by the profile service.
//
// A missing profile and a missing name share one error so a caller cannot
// learn which names exist.
var (
	// ErrNotFound reports a profile or a public name that does not exist.
	ErrNotFound = errors.New("profile: not found")
	// ErrUsernameTaken reports a public name that another profile already
	// owns. The comparison is case-insensitive.
	ErrUsernameTaken = errors.New("profile: the username is already taken")
	// ErrInvalidUsername reports a rejected public name.
	ErrInvalidUsername = errors.New("profile: the username is not allowed")
	// ErrInvalidAvatar reports a rejected avatar choice.
	ErrInvalidAvatar = errors.New("profile: the avatar is not allowed")
	// ErrNotAuthorized reports a caller that does not own the profile it
	// tried to change.
	ErrNotAuthorized = errors.New("profile: not authorized")
	// ErrSeatAlreadyLinked reports a guest seat that is already linked to a
	// profile.
	ErrSeatAlreadyLinked = errors.New("profile: the guest seat is already linked")
	// ErrProofConsumed reports an ownership proof that already bound a
	// profile.
	ErrProofConsumed = errors.New("profile: the ownership proof was already used")
)

// AvatarKind is the origin of a public avatar.
type AvatarKind string

const (
	// AvatarGenerated is the default avatar. It is derived from the profile
	// identifier, so it is stable for a person and stores nothing.
	AvatarGenerated AvatarKind = "generated"
	// AvatarChosen is an avatar the owner deliberately picked from the
	// bounded catalog.
	AvatarChosen AvatarKind = "chosen"
)

// Avatar is the public avatar of a profile.
//
// A generated avatar carries the profile identifier as its seed. A chosen
// avatar carries a catalog key. The representation is deliberately bounded: it
// is never a URL, a data URI, an image blob, or a provider identifier.
type Avatar struct {
	Kind  AvatarKind
	Value string
}

// ChosenAvatars is the bounded catalog of avatar choices.
//
// The catalog is fixed on purpose. A chosen avatar is a short key from this
// list, so a public payload can never carry an arbitrary string, a remote
// image reference, or a tracking URL.
var ChosenAvatars = []string{
	"ember",
	"harbor",
	"meadow",
	"orchid",
	"slate",
	"sunrise",
	"tide",
	"violet",
}

// reservedUsernames are public names that would impersonate a participant
// label, an account role, or a system identity.
var reservedUsernames = map[string]bool{
	"guest":         true,
	"guests":        true,
	"anonymous":     true,
	"deleted":       true,
	"admin":         true,
	"administrator": true,
	"system":        true,
	"moderator":     true,
	"support":       true,
	"staff":         true,
	"official":      true,
	"root":          true,
	"null":          true,
	"undefined":     true,
}

// Profile is the public identity of one account.
type Profile struct {
	// ProfileID is the stable public identifier. It never changes, it is not
	// derived from the account, and it survives a rename.
	ProfileID string
	// Username is the chosen public name. An empty value means the owner has
	// not chosen one yet, and the profile publishes no name.
	Username string
	// Avatar is the public avatar.
	Avatar Avatar
	// CreatedAt is when the profile was created.
	CreatedAt time.Time
	// UpdatedAt is when the owner last changed the profile.
	UpdatedAt time.Time
}

// GuestLink is a verified association between one guest seat and one
// account.
//
// The link never replaces the seat owner. The guest stays the actor of every
// accepted move, and the accepted fingerprints keep their original value.
type GuestLink struct {
	LinkID    string
	ProfileID string
	MatchID   string
	Seat      online.Seat
	LinkedAt  time.Time
}

// Update is an ownership-checked change to one profile.
//
// A nil field keeps the current value. An empty username removes the chosen
// name, and an empty avatar returns the profile to the generated default.
type Update struct {
	// Username is the new public name.
	Username *string
	// Avatar is the new avatar choice.
	Avatar *string
}

// usernamePattern is the shape of an allowed public name.
//
// The name is deliberately narrow. It cannot contain an "@" or a dot, so it
// can never be read as an email address, and it cannot contain a character
// that would make a public label ambiguous. It starts and ends with a letter
// or a digit, so a name never ends in a dangling separator.
var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{1,22}[A-Za-z0-9]$`)

// NormalizeUsername validates a chosen public name.
//
// It returns the display form the owner typed and the comparison key used for
// uniqueness. The key is the lower-cased name, so two owners cannot claim the
// same name with different spelling.
//
// An empty name is refused here. Clearing a chosen name is a separate,
// explicit update.
func NormalizeUsername(value string) (display string, key string, err error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", "", fmt.Errorf("%w: the name is empty", ErrInvalidUsername)
	}
	if !usernamePattern.MatchString(trimmed) {
		return "", "", fmt.Errorf("%w: the name must be 3 to 24 letters, digits, underscores or dashes", ErrInvalidUsername)
	}
	lower := strings.ToLower(trimmed)
	if reservedUsernames[lower] {
		return "", "", fmt.Errorf("%w: the name is reserved", ErrInvalidUsername)
	}
	return trimmed, lower, nil
}

// UsernameKey returns the comparison key of a public name.
//
// A name that cannot be chosen is refused, so a lookup can never be used to
// probe a shape the service would reject.
func UsernameKey(value string) (string, error) {
	_, key, err := NormalizeUsername(value)
	if err != nil {
		return "", err
	}
	return key, nil
}

// NormalizeAvatar validates a chosen avatar.
//
// An empty value is the generated default. Any other value must be a key from
// the bounded catalog.
func NormalizeAvatar(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", nil
	}
	for _, candidate := range ChosenAvatars {
		if candidate == trimmed {
			return trimmed, nil
		}
	}
	return "", fmt.Errorf("%w: the avatar is not in the catalog", ErrInvalidAvatar)
}
