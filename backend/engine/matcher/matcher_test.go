// Tests for the template index. The matcher decides which template a line is
// parsed with, so every bug here becomes a wrong parse downstream — and the
// reconstruction gate only catches the subset that also fails to rebuild.
// The cases below pin the three properties the rest of the engine assumes:
// candidate order, discriminator-as-prefilter, and lock-free hot swap.
package matcher_test

import (
	"strings"
	"testing"

	"github.com/Ritesh2006M/aletheia/envelope"
	"github.com/Ritesh2006M/aletheia/matcher"
	"github.com/Ritesh2006M/aletheia/registry"
)

const packsDir = "../../packs"

func packs(t *testing.T) []*registry.Pack {
	t.Helper()
	p, err := registry.LoadDir(packsDir)
	if err != nil {
		t.Fatalf("load packs from %s: %v", packsDir, err)
	}
	if len(p) == 0 {
		t.Fatal("no packs loaded")
	}
	return p
}

func index(t *testing.T) *matcher.Index {
	t.Helper()
	return matcher.Build(packs(t))
}

// body wraps a line as a bare-envelope result, which is what a file-tailed
// format (Suricata EVE, Squid) looks like when it reaches the matcher.
func body(s string) envelope.Result {
	return envelope.Result{ID: "bare", Body: s, Facility: -1}
}

func src(id, vendor, product string) *registry.Source {
	return &registry.Source{SourceID: id, Vendor: vendor, Product: product, Enabled: true}
}

// TestBuildIndexesEveryTemplate guards the silent-drop failure: a template that
// never lands in a bucket can never match, and nothing else in the pipeline
// notices — the line just quarantines.
func TestBuildIndexesEveryTemplate(t *testing.T) {
	ps := packs(t)
	want := 0
	for _, p := range ps {
		want += len(p.Templates)
	}
	ix := matcher.Build(ps)
	if ix.Len() != want {
		t.Fatalf("indexed %d templates, packs declare %d", ix.Len(), want)
	}
	for _, p := range ps {
		for _, tpl := range p.Templates {
			if ix.Template(p.Pack, tpl.ID) == nil {
				t.Errorf("%s/%s not retrievable from the index", p.Pack, tpl.ID)
			}
			if tpl.Compiled == nil {
				t.Errorf("%s/%s reached the index uncompiled", p.Pack, tpl.ID)
			}
		}
	}
}

// TestDiscriminatorIsPrefilterNotFilter is the subtle one. Build files a
// discriminated template under BOTH its discriminator key and the empty key, so
// it stays reachable when the envelope yielded no discriminator at all. An
// "optimization" that files it only under its own discriminator would silently
// stop matching every bare-envelope format — and the only symptom would be a
// rise in quarantine volume.
func TestDiscriminatorIsPrefilterNotFilter(t *testing.T) {
	ix := index(t)
	s := src("any", "", "")

	withDisc := ix.Candidates(s, envelope.Result{ID: "bare", Discriminator: `"event_type":"alert"`})
	noDisc := ix.Candidates(s, envelope.Result{ID: "bare"})

	if len(noDisc) == 0 {
		t.Fatal("no candidates at all when the envelope carries no discriminator")
	}
	find := func(list []*registry.TemplateDef, id string) bool {
		for _, tpl := range list {
			if tpl.ID == id {
				return true
			}
		}
		return false
	}
	const target = "suricata_eve_alert"
	if !find(withDisc, target) {
		t.Errorf("%s unreachable when its own discriminator is present", target)
	}
	if !find(noDisc, target) {
		t.Errorf("%s unreachable without a discriminator; it was filed only under its own key", target)
	}
}

// TestCandidatesAreDeduplicated pins that a template reachable through several
// scopes is offered once. Duplicates are not merely wasteful: they make
// "first hit wins" depend on how many scopes happened to match.
func TestCandidatesAreDeduplicated(t *testing.T) {
	ix := index(t)
	// A source whose id, vendor and product all resolve, so every scope hits.
	cands := ix.Candidates(src("asa", "Cisco", "ASA"), body(""))
	seen := map[*registry.TemplateDef]int{}
	for _, tpl := range cands {
		seen[tpl]++
	}
	for tpl, n := range seen {
		if n > 1 {
			t.Errorf("template %s offered %d times", tpl.ID, n)
		}
	}
}

// TestCandidateOrderIsSpecificFirst pins CONTRACTS' ordering rule: a template
// scoped to this source must be tried before a vendor-scoped one, and both
// before the wildcard. Reversing this makes a generic template shadow the
// specific one that was written for the source.
func TestCandidateOrderIsSpecificFirst(t *testing.T) {
	ps := packs(t)
	ix := matcher.Build(ps)
	cands := ix.Candidates(src("asa", "Cisco", "ASA"), body(""))
	if len(cands) < 2 {
		t.Skip("need at least two candidates to compare ordering")
	}
	// Source scope lives on the pack, so fold it down onto each template.
	srcScoped := map[*registry.TemplateDef]bool{}
	for _, p := range ps {
		if !contains(p.Sources, "asa") {
			continue
		}
		for _, tpl := range p.Templates {
			srcScoped[tpl] = true
		}
	}
	rank := func(tpl *registry.TemplateDef) int {
		switch {
		case srcScoped[tpl]:
			return 0
		case tpl.Vendor == "Cisco" && tpl.Product == "ASA":
			return 1
		default:
			return 2
		}
	}
	last := -1
	for _, tpl := range cands {
		r := rank(tpl)
		if r < last {
			t.Errorf("candidate %s (rank %d) came after a rank %d template", tpl.ID, r, last)
		}
		if r > last {
			last = r
		}
	}
}

