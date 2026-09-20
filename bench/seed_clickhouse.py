#!/usr/bin/env python3
"""Seed ClickHouse from the golden samples so the UI has real data before the worker exists.

Every row here went through the same path the engine uses: match a template, capture exact
substrings, reconstruct, and verify the reconstruction is byte-identical. A sample that does not
reconstruct is never inserted — the seeder holds to the same rule as the pipeline.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import random
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
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


def ch(sql: str, body: bytes | None = None, timeout: int = 60) -> str:
    q = urllib.parse.urlencode({"user": CH_USER, "password": CH_PASS,
                                "database": CH_DB, "query": sql})
    req = urllib.request.Request(f"{CH_URL}/?{q}", data=body or b"")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode().strip()
    except urllib.error.HTTPError as e:
        # ClickHouse puts the real reason in the body; a bare 500 says nothing.
        raise RuntimeError(f"ClickHouse: {e.read().decode()[:400]}") from e


def ulid(ts_ms: int, entropy: bytes) -> str:
    """Deterministic ULID, same construction as the engine (CONTRACTS section 4)."""
    n = (ts_ms << 80) | int.from_bytes(entropy[:10], "big")
    return "".join(CROCKFORD[(n >> (5 * i)) & 31] for i in range(25, -1, -1))


def v6(ip: str | None) -> str | None:
    """IPv4 is stored as IPv4-mapped IPv6 (schema note in init.sql)."""
    if not ip:
        return None
    return f"::ffff:{ip}" if ":" not in ip else ip


def dig(doc: dict, path: str):
    cur = doc
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repeat", type=int, default=40,
                    help="times to replay the corpus, with fresh timestamps")
    ap.add_argument("--seed", type=int, default=1337)
    ap.add_argument("--truncate", action="store_true", help="clear events first")
    a = ap.parse_args()
    rng = random.Random(a.seed)

    envelopes = yaml.safe_load((PACKS / "_envelopes.yaml").read_text())["envelopes"]
    enums = yaml.safe_load((ROOT / "backend" / "ocsf" / "enums.yaml").read_text())

    try:
        ch("SELECT 1")
    except Exception as exc:                                        # noqa: BLE001
        print(f"error: ClickHouse unreachable at {CH_URL}: {exc}", file=sys.stderr)
        print("run `make services` first", file=sys.stderr)
        return 2

    if a.truncate:
        ch("TRUNCATE TABLE IF EXISTS events")
        ch("TRUNCATE TABLE IF EXISTS templates")
        ch("TRUNCATE TABLE IF EXISTS baseline_events")

    units, templates, skipped = [], {}, 0
    for pack_file in sorted(PACKS.glob("*.yaml")):
        if pack_file.stem == "_envelopes":
            continue
        pack = yaml.safe_load(pack_file.read_text())
        for tpl in pack.get("templates", []):
            spec = (tpl.get("tests") or {}).get("samples")
            if not spec:
                continue
            for sample in sorted(glob.glob(str(PACKS / spec))):
                raw = Path(sample).read_text().rstrip("\n")
                for env_id in pack.get("envelopes", ["bare"]):
                    env = envelopes.get(env_id)
                    if env is None:
                        continue
                    try:
                        tokens = vp.splice(env, tpl["body"], tpl["id"])
                        rx, names = vp.compile_tokens(tokens, tpl["id"])
                    except vp.PackError:
                        continue
                    m = rx.match(raw)
                    if not m:
                        continue
                    vars_ = dict(zip(names, m.groups()))
                    # Same rule as the pipeline: no byte-exact rebuild, no row.
                    if vp.reconstruct(tokens, vars_) != raw:
                        skipped += 1
                        continue
                    doc = vp.normalize(pack, tpl, tokens, vars_, enums, raw)
                    templates[tpl["id"]] = (pack["pack"], int(pack.get("version", 1)),
                                            json.dumps(tokens, separators=(",", ":")))
                    units.append((pack, tpl, raw, names, m.groups(), doc, env_id))
                    break
    if not units:
        print("error: no reconstructable samples found", file=sys.stderr)
        return 1

    now = datetime.now(timezone.utc)
    rows, baseline = [], []
    for n in range(a.repeat):
        for k, (pack, tpl, raw, names, groups, doc, env_id) in enumerate(units):
            ts = now - timedelta(seconds=rng.randint(0, 3600))
            ts_ms = int(ts.timestamp() * 1000)
            ent = hashlib.sha256(f"seed|{n}|{k}".encode()).digest()
            uid = ulid(ts_ms, ent)
            tstr = ts.strftime("%Y-%m-%d %H:%M:%S.") + f"{ts.microsecond // 1000:03d}"
            src = (pack.get("applies_to", {}).get("product")
                   or pack["pack"]).lower().replace(" ", "_")
            cls = int(dig(doc, "class_uid") or 0)
            rows.append({
                "event_uid": uid, "recv_time": tstr, "event_time": tstr,
                "source_id": src, "envelope_id": env_id,
                "template_id": tpl["id"], "pack_version": int(pack.get("version", 1)),
                "storage_mode": "template", "parse_status": "full",
                "vars": list(groups),
                "raw_verbatim": None,
                "raw_sha256": hashlib.sha256(raw.encode()).hexdigest(),
                "class_uid": cls,
                "activity_id": int(dig(doc, "activity_id") or 0),
                "severity_id": int(dig(doc, "severity_id") or 1),
                "src_ip": v6(dig(doc, "src_endpoint.ip")),
                "src_port": dig(doc, "src_endpoint.port"),
                "dst_ip": v6(dig(doc, "dst_endpoint.ip")),
                "dst_port": dig(doc, "dst_endpoint.port"),
                "protocol": dig(doc, "connection_info.protocol_name") or "",
                "action_id": int(dig(doc, "action_id") or 0),
                "user_name": dig(doc, "user.name"),
                "unmapped": json.dumps(doc.get("unmapped") or {}, separators=(",", ":")),
                "ocsf_extra": json.dumps(
                    {k2: v2 for k2, v2 in doc.items()
                     if k2 in ("src_endpoint", "dst_endpoint", "connection_info", "traffic",
                               "http_request", "finding_info", "message", "metadata")},
                    separators=(",", ":"), default=str),
                "merkle_batch": f"{src}/p0/{ts.strftime('%Y-%m-%dT%H:%MZ')}",
            })
            baseline.append({"event_uid": uid, "recv_time": tstr, "source_id": src,
                             "raw": raw,
                             "normalized": json.dumps(doc, separators=(",", ":"), default=str)})

    tpl_rows = [{"template_id": tid, "pack": p, "pack_version": pv, "tokens": toks,
                 "created_at": now.strftime("%Y-%m-%d %H:%M:%S.000")}
                for tid, (p, pv, toks) in templates.items()]

    # raw_sha256 is FixedString(32) = 32 raw bytes, so the hex digest is unhex()ed on the way in.
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

    def insert(table: str, data: list[dict], select: str = "", spec: str = "") -> None:
        payload = "\n".join(json.dumps(r, default=str) for r in data).encode()
        if spec:
            sql = f"INSERT INTO {table} SELECT {select} FROM input('{spec}') FORMAT JSONEachRow"
        else:
            sql = f"INSERT INTO {table} FORMAT JSONEachRow"
        ch(sql, body=payload)

    insert("templates", tpl_rows)
    insert("events", rows, EVENTS_SEL, EVENTS_IN)
    insert("baseline_events", baseline)

    total = ch("SELECT count() FROM events")
    print(f"seeded {len(rows)} events from {len(units)} reconstructable samples "
          f"across {len(templates)} templates")
    if skipped:
        print(f"skipped {skipped} samples that did not reconstruct byte-exactly")
    print(f"events now in ClickHouse: {total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
