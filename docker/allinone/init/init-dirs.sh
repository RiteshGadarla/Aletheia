#!/usr/bin/env bash
# All state lives under /data. Without a volume every run is a fresh, identical demo.
set -euo pipefail
echo "[init-dirs] preparing /data"

for d in postgres clickhouse redpanda minio loki prometheus grafana vector tls run logs bench demo packs; do
  mkdir -p "/data/$d"
done
mkdir -p /data/logs/grafana /data/clickhouse/tmp /data/clickhouse/user_files /data/clickhouse/format_schemas
chown -R aletheia:aletheia /data
chown -R pgrun:aletheia /data/postgres /data/run
chmod 700 /data/postgres

# Working copy of the parser packs, so the Studio can write new versions.
if [ ! -f /data/packs/.seeded ]; then
  cp -a /opt/aletheia/packs/. /data/packs/ 2>/dev/null || true
  touch /data/packs/.seeded
  chown -R aletheia:aletheia /data/packs
fi

# PostgreSQL cluster on first start only.
if [ ! -s /data/postgres/PG_VERSION ]; then
  echo "[init-dirs] initdb (first start)"
  su -s /bin/bash pgrun -c "/usr/lib/postgresql/16/bin/initdb -D /data/postgres -U aletheia --auth=trust --encoding=UTF8 --locale=en_US.UTF-8" >/dev/null
fi

# Redpanda needs its config written once; node id and dirs are fixed.
mkdir -p /etc/aletheia/redpanda
chown -R aletheia:aletheia /etc/aletheia/redpanda
echo "[init-dirs] done"
