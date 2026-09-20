package stamp

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

const recvMS = int64(1789828262123) // 2026-09-19T14:31:02.123Z

// TestEventUIDDeterministic pins CONTRACTS §4: the uid is a pure function of
// (recv_ms, topic, partition, offset), so redelivery reproduces it exactly.
func TestEventUIDDeterministic(t *testing.T) {
	a := EventUID(recvMS, "raw", 3, 4242)
	for i := 0; i < 100; i++ {
		if got := EventUID(recvMS, "raw", 3, 4242); got != a {
			t.Fatalf("call %d returned %s, want %s", i, got, a)
		}
	}
	if len(a) != 26 {
		t.Fatalf("event_uid %q is %d chars, want 26", a, len(a))
	}
	for i := 0; i < len(a); i++ {
		if !strings.ContainsRune(crockford, rune(a[i])) {
			t.Fatalf("event_uid %q has non-Crockford byte %q at %d", a, a[i], i)
		}
	}
}

// TestEventUIDVariesWithCoordinates: any change to the bus coordinates must
// produce a different uid, or two distinct events could collide.
func TestEventUIDVariesWithCoordinates(t *testing.T) {
	base := EventUID(recvMS, "raw", 3, 4242)
	cases := []struct {
		name      string
		recv      int64
		topic     string
		partition int32
		offset    int64
	}{
		{"next_offset", recvMS, "raw", 3, 4243},
		{"previous_offset", recvMS, "raw", 3, 4241},
		{"zero_offset", recvMS, "raw", 3, 0},
		{"other_partition", recvMS, "raw", 4, 4242},
		{"other_topic", recvMS, "quarantine", 3, 4242},
		{"one_ms_later", recvMS + 1, "raw", 3, 4242},
	}
	seen := map[string]string{base: "base"}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			got := EventUID(c.recv, c.topic, c.partition, c.offset)
			if prev, dup := seen[got]; dup {
				t.Fatalf("uid %s collides with %s", got, prev)
			}
			seen[got] = c.name
		})
	}
}

// TestEntropyIsFirst80Bits pins the entropy derivation byte for byte.
func TestEntropyIsFirst80Bits(t *testing.T) {
	sum := sha256.Sum256([]byte("raw|3|4242"))
	got := Entropy("raw", 3, 4242)
	if hex.EncodeToString(got[:]) != hex.EncodeToString(sum[:10]) {
		t.Fatalf("entropy = %x, want first 80 bits of sha256(\"raw|3|4242\") = %x", got, sum[:10])
	}
}

// TestULIDTimestampPrefix pins the uint48 big-endian millisecond prefix and its
// recovery, and that uids sort by time as ULIDs must.
func TestULIDTimestampPrefix(t *testing.T) {
	cases := []int64{0, 1, recvMS, 1<<48 - 1}
	for _, ms := range cases {
		id := ULID(ms, "raw", 0, 1)
		var back int64
		for i := 0; i < 6; i++ {
			back = back<<8 | int64(id[i])
		}
		if back != ms {
			t.Fatalf("ULID prefix = %d, want %d", back, ms)
		}
		uid := Encode(id)
		got, ok := TimeMS(uid)
		if !ok || got != ms {
			t.Fatalf("TimeMS(%s) = %d, %v, want %d", uid, got, ok, ms)
		}
	}
	if a, b := EventUID(recvMS, "raw", 0, 1), EventUID(recvMS+1000, "raw", 0, 1); !(a < b) {
		t.Fatalf("uids do not sort by time: %s !< %s", a, b)
	}
}

// TestTimeMSRejectsJunk keeps a malformed uid from decoding to a plausible time.
func TestTimeMSRejectsJunk(t *testing.T) {
	cases := []string{"", "TOOSHORT", strings.Repeat("Z", 27), "U" + strings.Repeat("0", 25)}
	for _, c := range cases {
		if _, ok := TimeMS(c); ok {
			t.Errorf("TimeMS(%q) accepted a malformed uid", c)
		}
	}
}

// TestSHA256AndHex pins the arrival fingerprint against the stdlib.
func TestSHA256AndHex(t *testing.T) {
	raw := []byte("<166>Sep 19 14:31:02 fw01 %ASA-6-302013: Built")
	want := sha256.Sum256(raw)
	got := SHA256(raw)
	if got != want {
		t.Fatalf("SHA256 differs from crypto/sha256")
	}
	if Hex(got) != hex.EncodeToString(want[:]) {
		t.Fatalf("Hex = %s, want %s", Hex(got), hex.EncodeToString(want[:]))
	}
	if Hex(SHA256(nil)) != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Fatalf("empty-input digest = %s", Hex(SHA256(nil)))
	}
}
