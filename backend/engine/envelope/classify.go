package envelope

import "strings"

// classify derives the body type hint and the matcher discriminator. Spec §6.4.
func classify(r *Result) {
	b := r.Body
	switch {
	case strings.HasPrefix(b, "CEF:"):
		r.BodyType = BodyCEF
		h := ParseCEF(b)
		for k, v := range h.Fields {
			r.Fields["cef_"+k] = v
		}
		r.Discriminator = "CEF:" + h.Vendor + "|" + h.Product + "|" + h.SignatureID
		return
	case strings.HasPrefix(b, "LEEF:"):
		r.BodyType = BodyLEEF
		h := ParseLEEF(b)
		for k, v := range h.Fields {
			r.Fields["leef_"+k] = v
		}
		r.Discriminator = "LEEF:" + h.Vendor + "|" + h.Product + "|" + h.EventID
		return
	case strings.HasPrefix(b, "{"):
		r.BodyType = BodyJSON
	case len(reKV.FindAllString(b, 2)) >= 2:
		r.BodyType = BodyKV
	case strings.Count(b, ",") >= 5:
		r.BodyType = BodyCSV
	default:
		r.BodyType = BodyText
	}

	if tag := r.Fields["tag"]; tag != "" {
		r.Discriminator = "tag:" + tag
		return
	}
	if m := reASA.FindString(b); m != "" {
		r.Discriminator = m
		return
	}
	if r.BodyType == BodyKV {
		if m := reLogID.FindStringSubmatch(b); m != nil {
			r.Discriminator = "logid=" + m[2]
			return
		}
	}
	if r.BodyType == BodyJSON {
		r.Discriminator = "json"
		return
	}
	if app := r.Fields["app"]; app != "" && app != "-" {
		r.Discriminator = "app:" + app
	}
}

// CEFHeader is the parsed CEF header. Spec §9.3.
type CEFHeader struct {
	Version     string
	Vendor      string
	Product     string
	DeviceVer   string
	SignatureID string
	Name        string
	Severity    string
	Extension   string
	Fields      map[string]string
}

// ParseCEF splits a CEF header on unescaped pipes.
func ParseCEF(b string) CEFHeader {
	p := splitUnescaped(b, '|', 8)
	get := func(i int) string {
		if i < len(p) {
			return p[i]
		}
		return ""
	}
	h := CEFHeader{
		Version:     strings.TrimPrefix(get(0), "CEF:"),
		Vendor:      get(1),
		Product:     get(2),
		DeviceVer:   get(3),
		SignatureID: get(4),
		Name:        get(5),
		Severity:    get(6),
		Extension:   get(7),
	}
	h.Fields = map[string]string{
		"version": h.Version, "vendor": h.Vendor, "product": h.Product,
		"device_version": h.DeviceVer, "signature_id": h.SignatureID,
		"name": h.Name, "severity": h.Severity,
	}
	return h
}

// LEEFHeader is the parsed LEEF header. Spec §9.4.
type LEEFHeader struct {
	Version   string
	Vendor    string
	Product   string
	DeviceVer string
	EventID   string
	Delimiter string
	Attrs     string
	Fields    map[string]string
}

// ParseLEEF splits a LEEF header, honouring the LEEF 2.0 delimiter field.
func ParseLEEF(b string) LEEFHeader {
	p := splitUnescaped(b, '|', 7)
	get := func(i int) string {
		if i < len(p) {
			return p[i]
		}
		return ""
	}
	h := LEEFHeader{
		Version:   strings.TrimPrefix(get(0), "LEEF:"),
		Vendor:    get(1),
		Product:   get(2),
		DeviceVer: get(3),
		EventID:   get(4),
		Delimiter: "\t",
		Attrs:     get(5),
	}
	// LEEF 2.0 may declare a delimiter in a sixth header field.
	if strings.HasPrefix(h.Version, "2") && len(p) > 6 && isDelimiterField(get(5)) {
		h.Delimiter = decodeDelimiter(get(5))
		h.Attrs = get(6)
	}
	h.Fields = map[string]string{
		"version": h.Version, "vendor": h.Vendor, "product": h.Product,
		"device_version": h.DeviceVer, "event_id": h.EventID, "delimiter": h.Delimiter,
	}
	return h
}

func isDelimiterField(s string) bool {
	if len(s) == 1 {
		return true
	}
	return len(s) == 4 && (strings.HasPrefix(s, "x") || strings.HasPrefix(s, "0x"))
}

func decodeDelimiter(s string) string {
	if len(s) == 1 {
		return s
	}
	t := strings.TrimPrefix(strings.TrimPrefix(s, "0x"), "x")
	var v int
	for i := 0; i < len(t); i++ {
		c := t[i]
		switch {
		case c >= '0' && c <= '9':
			v = v*16 + int(c-'0')
		case c >= 'a' && c <= 'f':
			v = v*16 + int(c-'a') + 10
		case c >= 'A' && c <= 'F':
			v = v*16 + int(c-'A') + 10
		default:
			return "\t"
		}
	}
	return string(rune(v))
}

// splitUnescaped splits on sep, treating a backslash as an escape, into at most n parts.
func splitUnescaped(s string, sep byte, n int) []string {
	var out []string
	var cur strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) {
			cur.WriteByte(s[i])
			cur.WriteByte(s[i+1])
			i++
			continue
		}
		if s[i] == sep && len(out) < n-1 {
			out = append(out, cur.String())
			cur.Reset()
			continue
		}
		cur.WriteByte(s[i])
	}
	out = append(out, cur.String())
	return out
}
