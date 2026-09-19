package normalize

import (
	"encoding/json"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Ritesh2006M/aletheia/envelope"
	"github.com/Ritesh2006M/aletheia/registry"
	"github.com/Ritesh2006M/aletheia/stamp"
	"github.com/Ritesh2006M/aletheia/template"
)

// Input is everything the normalizer needs for one event.
type Input struct {
	EventUID    string
	SourceID    string
	RecvMS      int64
	RawSHA      [32]byte
	Raw         []byte
	Verified    bool
	MerkleBatch string
	Envelope    envelope.Result
	Template    *registry.TemplateDef // nil on a matcher miss
	Vars        []string              // body vars, in body token order
	Source      *registry.Source
	StorageMode string
	Enums       *Enums
}

// Row is one ClickHouse `events` row. Column names and order follow
// deploy/clickhouse/init.sql exactly (CONTRACTS §6).
type Row struct {
	EventUID    string
	RecvTime    time.Time
	EventTime   time.Time
	SourceID    string
	EnvelopeID  string
	TemplateID  string
	PackVersion uint32
	StorageMode string
	ParseStatus string
	Vars        []string
	RawVerbatim *string
	RawSHA256   []byte
	ClassUID    uint16
	ActivityID  uint8
	SeverityID  uint8
	SrcIP       *net.IP
	SrcPort     *uint16
	DstIP       *net.IP
	DstPort     *uint16
	Protocol    string
	ActionID    uint8
	UserName    *string
	Unmapped    string
	OCSFExtra   string
	MerkleBatch string
}

// Result carries the normalized event in both shapes.
type Result struct {
	Event       map[string]any // CONTRACTS §5 JSON
	Row         Row
	ParseStatus string
	EventTimeMS int64
	Spans       map[string]template.Span
}

// JSON marshals the normalized event for the `normalized` topic.
func (r Result) JSON() ([]byte, error) { return json.Marshal(r.Event) }

// Normalize builds the OCSF event and the storage row. It never fails: an
// unmatched or invalid event still produces a complete, lossless record.
func Normalize(in Input) Result {
	en := in.Enums
	if en == nil {
		en = Default
	}
	src := in.Source
	if src == nil {
		src = &registry.Source{SourceID: in.SourceID, Timezone: "UTC"}
	}
	ev := map[string]any{}
	unmapped := map[string]string{}
	status := StatusFull

	// --- envelope-derived fields -------------------------------------------
	origTime := ""
	eventMS := in.RecvMS
	timeFromRaw := false
	if ts := in.Envelope.Fields["ts"]; ts != "" {
		origTime = ts
		if ms, ok := ParseAny(ts, in.RecvMS, src.Location()); ok {
			eventMS, timeFromRaw = ms, true
		} else {
			status = StatusPartial
		}
	}
	if h := in.Envelope.Fields["host"]; h != "" {
		setPath(ev, "device.hostname", h)
	}
	for _, k := range []string{"tag", "pid", "app", "procid", "msgid"} {
		if v := in.Envelope.Fields[k]; v != "" && v != "-" {
			unmapped["syslog_"+k] = v
		}
	}
	if sd := in.Envelope.Fields["sd"]; sd != "" && sd != "-" {
		for k, v := range ParseStructuredData(sd) {
			unmapped["sd."+k] = v
		}
	}

	// --- class, activity, severity -----------------------------------------
	severity := 1
	if in.Envelope.Severity >= 0 {
		severity = en.SeverityFromPRI(in.Envelope.Severity)
	}
	classUID, activityID := 0, 0
	templateID, pack := "", ""
	var packVersion uint32
	var toks []template.Token
	var vals map[string]Typed

	if in.Template == nil {
		status = StatusRawOnly
	} else {
		td := in.Template
		templateID, pack, packVersion = td.ID, td.Pack, td.PackVersion
		classUID, activityID = td.OCSF.ClassUID, td.OCSF.ActivityID
		if td.OCSF.SeverityID != nil {
			severity = *td.OCSF.SeverityID
		}
		toks = td.Body
		vals = typeVars(toks, in.Vars)
		for _, v := range vals {
			if !v.Valid && status == StatusFull {
				status = StatusPartial
			}
		}

		applyConstants(ev, td.OCSF.Constants)
		mapped := map[string]bool{}
		if !applyMap(ev, td.OCSF.Map, vals, mapped, en, in.RecvMS, src) && status == StatusFull {
			status = StatusPartial
		}
		for _, c := range td.OCSF.Conditional {
			if !condMatches(c.When, vals) {
				continue
			}
			applyConstants(ev, c.Constants)
			if !applyMap(ev, c.Map, vals, mapped, en, in.RecvMS, src) && status == StatusFull {
				status = StatusPartial
			}
		}
		// Slots with no mapping are kept verbatim so nothing is lost.
		for _, tok := range toks {
			if tok.IsLit() || mapped[tok.Slot] {
				continue
			}
			if v, ok := vals[tok.Slot]; ok {
				unmapped[tok.Slot] = v.Raw
			}
		}
		for _, s := range td.OCSF.UnmappedKeep {
			if v, ok := vals[s]; ok {
				unmapped[s] = v.Raw
			}
		}
		// A slot mapped through ts_parse wins over the envelope timestamp.
		if ms, raw, ok := mappedTime(td, vals, in.RecvMS, src); ok {
			eventMS, timeFromRaw = ms, true
			if origTime == "" {
				origTime = raw
			}
		}
	}

	if !timeFromRaw {
		unmapped["time_source"] = "recv_time"
	}

	// --- required OCSF scaffolding -----------------------------------------
	ev["class_uid"] = classUID
	ev["category_uid"] = en.CategoryUID(classUID)
	ev["activity_id"] = activityID
	ev["type_uid"] = classUID*100 + activityID
	ev["time"] = eventMS
	ev["severity_id"] = severity

	md, _ := ev["metadata"].(map[string]any)
	if md == nil {
		md = map[string]any{}
		ev["metadata"] = md
	}
	md["version"] = OCSFVersion
	md["uid"] = in.EventUID
	if origTime != "" {
		md["original_time"] = origTime
	}
	md["log_name"] = in.SourceID
	if src.Vendor != "" || src.Product != "" {
		prod, _ := md["product"].(map[string]any)
		if prod == nil {
			prod = map[string]any{}
			md["product"] = prod
		}
		if src.Vendor != "" {
			prod["vendor_name"] = src.Vendor
		}
		if src.Product != "" {
			prod["name"] = src.Product
		}
	}
	if src.DeviceType != "" {
		setPath(ev, "device.type", src.DeviceType)
	}

	ev["unmapped"] = unmapped

	mode := in.StorageMode
	if mode == "" {
		mode = ModeTemplate
	}
	if status == StatusRawOnly {
		mode = ModeVerbatim
	}
	ev["aletheia"] = map[string]any{
		"event_uid":    in.EventUID,
		"source_id":    in.SourceID,
		"parse_status": status,
		"storage_mode": mode,
		"template_id":  templateID,
		"pack":         pack,
		"pack_version": packVersion,
		"raw_sha256":   stamp.Hex(in.RawSHA),
		"verified":     in.Verified,
		"merkle_batch": in.MerkleBatch,
	}

	res := Result{Event: ev, ParseStatus: status, EventTimeMS: eventMS}
	if toks != nil {
		res.Spans = template.Spans(toks, in.Vars)
	}
	res.Row = buildRow(in, ev, unmapped, status, mode, eventMS, templateID, packVersion,
		uint16(classUID), uint8(activityID), uint8(severity))
	return res
}

