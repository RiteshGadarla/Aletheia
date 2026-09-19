#!/usr/bin/env bash
# wait-for.sh {tcp host:port | http url} [seconds]
set -euo pipefail
kind="$1"; target="$2"; deadline="${3:-60}"
for _ in $(seq 1 "$deadline"); do
  case "$kind" in
    tcp)  host="${target%%:*}"; port="${target##*:}"
          nc -z "$host" "$port" >/dev/null 2>&1 && exit 0 ;;
    http) curl -fsS --max-time 2 "$target" >/dev/null 2>&1 && exit 0 ;;
    *)    echo "wait-for: unknown kind $kind" >&2; exit 64 ;;
  esac
  sleep 1
done
echo "wait-for: timed out on $kind $target after ${deadline}s" >&2
exit 1
