// Package matcher indexes templates by (scope, envelope, discriminator) and
// runs anchored RE2 matches, first hit wins. Spec §6.5.
package matcher

import (
	"sort"
	"sync/atomic"

	"github.com/Ritesh2006M/aletheia/envelope"
	"github.com/Ritesh2006M/aletheia/registry"
)

const sep = "\x00"

// Index is an immutable compiled matcher index. Reload builds a new one and
// swaps an atomic pointer; in-flight events finish with the old index.
type Index struct {
	buckets map[string][]*registry.TemplateDef
	packs   []*registry.Pack
	nTpl    int
}

// Build compiles an index from packs. Candidate order inside a bucket is the
// order declared in the pack (most specific first).
func Build(packs []*registry.Pack) *Index {
	ix := &Index{buckets: map[string][]*registry.TemplateDef{}, packs: packs}
	for _, p := range packs {
		for _, t := range p.Templates {
			ix.nTpl++
			envs := t.Envelopes
			if len(envs) == 0 {
				envs = []string{"*"}
			}
			for _, scope := range scopesFor(p) {
				for _, e := range envs {
					ix.add(key(scope, e, t.Discriminator), t)
					if t.Discriminator != "" {
						// Also reachable without a discriminator, e.g. structural formats.
						ix.add(key(scope, e, ""), t)
					}
				}
			}
		}
	}
	return ix
}

func scopesFor(p *registry.Pack) []string {
	var out []string
	for _, s := range p.Sources {
		out = append(out, "s:"+s)
	}
	if p.AppliesTo.Vendor != "" || p.AppliesTo.Product != "" {
		out = append(out, "v:"+p.AppliesTo.Vendor+"/"+p.AppliesTo.Product)
	}
	return append(out, "*")
}

func key(scope, env, disc string) string { return scope + sep + env + sep + disc }

func (ix *Index) add(k string, t *registry.TemplateDef) {
	for _, e := range ix.buckets[k] {
		if e == t {
			return
		}
	}
	ix.buckets[k] = append(ix.buckets[k], t)
}

// Len reports the number of distinct templates indexed.
func (ix *Index) Len() int { return ix.nTpl }

// Packs returns the packs this index was built from.
func (ix *Index) Packs() []*registry.Pack { return ix.packs }

// Template looks up a template by pack and id.
func (ix *Index) Template(pack, id string) *registry.TemplateDef {
	for _, p := range ix.packs {
		if pack != "" && p.Pack != pack {
			continue
		}
		for _, t := range p.Templates {
			if t.ID == id {
				return t
			}
		}
	}
	return nil
}

// Candidates returns the ordered, deduplicated candidate list for an event.
func (ix *Index) Candidates(src *registry.Source, env envelope.Result) []*registry.TemplateDef {
	scopes := []string{"s:" + src.SourceID}
	if src.Vendor != "" || src.Product != "" {
		scopes = append(scopes, "v:"+src.Vendor+"/"+src.Product)
	}
	scopes = append(scopes, "*")

	discs := []string{env.Discriminator}
	if env.Discriminator != "" {
		discs = append(discs, "")
	}
	var out []*registry.TemplateDef
	seen := map[*registry.TemplateDef]bool{}
	for _, scope := range scopes {
		for _, e := range []string{env.ID, "*"} {
			for _, d := range discs {
				for _, t := range ix.buckets[key(scope, e, d)] {
					if !seen[t] {
						seen[t] = true
						out = append(out, t)
					}
				}
			}
		}
	}
	return out
}

// Match finds the first candidate whose anchored regexp matches the body.
// Returns the template and the captured vars as exact byte substrings.
func (ix *Index) Match(src *registry.Source, env envelope.Result) (*registry.TemplateDef, []string, bool) {
	body := []byte(env.Body)
	for _, t := range ix.Candidates(src, env) {
		if vars, ok := t.Compiled.Match(body); ok {
			return t, vars, true
		}
	}
	return nil, nil, false
}

// Matcher holds the live index behind an atomic pointer for lock-free hot swap.
type Matcher struct {
	ptr atomic.Pointer[Index]
}

// New returns a matcher over an empty index.
func New() *Matcher {
	m := &Matcher{}
	m.ptr.Store(Build(nil))
	return m
}

// Swap installs a new index. Readers already in Match keep the old one.
func (m *Matcher) Swap(ix *Index) { m.ptr.Store(ix) }

// Index returns the live index.
func (m *Matcher) Index() *Index { return m.ptr.Load() }

// Match delegates to the live index.
func (m *Matcher) Match(src *registry.Source, env envelope.Result) (*registry.TemplateDef, []string, bool) {
	return m.ptr.Load().Match(src, env)
}

// BucketKeys lists index buckets, for diagnostics.
func (ix *Index) BucketKeys() []string {
	out := make([]string, 0, len(ix.buckets))
	for k := range ix.buckets {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
