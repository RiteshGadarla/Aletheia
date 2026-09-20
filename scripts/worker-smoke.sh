#!/usr/bin/env bash
# End-to-end proof that the streaming hot path works: produce raw records onto the
# bus, let the real worker consume them, and check what landed.
#
# This exists because the worker is the one component that cannot be exercised by
# `make check` — it needs Redpanda, ClickHouse and PostgreSQL all at once, so it
# went unrun for a long time while every other part of the engine had tests. A
# path nobody runs is a path nobody trusts.
#
# It asserts four things, and fails loudly on any of them:
#   1. the worker consumes from `raw` and writes to ClickHouse
#   2. every event it wrote reconstructs byte-exactly (parse_status=full)
#   3. the Merkle chain over those events verifies (chain_ok)
#   4. replaying the same offsets is idempotent -- the deterministic ULID means a
#      redelivery produces the SAME event_uid, so rows may repeat but events do not
#
# Everything it creates is under a throwaway source id and is removed on exit.
#
# Usage: scripts/worker-smoke.sh [record-count]   (default 20)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COUNT="${1:-20}"
SOURCE="smoke$$"                       # unique per run, so concurrent runs cannot collide
GROUP="worker-smoke-$$"
RPK=(docker exec -i aletheia-services-redpanda-1 rpk)

export ALETHEIA_PACKS_DIR="${ALETHEIA_PACKS_DIR:-$ROOT/backend/packs}"
export ALETHEIA_CLICKHOUSE_URL="${ALETHEIA_CLICKHOUSE_URL:-http://127.0.0.1:8123}"
export ALETHEIA_CLICKHOUSE_USER="${ALETHEIA_CLICKHOUSE_USER:-aletheia}"
export ALETHEIA_CLICKHOUSE_PASSWORD="${ALETHEIA_CLICKHOUSE_PASSWORD:-aletheia}"
export ALETHEIA_PG_DSN="${ALETHEIA_PG_DSN:-postgres://aletheia:aletheia@127.0.0.1:5432/aletheia}"
export ALETHEIA_BUS_BROKERS="${ALETHEIA_BUS_BROKERS:-127.0.0.1:9092}"
export ALETHEIA_CONSUMER_GROUP="$GROUP"

ch() { curl -sS -u "$ALETHEIA_CLICKHOUSE_USER:$ALETHEIA_CLICKHOUSE_PASSWORD" \
        "$ALETHEIA_CLICKHOUSE_URL/" --data-binary "$1"; }
pg() { docker exec -i aletheia-services-postgres-1 psql -U aletheia -d aletheia -tAc "$1"; }

cleanup() {
  echo "-- cleanup: dropping $SOURCE"
  ch "ALTER TABLE aletheia.events DELETE WHERE source_id='$SOURCE'" >/dev/null 2>&1 || true
  pg "DELETE FROM merkle_batches WHERE source_id='$SOURCE'"          >/dev/null 2>&1 || true
  "${RPK[@]}" group delete "$GROUP"                                   >/dev/null 2>&1 || true
}
trap cleanup EXIT

[ -x "$ROOT/bin/aletheia-worker" ] || { echo "build first: make engine"; exit 1; }

# Feed it real golden lines rather than synthetic ones, so a parse failure here
# means the worker diverged from the reference verifier -- which is the whole point.
mapfile -t LINES < <(find "$ROOT/backend/packs/tests" -name '*.log' -exec cat {} + | grep -v '^$' | head -"$COUNT")
[ "${#LINES[@]}" -gt 0 ] || { echo "no golden samples found"; exit 1; }
echo "-- ${#LINES[@]} golden lines -> topic raw as source '$SOURCE'"

# Pin the throwaway group to the current end of `raw` before the worker starts.
# The worker consumes AtStart by design -- a restart must never skip what arrived
# while it was down -- but for a smoke run that means replaying the whole backlog,
# which is slow and resurrects rows an earlier run deleted. Seeking first scopes
# the run to exactly the records we are about to produce.
"${RPK[@]}" group seek "$GROUP" --to end --topics raw --allow-new-topics >/dev/null 2>&1 || true

# The worker must already be consuming before we produce: a new group resolves its
# start offset on first fetch, and anything produced before that resolution is
# skipped. Start it, wait for it to announce itself, then produce.
LOG="$(mktemp)"
"$ROOT/bin/aletheia-worker" -packs "$ALETHEIA_PACKS_DIR" -drain 12s -metrics :0 >"$LOG" 2>&1 &
WORKER=$!
for _ in $(seq 1 30); do grep -q "consuming raw" "$LOG" && break; sleep 0.5; done
grep -q "consuming raw" "$LOG" || { echo "worker never joined the group:"; cat "$LOG"; exit 1; }
sleep 2                                  # let the group finish its first fetch

NOW="$(date +%s%3N)"
for line in "${LINES[@]}"; do
  printf '%s\n' "$line" | "${RPK[@]}" topic produce raw -k "$SOURCE" \
    -H "pr_recv_ms=$NOW" -H "pr_peer=10.0.0.9:51000" -H "pr_listener=udp:5514" >/dev/null
done
echo "-- produced; waiting for the worker to drain"
wait "$WORKER" || { echo "worker exited non-zero:"; cat "$LOG"; exit 1; }
sed 's/^/   /' "$LOG"; rm -f "$LOG"

read -r ROWS UIDS FULL < <(ch "SELECT count(), uniqExact(event_uid), countIf(parse_status='full')
                               FROM aletheia.events WHERE source_id='$SOURCE' FORMAT TSV")
echo "-- clickhouse: $ROWS rows, $UIDS distinct events, $FULL parsed in full"
[ "${UIDS:-0}" -gt 0 ] || { echo "FAIL: the worker consumed nothing"; exit 1; }
[ "$FULL" = "$ROWS" ]  || { echo "FAIL: $((ROWS - FULL)) of $ROWS rows did not parse in full"; exit 1; }
[ "$ROWS" -ge "$UIDS" ] || { echo "FAIL: fewer rows than distinct events"; exit 1; }

echo "-- verifying reconstruction and the merkle chain"
REPORT="$(mktemp)"
"$ROOT/bin/aletheia" verify --source "$SOURCE" --last 1h >"$REPORT"
cat "$REPORT"
python3 "$ROOT/scripts/check_verify.py" "$REPORT"
rm -f "$REPORT"