// typeVars validates every body var against its slot type.
func typeVars(toks []template.Token, vars []string) map[string]Typed {
	out := make(map[string]Typed, len(vars))
	i := 0
	for _, t := range toks {
		if t.IsLit() {
			continue
		}
		if i >= len(vars) {
			break
		}
		out[t.Slot] = Validate(t, vars[i])
		i++
	}
	return out
}

func condMatches(when map[string]string, vals map[string]Typed) bool {
	for slot, want := range when {
		v, ok := vals[slot]
		if !ok || (v.Raw != want && Unquote(v.Raw) != want) {
			return false
		}
	}
	return len(when) > 0
}

func applyConstants(ev map[string]any, c map[string]any) {
	keys := make([]string, 0, len(c))
	for k := range c {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		setPath(ev, k, c[k])
	}
}

func mappedTime(td *registry.TemplateDef, vals map[string]Typed, recvMS int64, src *registry.Source) (int64, string, bool) {
	check := func(m map[string]registry.MapTarget) (int64, string, bool) {
		slots := make([]string, 0, len(m))
		for s := range m {
			slots = append(slots, s)
		}
		sort.Strings(slots)
		for _, s := range slots {
			if m[s].Transform != "ts_parse" {
				continue
			}
			v, ok := vals[s]
			if !ok {
				continue
			}
			if ms, ok := ParseAny(Unquote(v.Raw), recvMS, src.Location()); ok {
				return ms, v.Raw, true
			}
		}
		return 0, "", false
	}
	if ms, raw, ok := check(td.OCSF.Map); ok {
		return ms, raw, true
	}
	for _, c := range td.OCSF.Conditional {
		if !condMatches(c.When, vals) {
			continue
		}
		if ms, raw, ok := check(c.Map); ok {
			return ms, raw, true
		}
	}
	return 0, "", false
}

// setPath writes v at a dotted OCSF path, creating intermediate objects.
func setPath(m map[string]any, path string, v any) {
	parts := strings.Split(path, ".")
	cur := m
	for i := 0; i < len(parts)-1; i++ {
		next, ok := cur[parts[i]].(map[string]any)
		if !ok {
			next = map[string]any{}
			cur[parts[i]] = next
		}
		cur = next
	}
	cur[parts[len(parts)-1]] = v
}

