#!/usr/bin/env bash
# Create the five bus topics inside the container (CONTRACTS §3).
set -euo pipefail
/opt/aletheia/init/wait-for.sh tcp 127.0.0.1:9092 180
export REDPANDA_BROKERS=127.0.0.1:9092
export ALETHEIA_PARTITIONS="${ALETHEIA_PARTITIONS:-4}"   # single node: 4 is plenty
export ALETHEIA_REPLICAS=1
exec bash /opt/aletheia/init/create-topics.sh
