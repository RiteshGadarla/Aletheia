package reconstruct

import (
	"testing"

	"github.com/Ritesh2006M/aletheia/stamp"
	"github.com/Ritesh2006M/aletheia/template"
)

var asaTokens = []template.Token{
	{Lit: "<"}, {Slot: "pri", Type: template.TypeInt}, {Lit: ">"},
	{Slot: "ts", Type: template.TypeSyslogTS}, {Lit: " "},
	{Slot: "host", Type: template.TypeHostname}, {Lit: " conn "},
	{Slot: "id", Type: template.TypeInt},
}

var asaVars = []string{"166", "Sep 19 14:31:02", "fw01", "1234"}

const asaRaw = "<166>Sep 19 14:31:02 fw01 conn 1234"

// TestVerify is the arrival-hash gate: the rebuild must rehash to the digest
// taken before any parsing (CONTRACTS §10.1).
func TestVerify(t *testing.T) {
	want := stamp.SHA256([]byte(asaRaw))
	ok, got, err := Verify(asaTokens, asaVars, want)
	if err != nil || !ok {
		t.Fatalf("Verify = %v, %v", ok, err)
	}
	if string(got) != asaRaw {
		t.Fatalf("rebuilt %q, want %q", got, asaRaw)
	}
	// One byte of one var changed: the hash must no longer match.
	tampered := append([]string(nil), asaVars...)
	tampered[0] = "166X"
	ok, got, err = Verify(asaTokens, tampered, want)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if ok {
		t.Fatal("a tampered var still verified")
	}
	if d := FirstDiff([]byte(asaRaw), got); d != 4 {
		t.Fatalf("FirstDiff = %d, want 4 (the byte after the altered PRI)", d)
	}
}

// TestFirstDiff pins the offset verify reports.
func TestFirstDiff(t *testing.T) {
	cases := []struct {
		name string
		a, b string
		want int
	}{
		{"identical", "abc", "abc", -1},
		{"both_empty", "", "", -1},
		{"first_byte", "abc", "xbc", 0},
		{"middle_byte", "abcdef", "abcXef", 3},
		{"b_is_a_prefix", "abcdef", "abc", 3},
		{"a_is_a_prefix", "abc", "abcdef", 3},
		{"one_empty", "", "abc", 0},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			if got := FirstDiff([]byte(c.a), []byte(c.b)); got != c.want {
				t.Fatalf("FirstDiff(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
			}
		})
	}
}

// TestRebuildArityIsReported: too few or too many vars is an error naming both
// counts, not a silently truncated line.
func TestRebuildArityIsReported(t *testing.T) {
	if _, err := Rebuild(asaTokens, asaVars[:3]); err == nil {
		t.Fatal("a short var list rebuilt without error")
	}
	if _, err := Rebuild(asaTokens, append(append([]string(nil), asaVars...), "extra")); err == nil {
		t.Fatal("a long var list rebuilt without error")
	}
	if _, _, err := Verify(asaTokens, asaVars[:3], stamp.SHA256([]byte(asaRaw))); err == nil {
		t.Fatal("Verify accepted a short var list")
	}
}

// TestLineage recomputes byte spans; they are never stored, so they must agree
// with the reconstruction exactly.
func TestLineage(t *testing.T) {
	spans := Lineage(asaTokens, asaVars)
	want := map[string]template.Span{
		"pri":  {Start: 1, End: 4},
		"ts":   {Start: 5, End: 20},
		"host": {Start: 21, End: 25},
		"id":   {Start: 31, End: 35},
	}
	for slot, w := range want {
		got, ok := spans[slot]
		if !ok {
			t.Errorf("no span for slot %q", slot)
			continue
		}
		if got != w {
			t.Errorf("span %q = %v, want %v", slot, got, w)
		}
		if asaRaw[got.Start:got.End] == "" {
			t.Errorf("span %q is empty", slot)
		}
	}
	if len(spans) != len(want) {
		t.Errorf("%d spans, want %d", len(spans), len(want))
	}
}
