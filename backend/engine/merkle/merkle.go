// Package merkle seals batches of raw hashes into a tamper-evident chain.
// CONTRACTS §4, spec §6.9 / §8.5.
package merkle

import (
	"crypto/sha256"
	"fmt"
	"sort"
	"sync"
	"time"
)

// Domain separation bytes prevent second-preimage tricks between levels.
const (
	domainLeaf byte = 0x00
	domainNode byte = 0x01
)

// Leaf hashes a raw_sha256 into the leaf domain.
func Leaf(rawSHA [32]byte) [32]byte {
	var b [33]byte
	b[0] = domainLeaf
	copy(b[1:], rawSHA[:])
	return sha256.Sum256(b[:])
}

// Node hashes two children into the internal-node domain.
func Node(l, r [32]byte) [32]byte {
	var b [65]byte
	b[0] = domainNode
	copy(b[1:33], l[:])
	copy(b[33:], r[:])
	return sha256.Sum256(b[:])
}

// Key identifies a batch: (source_id, partition, ingest minute).
type Key struct {
	SourceID  string
	Partition int32
	Minute    time.Time // UTC, truncated to the minute
}

// String renders the canonical batch key, e.g. fw01/p3/2026-09-19T14:31Z.
func (k Key) String() string {
	return fmt.Sprintf("%s/p%d/%s", k.SourceID, k.Partition, k.Minute.UTC().Format("2006-01-02T15:04Z"))
}

// KeyFor derives the batch key from ingest time.
func KeyFor(sourceID string, partition int32, recvMS int64) Key {
	t := time.UnixMilli(recvMS).UTC().Truncate(time.Minute)
	return Key{SourceID: sourceID, Partition: partition, Minute: t}
}

// Root builds the tree over leaves already ordered by event_uid.
// An odd node is paired with itself. Empty input yields the zero digest.
func Root(rawHashes [][32]byte) [32]byte {
	if len(rawHashes) == 0 {
		return [32]byte{}
	}
	level := make([][32]byte, len(rawHashes))
	for i, h := range rawHashes {
		level[i] = Leaf(h)
	}
	for len(level) > 1 {
		if len(level)%2 == 1 {
			level = append(level, level[len(level)-1])
		}
		next := make([][32]byte, 0, len(level)/2)
		for i := 0; i < len(level); i += 2 {
			next = append(next, Node(level[i], level[i+1]))
		}
		level = next
	}
	return level[0]
}

// Chain links a root to the previous chained root of the same (source, partition).
// chained_n = sha256(chained_(n-1) || root_n || batch key).
func Chain(prev, root [32]byte, k Key) [32]byte {
	buf := make([]byte, 0, 64+len(k.String()))
	buf = append(buf, prev[:]...)
	buf = append(buf, root[:]...)
	buf = append(buf, k.String()...)
	return sha256.Sum256(buf)
}

// entry is one deduplicated leaf.
type entry struct {
	uid string
	h   [32]byte
}

// Batch accumulates leaves for one key, deduplicated by event_uid.
type Batch struct {
	Key     Key
	mu      sync.Mutex
	leaves  map[string][32]byte
	updated time.Time
}

// NewBatch creates an empty batch.
func NewBatch(k Key) *Batch {
	return &Batch{Key: k, leaves: map[string][32]byte{}, updated: time.Now()}
}

// Add registers (event_uid, raw_sha256). Redelivery is idempotent.
func (b *Batch) Add(uid string, rawSHA [32]byte) {
	b.mu.Lock()
	b.leaves[uid] = rawSHA
	b.updated = time.Now()
	b.mu.Unlock()
}

// Len returns the deduplicated leaf count.
func (b *Batch) Len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.leaves)
}

