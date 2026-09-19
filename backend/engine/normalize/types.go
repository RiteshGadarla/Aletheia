package normalize

import (
	"net"
	"net/netip"
	"strconv"
	"strings"

	"github.com/Ritesh2006M/aletheia/template"
)

// Typed is a validated slot value. Raw always holds the exact byte substring.
type Typed struct {
	Raw   string
	Value any
	Valid bool
}

// Validate coerces a var according to its slot type. Spec §6.7 step 1.
// An invalid value is never dropped: Raw is preserved and Valid is false.
func Validate(tok template.Token, raw string) Typed {
	t := Typed{Raw: raw, Value: raw, Valid: true}
	switch tok.Type {
	case template.TypeInt:
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			t.Valid = false
			return t
		}
		t.Value = n
	case template.TypePort:
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 || n > 65535 {
			t.Valid = false
			return t
		}
		t.Value = n
	case template.TypeIPv4, template.TypeIPv6, template.TypeIP:
		a, err := netip.ParseAddr(raw)
		if err != nil {
			t.Valid = false
			return t
		}
		if tok.Type == template.TypeIPv4 && !a.Is4() {
			t.Valid = false
			return t
		}
		if tok.Type == template.TypeIPv6 && a.Is4() {
			t.Valid = false
			return t
		}
		t.Value = a.String()
	case template.TypeMAC:
		if _, err := net.ParseMAC(raw); err != nil {
			t.Valid = false
			return t
		}
	case template.TypeHostname:
		if raw == "" || len(raw) > 255 {
			t.Valid = false
		}
	case template.TypeSyslogTS:
		if !plausibleSyslogTS(raw) {
			t.Valid = false
		}
	case template.TypeISO8601:
		if _, ok := ParseISO8601(raw); !ok {
			t.Valid = false
		}
	case template.TypeEpochTS:
		f, err := strconv.ParseFloat(raw, 64)
		if err != nil || f < 1e8 || f > 4e10 {
			t.Valid = false
			return t
		}
		t.Value = int64(f * 1000)
	case template.TypeEnum:
		in := false
		for _, v := range tok.Values {
			if v == raw {
				in = true
				break
			}
		}
		t.Valid = in
	}
	return t
}

// Unquote strips one layer of surrounding double quotes for derived values.
// The var itself keeps the quotes, because vars are exact substrings.
func Unquote(s string) string {
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		return s[1 : len(s)-1]
	}
	return s
}

// toIP renders a value as a normalized IP string, "" when it is not an address.
func toIP(s string) string {
	a, err := netip.ParseAddr(strings.TrimSpace(Unquote(s)))
	if err != nil {
		return ""
	}
	return a.String()
}

// netIP converts a string to a *net.IP for the ClickHouse IPv6 columns.
func netIP(s string) *net.IP {
	a, err := netip.ParseAddr(s)
	if err != nil {
		return nil
	}
	ip := net.IP(a.AsSlice())
	if a.Is4() {
		ip = ip.To16()
	}
	return &ip
}
