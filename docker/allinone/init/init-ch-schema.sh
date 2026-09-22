#!/usr/bin/env bash
# Apply the frozen ClickHouse schema (CONTRACTS §6). Idempotent.
set -euo pipefail
/opt/aletheia/init/wait-for.sh http http://127.0.0.1:8123/ping 180
clickhouse-client --host 127.0.0.1 --multiquery < /opt/aletheia/sql/clickhouse-init.sql
# Application user. The Studio authenticates as ALETHEIA_CH_USER/ALETHEIA_CH_PASSWORD
# (aletheia/aletheia by default) and needs read+write on the database plus system.parts for the
# storage-economy figures.
CH_APP_USER="${ALETHEIA_CH_USER:-aletheia}"
CH_APP_PASS="${ALETHEIA_CH_PASSWORD:-aletheia}"
clickhouse-client --host 127.0.0.1 --multiquery <<SQL
CREATE USER IF NOT EXISTS ${CH_APP_USER} IDENTIFIED WITH plaintext_password BY '${CH_APP_PASS}';
GRANT ALL ON aletheia.* TO ${CH_APP_USER};
GRANT SELECT ON system.parts TO ${CH_APP_USER};
GRANT SELECT ON system.parts_columns TO ${CH_APP_USER};
SQL

# Read-only demo user for evaluators poking at port 8123 (spec §13.3).
clickhouse-client --host 127.0.0.1 --multiquery <<'SQL'
CREATE USER IF NOT EXISTS demo IDENTIFIED WITH no_password SETTINGS readonly = 1;
GRANT SELECT ON aletheia.* TO demo;
GRANT SELECT ON system.parts TO demo;
GRANT SELECT ON system.parts_columns TO demo;
SQL
echo "[init-ch-schema] applied"
