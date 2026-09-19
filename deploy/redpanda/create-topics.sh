#!/usr/bin/env bash
# Create the five Aletheia bus topics (CONTRACTS §3, spec §5.3). Idempotent.
set -euo pipefail

BROKERS="${REDPANDA_BROKERS:-redpanda:9092}"
P="${ALETHEIA_PARTITIONS:-12}"
R="${ALETHEIA_REPLICAS:-1}"

# `raw` retention covers the maximum expected processing outage plus reprocessing (spec §6.2).
RAW_RETENTION_MS="${ALETHEIA_RAW_RETENTION_MS:-604800000}"        # 7 days
DERIVED_RETENTION_MS="${ALETHEIA_DERIVED_RETENTION_MS:-259200000}" # 3 days

rpk() { command rpk -X brokers="$BROKERS" "$@"; }

echo "waiting for ${BROKERS}"
for _ in $(seq 1 60); do
  if rpk cluster info >/dev/null 2>&1; then break; fi
  sleep 2
done

create() {
  local name="$1" parts="$2" retention="$3" cleanup="$4"
  if rpk topic describe "$name" >/dev/null 2>&1; then
    echo "topic $name exists"
  else
    rpk topic create "$name" \
      --partitions "$parts" \
      --replicas "$R" \
      --topic-config "retention.ms=$retention" \
      --topic-config "cleanup.policy=$cleanup" \
      --topic-config "compression.type=producer" \
      --topic-config "max.message.bytes=1048576"
    echo "created topic $name (p=$parts)"
  fi
}

# All keyed by source_id, so one source's events stay ordered within a partition.
# `raw` value = exact raw bytes; producers must not set compression that rewrites them.
create raw        "$P" "$RAW_RETENTION_MS"     delete
create quarantine "$P" "$DERIVED_RETENTION_MS" delete
create normalized "$P" "$DERIVED_RETENTION_MS" delete
create dlq        "$P" "$RAW_RETENTION_MS"     delete

# `control` carries pack publish/retire notices: unkeyed, single partition so every
# worker sees the same order; compacted so a late worker gets the latest state.
create control 1 "$DERIVED_RETENTION_MS" compact

rpk topic list
echo "topics ready"
