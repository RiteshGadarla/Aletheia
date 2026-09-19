// Package registry loads, validates and compiles parser packs, and hot-reloads
// them on the control topic. Spec §6.10, CONTRACTS §2.
package registry

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/Ritesh2006M/aletheia/template"
)

// MapTarget is a slot to OCSF path mapping. YAML allows a bare string or an object.
type MapTarget struct {
	Path      string         `yaml:"path"      json:"path"`
	Enum      map[string]int `yaml:"enum"      json:"enum,omitempty"`
	Transform string         `yaml:"transform" json:"transform,omitempty"`
}

// UnmarshalYAML accepts either `slot: ocsf.path` or `slot: {path: ..., enum: ...}`.
func (m *MapTarget) UnmarshalYAML(n *yaml.Node) error {
	if n.Kind == yaml.ScalarNode {
		m.Path = n.Value
		return nil
	}
	type raw MapTarget
	var r raw
	if err := n.Decode(&r); err != nil {
		return err
	}
	*m = MapTarget(r)
	return nil
}

// Conditional applies extra mappings when every `when` slot matches exactly.
type Conditional struct {
	When      map[string]string    `yaml:"when"      json:"when"`
	Map       map[string]MapTarget `yaml:"map"       json:"map,omitempty"`
	Constants map[string]any       `yaml:"constants" json:"constants,omitempty"`
}

// OCSF is the normalization block of a template.
type OCSF struct {
	ClassUID     int                  `yaml:"class_uid"     json:"class_uid"`
	ActivityID   int                  `yaml:"activity_id"   json:"activity_id"`
	SeverityID   *int                 `yaml:"severity_id"   json:"severity_id,omitempty"`
	Constants    map[string]any       `yaml:"constants"     json:"constants,omitempty"`
	Map          map[string]MapTarget `yaml:"map"           json:"map,omitempty"`
	Conditional  []Conditional        `yaml:"conditional"   json:"conditional,omitempty"`
	UnmappedKeep []string             `yaml:"unmapped_keep" json:"unmapped_keep,omitempty"`
}

// Tests points at golden samples for the reconstruction gate.
type Tests struct {
	Samples  string `yaml:"samples"  json:"samples,omitempty"`
	Expected string `yaml:"expected" json:"expected,omitempty"`
}

// TemplateDef is one template inside a pack, after compilation.
type TemplateDef struct {
	ID            string            `yaml:"id"            json:"id"`
	Discriminator string            `yaml:"discriminator" json:"discriminator,omitempty"`
	Envelopes     []string          `yaml:"envelopes"     json:"envelopes,omitempty"`
	Body          []template.Token  `yaml:"body"          json:"body"`
	OCSF          OCSF              `yaml:"ocsf"          json:"ocsf"`
	Tests         Tests             `yaml:"tests"         json:"tests,omitempty"`

	Pack        string             `yaml:"-" json:"pack"`
	PackVersion uint32             `yaml:"-" json:"pack_version"`
	Vendor      string             `yaml:"-" json:"vendor,omitempty"`
	Product     string             `yaml:"-" json:"product,omitempty"`
	Compiled    *template.Template `yaml:"-" json:"-"`
}

// AppliesTo scopes a pack to a vendor/product pair.
type AppliesTo struct {
	Vendor  string `yaml:"vendor"  json:"vendor"`
	Product string `yaml:"product" json:"product"`
}

// Pack is one parser pack file.
type Pack struct {
	Pack      string         `yaml:"pack"      json:"pack"`
	Version   uint32         `yaml:"version"   json:"version"`
	AppliesTo AppliesTo      `yaml:"applies_to" json:"applies_to"`
	Envelopes []string       `yaml:"envelopes" json:"envelopes,omitempty"`
	Sources   []string       `yaml:"sources"   json:"sources,omitempty"`
	Templates []*TemplateDef `yaml:"templates" json:"templates"`

	Path     string `yaml:"-" json:"path,omitempty"`
	Checksum string `yaml:"-" json:"checksum"`
}

// ParsePack decodes and compiles a pack from YAML bytes.
func ParsePack(data []byte, path string) (*Pack, error) {
	var p Pack
	if err := yaml.Unmarshal(data, &p); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if p.Pack == "" {
		return nil, fmt.Errorf("%s: missing pack name", path)
	}
	if len(p.Templates) == 0 {
		return nil, fmt.Errorf("%s: pack %s has no templates", path, p.Pack)
	}
	sum := sha256.Sum256(data)
	p.Path = path
	p.Checksum = hex.EncodeToString(sum[:])
	seen := map[string]bool{}
	for _, t := range p.Templates {
		if t.ID == "" {
			return nil, fmt.Errorf("%s: template with no id", path)
		}
		if seen[t.ID] {
			return nil, fmt.Errorf("%s: duplicate template id %s", path, t.ID)
		}
		seen[t.ID] = true
		t.Pack, t.PackVersion = p.Pack, p.Version
		t.Vendor, t.Product = p.AppliesTo.Vendor, p.AppliesTo.Product
		if len(t.Envelopes) == 0 {
			t.Envelopes = p.Envelopes
		}
		c, err := template.Compile(t.ID, t.Body)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		t.Compiled = c
		if t.Discriminator != "" && !discriminatorPlausible(t) {
			return nil, fmt.Errorf("%s: template %s discriminator %q does not appear in its body literals",
				path, t.ID, t.Discriminator)
		}
	}
	return &p, nil
}

// discriminatorPlausible checks the pack invariant that the discriminator is a
// fast index key derived from the body, the envelope tag or a structural header.
func discriminatorPlausible(t *TemplateDef) bool {
	if strings.ContainsAny(t.Discriminator, ":=|") {
		return true // tag:, logid=, CEF:/LEEF: structural keys
	}
	var b strings.Builder
	for _, tok := range t.Body {
		if tok.IsLit() {
			b.WriteString(tok.Lit)
		}
	}
	return strings.Contains(b.String(), t.Discriminator)
}

// LoadPackFile reads and compiles one pack file.
func LoadPackFile(path string) (*Pack, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return ParsePack(data, path)
}

// LoadDir loads every *.yaml pack in dir, skipping files starting with '_'.
func LoadDir(dir string) ([]*Pack, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() || strings.HasPrefix(e.Name(), "_") {
			continue
		}
		if ext := filepath.Ext(e.Name()); ext != ".yaml" && ext != ".yml" {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)
	packs := make([]*Pack, 0, len(names))
	for _, n := range names {
		p, err := LoadPackFile(filepath.Join(dir, n))
		if err != nil {
			return nil, err
		}
		packs = append(packs, p)
	}
	return packs, nil
}

// envelopeFile is the shape of backend/packs/_envelopes.yaml.
type envelopeFile struct {
	Envelopes map[string][]template.Token `yaml:"envelopes"`
}

// LoadEnvelopes reads the shared envelope template file, if present.
func LoadEnvelopes(path string) (map[string][]template.Token, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string][]template.Token{}, nil
		}
		return nil, err
	}
	var f envelopeFile
	if err := yaml.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if f.Envelopes == nil {
		f.Envelopes = map[string][]template.Token{}
	}
	return f.Envelopes, nil
}
