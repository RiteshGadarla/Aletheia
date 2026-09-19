package template

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Template is a compiled token list: one anchored RE2 regexp, one capture per slot.
type Template struct {
	ID     string
	Tokens []Token
	Slots  []string // slot names in token order
	Expr   string
	re     *regexp.Regexp
}

// Compile validates the tokens and builds the anchored regexp `^...$`.
func Compile(id string, toks []Token) (*Template, error) {
	if err := Validate(toks); err != nil {
		return nil, fmt.Errorf("template %s: %w", id, err)
	}
	var b strings.Builder
	b.WriteByte('^')
	var slots []string
	for _, t := range toks {
		if t.IsLit() {
			b.WriteString(regexp.QuoteMeta(t.Lit))
			continue
		}
		p, err := Pattern(t)
		if err != nil {
			return nil, fmt.Errorf("template %s: %w", id, err)
		}
		b.WriteByte('(')
		b.WriteString(p)
		b.WriteByte(')')
		slots = append(slots, t.Slot)
	}
	b.WriteByte('$')
	expr := b.String()
	re, err := regexp.Compile(expr)
	if err != nil {
		return nil, fmt.Errorf("template %s: %w", id, err)
	}
	return &Template{ID: id, Tokens: append([]Token(nil), toks...), Slots: slots, Expr: expr, re: re}, nil
}

// Validate enforces the compiler rules of CONTRACTS §1.
func Validate(toks []Token) error {
	if len(toks) == 0 {
		return errors.New("empty token list")
	}
	seen := map[string]bool{}
	for i, t := range toks {
		if t.IsLit() {
			// An empty literal consumes no bytes but still separates two slots,
			// which is how packs declare an unambiguous slot pair explicitly.
			continue
		}
		if seen[t.Slot] {
			return fmt.Errorf("token %d: duplicate slot %q", i, t.Slot)
		}
		seen[t.Slot] = true
		if _, err := Pattern(t); err != nil {
			return err
		}
		if t.Type == TypeText && i+1 < len(toks) && !toks[i+1].IsLit() {
			// `text` is lazy: it needs a following literal, or the `$` anchor,
			// to bound it (CONTRACTS §1).
			return fmt.Errorf("token %d: slot %q of type text must be followed by a literal", i, t.Slot)
		}
		if i+1 < len(toks) && !toks[i+1].IsLit() {
			if err := checkAdjacent(t, toks[i+1]); err != nil {
				return fmt.Errorf("token %d: %w", i, err)
			}
		}
	}
	return nil
}

// checkAdjacent rejects ambiguous slot pairs: allowed only when both are
// fixed-width, or when a ws run abuts a type that cannot contain whitespace.
func checkAdjacent(a, b Token) error {
	if fixedWidth[a.Type] && fixedWidth[b.Type] {
		return nil
	}
	if a.Type == TypeWS && noSpace[b.Type] {
		return nil
	}
	if b.Type == TypeWS && noSpace[a.Type] {
		return nil
	}
	return fmt.Errorf("adjacent slots %q(%s) and %q(%s) are ambiguous", a.Slot, a.Type, b.Slot, b.Type)
}

// Regexp exposes the compiled expression.
func (t *Template) Regexp() *regexp.Regexp { return t.re }

// Match runs the anchored regexp and returns the capture groups as exact byte
// substrings of b. It never allocates a copy of the input beyond the captures.
func (t *Template) Match(b []byte) ([]string, bool) {
	m := t.re.FindSubmatchIndex(b)
	if m == nil {
		return nil, false
	}
	n := len(m)/2 - 1
	vars := make([]string, n)
	for i := 1; i <= n; i++ {
		s, e := m[2*i], m[2*i+1]
		if s < 0 {
			vars[i-1] = ""
			continue
		}
		vars[i-1] = string(b[s:e])
	}
	return vars, true
}

// Reconstruct rebuilds the original bytes from tokens and captured vars.
func Reconstruct(toks []Token, vars []string) ([]byte, error) {
	n := 0
	for _, t := range toks {
		if t.IsLit() {
			n += len(t.Lit)
		}
	}
	for _, v := range vars {
		n += len(v)
	}
	out := make([]byte, 0, n)
	vi := 0
	for _, t := range toks {
		if t.IsLit() {
			out = append(out, t.Lit...)
			continue
		}
		if vi >= len(vars) {
			return nil, fmt.Errorf("reconstruct: missing var for slot %q", t.Slot)
		}
		out = append(out, vars[vi]...)
		vi++
	}
	if vi != len(vars) {
		return nil, fmt.Errorf("reconstruct: %d vars for %d slots", len(vars), vi)
	}
	return out, nil
}

// Span is a half-open byte range [Start, End) in the reconstructed raw line.
type Span struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// Spans computes lineage byte ranges per slot. Never stored; recomputed on demand.
func Spans(toks []Token, vars []string) map[string]Span {
	spans := make(map[string]Span, len(vars))
	off, vi := 0, 0
	for _, t := range toks {
		if t.IsLit() {
			off += len(t.Lit)
			continue
		}
		if vi >= len(vars) {
			break
		}
		spans[t.Slot] = Span{Start: off, End: off + len(vars[vi])}
		off += len(vars[vi])
		vi++
	}
	return spans
}

// Splice replaces the token named slot with sub, producing the full-line token
// list. Used to fold a body template into its envelope. CONTRACTS §2.
func Splice(env []Token, slot string, sub []Token) ([]Token, int, bool) {
	for i, t := range env {
		if !t.IsLit() && t.Slot == slot {
			out := make([]Token, 0, len(env)-1+len(sub))
			out = append(out, env[:i]...)
			out = append(out, sub...)
			out = append(out, env[i+1:]...)
			return out, i, true
		}
	}
	return nil, 0, false
}

// SlotIndex returns the capture index of a slot name, or -1.
func SlotIndex(toks []Token, slot string) int {
	i := 0
	for _, t := range toks {
		if t.IsLit() {
			continue
		}
		if t.Slot == slot {
			return i
		}
		i++
	}
	return -1
}
