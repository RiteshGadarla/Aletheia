// Package envelope detects and splits log wrappers (RFC 3164/5424, CEF, LEEF)
// so the matcher works on a small, predictable body. Spec §6.4, CONTRACTS §2.
//
// Envelopes are themselves templates: the header tokens plus the body template
// reconstruct the entire raw line, header included.
package envelope

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/Ritesh2006M/aletheia/template"
)

// BodySlot is the name of the placeholder slot an envelope reserves for the body.
const BodySlot = "body"

// Envelope template ids.
const (
	IDRFC5424      = "rfc5424_std"
	IDRFC3164Host  = "rfc3164_std"
	IDRFC3164HTag  = "rfc3164_tag"
	IDRFC3164Tag   = "rfc3164_nohost_tag"
	IDRFC3164Plain = "rfc3164_nohost"
	IDPriOnly      = "pri_only"
	IDBare         = "bare"
)

// Body type hints.
const (
	BodyText = "text"
	BodyJSON = "json"
	BodyKV   = "kv"
	BodyCSV  = "csv"
	BodyCEF  = "cef"
	BodyLEEF = "leef"
)

// Result is one decoded envelope.
type Result struct {
	ID            string
	Tokens        []template.Token // header tokens, one of which is the body slot
	Vars          []string         // envelope slot values, body slot included
	BodyTokenIdx  int              // index into Tokens of the body slot
	BodyVarIdx    int              // capture index of the body slot
	BodyStart     int              // byte offset of the body within raw
	BodyEnd       int
	Body          string
	Fields        map[string]string
	Discriminator string
	BodyType      string
	Facility      int // -1 when no PRI
	Severity      int // -1 when no PRI
}

var (
	reSyslogTS = regexp.MustCompile(`^[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}`)
	reTag      = regexp.MustCompile(`^([A-Za-z0-9._-]+)(\[[0-9]+\])?: `)
	reASA      = regexp.MustCompile(`^%[A-Za-z][A-Za-z0-9_-]*-\d+-\d+`)
	reKV       = regexp.MustCompile(`(?:^|[ \t^|])[A-Za-z][A-Za-z0-9_.\-]*=`)
	// RE2 has no backreferences: capture the whole token verbatim, quotes and
	// all, so the discriminator equals the literal a pack declares.
	reLogID = regexp.MustCompile(`(?:^|[ \t])(logid=(?:"[^"]*"|[^" \t]+))`)
)

const tagPattern = `[A-Za-z0-9._-]+(?:\[[0-9]+\])?`
const bodyPattern = `(?s).*`
const sd5424Pattern = `(?:-|(?:\[(?:[^\\\]]|\\.)*\])+)`
const ts5424Pattern = `(?:-|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)`

func lit(s string) template.Token     { return template.Token{Lit: s} }
func slot(n, t string) template.Token { return template.Token{Slot: n, Type: t} }
func custom(n, p string) template.Token {
	return template.Token{Slot: n, Type: template.TypeCustom, Pattern: p}
}

// bodyToken is the placeholder replaced by the matched body template.
func bodyToken() template.Token { return custom(BodySlot, bodyPattern) }

// Decode splits raw into an envelope and a body. It never fails: an
// unrecognised line decodes as a bare envelope whose body is the whole line.
func Decode(raw []byte) Result {
	s := string(raw)

	// Preserve any framing newline as a trailing literal so reconstruction is exact.
	tail := ""
	for strings.HasSuffix(s, "\n") || strings.HasSuffix(s, "\r") {
		tail = s[len(s)-1:] + tail
		s = s[:len(s)-1]
	}

	r := Result{Fields: map[string]string{}, Facility: -1, Severity: -1}
	pos := 0
	var toks []template.Token
	var vars []string

	if pri, n, ok := readPRI(s); ok {
		f, _ := strconv.Atoi(pri)
		r.Facility, r.Severity = f/8, f%8
		r.Fields["pri"] = pri
		toks = append(toks, lit("<"), slot("pri", template.TypeInt), lit(">"))
		vars = append(vars, pri)
		pos = n
		if rest := s[pos:]; strings.HasPrefix(rest, "1 ") {
			return finish(&r, decode5424(&r, s, pos, toks, vars), tail, s)
		}
		if m := reSyslogTS.FindString(s[pos:]); m != "" {
			return finish(&r, decode3164(&r, s, pos, m, toks, vars), tail, s)
		}
		// PRI but no recognised timestamp: everything after > is body.
		r.ID = IDPriOnly
		toks = append(toks, bodyToken())
		vars = append(vars, s[pos:])
		r.BodyStart = pos
		return finish(&r, sub{toks, vars}, tail, s)
	}

	r.ID = IDBare
	toks = append(toks, bodyToken())
	vars = append(vars, s)
	r.BodyStart = 0
	return finish(&r, sub{toks, vars}, tail, s)
}

type sub struct {
	toks []template.Token
	vars []string
}

// finish fills body ranges, the trailing framing literal and the discriminator.
func finish(r *Result, x sub, tail, s string) Result {
	toks, vars := x.toks, x.vars
	if tail != "" {
		toks = append(toks, lit(tail))
	}
	r.Tokens, r.Vars = toks, vars
	r.BodyTokenIdx = -1
	r.BodyVarIdx = -1
	vi := 0
	for i, t := range toks {
		if t.IsLit() {
			continue
		}
		if t.Slot == BodySlot {
			r.BodyTokenIdx, r.BodyVarIdx = i, vi
		}
		vi++
	}
	if r.BodyVarIdx >= 0 {
		r.Body = vars[r.BodyVarIdx]
	}
	r.BodyEnd = r.BodyStart + len(r.Body)
	classify(r)
	return *r
}

