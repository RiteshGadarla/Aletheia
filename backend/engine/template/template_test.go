package template

import (
	"regexp"
	"strings"
	"testing"
)

func lit(s string) Token     { return Token{Lit: s} }
func slot(n, t string) Token { return Token{Slot: n, Type: t} }
func enum(n string, v ...string) Token {
	return Token{Slot: n, Type: TypeEnum, Values: v}
}

// TestPatternTable pins the RE2 sub-pattern emitted per slot type (CONTRACTS §1).
func TestPatternTable(t *testing.T) {
	cases := []struct {
		tok  Token
		want string
	}{
		{slot("a", TypeInt), `\d+`},
		{slot("a", TypePort), `\d{1,5}`},
		{slot("a", TypeIPv4), `(?:\d{1,3}\.){3}\d{1,3}`},
		{slot("a", TypeIPv6), `[0-9A-Fa-f:]{2,45}`},
		{slot("a", TypeIP), `(?:(?:\d{1,3}\.){3}\d{1,3}|[0-9A-Fa-f:]{2,45})`},
		{slot("a", TypeMAC), `(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}`},
		{slot("a", TypeHostname), `[A-Za-z0-9._-]+`},
		{slot("a", TypeSyslogTS), `[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}`},
		{slot("a", TypeEpochTS), `\d{9,10}(?:\.\d+)?`},
		{slot("a", TypeWord), `\S+`},
		{slot("a", TypeQuoted), `"(?:[^"\\]|\\.)*"`},
		{slot("a", TypeWS), `[ \t]+`},
		{slot("a", TypeText), `.*?`},
		{Token{Slot: "a", Type: TypeCustom, Pattern: `[A-Z]+`}, `[A-Z]+`},
	}
	for _, c := range cases {
		c := c
		t.Run(c.tok.Type, func(t *testing.T) {
			got, err := Pattern(c.tok)
			if err != nil {
				t.Fatalf("Pattern: %v", err)
			}
			if got != c.want {
				t.Fatalf("pattern = %q, want %q", got, c.want)
			}
			if _, err := regexp.Compile(got); err != nil {
				t.Fatalf("pattern does not compile under RE2: %v", err)
			}
		})
	}
}

// TestEnumLongestFirst pins that the alternation cannot stop at a prefix.
func TestEnumLongestFirst(t *testing.T) {
	got, err := Pattern(enum("act", "deny", "deny-and-log", "ok"))
	if err != nil {
		t.Fatalf("Pattern: %v", err)
	}
	if want := `(?:deny-and-log|deny|ok)`; got != want {
		t.Fatalf("pattern = %q, want %q", got, want)
	}
	tpl, err := Compile("t", []Token{enum("act", "deny", "deny-and-log"), lit("!")})
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	vars, ok := tpl.Match([]byte("deny-and-log!"))
	if !ok || vars[0] != "deny-and-log" {
		t.Fatalf("matched %q ok=%v, want the longest value", vars, ok)
	}
}