// TestNoCrossFormatOverMatch is the regression that actually bit: the Suricata
// EVE template once carried a bare `text` slot, so it matched any line at all —
// including plain syslog — and then died in json.loads. Anchoring the pattern on
// the JSON braces plus the event_type discriminator fixed it. These assertions
// fail the moment a template's pattern goes permissive again.
func TestNoCrossFormatOverMatch(t *testing.T) {
	ix := index(t)
	anySrc := src("any", "", "")

	cases := []struct {
		name string
		line string
		// wantPackPrefix is the pack a match must come from, if anything matches.
		wantPackPrefix string
	}{
		{
			name:           "suricata eve json",
			line:           `{"timestamp":"2026-09-19T14:31:02.123456+0000","event_type":"alert","src_ip":"10.0.0.5","src_port":44321,"dest_ip":"93.184.216.34","dest_port":443,"proto":"TCP","alert":{"action":"allowed","signature_id":2013028,"signature":"ET POLICY curl User-Agent","category":"Attempted Information Leak","severity":2}}`,
			wantPackPrefix: "suricata",
		},
		{
			name:           "squid access line",
			line:           `1789828262.123    132 10.0.0.5 TCP_MISS/200 4214 GET http://example.com/ - HIER_DIRECT/93.184.216.34 text/html`,
			wantPackPrefix: "squid",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			tpl, _, ok := ix.Match(anySrc, body(c.line))
			if !ok {
				t.Fatalf("no template matched a well-formed %s line", c.name)
			}
			if !strings.HasPrefix(tpl.Pack, c.wantPackPrefix) {
				t.Fatalf("matched %s/%s, want a pack starting %q — a permissive pattern is shadowing it",
					tpl.Pack, tpl.ID, c.wantPackPrefix)
			}
		})
	}

	// Garbage must not match anything. CONTRACTS §10.2: an unknown line
	// quarantines, it is never forced into a template.
	for _, junk := range []string{
		"hello world",
		"",
		"<134>not a real log line at all",
		`{"event_type":"alert"`, // truncated JSON: no closing brace
	} {
		if tpl, _, ok := ix.Match(anySrc, body(junk)); ok {
			t.Errorf("junk %q matched %s/%s; a template is over-matching", junk, tpl.Pack, tpl.ID)
		}
	}
}

// TestEmptyIndexNeverPanics: New() serves an empty index until the first
// reload, and the hot path calls Match on it.
func TestEmptyIndexNeverPanics(t *testing.T) {
	m := matcher.New()
	if got := m.Index().Len(); got != 0 {
		t.Fatalf("fresh matcher indexes %d templates, want 0", got)
	}
	if _, _, ok := m.Match(src("any", "", ""), body("anything at all")); ok {
		t.Fatal("empty index reported a match")
	}
}

// TestSwapIsAtomicForInFlightReaders pins the hot-reload contract: Swap
// installs a new index, and a reader holding the old pointer keeps serving from
// it rather than observing a half-built one.
func TestSwapIsAtomicForInFlightReaders(t *testing.T) {
	m := matcher.New()
	old := m.Index()

	m.Swap(index(t))
	if m.Index().Len() == 0 {
		t.Fatal("Swap did not install the new index")
	}
	if old.Len() != 0 {
		t.Fatal("Swap mutated the index an in-flight reader was holding")
	}

	// The reader that captured `old` still gets the old answer.
	if _, _, ok := old.Match(src("any", "", ""), body("hello world")); ok {
		t.Fatal("the retained old index started matching after a swap")
	}
}

// TestMatchReturnsExactByteSubstrings: vars must be the captured bytes verbatim,
// because reconstruction concatenates them back with the literals. Any trimming
// or normalization here breaks byte-exactness — the one invariant with no
// fallback.
func TestMatchReturnsExactByteSubstrings(t *testing.T) {
	ix := index(t)
	line := `1789828262.123    132 10.0.0.5 TCP_MISS/200 4214 GET http://example.com/ - HIER_DIRECT/93.184.216.34 text/html`
	tpl, vars, ok := ix.Match(src("squid", "", ""), body(line))
	if !ok {
		t.Fatal("the squid golden line did not match")
	}
	for i, v := range vars {
		if !strings.Contains(line, v) {
			t.Errorf("%s var %d = %q is not a substring of the input; the matcher altered it",
				tpl.ID, i, v)
		}
	}
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}
