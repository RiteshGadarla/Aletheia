// Package normalize turns template vars into typed OCSF fields. Spec §6.7, §10.
package normalize

import (
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// OCSFVersion is the pinned OCSF schema version reported in metadata.
const OCSFVersion = "1.3.0"

// Parse status values (CONTRACTS §5).
const (
	StatusFull    = "full"
	StatusPartial = "partial"
	StatusRawOnly = "raw_only"
)

// Storage modes (CONTRACTS §5).
const (
	ModeTemplate = "template"
	ModeVerbatim = "verbatim"
)

// Enums mirrors backend/ocsf/enums.yaml, shared by engine and studio.
type Enums struct {
	Action      map[int][]string `yaml:"action"`
	SyslogSev   map[int]int      `yaml:"syslog_severity"`
	Category    map[int]int      `yaml:"category"`
	ProtocolNum map[int]string   `yaml:"protocol_num"`

	actionByWord map[string]int
}

// Default is the compiled-in copy of the canonical enum table.
var Default = mustIndex(&Enums{
	Action: map[int][]string{
		1: {"allow", "allowed", "accept", "accepted", "permit", "permitted", "pass", "passed"},
		2: {"deny", "denied", "drop", "dropped", "block", "blocked", "reject", "rejected"},
	},
	SyslogSev:   map[int]int{0: 6, 1: 6, 2: 5, 3: 4, 4: 3, 5: 2, 6: 1, 7: 1},
	Category:    map[int]int{4001: 4, 4002: 4, 4003: 4, 3002: 3, 2004: 2},
	ProtocolNum: map[int]string{1: "icmp", 6: "tcp", 17: "udp", 47: "gre", 50: "esp", 58: "ipv6-icmp"},
})

func mustIndex(e *Enums) *Enums {
	e.actionByWord = map[string]int{}
	for id, words := range e.Action {
		for _, w := range words {
			e.actionByWord[strings.ToLower(w)] = id
		}
	}
	return e
}

// LoadEnums reads backend/ocsf/enums.yaml, overriding the compiled-in copy.
func LoadEnums(path string) (*Enums, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var e Enums
	if err := yaml.Unmarshal(data, &e); err != nil {
		return nil, err
	}
	return mustIndex(&e), nil
}

// ActionID resolves a vendor action word to an OCSF action_id, 0 if unknown.
func (e *Enums) ActionID(word string) int {
	return e.actionByWord[strings.ToLower(strings.Trim(word, `"`))]
}

// SeverityFromPRI maps syslog PRI to an OCSF severity_id.
func (e *Enums) SeverityFromPRI(pri int) int {
	if v, ok := e.SyslogSev[pri%8]; ok {
		return v
	}
	return 1
}

// CategoryUID maps an OCSF class to its category.
func (e *Enums) CategoryUID(classUID int) int {
	if v, ok := e.Category[classUID]; ok {
		return v
	}
	return classUID / 1000
}

// ProtocolName maps an IANA protocol number to a name, "" if unknown.
func (e *Enums) ProtocolName(num int) string { return e.ProtocolNum[num] }
