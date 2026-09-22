#!/usr/bin/env bash
# Docker HEALTHCHECK for the all-in-one image.
#
# Deliberately thin: it asks the readiness aggregator on :6156/healthz and nothing else, so there
# is exactly one definition of "ready" (init/healthz_server.py) rather than one here and a
# different one there. A healthcheck that drifts from the readiness endpoint is worse than none,
# because the container reports healthy while the UI returns 503.
#
# The image's start-period is 180s, which is what a first boot needs: PostgreSQL initdb,
# ClickHouse schema and Redpanda topic creation all run before the
# pipeline is genuinely up.

set -uo pipefail

# 6156 is fixed: nginx.conf hardcodes `listen 6156`, so honouring an ALETHEIA_UI_PORT
# override here would only make the container report unhealthy while the UI still served
# on 6156. Remap on the host instead: -p 8080:6156
URL="http://127.0.0.1:6156/healthz"

body="$(curl -fsS --max-time 8 "$URL" 2>/dev/null)" || {
  echo "healthcheck: $URL did not answer"
  exit 1
}

# The aggregator returns {"status":"ready",...} only when every component is up. Anything else
# is reported verbatim so `docker inspect` shows which component is still starting.
case "$body" in
  *'"status":"ready"'*|*'"status": "ready"'*)
    exit 0
    ;;
  *)
    echo "healthcheck: not ready -> ${body:0:300}"
    exit 1
    ;;
esac
