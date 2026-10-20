package httpapi

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
)

// participantAuthenticator resolves the origin of a request and the verified
// caller behind its credential.
//
// It is the shared boundary of the online participant API and the public
// profile API. Both refuse a request that names an origin the service does
// not allow, both refuse a mutation without an explicit origin, and both
// take the credential from the request header the credential kind owns.
type participantAuthenticator struct {
	authenticator OnlineAuthenticator
	options       OnlineOptions
}

func newParticipantAuthenticator(authenticator OnlineAuthenticator, options OnlineOptions) participantAuthenticator {
	return participantAuthenticator{authenticator: authenticator, options: options}
}

// origin resolves the origin of a request.
//
// An explicit Origin header always wins. A mutation must carry one. A read
// may omit it, and then the origin is resolved from the configured origins by
// request host, which only succeeds for a same-origin deployment.
func (p participantAuthenticator) origin(r *http.Request, mutation bool) (string, bool) {
	origins := r.Header.Values("Origin")
	if len(origins) > 1 {
		return "", false
	}
	if len(origins) == 1 {
		origin := strings.TrimSpace(origins[0])
		if origin == "" {
			return "", false
		}
		return origin, true
	}
	if mutation {
		return "", false
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
		return "", false
	}
	return p.sameOrigin(r)
}

// sameOrigin resolves the request origin from the configured origins by
// request host. It never trusts a forwarded scheme header.
func (p participantAuthenticator) sameOrigin(r *http.Request) (string, bool) {
	if r.Host == "" {
		return "", false
	}
	for _, candidate := range p.options.AllowedOrigins {
		parsed, err := url.Parse(candidate)
		if err != nil || parsed.Host == "" {
			continue
		}
		if parsed.Host == r.Host {
			return candidate, true
		}
	}
	return "", false
}

// participant authenticates the request and returns the caller.
//
// An account participant presents a Clerk session token. A guest participant
// presents the opaque seat credential. Presenting both is rejected so the
// server never has to choose which identity wins.
//
// A mutation requires an explicit Origin header. A browser always sends it,
// and a mutation without one is never silently accepted.
func (p participantAuthenticator) participant(w http.ResponseWriter, r *http.Request, mutation bool) (onlineauth.Principal, bool) {
	origin, ok := p.origin(r, mutation)
	if !ok {
		writeError(w, http.StatusForbidden, "origin_required")
		return onlineauth.Principal{}, false
	}
	authorization := r.Header.Values("Authorization")
	guest := r.Header.Values(GuestCredentialHeader)
	if len(authorization) > 1 || len(guest) > 1 {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return onlineauth.Principal{}, false
	}
	if len(authorization) == 1 && len(guest) == 1 {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return onlineauth.Principal{}, false
	}
	if len(authorization) == 1 {
		fields := strings.Fields(authorization[0])
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return onlineauth.Principal{}, false
		}
		principal, err := p.authenticator.AuthenticateAccount(r.Context(), fields[1], origin)
		if err != nil {
			writeOnlineError(w, err)
			return onlineauth.Principal{}, false
		}
		return principal, true
	}
	if len(guest) == 1 {
		principal, err := p.authenticator.AuthenticateGuest(r.Context(), guest[0], origin)
		if err != nil {
			writeOnlineError(w, err)
			return onlineauth.Principal{}, false
		}
		return principal, true
	}
	writeError(w, http.StatusUnauthorized, "unauthorized")
	return onlineauth.Principal{}, false
}

// account authenticates the request and requires an account identity.
//
// A guest seat credential is refused here. A guest is a participant of a
// match, never an account, and an account-scoped route must never act for a
// guest.
func (p participantAuthenticator) account(w http.ResponseWriter, r *http.Request, mutation bool) (onlineauth.Principal, bool) {
	principal, ok := p.participant(w, r, mutation)
	if !ok {
		return onlineauth.Principal{}, false
	}
	if principal.IsGuest() {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return onlineauth.Principal{}, false
	}
	return principal, true
}
