// Package template implements the Aletheia token model: compilation to a fully
// anchored RE2 regexp, byte-exact reconstruction and lineage spans. CONTRACTS §1.
package template

import (
	"fmt"
	"regexp"
	"strings"
)

// Token is one element of a template: either literal bytes or a capture slot.
type Token struct {
	Lit     string   `json:"lit,omitempty"     yaml:"lit,omitempty"`
	Slot    string   `json:"slot,omitempty"    yaml:"slot,omitempty"`
	Type    string   `json:"type,omitempty"    yaml:"type,omitempty"`
	Values  []string `json:"values,omitempty"  yaml:"values,omitempty"`
	Pattern string   `json:"pattern,omitempty" yaml:"pattern,omitempty"`
}

// IsLit reports whether the token is literal bytes.
func (t Token) IsLit() bool { return t.Slot == "" }

// Slot type names. Exact strings from CONTRACTS §1.
const (
	TypeInt      = "int"
	TypePort     = "port"
	TypeIPv4     = "ipv4"
	TypeIPv6     = "ipv6"
	TypeIP       = "ip"
	TypeMAC      = "mac"
	TypeHostname = "hostname"
	TypeSyslogTS = "syslog3164_ts"
	TypeISO8601  = "iso8601_ts"
	TypeEpochTS  = "epoch_ts"
	TypeEnum     = "enum"
	TypeWord     = "word"
	TypeQuoted   = "quoted"
	TypeWS       = "ws"
	TypeText     = "text"
	TypeCustom   = "custom"
)

const (
	patIPv4 = `(?:\d{1,3}\.){3}\d{1,3}`
	patIPv6 = `[0-9A-Fa-f:]{2,45}`
)

var basePatterns = map[string]string{
	TypeInt:      `\d+`,
	TypePort:     `\d{1,5}`,
	TypeIPv4:     patIPv4,
	TypeIPv6:     patIPv6,
	TypeIP:       `(?:` + patIPv4 + `|` + patIPv6 + `)`,
	TypeMAC:      `(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}`,
	TypeHostname: `[A-Za-z0-9._-]+`,
	TypeSyslogTS: `[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}`,
	TypeISO8601:  `\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?`,
	TypeEpochTS:  `\d{9,10}(?:\.\d+)?`,
	TypeWord:     `\S+`,
	TypeQuoted:   `"(?:[^"\\]|\\.)*"`,
	TypeWS:       `[ \t]+`,
	TypeText:     `.*?`,
}

// fixedWidth types always produce the same byte length, so adjacency is unambiguous.
var fixedWidth = map[string]bool{TypeSyslogTS: true, TypeMAC: true}

// noSpace types can never match a space or tab, so they are unambiguous next to ws.
var noSpace = map[string]bool{
	TypeInt: true, TypePort: true, TypeIPv4: true, TypeIPv6: true, TypeIP: true,
	TypeMAC: true, TypeHostname: true, TypeWord: true, TypeEpochTS: true,
}

// Pattern returns the RE2 sub-pattern for a slot token.
func Pattern(t Token) (string, error) {
	switch t.Type {
	case TypeEnum:
		if len(t.Values) == 0 {
			return "", fmt.Errorf("slot %q: enum needs values", t.Slot)
		}
		vs := append([]string(nil), t.Values...)
		// Longest first so the alternation cannot stop at a prefix.
		for i := 1; i < len(vs); i++ {
			for j := i; j > 0 && len(vs[j]) > len(vs[j-1]); j-- {
				vs[j], vs[j-1] = vs[j-1], vs[j]
			}
		}
		q := make([]string, len(vs))
		for i, v := range vs {
			q[i] = regexp.QuoteMeta(v)
		}
		return `(?:` + strings.Join(q, `|`) + `)`, nil
	case TypeCustom:
		if t.Pattern == "" {
			return "", fmt.Errorf("slot %q: custom needs pattern", t.Slot)
		}
		return t.Pattern, nil
	}
	p, ok := basePatterns[t.Type]
	if !ok {
		return "", fmt.Errorf("slot %q: unknown type %q", t.Slot, t.Type)
	}
	return p, nil
}

// enumValues returns the concrete values a slot may take, or nil.
func enumValues(t Token) []string {
	if t.Type == TypeEnum {
		return t.Values
	}
	return nil
}
