package pipeline_test

import (
	"strings"
	"testing"

	"github.com/Ritesh2006M/aletheia/pipeline"
	"github.com/Ritesh2006M/aletheia/reconstruct"
	"github.com/Ritesh2006M/aletheia/stamp"
)

// storedRow is the subset of a ClickHouse `events` row that `aletheia verify`
// rebuilds from: the pair (template_id, envelope_id), the vars and the hash.
type storedRow struct {
	sample     sample
	templateID string
	envelopeID string
	vars       []string
	rawSHA     [32]byte
}

// store runs every golden line through the engine and keeps what would be
// persisted, so the verify path can be replayed without a database.
func store(t *testing.T, eng *pipeline.Engine) []storedRow {
	t.Helper()
	var rows []storedRow
	for _, fam := range families {
		for _, s := range samples(t, fam.prefix) {
			o := eng.Process(pipeline.Message{Raw: s.line, SourceID: "test",
				RecvMS: recvMS, Topic: "raw", Partition: 0, Offset: 1})
			if o.Quarantine || o.Mismatch {
				t.Fatalf("%s/%s: golden line did not match cleanly", s.dir, s.file)
			}
			rows = append(rows, storedRow{sample: s, templateID: o.Result.Row.TemplateID,
				envelopeID: o.Result.Row.EnvelopeID, vars: o.Result.Row.Vars, rawSHA: o.RawSHA})
		}
	}
	if len(rows) == 0 {
		t.Fatal("no golden rows stored")
	}
	return rows
}

// TestStoredRowRebuilds is the `aletheia verify` path end to end: look the
// whole-line template up by the stored (template_id, envelope_id) pair, rebuild
// from the stored vars and rehash. This is the invariant a writer violates when
// it records an envelope id other than the one that actually matched.
func TestStoredRowRebuilds(t *testing.T) {
	eng := engine(t)
	for _, r := range store(t, eng) {
		r := r
		t.Run(r.sample.dir+"/"+r.sample.file, func(t *testing.T) {
			if r.envelopeID == "" || r.templateID == "" {
				t.Fatalf("stored row has template_id=%q envelope_id=%q", r.templateID, r.envelopeID)
			}
			entry := eng.Index.Find(r.templateID, r.envelopeID)
			if entry == nil {
				t.Fatalf("template %q@%q is not in the loaded packs", r.templateID, r.envelopeID)
			}
			slots := 0
			for _, tok := range entry.Tokens {
				if !tok.IsLit() {
					slots++
				}
			}
			if slots != len(r.vars) {
				t.Fatalf("%s@%s has %d slots but the row stored %d vars",
					r.templateID, r.envelopeID, slots, len(r.vars))
			}
			raw, err := reconstruct.Rebuild(entry.Tokens, r.vars)
			if err != nil {
				t.Fatalf("rebuild: %v", err)
			}
			if string(raw) != string(r.sample.line) {
				t.Fatalf("rebuilt bytes differ at %d\n want %q\n got  %q",
					reconstruct.FirstDiff(r.sample.line, raw), r.sample.line, raw)
			}
			if stamp.SHA256(raw) != r.rawSHA {
				t.Fatal("rebuilt line does not rehash to the stored raw_sha256")
			}
		})
	}
}

// TestWrongEnvelopeIDNeverSilentlyVerifies pins the failure mode behind the
// live `verify` failures: a row whose envelope_id is not the envelope that
// matched must fail loudly, never rebuild into different bytes that pass.
func TestWrongEnvelopeIDNeverSilentlyVerifies(t *testing.T) {
	eng := engine(t)
	checked := 0
	for _, r := range store(t, eng) {
		entry := eng.Index.Find(r.templateID, r.envelopeID)
		if entry == nil {
			t.Fatalf("%s@%s missing", r.templateID, r.envelopeID)
		}
		for _, other := range eng.Index.Entries() {
			if other.Def.ID != r.templateID || other.EnvID == r.envelopeID {
				continue
			}
			checked++
			raw, err := reconstruct.Rebuild(other.Tokens, r.vars)
			if err != nil {
				continue // arity mismatch: rejected, which is what we want
			}
			if stamp.SHA256(raw) == r.rawSHA {
				t.Errorf("%s: vars rebuilt under envelope %q still matched the stored hash",
					r.sample.file, other.EnvID)
			}
		}
	}
	if checked == 0 {
		t.Fatal("no template is declared against more than one envelope; nothing was checked")
	}
}

// TestNohostEnvelopeIsRecorded pins the specific golden line that exposed the
// bug: an ASA message with the device-id omitted matches rfc3164_nohost, and
// the row must say so, because rfc3164_std has one extra slot.
func TestNohostEnvelopeIsRecorded(t *testing.T) {
	eng := engine(t)
	var found bool
	for _, s := range samples(t, "asa_") {
		if !strings.Contains(s.file, "nohost") {
			continue
		}
		found = true
		o := eng.Process(pipeline.Message{Raw: s.line, SourceID: "asa", RecvMS: recvMS,
			Topic: "raw", Partition: 0, Offset: 1})
		if got := o.Result.Row.EnvelopeID; got != "rfc3164_nohost" {
			t.Fatalf("%s: envelope_id = %q, want rfc3164_nohost", s.file, got)
		}
		std := eng.Index.Find(o.Result.Row.TemplateID, "rfc3164_std")
		if std == nil {
			t.Fatal("rfc3164_std variant is not compiled")
		}
		if _, err := reconstruct.Rebuild(std.Tokens, o.Result.Row.Vars); err == nil {
			t.Fatal("the std envelope accepted nohost vars; a wrong envelope_id would pass silently")
		}
	}
	if !found {
		t.Fatal("no nohost ASA golden sample found")
	}
}
