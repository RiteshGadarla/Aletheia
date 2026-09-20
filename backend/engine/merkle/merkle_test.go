package merkle

import (
	"crypto/sha256"
	"testing"
	"time"
)

// h makes a distinguishable stand-in raw_sha256.
func h(b byte) [32]byte {
	var out [32]byte
	for i := range out {
		out[i] = b
	}
	return out
}

func hashes(bs ...byte) [][32]byte {
	out := make([][32]byte, len(bs))
	for i, b := range bs {
		out[i] = h(b)
	}
	return out
}

// TestDomainSeparation pins the 0x00 leaf / 0x01 node prefixes of CONTRACTS §4.
// Without them a leaf digest could be replayed as an internal node.
func TestDomainSeparation(t *testing.T) {
	raw := h(0xAB)
	wantLeaf := sha256.Sum256(append([]byte{0x00}, raw[:]...))
	if Leaf(raw) != wantLeaf {
		t.Fatalf("Leaf is not sha256(0x00 || raw_sha256)")
	}
	l, r := h(1), h(2)
	wantNode := sha256.Sum256(append(append([]byte{0x01}, l[:]...), r[:]...))
	if Node(l, r) != wantNode {
		t.Fatalf("Node is not sha256(0x01 || left || right)")
	}
	if Leaf(raw) == sha256.Sum256(raw[:]) {
		t.Fatal("leaf digest equals the undomained hash")
	}
	// A two-leaf root must not equal the node hash of the raw values.
	if Root(hashes(1, 2)) == Node(l, r) {
		t.Fatal("internal nodes are not domain separated from leaves")
	}
}

// TestRootShape checks the tree against hand-built expectations, including the
// odd-node case: the last node is paired with itself, never dropped or padded
// with a zero digest.
func TestRootShape(t *testing.T) {
	l := func(b byte) [32]byte { return Leaf(h(b)) }
	cases := []struct {
		name string
		in   [][32]byte
		want [32]byte
	}{
		{"empty_is_zero_digest", nil, [32]byte{}},
		{"one_leaf_is_the_leaf", hashes(1), l(1)},
		{"two_leaves", hashes(1, 2), Node(l(1), l(2))},
		{"four_leaves", hashes(1, 2, 3, 4), Node(Node(l(1), l(2)), Node(l(3), l(4)))},
		// Three leaves: leaf 3 has no sibling, so it pairs with itself.
		{"three_leaves_odd_pairs_with_itself", hashes(1, 2, 3),
			Node(Node(l(1), l(2)), Node(l(3), l(3)))},
		// Five leaves: odd at the leaf level and again one level up.
		{"five_leaves_odd_twice", hashes(1, 2, 3, 4, 5),
			Node(Node(Node(l(1), l(2)), Node(l(3), l(4))),
				Node(Node(l(5), l(5)), Node(l(5), l(5))))},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			if got := Root(c.in); got != c.want {
				t.Fatalf("root = %x, want %x", got, c.want)
			}
		})
	}
}

// TestRootIsOrderSensitive: the root commits to the event order, so swapping
// two leaves must change it. Otherwise resequencing would go undetected.
func TestRootIsOrderSensitive(t *testing.T) {
	if Root(hashes(1, 2, 3)) == Root(hashes(3, 2, 1)) {
		t.Fatal("root is independent of leaf order")
	}
	if Root(hashes(1, 2)) == Root(hashes(1, 2, 3)) {
		t.Fatal("an extra leaf did not change the root")
	}
}

// TestOddLeafDuplicationIsAmbiguous documents a known property of the
// pair-the-odd-node-with-itself rule (CONTRACTS §4): an odd leaf list and the
// same list with its last leaf repeated share a root. Two defences stand in
// front of it and both are load bearing, so this test guards them:
// merkle.Batch keys leaves by event_uid, so a duplicate can never enter a
// batch, and verify compares the stored leaf_count before trusting the root.
func TestOddLeafDuplicationIsAmbiguous(t *testing.T) {
	if Root(hashes(1, 2, 3)) != Root(hashes(1, 2, 3, 3)) {
		t.Skip("root is no longer ambiguous; the leaf_count check may be relaxed")
	}
	b := NewBatch(KeyFor("fw01", 0, mustMS("2026-09-19T14:31:00Z")))
	b.Add("uid_a", h(1))
	b.Add("uid_b", h(2))
	b.Add("uid_c", h(3))
	b.Add("uid_c", h(3)) // the only way to repeat a leaf is to repeat its uid
	if b.Len() != 3 {
		t.Fatalf("leaf count = %d, want 3: a batch must deduplicate by event_uid", b.Len())
	}
}

