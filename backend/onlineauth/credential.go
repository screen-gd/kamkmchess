package onlineauth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

const (
	// guestSecretBytes is the entropy of every issued guest secret.
	guestSecretBytes = 32
	// credentialPrefix marks a seat-control credential secret.
	credentialPrefix = "kmgc1_"
	// proofPrefix marks an ownership-proof secret.
	proofPrefix = "kmgp1_"
	// hashDomain separates the stored hash of one secret kind from another.
	hashDomain = "kamkm.online.guest.v1:"
)

// newSecret returns a fresh opaque secret. The value is returned to the
// issuer exactly once and is never persisted.
func newSecret(prefix string) (string, error) {
	raw := make([]byte, guestSecretBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("onlineauth: secure random source unavailable")
	}
	return prefix + base64.RawURLEncoding.EncodeToString(raw), nil
}

// hashSecret derives the stored hash of a secret. The hash is domain
// separated so a seat credential and an ownership proof never share a stored
// value, and it never leaves the server.
func hashSecret(purpose, secret string) []byte {
	sum := sha256.Sum256([]byte(hashDomain + purpose + ":" + secret))
	return sum[:]
}

// secretShape rejects values that cannot be an issued secret before they
// reach the database.
func secretShape(secret, prefix string) bool {
	if !strings.HasPrefix(secret, prefix) {
		return false
	}
	body := strings.TrimPrefix(secret, prefix)
	if len(body) != 43 {
		return false
	}
	_, err := base64.RawURLEncoding.DecodeString(body)
	return err == nil
}

// IssuedSeatCredential is a freshly minted guest seat credential.
//
// The plaintext secret is returned once to the trusted issuer. It is redacted
// from JSON and from structured logs so it cannot reach a response body, a
// snapshot, or a log line by accident.
type IssuedSeatCredential struct {
	CredentialID string
	GuestID      string
	MatchID      string
	Seat         online.Seat
	Origin       string
	Secret       string
	IssuedAt     time.Time
	ExpiresAt    time.Time
}

// LogValue redacts the secret from structured logs.
func (c IssuedSeatCredential) LogValue() slog.Value {
	return slog.StringValue("redacted guest seat credential")
}

// MarshalJSON redacts the secret. A caller that must deliver the secret
// builds its own transport payload from the field.
func (c IssuedSeatCredential) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		CredentialID string      `json:"credentialId"`
		GuestID      string      `json:"guestId"`
		MatchID      string      `json:"matchId"`
		Seat         online.Seat `json:"seat"`
		Origin       string      `json:"origin"`
		IssuedAt     time.Time   `json:"issuedAt"`
		ExpiresAt    time.Time   `json:"expiresAt"`
	}{c.CredentialID, c.GuestID, c.MatchID, c.Seat, c.Origin, c.IssuedAt.UTC(), c.ExpiresAt.UTC()})
}

// IssuedOwnershipProof is a freshly minted, append-only ownership proof.
//
// The proof proves that its holder controls a guest seat. It never grants seat
// control and it never mutates the guest actor, the seat, or any accepted
// operation fingerprint.
type IssuedOwnershipProof struct {
	ProofID   string
	GuestID   string
	MatchID   string
	Seat      online.Seat
	Secret    string
	IssuedAt  time.Time
	ExpiresAt time.Time
}

// LogValue redacts the secret from structured logs.
func (p IssuedOwnershipProof) LogValue() slog.Value {
	return slog.StringValue("redacted guest ownership proof")
}

// MarshalJSON redacts the secret.
func (p IssuedOwnershipProof) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		ProofID   string      `json:"proofId"`
		GuestID   string      `json:"guestId"`
		MatchID   string      `json:"matchId"`
		Seat      online.Seat `json:"seat"`
		IssuedAt  time.Time   `json:"issuedAt"`
		ExpiresAt time.Time   `json:"expiresAt"`
	}{p.ProofID, p.GuestID, p.MatchID, p.Seat, p.IssuedAt.UTC(), p.ExpiresAt.UTC()})
}

// OwnershipProof is a verified ownership proof. It is the typed port an
// explicit account-link flow composes; it performs no linking itself.
type OwnershipProof struct {
	ProofID   string
	GuestID   string
	MatchID   string
	Seat      online.Seat
	IssuedAt  time.Time
	ExpiresAt time.Time
}
