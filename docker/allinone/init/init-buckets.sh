#!/usr/bin/env bash
# MinIO layout of spec §7.7.
set -euo pipefail
/opt/aletheia/init/wait-for.sh tcp 127.0.0.1:9100 180
export MINIO_ENDPOINT="${ALETHEIA_S3_ENDPOINT:-http://127.0.0.1:9100}"
export MINIO_ACCESS_KEY="${ALETHEIA_S3_ACCESS_KEY:-aletheia}"
export MINIO_SECRET_KEY="${ALETHEIA_S3_SECRET_KEY:-aletheia-demo-secret}"
export MC_CONFIG_DIR=/data/minio/.mc
exec sh /opt/aletheia/init/create-buckets.sh
