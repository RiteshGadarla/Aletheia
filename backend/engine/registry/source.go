package registry

import (
	"fmt"
	"os"
	"time"

	"gopkg.in/yaml.v3"
)

// Source is one log source. Mirrors the PostgreSQL `sources` table (CONTRACTS §7).
type Source struct {
	SourceID   string   `yaml:"source_id"   json:"source_id"`
	Peers      []string `yaml:"peers"       json:"peers,omitempty"`
	Listener   string   `yaml:"listener"    json:"listener,omitempty"`
	Vendor     string   `yaml:"vendor"      json:"vendor"`
	Product    string   `yaml:"product"     json:"product"`
	DeviceType string   `yaml:"device_type" json:"device_type"`
	Timezone   string   `yaml:"timezone"    json:"timezone"`
	Packs      []string `yaml:"packs"       json:"packs,omitempty"`
	Enabled    bool     `yaml:"enabled"     json:"enabled"`

	loc *time.Location
}

// Location resolves the source timezone, defaulting to UTC.
func (s *Source) Location() *time.Location {
	if s.loc != nil {
		return s.loc
	}
	if s.Timezone == "" {
		s.loc = time.UTC
		return s.loc
	}
	l, err := time.LoadLocation(s.Timezone)
	if err != nil {
		l = time.UTC
	}
	s.loc = l
	return l
}

// Sources is the in-memory source registry.
type Sources struct {
	byID map[string]*Source
}

type sourcesFile struct {
	Sources []*Source `yaml:"sources"`
}

// LoadSources reads a sources YAML file. A missing file yields an empty registry.
func LoadSources(path string) (*Sources, error) {
	s := &Sources{byID: map[string]*Source{}}
	if path == "" {
		return s, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, err
	}
	var f sourcesFile
	if err := yaml.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	for _, src := range f.Sources {
		if src.Timezone == "" {
			src.Timezone = "UTC"
		}
		s.byID[src.SourceID] = src
	}
	return s, nil
}

// Get returns the source, or a synthetic UTC entry for an unknown id.
func (s *Sources) Get(id string) *Source {
	if s != nil {
		if src, ok := s.byID[id]; ok {
			return src
		}
	}
	return &Source{SourceID: id, Timezone: "UTC", Enabled: true}
}

// All returns every registered source.
func (s *Sources) All() []*Source {
	out := make([]*Source, 0, len(s.byID))
	for _, v := range s.byID {
		out = append(out, v)
	}
	return out
}

// Put inserts or replaces a source.
func (s *Sources) Put(src *Source) {
	if s.byID == nil {
		s.byID = map[string]*Source{}
	}
	s.byID[src.SourceID] = src
}
