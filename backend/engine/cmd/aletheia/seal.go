package main

import (
	"context"
	"encoding/hex"
	"flag"
	"fmt"
	"sort"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Ritesh2006M/aletheia/config"
	"github.com/Ritesh2006M/aletheia/merkle"
	"github.com/Ritesh2006M/aletheia/sink"
	"github.com/Ritesh2006M/aletheia/store"
)

// SealedRef is one batch this run wrote.
type SealedRef struct {
	Batch       string `json:"batch"`
	Leaves      int    `json:"leaves"`
	Root        string `json:"root"`
	ChainedRoot string `json:"chained_root"`
}

// SealResult is the report of a seal run.
type SealResult struct {
	OK      bool        `json:"ok"`
	Sources []string    `json:"sources"`
	From    string      `json:"from"`
	To      string      `json:"to"`
	Events  int         `json:"events"`
	Batches int         `json:"batches"`
	Skipped int         `json:"skipped_unparseable"`
	Sealed  []SealedRef `json:"sealed"`
	Error   string      `json:"error,omitempty"`
	DryRun  bool        `json:"dry_run"`
}

// cmdSeal seals the Merkle batches of events already in ClickHouse. The worker
// seals from the arrival hash on the hot path; this reaches the same batches
// for a corpus that was loaded without the bus.
func cmdSeal(args []string) int {
	fs := flag.NewFlagSet("seal", flag.ContinueOnError)
	source := fs.String("source", "", "source id; empty seals every source in the window")
	last := fs.String("last", "", "relative window, e.g. 24h")
	from := fs.String("from", "", "RFC3339 start")
	to := fs.String("to", "", "RFC3339 end")
	dry := fs.Bool("dry-run", false, "compute roots but write nothing")
	fs.Bool("json", true, "print JSON (always on)")
	if err := fs.Parse(args); err != nil {
		return sealFail(SealResult{}, fmt.Sprintf("bad flags: %v", err))
	}

	res := SealResult{Sources: []string{}, Sealed: []SealedRef{}, DryRun: *dry}
	start, end, err := window(*last, *from, *to, 24*time.Hour)
	if err != nil {
		return sealFail(res, err.Error())
	}
	res.From, res.To = start.Format(time.RFC3339), end.Format(time.RFC3339)

	cfg := config.Load()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	conn, err := sink.Connect(ctx, sink.Options{Addr: cfg.ClickHouseAddr, Database: cfg.ClickHouseDB,
		User: cfg.ClickHouseUser, Password: cfg.ClickHousePass})
	if err != nil {
		return sealFail(res, "clickhouse: "+err.Error())
	}
	defer conn.Close()

	sources := []string{*source}
	if *source == "" {
		if sources, err = distinctSources(ctx, conn, cfg.ClickHouseDB, start, end); err != nil {
			return sealFail(res, "list sources: "+err.Error())
		}
	}
	res.Sources = sources

	if cfg.PostgresDSN == "" {
		return sealFail(res, "no ALETHEIA_PG_DSN: nowhere to persist the roots")
	}
	pool, err := store.OpenPG(ctx, cfg.PostgresDSN)
	if err != nil {
		return sealFail(res, "postgres: "+err.Error())
	}
	defer pool.Close()

	for _, src := range sources {
		if err := sealSource(ctx, conn, pool, cfg, src, start, end, *dry, &res); err != nil {
			return sealFail(res, err.Error())
		}
	}
	res.OK = res.Batches > 0
	if !res.OK {
		res.Error = "no batches to seal in this window"
	}
	emit(res)
	return code(res.OK)
}

// sealSource groups one source's events into their stored Merkle batches,
// rebuilds root and chained root per CONTRACTS §4 and upserts them.
func sealSource(ctx context.Context, conn driver.Conn, pool *pgxpool.Pool, cfg *config.Config,
	src string, start, end time.Time, dry bool, res *SealResult) error {

	events, err := store.QueryRange(ctx, conn, cfg.ClickHouseDB, src, start, end, 0)
	if err != nil {
		return fmt.Errorf("query events for %s: %w", src, err)
	}
	// uid -> raw_sha256 per batch: redelivered rows collapse, exactly as the
	// streaming sealer's per-batch leaf map does.
	byBatch := map[string]map[string][32]byte{}
	keys := map[string]merkle.Key{}
	for _, e := range events {
		res.Events++
		k, err := merkle.ParseKey(e.MerkleBatch)
		if err != nil {
			res.Skipped++
			continue
		}
		h, ok := sha32(e.RawSHA256)
		if !ok {
			res.Skipped++
			continue
		}
		if byBatch[e.MerkleBatch] == nil {
			byBatch[e.MerkleBatch] = map[string][32]byte{}
			keys[e.MerkleBatch] = k
		}
		byBatch[e.MerkleBatch][e.EventUID] = h
	}

	// One chain per partition, walked in minute order and seeded from the
	// batch that already precedes the window.
	byPart := map[int32][]string{}
	for name, k := range keys {
		byPart[k.Partition] = append(byPart[k.Partition], name)
	}
	parts := make([]int32, 0, len(byPart))
	for p := range byPart {
		parts = append(parts, p)
	}
	sort.Slice(parts, func(i, j int) bool { return parts[i] < parts[j] })

	for _, p := range parts {
		names := byPart[p]
		sort.Slice(names, func(i, j int) bool { return keys[names[i]].Minute.Before(keys[names[j]].Minute) })
		prev, _, _ := store.PrevChained(ctx, pool, src, p, keys[names[0]].Minute)
		for _, name := range names {
			k := keys[name]
			leaves := byBatch[name]
			uids := make([]string, 0, len(leaves))
			for u := range leaves {
				uids = append(uids, u)
			}
			sort.Strings(uids) // leaves ordered by event_uid (CONTRACTS §4)
			hs := make([][32]byte, len(uids))
			for i, u := range uids {
				hs[i] = leaves[u]
			}
			root := merkle.Root(hs)
			chained := merkle.Chain(prev, root, k)
			prev = chained
			res.Batches++
			res.Sealed = append(res.Sealed, SealedRef{Batch: name, Leaves: len(uids),
				Root: hex.EncodeToString(root[:]), ChainedRoot: hex.EncodeToString(chained[:])})
			if dry {
				continue
			}
			b := store.SealedBatch{SourceID: k.SourceID, Partition: k.Partition, Minute: k.Minute,
				LeafCount: len(uids), Root: root[:], SealedAt: time.Now().UTC()}
			// The store chains from the stored predecessor and repairs the rest
			// of the chain, so sealing a window twice is idempotent.
			if _, err := store.SealAndChain(ctx, pool, b); err != nil {
				return fmt.Errorf("seal %s: %w", name, err)
			}
		}
	}
	return nil
}

// distinctSources lists the sources that have events in the window.
func distinctSources(ctx context.Context, conn driver.Conn, db string, start, end time.Time) ([]string, error) {
	rows, err := conn.Query(ctx, fmt.Sprintf(
		`SELECT DISTINCT source_id FROM %s.events WHERE recv_time >= ? AND recv_time < ? ORDER BY source_id`, db),
		start, end)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func sealFail(res SealResult, reason string) int {
	res.OK = false
	res.Error = reason
	if res.Sources == nil {
		res.Sources = []string{}
	}
	if res.Sealed == nil {
		res.Sealed = []SealedRef{}
	}
	emit(res)
	return 1
}
