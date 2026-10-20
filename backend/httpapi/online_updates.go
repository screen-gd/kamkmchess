package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
)

// OnlineUpdatesSchemaVersion is the wire version of the updates envelope.
//
// The envelope is additive. It carries the durable match version as its
// cursor and the canonical participant snapshot, so a client that does not
// understand the version still reads a usable snapshot.
const OnlineUpdatesSchemaVersion = 1

const (
	// defaultUpdatesPollInterval is how often a live stream probes the
	// durable match version for a change.
	defaultUpdatesPollInterval = time.Second
	// defaultUpdatesHeartbeatInterval is how often a live stream writes an
	// SSE comment while nothing changed. It stays below the five second
	// limit of the contract, so a proxy or a consumer never sees a silent
	// stream.
	defaultUpdatesHeartbeatInterval = 4 * time.Second
	// defaultUpdatesStreamDuration bounds one live stream window.
	defaultUpdatesStreamDuration = 20 * time.Second
	// maxUpdatesStreamDuration is the hard cap of one live stream window.
	// A window never lasts longer than twenty seconds, whatever is
	// configured.
	maxUpdatesStreamDuration = 20 * time.Second
	// maxUpdatesHeartbeatInterval is the hard cap of the heartbeat interval.
	// The contract requires a comment at least every five seconds.
	maxUpdatesHeartbeatInterval = 5 * time.Second
	// updatesExpiryMargin keeps a stream strictly shorter than the expiry
	// of the credential that opened it. A window that ended exactly at the
	// expiry would still be alive while the credential was dead.
	updatesExpiryMargin = time.Second
	// defaultUpdatesWriteTimeout bounds one write to a consumer. A consumer
	// that cannot keep up fails closed instead of holding a stream open.
	defaultUpdatesWriteTimeout = 10 * time.Second
	// maxUpdatesCursor is the largest cursor a client may present. It is
	// the largest integer a browser client holds exactly.
	maxUpdatesCursor = int64(1<<53 - 1)
)

// onlineUpdatesEnvelope is the canonical update envelope.
//
// The cursor is the durable match version and it always equals the version of
// the snapshot it carries. A snapshot is a replacement and never a delta: a
// client that missed events converges on the next snapshot instead of
// replaying them, so a gap, a duplicate, or a lost acknowledgement can
// neither reapply a move nor move the cursor backwards.
type onlineUpdatesEnvelope struct {
	SchemaVersion int                 `json:"schemaVersion"`
	Cursor        int64               `json:"cursor"`
	Snapshot      onlineMatchResponse `json:"snapshot"`
}

// onlineVersionReader is an optional extension of the online service.
//
// A service that implements it reports the durable match version with a
// bounded read that holds no transaction. The live stream uses it to detect a
// change without loading the whole match, and it keeps no database
// connection between two reads.
type onlineVersionReader interface {
	MatchVersionForParticipant(ctx context.Context, matchID string, participant online.ParticipantRef) (int64, error)
}

// OnlineStreamAuthorizer is an optional extension of the online
// authenticator.
//
// A service that implements it grants one live subscription window: it
// re-checks the presented credential and the match membership and returns
// the deadline of the window. The updates stream uses the grant when it is
// available and falls back to the credential expiry otherwise.
type OnlineStreamAuthorizer interface {
	AuthorizeStream(ctx context.Context, principal onlineauth.Principal, matchID string) (onlineauth.StreamGrant, error)
}

// updatesRepresentation is the representation of the updates route.
type updatesRepresentation int

const (
	// updatesRepresentationJSON answers one request with the canonical
	// envelope. It is the compatibility fallback of the live stream.
	updatesRepresentationJSON updatesRepresentation = iota
	// updatesRepresentationSSE opens the finite live stream.
	updatesRepresentationSSE
)

