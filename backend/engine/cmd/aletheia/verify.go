package main

import (
	"context"
	"encoding/hex"
	"flag"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Ritesh2006M/aletheia/config"
	"github.com/Ritesh2006M/aletheia/merkle"
	"github.com/Ritesh2006M/aletheia/pipeline"
	"github.com/Ritesh2006M/aletheia/reconstruct"
	"github.com/Ritesh2006M/aletheia/sink"
	"github.com/Ritesh2006M/aletheia/stamp"
	"github.com/Ritesh2006M/aletheia/store"
)

// EventFailure names one stored event that did not re-verify.
type EventFailure struct {
	EventUID   string `json:"event_uid"`
	TemplateID string `json:"template_id,omitempty"`
	Batch      string `json:"merkle_batch,omitempty"`
	Reason     string `json:"reason"`
	Offset     int    `json:"offset"`
}

// BatchFailure names one Merkle batch whose root or chain did not recompute.
type BatchFailure struct {
	Batch         string `json:"batch"`
	Reason        string `json:"reason"`
	StoredRoot    string `json:"stored_root,omitempty"`
	ComputedRoot  string `json:"computed_root,omitempty"`
	StoredChain   string `json:"stored_chained_root,omitempty"`
	ComputedChain string `json:"computed_chained_root,omitempty"`
	LeavesStored  int    `json:"leaves_stored,omitempty"`
	LeavesFound   int    `json:"leaves_found,omitempty"`
}

// VerifyResult is the integrity report (spec §6.13).
type VerifyResult struct {
	OK       bool   `json:"ok"`
	Source   string `json:"source"`
	From     string `json:"from"`
	To       string `json:"to"`
	Events   int    `json:"events"`
	Verified int    `json:"verified"`
	Rebuilt  int    `json:"rebuilt"`
	Verbatim int    `json:"verbatim"`
	Batches  int    `json:"batches"`
	BatchOK  int    `json:"batches_ok"`
	ChainOK  bool   `json:"chain_ok"`

	FailedEvents  []EventFailure `json:"failed_events"`
	FailedBatches []BatchFailure `json:"failed_batches"`
	Error         string         `json:"error,omitempty"`
}

