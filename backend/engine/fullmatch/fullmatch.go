// Package fullmatch compiles whole-line templates: each pack body spliced into
// each envelope it declares (CONTRACTS §2). The compiled regex therefore covers
// the entire raw event, header included, so reconstruction is byte-exact.
//
// matcher.Index matches bodies against a runtime-decoded envelope; fullmatch is
// the declared-envelope counterpart the reconstruction gate and the worker need,
// because pack envelope ids (`cef`, `syslog_pri_only`) are pack-authored names
// and not the decoder's runtime labels.
package fullmatch

import (
	"fmt"
	"sort"
	"strings"

	"github.com/Ritesh2006M/aletheia/registry"
	"github.com/Ritesh2006M/aletheia/template"
)

// Entry is one (template, envelope) pair compiled to a whole-line regex.
type Entry struct {
	Def      *registry.TemplateDef
	Pack     *registry.Pack
	EnvID    string
	Tokens   []template.Token   // envelope tokens with the body slot spliced out
	Compiled *template.Template // anchored, one capture group per slot

	// BodyVarAt is the index of the first body capture inside the full var list;
	// BodyVarCount is how many of them there are.
	BodyVarAt    int
	BodyVarCount int

	scope int // 0 source-listed, 1 vendor/product, 2 generic
}

// BodyVars slices the body captures out of a full var list.
func (e *Entry) BodyVars(full []string) []string {
	if e.BodyVarAt < 0 || e.BodyVarAt+e.BodyVarCount > len(full) {
		return nil
	}
	return full[e.BodyVarAt : e.BodyVarAt+e.BodyVarCount]
}

// Index is an immutable set of compiled whole-line templates.
type Index struct {
	entries   []*Entry
	packs     []*registry.Pack
	envelopes map[string][]template.Token
	nTpl      int
}

// Build compiles every template against every envelope it declares. Templates
// that fail to compile are reported but never abort the build.
func Build(packs []*registry.Pack, envs map[string][]template.Token) (*Index, []error) {
	ix := &Index{packs: packs, envelopes: envs}
	var errs []error
	for _, p := range packs {
		for _, td := range p.Templates {
			ix.nTpl++
			names := td.Envelopes
			if len(names) == 0 {
				names = p.Envelopes
			}
			if len(names) == 0 {
				names = []string{"bare"}
			}
			for _, name := range names {
				env, ok := envs[name]
				if !ok {
					errs = append(errs, fmt.Errorf("%s/%s: unknown envelope %q", p.Pack, td.ID, name))
					continue
				}
				e, err := compile(p, td, name, env)
				if err != nil {
					errs = append(errs, err)
					continue
				}
				ix.entries = append(ix.entries, e)
			}
		}
	}
	sort.SliceStable(ix.entries, func(i, j int) bool { return ix.entries[i].scope < ix.entries[j].scope })
	return ix, errs
}

func compile(p *registry.Pack, td *registry.TemplateDef, envID string, env []template.Token) (*Entry, error) {
	toks, _, ok := template.Splice(env, "body", td.Body)
	if !ok {
		return nil, fmt.Errorf("%s/%s: envelope %q has no body slot", p.Pack, td.ID, envID)
	}
	c, err := template.Compile(td.ID+"@"+envID, toks)
	if err != nil {
		return nil, fmt.Errorf("%s/%s@%s: %w", p.Pack, td.ID, envID, err)
	}
	at := template.SlotIndex(env, "body")
	if at < 0 {
		return nil, fmt.Errorf("%s/%s: envelope %q has no body slot", p.Pack, td.ID, envID)
	}
	n := 0
	for _, t := range td.Body {
		if !t.IsLit() {
			n++
		}
	}
	sc := 2
	if len(p.Sources) > 0 {
		sc = 0
	} else if p.AppliesTo.Vendor != "" || p.AppliesTo.Product != "" {
		sc = 1
	}
	return &Entry{Def: td, Pack: p, EnvID: envID, Tokens: toks, Compiled: c,
		BodyVarAt: at, BodyVarCount: n, scope: sc}, nil
}

// Len reports the number of distinct templates indexed.
func (ix *Index) Len() int { return ix.nTpl }

// Entries exposes the compiled pairs in candidate order.
func (ix *Index) Entries() []*Entry { return ix.entries }

// Packs returns the packs this index was built from.
func (ix *Index) Packs() []*registry.Pack { return ix.packs }

// Envelopes returns the envelope token table.
func (ix *Index) Envelopes() map[string][]template.Token { return ix.envelopes }

// Find looks up one compiled pair by template id and envelope id.
func (ix *Index) Find(templateID, envID string) *Entry {
	for _, e := range ix.entries {
		if e.Def.ID == templateID && (envID == "" || e.EnvID == envID) {
			return e
		}
	}
	return nil
}

// Match runs the whole-line templates against raw. The discriminator is a plain
// substring prefilter, so only plausible regexes ever run. First hit wins.
func (ix *Index) Match(src *registry.Source, raw []byte) (*Entry, []string, bool) {
	s := string(raw)
	for _, e := range ix.entries {
		if !inScope(e.Pack, src) {
			continue
		}
		if d := e.Def.Discriminator; d != "" && !strings.Contains(s, d) {
			continue
		}
		if vars, ok := e.Compiled.Match(raw); ok {
			return e, vars, true
		}
	}
	return nil, nil, false
}

// inScope keeps a pack away from sources it does not claim. A pack with neither
// a source list nor a vendor (generic CEF/LEEF) applies everywhere.
func inScope(p *registry.Pack, src *registry.Source) bool {
	if src == nil {
		return true
	}
	if len(p.Sources) > 0 {
		for _, s := range p.Sources {
			if s == src.SourceID {
				return true
			}
		}
		return false
	}
	if p.AppliesTo.Vendor == "" && p.AppliesTo.Product == "" {
		return true
	}
	if src.Vendor == "" && src.Product == "" {
		return true
	}
	if p.AppliesTo.Vendor != "" && src.Vendor != "" &&
		!strings.EqualFold(p.AppliesTo.Vendor, src.Vendor) {
		return false
	}
	if p.AppliesTo.Product != "" && src.Product != "" &&
		!strings.EqualFold(p.AppliesTo.Product, src.Product) {
		return false
	}
	return true
}
