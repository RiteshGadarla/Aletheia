package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/Ritesh2006M/aletheia/fullmatch"
	"github.com/Ritesh2006M/aletheia/pipeline"
	"github.com/Ritesh2006M/aletheia/reconstruct"
	"github.com/Ritesh2006M/aletheia/registry"
)

// Failure is one golden sample that did not reconstruct. Shape frozen by
// CONTRACTS §8; the Studio parses it.
type Failure struct {
	Sample string `json:"sample"`
	Reason string `json:"reason"`
	Offset int    `json:"offset"`
}

// TestPackResult is the whole gate report. Keys and types are frozen.
type TestPackResult struct {
	OK            bool      `json:"ok"`
	Samples       int       `json:"samples"`
	Reconstructed int       `json:"reconstructed"`
	Failures      []Failure `json:"failures"`
}

// cmdTestPack is THE reconstruction gate (spec §8.9): a pack is acceptable only
// when every golden sample rebuilds byte-for-byte from template plus vars.
func cmdTestPack(args []string) int {
	fs := flag.NewFlagSet("test-pack", flag.ContinueOnError)
	packPath := fs.String("pack", "", "parser pack YAML file (required)")
	samplesDir := fs.String("samples", "", "directory holding the golden samples")
	envFile := fs.String("envelopes", "", "envelope table (default <packdir>/_envelopes.yaml)")
	fs.Bool("json", true, "print JSON (always on)")
	if err := fs.Parse(args); err != nil {
		return hardFail(fmt.Sprintf("bad flags: %v", err))
	}
	if *packPath == "" {
		return hardFail("--pack is required")
	}

	packDir := filepath.Dir(*packPath)
	if *envFile == "" {
		*envFile = filepath.Join(packDir, "_envelopes.yaml")
	}
	if *samplesDir == "" {
		*samplesDir = filepath.Join(packDir, "tests")
	}

	pack, err := registry.LoadPackFile(*packPath)
	if err != nil {
		return hardFail(err.Error())
	}
	envs, err := pipeline.LoadEnvelopes(*envFile)
	if err != nil {
		return hardFail(err.Error())
	}
	if len(envs) == 0 {
		return hardFail(fmt.Sprintf("no envelopes in %s", *envFile))
	}

	ix, warn := fullmatch.Build([]*registry.Pack{pack}, envs)
	res := TestPackResult{Failures: []Failure{}}
	for _, w := range warn {
		res.Failures = append(res.Failures, Failure{Sample: "-", Reason: w.Error(), Offset: -1})
	}

	// Group the compiled (template, envelope) pairs by template.
	byTpl := map[string][]*fullmatch.Entry{}
	for _, e := range ix.Entries() {
		byTpl[e.Def.ID] = append(byTpl[e.Def.ID], e)
	}

	for _, td := range pack.Templates {
		entries := byTpl[td.ID]
		if len(entries) == 0 {
			res.Failures = append(res.Failures, Failure{
				Sample: td.ID, Reason: "no envelope compiled for this template", Offset: -1})
			continue
		}
		samples, glob := findSamples(td, packDir, *samplesDir)
		if len(samples) == 0 {
			res.Failures = append(res.Failures, Failure{
				Sample: td.ID, Reason: "no samples matched " + glob, Offset: -1})
			continue
		}
		for _, path := range samples {
			name := relName(path, *samplesDir)
			raw, err := os.ReadFile(path)
			if err != nil {
				res.Failures = append(res.Failures, Failure{Sample: name, Reason: err.Error(), Offset: -1})
				continue
			}
			for _, line := range splitSamples(raw) {
				res.Samples++
				if f, ok := gate(td, entries, line, name); !ok {
					res.Failures = append(res.Failures, f)
					continue
				}
				res.Reconstructed++
			}
		}
	}

	res.OK = len(res.Failures) == 0 && res.Samples > 0 && res.Samples == res.Reconstructed
	emit(res)
	return code(res.OK)
}

// gate runs one sample through splice, match, extract and reconstruct.
func gate(td *registry.TemplateDef, entries []*fullmatch.Entry, raw []byte, name string) (Failure, bool) {
	if d := td.Discriminator; d != "" && !strings.Contains(string(raw), d) {
		return Failure{Sample: name, Offset: -1,
			Reason: fmt.Sprintf("%s: discriminator %q absent from sample", td.ID, d)}, false
	}
	tried := make([]string, 0, len(entries))
	for _, e := range entries {
		tried = append(tried, e.EnvID)
		vars, ok := e.Compiled.Match(raw)
		if !ok {
			continue
		}
		got, err := reconstruct.Rebuild(e.Tokens, vars)
		if err != nil {
			return Failure{Sample: name, Offset: -1,
				Reason: fmt.Sprintf("%s@%s: reconstruct: %v", td.ID, e.EnvID, err)}, false
		}
		if off := reconstruct.FirstDiff(raw, got); off >= 0 {
			return Failure{Sample: name, Offset: off,
				Reason: fmt.Sprintf("%s@%s: reconstruction mismatch at byte %d", td.ID, e.EnvID, off)}, false
		}
		return Failure{}, true
	}
	return Failure{Sample: name, Offset: -1,
		Reason: fmt.Sprintf("%s: no template matched (tried envelopes %s)",
			td.ID, strings.Join(tried, ","))}, false
}

// findSamples resolves the pack's sample glob. The Studio passes the tests
// directory itself, packs write the glob relative to the pack file, so try both.
func findSamples(td *registry.TemplateDef, packDir, samplesDir string) ([]string, string) {
	pat := td.Tests.Samples
	cands := []string{}
	if pat != "" {
		cands = append(cands,
			filepath.Join(samplesDir, pat),
			filepath.Join(samplesDir, strings.TrimPrefix(pat, "tests/")),
			filepath.Join(packDir, pat),
		)
	}
	cands = append(cands,
		filepath.Join(samplesDir, td.ID, "*.log"),
		filepath.Join(samplesDir, "tests", td.ID, "*.log"),
	)
	for _, c := range cands {
		m, err := filepath.Glob(c)
		if err != nil || len(m) == 0 {
			continue
		}
		sort.Strings(m)
		return m, c
	}
	if pat == "" {
		pat = filepath.Join(td.ID, "*.log")
	}
	return nil, pat
}

// splitSamples yields one raw event per non-empty line, trailing framing removed.
func splitSamples(b []byte) [][]byte {
	s := strings.TrimRight(string(b), "\r\n")
	if s == "" {
		return nil
	}
	parts := strings.Split(s, "\n")
	out := make([][]byte, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimRight(p, "\r")
		if p == "" {
			continue
		}
		out = append(out, []byte(p))
	}
	return out
}

func relName(path, base string) string {
	if r, err := filepath.Rel(base, path); err == nil && !strings.HasPrefix(r, "..") {
		return r
	}
	return filepath.Base(path)
}

// hardFail reports a setup error in the frozen test-pack shape so the Studio
// parses the same object whatever went wrong.
func hardFail(reason string) int {
	emit(TestPackResult{OK: false, Samples: 0, Reconstructed: 0,
		Failures: []Failure{{Sample: "-", Reason: reason, Offset: -1}}})
	return 1
}
