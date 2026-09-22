#!/usr/bin/env bash
# Builds and (optionally) pushes the Aletheia all-in-one evaluation image via buildx.
# Versions/registry/tag come from docker/versions.env — change values there, not here.
#
# Usage:
#   ./docker/build.sh                 # build for the host arch, load into local docker
#   ./docker/build.sh --push          # build linux/amd64+arm64 and push to the registry
#   ./docker/build.sh --push --tag dev  # override the tag (default: $ALETHEIA_VERSION)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
source docker/versions.env

TAG="${ALETHEIA_VERSION}"
PUSH=0
PLATFORMS="linux/amd64,linux/arm64"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --push) PUSH=1; shift ;;
    --tag) TAG="$2"; shift 2 ;;
    --platform) PLATFORMS="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

IMAGE="${ALETHEIA_REGISTRY}/aletheia:${TAG}"

BUILD_ARGS=(
  --build-arg "ALETHEIA_VERSION=${ALETHEIA_VERSION}"
  --build-arg "VECTOR_VERSION=${VECTOR_VERSION}"
  --build-arg "REDPANDA_VERSION=${REDPANDA_VERSION}"
  --build-arg "CLICKHOUSE_VERSION=${CLICKHOUSE_VERSION}"
  --build-arg "POSTGRES_VERSION=${POSTGRES_VERSION}"
  --build-arg "MINIO_VERSION=${MINIO_VERSION}"
  --build-arg "MINIO_MC_VERSION=${MINIO_MC_VERSION}"
  --build-arg "LOKI_VERSION=${LOKI_VERSION}"
  --build-arg "GRAFANA_VERSION=${GRAFANA_VERSION}"
  --build-arg "PROMETHEUS_VERSION=${PROMETHEUS_VERSION}"
  --build-arg "GO_VERSION=${GO_VERSION}"
  --build-arg "NODE_VERSION=${NODE_VERSION}"
  --build-arg "PYTHON_VERSION=${PYTHON_VERSION}"
  --build-arg "DEBIAN_SUITE=${DEBIAN_SUITE}"
  --build-arg "S6_OVERLAY_VERSION=${S6_OVERLAY_VERSION}"
)

if ! docker buildx inspect aletheia-builder >/dev/null 2>&1; then
  docker buildx create --name aletheia-builder --use >/dev/null
else
  docker buildx use aletheia-builder
fi

echo "Building ${IMAGE} for ${PLATFORMS} (push=${PUSH})"

if [[ "$PUSH" -eq 1 ]]; then
  docker buildx build \
    --platform "$PLATFORMS" \
    -f docker/allinone/Dockerfile \
    "${BUILD_ARGS[@]}" \
    -t "$IMAGE" \
    --push \
    .
else
  # Multi-platform output can't be --load'd; build for the host arch only and load it locally.
  HOST_PLATFORM="linux/$(docker version -f '{{.Server.Arch}}')"
  docker buildx build \
    --platform "$HOST_PLATFORM" \
    -f docker/allinone/Dockerfile \
    "${BUILD_ARGS[@]}" \
    -t "$IMAGE" \
    --load \
    .
  echo "Loaded locally as ${IMAGE} (${HOST_PLATFORM} only — use --push for multi-arch)"
fi
