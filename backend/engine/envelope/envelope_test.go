package envelope

import (
	"testing"

	"github.com/Ritesh2006M/aletheia/template"
)

// TestDecode is the envelope table of spec §9.1-§9.4. Every case also has to
// reconstruct: the header tokens plus their vars must rebuild the raw line
// byte for byte, header included (CONTRACTS §2).
func TestDecode(t *testing.T) {
	cases := []struct {
		name     string
		raw      string
		wantID   string
		wantBody string
		wantType string
		wantSev  int
		wantFac  int
		fields   map[string]string
		disc     string
	}{
		{
			name:     "rfc3164_with_host",
			raw:      `<166>Sep 19 14:31:02 fw01 %ASA-6-302013: Built outbound TCP connection 1234`,
			wantID:   IDRFC3164Host,
			wantBody: `%ASA-6-302013: Built outbound TCP connection 1234`,
			wantType: BodyText, wantSev: 6, wantFac: 20,
			fields: map[string]string{"pri": "166", "ts": "Sep 19 14:31:02", "host": "fw01"},
			disc:   "%ASA-6-302013",
		},
		{
			// RFC 3164 pads a single-digit day with a space: "Sep  9", two
			// spaces after the month. The timestamp slot has to keep both.
			name:     "rfc3164_space_padded_single_digit_day",
			raw:      `<166>Sep  9 04:05:06 %ASA-6-302013: Built inbound TCP connection 9876`,
			wantID:   IDRFC3164Plain,
			wantBody: `%ASA-6-302013: Built inbound TCP connection 9876`,
			wantType: BodyText, wantSev: 6, wantFac: 20,
			fields: map[string]string{"pri": "166", "ts": "Sep  9 04:05:06"},
			disc:   "%ASA-6-302013",
		},
		{
			name:     "rfc3164_padded_day_with_host",
			raw:      `<134>Jan  1 00:00:00 fw01 something happened`,
			wantID:   IDRFC3164Host,
			wantBody: `something happened`,
			wantType: BodyText, wantSev: 6, wantFac: 16,
			fields: map[string]string{"ts": "Jan  1 00:00:00", "host": "fw01"},
		},
		{
			name:     "rfc3164_host_and_tag_with_pid",
			raw:      `<29>Sep 19 14:31:02 vpn01 openvpn[812]: user 'analyst' authenticated`,
			wantID:   IDRFC3164HTag,
			wantBody: `user 'analyst' authenticated`,
			wantType: BodyText, wantSev: 5, wantFac: 3,
			fields: map[string]string{"host": "vpn01", "tag": "openvpn", "pid": "812"},
			disc:   "tag:openvpn",
		},
		{
			name:     "rfc3164_tag_without_host",
			raw:      `<134>Sep 19 14:31:02 filterlog[1234]: 5,,,1000000103,em0,match,block,in,4`,
			wantID:   IDRFC3164Tag,
			wantBody: `5,,,1000000103,em0,match,block,in,4`,
			wantType: BodyCSV, wantSev: 6, wantFac: 16,
			fields: map[string]string{"tag": "filterlog", "pid": "1234"},
			disc:   "tag:filterlog",
		},
		{
			name:     "rfc5424",
			raw:      `<165>1 2026-09-19T14:31:02.123+05:30 edge-rtr01 sshd 812 ID47 [meta sequenceId="29"] message text`,
			wantID:   IDRFC5424,
			wantBody: `message text`,
			wantType: BodyText, wantSev: 5, wantFac: 20,
			fields: map[string]string{
				"version": "1", "ts": "2026-09-19T14:31:02.123+05:30", "host": "edge-rtr01",
				"app": "sshd", "procid": "812", "msgid": "ID47",
				"sd": `[meta sequenceId="29"]`,
			},
			disc: "app:sshd",
		},
		{
			name:     "rfc5424_nil_structured_data",
			raw:      `<13>1 2026-09-19T14:31:02Z host app - - - plain message`,
			wantID:   IDRFC5424,
			wantBody: `plain message`,
			wantType: BodyText, wantSev: 5, wantFac: 1,
			fields: map[string]string{"sd": "-", "procid": "-", "msgid": "-", "app": "app"},
		},
		{
			name:     "cef_bare",
			raw:      `CEF:0|VendorX|NGFW|4.2|1001|Connection allowed|3|src=10.0.0.5 spt=52144`,
			wantID:   IDBare,
			wantBody: `CEF:0|VendorX|NGFW|4.2|1001|Connection allowed|3|src=10.0.0.5 spt=52144`,
			wantType: BodyCEF, wantSev: -1, wantFac: -1,
			fields: map[string]string{"cef_vendor": "VendorX", "cef_product": "NGFW",
				"cef_signature_id": "1001", "cef_severity": "3", "cef_version": "0"},
			disc: "CEF:VendorX|NGFW|1001",
		},
		{
			name:     "cef_inside_syslog",
			raw:      `<134>Sep 19 14:31:02 siem01 CEF:0|VendorX|NGFW|4.2|1002|Connection denied|7|src=10.0.0.9`,
			wantID:   IDRFC3164Host,
			wantBody: `CEF:0|VendorX|NGFW|4.2|1002|Connection denied|7|src=10.0.0.9`,
			wantType: BodyCEF, wantSev: 6, wantFac: 16,
			fields: map[string]string{"host": "siem01", "cef_signature_id": "1002"},
			disc:   "CEF:VendorX|NGFW|1002",
		},
		{
			name:     "leef_2_with_caret_delimiter",
			raw:      `LEEF:2.0|VendorY|WAF|3.1|BLOCK|^|src=10.0.0.5^dst=203.0.113.9`,
			wantID:   IDBare,
			wantBody: `LEEF:2.0|VendorY|WAF|3.1|BLOCK|^|src=10.0.0.5^dst=203.0.113.9`,
			wantType: BodyLEEF, wantSev: -1, wantFac: -1,
			fields: map[string]string{"leef_vendor": "VendorY", "leef_event_id": "BLOCK",
				"leef_delimiter": "^", "leef_version": "2.0"},
			disc: "LEEF:VendorY|WAF|BLOCK",
		},
		{
			name:     "leef_1_tab_delimited",
			raw:      "LEEF:1.0|VendorY|FW|2.0|ACCEPT|src=10.0.0.5\tdst=203.0.113.9",
			wantID:   IDBare,
			wantBody: "LEEF:1.0|VendorY|FW|2.0|ACCEPT|src=10.0.0.5\tdst=203.0.113.9",
			wantType: BodyLEEF, wantSev: -1, wantFac: -1,
			fields: map[string]string{"leef_event_id": "ACCEPT", "leef_delimiter": "\t"},
			disc:   "LEEF:VendorY|FW|ACCEPT",
		},
		{
			name:     "pri_only_key_value",
			raw:      `<189>date=2026-09-19 time=14:31:02 devname="FGT-EDGE" logid="0000000013" type="traffic"`,
			wantID:   IDPriOnly,
			wantBody: `date=2026-09-19 time=14:31:02 devname="FGT-EDGE" logid="0000000013" type="traffic"`,
			wantType: BodyKV, wantSev: 5, wantFac: 23,
			fields: map[string]string{"pri": "189"},
			disc:   `logid="0000000013"`,
		},
		{
			name:     "bare_squid_line",
			raw:      `1789828262.123    245 10.0.0.5 TCP_TUNNEL/200 5120 CONNECT example.com:443 - HIER_DIRECT/93.184.216.34 -`,
			wantID:   IDBare,
			wantBody: `1789828262.123    245 10.0.0.5 TCP_TUNNEL/200 5120 CONNECT example.com:443 - HIER_DIRECT/93.184.216.34 -`,
			wantType: BodyText, wantSev: -1, wantFac: -1,
		},
		{
			name:     "bare_json",
			raw:      `{"timestamp":"2026-09-19T14:31:02.123456+0530","event_type":"alert"}`,
			wantID:   IDBare,
			wantBody: `{"timestamp":"2026-09-19T14:31:02.123456+0530","event_type":"alert"}`,
			wantType: BodyJSON, wantSev: -1, wantFac: -1,
			disc: "json",
		},
		{
			name: "empty_line_is_still_an_envelope", raw: "",
			wantID: IDBare, wantBody: "", wantType: BodyText, wantSev: -1, wantFac: -1,
		},
		{
			// A leading '<' that is not a PRI must not be mistaken for one.
			name: "angle_bracket_is_not_a_pri", raw: `<GroupPolicy> user denied`,
			wantID: IDBare, wantBody: `<GroupPolicy> user denied`,
			wantType: BodyText, wantSev: -1, wantFac: -1,
		},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			r := Decode([]byte(c.raw))
			if r.ID != c.wantID {
				t.Errorf("envelope id = %q, want %q", r.ID, c.wantID)
			}
			if r.Body != c.wantBody {
				t.Errorf("body = %q, want %q", r.Body, c.wantBody)
			}
			if r.BodyType != c.wantType {
				t.Errorf("body type = %q, want %q", r.BodyType, c.wantType)
			}
			if r.Severity != c.wantSev || r.Facility != c.wantFac {
				t.Errorf("facility/severity = %d/%d, want %d/%d",
					r.Facility, r.Severity, c.wantFac, c.wantSev)
			}
			if c.disc != "" && r.Discriminator != c.disc {
				t.Errorf("discriminator = %q, want %q", r.Discriminator, c.disc)
			}
			for k, want := range c.fields {
				if got := r.Fields[k]; got != want {
					t.Errorf("field %q = %q, want %q", k, got, want)
				}
			}
			if c.raw[r.BodyStart:r.BodyEnd] != r.Body {
				t.Errorf("body span [%d,%d) quotes %q, body is %q",
					r.BodyStart, r.BodyEnd, c.raw[r.BodyStart:r.BodyEnd], r.Body)
			}
			assertRebuilds(t, r, c.raw)
		})
	}
}

