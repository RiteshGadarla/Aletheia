package pipeline_test

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Ritesh2006M/aletheia/pipeline"
	"github.com/Ritesh2006M/aletheia/reconstruct"
	"github.com/Ritesh2006M/aletheia/stamp"
	"github.com/Ritesh2006M/aletheia/template"
)

const (
	packsDir  = "../../packs"
	enumsFile = "../../ocsf/enums.yaml"
	recvMS    = int64(1789828262123) // 2026-09-19T14:31:02.123Z
)

// families ties each spec §9 format to the golden sample directories that
// carry it. Every listed format must survive the round trip byte for byte.
var families = []struct {
	name   string
	prefix string
}{
	{"cisco asa free text (§9.9)", "asa_"},
	{"fortigate key=value (§9.5)", "fgt_"},
	{"cef (§9.3)", "cef_"},
	{"leef (§9.4)", "leef_"},
	{"pfsense filterlog csv in syslog (§9.6)", "pfsense_"},
	{"squid space-delimited, ws slot (§9.8)", "squid_"},
	{"openvpn free text (§9.9)", "openvpn_"},
	{"suricata eve json (§9.7)", "suricata_"},
}

// sample is one golden line and where it came from.
type sample struct {
	dir  string
	file string
	line []byte
}

func engine(t *testing.T) *pipeline.Engine {
	t.Helper()
	eng, warn, err := pipeline.Load(pipeline.Paths{PacksDir: packsDir, EnumsFile: enumsFile})
	if err != nil {
		t.Fatalf("load packs from %s: %v", packsDir, err)
	}
	for _, w := range warn {
		t.Errorf("pack compile warning: %v", w)
	}
	if eng.Index.Len() == 0 {
		t.Fatal("no templates compiled")
	}
	return eng
}

// samples reads every golden line whose directory starts with prefix.
func samples(t *testing.T, prefix string) []sample {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join(packsDir, "tests", prefix+"*", "*.log"))
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	var out []sample
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read %s: %v", p, err)
		}
		for _, line := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
			if line == "" {
				continue
			}
			out = append(out, sample{dir: filepath.Base(filepath.Dir(p)), file: filepath.Base(p), line: []byte(line)})
		}
	}
	return out
}

// TestRoundTripGoldenSamples is the central guarantee: parse, then reconstruct,
// and the bytes must be identical (CONTRACTS §10.4, spec §6.6).
func TestRoundTripGoldenSamples(t *testing.T) {
	eng := engine(t)
	total := 0
	for _, fam := range families {
		fam := fam
		t.Run(fam.prefix, func(t *testing.T) {
			ss := samples(t, fam.prefix)
			if len(ss) == 0 {
				t.Fatalf("%s: no golden samples under %s/tests/%s*", fam.name, packsDir, fam.prefix)
			}
			for _, s := range ss {
				total++
				o := eng.Process(pipeline.Message{
					Raw: s.line, SourceID: "test", RecvMS: recvMS,
					Topic: "raw", Partition: 0, Offset: 1,
				})
				switch {
				case o.Quarantine:
					t.Errorf("%s/%s: no template matched", s.dir, s.file)
					continue
				case o.Mismatch:
					t.Errorf("%s/%s: reconstruct mismatch at byte %d", s.dir, s.file, o.MismatchOffset)
					continue
				}
				got, err := reconstruct.Rebuild(o.Tokens, o.Vars)
				if err != nil {
					t.Errorf("%s/%s: rebuild: %v", s.dir, s.file, err)
					continue
				}
				if !bytes.Equal(got, s.line) {
					t.Errorf("%s/%s: not byte-identical at %d\n want %q\n got  %q",
						s.dir, s.file, reconstruct.FirstDiff(s.line, got), s.line, got)
					continue
				}
				if h := stamp.SHA256(got); h != o.RawSHA {
					t.Errorf("%s/%s: rehash differs from arrival hash", s.dir, s.file)
				}
				if !o.Verified {
					t.Errorf("%s/%s: verified=false on a byte-identical reconstruction", s.dir, s.file)
				}
				if o.Mode != "template" {
					t.Errorf("%s/%s: storage_mode = %q, want template", s.dir, s.file, o.Mode)
				}
				if o.Status != "full" {
					t.Errorf("%s/%s: parse_status = %q, want full", s.dir, s.file, o.Status)
				}
				if o.Result.Row.EventUID != o.UID || len(o.UID) != 26 {
					t.Errorf("%s/%s: bad event_uid %q", s.dir, s.file, o.UID)
				}
			}
		})
	}
	if total < 30 {
		t.Errorf("only %d golden lines exercised; the corpus had 30", total)
	}
}

