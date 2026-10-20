package integration

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/storage"
)

func TestPostgresPrivateSavePreservesAgreedDraw(t *testing.T) {
	store := openStore(t)
	ctx := context.Background()
	result := map[string]any{
		"kind": "final", "winner": "draw", "reason": "draw-agreement",
		"eventId": "draw-confirmed", "decidedAtMs": 100,
	}
	_, err := store.Create(ctx, "user_a", storage.CreateGame{
		GameID: "offline-draw", CheckpointJSON: checkpoint("offline-draw", "user_a", 1, 1, result),
	})
	if err != nil {
		t.Fatalf("save confirmed offline draw: %v", err)
	}
	saved, err := store.Get(ctx, "user_a", "offline-draw")
	if err != nil {
		t.Fatal(err)
	}
	var restored struct {
		Result struct {
			Winner string `json:"winner"`
			Reason string `json:"reason"`
		} `json:"result"`
	}
	if err = json.Unmarshal(saved.CheckpointJSON, &restored); err != nil {
		t.Fatal(err)
	}
	if restored.Result.Winner != "draw" || restored.Result.Reason != "draw-agreement" {
		t.Fatalf("restored result = %+v", restored.Result)
	}
	result["winner"] = "white"
	_, err = store.Create(ctx, "user_a", storage.CreateGame{
		GameID: "invalid-draw", CheckpointJSON: checkpoint("invalid-draw", "user_a", 1, 1, result),
	})
	if !errors.Is(err, storage.ErrInvalidDTO) {
		t.Fatalf("agreed draw naming a winner must fail, got %v", err)
	}
}
