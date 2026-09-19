#!/usr/bin/env bash
# Air-gap step 1, on the CONNECTED machine (spec §13.4).
# Pulls every pinned image, saves them to one tarball and writes verifiable checksums.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT_DIR="${1:-$REPO/offline-bundle}"

# shellcheck source=/dev/null
set -a; . "$REPO/docker/versions.env"; set +a

ALLINONE_ONLY="${ALLINONE_ONLY:-false}"
PLATFORM="${PLATFORM:-}"   # e.g. linux/amd64 — leave empty for the host platform

mkdir -p "$OUT_DIR"

expand_images() {
  # Expand ${VAR} references in images.txt, skipping comments and blanks.
  while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    eval "echo \"$line\""
  done < "$HERE/images.txt"
}

mapfile -t IMAGES < <(expand_images)

if [ "$ALLINONE_ONLY" = "true" ]; then
  IMAGES=("${ALETHEIA_REGISTRY}/aletheia:${ALETHEIA_VERSION}")
  TARBALL="$OUT_DIR/aletheia-${ALETHEIA_VERSION}.tar"
else
  TARBALL="$OUT_DIR/aletheia-stack-${ALETHEIA_VERSION}.tar"
fi

echo "==> pulling ${#IMAGES[@]} image(s)"
for img in "${IMAGES[@]}"; do
  echo "    $img"
  if [ -n "$PLATFORM" ]; then
    docker pull --platform "$PLATFORM" "$img"
  else
    docker pull "$img"
  fi
done

echo "==> recording digests"
: > "$OUT_DIR/digests.txt"
for img in "${IMAGES[@]}"; do
  digest="$(docker image inspect --format '{{ if .RepoDigests }}{{ index .RepoDigests 0 }}{{ else }}(local build, no digest){{ end }}' "$img")"
  size="$(docker image inspect --format '{{ .Size }}' "$img")"
  printf '%s\tsize=%s\t%s\n' "$img" "$size" "$digest" >> "$OUT_DIR/digests.txt"
done

echo "==> docker save -> $TARBALL"
docker save -o "$TARBALL" "${IMAGES[@]}"

echo "==> bundling deployment files"
tar -C "$REPO" -czf "$OUT_DIR/aletheia-deploy-${ALETHEIA_VERSION}.tgz" \
  --exclude 'deploy/secrets/*' --exclude '!deploy/secrets/*.example' \
  deploy docker/versions.env bench demo

echo "==> checksums"
( cd "$OUT_DIR" && sha256sum ./*.tar ./*.tgz digests.txt > checksums.sha256 )

cat "$OUT_DIR/checksums.sha256"
echo
echo "Transfer these through the approved media process:"
ls -lh "$OUT_DIR"
echo
echo "Note: no API keys and no model weights are in this bundle (spec §13.2)."