// TestPatternErrors covers the slot types that cannot be compiled bare.
func TestPatternErrors(t *testing.T) {
	cases := []struct {
		name string
		tok  Token
	}{
		{"enum_without_values", slot("a", TypeEnum)},
		{"custom_without_pattern", slot("a", TypeCustom)},
		{"unknown_type", slot("a", "tribble")},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			if _, err := Pattern(c.tok); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

// TestValidate is the compiler gate of CONTRACTS §1: ambiguous slot pairs and
// an unbounded `text` slot are rejected before a template can ever match.
func TestValidate(t *testing.T) {
	cases := []struct {
		name    string
		toks    []Token
		wantErr string // substring, "" means the template must be accepted
	}{
		{"empty", nil, "empty token list"},
		{"literal_only", []Token{lit("hello")}, ""},
		{"slot_lit_slot", []Token{slot("a", TypeIP), lit(":"), slot("b", TypePort)}, ""},

		// --- two adjacent non-fixed-width slots are ambiguous ---------------
		{"adjacent_word_word", []Token{slot("a", TypeWord), slot("b", TypeWord)}, "ambiguous"},
		{"adjacent_int_int", []Token{slot("a", TypeInt), slot("b", TypeInt)}, "ambiguous"},
		{"adjacent_ip_port", []Token{slot("a", TypeIP), slot("b", TypePort)}, "ambiguous"},
		{"adjacent_text_quoted", []Token{slot("a", TypeText), slot("b", TypeQuoted)}, "must be followed by a literal"},
		{"adjacent_quoted_word", []Token{slot("a", TypeQuoted), slot("b", TypeWord)}, "ambiguous"},

		// --- the two documented exemptions ---------------------------------
		{"adjacent_fixed_width", []Token{slot("a", TypeSyslogTS), slot("b", TypeMAC)}, ""},
		{"ws_then_nospace", []Token{slot("pad", TypeWS), slot("n", TypeInt)}, ""},
		{"nospace_then_ws", []Token{slot("n", TypeInt), slot("pad", TypeWS)}, ""},
		{"ws_then_quoted_is_ambiguous", []Token{slot("pad", TypeWS), slot("q", TypeQuoted)}, "ambiguous"},

		// An empty literal is how a pack declares a deliberate slot boundary.
		{"empty_literal_separates", []Token{slot("a", TypeWord), lit(""), slot("b", TypeWord)}, ""},

		{"duplicate_slot", []Token{slot("a", TypeInt), lit("/"), slot("a", TypeInt)}, "duplicate slot"},
		{"bad_type", []Token{slot("a", "nope")}, "unknown type"},

		// `text` bounded by a following literal, and as the final token: both
		// legal. Every envelope in backend/packs/_envelopes.yaml ends in a
		// trailing `body` text slot, so the last-token form must stay legal.
		{"text_then_literal", []Token{slot("a", TypeText), lit(" end")}, ""},
		{"text_last", []Token{lit("pre "), slot("a", TypeText)}, ""},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			err := Validate(c.toks)
			switch {
			case c.wantErr == "" && err != nil:
				t.Fatalf("Validate rejected a legal template: %v", err)
			case c.wantErr != "" && err == nil:
				t.Fatalf("Validate accepted an illegal template, want error containing %q", c.wantErr)
			case c.wantErr != "" && !strings.Contains(err.Error(), c.wantErr):
				t.Fatalf("error = %v, want it to contain %q", err, c.wantErr)
			}
			if c.wantErr != "" {
				if _, err := Compile("t", c.toks); err == nil {
					t.Fatal("Compile accepted what Validate rejected")
				}
			}
		})
	}
}

// TestCompileExpr pins the anchored shape: ^ + literals quoted + one group per slot + $.
func TestCompileExpr(t *testing.T) {
	toks := []Token{lit("<"), slot("pri", TypeInt), lit(">a.b "), slot("ip", TypeIPv4)}
	tpl, err := Compile("t", toks)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	want := `^<(\d+)>a\.b ((?:\d{1,3}\.){3}\d{1,3})$`
	if tpl.Expr != want {
		t.Fatalf("expr = %q, want %q", tpl.Expr, want)
	}
	if got := strings.Join(tpl.Slots, ","); got != "pri,ip" {
		t.Fatalf("slots = %q, want \"pri,ip\"", got)
	}
	if n := tpl.Regexp().NumSubexp(); n != 2 {
		t.Fatalf("%d capture groups, want one per slot", n)
	}
}

