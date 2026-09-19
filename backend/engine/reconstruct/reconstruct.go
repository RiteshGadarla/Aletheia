// Package reconstruct rebuilds raw bytes from a template and its vars and
// verifies them against the arrival hash. Spec §6.6, §8.4.
package reconstruct

import (
	"github.com/Ritesh2006M/aletheia/stamp"
	"github.com/Ritesh2006M/aletheia/template"
)

// Rebuild concatenates literals and vars in token order.
func Rebuild(toks []template.Token, vars []string) ([]byte, error) {
	return template.Reconstruct(toks, vars)
}

// Verify rebuilds and compares against the hash taken at arrival. A successful
// anchored match reconstructs by construction, so a mismatch is an engine defect.
func Verify(toks []template.Token, vars []string, want [32]byte) (ok bool, got []byte, err error) {
	got, err = template.Reconstruct(toks, vars)
	if err != nil {
		return false, nil, err
	}
	return stamp.SHA256(got) == want, got, nil
}

// Lineage recomputes byte spans per slot. Spans are never stored.
func Lineage(toks []template.Token, vars []string) map[string]template.Span {
	return template.Spans(toks, vars)
}

// FirstDiff returns the byte offset where a and b diverge, or -1 if equal.
func FirstDiff(a, b []byte) int {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		if a[i] != b[i] {
			return i
		}
	}
	if len(a) != len(b) {
		return n
	}
	return -1
}
