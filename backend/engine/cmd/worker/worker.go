package main

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"

	"github.com/Ritesh2006M/aletheia/config"
	"github.com/Ritesh2006M/aletheia/normalize"
	"github.com/Ritesh2006M/aletheia/pipeline"
	"github.com/Ritesh2006M/aletheia/registry"
	"github.com/Ritesh2006M/aletheia/sink"
	"github.com/Ritesh2006M/aletheia/stamp"
)

// Worker is one member of the consumer group: the streaming face of spec §8.1.
type Worker struct {
	cfg *config.Config
	met *Metrics

	eng atomic.Pointer[pipeline.Engine] // hot-swapped by the control listener
	cl  *kgo.Client
	pub *sink.Publisher
	bat *sink.Batcher
	sl  *Sealer

	commitMu sync.Mutex
	idle     time.Duration // >0: exit after this long with no records (drain mode)
	nDone    atomic.Uint64 // records handled, so drain can report what it actually did
}

// NewWorker wires the consumer, the ClickHouse batcher and the publisher.
func NewWorker(ctx context.Context, cfg *config.Config, eng *pipeline.Engine,
	met *Metrics, sl *Sealer, idle time.Duration) (*Worker, error) {

	w := &Worker{cfg: cfg, met: met, sl: sl, idle: idle}
	w.eng.Store(eng)

	pub, err := sink.NewPublisher(cfg.Brokers)
	if err != nil {
		return nil, err
	}
	w.pub = pub

	bat, err := sink.NewBatcher(ctx, sink.Options{
		Addr:     cfg.ClickHouseAddr,
		Database: cfg.ClickHouseDB,
		User:     cfg.ClickHouseUser,
		Password: cfg.ClickHousePass,
		MaxRows:  cfg.BatchRows,
		Interval: cfg.BatchInterval,
		OnFlush:  w.onFlush,
	})
	if err != nil {
		pub.Close()
		return nil, err
	}
	w.bat = bat

	// Offsets are committed by hand, only after a successful insert (§12.3).
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(cfg.Brokers...),
		kgo.ConsumerGroup(cfg.ConsumerGroup),
		kgo.ConsumeTopics(cfg.TopicRaw),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
		kgo.DisableAutoCommit(),
		kgo.FetchMaxWait(500*time.Millisecond),
		kgo.OnPartitionsRevoked(w.onRevoked),
		kgo.ClientID("aletheia-worker/"+cfg.WorkerID),
	)
	if err != nil {
		_ = bat.Close()
		pub.Close()
		return nil, err
	}
	w.cl = cl
	return w, nil
}

// Engine returns the live engine. Callers keep their pointer for the whole
// event, so a reload never changes an index mid-flight.
func (w *Worker) Engine() *pipeline.Engine { return w.eng.Load() }

// Swap installs a freshly compiled engine (§6.10 hot reload).
func (w *Worker) Swap(e *pipeline.Engine) {
	w.eng.Store(e)
	w.met.Index(e.Index.Len(), len(e.Index.Packs()), true)
}

// Run consumes until ctx is cancelled, or until the idle window elapses in
// drain mode.
func (w *Worker) Run(ctx context.Context) error {
	for {
		if ctx.Err() != nil {
			return nil
		}
		pollCtx := ctx
		var cancel context.CancelFunc
		if w.idle > 0 {
			pollCtx, cancel = context.WithTimeout(ctx, w.idle)
		}
		fs := w.cl.PollFetches(pollCtx)
		if cancel != nil {
			cancel()
		}
		if fs.IsClientClosed() {
			return nil
		}
		for _, e := range fs.Errors() {
			if errors.Is(e.Err, context.Canceled) || errors.Is(e.Err, context.DeadlineExceeded) {
				continue
			}
			logf("fetch %s/%d: %v", e.Topic, e.Partition, e.Err)
		}
		if fs.NumRecords() == 0 {
			if ctx.Err() != nil {
				return nil
			}
			if w.idle > 0 {
				// Say what was processed: "no records" alone reads as "did
				// nothing", which is wrong after a full batch has gone through.
				logf("drain: %d records processed, none new for %s, stopping",
					w.nDone.Load(), w.idle)
				return nil
			}
			continue
		}
		w.consume(fs)
		w.backpressure(ctx)
	}
}