// getPath reads a dotted OCSF path.
func getPath(m map[string]any, path string) (any, bool) {
	parts := strings.Split(path, ".")
	var cur any = m
	for _, p := range parts {
		obj, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		cur, ok = obj[p]
		if !ok {
			return nil, false
		}
	}
	return cur, true
}

// ParseStructuredData flattens RFC 5424 SD into `sdid.param` string pairs.
func ParseStructuredData(sd string) map[string]string {
	out := map[string]string{}
	i := 0
	for i < len(sd) {
		if sd[i] != '[' {
			i++
			continue
		}
		j, depth := i+1, 1
		for j < len(sd) && depth > 0 {
			switch {
			case sd[j] == '\\':
				j++
			case sd[j] == ']':
				depth--
			}
			j++
		}
		elem := sd[i+1 : j-1]
		fields := splitSD(elem)
		if len(fields) == 0 {
			i = j
			continue
		}
		id := fields[0]
		for _, f := range fields[1:] {
			k, v, ok := strings.Cut(f, "=")
			if !ok {
				continue
			}
			out[id+"."+k] = strings.Trim(v, `"`)
		}
		i = j
	}
	return out
}

// splitSD splits an SD element on spaces outside quoted values.
func splitSD(s string) []string {
	var out []string
	var cur strings.Builder
	inQ := false
	for i := 0; i < len(s); i++ {
		switch {
		case s[i] == '\\' && i+1 < len(s):
			cur.WriteByte(s[i])
			cur.WriteByte(s[i+1])
			i++
		case s[i] == '"':
			inQ = !inQ
			cur.WriteByte(s[i])
		case s[i] == ' ' && !inQ:
			if cur.Len() > 0 {
				out = append(out, cur.String())
				cur.Reset()
			}
		default:
			cur.WriteByte(s[i])
		}
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}

// buildRow projects the OCSF event onto the ClickHouse column set.
func buildRow(in Input, ev map[string]any, unmapped map[string]string, status, mode string,
	eventMS int64, templateID string, packVersion uint32, classUID uint16, activityID, severity uint8) Row {

	r := Row{
		EventUID:    in.EventUID,
		RecvTime:    time.UnixMilli(in.RecvMS).UTC(),
		EventTime:   time.UnixMilli(eventMS).UTC(),
		SourceID:    in.SourceID,
		EnvelopeID:  in.Envelope.ID,
		TemplateID:  templateID,
		PackVersion: packVersion,
		StorageMode: mode,
		ParseStatus: status,
		RawSHA256:   append([]byte(nil), in.RawSHA[:]...),
		ClassUID:    classUID,
		ActivityID:  activityID,
		SeverityID:  severity,
		MerkleBatch: in.MerkleBatch,
	}
	if mode == ModeTemplate {
		r.Vars = in.Envelope.FullVars(in.Vars)
	} else {
		r.Vars = []string{}
		s := string(in.Raw)
		r.RawVerbatim = &s
	}
	if v, ok := getPath(ev, "src_endpoint.ip"); ok {
		r.SrcIP = netIP(asString(v))
	}
	if v, ok := getPath(ev, "dst_endpoint.ip"); ok {
		r.DstIP = netIP(asString(v))
	}
	r.SrcPort = asPort(ev, "src_endpoint.port")
	r.DstPort = asPort(ev, "dst_endpoint.port")
	if v, ok := getPath(ev, "connection_info.protocol_name"); ok {
		r.Protocol = asString(v)
	}
	if v, ok := ev["action_id"]; ok {
		r.ActionID = uint8(asInt(v))
	}
	for _, p := range []string{"actor.user.name", "user.name", "src_endpoint.svc_name"} {
		if v, ok := getPath(ev, p); ok {
			s := asString(v)
			r.UserName = &s
			break
		}
	}
	um, _ := json.Marshal(unmapped)
	r.Unmapped = string(um)

	extra := make(map[string]any, len(ev))
	for k, v := range ev {
		if k == "unmapped" || k == "aletheia" {
			continue
		}
		extra[k] = v
	}
	ex, _ := json.Marshal(extra)
	r.OCSFExtra = string(ex)
	return r
}

func asString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	default:
		return ""
	}
}

func asInt(v any) int {
	switch x := v.(type) {
	case int:
		return x
	case int64:
		return int(x)
	case float64:
		return int(x)
	case string:
		n, _ := strconv.Atoi(x)
		return n
	}
	return 0
}

func asPort(ev map[string]any, path string) *uint16 {
	v, ok := getPath(ev, path)
	if !ok {
		return nil
	}
	n := asInt(v)
	if n < 0 || n > 65535 {
		return nil
	}
	p := uint16(n)
	return &p
}