// TestKeyStringAndKeyFor pin the canonical batch key of CONTRACTS §4.
func TestKeyStringAndKeyFor(t *testing.T) {
	cases := []struct {
		name   string
		source string
		part   int32
		recvMS int64
		want   string
	}{
		{"spec_example", "fw01", 3, mustMS("2026-09-19T14:31:02.123Z"), "fw01/p3/2026-09-19T14:31Z"},
		{"truncates_to_the_minute", "fw01", 3, mustMS("2026-09-19T14:31:59.999Z"), "fw01/p3/2026-09-19T14:31Z"},
		{"next_minute", "fw01", 3, mustMS("2026-09-19T14:32:00.000Z"), "fw01/p3/2026-09-19T14:32Z"},
		{"partition_zero", "asa", 0, mustMS("2026-09-20T07:55:58.318Z"), "asa/p0/2026-09-20T07:55Z"},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			if got := KeyFor(c.source, c.part, c.recvMS).String(); got != c.want {
				t.Fatalf("key = %q, want %q", got, c.want)
			}
		})
	}
	// A key built in another zone still renders as UTC.
	ist := time.FixedZone("IST", 5*3600+1800)
	k := Key{SourceID: "fw01", Partition: 1,
		Minute: time.Date(2026, 9, 19, 20, 1, 0, 0, ist)}
	if got, want := k.String(), "fw01/p1/2026-09-19T14:31Z"; got != want {
		t.Fatalf("key = %q, want %q", got, want)
	}
}

// TestChainLinkage pins that each chained root commits to its predecessor, the
// batch root and the batch key, so a removed or reordered batch is detectable.
func TestChainLinkage(t *testing.T) {
	k1 := KeyFor("fw01", 0, mustMS("2026-09-19T14:31:00Z"))
	k2 := KeyFor("fw01", 0, mustMS("2026-09-19T14:32:00Z"))
	r1, r2 := Root(hashes(1, 2)), Root(hashes(3, 4, 5))

	var zero [32]byte
	c1 := Chain(zero, r1, k1)
	c2 := Chain(c1, r2, k2)

	want := sha256.Sum256(append(append(append([]byte{}, c1[:]...), r2[:]...), k2.String()...))
	if c2 != want {
		t.Fatalf("chained root is not sha256(prev || root || batch key)")
	}
	if c2 == Chain(zero, r2, k2) {
		t.Fatal("chained root ignores its predecessor")
	}
	if c2 == Chain(c1, r2, k1) {
		t.Fatal("chained root ignores the batch key")
	}
	if c2 == Chain(c1, r1, k2) {
		t.Fatal("chained root ignores the batch root")
	}
}

// TestBatchOrdersByEventUID: leaves are ordered by event_uid, not by arrival,
// and redelivery of the same uid is idempotent.
func TestBatchOrdersByEventUID(t *testing.T) {
	k := KeyFor("fw01", 0, mustMS("2026-09-19T14:31:00Z"))
	b := NewBatch(k)
	b.Add("01M2XG56X7NVY9YE3NBZC9N002", h(3))
	b.Add("01M2XFYG276EPYZ1XBJB38V6RB", h(1))
	b.Add("01M2XG16ZF3ZGMBH9R7P79GR4V", h(2))
	b.Add("01M2XFYG276EPYZ1XBJB38V6RB", h(1)) // redelivery
	if b.Len() != 3 {
		t.Fatalf("leaf count = %d, want 3 after a redelivery", b.Len())
	}
	if got := b.Ordered(); got[0] != h(1) || got[1] != h(2) || got[2] != h(3) {
		t.Fatal("leaves are not ordered by event_uid")
	}
	if b.Root() != Root(hashes(1, 2, 3)) {
		t.Fatal("batch root differs from the uid-ordered tree")
	}
}

// TestVerifyBatch is the verify path: recompute from stored events and compare.
func TestVerifyBatch(t *testing.T) {
	k := KeyFor("fw01", 0, mustMS("2026-09-19T14:31:00Z"))
	leaves := map[string][32]byte{"uid_b": h(2), "uid_a": h(1), "uid_c": h(3)}
	var prev [32]byte
	root := Root(hashes(1, 2, 3))
	chained := Chain(prev, root, k)

	if _, _, ok := VerifyBatch(k, leaves, prev, root, chained); !ok {
		t.Fatal("an untampered batch failed to verify")
	}
	cases := []struct {
		name     string
		mutate   func(map[string][32]byte)
		wantRoot bool // true when the recomputed root should still match
	}{
		{"one_leaf_flipped", func(m map[string][32]byte) { m["uid_b"] = h(0xFF) }, false},
		{"leaf_removed", func(m map[string][32]byte) { delete(m, "uid_c") }, false},
		{"leaf_added", func(m map[string][32]byte) { m["uid_d"] = h(4) }, false},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			m := map[string][32]byte{}
			for u, v := range leaves {
				m[u] = v
			}
			c.mutate(m)
			got, _, ok := VerifyBatch(k, m, prev, root, chained)
			if ok {
				t.Fatal("tampering went undetected")
			}
			if (got == root) != c.wantRoot {
				t.Fatalf("recomputed root = %x, stored %x", got, root)
			}
		})
	}
	// A correct batch under a wrong predecessor breaks the chain, not the root.
	root2, chain2, ok := VerifyBatch(k, leaves, h(9), root, chained)
	if ok || root2 != root || chain2 == chained {
		t.Fatal("a broken chain must fail while the root still matches")
	}
}

