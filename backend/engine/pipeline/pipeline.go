// Package pipeline is the per-event hot path of spec §8.1, shared by the
// streaming worker, `aletheia replay` and `aletheia bench` so all three agree
// byte for byte on what an event becomes.
package pipeline

import (
	"encoding/json"

	"github.com/Ritesh2006M/aletheia/envelope"
	"github.com/Ritesh2006M/aletheia/fullmatch"
	"github.com/Ritesh2006M/aletheia/merkle"
	"github.com/Ritesh2006M/aletheia/normalize"
	"github.com/Ritesh2006M/aletheia/reconstruct"
	"github.com/Ritesh2006M/aletheia/registry"
	"github.com/Ritesh2006M/aletheia/stamp"
	"github.com/Ritesh2006M/aletheia/template"
)

// engineSlots are envelope slots the engine consumes itself. They are never
// pack-mapped and never land in `unmapped` (mirrors the pack reference gate).
var engineSlots = map[string]bool{
	"pri": true, "ts": true, "host": true, "tag": true, "pid": true,
	"app": true, "procid": true, "msgid": true, "sd": true, "body": true,
}

// Message is one record off the `raw` topic.
type Message struct {
	Raw       []byte
	SourceID  string
	RecvMS    int64
	Topic     string
	Partition int32
	Offset    int64
}

// Outcome is everything one event produced.
type Outcome struct {
	UID         string
	RawSHA      [32]byte
	MerkleKey   merkle.Key
	MerkleBatch string

	Entry  *fullmatch.Entry
	Vars   []string // whole-line captures, exact substrings
	Tokens []template.Token

	Result   normalize.Result
	Status   string
	Mode     string
	Verified bool

	// Quarantine is a normal outcome: no template matched.
	Quarantine bool
	// Mismatch means reconstruction did not rehash to the arrival hash. An
	// engine defect; the event still lands, verbatim, plus a `dlq` record.
	Mismatch bool
	// MismatchOffset is the first differing byte, or -1.
	MismatchOffset int
	// Rebuilt is the reconstruction, kept for dlq context.
	Rebuilt []byte
}

// JSON marshals the normalized event for the `normalized` topic.
func (o *Outcome) JSON() ([]byte, error) { return json.Marshal(o.Result.Event) }

// Engine holds the live index and the lookup tables the hot path needs.
type Engine struct {
	Index   *fullmatch.Index
	Sources *registry.Sources
	Enums   *normalize.Enums
}

// New builds an engine over a compiled index.
func New(ix *fullmatch.Index, srcs *registry.Sources, en *normalize.Enums) *Engine {
	if en == nil {
		en = normalize.Default
	}
	return &Engine{Index: ix, Sources: srcs, Enums: en}
}

// Process runs the spec §8.1 worker loop for one message. It never returns an
// error: an unmatched or defective event still produces a complete record.
func (e *Engine) Process(m Message) *Outcome {
	o := &Outcome{MismatchOffset: -1}
	o.UID = stamp.EventUID(m.RecvMS, m.Topic, m.Partition, m.Offset)
	o.RawSHA = stamp.SHA256(m.Raw)
	o.MerkleKey = merkle.KeyFor(m.SourceID, m.Partition, m.RecvMS)
	o.MerkleBatch = o.MerkleKey.String()

	decoded := envelope.Decode(m.Raw)
	var src *registry.Source
	if e.Sources != nil {
		src = e.Sources.Get(m.SourceID)
	}

	entry, vars, matched := e.Index.Match(src, m.Raw)
	switch {
	case !matched:
		o.Quarantine = true
		o.Status = normalize.StatusRawOnly
		o.Mode = normalize.ModeVerbatim
	default:
		o.Entry, o.Vars, o.Tokens = entry, vars, entry.Tokens
		ok, got, err := reconstruct.Verify(entry.Tokens, vars, o.RawSHA)
		o.Rebuilt = got
		if err != nil || !ok {
			o.Mismatch = true
			o.MismatchOffset = reconstruct.FirstDiff(m.Raw, got)
			o.Entry, o.Vars, o.Tokens = nil, nil, nil
			o.Status = normalize.StatusRawOnly
			o.Mode = normalize.ModeVerbatim
		} else {
			o.Verified = true
			o.Mode = normalize.ModeTemplate
		}
	}

	in := normalize.Input{
		EventUID:    o.UID,
		SourceID:    m.SourceID,
		RecvMS:      m.RecvMS,
		RawSHA:      o.RawSHA,
		Raw:         m.Raw,
		Verified:    o.Verified,
		MerkleBatch: o.MerkleBatch,
		Envelope:    flatten(decoded, entryID(o.Entry, decoded.ID), m.Raw),
		Source:      src,
		StorageMode: o.Mode,
		Enums:       e.Enums,
	}
	if o.Entry != nil {
		// The whole-line token list is handed to the normalizer as the template
		// body, so envelope slots a pack maps (CEF dev_vendor, ...) resolve too.
		td := *o.Entry.Def
		td.Body = o.Entry.Tokens
		in.Template = &td
		in.Vars = o.Vars
	}
	o.Result = normalize.Normalize(in)
	if o.Entry == nil {
		o.Result.Row.EnvelopeID = decoded.ID
	}
	stripEngineSlots(&o.Result, o.Tokens)
	o.Status = o.Result.ParseStatus
	o.Mode = o.Result.Row.StorageMode
	return o
}

// entryID prefers the pack-declared envelope name, falling back to the
// runtime-decoded one when nothing matched.
func entryID(e *fullmatch.Entry, fallback string) string {
	if e != nil {
		return e.EnvID
	}
	return fallback
}

// flatten replaces the decoder's header tokens with a single whole-line body
// slot, so Row.Vars becomes exactly the whole-line captures. The decoded fields
// (pri, ts, host) and the PRI severity are preserved.
func flatten(r envelope.Result, id string, raw []byte) envelope.Result {
	r.ID = id
	r.Tokens = []template.Token{{Slot: envelope.BodySlot, Type: template.TypeText}}
	r.Vars = []string{string(raw)}
	r.BodyTokenIdx, r.BodyVarIdx = 0, 0
	return r
}

// stripEngineSlots removes syslog header slots and whitespace padding from
// `unmapped`; they are envelope machinery, not vendor data.
func stripEngineSlots(res *normalize.Result, toks []template.Token) {
	um, ok := res.Event["unmapped"].(map[string]string)
	if !ok {
		return
	}
	for _, t := range toks {
		if t.IsLit() {
			continue
		}
		if engineSlots[t.Slot] || t.Type == template.TypeWS {
			delete(um, t.Slot)
		}
	}
	b, err := json.Marshal(um)
	if err == nil {
		res.Row.Unmapped = string(b)
	}
}
