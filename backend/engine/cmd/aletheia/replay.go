package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Ritesh2006M/aletheia/config"
	"github.com/Ritesh2006M/aletheia/normalize"
	"github.com/Ritesh2006M/aletheia/pipeline"
	"github.com/Ritesh2006M/aletheia/reconstruct"
	"github.com/Ritesh2006M/aletheia/registry"
	"github.com/Ritesh2006M/aletheia/sink"
	"github.com/Ritesh2006M/aletheia/store"
	"github.com/Ritesh2006M/aletheia/template"
)

// Regression is an event a pack change makes worse. Blocking by definition
// (spec §8.10): full -> partial or raw_only, or a match that disappears.
type Regression struct {
	EventUID     string `json:"event_uid"`
	FromStatus   string `json:"from_status"`
	ToStatus     string `json:"to_status"`
	FromTemplate string `json:"from_template"`
	ToTemplate   string `json:"to_template"`
	Sample       string `json:"sample"`
}

// TemplateChange is one event whose matched template id moved.
type TemplateChange struct {
	EventUID     string `json:"event_uid"`
	FromTemplate string `json:"from_template"`
	ToTemplate   string `json:"to_template"`
}

// FieldDiff counts how many events changed one OCSF field, with an example.
type FieldDiff struct {
	Path    string `json:"path"`
	Changed int    `json:"changed"`
	Added   int    `json:"added"`
	Removed int    `json:"removed"`
	Before  string `json:"before"`
	After   string `json:"after"`
	Example string `json:"example_event_uid"`
}

// ReplayResult is the blast-radius report the reviewer approves against.
type ReplayResult struct {
	OK          bool   `json:"ok"`
	Blocking    bool   `json:"blocking"`
	Source      string `json:"source"`
	FromVersion uint32 `json:"from_version"`
	ToVersion   uint32 `json:"to_version"`
	Events      int    `json:"events"`

	NewlyMatched    int `json:"newly_matched"`
	NoLongerMatched int `json:"no_longer_matched"`
	TemplateChanged int `json:"template_changed"`
	Unchanged       int `json:"unchanged"`

	StatusTransitions map[string]int   `json:"status_transitions"`
	Templates         []TemplateChange `json:"template_changes"`
	Fields            []FieldDiff      `json:"fields"`
	Regressions       []Regression     `json:"regressions"`
	Error             string           `json:"error,omitempty"`
}