// updates serves the finite live update stream and its polling fallback.
//
// The route is one path with two representations. A client that asks for
// text/event-stream receives a finite server-sent event stream; a client that
// asks for application/json receives the same envelope once. Both start from
// the current canonical snapshot, so a client that reconnects converges even
// when it missed events.
func (a *onlineAPI) updates(w http.ResponseWriter, r *http.Request) {
	representation, ok := negotiateUpdates(r.Header.Values("Accept"))
	if !ok {
		writeError(w, http.StatusNotAcceptable, "not_acceptable")
		return
	}
	// The cursor is optional. A malformed or out-of-range cursor is a
	// malformed request and never a silent reset: a client that cannot
	// state its position exactly must not look as if it had.
	if _, ok = parseUpdatesCursor(r.Header.Values("Last-Event-ID")); !ok {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	principal, ok := a.participant(w, r, false)
	if !ok {
		return
	}
	matchID := r.PathValue("matchID")
	if representation == updatesRepresentationJSON {
		a.pollUpdates(w, r, principal, matchID)
		return
	}
	a.streamUpdates(w, r, principal, matchID)
}

// pollUpdates answers one polling request with the canonical envelope.
//
// The polling fallback uses the same envelope and accepts the same cursor
// header as the live stream, so a client can switch between them without
// changing how it stores a position.
func (a *onlineAPI) pollUpdates(w http.ResponseWriter, r *http.Request, principal onlineauth.Principal, matchID string) {
	// The read is bounded by the same window as a stream, so a slow
	// database cannot hold a request and its connection open.
	ctx, cancel := context.WithDeadline(onlineauth.WithPrincipal(r.Context(), principal), a.updatesRequestDeadline(principal))
	defer cancel()
	match, err := a.service.GetMatchForParticipant(ctx, matchID, principal.Participant)
	if err != nil {
		writeOnlineError(w, err)
		return
	}
	envelope, err := newUpdatesEnvelope(match, principal)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	writeJSON(w, http.StatusOK, envelope)
}

// streamUpdates opens the finite live stream.
//
// The window is bounded twice: it never outlives the configured maximum and
// it never outlives the expiry of the credential that opened it. The stream
// begins with the current canonical snapshot, so a client that presents a
// stale, a future, or a gap cursor still receives a usable state.
//
// The whole window shares one deadline. The first read, every later read and
// every write are bounded by it, so a slow database or a blocked consumer
// cannot keep a stream alive past the window or past the expiry of the
// credential that opened it.
//
// The stream holds no database connection while it waits. A change is
// detected by a bounded read of the durable version, and the read ends before
// the stream waits again.
func (a *onlineAPI) streamUpdates(w http.ResponseWriter, r *http.Request, principal onlineauth.Principal, matchID string) {
	if _, ok := w.(http.Flusher); !ok {
		writeError(w, http.StatusInternalServerError, "stream_unavailable")
		return
	}
	deadline, err := a.updatesDeadline(r.Context(), principal, matchID)
	if err != nil {
		writeOnlineError(w, err)
		return
	}
	// Every read of the window runs under this deadline. A read that would
	// wait for a lock or for a pool slot is cut off with the window.
	ctx, cancel := context.WithDeadline(onlineauth.WithPrincipal(r.Context(), principal), deadline)
	defer cancel()
	// The first snapshot is read before the response starts, so a refused
	// membership or a refused credential is a status code and not an empty
	// stream.
	match, err := a.service.GetMatchForParticipant(ctx, matchID, principal.Participant)
	if err != nil {
		writeOnlineError(w, err)
		return
	}
	envelope, err := newUpdatesEnvelope(match, principal)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	// The window must still be open before the response starts.
	if !time.Now().Before(deadline) {
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	controller := http.NewResponseController(w)
	defer func() { _ = controller.SetWriteDeadline(time.Time{}) }()
	// The write deadline is armed before anything is written, so a blocked
	// consumer cannot stall the response headers either.
	if err = a.armWriteDeadline(controller, deadline); err != nil {
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	// A reverse proxy must not buffer the stream.
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	if err = controller.Flush(); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return
	}
	if err = a.writeUpdatesSnapshot(w, controller, deadline, envelope); err != nil {
		return
	}
	lastVersion := envelope.Cursor
	lastActivity := time.Now()

	pollTicker := time.NewTicker(a.options.UpdatesPollInterval)
	defer pollTicker.Stop()
	heartbeatTicker := time.NewTicker(a.options.UpdatesHeartbeatInterval)
	defer heartbeatTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			// The window closed or the consumer went away. The stream ends
			// without an error.
			return
		case <-pollTicker.C:
			// The read may not delay the heartbeat past its interval. A
			// read that is too slow is cut off, and the stream waits for
			// the next poll instead of losing its heartbeat.
			readCtx, cancelRead := context.WithDeadline(ctx, a.updatesReadDeadline(deadline, lastActivity))
			version, err := a.matchVersion(readCtx, matchID, principal.Participant)
			cancelRead()
			if err != nil {
				if errors.Is(err, context.DeadlineExceeded) {
					// The read was cut off by the heartbeat bound or by
					// the window. The window ends the stream at the next
					// turn of the loop.
					continue
				}
				// A revoked credential or a lost membership ends the
				// stream. The next request reports the refusal with a
				// status code.
				return
			}
			if version <= lastVersion {
				continue
			}
			readCtx, cancelRead = context.WithDeadline(ctx, a.updatesReadDeadline(deadline, lastActivity))
			match, err := a.service.GetMatchForParticipant(readCtx, matchID, principal.Participant)
			cancelRead()
			if err != nil {
				if errors.Is(err, context.DeadlineExceeded) {
					// The change is still pending. The next poll finds
					// it again.
					continue
				}
				return
			}
			envelope, err := newUpdatesEnvelope(match, principal)
			if err != nil {
				return
			}
			if err = a.writeUpdatesSnapshot(w, controller, deadline, envelope); err != nil {
				return
			}
			lastVersion = envelope.Cursor
			lastActivity = time.Now()
		case <-heartbeatTicker.C:
			// The heartbeat is unconditional. A busy match produces
			// snapshots, and a comment still proves that the stream is
			// alive.
			if err = a.writeUpdatesHeartbeat(w, controller, deadline); err != nil {
				return
			}
			lastActivity = time.Now()
		}
	}
}

