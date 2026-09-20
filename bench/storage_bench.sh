#!/usr/bin/env bash
# Reproduce section 2 of docs/benchmarks.md from nothing.
#
# Three things have to be true at once or the measurement is wrong rather than merely weak, and
# each has caught this project out before:
#
#   1. Both tables hold the SAME rows. A ratio across a 2,713-row `events` and a 52,000-row
#      `baseline_events` is meaningless; storage_report.py refuses to print one, which is how the
#      mismatch was noticed. Filling both in a single ingest pass makes it true by construction.
#   2. Parts must be Wide. ClickHouse packs every column into one file for a Compact part and
#      then reports each column's size as 0 -- which is how a per-column figure of 0 once got
#      mistaken for a broken query rather than an unreadable one. Enough rows plus OPTIMIZE FINAL
#      forces Wide parts.
#   3. It must not touch the demo corpus. Everything lands in a throwaway database.
#
# Usage: bench/storage_bench.sh [event-count]   (default 120000; below ~50k parts stay Compact)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COUNT="${1:-120000}"
DB="${ALETHEIA_BENCH_DB:-aletheia_bench}"
CH_URL="${ALETHEIA_CH_URL:-http://127.0.0.1:8123}"
CH_USER="${ALETHEIA_CH_USER:-aletheia}"
CH_PASS="${ALETHEIA_CH_PASSWORD:-aletheia}"
CORPUS="$(mktemp -t aletheia-bench-XXXXXX.log)"

ch() { curl -sS -u "$CH_USER:$CH_PASS" "$CH_URL/" --data-binary "$1"; }

trap 'rm -f "$CORPUS"' EXIT

ch "SELECT 1" >/dev/null || { echo "ClickHouse unreachable at $CH_URL — run: make services"; exit 1; }

echo "-- (re)creating database $DB with the production schema and codecs"
ch "DROP DATABASE IF EXISTS $DB" >/dev/null
# The schema is taken from the real init.sql rather than duplicated, so the baseline can never
# drift into a different codec treatment than `events` and flatter one side of the comparison.
# Comments are stripped first: several contain semicolons and would break statement splitting.
python3 - "$ROOT/deploy/clickhouse/init.sql" "$DB" "$CH_URL" "$CH_USER" "$CH_PASS" <<'PY'
import re, sys, urllib.parse, urllib.request
src, db, url, user, password = sys.argv[1:6]
sql = re.sub(r"(?m)--.*$", "", open(src, encoding="utf-8").read())
sql = re.sub(r"\baletheia\b", db, sql)
q = urllib.parse.urlencode({"user": user, "password": password})
for stmt in (s.strip() for s in sql.split(";")):
    if stmt:
        urllib.request.urlopen(
            urllib.request.Request(f"{url}/?{q}", data=stmt.encode()), timeout=60).read()
PY

echo "-- generating $COUNT events"
python3 "$ROOT/sources/generators/log_generator.py" \
  --count "$COUNT" --formats asa,fortigate,cef,leef --out "$CORPUS"

echo "-- ingesting (fills events AND baseline_events in one pass)"
ALETHEIA_CH_DB="$DB" ALETHEIA_CH_URL="$CH_URL" \
ALETHEIA_CH_USER="$CH_USER" ALETHEIA_CH_PASSWORD="$CH_PASS" \
  python3 "$ROOT/bench/ingest.py" --file "$CORPUS" --json

echo "-- merging to Wide parts so per-column sizes are readable"
ch "OPTIMIZE TABLE $DB.events FINAL" >/dev/null
ch "OPTIMIZE TABLE $DB.baseline_events FINAL" >/dev/null

compact=$(ch "SELECT countIf(part_type='Compact') FROM system.parts
              WHERE active AND database='$DB' AND table IN ('events','baseline_events')")
[ "$compact" = "0" ] || echo "   warning: $compact Compact part(s) remain — raise the event count"

echo
ALETHEIA_CH_URL="$CH_URL" ALETHEIA_CH_USER="$CH_USER" ALETHEIA_CH_PASSWORD="$CH_PASS" \
  python3 "$ROOT/bench/storage_report.py" --db "$DB"

echo
echo "-- the demo corpus in 'aletheia' was not touched; drop the bench data with:"
echo "   curl -u $CH_USER:*** '$CH_URL/' --data-binary 'DROP DATABASE $DB'"
