package profile

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"regexp"
	"testing"
)

// sharedContract is the shape contract the browser parses too. The fixture is
// the single source of truth for both sides of the wire.
type sharedContract struct {
	ProfileIDPattern  string   `json:"profileIdPattern"`
	LinkIDPattern     string   `json:"linkIdPattern"`
	ProofIDPattern    string   `json:"proofIdPattern"`
	UsernamePattern   string   `json:"usernamePattern"`
	AvatarChoices     []string `json:"avatarChoices"`
	ReservedUsernames []string `json:"reservedUsernames"`
}

func readSharedContract(t *testing.T) sharedContract {
	t.Helper()
	raw, err := os.ReadFile("testdata/public-profile-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract sharedContract
	if err = json.Unmarshal(raw, &contract); err != nil {
		t.Fatal(err)
	}
	return contract
}

func TestTheServiceRulesMatchTheSharedShapeContract(t *testing.T) {
	contract := readSharedContract(t)
	if contract.UsernamePattern != usernamePattern.String() {
		t.Fatalf("the public name shape %q does not match the shared contract %q", usernamePattern.String(), contract.UsernamePattern)
	}
	if !reflect.DeepEqual(contract.AvatarChoices, ChosenAvatars) {
		t.Fatalf("the avatar catalog %v does not match the shared contract %v", ChosenAvatars, contract.AvatarChoices)
	}
	if len(contract.ReservedUsernames) != len(reservedUsernames) {
		t.Fatalf("the reserved names %v do not match the shared contract %v", reservedUsernames, contract.ReservedUsernames)
	}
	for _, name := range contract.ReservedUsernames {
		if !reservedUsernames[name] {
			t.Fatalf("the reserved name %q is missing from the service rules", name)
		}
	}
}

func TestTheIssuedIdentifiersMatchTheSharedShapeContract(t *testing.T) {
	contract := readSharedContract(t)
	profileID, err := newIdentifier("kp_")
	if err != nil {
		t.Fatal(err)
	}
	linkID, err := newIdentifier("kl_")
	if err != nil {
		t.Fatal(err)
	}
	if !matchesPattern(contract.ProfileIDPattern, profileID) {
		t.Fatalf("the profile identifier %q does not match %q", profileID, contract.ProfileIDPattern)
	}
	if !matchesPattern(contract.LinkIDPattern, linkID) {
		t.Fatalf("the link identifier %q does not match %q", linkID, contract.LinkIDPattern)
	}
}

func matchesPattern(pattern, value string) bool {
	expression, err := regexp.Compile(pattern)
	if err != nil {
		return false
	}
	return expression.MatchString(value)
}

func TestNormalizeUsernameKeepsTheChosenSpellingAndComparesCaseInsensitively(t *testing.T) {
	cases := []struct {
		input   string
		display string
		key     string
	}{
		{"alice", "alice", "alice"},
		{"Alice", "Alice", "alice"},
		{"ALICE", "ALICE", "alice"},
		{"  alice  ", "alice", "alice"},
		{"a_1", "a_1", "a_1"},
		{"a-1", "a-1", "a-1"},
		{"ab1", "ab1", "ab1"},
	}
	for _, testCase := range cases {
		display, key, err := NormalizeUsername(testCase.input)
		if err != nil {
			t.Fatalf("NormalizeUsername(%q) failed: %v", testCase.input, err)
		}
		if display != testCase.display || key != testCase.key {
			t.Fatalf("NormalizeUsername(%q) = %q/%q, want %q/%q", testCase.input, display, key, testCase.display, testCase.key)
		}
	}
}

func TestNormalizeUsernameRefusesReservedAndUnsafeNames(t *testing.T) {
	for _, value := range []string{
		"",
		"   ",
		"ab",
		"a",
		"guest",
		"GUEST",
		"Guest",
		"anonymous",
		"deleted",
		"admin",
		"administrator",
		"system",
		"moderator",
		"support",
		"staff",
		"official",
		"root",
		"null",
		"undefined",
		"has space",
		"a@name.com",
		"name@example",
		"-leading",
		"_leading",
		"trailing-",
		"trailing_",
		"dots.are.out",
		"slash/es",
		"colon:name",
		"quote\"name",
		"emoji😀name",
		"toolongusername-toolongusername",
		"newline\nname",
	} {
		if _, _, err := NormalizeUsername(value); !errors.Is(err, ErrInvalidUsername) {
			t.Fatalf("NormalizeUsername(%q) accepted the name: %v", value, err)
		}
	}
}

func TestUsernameKeyRejectsANameTheServiceWouldNotAccept(t *testing.T) {
	if _, err := UsernameKey("guest"); !errors.Is(err, ErrInvalidUsername) {
		t.Fatalf("UsernameKey accepted a reserved name: %v", err)
	}
	key, err := UsernameKey("Alice")
	if err != nil {
		t.Fatalf("UsernameKey failed: %v", err)
	}
	if key != "alice" {
		t.Fatalf("UsernameKey = %q, want alice", key)
	}
}

func TestNormalizeAvatarAcceptsOnlyTheBoundedCatalog(t *testing.T) {
	for _, value := range ChosenAvatars {
		normalized, err := NormalizeAvatar(value)
		if err != nil {
			t.Fatalf("NormalizeAvatar(%q) failed: %v", value, err)
		}
		if normalized != value {
			t.Fatalf("NormalizeAvatar(%q) = %q", value, normalized)
		}
	}
	// The generated default is an empty choice.
	normalized, err := NormalizeAvatar("")
	if err != nil {
		t.Fatalf("NormalizeAvatar(\"\") failed: %v", err)
	}
	if normalized != "" {
		t.Fatalf("NormalizeAvatar(\"\") = %q", normalized)
	}
	for _, value := range []string{
		"unknown",
		"https://tracker.example/pixel.png",
		"data:image/svg+xml;base64,AAAA",
		"../../etc/passwd",
		"Ember",
	} {
		if _, err := NormalizeAvatar(value); !errors.Is(err, ErrInvalidAvatar) {
			t.Fatalf("NormalizeAvatar(%q) accepted the avatar: %v", value, err)
		}
	}
}
