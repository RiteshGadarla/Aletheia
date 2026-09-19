#!/usr/bin/env python3
"""Storage efficiency, reported the two ways spec §17 demands.

Comparing Aletheia only against *uncompressed* raw would flatter it: ClickHouse already ZSTDs raw
text well. So we report against the realistic baseline (raw + normalized copies) AND against
ZSTD-compressed raw alone, which is the harder and more honest number.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import urllib.request

# Compressed bytes per table, straight from ClickHouse's own accounting.
PARTS_SQL = """
SELECT table, sum(data_compressed_bytes) AS comp, sum(data_uncompressed_bytes) AS uncomp,
       sum(rows) AS rows
FROM system.parts
WHERE active AND database = '{db}' AND table IN ('events','baseline_events')
GROUP BY table FORMAT JSON
"""

# The raw column of baseline_events alone — Aletheia's hardest comparison.
RAW_ONLY_SQL = """
SELECT sum(data_compressed_bytes) AS comp
FROM system.columns
WHERE database = '{db}' AND table = 'baseline_events' AND name = 'raw' FORMAT JSON
"""


def query(url: str, sql: str, user: str, password: str) -> dict:
    params = urllib.parse.urlencode({"query": sql, "user": user, "password": password})
    with urllib.request.urlopen(f"{url}/?{params}", timeout=30) as r:
        return json.loads(r.read())


def human(n: float) -> str:
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if abs(n) < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} PiB"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", default="http://localhost:8123")
    ap.add_argument("--db", default="aletheia")
    ap.add_argument("--user", default="default")
    ap.add_argument("--password", default="")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    a = ap.parse_args()

    try:
        parts = query(a.url, PARTS_SQL.format(db=a.db), a.user, a.password)
        raw_only = query(a.url, RAW_ONLY_SQL.format(db=a.db), a.user, a.password)
    except Exception as exc:                                    # noqa: BLE001
        print(f"error: cannot reach ClickHouse at {a.url}: {exc}", file=sys.stderr)
        return 2

    by_table = {r["table"]: r for r in parts.get("data", [])}
    if "events" not in by_table:
        print("error: no rows in aletheia.events — load a corpus first", file=sys.stderr)
        return 2

    aleth = int(by_table["events"]["comp"])
    rows = int(by_table["events"]["rows"])
    base = int(by_table.get("baseline_events", {}).get("comp", 0))
    raw_c = int((raw_only.get("data") or [{}])[0].get("comp", 0))

    out = {
        "rows": rows,
        "aletheia_compressed_bytes": aleth,
        "baseline_raw_plus_normalized_bytes": base,
        "compressed_raw_only_bytes": raw_c,
        "ratio_vs_baseline": round(base / aleth, 3) if aleth and base else None,
        "ratio_vs_compressed_raw": round(raw_c / aleth, 3) if aleth and raw_c else None,
        "bytes_per_event": round(aleth / rows, 2) if rows else None,
    }

    if a.json:
        print(json.dumps(out, indent=2))
        return 0

    print(f"rows: {rows:,}\n")
    print(f"{'representation':<38} {'compressed':>12} {'vs Aletheia':>12}")
    print("-" * 64)
    print(f"{'Aletheia (template + vars)':<38} {human(aleth):>12} {'1.00x':>12}")
    if base:
        print(f"{'Baseline: raw + normalized JSON':<38} {human(base):>12} "
              f"{out['ratio_vs_baseline']:>11}x")
    if raw_c:
        print(f"{'Compressed raw only (hard comparison)':<38} {human(raw_c):>12} "
              f"{out['ratio_vs_compressed_raw']:>11}x")
    print("-" * 64)
    if out["bytes_per_event"]:
        print(f"\n{out['bytes_per_event']} compressed bytes per event")
    if not base:
        print("\nnote: baseline_events is empty, so only the absolute figure is meaningful.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