// consume processes one poll. Partitions run in parallel; within a partition
// records stay in offset order, so any flush cut is a per-partition prefix and
// committing the highest offset in the batch can never skip a row.
func (w *Worker) consume(fs kgo.Fetches) {
	var wg sync.WaitGroup
	fs.EachPartition(func(p kgo.FetchTopicPartition) {
		if len(p.Records) == 0 {
			return
		}
		wg.Add(1)
		go func(p kgo.FetchTopicPartition) {
			defer wg.Done()
			for _, r := range p.Records {
				w.handle(r)
			}
			w.nDone.Add(uint64(len(p.Records)))
			last := p.Records[len(p.Records)-1]
			w.met.Lag(p.Partition, p.HighWatermark-last.Offset-1)
		}(p)
	})
	wg.Wait()
	w.met.BusError(w.pub.Errors())
}

// handle runs the §8.1 loop for one raw message. Nothing is ever dropped: an
// unmatched or defective event still becomes a row and still reaches the bus.
func (w *Worker) handle(r *kgo.Record) {
	eng := w.Engine()
	src := w.sourceID(eng, r)
	recvMS := recvMS(r)

	o := eng.Process(pipeline.Message{
		Raw:       r.Value,
		SourceID:  src,
		RecvMS:    recvMS,
		Topic:     r.Topic,
		Partition: r.Partition,
		Offset:    r.Offset,
	})

	// Merkle leaf is registered from the arrival hash, before anything else can
	// go wrong downstream (§6.3).
	w.sl.Add(o.MerkleKey, o.UID, o.RawSHA)

	ref := []kgo.RecordHeader{
		{Key: "pr_event_uid", Value: []byte(o.UID)},
		{Key: "pr_raw_sha256", Value: []byte(stamp.Hex(o.RawSHA))},
		{Key: config.HeaderRecvMS, Value: []byte(strconv.FormatInt(recvMS, 10))},
		{Key: config.HeaderSourceID, Value: []byte(src)},
		{Key: "pr_offset", Value: []byte(strconv.FormatInt(r.Offset, 10))},
		{Key: "pr_partition", Value: []byte(strconv.FormatInt(int64(r.Partition), 10))},
		{Key: "pr_merkle_batch", Value: []byte(o.MerkleBatch)},
	}

	switch {
	case o.Quarantine:
		// Normal path, not an error path: the raw bytes go to `quarantine`
		// unwrapped (CONTRACTS §3) with the reference in headers.
		w.pub.Publish(w.cfg.TopicQuar, src, r.Value, ref...)
	case o.Mismatch:
		// Should never fire. An engine defect, not a data problem.
		logf("RECONSTRUCT MISMATCH uid=%s template=%s offset=%d", o.UID, o.Result.Row.TemplateID, o.MismatchOffset)
		w.pub.Publish(w.cfg.TopicDLQ, src, dlqRecord(o, r, src, recvMS), ref...)
	}

	if js, err := o.JSON(); err == nil {
		w.pub.Publish(w.cfg.TopicNorm, src, js, ref...)
	} else {
		logf("normalized marshal uid=%s: %v", o.UID, err)
	}

	// The row carries the Kafka record as its mark: the batcher hands it back
	// on flush success and only then is the offset committed.
	w.bat.Add(o.Result.Row, r)
	w.met.Event(src, o.Status, o.Verified, o.Quarantine, o.Mismatch)
}

// onFlush commits the offsets of an inserted batch (§12.3). A failed insert
// commits nothing, so the bus replays and deterministic uids dedupe the rows.
func (w *Worker) onFlush(marks []any, rows int, took time.Duration, err error) {
	w.met.Insert(took, rows, err)
	if err != nil {
		logf("clickhouse insert of %d rows failed, will retry: %v", rows, err)
		return
	}
	recs := make([]*kgo.Record, 0, len(marks))
	for _, m := range marks {
		if r, ok := m.(*kgo.Record); ok {
			recs = append(recs, r)
		}
	}
	if len(recs) == 0 {
		return
	}
	w.commitMu.Lock()
	defer w.commitMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cerr := w.cl.CommitRecords(ctx, recs...)
	w.met.Commit(cerr)
	if cerr != nil {
		logf("commit %d offsets: %v", len(recs), cerr)
	}
}

