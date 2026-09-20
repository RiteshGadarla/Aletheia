#!/usr/bin/env python3
"""Storage efficiency, reported the two ways spec §17 demands — and audited well enough to catch
the two ways this measurement lies.

Comparing Aletheia only against *uncompressed* raw would flatter it: ClickHouse already ZSTDs raw
text well. So we report against the realistic baseline (raw + normalized copies) AND against
ZSTD-compressed raw alone, which is the harder and more honest number.

Two guards exist because both failures actually happened (docs/benchmarks.md §2):
  - A ratio computed across tables holding different row counts is meaningless. If `events` and
    `baseline_events` disagree, no ratio is printed at all.
  - ClickHouse reports per-column sizes as 0 for *Compact* parts, because a compact part packs
    every column into one file. Printing that 0 as if it were a measurement is how a broken
    number survives review, so it is reported as unavailable instead.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request

# Compressed bytes per table, straight from ClickHouse's own accounting.
PARTS_SQL = """
SELECT table, sum(data_compressed_bytes) AS comp, sum(data_uncompressed_bytes) AS uncomp,
       sum(rows) AS rows, countIf(part_type = 'Compact') AS compact_parts
FROM system.parts
WHERE active AND database = '{db}' AND table IN ('events','baseline_events')
GROUP BY table FORMAT JSON
"""

# Per-column attribution. system.parts_columns is the only source that is correct here;
# system.columns reports 0 for a table whose parts are all Compact, which is what made the old
# `compressed_raw_only_bytes` silently read 0.
COLUMNS_SQL = """
SELECT table, column, sum(column_data_compressed_bytes) AS comp,
       sum(column_data_uncompressed_bytes) AS uncomp
FROM system.parts_columns
WHERE active AND database = '{db}' AND table IN ('events','baseline_events')
GROUP BY table, column
ORDER BY table, comp DESC FORMAT JSON
"""

# Columns that exist only to make an event provably the event it claims to be. Called out
# separately because they are incompressible by construction and dominate the difference.
INTEGRITY_COLUMNS = ("raw_sha256", "event_uid", "merkle_batch")


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
    ap.add_argument("--url", default=os.environ.get("ALETHEIA_CH_URL", "http://localhost:8123"))
    ap.add_argument("--db", default=os.environ.get("ALETHEIA_CH_DB", "aletheia"))
    ap.add_argument("--user", default=os.environ.get("ALETHEIA_CH_USER", "aletheia"))
    ap.add_argument("--password", default=os.environ.get("ALETHEIA_CH_PASSWORD", "aletheia"))
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    a = ap.parse_args()

    try:
        parts = query(a.url, PARTS_SQL.format(db=a.db), a.user, a.password)
        cols = query(a.url, COLUMNS_SQL.format(db=a.db), a.user, a.password)
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
    base_rows = int(by_table.get("baseline_events", {}).get("rows", 0))

    # Per-column sizes are unreadable while any part is Compact; say so rather than print zeros.
    compact = sum(int(r["compact_parts"]) for r in by_table.values())
    per_col: dict[str, list[dict]] = {}
    if not compact:
        for r in cols.get("data", []):
            per_col.setdefault(r["table"], []).append(
                {"column": r["column"], "comp": int(r["comp"]), "uncomp": int(r["uncomp"])})

    # The hardest comparison: Aletheia against ZSTD-compressed raw and nothing else.
    raw_c = next((c["comp"] for c in per_col.get("baseline_events", []) if c["column"] == "raw"), 0)
    integrity = sum(c["comp"] for c in per_col.get("events", [])
                    if c["column"] in INTEGRITY_COLUMNS)

    # A ratio across mismatched row counts is not a weak number, it is a wrong one.
    comparable = bool(base) and base_rows == rows

    out = {
        "rows": rows,
        "baseline_rows": base_rows,
        "comparable": comparable,
        "aletheia_compressed_bytes": aleth,
        "baseline_raw_plus_normalized_bytes": base,
        "compressed_raw_only_bytes": raw_c or None,
        "integrity_metadata_bytes": integrity or None,
        "integrity_share_of_aletheia": round(integrity / aleth, 3) if integrity else None,
        "ratio_vs_baseline": round(base / aleth, 3) if comparable else None,
        "ratio_vs_compressed_raw": round(raw_c / aleth, 3) if comparable and raw_c else None,
        "bytes_per_event": round(aleth / rows, 2) if rows else None,
        "per_column": per_col or None,
    }

    if a.json:
        print(json.dumps(out, indent=2))
        return 0

    print(f"rows: {rows:,}\n")
    print(f"{'representation':<38} {'compressed':>12} {'vs Aletheia':>12}")
    print("-" * 64)
    print(f"{'Aletheia (template + vars + OCSF)':<38} {human(aleth):>12} {'1.00x':>12}")
    if base:
        ratio = f"{out['ratio_vs_baseline']:.3f}x" if comparable else "n/a"
        print(f"{'Baseline: raw + normalized JSON':<38} {human(base):>12} {ratio:>12}")
    if raw_c:
        ratio = f"{out['ratio_vs_compressed_raw']:.3f}x" if comparable else "n/a"
        print(f"{'Compressed raw only (hard comparison)':<38} {human(raw_c):>12} {ratio:>12}")
    print("-" * 64)
    if out["bytes_per_event"]:
        print(f"\n{out['bytes_per_event']} compressed bytes per event")
    if integrity:
        print(f"of which {round(integrity / rows, 2)} bytes/event is integrity metadata "
              f"({out['integrity_share_of_aletheia']:.1%} of the table) — "
              f"incompressible by construction, see docs/benchmarks.md §3")

    for table in ("events", "baseline_events"):
        if not per_col.get(table):
            continue
        total = sum(c["comp"] for c in per_col[table]) or 1
        print(f"\nper-column breakdown — {a.db}.{table}")
        print(f"{'column':<18} {'compressed':>12} {'B/event':>9} {'share':>7} {'x':>7}")
        print("-" * 64)
        for c in per_col[table]:
            if not c["comp"]:
                continue
            x = c["uncomp"] / c["comp"]
            print(f"{c['column']:<18} {human(c['comp']):>12} {c['comp'] / rows:>9.2f} "
                  f"{c['comp'] / total:>6.1%} {x:>6.2f}x")

    if not base:
        print("\nnote: baseline_events is empty, so only the absolute figure is meaningful.")
    elif not comparable:
        print(f"\nWARNING: events has {rows:,} rows but baseline_events has {base_rows:,}. "
              "Ratios are suppressed — reload both from one run of bench/ingest.py.")
    if compact:
        print(f"\nnote: {compact} Compact part(s) present, so ClickHouse reports no per-column "
              "sizes. Corpora past ~10 MB/part produce Wide parts; until then the breakdown "
              "is genuinely unavailable rather than zero.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
