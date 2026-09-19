// Package stamp produces deterministic event identity and integrity fingerprints.
// CONTRACTS §4, spec §6.3 / §8.2.
package stamp

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
)

// crockford is the Crockford base32 alphabet used by ULID.
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// SHA256 hashes b. Raw bytes are hashed before any parsing and never mutated.
func SHA256(b []byte) [32]byte { return sha256.Sum256(b) }

// Hex renders a digest as lowercase hex.
func Hex(h [32]byte) string { return hex.EncodeToString(h[:]) }

// Entropy is the first 80 bits of sha256(topic|partition|offset).
// The bus offset never changes, so redelivery yields the same entropy.
func Entropy(topic string, partition int32, offset int64) [10]byte {
	var buf []byte
	buf = append(buf, topic...)
	buf = append(buf, '|')
	buf = strconv.AppendInt(buf, int64(partition), 10)
	buf = append(buf, '|')
	buf = strconv.AppendInt(buf, offset, 10)
	sum := sha256.Sum256(buf)
	var e [10]byte
	copy(e[:], sum[:10])
	return e
}

// ULID builds the 16-byte ULID payload: uint48(recvMS) || 80 bits of entropy.
func ULID(recvMS int64, topic string, partition int32, offset int64) [16]byte {
	e := Entropy(topic, partition, offset)
	var id [16]byte
	t := uint64(recvMS) & 0xFFFFFFFFFFFF
	id[0] = byte(t >> 40)
	id[1] = byte(t >> 32)
	id[2] = byte(t >> 24)
	id[3] = byte(t >> 16)
	id[4] = byte(t >> 8)
	id[5] = byte(t)
	copy(id[6:], e[:])
	return id
}

// EventUID is the 26-character Crockford base32 form of the deterministic ULID.
func EventUID(recvMS int64, topic string, partition int32, offset int64) string {
	return Encode(ULID(recvMS, topic, partition, offset))
}

// Encode renders 128 bits as 26 Crockford base32 characters (ULID layout).
func Encode(id [16]byte) string {
	var s [26]byte
	s[0] = crockford[(id[0]&224)>>5]
	s[1] = crockford[id[0]&31]
	s[2] = crockford[(id[1]&248)>>3]
	s[3] = crockford[((id[1]&7)<<2)|((id[2]&192)>>6)]
	s[4] = crockford[(id[2]&62)>>1]
	s[5] = crockford[((id[2]&1)<<4)|((id[3]&240)>>4)]
	s[6] = crockford[((id[3]&15)<<1)|((id[4]&128)>>7)]
	s[7] = crockford[(id[4]&124)>>2]
	s[8] = crockford[((id[4]&3)<<3)|((id[5]&224)>>5)]
	s[9] = crockford[id[5]&31]
	s[10] = crockford[(id[6]&248)>>3]
	s[11] = crockford[((id[6]&7)<<2)|((id[7]&192)>>6)]
	s[12] = crockford[(id[7]&62)>>1]
	s[13] = crockford[((id[7]&1)<<4)|((id[8]&240)>>4)]
	s[14] = crockford[((id[8]&15)<<1)|((id[9]&128)>>7)]
	s[15] = crockford[(id[9]&124)>>2]
	s[16] = crockford[((id[9]&3)<<3)|((id[10]&224)>>5)]
	s[17] = crockford[id[10]&31]
	s[18] = crockford[(id[11]&248)>>3]
	s[19] = crockford[((id[11]&7)<<2)|((id[12]&192)>>6)]
	s[20] = crockford[(id[12]&62)>>1]
	s[21] = crockford[((id[12]&1)<<4)|((id[13]&240)>>4)]
	s[22] = crockford[((id[13]&15)<<1)|((id[14]&128)>>7)]
	s[23] = crockford[(id[14]&124)>>2]
	s[24] = crockford[((id[14]&3)<<3)|((id[15]&224)>>5)]
	s[25] = crockford[id[15]&31]
	return string(s[:])
}

// TimeMS recovers the millisecond timestamp from an encoded event_uid.
func TimeMS(uid string) (int64, bool) {
	if len(uid) != 26 {
		return 0, false
	}
	var v int64
	for i := 0; i < 10; i++ {
		d := decode(uid[i])
		if d < 0 {
			return 0, false
		}
		v = v<<5 | int64(d)
	}
	return v, true
}

func decode(c byte) int {
	for i := 0; i < len(crockford); i++ {
		if crockford[i] == c {
			return i
		}
	}
	return -1
}
