#!/usr/bin/env python3
"""Ingest raw log lines into ClickHouse using the worker's own decision path.

This is the Go worker's per-event logic (spec 8.1) in miniature, for the dockerless demo where
Redpanda and the worker are not in play:

    match a template -> capture exact substrings -> reconstruct -> verify byte-equality
      match + verified  -> storage_mode=template, parse_status=full
      no match          -> storage_mode=verbatim, parse_status=raw_only  (quarantined, NOT dropped)
      rebuild mismatch  -> storage_mode=verbatim, parse_status=raw_only  (engine defect)

The invariant that matters is preserved: **nothing is ever dropped**. A line that no template
understands is still stored in full, which is what makes the drift scenario meaningful.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKS = ROOT / "backend" / "packs"
sys.path.insert(0, str(PACKS))

import verify_packs as vp                                      # noqa: E402
import yaml                                                    # noqa: E402

CH_URL = os.environ.get("ALETHEIA_CH_URL", "http://localhost:8123")
CH_USER = os.environ.get("ALETHEIA_CH_USER", "aletheia")
CH_PASS = os.environ.get("ALETHEIA_CH_PASSWORD", "aletheia")
CH_DB = os.environ.get("ALETHEIA_CH_DB", "aletheia")

CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

EVENTS_IN = (
    "event_uid String, recv_time DateTime64(3), event_time DateTime64(3), source_id String, "
    "envelope_id String, template_id String, pack_version UInt32, storage_mode String, "
    "parse_status String, vars Array(String), raw_verbatim Nullable(String), "
    "raw_sha256 String, class_uid UInt16, activity_id UInt8, severity_id UInt8, "
    "src_ip Nullable(String), src_port Nullable(UInt16), dst_ip Nullable(String), "
    "dst_port Nullable(UInt16), protocol String, action_id UInt8, "
    "user_name Nullable(String), unmapped String, ocsf_extra String, merkle_batch String")
EVENTS_SEL = (
    "event_uid, recv_time, event_time, source_id, envelope_id, template_id, pack_version, "
    "storage_mode, parse_status, vars, raw_verbatim, unhex(raw_sha256), class_uid, "
    "activity_id, severity_id, toIPv6OrNull(src_ip), src_port, toIPv6OrNull(dst_ip), "
    "dst_port, protocol, action_id, user_name, unmapped, ocsf_extra, merkle_batch")


def ch(sql: str, body: bytes | None = None, timeout: int = 120) -> str:
    q = urllib.parse.urlencode({"user": CH_USER, "password": CH_PASS,
                                "database": CH_DB, "query": sql})
    req = urllib.request.Request(f"{CH_URL}/?{q}", data=body or b"")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode().strip()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"ClickHouse: {e.read().decode()[:400]}") from e


def ulid(ts_ms: int, entropy: bytes) -> str:
    n = (ts_ms << 80) | int.from_bytes(entropy[:10], "big")
    return "".join(CROCKFORD[(n >> (5 * i)) & 31] for i in range(25, -1, -1))


def v6(ip):
    if not ip:
        return None
    return f"::ffff:{ip}" if ":" not in str(ip) else str(ip)


def dig(doc: dict, path: str):
    cur = doc
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


class Matcher:
    """Compiled templates from every pack, tried in order — the engine's matcher index."""

    def __init__(self) -> None:
        envelopes = yaml.safe_load((PACKS / "_envelopes.yaml").read_text())["envelopes"]
        self.enums = yaml.safe_load((ROOT / "backend" / "ocsf" / "enums.yaml").read_text())
        self.entries = []
        for pack_file in sorted(PACKS.glob("*.yaml")):
            if pack_file.stem == "_envelopes":
                continue
            pack = yaml.safe_load(pack_file.read_text())
            for tpl in pack.get("templates", []):
                for env_id in pack.get("envelopes", ["bare"]):
                    env = envelopes.get(env_id)
                    if env is None:
                        continue
                    try:
                        tokens = vp.splice(env, tpl["body"], tpl["id"])
                        rx, names = vp.compile_tokens(tokens, tpl["id"])
                    except vp.PackError:
                        continue
                    self.entries.append((pack, tpl, env_id, tokens, rx, names))

    def match(self, raw: str):
        for pack, tpl, env_id, tokens, rx, names in self.entries:
            m = rx.match(raw)
            if not m:
                continue
            vars_ = dict(zip(names, m.groups()))
            # The gate the whole product rests on: no byte-exact rebuild, not template mode.
            if vp.reconstruct(tokens, vars_) != raw:
                continue
            try:
                doc = vp.normalize(pack, tpl, tokens, vars_, self.enums, raw)
            except Exception:                                   # noqa: BLE001
                # A permissive template (e.g. the JSON body one) can match text it cannot
                # actually normalize. That is not a real match — keep looking.
                continue
            return pack, tpl, env_id, tokens, list(m.groups()), doc
        return None


