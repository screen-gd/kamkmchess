package rulesworker

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

// semanticInputFingerprint recomputes the worker's semantic input fingerprint
// from the request the Go authority actually sent. It mirrors inputFingerprint
// in src/online-rules-worker/protocol.ts byte for byte: the same field order,
// the same JSON.stringify string escaping and the same canonical intent shape.
// Hashing only what Go sent means a worker cannot answer a different position,
// history or timeout side with a well-shaped but unrelated digest. Chess
// identities are deliberately not reimplemented here; they are inside the
// request payload and therefore inside the hash.
func semanticInputFingerprint(request Request) (string, error) {
	var canonical strings.Builder
	canonical.WriteString(`{"protocolVersion":`)
	canonical.WriteString(strconv.Itoa(ProtocolVersion))
	canonical.WriteString(`,"rulesPolicyVersion":`)
	if err := writeJSONString(&canonical, policyFor(request)); err != nil {
		return "", err
	}
	canonical.WriteString(`,"matchVersion":`)
	canonical.WriteString(strconv.FormatInt(request.MatchVersion, 10))
	canonical.WriteString(`,"fen":`)
	if err := writeJSONString(&canonical, request.FEN); err != nil {
		return "", err
	}
	canonical.WriteString(`,"history":[`)
	for index, fen := range request.History {
		if index > 0 {
			canonical.WriteByte(',')
		}
		if err := writeJSONString(&canonical, fen); err != nil {
			return "", err
		}
	}
	canonical.WriteString(`],"intent":`)
	if err := writeCanonicalIntent(&canonical, request.Intent); err != nil {
		return "", err
	}
	canonical.WriteByte('}')

	sum := sha256.Sum256([]byte(canonical.String()))
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

// writeCanonicalIntent reproduces canonicalIntent() from the worker: an absent
// intent hashes as null, a move carries a nullable promotion, and a timeout
// carries only the expired colour.
func writeCanonicalIntent(canonical *strings.Builder, intent *Intent) error {
	if intent == nil {
		canonical.WriteString("null")
		return nil
	}
	switch intent.Kind {
	case "move":
		canonical.WriteString(`{"kind":"move","from":`)
		if err := writeJSONString(canonical, intent.From); err != nil {
			return err
		}
		canonical.WriteString(`,"to":`)
		if err := writeJSONString(canonical, intent.To); err != nil {
			return err
		}
		canonical.WriteString(`,"promotion":`)
		if intent.Promotion == "" {
			canonical.WriteString("null")
		} else if err := writeJSONString(canonical, intent.Promotion); err != nil {
			return err
		}
		canonical.WriteByte('}')
	case "timeout":
		canonical.WriteString(`{"kind":"timeout","expiredColor":`)
		if err := writeJSONString(canonical, intent.ExpiredColor); err != nil {
			return err
		}
		canonical.WriteByte('}')
	default:
		return fmt.Errorf("%w: intent kind must be move or timeout", ErrInvalidRequest)
	}
	return nil
}

// writeJSONString matches JSON.stringify for the characters a FEN, policy
// version or intent can hold. Inputs are ASCII in every accepted request, but
// the escaping is exact for UTF-8 too so the canonical bytes stay identical.
func writeJSONString(canonical *strings.Builder, value string) error {
	if !utf8.ValidString(value) {
		// JSON.parse would have replaced invalid bytes with U+FFFD before the
		// worker hashed them, so these bytes cannot match any worker digest.
		return fmt.Errorf("%w: input fingerprint contains invalid UTF-8", ErrCorrelation)
	}
	canonical.WriteByte('"')
	for _, character := range value {
		switch character {
		case '"':
			canonical.WriteString(`\"`)
		case '\\':
			canonical.WriteString(`\\`)
		case '\b':
			canonical.WriteString(`\b`)
		case '\f':
			canonical.WriteString(`\f`)
		case '\n':
			canonical.WriteString(`\n`)
		case '\r':
			canonical.WriteString(`\r`)
		case '\t':
			canonical.WriteString(`\t`)
		default:
			switch {
			case character < 0x20:
				fmt.Fprintf(canonical, `\u%04x`, character)
			case character >= 0xD800 && character <= 0xDFFF:
				return fmt.Errorf("%w: input fingerprint contains an unpaired surrogate", ErrCorrelation)
			default:
				canonical.WriteRune(character)
			}
		}
	}
	canonical.WriteByte('"')
	return nil
}