// TestSealerChainsAcrossMinutes covers the sealer end to end: the grace window,
// per-partition chain state and the linkage between consecutive batches.
func TestSealerChainsAcrossMinutes(t *testing.T) {
	s := NewSealer(2 * time.Minute)
	m1 := mustMS("2026-09-19T14:31:00Z")
	m2 := mustMS("2026-09-19T14:32:00Z")
	k1, k2 := KeyFor("fw01", 0, m1), KeyFor("fw01", 0, m2)
	kOther := KeyFor("fw01", 1, m1) // a second partition, independent chain

	s.Add(k1, "uid_a", h(1))
	s.Add(k1, "uid_b", h(2))
	s.Add(k2, "uid_c", h(3))
	s.Add(kOther, "uid_d", h(4))

	// Nothing is due while the grace window is still open.
	if got := s.Close(time.UnixMilli(m1).Add(90 * time.Second)); len(got) != 0 {
		t.Fatalf("sealed %d batches before the grace window elapsed", len(got))
	}
	sealed := s.CloseAll()
	if len(sealed) != 3 {
		t.Fatalf("sealed %d batches, want 3", len(sealed))
	}
	byKey := map[string]Sealed{}
	for _, b := range sealed {
		byKey[b.Key.String()] = b
	}
	b1, b2 := byKey[k1.String()], byKey[k2.String()]
	if b1.LeafCount != 2 || b2.LeafCount != 1 {
		t.Fatalf("leaf counts = %d, %d, want 2, 1", b1.LeafCount, b2.LeafCount)
	}
	var zero [32]byte
	if b1.Root != Root(hashes(1, 2)) || b1.ChainedRoot != Chain(zero, b1.Root, k1) {
		t.Fatal("first batch of a partition does not chain from the zero digest")
	}
	if b2.ChainedRoot != Chain(b1.ChainedRoot, b2.Root, k2) {
		t.Fatal("consecutive batches of a partition are not chained")
	}
	// Partition 1 has its own chain, seeded independently.
	if bo := byKey[kOther.String()]; bo.ChainedRoot != Chain(zero, bo.Root, kOther) {
		t.Fatal("partitions do not keep separate chain heads")
	}
	if len(s.CloseAll()) != 0 {
		t.Fatal("a sealed batch was sealed twice")
	}
}

// TestSetPrevSeedsTheChain covers a worker restart resuming from PostgreSQL.
func TestSetPrevSeedsTheChain(t *testing.T) {
	s := NewSealer(0)
	head := h(0x7E)
	s.SetPrev("fw01", 0, head)
	k := KeyFor("fw01", 0, mustMS("2026-09-19T14:31:00Z"))
	s.Add(k, "uid_a", h(1))
	sealed := s.CloseAll()
	if len(sealed) != 1 {
		t.Fatalf("sealed %d batches, want 1", len(sealed))
	}
	if sealed[0].ChainedRoot != Chain(head, sealed[0].Root, k) {
		t.Fatal("the seeded chain head was not used")
	}
}

func mustMS(rfc3339 string) int64 {
	t, err := time.Parse(time.RFC3339, rfc3339)
	if err != nil {
		panic(err)
	}
	return t.UnixMilli()
}

// TestParseKeyRoundTrip covers the source ids that contain a slash, which is
// why the key is split from the right.
func TestParseKeyRoundTrip(t *testing.T) {
	for _, k := range []Key{
		{SourceID: "fw01", Partition: 3, Minute: time.Date(2026, 9, 19, 14, 31, 0, 0, time.UTC)},
		{SourceID: "pfsense/opnsense_filterlog", Partition: 0, Minute: time.Date(2026, 1, 2, 3, 4, 0, 0, time.UTC)},
		{SourceID: "a/b/c", Partition: 12, Minute: time.Date(2030, 12, 31, 23, 59, 0, 0, time.UTC)},
	} {
		got, err := ParseKey(k.String())
		if err != nil {
			t.Fatalf("ParseKey(%q): %v", k.String(), err)
		}
		if got != k {
			t.Fatalf("ParseKey(%q) = %+v, want %+v", k.String(), got, k)
		}
	}
	for _, bad := range []string{"", "fw01", "fw01/p3", "fw01/3/2026-09-19T14:31Z", "fw01/px/2026-09-19T14:31Z"} {
		if _, err := ParseKey(bad); err == nil {
			t.Fatalf("ParseKey(%q) accepted a malformed key", bad)
		}
	}
}
