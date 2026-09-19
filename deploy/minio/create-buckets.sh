#!/bin/sh
# Create the MinIO layout of spec §7.7. Idempotent.
set -eu

EP="${MINIO_ENDPOINT:-http://minio:9000}"
AK="${MINIO_ACCESS_KEY:-aletheia}"
SK="${MINIO_SECRET_KEY:-aletheia-demo-secret}"
BUCKET="${ALETHEIA_S3_BUCKET:-aletheia}"

for _ in $(seq 1 60); do
  if mc alias set al "$EP" "$AK" "$SK" >/dev/null 2>&1; then break; fi
  sleep 2
done
mc alias set al "$EP" "$AK" "$SK"

mc mb --ignore-existing "al/${BUCKET}"

# lake/  = Parquet OCSF exports; anchors/ = daily Merkle anchors + signature;
# archive/ = optional raw archive, only when that mode is enabled.
for p in lake anchors archive; do
  mc mb --ignore-existing "al/${BUCKET}/${p}" 2>/dev/null || true
done

# Anchors are evidence: once written, never overwritten.
mc version enable "al/${BUCKET}" || true
mc retention set --default COMPLIANCE 365d "al/${BUCKET}/anchors" 2>/dev/null || \
  echo "note: object-lock retention unavailable on this bucket; versioning still on"

mc ls "al/${BUCKET}"
echo "buckets ready"
