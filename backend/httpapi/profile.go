package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/profile"
)

// GuestOwnershipProofHeader carries the guest ownership proof.
//
// The proof travels in its own header so it can never be mistaken for a
// Clerk session token or for a guest seat credential. Like every other
// credential it never belongs in a URL, a shared state, or a log line.
const GuestOwnershipProofHeader = "X-Guest-Ownership-Proof"

// ProfileRequestHeaders lists the request headers the profile API accepts.
//
// The guest seat credential header is accepted by the ownership-proof route
// only. The private single-owner sync API keeps its narrower header set.
var ProfileRequestHeaders = []string{GuestCredentialHeader, GuestOwnershipProofHeader}

// ProfileService is the public profile service the API uses.
type ProfileService interface {
	EnsureProfile(ctx context.Context, account onlineauth.Principal, origin string) (profile.Profile, error)
	UpdateProfile(ctx context.Context, account onlineauth.Principal, update profile.Update, origin string) (profile.Profile, error)
	PublicProfile(ctx context.Context, profileID string) (profile.Profile, error)
	ProfileByUsername(ctx context.Context, username string) (profile.Profile, error)
	LinkGuestSeat(ctx context.Context, account onlineauth.Principal, request profile.LinkRequest) (profile.GuestLink, error)
	GuestLinks(ctx context.Context, accountID string) ([]profile.GuestLink, error)
}

// GuestProofIssuer mints a guest ownership proof from a live seat credential.
//
// The proof proves that its holder controls a guest seat. It grants no seat
// control, and it is not an account identity.
type GuestProofIssuer interface {
	IssueOwnershipProof(ctx context.Context, seatSecret, origin string) (onlineauth.IssuedOwnershipProof, error)
}

type profileAPI struct {
	profiles ProfileService
	issuer   GuestProofIssuer
	auth     participantAuthenticator
}