// updatesReadDeadline returns the deadline of one bounded read.
//
// A read after the first snapshot may not hold the stream past the heartbeat
// interval. The read is bounded by the window and by the last write, so the
// consumer never waits longer than the heartbeat interval for a comment or
// for the end of the stream. A read that exceeds the bound is cut off, and
// the stream keeps its heartbeat.
func (a *onlineAPI) updatesReadDeadline(window time.Time, lastActivity time.Time) time.Time {
	deadline := lastActivity.Add(a.options.UpdatesHeartbeatInterval)
	if window.Before(deadline) {
		return window
	}
	return deadline
}

// updatesDeadline returns the deadline of one live stream window.
//
// The window is the earliest of the configured maximum, the hard twenty
// second cap, the window the authorization service grants, and the expiry of
// the presented credential minus a margin. The margin keeps the stream
// strictly shorter than its credential, so the stream is never alive while
// the credential is dead.
//
// The authorization read shares the same window. A blocked database can
// therefore not keep the request open past the window that the request
// started, and the stream that follows never outlives the request either.
func (a *onlineAPI) updatesDeadline(ctx context.Context, principal onlineauth.Principal, matchID string) (time.Time, error) {
	deadline := a.updatesRequestDeadline(principal)
	if a.streamAuthorizer == nil {
		return deadline, nil
	}
	authCtx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	grant, err := a.streamAuthorizer.AuthorizeStream(authCtx, principal, matchID)
	if err != nil {
		return time.Time{}, err
	}
	if grant.ExpiresAt.Before(deadline) {
		return grant.ExpiresAt, nil
	}
	return deadline, nil
}

