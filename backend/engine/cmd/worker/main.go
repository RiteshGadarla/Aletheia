// Command aletheia-worker is the streaming pipeline of spec §8.1: consume
// `raw`, stamp identity and integrity, decode the envelope, match a template,
// reconstruct and verify, normalize to OCSF, batch-insert into ClickHouse and
// publish to `normalized`. Offsets commit only after a successful insert, and
// nothing is ever dropped (CONTRACTS §10).
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Ritesh2006M/aletheia/config"
	"github.com/Ritesh2006M/aletheia/store"
)

var version = "dev"

const usage = `aletheia-worker — Aletheia streaming pipeline

  aletheia-worker [-role worker|sealer] [-packs DIR] [-brokers a,b] [-metrics :9108]

Configuration is ALETHEIA_* environment variables (see config.Load); the flags
below override the ones you change most often.

  -role      worker (default) runs the pipeline; sealer runs only the Merkle sealer
  -packs     parser pack directory            (ALETHEIA_PACKS_DIR)
  -brokers   comma-separated bus brokers      (ALETHEIA_BUS_BROKERS)
  -group     consumer group                   (ALETHEIA_CONSUMER_GROUP)
  -metrics   Prometheus listen address        (ALETHEIA_METRICS_ADDR)
  -drain     exit after this long with no new records (0 = run forever)
  -version   print the version and exit
`

func main() {
	fs := flag.NewFlagSet("aletheia-worker", flag.ContinueOnError)
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	role := fs.String("role", "", "worker|sealer")
	packs := fs.String("packs", "", "parser pack directory")
	brokers := fs.String("brokers", "", "comma-separated bus brokers")
	group := fs.String("group", "", "consumer group")
	metrics := fs.String("metrics", "", "Prometheus listen address")
	drain := fs.Duration("drain", 0, "exit after this long with no new records")
	showVersion := fs.Bool("version", false, "print version and exit")
	if err := fs.Parse(os.Args[1:]); err != nil {
		os.Exit(2)
	}
	if *showVersion {
		fmt.Println(version)
		return
	}

	cfg := config.Load()
	if *role != "" {
		cfg.Role = *role
	}
	if *packs != "" {
		cfg.PacksDir = *packs
		cfg.EnvelopeFile = *packs + "/_envelopes.yaml"
		cfg.SourcesFile = *packs + "/_sources.yaml"
	}
	if *brokers != "" {
		cfg.Brokers = splitList(*brokers)
	}
	if *group != "" {
		cfg.ConsumerGroup = *group
	}
	if *metrics != "" {
		cfg.MetricsAddr = *metrics
	}

	if err := run(cfg, *drain); err != nil {
		logf("fatal: %v", err)
		os.Exit(1)
	}
}

func run(cfg *config.Config, drain time.Duration) error {
	log.SetFlags(0)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	met := NewMetrics()
	srv := serveMetrics(cfg.MetricsAddr, met)
	defer func() {
		sc, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(sc)
	}()
	logf("metrics on %s/metrics", cfg.MetricsAddr)

	pool := openPG(ctx, cfg)
	if pool != nil {
		defer pool.Close()
	}

	sl := NewSealer(ctx, pool, cfg.SealGrace, met)

	if cfg.Role == config.RoleSealer {
		// Sealer-only mode has no leaves of its own; it exists so a deployment
		// can run sealing in a separate process from the pipeline.
		logf("role=sealer grace=%s", cfg.SealGrace)
		sl.Run(ctx, sealInterval(cfg.SealGrace))
		return nil
	}

	eng, err := buildEngine(ctx, cfg, pool, 0)
	if err != nil {
		return fmt.Errorf("load packs from %s: %w", cfg.PacksDir, err)
	}
	met.Index(eng.Index.Len(), len(eng.Index.Packs()), false)
	logf("loaded %d templates from %d packs (%s)", eng.Index.Len(), len(eng.Index.Packs()), cfg.PacksDir)

	w, err := NewWorker(ctx, cfg, eng, met, sl, drain)
	if err != nil {
		return err
	}

	// Record the live template set so stored events can always be rebuilt with
	// the exact version that produced them (spec §6.10).
	tctx, tcancel := context.WithTimeout(ctx, 30*time.Second)
	if err := w.bat.InsertTemplates(tctx, eng.Index.Packs()); err != nil {
		logf("templates table: %v", err)
	}
	tcancel()

	go sl.Run(ctx, sealInterval(cfg.SealGrace))
	go watchControl(ctx, cfg, w, pool)

	logf("worker %s consuming %s group=%s brokers=%v batch=%d/%s",
		cfg.WorkerID, cfg.TopicRaw, cfg.ConsumerGroup, cfg.Brokers, cfg.BatchRows, cfg.BatchInterval)

	runErr := w.Run(ctx)

	// Shut down on a fresh context: the signal context is already cancelled.
	sctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	w.Close(sctx)
	if n := met.Mismatches(); n > 0 {
		logf("WARNING: %d reconstruct mismatches — engine defect, see the dlq topic", n)
	}
	return runErr
}

// openPG connects to PostgreSQL for Merkle roots. Absent or unreachable, the
// pipeline still runs: roots stay in memory and the fact is logged.
func openPG(ctx context.Context, cfg *config.Config) *pgxpool.Pool {
	if cfg.PostgresDSN == "" {
		logf("no PostgreSQL DSN: merkle roots will not be persisted")
		return nil
	}
	c, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	pool, err := store.OpenPG(c, cfg.PostgresDSN)
	if err != nil {
		logf("postgres unavailable, merkle roots will not be persisted: %v", err)
		return nil
	}
	return pool
}

// sealInterval checks for due batches often enough to keep seal delay near the
// grace window, and at least once a minute.
func sealInterval(grace time.Duration) time.Duration {
	d := grace / 4
	if d > time.Minute {
		d = time.Minute
	}
	if d < 5*time.Second {
		d = 5 * time.Second
	}
	return d
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// logf writes one diagnostic line to stderr.
func logf(format string, args ...any) {
	log.Printf("%s aletheia-worker: %s", time.Now().UTC().Format(time.RFC3339), fmt.Sprintf(format, args...))
}
