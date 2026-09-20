#!/usr/bin/env bash
# Start the Studio API and the frontend dev server detached, so they survive the caller's shell.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS="$ROOT/.dev-logs"; mkdir -p "$LOGS"

port_pid() { ss -ltnp 2>/dev/null | grep ":$1 " | grep -oP 'pid=\K[0-9]+' | head -1; }

stop_port() { local p; p=$(port_pid "$1"); [ -n "${p:-}" ] && { kill -9 "$p" 2>/dev/null; sleep 1; }; }

case "${1:-up}" in
  down)
    stop_port 8081; stop_port 5173; echo "stopped"; exit 0 ;;
esac

stop_port 8081; stop_port 5173

set -a; [ -f "$ROOT/deploy/secrets/aletheia.env" ] && . "$ROOT/deploy/secrets/aletheia.env"; set +a
export ALETHEIA_CH_URL="${ALETHEIA_CH_URL:-http://localhost:8123}"
export ALETHEIA_CH_USER="${ALETHEIA_CH_USER:-aletheia}"
export ALETHEIA_CH_PASSWORD="${ALETHEIA_CH_PASSWORD:-aletheia}"
export ALETHEIA_PACKS_DIR="${ALETHEIA_PACKS_DIR:-$ROOT/backend/packs}"
export ALETHEIA_PG_DSN="${ALETHEIA_PG_DSN:-postgres://aletheia:aletheia@127.0.0.1:5432/aletheia}"

( cd "$ROOT/backend" && setsid "$ROOT/.venv/bin/uvicorn" studio.main:app \
    --host 127.0.0.1 --port 8081 > "$LOGS/studio.log" 2>&1 < /dev/null & )
( cd "$ROOT/frontend" && setsid npm run dev -- --port 5173 > "$LOGS/vite.log" 2>&1 < /dev/null & )

for i in $(seq 1 40); do
  curl -sf http://127.0.0.1:8081/healthz >/dev/null 2>&1 && break; sleep 1
done
printf "  studio   %s\n" "$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:8081/healthz)"
for i in $(seq 1 30); do curl -sf http://127.0.0.1:5173/ >/dev/null 2>&1 && break; sleep 1; done
printf "  frontend %s   -> http://localhost:5173\n" "$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:5173/)"
echo "  logs: .dev-logs/"