// TestDecodeKeepsFraming pins that a trailing newline survives as a literal, so
// framed input still reconstructs byte for byte.
func TestDecodeKeepsFraming(t *testing.T) {
	for _, raw := range []string{
		"<166>Sep 19 14:31:02 fw01 hello\n",
		"<166>Sep 19 14:31:02 fw01 hello\r\n",
		"bare line\n",
	} {
		r := Decode([]byte(raw))
		if r.Body == "" {
			t.Fatalf("%q: empty body", raw)
		}
		assertRebuilds(t, r, raw)
	}
}

// TestFullAndFullVars folds a body template into the decoded envelope and
// checks the whole line still reconstructs.
func TestFullAndFullVars(t *testing.T) {
	raw := `<166>Sep 19 14:31:02 fw01 built 1234 ok`
	r := Decode([]byte(raw))
	body := []template.Token{
		{Lit: "built "}, {Slot: "id", Type: template.TypeInt}, {Lit: " ok"},
	}
	full, ok := r.Full(body)
	if !ok {
		t.Fatal("Full: the envelope has no body slot")
	}
	tpl, err := template.Compile("full", full)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	vars, matched := tpl.Match([]byte(raw))
	if !matched {
		t.Fatalf("the spliced whole-line template did not match %q", raw)
	}
	got, err := template.Reconstruct(full, vars)
	if err != nil || string(got) != raw {
		t.Fatalf("reconstruct = %q, %v", got, err)
	}
	if fv := r.FullVars([]string{"1234"}); len(fv) != len(r.Vars) {
		t.Fatalf("FullVars produced %d vars, want %d", len(fv), len(r.Vars))
	}
	// A Result with no body slot must degrade, not panic: the hot path has no
	// exception route (CONTRACTS §10.2).
	empty := Result{BodyVarIdx: -1}
	if got := empty.FullVars([]string{"a", "b"}); len(got) != 2 {
		t.Fatalf("FullVars on a bodyless envelope = %q, want the body vars alone", got)
	}
	if got := (Result{}).FullVars(nil); len(got) != 0 {
		t.Fatalf("FullVars on a zero Result = %q, want empty", got)
	}
}