func cmdReplay(args []string) int {
	fs := flag.NewFlagSet("replay", flag.ContinueOnError)
	source := fs.String("source", "", "source id (required)")
	fromV := fs.Uint("from-version", 0, "current pack version")
	toV := fs.Uint("to-version", 0, "proposed pack version")
	last := fs.Int("last", 1000, "number of most recent events to replay")
	fromDir := fs.String("from-packs", "", "pack directory for the current version")
	toDir := fs.String("to-packs", "", "pack directory for the proposed version")
	maxEx := fs.Int("max-examples", 25, "cap on listed template changes and regressions")
	fs.Bool("json", true, "print JSON (always on)")
	if err := fs.Parse(args); err != nil {
		return replayFail(ReplayResult{}, fmt.Sprintf("bad flags: %v", err))
	}

	res := ReplayResult{Source: *source, FromVersion: uint32(*fromV), ToVersion: uint32(*toV),
		StatusTransitions: map[string]int{}, Templates: []TemplateChange{},
		Fields: []FieldDiff{}, Regressions: []Regression{}}
	if *source == "" {
		return replayFail(res, "--source is required")
	}
	if *fromV == *toV && *fromDir == "" && *toDir == "" {
		return replayFail(res, "--from-version and --to-version must differ")
	}

	cfg := config.Load()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	envs, err := pipeline.LoadEnvelopes(cfg.EnvelopeFile)
	if err != nil {
		return replayFail(res, "envelopes: "+err.Error())
	}
	srcs, err := registry.LoadSources(cfg.SourcesFile)
	if err != nil {
		return replayFail(res, "sources: "+err.Error())
	}
	en := normalize.Default
	if loaded, lerr := normalize.LoadEnums(cfg.EnumsFile()); lerr == nil {
		en = loaded
	}

	var pool *pgxpool.Pool
	if cfg.PostgresDSN != "" {
		if pool, err = store.OpenPG(ctx, cfg.PostgresDSN); err != nil {
			return replayFail(res, "postgres: "+err.Error())
		}
		defer pool.Close()
	}

	oldEng, err := engineAt(ctx, pool, cfg, envs, srcs, en, uint32(*fromV), *fromDir)
	if err != nil {
		return replayFail(res, "from-version: "+err.Error())
	}
	newEng, err := engineAt(ctx, pool, cfg, envs, srcs, en, uint32(*toV), *toDir)
	if err != nil {
		return replayFail(res, "to-version: "+err.Error())
	}

	conn, err := sink.Connect(ctx, sink.Options{Addr: cfg.ClickHouseAddr, Database: cfg.ClickHouseDB,
		User: cfg.ClickHouseUser, Password: cfg.ClickHousePass})
	if err != nil {
		return replayFail(res, "clickhouse: "+err.Error())
	}
	defer conn.Close()

	events, err := store.QueryLast(ctx, conn, cfg.ClickHouseDB, *source, *last)
	if err != nil {
		return replayFail(res, "query events: "+err.Error())
	}

	fields := map[string]*FieldDiff{}
	for _, e := range events {
		raw, ok := rawOf(oldEng, newEng, e)
		if !ok {
			continue // cannot reconstruct: nothing honest to diff
		}
		res.Events++
		m := pipeline.Message{Raw: raw, SourceID: e.SourceID,
			RecvMS: e.RecvTime.UnixMilli(), Topic: cfg.TopicRaw}
		oldOut := oldEng.Process(m)
		newOut := newEng.Process(m)

		ot, nt := templateOf(oldOut), templateOf(newOut)
		os_, ns := oldOut.Status, newOut.Status
		res.StatusTransitions[os_+"->"+ns]++

		switch {
		case ot == "" && nt != "":
			res.NewlyMatched++
		case ot != "" && nt == "":
			res.NoLongerMatched++
		case ot != nt:
			res.TemplateChanged++
		}
		if ot != nt && len(res.Templates) < *maxEx {
			res.Templates = append(res.Templates, TemplateChange{EventUID: e.EventUID,
				FromTemplate: ot, ToTemplate: nt})
		}
		if worse(os_, ns) {
			if len(res.Regressions) < *maxEx {
				res.Regressions = append(res.Regressions, Regression{EventUID: e.EventUID,
					FromStatus: os_, ToStatus: ns, FromTemplate: ot, ToTemplate: nt,
					Sample: truncate(string(raw), 300)})
			}
			res.Blocking = true
		}

		changed := diffFields(flat(oldOut.Result.Event), flat(newOut.Result.Event), fields, e.EventUID)
		if !changed && ot == nt {
			res.Unchanged++
		}
	}

	res.Fields = sortFields(fields)
	res.OK = res.Events > 0 && !res.Blocking
	emit(res)
	return code(res.OK)
}

// engineAt loads a pack version from PostgreSQL, or a directory when given.
func engineAt(ctx context.Context, pool *pgxpool.Pool, cfg *config.Config,
	envs map[string][]template.Token, srcs *registry.Sources, en *normalize.Enums,
	version uint32, dir string) (*pipeline.Engine, error) {

	if dir != "" {
		packs, err := registry.LoadDir(dir)
		if err != nil {
			return nil, err
		}
		eng, _ := pipeline.LoadPacks(packs, envs, srcs, en)
		return eng, nil
	}
	if pool == nil {
		// No registry database: fall back to the on-disk packs if they carry
		// the requested version, so replay still works in a local checkout.
		packs, err := registry.LoadDir(cfg.PacksDir)
		if err != nil {
			return nil, err
		}
		var keep []*registry.Pack
		for _, p := range packs {
			if p.Version == version {
				keep = append(keep, p)
			}
		}
		if len(keep) == 0 {
			return nil, fmt.Errorf("no ALETHEIA_PG_DSN and no pack at version %d in %s", version, cfg.PacksDir)
		}
		eng, _ := pipeline.LoadPacks(keep, envs, srcs, en)
		return eng, nil
	}
	packs, err := store.PacksAtVersion(ctx, pool, version)
	if err != nil {
		return nil, err
	}
	if len(packs) == 0 {
		return nil, fmt.Errorf("no packs at version %d in the registry", version)
	}
	eng, _ := pipeline.LoadPacks(packs, envs, srcs, en)
	return eng, nil
}