func cmdVerify(args []string) int {
	fs := flag.NewFlagSet("verify", flag.ContinueOnError)
	source := fs.String("source", "", "source id (required)")
	last := fs.String("last", "", "relative window, e.g. 15m")
	from := fs.String("from", "", "RFC3339 start")
	to := fs.String("to", "", "RFC3339 end")
	packsDir := fs.String("packs", "", "pack directory (default $ALETHEIA_PACKS_DIR)")
	limit := fs.Int("limit", 0, "cap on events examined, 0 for no cap")
	fs.Bool("json", true, "print JSON (always on)")
	if err := fs.Parse(args); err != nil {
		return verifyFail(VerifyResult{}, fmt.Sprintf("bad flags: %v", err))
	}

	res := VerifyResult{Source: *source, FailedEvents: []EventFailure{}, FailedBatches: []BatchFailure{}}
	if *source == "" {
		return verifyFail(res, "--source is required")
	}
	start, end, err := window(*last, *from, *to, 15*time.Minute)
	if err != nil {
		return verifyFail(res, err.Error())
	}
	res.From, res.To = start.Format(time.RFC3339), end.Format(time.RFC3339)

	cfg := config.Load()
	if *packsDir == "" {
		*packsDir = cfg.PacksDir
	}
	eng, _, err := pipeline.Load(pipeline.Paths{PacksDir: *packsDir, EnumsFile: cfg.EnumsFile()})
	if err != nil {
		return verifyFail(res, "load packs: "+err.Error())
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	conn, err := sink.Connect(ctx, sink.Options{Addr: cfg.ClickHouseAddr, Database: cfg.ClickHouseDB,
		User: cfg.ClickHouseUser, Password: cfg.ClickHousePass})
	if err != nil {
		return verifyFail(res, "clickhouse: "+err.Error())
	}
	defer conn.Close()

	events, err := store.QueryRange(ctx, conn, cfg.ClickHouseDB, *source, start, end, *limit)
	if err != nil {
		return verifyFail(res, "query events: "+err.Error())
	}

	// --- per event: rebuild (or read verbatim), rehash, compare -------------
	leaves := map[string]map[string][32]byte{} // batch -> uid -> raw_sha256
	for _, e := range events {
		res.Events++
		var raw []byte
		switch {
		case e.StorageMode == "verbatim" || e.TemplateID == "":
			if e.RawVerbatim == nil {
				res.FailedEvents = append(res.FailedEvents, EventFailure{EventUID: e.EventUID,
					Batch: e.MerkleBatch, Reason: "verbatim row with no raw_verbatim", Offset: -1})
				continue
			}
			raw = []byte(*e.RawVerbatim)
			res.Verbatim++
		default:
			entry := eng.Index.Find(e.TemplateID, e.EnvelopeID)
			if entry == nil {
				res.FailedEvents = append(res.FailedEvents, EventFailure{EventUID: e.EventUID,
					TemplateID: e.TemplateID, Batch: e.MerkleBatch, Offset: -1,
					Reason: fmt.Sprintf("template %q@%q not in the loaded packs", e.TemplateID, e.EnvelopeID)})
				continue
			}
			raw, err = reconstruct.Rebuild(entry.Tokens, e.Vars)
			if err != nil {
				res.FailedEvents = append(res.FailedEvents, EventFailure{EventUID: e.EventUID,
					TemplateID: e.TemplateID, Batch: e.MerkleBatch, Reason: err.Error(), Offset: -1})
				continue
			}
			res.Rebuilt++
		}

		want, ok := sha32(e.RawSHA256)
		if !ok {
			res.FailedEvents = append(res.FailedEvents, EventFailure{EventUID: e.EventUID,
				TemplateID: e.TemplateID, Batch: e.MerkleBatch, Offset: -1,
				Reason: "stored raw_sha256 is not 32 bytes"})
			continue
		}
		got := stamp.SHA256(raw)
		if got != want {
			res.FailedEvents = append(res.FailedEvents, EventFailure{EventUID: e.EventUID,
				TemplateID: e.TemplateID, Batch: e.MerkleBatch, Offset: -1,
				Reason: fmt.Sprintf("hash mismatch: stored %s, recomputed %s",
					hex.EncodeToString(want[:]), stamp.Hex(got))})
			continue
		}
		res.Verified++
		if leaves[e.MerkleBatch] == nil {
			leaves[e.MerkleBatch] = map[string][32]byte{}
		}
		leaves[e.MerkleBatch][e.EventUID] = want
	}

	// --- per batch: recompute root and chain, compare with PostgreSQL -------
	res.ChainOK = true
	if cfg.PostgresDSN == "" {
		res.FailedBatches = append(res.FailedBatches, BatchFailure{Batch: "-",
			Reason: "no ALETHEIA_PG_DSN: Merkle roots could not be checked"})
		res.ChainOK = false
	} else {
		pool, err := store.OpenPG(ctx, cfg.PostgresDSN)
		if err != nil {
			return verifyFail(res, "postgres: "+err.Error())
		}
		defer pool.Close()
		verifyBatches(ctx, pool, &res, *source, start, end, leaves)
	}

	res.OK = len(res.FailedEvents) == 0 && len(res.FailedBatches) == 0 &&
		res.ChainOK && res.Events > 0
	emit(res)
	return code(res.OK)
}

// verifyBatches recomputes every root in the window and walks the hash chain.
func verifyBatches(ctx context.Context, pool *pgxpool.Pool, res *VerifyResult,
	source string, start, end time.Time, leaves map[string]map[string][32]byte) {

	batches, err := store.Batches(ctx, pool, source, start.Truncate(time.Minute), end)
	if err != nil {
		res.FailedBatches = append(res.FailedBatches, BatchFailure{Batch: "-",
			Reason: "query merkle_batches: " + err.Error()})
		res.ChainOK = false
		return
	}
	// Chain state per partition, seeded from the batch before the window.
	prev := map[int32][32]byte{}
	seeded := map[int32]bool{}

	sort.SliceStable(batches, func(i, j int) bool {
		if batches[i].Partition != batches[j].Partition {
			return batches[i].Partition < batches[j].Partition
		}
		return batches[i].Minute.Before(batches[j].Minute)
	})

	for _, b := range batches {
		res.Batches++
		key := b.Key()
		name := key.String()
		if !seeded[b.Partition] {
			h, _, _ := store.PrevChained(ctx, pool, source, b.Partition, b.Minute)
			prev[b.Partition] = h
			seeded[b.Partition] = true
		}
		var storedRoot, storedChain [32]byte
		if len(b.Root) != 32 || len(b.ChainedRoot) != 32 {
			res.FailedBatches = append(res.FailedBatches, BatchFailure{Batch: name,
				Reason: "stored root or chained root is not 32 bytes"})
			res.ChainOK = false
			continue
		}
		copy(storedRoot[:], b.Root)
		copy(storedChain[:], b.ChainedRoot)

		found := leaves[name]
		root, chained, ok := merkle.VerifyBatch(key, found, prev[b.Partition], storedRoot, storedChain)
		prev[b.Partition] = storedChain // keep walking the stored chain either way

		if len(found) != b.LeafCount {
			res.FailedBatches = append(res.FailedBatches, BatchFailure{Batch: name,
				Reason:       "leaf count differs: the stored events do not account for the sealed batch",
				LeavesStored: b.LeafCount, LeavesFound: len(found),
				StoredRoot: hex.EncodeToString(storedRoot[:]), ComputedRoot: hex.EncodeToString(root[:])})
			res.ChainOK = false
			continue
		}
		if !ok {
			f := BatchFailure{Batch: name, LeavesStored: b.LeafCount, LeavesFound: len(found),
				StoredRoot: hex.EncodeToString(storedRoot[:]), ComputedRoot: hex.EncodeToString(root[:]),
				StoredChain: hex.EncodeToString(storedChain[:]), ComputedChain: hex.EncodeToString(chained[:])}
			if root != storedRoot {
				f.Reason = "root mismatch: the events in this batch are not the ones that were sealed"
			} else {
				f.Reason = "chained root mismatch: the batch sequence has been altered"
			}
			res.FailedBatches = append(res.FailedBatches, f)
			res.ChainOK = false
			continue
		}
		res.BatchOK++
	}
	// Events whose batch was never sealed are reported, not silently passed.
	sealed := map[string]bool{}
	for _, b := range batches {
		sealed[b.Key().String()] = true
	}
	names := make([]string, 0, len(leaves))
	for n := range leaves {
		if !sealed[n] {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	for _, n := range names {
		res.FailedBatches = append(res.FailedBatches, BatchFailure{Batch: n,
			Reason: "events present but no sealed batch in PostgreSQL", LeavesFound: len(leaves[n])})
		res.ChainOK = false
	}
}

func sha32(s string) ([32]byte, bool) {
	var out [32]byte
	if len(s) != 32 {
		return out, false
	}
	copy(out[:], s)
	return out, true
}

// window resolves --last or --from/--to into a concrete UTC range.
func window(last, from, to string, def time.Duration) (time.Time, time.Time, error) {
	now := time.Now().UTC()
	if from != "" || to != "" {
		start, end := now.Add(-def), now
		var err error
		if from != "" {
			if start, err = time.Parse(time.RFC3339, from); err != nil {
				return start, end, fmt.Errorf("--from: %w", err)
			}
		}
		if to != "" {
			if end, err = time.Parse(time.RFC3339, to); err != nil {
				return start, end, fmt.Errorf("--to: %w", err)
			}
		}
		if !end.After(start) {
			return start, end, fmt.Errorf("--to must be after --from")
		}
		return start.UTC(), end.UTC(), nil
	}
	d := def
	if last != "" {
		var err error
		if d, err = time.ParseDuration(last); err != nil {
			return now, now, fmt.Errorf("--last: %w", err)
		}
	}
	return now.Add(-d), now, nil
}

func verifyFail(res VerifyResult, reason string) int {
	res.OK = false
	res.Error = reason
	if res.FailedEvents == nil {
		res.FailedEvents = []EventFailure{}
	}
	if res.FailedBatches == nil {
		res.FailedBatches = []BatchFailure{}
	}
	emit(res)
	return 1
}