// TestParseCEF covers header splitting, including escaped pipes in the name.
func TestParseCEF(t *testing.T) {
	cases := []struct {
		name, in                           string
		version, vendor, product, sig, sev string
	}{
		{"plain", `CEF:0|VendorX|NGFW|4.2|1001|Connection allowed|3|src=10.0.0.5`,
			"0", "VendorX", "NGFW", "1001", "3"},
		{"escaped_pipe_in_name", `CEF:0|V|P|1.0|42|allow\|log|5|src=10.0.0.5`,
			"0", "V", "P", "42", "5"},
		{"no_extension", `CEF:0|V|P|1.0|42|name|5|`, "0", "V", "P", "42", "5"},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			h := ParseCEF(c.in)
			if h.Version != c.version || h.Vendor != c.vendor || h.Product != c.product ||
				h.SignatureID != c.sig || h.Severity != c.sev {
				t.Fatalf("header = %+v", h)
			}
		})
	}
}

// TestParseLEEF covers the LEEF 2.0 delimiter field, which decides how the
// attribute run is split and therefore which pack template can match.
func TestParseLEEF(t *testing.T) {
	cases := []struct {
		name, in                       string
		version, eventID, delim, attrs string
	}{
		{"leef_1_defaults_to_tab", "LEEF:1.0|V|P|2.0|ACCEPT|src=10.0.0.5\tdst=1.2.3.4",
			"1.0", "ACCEPT", "\t", "src=10.0.0.5\tdst=1.2.3.4"},
		{"leef_2_caret", `LEEF:2.0|V|P|3.1|BLOCK|^|src=10.0.0.5^dst=1.2.3.4`,
			"2.0", "BLOCK", "^", "src=10.0.0.5^dst=1.2.3.4"},
		{"leef_2_hex_delimiter", `LEEF:2.0|V|P|3.1|BLOCK|x09|src=10.0.0.5`,
			"2.0", "BLOCK", "\t", "src=10.0.0.5"},
		{"leef_2_0x_delimiter", `LEEF:2.0|V|P|3.1|BLOCK|0x7c|src=10.0.0.5`,
			"2.0", "BLOCK", "|", "src=10.0.0.5"},
		{"leef_2_without_delimiter_field", "LEEF:2.0|V|P|3.1|BLOCK|src=10.0.0.5\tdst=1.2.3.4",
			"2.0", "BLOCK", "\t", "src=10.0.0.5\tdst=1.2.3.4"},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			h := ParseLEEF(c.in)
			if h.Version != c.version || h.EventID != c.eventID ||
				h.Delimiter != c.delim || h.Attrs != c.attrs {
				t.Fatalf("header = %+v", h)
			}
		})
	}
}

// assertRebuilds checks the decoded envelope reconstructs the raw line exactly.
func assertRebuilds(t *testing.T, r Result, raw string) {
	t.Helper()
	got, err := template.Reconstruct(r.Tokens, r.Vars)
	if err != nil {
		t.Fatalf("reconstruct: %v", err)
	}
	if string(got) != raw {
		t.Fatalf("envelope does not reconstruct\n want %q\n got  %q", raw, got)
	}
	if r.BodyVarIdx < 0 || r.BodyTokenIdx < 0 {
		t.Fatalf("decoded envelope has no body slot: %+v", r.Tokens)
	}
	if err := template.Validate(r.Tokens); err != nil {
		t.Fatalf("decoded envelope is not a legal template: %v", err)
	}
}
