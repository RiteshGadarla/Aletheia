package registry

import (
	"path/filepath"
	"strings"
	"testing"
)

const packsDir = "../../packs"

// TestLoadShippedPacks: every pack in backend/packs must parse and compile, and
// carry the pack identity down onto each template (CONTRACTS §2).
func TestLoadShippedPacks(t *testing.T) {
	packs, err := LoadDir(packsDir)
	if err != nil {
		t.Fatalf("LoadDir(%s): %v", packsDir, err)
	}
	if len(packs) == 0 {
		t.Fatalf("no packs found under %s", packsDir)
	}
	envs, err := LoadEnvelopes(filepath.Join(packsDir, "_envelopes.yaml"))
	if err != nil {
		t.Fatalf("LoadEnvelopes: %v", err)
	}
	if len(envs) == 0 {
		t.Fatal("no envelopes loaded")
	}
	for _, p := range packs {
		p := p
		t.Run(p.Pack, func(t *testing.T) {
			if p.Version == 0 {
				t.Error("pack version is 0")
			}
			if len(p.Checksum) != 64 {
				t.Errorf("checksum = %q, want 64 hex characters", p.Checksum)
			}
			for _, td := range p.Templates {
				if td.Compiled == nil {
					t.Errorf("%s: not compiled", td.ID)
					continue
				}
				if td.Pack != p.Pack || td.PackVersion != p.Version {
					t.Errorf("%s: pack identity not propagated", td.ID)
				}
				if len(td.Envelopes) == 0 {
					t.Errorf("%s: no envelope declared by the template or the pack", td.ID)
				}
				for _, name := range td.Envelopes {
					if _, ok := envs[name]; !ok {
						t.Errorf("%s: declares unknown envelope %q", td.ID, name)
					}
				}
				if td.OCSF.ClassUID == 0 {
					t.Errorf("%s: no OCSF class_uid", td.ID)
				}
			}
		})
	}
}

// TestParsePackRejects covers the pack-level validation gate.
func TestParsePackRejects(t *testing.T) {
	cases := []struct{ name, yaml, wantErr string }{
		{"no_pack_name", "version: 1\ntemplates: [{id: a, body: [{lit: x}]}]\n", "missing pack name"},
		{"no_templates", "pack: p\nversion: 1\ntemplates: []\n", "no templates"},
		{"template_without_id", "pack: p\nversion: 1\ntemplates: [{body: [{lit: x}]}]\n", "template with no id"},
		{"duplicate_template_id",
			"pack: p\nversion: 1\ntemplates:\n  - {id: a, body: [{lit: x}]}\n  - {id: a, body: [{lit: y}]}\n",
			"duplicate template id"},
		{"uncompilable_body",
			"pack: p\nversion: 1\ntemplates:\n  - id: a\n    body: [{slot: x, type: word}, {slot: y, type: word}]\n",
			"ambiguous"},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			_, err := ParsePack([]byte(c.yaml), "mem.yaml")
			if err == nil {
				t.Fatalf("accepted an invalid pack, want error containing %q", c.wantErr)
			}
			if !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("error = %v, want it to contain %q", err, c.wantErr)
			}
		})
	}
}

// TestMapTargetForms pins the three YAML shapes a `map:` value may take: a bare
// OCSF path, an object, or a sequence of either (CONTRACTS §2).
func TestMapTargetForms(t *testing.T) {
	src := `
pack: p
version: 1
templates:
  - id: a
    body: [{lit: "x="}, {slot: v, type: word}]
    ocsf:
      class_uid: 4001
      activity_id: 1
      map:
        bare: dst_endpoint.ip
        obj: {path: connection_info.direction_id, enum: {outbound: 2}, transform: to_int}
        many:
          - connection_info.protocol_num
          - {path: connection_info.protocol_name, enum: {6: tcp}}
`
	p, err := ParsePack([]byte(src), "mem.yaml")
	if err != nil {
		t.Fatalf("ParsePack: %v", err)
	}
	m := p.Templates[0].OCSF.Map
	if got := m["bare"]; len(got) != 1 || got[0].Path != "dst_endpoint.ip" {
		t.Errorf("scalar form = %+v", got)
	}
	obj := m["obj"]
	if len(obj) != 1 || obj[0].Path != "connection_info.direction_id" ||
		obj[0].Transform != "to_int" || obj[0].Enum["outbound"] != 2 {
		t.Errorf("object form = %+v", obj)
	}
	many := m["many"]
	if len(many) != 2 || many[0].Path != "connection_info.protocol_num" ||
		many[1].Enum["6"] != "tcp" {
		t.Errorf("sequence form = %+v", many)
	}
}
