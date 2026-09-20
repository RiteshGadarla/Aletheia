package normalize

import (
	"testing"
	"time"

	"github.com/Ritesh2006M/aletheia/envelope"
	"github.com/Ritesh2006M/aletheia/registry"
	"github.com/Ritesh2006M/aletheia/template"
)

const recvMS = int64(1789828262123) // 2026-09-19T14:31:02.123Z

// TestSeverityFromPRI pins the syslog PRI mod 8 to OCSF severity_id table of
// CONTRACTS §5 across every facility, not just facility 0.
func TestSeverityFromPRI(t *testing.T) {
	want := map[int]int{0: 6, 1: 6, 2: 5, 3: 4, 4: 3, 5: 2, 6: 1, 7: 1}
	for facility := 0; facility < 24; facility++ {
		for sev := 0; sev < 8; sev++ {
			pri := facility*8 + sev
			if got := Default.SeverityFromPRI(pri); got != want[sev] {
				t.Errorf("PRI %d (facility %d, severity %d) -> %d, want %d",
					pri, facility, sev, got, want[sev])
			}
		}
	}
	// A few concrete PRIs from the golden corpus.
	for pri, wantSev := range map[int]int{166: 1, 164: 3, 134: 1, 29: 2, 189: 2, 13: 2} {
		if got := Default.SeverityFromPRI(pri); got != wantSev {
			t.Errorf("PRI %d -> severity_id %d, want %d", pri, got, wantSev)
		}
	}
}

// TestCategoryUID pins the class-to-category table of CONTRACTS §5 and the
// divide-by-1000 fallback for classes the table does not list.
func TestCategoryUID(t *testing.T) {
	cases := map[int]int{4001: 4, 4002: 4, 4003: 4, 3002: 3, 2004: 2, 4004: 4, 1001: 1}
	for class, want := range cases {
		if got := Default.CategoryUID(class); got != want {
			t.Errorf("class %d -> category %d, want %d", class, got, want)
		}
	}
}

// TestActionID pins the canonical action word table of CONTRACTS §5.
func TestActionID(t *testing.T) {
	cases := map[string]int{
		"allow": 1, "allowed": 1, "accept": 1, "ACCEPT": 1, "permit": 1, "pass": 1,
		"deny": 2, "denied": 2, "drop": 2, "Block": 2, "reject": 2, `"blocked"`: 2,
		"teardown": 0, "": 0,
	}
	for word, want := range cases {
		if got := Default.ActionID(word); got != want {
			t.Errorf("ActionID(%q) = %d, want %d", word, got, want)
		}
	}
}

// TestTypeUIDInvariant is CONTRACTS §5: type_uid = class_uid*100 + activity_id,
// and category_uid follows the class, on every normalized event.
func TestTypeUIDInvariant(t *testing.T) {
	cases := []struct {
		name     string
		class    int
		activity int
		wantType int
		wantCat  int
	}{
		{"network_activity_open", 4001, 1, 400101, 4},
		{"network_activity_close", 4001, 5, 400105, 4},
		{"http_activity", 4002, 2, 400202, 4},
		{"dns_activity", 4003, 6, 400306, 4},
		{"authentication", 3002, 1, 300201, 3},
		{"detection_finding", 2004, 1, 200401, 2},
		{"no_template_match", 0, 0, 0, 0},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			in := input(c.class, c.activity)
			if c.name == "no_template_match" {
				in.Template, in.Vars = nil, nil
			}
			res := Normalize(in)
			if got := res.Event["type_uid"]; got != c.wantType {
				t.Errorf("type_uid = %v, want %d", got, c.wantType)
			}
			if got := res.Event["class_uid"]; got != c.class {
				t.Errorf("class_uid = %v, want %d", got, c.class)
			}
			if got := res.Event["activity_id"]; got != c.activity {
				t.Errorf("activity_id = %v, want %d", got, c.activity)
			}
			if got := res.Event["category_uid"]; got != c.wantCat {
				t.Errorf("category_uid = %v, want %d", got, c.wantCat)
			}
		})
	}
}

