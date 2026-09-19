#!/usr/bin/env bash
# Air-gap step 2, on the AIR-GAPPED machine (spec §13.4).
# Verifies checksums before loading anything, then loads the images.
set -euo pipefail

BUNDLE_DIR="${1:-$(pwd)}"
cd "$BUNDLE_DIR"

if [ ! -f checksums.sha256 ]; then
  echo "error: checksums.sha256 not found in $BUNDLE_DIR" >&2
  exit 1
fi

echo "==> verifying checksums (nothing is loaded until this passes)"
if ! sha256sum -c checksums.sha256; then
  echo "CHECKSUM MISMATCH — refusing to load. The transfer is not trustworthy." >&2
  exit 2
fi

shopt -s nullglob
TARS=( ./*.tar )
if [ ${#TARS[@]} -eq 0 ]; then
  echo "error: no image tarball in $BUNDLE_DIR" >&2
  exit 1
fi

for t in "${TARS[@]}"; do
  echo "==> docker load -i $t"
  docker load -i "$t"
done

DEPLOY_TGZ=( ./aletheia-deploy-*.tgz )
if [ ${#DEPLOY_TGZ[@]} -gt 0 ]; then
  TARGET="${ALETHEIA_DEPLOY_DIR:-$BUNDLE_DIR/aletheia}"
  mkdir -p "$TARGET"
  echo "==> extracting deployment files to $TARGET"
  tar -C "$TARGET" -xzf "${DEPLOY_TGZ[0]}"
fi

echo
echo "Loaded images:"
docker image ls --format '{{.Repository}}:{{.Tag}}\t{{.Size}}' | grep -E 'aletheia|vector|redpanda|clickhouse|postgres|minio|loki|grafana|prometheus' || true

cat <<'EOF'

Next:
  # all-in-one evaluation image
  docker run -d --name aletheia -e ALETHEIA_AIRGAP=true \
    -p 8080:8080 -p 3000:3000 -p 5514:5514/udp -p 5514:5514/tcp \
    <registry>/aletheia:<version>

  # or the production stack
  cd aletheia && docker compose -f deploy/docker-compose.yml up -d

Set ALETHEIA_AIRGAP=true so cloud AI providers are refused. A self-hosted model
(Ollama) carried in the same way still works.
EOF
