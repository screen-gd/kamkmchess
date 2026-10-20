package integration

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
)

// Replace every API/service instance while retaining PostgreSQL. Recovery
// must use the durable version, accepted move and operation receipt.
func TestPostgresOnlineUpdatesRecoverAfterAPIReplacement(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	const matchID = "match-updates-restart"
	const path = "/v1/online/matches/" + matchID + "/updates"
	issued := createGuestMatch(t, fixture, matchID)
	options := httpapi.OnlineOptions{UpdatesStreamMaxDuration: time.Second}
	firstServer := onlineUpdatesServer(t, fixture, options)
	response := updatesStreamRequest(t, firstServer, path, map[string]string{
		httpapi.GuestCredentialHeader: issued.Credential.Secret,
	})
	defer response.Body.Close()
	frame, err := readLiveSSEFrame(bufio.NewReader(response.Body))
	if err != nil || frame.id != "1" {
		t.Fatalf("initial snapshot: frame=%+v err=%v", frame, err)
	}
	principal := guestParticipant(t, fixture, issued)
	ctx := onlineauth.WithPrincipal(context.Background(), principal)
	command := moveOnlineCommand(matchID, "op-restart-move", online.SeatWhite, 1, "e2e4")
	if _, err := fixture.service.Execute(ctx, principal.Participant, command); err != nil {
		t.Fatal(err)
	}
	// The client loses the move acknowledgement and the second event.
	response.Body.Close()
	firstServer.CloseClientConnections()
	firstServer.Close()

	authorizer, err := onlineauth.Open(context.Background(), fixture.pool, fixture.verifier, onlineauth.Options{})
	if err != nil {
		t.Fatal(err)
	}
	writer, err := online.Open(context.Background(), fixture.pool, moveEvaluator{}, online.WithSeatAuthorizer(authorizer))
	if err != nil {
		t.Fatal(err)
	}
	replacement := &onlineAuthFixture{service: writer, authorizer: authorizer}
	server := onlineUpdatesServer(t, replacement, options)
	credential := map[string]string{httpapi.GuestCredentialHeader: issued.Credential.Secret, "Last-Event-ID": "1"}
	poll := updatesPollRequest(t, server, path, credential)
	defer poll.Body.Close()
	if poll.StatusCode != http.StatusOK {
		t.Fatalf("recovery status %d", poll.StatusCode)
	}
	var recovered struct {
		Cursor   int64 `json:"cursor"`
		Snapshot struct {
			Version int64             `json:"version"`
			Moves   []online.Move     `json:"moves"`
			Clock   online.ClockState `json:"clock"`
		} `json:"snapshot"`
	}
	if err := json.NewDecoder(poll.Body).Decode(&recovered); err != nil {
		t.Fatal(err)
	}
	if recovered.Cursor != 2 || recovered.Snapshot.Version != 2 || len(recovered.Snapshot.Moves) != 1 || recovered.Snapshot.Clock.WhiteMs != 302000 {
		t.Fatalf("recovered state: %+v", recovered)
	}
	receiptPath := "/v1/online/matches/" + matchID + "/operations/" + command.OperationID
	receipt := updatesPollRequest(t, server, receiptPath, credential)
	defer receipt.Body.Close()
	stored, err := io.ReadAll(receipt.Body)
	if err != nil || receipt.StatusCode != http.StatusOK {
		t.Fatalf("durable receipt status=%d err=%v body=%s", receipt.StatusCode, err, stored)
	}
	duplicate, err := writer.Execute(ctx, principal.Participant, command)
	if err != nil || !duplicate.Duplicate {
		t.Fatalf("duplicate operation: %+v err=%v", duplicate, err)
	}
	match, err := writer.GetMatchForParticipant(ctx, matchID, principal.Participant)
	if err != nil || match.Version != 2 || len(match.Moves) != 1 || match.Clock.WhiteMs != recovered.Snapshot.Clock.WhiteMs {
		t.Fatalf("duplicate changed recovered state: %+v err=%v", match, err)
	}
}
