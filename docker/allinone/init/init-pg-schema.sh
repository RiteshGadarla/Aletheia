#!/usr/bin/env bash
# Apply the frozen PostgreSQL schema (CONTRACTS §7). Idempotent: every statement is IF NOT EXISTS.
set -euo pipefail
/opt/aletheia/init/wait-for.sh tcp 127.0.0.1:5432 120
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=aletheia

psql -tAc "SELECT 1 FROM pg_database WHERE datname='aletheia'" postgres | grep -q 1 || \
  psql -d postgres -c "CREATE DATABASE aletheia"

psql -v ON_ERROR_STOP=1 -d aletheia -f /opt/aletheia/sql/postgres-init.sql >/dev/null
echo "[init-pg-schema] applied"
