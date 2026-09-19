#!/usr/bin/env bash
# Demo TLS CA, generated at FIRST START (spec §13.7) — never baked into the image.
# Production deployments mount the organization's certificates over /data/tls.
set -euo pipefail
TLS=/data/tls
if [ -s "$TLS/server.crt" ] && [ -s "$TLS/ca.crt" ]; then
  echo "[init-ca] certificates already present"
else
  echo "[init-ca] generating a self-signed demo CA (first start)"
  umask 077
  openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
    -keyout "$TLS/ca.key" -out "$TLS/ca.crt" \
    -subj "/O=Aletheia Demo/CN=Aletheia Demo CA" >/dev/null 2>&1

  openssl req -newkey rsa:2048 -nodes -keyout "$TLS/server.key" -out "$TLS/server.csr" \
    -subj "/O=Aletheia Demo/CN=aletheia" >/dev/null 2>&1

  cat > "$TLS/server.ext" <<'EXT'
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:aletheia,DNS:localhost,IP:127.0.0.1
EXT

  openssl x509 -req -in "$TLS/server.csr" -CA "$TLS/ca.crt" -CAkey "$TLS/ca.key" \
    -CAcreateserial -out "$TLS/server.crt" -days 825 -sha256 \
    -extfile "$TLS/server.ext" >/dev/null 2>&1
  rm -f "$TLS/server.csr" "$TLS/server.ext"
fi

chown -R aletheia:aletheia "$TLS"
chmod 640 "$TLS"/*.key
FP="$(openssl x509 -in "$TLS/ca.crt" -noout -fingerprint -sha256 | cut -d= -f2)"
echo "[init-ca] demo CA SHA-256 fingerprint: $FP"
echo "[init-ca] syslog TLS (RFC 5425) listening on 6514 once Vector starts"