// TestNormalizeProvenance pins the required blocks of CONTRACTS §5: epoch
// millisecond time, the original timestamp string, and the aletheia block.
func TestNormalizeProvenance(t *testing.T) {
	in := input(4001, 1)
	res := Normalize(in)

	if _, ok := res.Event["time"].(int64); !ok {
		t.Fatalf("time = %T, want int64 epoch milliseconds", res.Event["time"])
	}
	md := res.Event["metadata"].(map[string]any)
	if md["original_time"] != "Sep  9 04:05:06" {
		t.Errorf("metadata.original_time = %v, want the raw timestamp string", md["original_time"])
	}
	if md["version"] != OCSFVersion {
		t.Errorf("metadata.version = %v, want %s", md["version"], OCSFVersion)
	}
	al := res.Event["aletheia"].(map[string]any)
	for _, k := range []string{"event_uid", "source_id", "parse_status", "storage_mode",
		"template_id", "pack", "pack_version", "raw_sha256", "verified", "merkle_batch"} {
		if _, ok := al[k]; !ok {
			t.Errorf("aletheia block is missing %q", k)
		}
	}
	if al["parse_status"] != StatusFull {
		t.Errorf("parse_status = %v, want %s", al["parse_status"], StatusFull)
	}
	if al["storage_mode"] != ModeTemplate {
		t.Errorf("storage_mode = %v, want %s", al["storage_mode"], ModeTemplate)
	}
	if len(al["raw_sha256"].(string)) != 64 {
		t.Errorf("raw_sha256 = %v, want 64 hex characters", al["raw_sha256"])
	}
	// `unmapped` is string-valued and carries the exact substrings (CONTRACTS §10.6).
	um := res.Event["unmapped"].(map[string]string)
	if um["conn_id"] != "9876" {
		t.Errorf("unmapped.conn_id = %q, want the exact substring \"9876\"", um["conn_id"])
	}
}

// TestNormalizeRawOnly: nothing matched, so the record is still complete.
func TestNormalizeRawOnly(t *testing.T) {
	in := input(0, 0)
	in.Template, in.Vars = nil, nil
	in.StorageMode = ModeVerbatim
	res := Normalize(in)
	if res.ParseStatus != StatusRawOnly {
		t.Errorf("parse_status = %q, want %s", res.ParseStatus, StatusRawOnly)
	}
	if res.Row.StorageMode != ModeVerbatim {
		t.Errorf("storage_mode = %q, want %s", res.Row.StorageMode, ModeVerbatim)
	}
	if res.Event["type_uid"] != 0 {
		t.Errorf("type_uid = %v, want 0", res.Event["type_uid"])
	}
}

// TestValidateTypes covers slot coercion: an invalid value is never dropped,
// the exact substring survives in Raw (CONTRACTS §10.6).
func TestValidateTypes(t *testing.T) {
	cases := []struct {
		name      string
		tok       template.Token
		raw       string
		wantValid bool
		wantValue any
	}{
		{"int", template.Token{Type: template.TypeInt}, "1234", true, int64(1234)},
		{"int_not_a_number", template.Token{Type: template.TypeInt}, "12x", false, nil},
		{"port", template.Token{Type: template.TypePort}, "52144", true, 52144},
		{"port_out_of_range", template.Token{Type: template.TypePort}, "70000", false, nil},
		{"ipv4", template.Token{Type: template.TypeIPv4}, "10.0.0.5", true, "10.0.0.5"},
		{"ipv4_octet_too_large", template.Token{Type: template.TypeIPv4}, "10.0.0.300", false, nil},
		{"ipv6_in_an_ipv4_slot", template.Token{Type: template.TypeIPv4}, "2001:db8::1", false, nil},
		{"ip_accepts_v6", template.Token{Type: template.TypeIP}, "2001:db8::1", true, "2001:db8::1"},
		{"mac", template.Token{Type: template.TypeMAC}, "00:1b:44:11:3a:b7", true, nil},
		{"mac_too_short", template.Token{Type: template.TypeMAC}, "00:1b:44:11:3a", false, nil},
		{"syslog_ts_padded_day", template.Token{Type: template.TypeSyslogTS}, "Sep  9 04:05:06", true, nil},
		{"syslog_ts_nonsense", template.Token{Type: template.TypeSyslogTS}, "Sep 99 04:05:06", false, nil},
		{"epoch", template.Token{Type: template.TypeEpochTS}, "1789828262.123", true, int64(1789828262123)},
		{"epoch_too_small", template.Token{Type: template.TypeEpochTS}, "123", false, nil},
		{"enum_member", template.Token{Type: template.TypeEnum, Values: []string{"in", "out"}}, "in", true, nil},
		{"enum_outsider", template.Token{Type: template.TypeEnum, Values: []string{"in", "out"}}, "sideways", false, nil},
		{"word_is_always_valid", template.Token{Type: template.TypeWord}, "whatever", true, nil},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			got := Validate(c.tok, c.raw)
			if got.Valid != c.wantValid {
				t.Fatalf("Valid = %v, want %v", got.Valid, c.wantValid)
			}
			if got.Raw != c.raw {
				t.Fatalf("Raw = %q, want the exact substring %q", got.Raw, c.raw)
			}
			if c.wantValue != nil && got.Value != c.wantValue {
				t.Fatalf("Value = %#v, want %#v", got.Value, c.wantValue)
			}
		})
	}
}