// TestSquidWhitespaceSlot pins the `ws` slot: Squid right-justifies the elapsed
// field, so the padding run must be captured, not normalized away.
func TestSquidWhitespaceSlot(t *testing.T) {
	eng := engine(t)
	ss := samples(t, "squid_")
	if len(ss) == 0 {
		t.Fatal("no squid samples")
	}
	for _, s := range ss {
		o := eng.Process(pipeline.Message{Raw: s.line, SourceID: "test", RecvMS: recvMS, Topic: "raw", Offset: 1})
		if o.Entry == nil {
			t.Fatalf("%s: no match", s.file)
		}
		ws := -1
		for i, tok := range o.Tokens {
			if tok.Type == template.TypeWS {
				ws = i
			}
		}
		if ws < 0 {
			t.Fatalf("%s: template has no ws slot", s.file)
		}
		spans := reconstruct.Lineage(o.Tokens, o.Vars)
		pad, ok := spans[o.Tokens[ws].Slot]
		if !ok {
			t.Fatalf("%s: ws slot has no lineage span", s.file)
		}
		run := string(s.line[pad.Start:pad.End])
		if strings.TrimLeft(run, " \t") != "" || run == "" {
			t.Fatalf("%s: ws span %q is not a whitespace run", s.file, run)
		}
	}
}

// TestNoMatchQuarantines pins CONTRACTS §10.2: an unknown line is never an
// error and is never dropped — it becomes a verbatim raw_only record.
func TestNoMatchQuarantines(t *testing.T) {
	eng := engine(t)
	cases := []struct{ name, raw string }{
		{"unknown_vendor_text", "<13>Sep 19 14:31:02 box1 wibble: nothing here matches any pack"},
		{"no_envelope", "totally unstructured line from an unknown device"},
		{"empty", ""},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			o := eng.Process(pipeline.Message{Raw: []byte(c.raw), SourceID: "test", RecvMS: recvMS, Topic: "raw", Offset: 7})
			if !o.Quarantine {
				t.Fatalf("matched a template it should not have: %s", o.Result.Row.TemplateID)
			}
			if o.Mismatch {
				t.Fatal("a miss must not be reported as a reconstruct mismatch")
			}
			if o.Mode != "verbatim" || o.Status != "raw_only" {
				t.Fatalf("storage_mode=%q parse_status=%q, want verbatim/raw_only", o.Mode, o.Status)
			}
			if o.Result.Row.RawVerbatim == nil || *o.Result.Row.RawVerbatim != c.raw {
				t.Fatal("raw bytes not preserved verbatim")
			}
			if o.RawSHA != stamp.SHA256([]byte(c.raw)) {
				t.Fatal("raw hash is not the hash of the arrival bytes")
			}
		})
	}
}

// TestProcessIsDeterministic pins idempotent redelivery (§12.4): same offset,
// same row, so ReplacingMergeTree collapses the duplicate.
func TestProcessIsDeterministic(t *testing.T) {
	eng := engine(t)
	ss := samples(t, "asa_")
	if len(ss) == 0 {
		t.Fatal("no asa samples")
	}
	m := pipeline.Message{Raw: ss[0].line, SourceID: "fw01", RecvMS: recvMS, Topic: "raw", Partition: 3, Offset: 4242}
	a, b := eng.Process(m), eng.Process(m)
	if a.UID != b.UID {
		t.Errorf("event_uid not deterministic: %s vs %s", a.UID, b.UID)
	}
	if a.MerkleBatch != b.MerkleBatch {
		t.Errorf("merkle batch not deterministic: %s vs %s", a.MerkleBatch, b.MerkleBatch)
	}
	if a.RawSHA != b.RawSHA {
		t.Error("raw hash not deterministic")
	}
	if want := "fw01/p3/2026-09-19T14:31Z"; a.MerkleBatch != want {
		t.Errorf("merkle batch = %q, want %q", a.MerkleBatch, want)
	}
}