// NewProfile returns the public profile API.
//
// The routes are:
//
//	GET  /v1/profiles/{profileID}                public profile read
//	GET  /v1/profiles/username/{username}        public name lookup
//	GET  /v1/account/profile                     the signed-in account's profile
//	PUT  /v1/account/profile                     ownership-checked profile update
//	GET  /v1/account/profile/guest-links         the linked guest seats
//	POST /v1/account/profile/guest-links         explicit guest link
//	POST /v1/guest-seats/ownership-proof         guest ownership proof
//
// The public reads need no credential. Every account route takes the verified
// account principal, and the request body never names an account, a profile,
// or an owner.
func NewProfile(profiles ProfileService, issuer GuestProofIssuer, authenticator OnlineAuthenticator, options OnlineOptions) http.Handler {
	api := &profileAPI{profiles: profiles, issuer: issuer, auth: newParticipantAuthenticator(authenticator, options)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/profiles/{profileID}", api.publicProfile)
	mux.HandleFunc("GET /v1/profiles/username/{username}", api.publicUsername)
	mux.HandleFunc("GET /v1/account/profile", api.ownProfile)
	mux.HandleFunc("PUT /v1/account/profile", api.updateProfile)
	mux.HandleFunc("GET /v1/account/profile/guest-links", api.guestLinks)
	mux.HandleFunc("POST /v1/account/profile/guest-links", api.linkGuestSeat)
	mux.HandleFunc("POST /v1/guest-seats/ownership-proof", api.ownershipProof)
	return mux
}

// publicProfile answers with the allowlisted public payload of one profile.
//
// The read works without signing in. The payload carries the public
// identifier, the chosen name, the chosen avatar, and the timestamps. It
// never carries the account identifier, the sign-in email, the legal name,
// or anything else the owner did not publish.
func (a *profileAPI) publicProfile(w http.ResponseWriter, r *http.Request) {
	record, err := a.profiles.PublicProfile(r.Context(), r.PathValue("profileID"))
	if err != nil {
		writeProfileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toPublicProfile(record))
}

// publicUsername answers the lookup a named friend challenge needs.
//
// The comparison is case-insensitive, so the challenger finds the owner with
// whichever spelling they typed.
func (a *profileAPI) publicUsername(w http.ResponseWriter, r *http.Request) {
	record, err := a.profiles.ProfileByUsername(r.Context(), r.PathValue("username"))
	if err != nil {
		writeProfileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toPublicProfile(record))
}

// ownProfile answers with the signed-in account's own profile.
func (a *profileAPI) ownProfile(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.auth.account(w, r, false)
	if !ok {
		return
	}
	origin, ok := a.auth.origin(r, false)
	if !ok {
		writeError(w, http.StatusForbidden, "origin_required")
		return
	}
	record, err := a.profiles.EnsureProfile(r.Context(), principal, origin)
	if err != nil {
		writeProfileError(w, err)
		return
	}
	links, err := a.profiles.GuestLinks(r.Context(), principal.Subject)
	if err != nil {
		writeProfileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ownProfileResponse{
		publicProfileResponse: toPublicProfile(record),
		GuestLinks:            toGuestLinks(links),
	})
}

// updateProfile applies an ownership-checked change to the account's own
// profile.
//
// The account is the verified principal, never a value from the body. A body
// that names a profile, an account, or an owner is refused as an unknown
// field.
func (a *profileAPI) updateProfile(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.auth.account(w, r, true)
	if !ok {
		return
	}
	origin, ok := a.auth.origin(r, true)
	if !ok {
		writeError(w, http.StatusForbidden, "origin_required")
		return
	}
	var body struct {
		Username *string `json:"username"`
		Avatar   *string `json:"avatar"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	record, err := a.profiles.UpdateProfile(r.Context(), principal, profile.Update{
		Username: body.Username,
		Avatar:   body.Avatar,
	}, origin)
	if err != nil {
		writeProfileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toPublicProfile(record))
}

// guestLinks lists the guest seats bound to the account.
func (a *profileAPI) guestLinks(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.auth.account(w, r, false)
	if !ok {
		return
	}
	links, err := a.profiles.GuestLinks(r.Context(), principal.Subject)
	if err != nil {
		writeProfileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"guestLinks": toGuestLinks(links)})
}

// linkGuestSeat binds one guest seat to the account's profile.
//
// The link is explicit: it happens because the account asked for it, and the
// account is the verified principal. The proof in the header is the only
// accepted proof of seat ownership, so a shareable invitation link can never
// link a seat.
//
// The link keeps the guest as the actor of the seat. It does not rewrite the
// seat owner, discard an accepted receipt, or invalidate an accepted
// fingerprint.
func (a *profileAPI) linkGuestSeat(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.auth.account(w, r, true)
	if !ok {
		return
	}
	proof := r.Header.Get(GuestOwnershipProofHeader)
	if proof == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body struct {
		MatchID string `json:"matchId"`
		Seat    string `json:"seat"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	seat := online.Seat(body.Seat)
	if seat != online.SeatWhite && seat != online.SeatBlack {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	origin, ok := a.auth.origin(r, true)
	if !ok {
		writeError(w, http.StatusForbidden, "origin_required")
		return
	}
	link, err := a.profiles.LinkGuestSeat(r.Context(), principal, profile.LinkRequest{
		ProofSecret: proof,
		Origin:      origin,
		MatchID:     body.MatchID,
		Seat:        seat,
	})
	if err != nil {
		writeProfileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, guestLinkResponse{
		SchemaVersion: profile.SchemaVersion,
		LinkID:        link.LinkID,
		ProfileID:     link.ProfileID,
		MatchID:       link.MatchID,
		Seat:          string(link.Seat),
		LinkedAt:      link.LinkedAt.UTC(),
	})
}

// ownershipProof mints a guest ownership proof from a live seat credential.
//
// The proof is issued to the holder of a guest seat credential, so it proves
// control of that seat. It grants no seat control of its own, and it is not
// an account identity.
//
// The proof is short lived. It exists so the guest can deliberately attach
// the seat to an account later.
func (a *profileAPI) ownershipProof(w http.ResponseWriter, r *http.Request) {
	origin, ok := a.auth.origin(r, true)
	if !ok {
		writeError(w, http.StatusForbidden, "origin_required")
		return
	}
	credentials := r.Header.Values(GuestCredentialHeader)
	if len(credentials) != 1 {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if a.issuer == nil {
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	proof, err := a.issuer.IssueOwnershipProof(r.Context(), credentials[0], origin)
	if err != nil {
		writeProfileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ownershipProofResponse{
		SchemaVersion: profile.SchemaVersion,
		ProofID:       proof.ProofID,
		Secret:        proof.Secret,
		MatchID:       proof.MatchID,
		Seat:          string(proof.Seat),
		ExpiresAt:     proof.ExpiresAt.UTC(),
	})
}

// publicProfileResponse is the allowlisted public payload.
//
// It carries the public identifier, the chosen name, the chosen avatar, and
// the timestamps. It never carries the account identifier, the sign-in
// email, the legal name, or a session, a credential, or a hash.
type publicProfileResponse struct {
	SchemaVersion int             `json:"schemaVersion"`
	ProfileID    string          `json:"profileId"`
	Username     *string         `json:"username"`
	Avatar       avatarResponse  `json:"avatar"`
	CreatedAt    time.Time       `json:"createdAt"`
	UpdatedAt    time.Time       `json:"updatedAt"`
}

type avatarResponse struct {
	Kind  string `json:"kind"`
	Value string `json:"value"`
}

// ownProfileResponse adds the linked guest seats to the public payload.
type ownProfileResponse struct {
	publicProfileResponse
	GuestLinks []guestLinkResponse `json:"guestLinks"`
}

type guestLinkResponse struct {
	SchemaVersion int       `json:"schemaVersion"`
	LinkID        string    `json:"linkId"`
	ProfileID     string    `json:"profileId"`
	MatchID       string    `json:"matchId"`
	Seat          string    `json:"seat"`
	LinkedAt      time.Time `json:"linkedAt"`
}

// ownershipProofResponse delivers a freshly minted proof to its holder.
//
// The secret is delivered once, in this response, and never stored. The seat
// binding travels with it so a caller can confirm the proof names the seat it
// means to link before it uses the secret.
type ownershipProofResponse struct {
	SchemaVersion int       `json:"schemaVersion"`
	ProofID       string    `json:"proofId"`
	Secret        string    `json:"secret"`
	MatchID       string    `json:"matchId"`
	Seat          string    `json:"seat"`
	ExpiresAt     time.Time `json:"expiresAt"`
}

func toPublicProfile(record profile.Profile) publicProfileResponse {
	response := publicProfileResponse{
		SchemaVersion: profile.SchemaVersion,
		ProfileID:    record.ProfileID,
		Avatar:       avatarResponse{Kind: string(record.Avatar.Kind), Value: record.Avatar.Value},
		CreatedAt:    record.CreatedAt.UTC(),
		UpdatedAt:    record.UpdatedAt.UTC(),
	}
	if record.Username != "" {
		name := record.Username
		response.Username = &name
	}
	return response
}

func toGuestLinks(links []profile.GuestLink) []guestLinkResponse {
	items := make([]guestLinkResponse, 0, len(links))
	for _, link := range links {
		items = append(items, guestLinkResponse{
			SchemaVersion: profile.SchemaVersion,
			LinkID:        link.LinkID,
			ProfileID:     link.ProfileID,
			MatchID:       link.MatchID,
			Seat:          string(link.Seat),
			LinkedAt:      link.LinkedAt.UTC(),
		})
	}
	return items
}

// writeProfileError maps a profile failure onto a status.
//
// A missing profile and a profile the caller does not own share one status,
// so a caller cannot learn which public names exist.
func writeProfileError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, onlineauth.ErrOriginRequired):
		writeError(w, http.StatusForbidden, "origin_required")
	case errors.Is(err, onlineauth.ErrUnauthenticated):
		writeError(w, http.StatusUnauthorized, "unauthorized")
	case errors.Is(err, profile.ErrNotFound), errors.Is(err, profile.ErrNotAuthorized):
		writeError(w, http.StatusNotFound, "not_found")
	case errors.Is(err, profile.ErrUsernameTaken):
		writeError(w, http.StatusConflict, "username_taken")
	case errors.Is(err, profile.ErrInvalidUsername):
		writeError(w, http.StatusBadRequest, "invalid_username")
	case errors.Is(err, profile.ErrInvalidAvatar):
		writeError(w, http.StatusBadRequest, "invalid_avatar")
	case errors.Is(err, profile.ErrSeatAlreadyLinked):
		writeError(w, http.StatusConflict, "seat_already_linked")
	case errors.Is(err, profile.ErrProofConsumed):
		writeError(w, http.StatusConflict, "proof_already_used")
	default:
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
	}
}
