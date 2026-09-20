package main

import (
	"context"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Ritesh2006M/aletheia/merkle"
	"github.com/Ritesh2006M/aletheia/store"
)

// Sealer closes Merkle batches after their minute plus the grace window and
// persists root and chained root to PostgreSQL (spec §6.9).
type Sealer struct {
	s    *merkle.Sealer
	pool *pgxpool.Pool
	met  *Metrics

	mu    sync.Mutex
	retry []store.SealedBatch // batches PostgreSQL refused; never discarded
}

// NewSealer seeds the hash chains from PostgreSQL so a restart resumes them.
func NewSealer(ctx context.Context, pool *pgxpool.Pool, grace time.Duration, met *Metrics) *Sealer {
	sl := &Sealer{s: merkle.NewSealer(grace), pool: pool, met: met}
	if pool == nil {
		return sl
	}
	heads, err := store.LatestChained(ctx, pool)
	if err != nil {
		logf("sealer: chain heads unreadable, chains restart: %v", err)
		return sl
	}
	for key, chained := range heads {
		src, part, ok := splitChainKey(key)
		if !ok {
			continue
		}
		sl.s.SetPrev(src, part, chained)
	}
	logf("sealer: resumed %d hash chains", len(heads))
	return sl
}

// Add registers one leaf in its ingest-minute batch.
func (sl *Sealer) Add(k merkle.Key, uid string, rawSHA [32]byte) { sl.s.Add(k, uid, rawSHA) }

// Run seals due batches on a ticker until ctx is cancelled.
func (sl *Sealer) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			sl.persist(ctx, sl.s.Close(now.UTC()))
			sl.flushRetries(ctx)
		}
	}
}

// Drain seals everything still open, for a clean shutdown.
func (sl *Sealer) Drain(ctx context.Context) {
	sl.persist(ctx, sl.s.CloseAll())
	sl.flushRetries(ctx)
	sl.mu.Lock()
	n := len(sl.retry)
	sl.mu.Unlock()
	if n > 0 {
		logf("WARNING: %d Merkle batches unsealed in PostgreSQL; rerun the sealer to persist them", n)
	}
}

// persist writes sealed batches, queueing any PostgreSQL refused.
func (sl *Sealer) persist(ctx context.Context, sealed []merkle.Sealed) {
	if len(sealed) == 0 {
		return
	}
	ok := 0
	for _, s := range sealed {
		b := store.SealedBatch{
			SourceID:    s.Key.SourceID,
			Partition:   s.Key.Partition,
			Minute:      s.Key.Minute,
			LeafCount:   s.LeafCount,
			Root:        s.Root[:],
			ChainedRoot: s.ChainedRoot[:],
			SealedAt:    s.SealedAt,
		}
		if sl.write(ctx, b) {
			ok++
			sl.met.Sealed(1, s.SealedAt.Sub(s.Key.Minute))
			continue
		}
		sl.met.SealFailed()
		sl.mu.Lock()
		sl.retry = append(sl.retry, b)
		sl.mu.Unlock()
	}
	logf("sealed %d/%d merkle batches", ok, len(sealed))
}

// flushRetries re-attempts batches PostgreSQL previously refused.
func (sl *Sealer) flushRetries(ctx context.Context) {
	sl.mu.Lock()
	pending := sl.retry
	sl.retry = nil
	sl.mu.Unlock()
	var still []store.SealedBatch
	for _, b := range pending {
		if sl.write(ctx, b) {
			sl.met.Sealed(1, 0)
			continue
		}
		still = append(still, b)
	}
	if len(still) > 0 {
		sl.mu.Lock()
		sl.retry = append(still, sl.retry...)
		sl.mu.Unlock()
	}
}

// write persists one batch. PostgreSQL decides the chained root from the batch
// that precedes this minute, so a replayed or backfilled minute re-chains
// instead of being appended to whatever this process sealed last. The returned
// chain head is fed back so the in-memory chain tracks the stored one.
// No pool means no persistence; roots stay in memory.
func (sl *Sealer) write(ctx context.Context, b store.SealedBatch) bool {
	if sl.pool == nil {
		return false
	}
	c, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	head, err := store.SealAndChain(c, sl.pool, b)
	if err != nil {
		logf("merkle batch %s/p%d/%s: %v", b.SourceID, b.Partition, b.Minute.Format(time.RFC3339), err)
		return false
	}
	sl.s.SetPrev(b.SourceID, b.Partition, head)
	return true
}

// splitChainKey reverses store.ChainKey.
func splitChainKey(k string) (string, int32, bool) {
	i := -1
	for j := 0; j < len(k); j++ {
		if k[j] == 0 {
			i = j
			break
		}
	}
	if i < 0 {
		return "", 0, false
	}
	var p int32
	for _, c := range k[i+1:] {
		if c < '0' || c > '9' {
			return "", 0, false
		}
		p = p*10 + int32(c-'0')
	}
	return k[:i], p, true
}
