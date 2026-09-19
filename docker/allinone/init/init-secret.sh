#!/usr/bin/env bash
# ALETHEIA_SECRET is generated at FIRST START and kept in /data — never baked in.
# It derives (HKDF-SHA256) the AES-GCM key for secrets stored via the UI (CONTRACTS §9).
set -euo pipefail
if [ -n "${ALETHEIA_SECRET:-}" ]; then
  printf '%s' "$ALETHEIA_SECRET" > /data/secret
  echo "[init-secret] using operator-supplied ALETHEIA_SECRET"
elif [ ! -s /data/secret ]; then
  openssl rand -hex 32 > /data/secret
  echo "[init-secret] generated a new ALETHEIA_SECRET (stored in /data/secret)"
else
  echo "[init-secret] reusing the secret in /data/secret"
fi
chmod 600 /data/secret
chown aletheia:aletheia /data/secret