// TestMatchReconstructRoundTrip is the byte-exactness guarantee in miniature.
func TestMatchReconstructRoundTrip(t *testing.T) {
	toks := []Token{
		lit("<"), slot("pri", TypeInt), lit(">"), slot("ts", TypeSyslogTS), lit(" "),
		slot("host", TypeHostname), lit(" elapsed"), slot("pad", TypeWS),
		slot("ms", TypeInt), lit(" "), slot("msg", TypeText),
	}
	cases := []struct{ name, raw string }{
		{"single_space_pad", "<166>Sep 19 14:31:02 fw01 elapsed 245 done"},
		{"wide_pad", "<166>Sep 19 14:31:02 fw01 elapsed    245 done ok"},
		{"tab_pad", "<13>Sep  9 04:05:06 host.example elapsed\t7 x"},
		{"empty_trailing_text", "<13>Sep  9 04:05:06 h elapsed 1 "},
	}
	tpl, err := Compile("t", toks)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			vars, ok := tpl.Match([]byte(c.raw))
			if !ok {
				t.Fatalf("no match for %q", c.raw)
			}
			got, err := Reconstruct(toks, vars)
			if err != nil {
				t.Fatalf("Reconstruct: %v", err)
			}
			if string(got) != c.raw {
				t.Fatalf("round trip differs\n want %q\n got  %q", c.raw, got)
			}
			// Every span must quote the same bytes the capture holds.
			spans := Spans(toks, vars)
			vi := 0
			for _, tok := range toks {
				if tok.IsLit() {
					continue
				}
				s := spans[tok.Slot]
				if c.raw[s.Start:s.End] != vars[vi] {
					t.Errorf("slot %q span %v quotes %q, capture is %q",
						tok.Slot, s, c.raw[s.Start:s.End], vars[vi])
				}
				vi++
			}
		})
	}
}

// TestReconstructArity rejects a var list that does not fit the token list --
// the exact defect a wrong stored envelope_id produces (see verify).
func TestReconstructArity(t *testing.T) {
	toks := []Token{lit("a="), slot("x", TypeInt), lit(" b="), slot("y", TypeInt)}
	if _, err := Reconstruct(toks, []string{"1"}); err == nil {
		t.Fatal("too few vars accepted")
	}
	if _, err := Reconstruct(toks, []string{"1", "2", "3"}); err == nil {
		t.Fatal("too many vars accepted")
	}
	got, err := Reconstruct(toks, []string{"1", "2"})
	if err != nil || string(got) != "a=1 b=2" {
		t.Fatalf("Reconstruct = %q, %v", got, err)
	}
}

// TestSpliceAndSlotIndex covers folding a body into an envelope (CONTRACTS §2).
func TestSpliceAndSlotIndex(t *testing.T) {
	env := []Token{lit("<"), slot("pri", TypeInt), lit("> "), slot("body", TypeText)}
	body := []Token{lit("built "), slot("id", TypeInt)}
	if got := SlotIndex(env, "body"); got != 1 {
		t.Fatalf("SlotIndex(body) = %d, want 1", got)
	}
	if got := SlotIndex(env, "nope"); got != -1 {
		t.Fatalf("SlotIndex(missing) = %d, want -1", got)
	}
	full, at, ok := Splice(env, "body", body)
	if !ok || at != 3 {
		t.Fatalf("Splice ok=%v at=%d, want true 3", ok, at)
	}
	tpl, err := Compile("full", full)
	if err != nil {
		t.Fatalf("Compile spliced: %v", err)
	}
	raw := "<166> built 42"
	vars, matched := tpl.Match([]byte(raw))
	if !matched {
		t.Fatalf("spliced template did not match %q", raw)
	}
	out, err := Reconstruct(full, vars)
	if err != nil || string(out) != raw {
		t.Fatalf("spliced reconstruct = %q, %v", out, err)
	}
	if _, _, ok := Splice(env, "absent", body); ok {
		t.Fatal("Splice reported success for a slot the envelope does not have")
	}
}

// The literal prefilter is a necessary condition only: it must never reject a real match,
// and must agree with the bare regexp on near misses.
func TestPrefilterAgreesWithRegexp(t *testing.T) {
	tpl, err := Compile("p", []Token{{Lit: "user="}, {Slot: "u", Type: TypeWord}, {Lit: " from "},
		{Slot: "ip", Type: TypeIPv4}, {Lit: " ok"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, in := range []string{
		"user=bob from 10.0.0.1 ok", "user=bob from 10.0.0.1 ok\n", "xuser=bob from 10.0.0.1 ok",
		"user=bob from 10.0.0.1 no", "user=bob fro 10.0.0.1 ok", "user= from 10.0.0.1 ok", "", "ok",
	} {
		_, got := tpl.Match([]byte(in))
		if want := tpl.re.MatchString(in); got != want {
			t.Errorf("%q: prefiltered=%v regexp=%v", in, got, want)
		}
	}
}