// updatesRequestDeadline returns the deadline of one bounded request.
//
// The deadline is the earlier of the configured maximum and the expiry of
// the presented credential minus a margin. The margin keeps a request
// strictly shorter than its credential, so a request is never served while
// the credential is dead.
func (a *onlineAPI) updatesRequestDeadline(principal onlineauth.Principal) time.Time {
	deadline := time.Now().Add(a.options.UpdatesStreamMaxDuration)
	if !principal.ExpiresAt.IsZero() {
		limited := principal.ExpiresAt.Add(-updatesExpiryMargin)
		if limited.Before(deadline) {
			deadline = limited
		}
	}
	return deadline
}

// matchVersion reads the durable version of a match for a participant.
//
// The optional version reader answers with a bounded read that holds no
// transaction. A service without one falls back to the full snapshot read,
// which is correct but heavier.
func (a *onlineAPI) matchVersion(ctx context.Context, matchID string, participant online.ParticipantRef) (int64, error) {
	if reader, ok := a.service.(onlineVersionReader); ok {
		return reader.MatchVersionForParticipant(ctx, matchID, participant)
	}
	match, err := a.service.GetMatchForParticipant(ctx, matchID, participant)
	if err != nil {
		return 0, err
	}
	return match.Version, nil
}

// newUpdatesEnvelope builds the canonical envelope of a match.
//
// The cursor is the durable version of the match, and the snapshot is the
// same allowlisted participant view the live route serves.
//
// The cursor is a safe integer. A version beyond the safe range would be
// rounded by a browser client, so it is refused instead of published.
func newUpdatesEnvelope(match online.Match, principal onlineauth.Principal) (onlineUpdatesEnvelope, error) {
	if match.Version < 1 || match.Version > maxUpdatesCursor {
		return onlineUpdatesEnvelope{}, errors.New("online: the match version is not a safe cursor")
	}
	snapshot := toOnlineMatch(match, principal)
	if snapshot.Version != match.Version {
		return onlineUpdatesEnvelope{}, errors.New("online: the snapshot version does not match the cursor")
	}
	return onlineUpdatesEnvelope{SchemaVersion: OnlineUpdatesSchemaVersion, Cursor: match.Version, Snapshot: snapshot}, nil
}

// writeUpdatesSnapshot writes one snapshot event.
//
// The event carries the cursor as its identifier and the envelope as a single
// line of JSON. A write that fails, including a write to a consumer that
// stopped reading, ends the stream: the handler fails closed instead of
// keeping a stream nobody receives.
func (a *onlineAPI) writeUpdatesSnapshot(w http.ResponseWriter, controller *http.ResponseController, deadline time.Time, envelope onlineUpdatesEnvelope) error {
	payload, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	var frame strings.Builder
	frame.WriteString("event: snapshot\n")
	frame.WriteString("id: ")
	frame.WriteString(strconv.FormatInt(envelope.Cursor, 10))
	frame.WriteString("\ndata: ")
	frame.Write(payload)
	frame.WriteString("\n\n")
	return a.writeUpdatesFrame(w, controller, deadline, frame.String())
}

// writeUpdatesHeartbeat writes one heartbeat comment.
//
// A comment is invisible to the event parser of a consumer, so a heartbeat
// never looks like a state change. It only proves that the stream is alive.
func (a *onlineAPI) writeUpdatesHeartbeat(w http.ResponseWriter, controller *http.ResponseController, deadline time.Time) error {
	return a.writeUpdatesFrame(w, controller, deadline, ": heartbeat\n\n")
}