// onRevoked flushes before losing partitions so committed offsets stay behind
// inserted rows rather than ahead of them.
func (w *Worker) onRevoked(_ context.Context, _ *kgo.Client, _ map[string][]int32) {
	w.bat.Flush()
}

// backpressure stalls consumption while ClickHouse is behind. Redpanda keeps
// the data; the lag metric is the alert (§12.3).
func (w *Worker) backpressure(ctx context.Context) {
	high := w.cfg.BatchRows * 4
	for w.bat.Pending() > high {
		select {
		case <-ctx.Done():
			return
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// Close drains everything in order: stop consuming, flush the last rows, seal
// the open Merkle batches, then let the producer finish.
func (w *Worker) Close(ctx context.Context) {
	w.cl.Close()
	for i := 0; i < 30 && w.bat.Pending() > 0; i++ {
		w.bat.Flush()
		if w.bat.Pending() > 0 {
			time.Sleep(time.Second)
		}
	}
	if n := w.bat.Pending(); n > 0 {
		logf("WARNING: %d rows never inserted; their offsets stay uncommitted and the bus will replay them", n)
	}
	if err := w.bat.Close(); err != nil {
		logf("batcher close: %v", err)
	}
	w.sl.Drain(ctx)
	if err := w.pub.Flush(ctx); err != nil {
		logf("publisher flush: %v", err)
	}
	w.pub.Close()
}

// sourceID resolves the source: record key first (CONTRACTS §3), then the
// explicit header, then the registry's peer list, then "unknown".
func (w *Worker) sourceID(eng *pipeline.Engine, r *kgo.Record) string {
	if len(r.Key) > 0 {
		return string(r.Key)
	}
	if v := header(r, config.HeaderSourceID); v != "" {
		return v
	}
	if peer := header(r, config.HeaderPeer); peer != "" && eng.Sources != nil {
		if id := matchPeer(eng.Sources, peer); id != "" {
			return id
		}
	}
	return "unknown"
}

// matchPeer finds a registered source by sender address.
func matchPeer(srcs *registry.Sources, peer string) string {
	ip := peer
	if i := strings.LastIndex(peer, ":"); i > 0 {
		ip = peer[:i]
	}
	for _, s := range srcs.All() {
		for _, p := range s.Peers {
			if p == peer || p == ip {
				return s.SourceID
			}
		}
	}
	return ""
}

// recvMS reads the collector receive time, falling back to the bus timestamp.
func recvMS(r *kgo.Record) int64 {
	if v := header(r, config.HeaderRecvMS); v != "" {
		if ms, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil && ms > 0 {
			return ms
		}
	}
	if !r.Timestamp.IsZero() {
		return r.Timestamp.UnixMilli()
	}
	return time.Now().UnixMilli()
}

func header(r *kgo.Record, key string) string {
	for _, h := range r.Headers {
		if h.Key == key {
			return string(h.Value)
		}
	}
	return ""
}

// dlqRecord describes a reconstruction mismatch with enough context to debug it.
func dlqRecord(o *pipeline.Outcome, r *kgo.Record, src string, recvMS int64) []byte {
	b, err := json.Marshal(map[string]any{
		"error":         "reconstruct_mismatch",
		"event_uid":     o.UID,
		"source_id":     src,
		"template_id":   o.Result.Row.TemplateID,
		"recv_ms":       recvMS,
		"topic":         r.Topic,
		"partition":     r.Partition,
		"offset":        r.Offset,
		"raw_sha256":    stamp.Hex(o.RawSHA),
		"first_diff":    o.MismatchOffset,
		"raw":           string(r.Value),
		"reconstructed": string(o.Rebuilt),
		"storage_mode":  normalize.ModeVerbatim,
	})
	if err != nil {
		return []byte(`{"error":"reconstruct_mismatch","event_uid":"` + o.UID + `"}`)
	}
	return b
}