// Ordered returns the raw hashes sorted by event_uid.
func (b *Batch) Ordered() [][32]byte {
	b.mu.Lock()
	es := make([]entry, 0, len(b.leaves))
	for uid, h := range b.leaves {
		es = append(es, entry{uid, h})
	}
	b.mu.Unlock()
	sort.Slice(es, func(i, j int) bool { return es[i].uid < es[j].uid })
	out := make([][32]byte, len(es))
	for i, e := range es {
		out[i] = e.h
	}
	return out
}

// Root seals the batch.
func (b *Batch) Root() [32]byte { return Root(b.Ordered()) }

// Sealed is the result of closing a batch.
type Sealed struct {
	Key         Key       `json:"batch"`
	LeafCount   int       `json:"leaf_count"`
	Root        [32]byte  `json:"-"`
	ChainedRoot [32]byte  `json:"-"`
	SealedAt    time.Time `json:"sealed_at"`
}

// Sealer holds open batches and closes them after the grace window.
type Sealer struct {
	Grace time.Duration
	mu    sync.Mutex
	open  map[string]*Batch
	prev  map[string][32]byte // (source,partition) -> last chained root
}

// NewSealer returns a sealer with the given grace window (spec suggests 2m).
func NewSealer(grace time.Duration) *Sealer {
	return &Sealer{Grace: grace, open: map[string]*Batch{}, prev: map[string][32]byte{}}
}

// Add registers a leaf in its ingest-minute batch.
func (s *Sealer) Add(k Key, uid string, rawSHA [32]byte) {
	ks := k.String()
	s.mu.Lock()
	b, ok := s.open[ks]
	if !ok {
		b = NewBatch(k)
		s.open[ks] = b
	}
	s.mu.Unlock()
	b.Add(uid, rawSHA)
}

// SetPrev seeds the chain head, e.g. from PostgreSQL on worker start.
func (s *Sealer) SetPrev(sourceID string, partition int32, chained [32]byte) {
	s.mu.Lock()
	s.prev[chainKey(sourceID, partition)] = chained
	s.mu.Unlock()
}

func chainKey(sourceID string, partition int32) string {
	return fmt.Sprintf("%s/p%d", sourceID, partition)
}

// Close seals every batch whose minute ended more than Grace ago.
func (s *Sealer) Close(now time.Time) []Sealed {
	s.mu.Lock()
	defer s.mu.Unlock()
	var due []*Batch
	for ks, b := range s.open {
		if now.After(b.Key.Minute.Add(time.Minute + s.Grace)) {
			due = append(due, b)
			delete(s.open, ks)
		}
	}
	sort.Slice(due, func(i, j int) bool {
		if due[i].Key.Minute.Equal(due[j].Key.Minute) {
			return due[i].Key.String() < due[j].Key.String()
		}
		return due[i].Key.Minute.Before(due[j].Key.Minute)
	})
	out := make([]Sealed, 0, len(due))
	for _, b := range due {
		root := b.Root()
		ck := chainKey(b.Key.SourceID, b.Key.Partition)
		chained := Chain(s.prev[ck], root, b.Key)
		s.prev[ck] = chained
		out = append(out, Sealed{Key: b.Key, LeafCount: b.Len(), Root: root, ChainedRoot: chained, SealedAt: now})
	}
	return out
}

// CloseAll seals every open batch regardless of the grace window.
func (s *Sealer) CloseAll() []Sealed {
	return s.Close(time.Now().Add(24 * time.Hour))
}

// VerifyBatch recomputes root and chained root and compares them with stored values.
func VerifyBatch(k Key, hashesByUID map[string][32]byte, prev, wantRoot, wantChained [32]byte) (root, chained [32]byte, ok bool) {
	uids := make([]string, 0, len(hashesByUID))
	for u := range hashesByUID {
		uids = append(uids, u)
	}
	sort.Strings(uids)
	hs := make([][32]byte, len(uids))
	for i, u := range uids {
		hs[i] = hashesByUID[u]
	}
	root = Root(hs)
	chained = Chain(prev, root, k)
	return root, chained, root == wantRoot && chained == wantChained
}
