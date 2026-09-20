package normalize

import (
	"strconv"
	"strings"
	"time"
)

var iso8601Layouts = []string{
	"2006-01-02T15:04:05.999999999Z07:00",
	"2006-01-02T15:04:05Z07:00",
	"2006-01-02T15:04:05.999999999-0700",
	"2006-01-02T15:04:05-0700",
	"2006-01-02T15:04:05.999999999",
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05.999999999",
	"2006-01-02 15:04:05",
}

// isoShaped: every layout starts YYYY-MM-DD and is at least 19 bytes; anything else
// (syslog, epoch) skips eight failing parses and their error allocations.
func isoShaped(s string) bool { return len(s) >= 19 && s[4] == '-' && s[7] == '-' }

// ParseISO8601 parses an ISO 8601 timestamp to epoch milliseconds.
func ParseISO8601(s string) (int64, bool) {
	if !isoShaped(s) {
		return 0, false
	}
	for _, l := range iso8601Layouts {
		if t, err := time.Parse(l, s); err == nil {
			return t.UnixMilli(), true
		}
	}
	return 0, false
}

// ParseISO8601In parses a timestamp that may lack an offset, using loc.
func ParseISO8601In(s string, loc *time.Location) (int64, bool) {
	if !isoShaped(s) {
		return 0, false
	}
	for _, l := range iso8601Layouts {
		if t, err := time.ParseInLocation(l, s, loc); err == nil {
			return t.UnixMilli(), true
		}
	}
	return 0, false
}

// ParseEpoch parses a possibly fractional epoch-seconds timestamp.
func ParseEpoch(s string) (int64, bool) {
	if s == "" || !(s[0] >= '0' && s[0] <= '9' || s[0] == '+' || s[0] == '.') {
		return 0, false
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || f < 1e8 || f > 4e10 {
		return 0, false
	}
	return int64(f * 1000), true
}

// ParseSyslog3164 resolves an RFC 3164 timestamp, which carries neither year
// nor zone. The year comes from receive time with December/January rollover;
// the zone comes from the source registry. Spec §6.7.
func ParseSyslog3164(ts string, recvMS int64, loc *time.Location) (int64, bool) {
	if loc == nil {
		loc = time.UTC
	}
	t, err := time.ParseInLocation("Jan _2 15:04:05", normalizeSyslogTS(ts), loc)
	if err != nil {
		return 0, false
	}
	recv := time.UnixMilli(recvMS).In(loc)
	year := recv.Year()
	switch {
	case t.Month() == time.December && recv.Month() == time.January:
		year--
	case t.Month() == time.January && recv.Month() == time.December:
		year++
	}
	out := time.Date(year, t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), 0, loc)
	return out.UnixMilli(), true
}

// normalizeSyslogTS collapses the space-padded day so Go's parser accepts it.
func normalizeSyslogTS(ts string) string {
	return strings.Join(strings.Fields(ts), " ")
}

func plausibleSyslogTS(ts string) bool {
	_, err := time.Parse("Jan _2 15:04:05", normalizeSyslogTS(ts))
	return err == nil
}

// ParseAny tries every timestamp form and returns epoch milliseconds.
func ParseAny(s string, recvMS int64, loc *time.Location) (int64, bool) {
	if ms, ok := ParseISO8601In(s, loc); ok {
		return ms, true
	}
	if ms, ok := ParseEpoch(s); ok {
		return ms, true
	}
	return ParseSyslog3164(s, recvMS, loc)
}