// TestTimestampParsing covers the three timestamp families the packs use,
// including the RFC 3164 year inference and its December/January rollover.
func TestTimestampParsing(t *testing.T) {
	utc := time.UTC
	cases := []struct {
		name string
		ts   string
		recv int64
		want string // RFC3339 in UTC
	}{
		{"iso8601_with_offset", "2026-09-19T14:31:02.123+05:30", recvMS, "2026-09-19T09:01:02Z"},
		{"iso8601_zulu", "2026-09-19T14:31:02Z", recvMS, "2026-09-19T14:31:02Z"},
		{"iso8601_space_separator", "2026-09-19 14:31:02", recvMS, "2026-09-19T14:31:02Z"},
		{"epoch_seconds", "1789828262.123", recvMS, "2026-09-19T14:31:02Z"},
		{"syslog_padded_day", "Sep  9 04:05:06", recvMS, "2026-09-09T04:05:06Z"},
		{"syslog_same_year", "Sep 19 14:31:02", recvMS, "2026-09-19T14:31:02Z"},
		{"syslog_december_seen_in_january", "Dec 31 23:59:59",
			mustMS("2027-01-01T00:00:01Z"), "2026-12-31T23:59:59Z"},
		{"syslog_january_seen_in_december", "Jan  1 00:00:01",
			mustMS("2026-12-31T23:59:59Z"), "2027-01-01T00:00:01Z"},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			ms, ok := ParseAny(c.ts, c.recv, utc)
			if !ok {
				t.Fatalf("ParseAny(%q) failed", c.ts)
			}
			if got := time.UnixMilli(ms).UTC().Format(time.RFC3339); got != c.want {
				t.Fatalf("ParseAny(%q) = %s, want %s", c.ts, got, c.want)
			}
		})
	}
	if _, ok := ParseAny("not a timestamp", recvMS, utc); ok {
		t.Error("ParseAny accepted junk")
	}
}

// TestUnparsableTimestampIsPartial: the event still lands, downgraded, with the
// original string preserved and the fallback to receive time recorded.
func TestUnparsableTimestampIsPartial(t *testing.T) {
	in := input(4001, 1)
	in.Envelope.Fields["ts"] = "Feb 30 99:99:99"
	res := Normalize(in)
	if res.ParseStatus != StatusPartial {
		t.Fatalf("parse_status = %q, want %s", res.ParseStatus, StatusPartial)
	}
	if res.EventTimeMS != recvMS {
		t.Errorf("event time = %d, want the receive time %d", res.EventTimeMS, recvMS)
	}
	md := res.Event["metadata"].(map[string]any)
	if md["original_time"] != "Feb 30 99:99:99" {
		t.Errorf("original_time = %v, want the unparsable string kept verbatim", md["original_time"])
	}
	if um := res.Event["unmapped"].(map[string]string); um["time_source"] != "recv_time" {
		t.Errorf("unmapped.time_source = %q, want recv_time", um["time_source"])
	}
}

// input builds a minimal ASA-shaped normalizer input for the given OCSF class.
func input(classUID, activityID int) Input {
	toks := []template.Token{
		{Lit: "%ASA-6-302013: Built "},
		{Slot: "direction", Type: template.TypeEnum, Values: []string{"inbound", "outbound"}},
		{Lit: " TCP connection "},
		{Slot: "conn_id", Type: template.TypeInt},
		{Lit: " for "},
		{Slot: "ip_a", Type: template.TypeIP},
		{Lit: "/"},
		{Slot: "port_a", Type: template.TypePort},
	}
	td := &registry.TemplateDef{
		ID: "asa_302013", Pack: "cisco_asa", PackVersion: 1,
		Body: toks,
		OCSF: registry.OCSF{
			ClassUID: classUID, ActivityID: activityID,
			Map: map[string]registry.Targets{
				"ip_a":   {{Path: "src_endpoint.ip"}},
				"port_a": {{Path: "src_endpoint.port", Transform: "to_int"}},
			},
		},
	}
	return Input{
		EventUID: "01M2XFYG276EPYZ1XBJB38V6RB", SourceID: "asa", RecvMS: recvMS,
		Verified: true, MerkleBatch: "asa/p0/2026-09-19T14:31Z",
		Envelope: envelope.Result{
			ID: envelope.IDRFC3164Plain, Facility: 20, Severity: 6,
			Fields: map[string]string{"pri": "166", "ts": "Sep  9 04:05:06"},
		},
		Template: td,
		Vars:     []string{"inbound", "9876", "198.51.100.9", "51514"},
		Source:   &registry.Source{SourceID: "asa", Timezone: "UTC"},
		Enums:    Default,
	}
}

func mustMS(rfc3339 string) int64 {
	t, err := time.Parse(time.RFC3339, rfc3339)
	if err != nil {
		panic(err)
	}
	return t.UnixMilli()
}