def row_for(raw: str, hit, i: int, now: datetime) -> tuple[dict, dict, tuple | None]:
    ts_ms = int(now.timestamp() * 1000)
    uid = ulid(ts_ms, hashlib.sha256(f"ingest|{now.timestamp()}|{i}|{raw}".encode()).digest())
    tstr = now.strftime("%Y-%m-%d %H:%M:%S.") + f"{now.microsecond // 1000:03d}"
    sha = hashlib.sha256(raw.encode()).hexdigest()

    if hit is None:
        # Unknown format: stored in full, flagged for onboarding. Never dropped.
        src = "unknown"
        row = {
            "event_uid": uid, "recv_time": tstr, "event_time": tstr, "source_id": src,
            "envelope_id": "", "template_id": "", "pack_version": 0,
            "storage_mode": "verbatim", "parse_status": "raw_only",
            "vars": [], "raw_verbatim": raw, "raw_sha256": sha,
            "class_uid": 0, "activity_id": 0, "severity_id": 1,
            "src_ip": None, "src_port": None, "dst_ip": None, "dst_port": None,
            "protocol": "", "action_id": 0, "user_name": None,
            "unmapped": "{}", "ocsf_extra": "{}",
            "merkle_batch": f"{src}/p0/{now.strftime('%Y-%m-%dT%H:%MZ')}",
        }
        return row, {"event_uid": uid, "recv_time": tstr, "source_id": src,
                     "raw": raw, "normalized": "{}"}, None

    pack, tpl, env_id, tokens, groups, doc = hit
    src = (pack.get("applies_to", {}).get("product") or pack["pack"]).lower().replace(" ", "_")
    # Honour the pack's declared storage_mode. Suricata EVE declares `verbatim` because byte-exact
    # templating of arbitrary JSON is fragile (spec §9.7), and verify_packs.py already reports it
    # that way -- hardcoding "template" here meant the stored rows disagreed with both the pack and
    # the reference verifier, and left the verbatim read path in `aletheia verify` never exercised.
    mode = tpl.get("storage_mode", pack.get("storage_mode", "template"))
    row = {
        "event_uid": uid, "recv_time": tstr, "event_time": tstr, "source_id": src,
        "envelope_id": env_id, "template_id": tpl["id"],
        "pack_version": int(pack.get("version", 1)),
        "storage_mode": mode, "parse_status": "full",
        # A verbatim event keeps the whole line; its vars are not the system of record.
        "vars": groups, "raw_verbatim": raw if mode == "verbatim" else None, "raw_sha256": sha,
        "class_uid": int(dig(doc, "class_uid") or 0),
        "activity_id": int(dig(doc, "activity_id") or 0),
        "severity_id": int(dig(doc, "severity_id") or 1),
        "src_ip": v6(dig(doc, "src_endpoint.ip")), "src_port": dig(doc, "src_endpoint.port"),
        "dst_ip": v6(dig(doc, "dst_endpoint.ip")), "dst_port": dig(doc, "dst_endpoint.port"),
        "protocol": dig(doc, "connection_info.protocol_name") or "",
        "action_id": int(dig(doc, "action_id") or 0),
        "user_name": dig(doc, "user.name"),
        "unmapped": json.dumps(doc.get("unmapped") or {}, separators=(",", ":")),
        "ocsf_extra": json.dumps(
            {k: v for k, v in doc.items()
             if k in ("src_endpoint", "dst_endpoint", "connection_info", "traffic",
                      "http_request", "finding_info", "message", "metadata")},
            separators=(",", ":"), default=str),
        "merkle_batch": f"{src}/p0/{now.strftime('%Y-%m-%dT%H:%MZ')}",
    }
    tpl_row = (tpl["id"], pack["pack"], int(pack.get("version", 1)),
               json.dumps(tokens, separators=(",", ":")))
    return row, {"event_uid": uid, "recv_time": tstr, "source_id": src, "raw": raw,
                 "normalized": json.dumps(doc, separators=(",", ":"), default=str)}, tpl_row


def ingest_lines(lines: list[str]) -> dict:
    matcher = Matcher()
    now = datetime.now(timezone.utc)
    rows, baseline, tpls = [], [], {}
    matched = 0
    for i, raw in enumerate(lines):
        raw = raw.rstrip("\n")
        if not raw:
            continue
        hit = matcher.match(raw)
        if hit:
            matched += 1
        row, base, tpl_row = row_for(raw, hit, i, now)
        rows.append(row)
        baseline.append(base)
        if tpl_row:
            tpls[tpl_row[0]] = tpl_row

    if not rows:
        return {"ingested": 0, "matched": 0, "quarantined": 0}

    if tpls:
        payload = "\n".join(json.dumps({
            "template_id": t[0], "pack": t[1], "pack_version": t[2], "tokens": t[3],
            "created_at": now.strftime("%Y-%m-%d %H:%M:%S.000")}) for t in tpls.values()).encode()
        ch("INSERT INTO templates FORMAT JSONEachRow", body=payload)

    ch(f"INSERT INTO events SELECT {EVENTS_SEL} FROM input('{EVENTS_IN}') FORMAT JSONEachRow",
       body="\n".join(json.dumps(r, default=str) for r in rows).encode())
    ch("INSERT INTO baseline_events FORMAT JSONEachRow",
       body="\n".join(json.dumps(r, default=str) for r in baseline).encode())

    return {"ingested": len(rows), "matched": matched, "quarantined": len(rows) - matched}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--file", help="file of raw log lines (default: stdin)")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    lines = (Path(a.file).read_text().splitlines() if a.file else sys.stdin.read().splitlines())
    try:
        out = ingest_lines(lines)
    except Exception as exc:                                        # noqa: BLE001
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if a.json:
        print(json.dumps(out))
    else:
        print(f"ingested {out['ingested']} lines: {out['matched']} normalized, "
              f"{out['quarantined']} quarantined (stored verbatim, never dropped)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