// rawOf recovers the original bytes: verbatim rows carry them, template rows
// reconstruct from whichever engine knows the template that stored them.
func rawOf(oldEng, newEng *pipeline.Engine, e store.Event) ([]byte, bool) {
	if e.RawVerbatim != nil && *e.RawVerbatim != "" {
		return []byte(*e.RawVerbatim), true
	}
	if e.TemplateID == "" {
		return nil, false
	}
	for _, eng := range []*pipeline.Engine{oldEng, newEng} {
		if entry := eng.Index.Find(e.TemplateID, e.EnvelopeID); entry != nil {
			if raw, err := reconstruct.Rebuild(entry.Tokens, e.Vars); err == nil {
				return raw, true
			}
		}
	}
	return nil, false
}

func templateOf(o *pipeline.Outcome) string {
	if o.Entry == nil {
		return ""
	}
	return o.Entry.Def.ID
}

// worse reports a parse_status regression: the reviewer's blocking signal.
func worse(from, to string) bool {
	rank := map[string]int{normalize.StatusFull: 3, normalize.StatusPartial: 2, normalize.StatusRawOnly: 1}
	return rank[to] < rank[from]
}

// flat renders an OCSF event as dotted path to scalar, ignoring provenance
// fields that change on every run.
func flat(ev map[string]any) map[string]string {
	out := map[string]string{}
	var walk func(prefix string, v any)
	walk = func(prefix string, v any) {
		switch x := v.(type) {
		case map[string]any:
			for k, vv := range x {
				walk(join(prefix, k), vv)
			}
		case map[string]string:
			for k, vv := range x {
				out[join(prefix, k)] = vv
			}
		default:
			b, err := json.Marshal(v)
			if err != nil {
				out[prefix] = fmt.Sprint(v)
				return
			}
			out[prefix] = string(b)
		}
	}
	walk("", ev)
	for k := range out {
		if strings.HasPrefix(k, "aletheia.") || k == "time" ||
			k == "metadata.uid" || k == "metadata.version" {
			delete(out, k)
		}
	}
	return out
}

func join(a, b string) string {
	if a == "" {
		return b
	}
	return a + "." + b
}

// diffFields accumulates per-path counts and keeps the first example.
func diffFields(a, b map[string]string, acc map[string]*FieldDiff, uid string) bool {
	any_ := false
	seen := map[string]bool{}
	for k, av := range a {
		seen[k] = true
		bv, ok := b[k]
		if ok && av == bv {
			continue
		}
		any_ = true
		d := entryFor(acc, k)
		if !ok {
			d.Removed++
		} else {
			d.Changed++
		}
		if d.Example == "" {
			d.Example, d.Before, d.After = uid, av, bv
		}
	}
	for k, bv := range b {
		if seen[k] {
			continue
		}
		any_ = true
		d := entryFor(acc, k)
		d.Added++
		if d.Example == "" {
			d.Example, d.Before, d.After = uid, "", bv
		}
	}
	return any_
}

func entryFor(acc map[string]*FieldDiff, path string) *FieldDiff {
	d, ok := acc[path]
	if !ok {
		d = &FieldDiff{Path: path}
		acc[path] = d
	}
	return d
}

func sortFields(acc map[string]*FieldDiff) []FieldDiff {
	out := make([]FieldDiff, 0, len(acc))
	for _, d := range acc {
		out = append(out, *d)
	}
	sort.Slice(out, func(i, j int) bool {
		li := out[i].Changed + out[i].Added + out[i].Removed
		lj := out[j].Changed + out[j].Added + out[j].Removed
		if li != lj {
			return li > lj
		}
		return out[i].Path < out[j].Path
	})
	return out
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func replayFail(res ReplayResult, reason string) int {
	res.OK, res.Error = false, reason
	if res.StatusTransitions == nil {
		res.StatusTransitions = map[string]int{}
	}
	if res.Templates == nil {
		res.Templates = []TemplateChange{}
	}
	if res.Fields == nil {
		res.Fields = []FieldDiff{}
	}
	if res.Regressions == nil {
		res.Regressions = []Regression{}
	}
	emit(res)
	return 1
}
