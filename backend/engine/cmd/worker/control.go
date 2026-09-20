package main

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/twmb/franz-go/pkg/kgo"

	"github.com/Ritesh2006M/aletheia/config"
	"github.com/Ritesh2006M/aletheia/normalize"
	"github.com/Ritesh2006M/aletheia/pipeline"
	"github.com/Ritesh2006M/aletheia/registry"
	"github.com/Ritesh2006M/aletheia/store"
)

// ControlMsg is what the registry publishes on approval (spec §6.10).
type ControlMsg struct {
	PackID   string `json:"pack_id"`
	Version  uint32 `json:"version"`
	Checksum string `json:"checksum"`
}

// watchControl rebuilds the matcher index in the background on every control
// message and atomically swaps it in. In-flight events finish on the old index.
func watchControl(ctx context.Context, cfg *config.Config, w *Worker, pool *pgxpool.Pool) {
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(cfg.Brokers...),
		kgo.ConsumeTopics(cfg.TopicControl),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtEnd()),
		kgo.ClientID("aletheia-control/"+cfg.WorkerID),
	)
	if err != nil {
		logf("control: listener disabled: %v", err)
		return
	}
	defer cl.Close()
	logf("control: listening on %s", cfg.TopicControl)

	for ctx.Err() == nil {
		fs := cl.PollFetches(ctx)
		if fs.IsClientClosed() {
			return
		}
		for _, e := range fs.Errors() {
			if errors.Is(e.Err, context.Canceled) {
				return
			}
			logf("control fetch: %v", e.Err)
		}
		var last *ControlMsg
		fs.EachRecord(func(r *kgo.Record) {
			var m ControlMsg
			if err := json.Unmarshal(r.Value, &m); err != nil {
				logf("control: unparseable message: %v", err)
				return
			}
			last = &m
		})
		if last == nil {
			continue
		}
		// Coalesce a burst of approvals into one rebuild.
		time.Sleep(200 * time.Millisecond)
		reload(ctx, cfg, w, pool, *last)
	}
}

// reload compiles a fresh engine and swaps it in. A failed build leaves the
// live index untouched.
func reload(ctx context.Context, cfg *config.Config, w *Worker, pool *pgxpool.Pool, m ControlMsg) {
	start := time.Now()
	eng, err := buildEngine(ctx, cfg, pool, m.Version)
	if err != nil {
		logf("control: reload for pack=%s version=%d failed, keeping live index: %v", m.PackID, m.Version, err)
		return
	}
	w.Swap(eng)
	logf("control: reloaded pack=%s version=%d — %d templates from %d packs in %s",
		m.PackID, m.Version, eng.Index.Len(), len(eng.Index.Packs()), time.Since(start).Round(time.Millisecond))
}

// buildEngine compiles the index from PostgreSQL at the requested version, and
// from the pack directory otherwise.
func buildEngine(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, version uint32) (*pipeline.Engine, error) {
	if pool != nil && version > 0 {
		c, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		packs, err := store.PacksAtVersion(c, pool, version)
		if err == nil && len(packs) > 0 {
			envs, eerr := pipeline.LoadEnvelopes(cfg.EnvelopeFile)
			if eerr != nil {
				return nil, eerr
			}
			srcs, serr := registry.LoadSources(cfg.SourcesFile)
			if serr != nil {
				return nil, serr
			}
			eng, warn := pipeline.LoadPacks(packs, envs, srcs, loadEnums(cfg))
			logWarn("control", warn)
			return eng, nil
		}
		if err != nil {
			logf("control: packs at version %d unreadable, falling back to %s: %v", version, cfg.PacksDir, err)
		}
	}
	eng, warn, err := pipeline.Load(pipeline.Paths{
		PacksDir:     cfg.PacksDir,
		EnvelopeFile: cfg.EnvelopeFile,
		SourcesFile:  cfg.SourcesFile,
		EnumsFile:    cfg.EnumsFile(),
	})
	if err != nil {
		return nil, err
	}
	logWarn("packs", warn)
	return eng, nil
}

// loadEnums reads the shared OCSF enum table, falling back to the built-in one.
func loadEnums(cfg *config.Config) *normalize.Enums {
	en, err := normalize.LoadEnums(cfg.EnumsFile())
	if err != nil {
		return normalize.Default
	}
	return en
}

// logWarn reports compile warnings without aborting: a broken template never
// stops the rest of the index from loading.
func logWarn(scope string, warn []error) {
	for _, e := range warn {
		logf("%s: %v", scope, e)
	}
}
