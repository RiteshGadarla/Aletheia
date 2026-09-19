package pipeline

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/Ritesh2006M/aletheia/fullmatch"
	"github.com/Ritesh2006M/aletheia/normalize"
	"github.com/Ritesh2006M/aletheia/registry"
	"github.com/Ritesh2006M/aletheia/template"
)

// Paths locates the pack tree on disk.
type Paths struct {
	PacksDir     string
	EnvelopeFile string
	SourcesFile  string
	EnumsFile    string
}

// Defaults fills envelope/sources/enums paths from the pack directory.
func (p Paths) Defaults() Paths {
	if p.EnvelopeFile == "" && p.PacksDir != "" {
		p.EnvelopeFile = filepath.Join(p.PacksDir, "_envelopes.yaml")
	}
	if p.SourcesFile == "" && p.PacksDir != "" {
		p.SourcesFile = filepath.Join(p.PacksDir, "_sources.yaml")
	}
	return p
}

// LoadEnvelopes reads the shared envelope table, tolerating a missing file.
func LoadEnvelopes(path string) (map[string][]template.Token, error) {
	envs, err := registry.LoadEnvelopes(path)
	if err != nil {
		return nil, err
	}
	for name, toks := range envs {
		if err := template.Validate(toks); err != nil {
			return nil, fmt.Errorf("envelope %s: %w", name, err)
		}
	}
	return envs, nil
}

// Load reads packs, envelopes, sources and enums and compiles a whole-line
// index. Compile warnings are returned separately and never abort the load.
func Load(p Paths) (*Engine, []error, error) {
	p = p.Defaults()
	packs, err := registry.LoadDir(p.PacksDir)
	if err != nil {
		return nil, nil, err
	}
	envs, err := LoadEnvelopes(p.EnvelopeFile)
	if err != nil {
		return nil, nil, err
	}
	srcs, err := registry.LoadSources(p.SourcesFile)
	if err != nil {
		return nil, nil, err
	}
	en := normalize.Default
	if p.EnumsFile != "" {
		if _, statErr := os.Stat(p.EnumsFile); statErr == nil {
			if loaded, lerr := normalize.LoadEnums(p.EnumsFile); lerr == nil {
				en = loaded
			}
		}
	}
	ix, warn := fullmatch.Build(packs, envs)
	return New(ix, srcs, en), warn, nil
}

// LoadPacks compiles an engine from packs already in memory (replay reads pack
// YAML out of PostgreSQL rather than the filesystem).
func LoadPacks(packs []*registry.Pack, envs map[string][]template.Token,
	srcs *registry.Sources, en *normalize.Enums) (*Engine, []error) {
	ix, warn := fullmatch.Build(packs, envs)
	return New(ix, srcs, en), warn
}
