"""Wire formats shared by log export and the supply stream.

Every dataset is first turned into flat-ish dicts (raw line, OCSF event, audit entry); this module
renders them into what downstream tools actually ingest: CEF (ArcSight, most SIEMs), LEEF (QRadar),
RFC 5424 syslog with RFC 6587 octet counting (rsyslog, syslog-ng, Splunk/Elastic TCP inputs),
XML, CSV/TSV and JSON. Raw lines are always carried whole, so a consumer can re-verify the SHA-256.
"""
from __future__ import annotations

import csv
import io
import json
import re
from datetime import datetime, timezone
from typing import Any, Iterable
from xml.sax.saxutils import escape as _xml_escape, quoteattr

VENDOR, PRODUCT, VERSION = "Aletheia", "Aletheia", "1.0"
# RFC 5612 documentation enterprise number: structured-data ids need one, and we have no PEN.
SD_ID = "aletheia@32473"

# Ingest severity words (rawstore.guess_severity) against the scales each format expects.
WORD_TO_OCSF = {"info": 1, "notice": 2, "warn": 3, "risk": 4}
WORD_TO_SYSLOG = {"info": 6, "notice": 5, "warn": 4, "risk": 3}
OCSF_TO_SYSLOG = {0: 6, 1: 6, 2: 5, 3: 4, 4: 3, 5: 2, 6: 1}
OCSF_TO_CEF = {0: 0, 1: 2, 2: 3, 3: 5, 4: 7, 5: 9, 6: 10}
ACTIONS = {0: "Unknown", 1: "Allowed", 2: "Denied", 3: "Observed", 4: "Modified"}
CLASSES = {1001: "File Activity", 1007: "Process Activity", 2004: "Detection Finding", 3001: "Account Change",
           3002: "Authentication", 4001: "Network Activity", 4002: "HTTP Activity", 4003: "DNS Activity",
           4007: "SSH Activity", 6003: "API Activity"}


