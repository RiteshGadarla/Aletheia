package normalize

import (
	"sort"
	"strconv"
	"strings"

	"github.com/Ritesh2006M/aletheia/registry"
)

// applyMap writes each mapped slot to its OCSF path, applying enum tables and
// transforms. Returns false if any mapping could not be applied, which
// downgrades parse_status to partial. Spec §6.7 steps 3 and 6.
func applyMap(ev map[string]any, m map[string]registry.Targets, vals map[string]Typed,
	mapped map[string]bool, en *Enums, recvMS int64, src *registry.Source) bool {

	slots := make([]string, 0, len(m))
	for s := range m {
		slots = append(slots, s)
	}
	sort.Strings(slots) // deterministic write order

	ok := true
	for _, slot := range slots {
		tgts := m[slot]
		v, found := vals[slot]
		if !found || len(tgts) == 0 {
			ok = false
			continue
		}
		mapped[slot] = true
		for _, tgt := range tgts {
			if tgt.Path == "" {
				ok = false
				continue
			}
			val, good := derive(tgt, v, en, recvMS, src)
			if !good {
				// An enum with no entry for this value stays unset; the exact
				// substring is still in vars, so nothing is lost.
				ok = false
				if len(tgt.Enum) > 0 {
					continue
				}
			}
			setPath(ev, tgt.Path, val)
			decorate(ev, tgt.Path, v, val, en)
		}
	}
	return ok
}

// derive computes the typed OCSF value for one mapping.
func derive(tgt registry.MapTarget, v Typed, en *Enums, recvMS int64, src *registry.Source) (any, bool) {
	raw := Unquote(v.Raw)

	if len(tgt.Enum) > 0 {
		if id, hit := tgt.Enum[raw]; hit {
			return id, true
		}
		if id, hit := tgt.Enum[strings.ToLower(raw)]; hit {
			return id, true
		}
		return nil, false
	}

	switch tgt.Transform {
	case "to_int":
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			return raw, false
		}
		return n, true
	case "to_ip":
		ip := toIP(raw)
		if ip == "" {
			return raw, false
		}
		return ip, true
	case "lowercase":
		return strings.ToLower(raw), true
	case "ts_parse":
		ms, hit := ParseAny(raw, recvMS, src.Location())
		if !hit {
			return raw, false
		}
		return ms, true
	}

	if isActionPath(tgt.Path) {
		id := en.ActionID(raw)
		return id, id != 0
	}
	if v.Valid {
		return v.Value, true
	}
	return raw, false
}

// decorate fills derived siblings: the action word and the protocol name.
func decorate(ev map[string]any, path string, v Typed, val any, en *Enums) {
	switch {
	case isActionPath(path):
		setSibling(ev, path, "action", strings.ToLower(Unquote(v.Raw)))
	case strings.HasSuffix(path, "protocol_num"):
		if name := en.ProtocolName(asInt(val)); name != "" {
			setSibling(ev, path, "protocol_name", name)
		}
	}
}

func isActionPath(p string) bool {
	return p == "action_id" || strings.HasSuffix(p, ".action_id")
}

// setSibling writes leaf next to path's own leaf, without overwriting.
func setSibling(ev map[string]any, path, leaf string, v any) {
	i := strings.LastIndexByte(path, '.')
	sib := leaf
	if i >= 0 {
		sib = path[:i+1] + leaf
	}
	if _, exists := getPath(ev, sib); !exists {
		setPath(ev, sib, v)
	}
}