// readPRI parses a leading <PRI>. Returns the digits and the offset past '>'.
func readPRI(s string) (string, int, bool) {
	if len(s) < 3 || s[0] != '<' {
		return "", 0, false
	}
	for i := 1; i < len(s) && i <= 4; i++ {
		if s[i] == '>' {
			if i == 1 {
				return "", 0, false
			}
			return s[1:i], i + 1, true
		}
		if s[i] < '0' || s[i] > '9' {
			return "", 0, false
		}
	}
	return "", 0, false
}

// decode3164 handles BSD syslog: <PRI>Mmm dd hh:mm:ss [host ][tag: ]body.
func decode3164(r *Result, s string, pos int, ts string, toks []template.Token, vars []string) sub {
	r.Fields["ts"] = ts
	toks = append(toks, slot("ts", template.TypeSyslogTS))
	vars = append(vars, ts)
	pos += len(ts)
	if pos < len(s) && s[pos] == ' ' {
		toks = append(toks, lit(" "))
		pos++
	}

	hasHost := false
	if m := reTag.FindStringSubmatch(s[pos:]); m == nil {
		// Not a tag here, so this word is the hostname.
		if sp := strings.IndexByte(s[pos:], ' '); sp > 0 {
			host := s[pos : pos+sp]
			if isHostname(host) {
				hasHost = true
				r.Fields["host"] = host
				toks = append(toks, slot("host", template.TypeHostname), lit(" "))
				vars = append(vars, host)
				pos += sp + 1
			}
		}
	}

	hasTag := false
	if m := reTag.FindStringSubmatch(s[pos:]); m != nil {
		hasTag = true
		full := m[0][:len(m[0])-2] // strip ": "
		r.Fields["tag"] = m[1]
		if m[2] != "" {
			r.Fields["pid"] = strings.Trim(m[2], "[]")
		}
		toks = append(toks, custom("tag", tagPattern), lit(": "))
		vars = append(vars, full)
		pos += len(m[0])
	}

	switch {
	case hasHost && hasTag:
		r.ID = IDRFC3164HTag
	case hasHost:
		r.ID = IDRFC3164Host
	case hasTag:
		r.ID = IDRFC3164Tag
	default:
		r.ID = IDRFC3164Plain
	}
	toks = append(toks, bodyToken())
	vars = append(vars, s[pos:])
	r.BodyStart = pos
	return sub{toks, vars}
}

// decode5424 handles <PRI>1 TS HOST APP PROCID MSGID SD [MSG].
func decode5424(r *Result, s string, pos int, toks []template.Token, vars []string) sub {
	r.ID = IDRFC5424
	r.Fields["version"] = "1"
	toks = append(toks, lit("1 "))
	pos += 2

	read := func(name, pattern string) bool {
		sp := strings.IndexByte(s[pos:], ' ')
		if sp < 0 {
			return false
		}
		v := s[pos : pos+sp]
		r.Fields[name] = v
		toks = append(toks, custom(name, pattern), lit(" "))
		vars = append(vars, v)
		pos += sp + 1
		return true
	}
	ok := read("ts5424", ts5424Pattern) && read("host", `\S+`) &&
		read("app", `\S+`) && read("procid", `\S+`) && read("msgid", `\S+`)
	if !ok {
		r.ID = IDPriOnly
		toks = append(toks, bodyToken())
		vars = append(vars, s[pos:])
		r.BodyStart = pos
		return sub{toks, vars}
	}
	r.Fields["ts"] = r.Fields["ts5424"]
	delete(r.Fields, "ts5424")
	// Rename the timestamp slot now that the field map is settled.
	for i := range toks {
		if toks[i].Slot == "ts5424" {
			toks[i].Slot = "ts"
		}
	}

	sd := readSD(s[pos:])
	r.Fields["sd"] = sd
	toks = append(toks, custom("sd", sd5424Pattern))
	vars = append(vars, sd)
	pos += len(sd)
	if pos < len(s) && s[pos] == ' ' {
		toks = append(toks, lit(" "))
		pos++
	}
	toks = append(toks, bodyToken())
	vars = append(vars, s[pos:])
	r.BodyStart = pos
	return sub{toks, vars}
}

// readSD returns the STRUCTURED-DATA field: "-" or one or more [...] elements.
func readSD(s string) string {
	if strings.HasPrefix(s, "-") {
		return "-"
	}
	i := 0
	for i < len(s) && s[i] == '[' {
		j := i + 1
		for j < len(s) {
			if s[j] == '\\' {
				j += 2
				continue
			}
			if s[j] == ']' {
				j++
				break
			}
			j++
		}
		if j > len(s) {
			return s
		}
		i = j
	}
	return s[:i]
}

func isHostname(s string) bool {
	if s == "" || len(s) > 255 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		ok := c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' ||
			c == '.' || c == '_' || c == '-'
		if !ok {
			return false
		}
	}
	return true
}

// Full folds a body token list into the envelope, yielding whole-line tokens.
func (r Result) Full(bodyTokens []template.Token) ([]template.Token, bool) {
	toks, _, ok := template.Splice(r.Tokens, BodySlot, bodyTokens)
	return toks, ok
}

// FullVars interleaves envelope vars with body vars in capture order. A Result
// with no body slot contributes no header captures, so the body vars stand
// alone: nothing on this path may panic (CONTRACTS §10.2).
func (r Result) FullVars(bodyVars []string) []string {
	if r.BodyVarIdx < 0 || r.BodyVarIdx >= len(r.Vars) {
		return append([]string(nil), bodyVars...)
	}
	out := make([]string, 0, len(r.Vars)-1+len(bodyVars))
	out = append(out, r.Vars[:r.BodyVarIdx]...)
	out = append(out, bodyVars...)
	out = append(out, r.Vars[r.BodyVarIdx+1:]...)
	return out
}