// writeUpdatesFrame writes one frame with a bounded write deadline.
//
// The deadline is the earlier of the write timeout and the end of the stream
// window, so a blocked consumer cannot keep a frame alive past the window. A
// consumer that cannot keep up fails the write, and the stream ends instead
// of holding a server goroutine and a connection open forever.
func (a *onlineAPI) writeUpdatesFrame(w http.ResponseWriter, controller *http.ResponseController, deadline time.Time, payload string) error {
	if err := a.armWriteDeadline(controller, deadline); err != nil {
		return err
	}
	if _, err := io.WriteString(w, payload); err != nil {
		return err
	}
	if err := controller.Flush(); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return err
	}
	return nil
}

// armWriteDeadline bounds one write.
//
// The deadline of a write is the earlier of the configured write timeout and
// the end of the stream window. A writer without a deadline support is not an
// error: the stream still ends at its window, it only cannot fail a blocked
// write early.
func (a *onlineAPI) armWriteDeadline(controller *http.ResponseController, deadline time.Time) error {
	target := time.Now().Add(a.options.UpdatesWriteTimeout)
	if deadline.Before(target) {
		target = deadline
	}
	if err := controller.SetWriteDeadline(target); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return err
	}
	return nil
}

// negotiateUpdates chooses the representation of the updates route.
//
// The stream is explicit: only a client that asks for text/event-stream gets
// a stream. Every other acceptable request, including the wildcard a browser
// sends by default, gets the JSON envelope. A request that accepts neither
// is refused.
func negotiateUpdates(values []string) (updatesRepresentation, bool) {
	if len(values) == 0 {
		return updatesRepresentationJSON, true
	}
	streamQuality := 0.0
	jsonQuality := 0.0
	wildcardQuality := 0.0
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			media, quality := parseAcceptPart(part)
			if media == "" || quality <= 0 {
				continue
			}
			switch media {
			case "text/event-stream":
				if quality > streamQuality {
					streamQuality = quality
				}
			case "application/json", "text/json":
				if quality > jsonQuality {
					jsonQuality = quality
				}
			case "*/*":
				if quality > wildcardQuality {
					wildcardQuality = quality
				}
			}
		}
	}
	// An explicit stream wins a tie, because asking for the stream is the
	// deliberate choice of the client.
	switch {
	case streamQuality > 0 && streamQuality >= jsonQuality:
		return updatesRepresentationSSE, true
	case jsonQuality > 0:
		return updatesRepresentationJSON, true
	case wildcardQuality > 0:
		return updatesRepresentationJSON, true
	default:
		return updatesRepresentationJSON, false
	}
}

// parseAcceptPart splits one accepted media type from its quality.
//
// A quality of zero means the media type is not acceptable at all.
func parseAcceptPart(part string) (string, float64) {
	fields := strings.Split(part, ";")
	media := strings.ToLower(strings.TrimSpace(fields[0]))
	if media == "" {
		return "", 0
	}
	quality := 1.0
	for _, parameter := range fields[1:] {
		key, value, found := strings.Cut(parameter, "=")
		if !found || !strings.EqualFold(strings.TrimSpace(key), "q") {
			continue
		}
		parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
		if err != nil || parsed < 0 {
			return media, 0
		}
		quality = parsed
	}
	return media, quality
}

// parseUpdatesCursor reads the optional cursor a client presents.
//
// The cursor is a nonnegative safe decimal integer. An absent header means
// that the client states no position. A header that is present but empty or
// padded is malformed, and a malformed or an out-of-range value is refused:
// a client that cannot state its position exactly must not look as if it had.
//
// The cursor never selects what the server sends: every stream starts from
// the current canonical snapshot, so a stale, a future, or a gap cursor still
// converges.
func parseUpdatesCursor(values []string) (int64, bool) {
	if len(values) == 0 {
		return 0, true
	}
	if len(values) > 1 {
		return 0, false
	}
	value := values[0]
	if value == "" || strings.TrimSpace(value) != value {
		return 0, false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return 0, false
		}
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed > maxUpdatesCursor {
		return 0, false
	}
	return parsed, true
}