# --------------------------------------------------------------------------- helpers
def iso_ns(ns: int | None) -> str:
    if not ns:
        return ""
    return datetime.fromtimestamp(ns / 1e9, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def iso_ms(ms: int | None) -> str:
    return iso_ns(int(ms) * 1_000_000) if ms else ""


def flatten(d: dict[str, Any], prefix: str = "") -> dict[str, Any]:
    """Nested dicts become dotted keys; lists stay whole as JSON so nothing is split or dropped."""
    out: dict[str, Any] = {}
    for k, v in d.items():
        key = f"{prefix}{k}"
        if isinstance(v, dict) and v:
            out.update(flatten(v, key + "."))
        elif isinstance(v, (dict, list)):
            out[key] = json.dumps(v, separators=(",", ":"))
        else:
            out[key] = v
    return out


def _cell(v: Any) -> str:
    return "" if v is None else "true" if v is True else "false" if v is False else str(v)


def _columns(rows: list[dict[str, Any]]) -> list[str]:
    """Union of keys in first-seen order: OCSF events differ in which objects they carry."""
    seen: dict[str, None] = {}
    for r in rows:
        seen.update(dict.fromkeys(r))
    return list(seen)


# --------------------------------------------------------------------------- per-dataset field maps
def _common(rec: dict[str, Any], dataset: str) -> dict[str, Any]:
    """The facts every event format needs, pulled out of whichever dataset shape `rec` is."""
    if dataset == "raw":
        return {"id": "raw", "name": "Raw log line", "ms": (rec.get("timestamp_ns") or 0) // 1_000_000,
                "host": rec.get("source_id", ""), "ocsf_sev": WORD_TO_OCSF.get(rec.get("severity", ""), 0),
                "sev_word": rec.get("severity", "info"), "sha256": rec.get("sha256", ""), "msg": rec.get("line", ""),
                "fields": {}}
    if dataset == "ocsf":
        a = rec.get("aletheia", {}) or {}
        src, dst = rec.get("src_endpoint") or {}, rec.get("dst_endpoint") or {}
        cls = int(rec.get("class_uid") or 0)
        return {"id": str(cls), "name": CLASSES.get(cls, f"Class {cls}"), "ms": rec.get("time") or 0,
                "host": a.get("source_id", ""), "ocsf_sev": int(rec.get("severity_id") or 0), "sev_word": "",
                "sha256": a.get("raw_sha256", ""), "msg": rec.get("raw_data", ""),
                "fields": {"src": src.get("ip"), "spt": src.get("port"), "dst": dst.get("ip"), "dpt": dst.get("port"),
                           "proto": (rec.get("connection_info") or {}).get("protocol_name"),
                           "act": ACTIONS.get(int(rec.get("action_id") or 0)) if rec.get("action_id") else None,
                           "user": (rec.get("user") or {}).get("name"), "uid": a.get("event_uid"),
                           "template": a.get("template_id"), "parse": a.get("parse_status"),
                           "verified": a.get("verified"), "batch": a.get("merkle_batch")}}
    return {"id": str(rec.get("action", "audit")), "name": str(rec.get("action", "audit")),
            "ms": _ms_from_iso(rec.get("time")), "host": "aletheia-studio", "ocsf_sev": 1, "sev_word": "info",
            "sha256": "", "msg": json.dumps(rec.get("detail") or {}, separators=(",", ":")),
            "fields": {"user": rec.get("actor"), "subject": rec.get("subject")}}


def _ms_from_iso(s: Any) -> int:
    try:
        return int(datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp() * 1000)
    except (TypeError, ValueError):
        return 0


# --------------------------------------------------------------------------- CEF
def _cef_h(v: Any) -> str:
    return _cell(v).replace("\\", "\\\\").replace("|", "\\|").replace("\r", " ").replace("\n", " ")


def _cef_v(v: Any) -> str:
    return _cell(v).replace("\\", "\\\\").replace("=", "\\=").replace("\r", "\\r").replace("\n", "\\n")


def to_cef(rec: dict[str, Any], dataset: str) -> str:
    c = _common(rec, dataset)
    f = c["fields"]
    sev = OCSF_TO_CEF.get(c["ocsf_sev"], 0)
    ext: list[tuple[str, Any]] = [("rt", c["ms"]), ("dvchost", c["host"]), ("src", f.get("src")), ("spt", f.get("spt")),
                                  ("dst", f.get("dst")), ("dpt", f.get("dpt")), ("proto", f.get("proto")),
                                  ("act", f.get("act")), ("suser", f.get("user")), ("externalId", f.get("uid")),
                                  ("cs1Label", "rawSha256" if c["sha256"] else None), ("cs1", c["sha256"] or None),
                                  ("cs2Label", "templateId" if f.get("template") else None), ("cs2", f.get("template")),
                                  ("cs3Label", "parseStatus" if f.get("parse") else None), ("cs3", f.get("parse")),
                                  ("cs4Label", "merkleBatch" if f.get("batch") else None), ("cs4", f.get("batch")),
                                  ("cs5Label", "verified" if f.get("verified") is not None else None), ("cs5", f.get("verified")),
                                  ("cs6Label", "subject" if f.get("subject") else None), ("cs6", f.get("subject")),
                                  ("msg", c["msg"])]
    body = " ".join(f"{k}={_cef_v(v)}" for k, v in ext if v not in (None, ""))
    return f"CEF:0|{VENDOR}|{PRODUCT}|{VERSION}|{_cef_h(c['id'])}|{_cef_h(c['name'])}|{sev}|{body}"


# --------------------------------------------------------------------------- LEEF 2.0 (tab-delimited)
def _leef_v(v: Any) -> str:
    return _cell(v).replace("\t", "\\t").replace("\r", "\\r").replace("\n", "\\n")


def to_leef(rec: dict[str, Any], dataset: str) -> str:
    c = _common(rec, dataset)
    f = c["fields"]
    attrs: list[tuple[str, Any]] = [("devTime", c["ms"] or None), ("sev", OCSF_TO_CEF.get(c["ocsf_sev"], 0)), ("cat", c["name"]), ("identHostName", c["host"]),
                                    ("src", f.get("src")), ("srcPort", f.get("spt")), ("dst", f.get("dst")),
                                    ("dstPort", f.get("dpt")), ("proto", f.get("proto")), ("action", f.get("act")),
                                    ("usrName", f.get("user")), ("eventUid", f.get("uid")), ("rawSha256", c["sha256"] or None),
                                    ("templateId", f.get("template")), ("parseStatus", f.get("parse")),
                                    ("verified", f.get("verified")), ("merkleBatch", f.get("batch")),
                                    ("subject", f.get("subject")), ("msg", c["msg"])]
    body = "\t".join(f"{k}={_leef_v(v)}" for k, v in attrs if v not in (None, ""))
    return f"LEEF:2.0|{VENDOR}|{PRODUCT}|{VERSION}|{_cef_h(c['id'])}|x09|{body}"


# --------------------------------------------------------------------------- RFC 5424
_HOST_BAD = re.compile(r"[^\x21-\x7e]")


def _sd(v: Any) -> str:
    return _cell(v).replace("\\", "\\\\").replace('"', '\\"').replace("]", "\\]")


def to_syslog5424(rec: dict[str, Any], dataset: str, facility: int = 16) -> str:
    """RFC 5424 line. MSG is the original event text untouched, so the hash in SD still matches it."""
    c = _common(rec, dataset)
    f = c["fields"]
    sev = WORD_TO_SYSLOG.get(c["sev_word"]) if c["sev_word"] else OCSF_TO_SYSLOG.get(c["ocsf_sev"], 6)
    host = _HOST_BAD.sub("_", c["host"])[:255] or "-"
    ts = iso_ms(c["ms"]) or "-"
    params = [("source", c["host"]), ("sha256", c["sha256"]), ("event_uid", f.get("uid")),
              ("parse_status", f.get("parse")), ("verified", f.get("verified"))]
    sd = "".join(f' {k}="{_sd(v)}"' for k, v in params if v not in (None, ""))
    msgid = {"raw": "raw", "ocsf": "ocsf"}.get(dataset, "audit")
    return f"<{facility * 8 + (sev if sev is not None else 6)}>1 {ts} {host} aletheia - {msgid} [{SD_ID}{sd}] {c['msg']}"


def octet_frame(msg: str) -> bytes:
    """RFC 6587 §3.4.1 octet counting: safe for messages that contain newlines."""
    b = msg.encode("utf-8")
    return str(len(b)).encode() + b" " + b


# --------------------------------------------------------------------------- whole-file renderers
_XML_BAD = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")


def _xml_text(v: Any) -> str:
    return _xml_escape(_XML_BAD.sub("\ufffd", _cell(v)))


def to_xml(records: list[dict[str, Any]], dataset: str, meta: dict[str, Any]) -> str:
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           "<aletheia-export " + " ".join(f"{k}={quoteattr(_cell(v))}" for k, v in meta.items()) + ">"]
    for r in records:
        out.append("  <record>")
        out += [f"    <field name={quoteattr(k)}>{_xml_text(v)}</field>" for k, v in flatten(r).items()]
        out.append("  </record>")
    out.append("</aletheia-export>")
    return "\n".join(out) + "\n"


def to_csv(records: list[dict[str, Any]]) -> str:
    rows = [flatten(r) for r in records]
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=_columns(rows), restval="")
    w.writeheader()
    for r in rows:
        w.writerow({k: _cell(v) for k, v in r.items()})
    return buf.getvalue()


def _tsv(v: Any) -> str:
    return _cell(v).replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r")


def to_tsv(records: list[dict[str, Any]]) -> str:
    rows = [flatten(r) for r in records]
    cols = _columns(rows)
    lines = ["\t".join(cols)] + ["\t".join(_tsv(r.get(c)) for c in cols) for r in rows]
    return "\n".join(lines) + "\n"


def lines(records: Iterable[dict[str, Any]], render: Any, dataset: str) -> str:
    out = "\n".join(render(r, dataset) for r in records)
    return out + "\n" if out else ""
