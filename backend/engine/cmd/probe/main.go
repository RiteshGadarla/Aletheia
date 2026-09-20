package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Ritesh2006M/aletheia/envelope"
	"github.com/Ritesh2006M/aletheia/pipeline"
)

func main() {
	lines := []string{
		`<166>Sep 19 14:31:02 fw01 %ASA-6-302013: Built outbound TCP connection 1234 for outside:203.0.113.5/443 (203.0.113.5/443) to inside:10.0.0.5/52144 (198.51.100.7/52144)`,
		`<165>1 2026-09-19T14:31:02.123+05:30 edge-rtr01 sshd 812 ID47 [meta sequenceId="29"] message text`,
		`<134>Sep 19 14:31:02 filterlog[1234]: 5,,,1000000103,em0,match,block,in,4`,
		`CEF:0|VendorX|NGFW|4.2|1001|Connection allowed|3|src=10.0.0.5 spt=52144`,
		`LEEF:2.0|VendorY|WAF|3.1|BLOCK|^|src=10.0.0.5^dst=203.0.113.9`,
		`date=2026-09-19 time=14:31:02 devname="FGT-EDGE" logid="0000000013" type="traffic"`,
		`1789828262.123    245 10.0.0.5 TCP_TUNNEL/200 5120 CONNECT example.com:443 - HIER_DIRECT/93.184.216.34 -`,
		`{"timestamp":"2026-09-19T14:31:02.123456+0530","event_type":"alert"}`,
	}
	for _, l := range lines {
		r := envelope.Decode([]byte(l))
		fmt.Printf("ID=%-20s type=%-5s disc=%-30q pri=%v sev=%d body=%q\n", r.ID, r.BodyType, r.Discriminator, r.Fields["pri"], r.Severity, trunc(r.Body))
	}
	fmt.Println("---- roundtrip over golden samples ----")
	eng, warn, err := pipeline.Load(pipeline.Paths{PacksDir: "../packs", EnumsFile: "../ocsf/enums.yaml"})
	if err != nil {
		fmt.Println("load:", err)
		os.Exit(1)
	}
	for _, w := range warn {
		fmt.Println("warn:", w)
	}
	files, _ := filepath.Glob("../packs/tests/*/*.log")
	for _, f := range files {
		b, _ := os.ReadFile(f)
		for _, line := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
			if line == "" {
				continue
			}
			o := eng.Process(pipeline.Message{Raw: []byte(line), SourceID: "t", RecvMS: 1789828262123, Topic: "raw", Partition: 0, Offset: 1})
			fmt.Printf("%-40s q=%v mm=%v ver=%v mode=%-8s status=%-8s tpl=%-22s env=%s\n",
				filepath.Base(filepath.Dir(f)), o.Quarantine, o.Mismatch, o.Verified, o.Mode, o.Status, o.Result.Row.TemplateID, o.Result.Row.EnvelopeID)
		}
	}
}

func trunc(s string) string {
	if len(s) > 40 {
		return s[:40]
	}
	return s
}
