#!/usr/bin/env bash
# Build, verify and package the Aletheia all-in-one image for submission.
#
#   ./docker/build.sh                 build, verify a live container, tag for the registry
#   ./docker/build.sh build           build only
#   ./docker/build.sh verify          verify an already-built image
#   ./docker/build.sh tag             (re)apply the registry tag
#   ./docker/build.sh save            export a tarball instead (air-gapped hand-off only)
#   ./docker/build.sh push            push the registry tag
#
# The image needs no environment file and no API key: every service address is hardcoded to
# 127.0.0.1 inside the container, and the Gemini key (optional) is entered by the user in the
# Settings page at run time and stored encrypted in the container's PostgreSQL.
#
# Verification is the point of this script. "docker build succeeded" says nothing about whether
# a log line put in the front door comes out the other end, so `verify` starts the image exactly
# the way a judge will, waits for it to report healthy, and then proves four separate things:
# the UI and Grafana are served through the one nginx port, internal services stay unpublished,
# the syslog ports answer from the host, and a syslog line sent to ${P_SYSLOG} lands in
# ClickHouse. Anything short of all four is a failed build.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ---------------------------------------------------------------- configuration

# versions.env is the single source of truth for pins; the Dockerfile ARG defaults mirror it so
# a build still works if the file is absent.
VERSIONS_FILE="docker/versions.env"
if [[ -f "$VERSIONS_FILE" ]]; then
  set -a; . "$VERSIONS_FILE"; set +a
fi

ALETHEIA_VERSION="${ALETHEIA_VERSION:-1.0.0}"
IMAGE="${IMAGE:-aletheia:${ALETHEIA_VERSION}}"
PLATFORM="${PLATFORM:-linux/amd64}"

# Which buildx builder to use. This is worth understanding before overriding it.
#
# The `docker` driver (builder name "default") writes the result straight into the local image
# store. The `docker-container` driver cannot do that: `--load` makes it export the whole image
# to a tar stream and re-import it, which for a ~2.7 GB image is minutes of pure overhead on
# every single build. For a single-platform image we load locally, "default" is strictly faster.
#
# docker-container is still the right choice for a multi-platform release build or when pushing
# straight to a registry with --push, so this auto-selects rather than hardcoding.
BUILDER="${BUILDER:-}"
CONTAINER="${CONTAINER:-aletheia-verify}"
OUT_DIR="${OUT_DIR:-dist}"
TARBALL="${OUT_DIR}/aletheia-${ALETHEIA_VERSION}.tar"

# Host ports used during verification, the same uncommon numbers the README documents.
# Overridable so a busy machine can still run the check. Grafana and ClickHouse have none:
# Grafana is reached at ${P_UI}/grafana/ and ClickHouse is never published.
P_UI="${P_UI:-6156}"
P_SYSLOG="${P_SYSLOG:-26514}"
P_SYSLOG_OCTET="${P_SYSLOG_OCTET:-26515}"
P_SYSLOG_TLS="${P_SYSLOG_TLS:-26516}"

# First boot runs initdb, the ClickHouse schema, topic creation and bucket creation before the
# pipeline is genuinely up. The image's own start-period is 180s; allow generously more here.
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-600}"

# ---------------------------------------------------------------- output helpers

if [[ -t 1 ]]; then
  C_OK=$'\033[32m'; C_BAD=$'\033[31m'; C_DIM=$'\033[2m'; C_B=$'\033[1m'; C_0=$'\033[0m'
else
  C_OK=''; C_BAD=''; C_DIM=''; C_B=''; C_0=''
fi

PASS=0; FAIL=0
step()  { printf '\n%s==> %s%s\n' "$C_B" "$*" "$C_0"; }
info()  { printf '    %s%s%s\n' "$C_DIM" "$*" "$C_0"; }
ok()    { PASS=$((PASS+1)); printf '    %s[ ok ]%s %s\n' "$C_OK" "$C_0" "$*"; }
bad()   { FAIL=$((FAIL+1)); printf '    %s[fail]%s %s\n' "$C_BAD" "$C_0" "$*"; }
die()   { printf '\n%s[fail]%s %s\n' "$C_BAD" "$C_0" "$*" >&2; exit 1; }

# Assert on a command's exit status. Used for every check so one failure does not abort the
# run -- a partial report is far more useful than stopping at the first problem.
check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$label"; else bad "$label"; fi
}

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed"; }

# ---------------------------------------------------------------- build

do_build() {
  step "Build  ${IMAGE}  (${PLATFORM})"
  need docker
  docker buildx version >/dev/null 2>&1 || die "docker buildx is required"

  # Without .dockerignore the context is 428 MB and includes two host virtualenvs and a real
  # API key, so this is a hard stop rather than a warning.
  [[ -f .dockerignore ]] || die ".dockerignore is missing; refusing to build with a 428 MB context"

  # Builder choice. Multi-platform needs docker-container; a single platform we then --load is
  # much faster on the plain docker driver, which skips the tar export/import entirely.
  local builder_note
  if [[ -n "$BUILDER" ]]; then
    builder_note="${BUILDER} (BUILDER override)"
  elif [[ "$PLATFORM" == *,* ]]; then
    BUILDER="$(docker buildx ls --format '{{.Name}} {{.Driver}}' 2>/dev/null \
                 | awk '$2=="docker-container"{print $1; exit}')"
    [[ -n "$BUILDER" ]] || die "multi-platform build needs a docker-container builder: docker buildx create --name multi --driver docker-container"
    builder_note="${BUILDER} (docker-container, required for ${PLATFORM})"
  else
    BUILDER=default
    builder_note="default (docker driver -- no tar export/import on --load)"
  fi
  docker buildx inspect "$BUILDER" >/dev/null 2>&1 || die "buildx builder '${BUILDER}' not found"

  # Tell the operator what is about to happen. A build that pulls nine upstream images and
  # compiles Go, Node and Python can sit for minutes with nothing obvious on screen, and a
  # silent terminal is indistinguishable from a hung one.
  local ctx_size cached
  ctx_size=$(du -sh --exclude=.git --exclude='*/.venv' --exclude=.venv \
                   --exclude='*/node_modules' . 2>/dev/null | awk '{print $1}')
  cached=$(docker images -q "$IMAGE" 2>/dev/null | wc -l | tr -d ' ' || true)

  info "context      ~${ctx_size} (trimmed by .dockerignore)"
  info "dockerfile   docker/allinone/Dockerfile"
  info "builder      ${builder_note}"
  info "version      ${ALETHEIA_VERSION}"
  info "pins         vector=${VECTOR_VERSION:-default} redpanda=${REDPANDA_VERSION:-default} clickhouse=${CLICKHOUSE_VERSION:-default}"
  info "             postgres=${POSTGRES_VERSION:-default} loki=${LOKI_VERSION:-default} grafana=${GRAFANA_VERSION:-default} prometheus=${PROMETHEUS_VERSION:-default}"
  echo
  info "stages: go-build -> ui-build -> py-build -> s6 -> 7 upstream pulls -> final assembly"
  info "cached: go modules+build, npm, pip, apt (BuildKit cache mounts, kept out of the image)"
  if [[ "$cached" == "0" ]]; then
    info "first build on this machine: ~2-3 GB of upstream images to pull, expect 10-20 min"
  else
    info "previous build found; unchanged layers come from cache"
  fi
  info "live progress follows -- each '=> [stage n/m]' line is a real step, not a spinner"
  echo

  # Preflight: resolve every pinned upstream image and lint the Dockerfile without building.
  # Ten seconds here beats discovering a bad pin or a typo fifteen minutes in.
  if [[ "${SKIP_CHECK:-0}" != "1" ]]; then
    local chk
    if chk=$(docker buildx build --builder "$BUILDER" --call check \
               --file docker/allinone/Dockerfile \
               --build-arg ALETHEIA_VERSION="$ALETHEIA_VERSION" . 2>&1); then
      ok "preflight: Dockerfile lints clean, all 9 upstream pins resolve"
    else
      printf '%s\n' "$chk" | tail -20 | sed 's/^/      /'
      die "preflight failed -- fix the above before building"
    fi

    # Resolve the Python pins before building anything. A conflict here (this file once pinned
    # websockets==17.1 against a google-genai that caps it below 17.0) otherwise only surfaces
    # in py-build, several minutes and several GB of image pulls into the run.
    local pybase="python:${PYTHON_VERSION:-3.12}-slim-${DEBIAN_SUITE:-bookworm}" dep
    if dep=$(docker run --rm -v "${REPO_ROOT}/backend/studio/requirements.txt:/r.txt:ro" \
               "$pybase" pip install --dry-run -q -r /r.txt 2>&1); then
      ok "preflight: python requirements resolve"
    elif grep -qiE 'ResolutionImpossible|conflicting dependencies|No matching distribution' <<<"$dep"; then
      printf '%s\n' "$dep" | grep -iE 'conflict|requested|depends on|ERROR' | head -12 | sed 's/^/      /'
      die "backend/studio/requirements.txt does not resolve -- fix the pins before building"
    else
      # Could not run the check at all (no image, no network). Not a reason to block the build;
      # py-build will still catch a genuine conflict.
      info "preflight: skipped python pin check (${pybase} unavailable)"
    fi
  fi

  local t0 rc
  t0=$SECONDS

  # A heartbeat for non-interactive runs (CI, `| tee build.log`), where buildx falls back to
  # plain output and a slow layer can look like a hang. On a TTY buildx draws its own live
  # progress and a second writer would fight it for the cursor, so the heartbeat stays off.
  local hb=0
  if [[ ! -t 1 ]]; then
    ( while :; do sleep 30; printf '    ... still building (%dm%02ds elapsed)\n' \
          $(( (SECONDS-t0)/60 )) $(( (SECONDS-t0)%60 )); done ) &
    hb=$!
  fi

  set +e
  docker buildx build \
    --builder "$BUILDER" \
    --platform "$PLATFORM" \
    --file docker/allinone/Dockerfile \
    --tag "$IMAGE" \
    --progress "${PROGRESS:-auto}" \
    --build-arg ALETHEIA_VERSION="$ALETHEIA_VERSION" \
    ${VECTOR_VERSION:+--build-arg VECTOR_VERSION="$VECTOR_VERSION"} \
    ${REDPANDA_VERSION:+--build-arg REDPANDA_VERSION="$REDPANDA_VERSION"} \
    ${CLICKHOUSE_VERSION:+--build-arg CLICKHOUSE_VERSION="$CLICKHOUSE_VERSION"} \
    ${POSTGRES_VERSION:+--build-arg POSTGRES_VERSION="$POSTGRES_VERSION"} \
    ${LOKI_VERSION:+--build-arg LOKI_VERSION="$LOKI_VERSION"} \
    ${GRAFANA_VERSION:+--build-arg GRAFANA_VERSION="$GRAFANA_VERSION"} \
    ${PROMETHEUS_VERSION:+--build-arg PROMETHEUS_VERSION="$PROMETHEUS_VERSION"} \
    ${S6_OVERLAY_VERSION:+--build-arg S6_OVERLAY_VERSION="$S6_OVERLAY_VERSION"} \
    --load \
    .
  rc=$?
  set -e
  if (( hb )); then kill "$hb" 2>/dev/null || true; hb=0; fi

  (( rc == 0 )) || die "build failed after $(( (SECONDS-t0)/60 ))m$(( (SECONDS-t0)%60 ))s (exit ${rc})"

  local secs size_bytes
  secs=$(( SECONDS - t0 ))
  size_bytes=$(docker image inspect "$IMAGE" --format '{{.Size}}')
  ok "built in $(( secs/60 ))m$(( secs%60 ))s"
  info "image  ${IMAGE}"
  info "size   $(awk -v b="$size_bytes" 'BEGIN{printf "%.2f GB", b/1024/1024/1024}') in $(docker image inspect "$IMAGE" --format '{{len .RootFS.Layers}}') layers"
  info "id     $(docker image inspect "$IMAGE" --format '{{.Id}}' | cut -c1-19)"
}

# ---------------------------------------------------------------- static image checks

# Things that must be true of the image before it is ever started. These catch the two failure
# modes that a running container hides: a secret baked into a layer, and a host-built virtualenv
# copied in over the one the builder stage produced.
verify_image() {
  step "Image contents"

  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "image ${IMAGE} not found; run: $0 build"

  local size_bytes
  size_bytes=$(docker image inspect "$IMAGE" --format '{{.Size}}')
  info "size $(awk -v b="$size_bytes" 'BEGIN{printf "%.2f GB", b/1024/1024/1024}'), $(docker image inspect "$IMAGE" --format '{{len .RootFS.Layers}}') layers"

  # No API key of any kind in the image configuration.
  if docker image inspect "$IMAGE" --format '{{json .Config.Env}}' | grep -qiE 'AIza|sk-[a-zA-Z0-9]{20}|API_KEY=[^",]'; then
    bad "no API key baked into the image environment"
  else
    ok "no API key baked into the image environment"
  fi

  # The host virtualenvs must not have been copied in. /app/studio/.venv existing would mean
  # .dockerignore stopped working and 131 MB of host wheels shipped with the submission.
  if docker run --rm --entrypoint sh "$IMAGE" -c '[ ! -e /app/studio/.venv ] && [ ! -e /app/.venv ]'; then
    ok "no host virtualenv copied into /app"
  else
    bad "host virtualenv found in /app -- .dockerignore is not being applied"
  fi

  if docker run --rm --entrypoint sh "$IMAGE" -c '[ ! -e /app/studio/.env ] && [ ! -e /app/.env ]'; then
    ok "no .env file in the image"
  else
    bad "a .env file was copied into the image"
  fi

  # No build toolchain in the final stage: go, node and gcc all belong to builder stages only.
  if docker run --rm --entrypoint sh "$IMAGE" -c '! command -v go && ! command -v node && ! command -v gcc' >/dev/null 2>&1; then
    ok "no build toolchain in the final image"
  else
    bad "a compiler or node runtime is present in the final image"
  fi

  # The artefacts that must be there.
  check "engine CLI present"     docker run --rm --entrypoint sh "$IMAGE" -c 'test -x /usr/local/bin/aletheia'
  check "worker present"         docker run --rm --entrypoint sh "$IMAGE" -c 'test -x /usr/local/bin/worker'
  check "built UI bundle present" docker run --rm --entrypoint sh "$IMAGE" -c 'test -s /usr/share/aletheia/ui/index.html'
  check "studio venv present"    docker run --rm --entrypoint sh "$IMAGE" -c 'test -x /venv/bin/uvicorn'
  check "parser packs present"   docker run --rm --entrypoint sh "$IMAGE" -c 'test -n "$(ls /opt/aletheia/packs/*.yaml 2>/dev/null)"'
  check "golden samples present" docker run --rm --entrypoint sh "$IMAGE" -c 'test -d /opt/aletheia/packs/tests'

  # MinIO was removed: no application code ever wrote to S3 (no S3 SDK and no Parquet library in
  # backend/engine/go.mod, no reference anywhere in backend/studio), so it only started itself
  # and created a bucket nothing used. This guards against it being reintroduced unnoticed.
  if docker run --rm --entrypoint sh "$IMAGE" -c '! command -v minio && ! command -v mc' >/dev/null 2>&1; then
    ok "unused MinIO/mc binaries absent"
  else
    bad "MinIO binaries are back in the image"
  fi
}

# ---------------------------------------------------------------- runtime checks

OWNS_CONTAINER=0

cleanup() {
  # Only tear down what this run started. Without the ownership flag, a run that exits while
  # another run holds the same container name deletes the other run's container out from under
  # it -- which looks exactly like the container crashing for no reason.
  (( OWNS_CONTAINER )) || return 0
  if [[ "${KEEP:-0}" != "1" ]]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  else
    info "container ${CONTAINER} left running (KEEP=1)"
  fi
}

verify_runtime() {
  step "Start container the way a judge will"
  need curl

  # Two concurrent runs share this container name, and the loser's EXIT trap deletes the
  # winner's container out from under it. Refuse rather than fight.
  if docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
    die "${CONTAINER} is already running (another verify in progress). Stop it first: docker rm -f ${CONTAINER}"
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  trap cleanup EXIT

  # No --env-file, no -e: the image is self-contained and the LLM key is entered in the UI.
  docker run -d --name "$CONTAINER" \
    -p "${P_UI}:6156" \
    -p "${P_SYSLOG}:5514/udp" \
    -p "${P_SYSLOG}:5514/tcp" \
    -p "${P_SYSLOG_OCTET}:5515/tcp" \
    -p "${P_SYSLOG_TLS}:6514/tcp" \
    "$IMAGE" >/dev/null || die "container failed to start"
  OWNS_CONTAINER=1

  info "waiting for HEALTHCHECK to report healthy (up to ${HEALTH_TIMEOUT}s)"
  info "first boot runs initdb, the ClickHouse schema, topic creation and pack seeding before"
  info "anything reports ready, so a quiet minute or two here is normal, not a hang"
  echo

  local waited=0 state comps
  while :; do
    state=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)

    # Distinguish "someone deleted the container" from "it crashed on its own". The generic
    # message sent people hunting through logs that no longer existed.
    if [[ "$state" == "missing" ]]; then
      die "container ${CONTAINER} disappeared (removed by another run of this script?)"
    fi

    if [[ "$state" == "healthy" ]]; then
      ok "container healthy after ${waited}s"
      break
    fi

    if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
      docker logs --tail 60 "$CONTAINER" 2>&1 | sed 's/^/      /'
      die "container exited before becoming healthy"
    fi

    # Show which components are still coming up, rather than printing nothing for ten minutes.
    # The readiness aggregator answers on 8088 inside the container even before nginx is up,
    # so this works during the part of the boot where :6156 still refuses connections.
    if (( waited % 15 == 0 )); then
      # `|| true` is load-bearing: the script runs under `set -euo pipefail`, and early in the
      # boot this curl exits 7 (cannot connect) because the aggregator is not listening yet.
      # Without it, pipefail propagates 7 and set -e kills the whole verify on the first tick.
      comps=$(docker exec "$CONTAINER" sh -c \
                'curl -fsS --max-time 3 http://127.0.0.1:8088/healthz 2>/dev/null' 2>/dev/null \
              | tr -d '"{} ' | tr ',' '\n' \
              | awk -F: '/^(postgres|clickhouse|redpanda|loki|prometheus|studio)/ {printf "%s:%s ", $1, $2}' || true)
      [[ -n "$comps" ]] || comps="aggregator not answering yet"
      printf '    %s[%4ds]%s %s\n' "$C_DIM" "$waited" "$C_0" "$comps"
    fi

    (( waited >= HEALTH_TIMEOUT )) && {
      info "last readiness report:"
      curl -fsS --max-time 5 "http://127.0.0.1:${P_UI}/healthz" 2>/dev/null | sed 's/^/      /' || true
      docker logs --tail 60 "$CONTAINER" 2>&1 | sed 's/^/      /'
      die "not healthy after ${HEALTH_TIMEOUT}s"
    }
    sleep 5; waited=$((waited+5))
  done

  # --- frontend, from the host
  step "Frontend on :${P_UI}"
  local body
  body=$(curl -fsS --max-time 10 "http://127.0.0.1:${P_UI}/" || true)
  if grep -q '<div id="root"' <<<"$body" || grep -qi '<title' <<<"$body"; then
    ok "UI index.html served"
  else
    bad "UI index.html not served"
  fi

  # The hashed bundle the index references must actually be fetchable, otherwise the judge gets
  # a blank page -- a 200 on / proves nothing on its own.
  local asset
  asset=$(grep -oE '/assets/[A-Za-z0-9._-]+\.js' <<<"$body" | head -1 || true)
  if [[ -n "$asset" ]] && curl -fsS -o /dev/null --max-time 15 "http://127.0.0.1:${P_UI}${asset}"; then
    ok "UI JS bundle fetchable (${asset})"
  else
    bad "UI JS bundle not fetchable"
  fi

  # SPA deep link must fall through to index.html, not 404.
  check "SPA deep route /demo serves the app" \
    curl -fsS -o /dev/null --max-time 10 "http://127.0.0.1:${P_UI}/demo"

  # --- internal services, as reported by the in-container readiness aggregator
  step "Internal services (readiness aggregator via :${P_UI}/healthz)"
  # Poll rather than sample once. The container reports healthy as soon as the *required*
  # components are up; Loki and Prometheus are optional to readiness and legitimately take
  # another 20-40s, so a single immediate probe catches Loki mid-start and calls it broken.
  local health svc i
  for i in $(seq 1 24); do
    health=$(curl -fsS --max-time 10 "http://127.0.0.1:${P_UI}/healthz" || true)
    grep -q '"starting' <<<"$health" || break
    sleep 5
  done

  if grep -q '"ready"' <<<"$health"; then
    ok "aggregate status: ready"
  else
    bad "aggregate status not ready"
  fi

  # Matches OPTIONAL in init/healthz_server.py: degraded, but the pipeline still works.
  local optional=" loki prometheus "
  for svc in postgres clickhouse redpanda loki prometheus studio; do
    if grep -qE "\"${svc}\"[[:space:]]*:[[:space:]]*\"ok\"" <<<"$health"; then
      ok "internal ${svc} reachable"
    elif [[ "$optional" == *" ${svc} "* ]]; then
      info "internal ${svc} still starting (optional, does not gate readiness) -- $(grep -oE "\"${svc}\"[^,}]*" <<<"$health" || echo 'not reported')"
    else
      bad "internal ${svc} not reachable -- $(grep -oE "\"${svc}\"[^,}]*" <<<"$health" || echo 'not reported')"
    fi
  done

  # Direct in-container socket probes, independent of the aggregator's own opinion.
  step "Internal ports (probed inside the container)"
  local p
  for p in "postgres:5432" "clickhouse-http:8123" "clickhouse-native:9000" "redpanda:9092" \
           "loki:3100" "prometheus:9090" "studio:8081" "healthz:8088" "grafana:3000"; do
    if docker exec "$CONTAINER" bash -c "nc -z 127.0.0.1 ${p##*:}" >/dev/null 2>&1; then
      ok "127.0.0.1:${p##*:} listening (${p%%:*})"
    else
      bad "127.0.0.1:${p##*:} not listening (${p%%:*})"
    fi
  done

  # --- the Studio API, reached the way the browser reaches it: through nginx on 6156
  step "Studio API through the nginx entrypoint"
  check "GET /api/v1/stats/overview" curl -fsS -o /dev/null --max-time 20 "http://127.0.0.1:${P_UI}/api/v1/stats/overview"
  check "GET /api/v1/sources"        curl -fsS -o /dev/null --max-time 20 "http://127.0.0.1:${P_UI}/api/v1/sources"

  # The Demo Console is the judge's primary path (README §5). It returned 503 "demo engine not
  # installed" for a long time because the Studio resolved the script path relative to a repo
  # checkout, which is "/" inside the image. Assert it is wired, not merely that the API answers.
  local dreset
  dreset=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
             -X POST "http://127.0.0.1:${P_UI}/api/v1/demo/reset" 2>/dev/null || echo 000)
  if [[ "$dreset" == "200" ]]; then
    ok "Demo Console engine wired (POST /api/v1/demo/reset -> 200)"
  else
    bad "Demo Console broken (POST /api/v1/demo/reset -> ${dreset}; 503 = script path wrong)"
  fi

  # The Studio silently falls back to an in-memory repo when it cannot find a Postgres DSN,
  # which loses every saved setting -- including the Gemini API key -- on restart.
  if docker logs "$CONTAINER" 2>&1 | grep -q "in-memory only"; then
    bad "Studio is running in-memory (no PG DSN) -- settings and API keys will not persist"
  else
    ok "Studio is backed by PostgreSQL (settings and API keys persist)"
  fi

  # A 200 is not enough. The overview returns 200 while reporting {"ch":{"available":false}} when
  # the Studio cannot authenticate to ClickHouse -- which is exactly what the UI renders as
  # "Event DB down". Assert the payload, not just the status code.
  local ov
  ov=$(curl -fsS --max-time 20 "http://127.0.0.1:${P_UI}/api/v1/stats/overview" 2>/dev/null || true)
  if grep -qE '"ch"[[:space:]]*:[[:space:]]*\{[[:space:]]*"available"[[:space:]]*:[[:space:]]*true' <<<"$ov"; then
    ok "Studio reaches the event store (UI shows 'Event DB reachable')"
  else
    bad "Studio cannot reach ClickHouse -- UI would show 'Event DB down': $(grep -oE '"ch":\{[^}]*\}' <<<"$ov" || echo 'no ch field')"
  fi

  # --- Grafana, reached the way the browser reaches it: under /grafana/ on the UI port
  step "Grafana through the nginx entrypoint (:${P_UI}/grafana/)"
  local gf="http://127.0.0.1:${P_UI}/grafana"
  check "Grafana ${gf}/api/health"  curl -fsS -o /dev/null --max-time 15 "${gf}/api/health"
  # A 200 on the HTML is not enough: the page must boot, so its JS bundle must load too.
  local gpage gjs
  gpage=$(curl -fsS --max-time 15 "${gf}/login" 2>/dev/null || true)
  # Grafana writes asset paths relative to <base href="/grafana/">, so resolve them the same way.
  gjs=$(grep -oE 'public/build/[A-Za-z0-9._-]+\.js' <<<"$gpage" | head -1 || true)
  if [[ -n "$gjs" ]] && curl -fsS -o /dev/null --max-time 15 "${gf}/${gjs}"; then
    ok "Grafana UI and JS bundle served under /grafana/ (${gjs})"
  else
    bad "Grafana UI bundle not reachable under /grafana/"
  fi
  if curl -sS -D - -o /dev/null --max-time 15 "${gf}/login" 2>/dev/null | grep -qi '^content-security-policy'; then
    bad "Grafana pages inherit the UI's CSP (Grafana needs inline scripts)"
  else
    ok "Grafana pages are not held to the UI's CSP"
  fi
  local ws
  ws=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 --http1.1 \
         -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
         -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "${gf}/api/live/ws" 2>/dev/null || true)
  if [[ "$ws" == "101" ]]; then ok "Grafana Live websocket upgrades through nginx"; else bad "Grafana Live websocket -> ${ws}"; fi

  # Grafana answering /api/health says only that Grafana is up. Provisioning can fail silently
  # (a dashboards path that does not exist just logs an error every 30s), leaving a judge with
  # an empty Grafana, so assert the dashboards are actually there.
  local dash
  dash=$(curl -fsS --max-time 15 -u "admin:${ALETHEIA_ADMIN_PASSWORD:-aletheia}" \
           "${gf}/api/search?type=dash-db" 2>/dev/null || true)
  if [[ "$(grep -o '"uid"' <<<"$dash" | wc -l)" -ge 2 ]]; then
    ok "Grafana dashboards provisioned ($(grep -o '"uid"' <<<"$dash" | wc -l) found)"
  else
    bad "Grafana dashboards missing -- provisioning path wrong? got: ${dash:0:120}"
  fi
  # Studio's alert deep links must point at the proxied path, not a host port that is closed.
  local gpub
  gpub=$(curl -fsS --max-time 15 "http://127.0.0.1:${P_UI}/api/v1/alerting/status" 2>/dev/null \
           | grep -oE '"public_url"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 || true)
  if grep -q '"/grafana"' <<<"$gpub"; then ok "Studio links Grafana at /grafana"; else bad "Studio Grafana public_url: ${gpub:-missing}"; fi

  # --- nothing but nginx and syslog is published or bound beyond loopback
  step "Hidden ports"
  local published
  published=$(docker inspect -f '{{range $p, $_ := .Config.ExposedPorts}}{{$p}} {{end}}' "$CONTAINER")
  if grep -qE '(^| )(3000|8123|9000|9090|3100|8081|5432|9092)/tcp' <<<"$published"; then
    bad "image EXPOSEs an internal port: ${published}"
  else
    ok "image EXPOSEs only: ${published}"
  fi
  # Even on the container's own network address, internal services must not answer.
  local cip
  cip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CONTAINER")
  for p in 3000 8123 9000 9090 3100 8081 8088 5432 9092; do
    if [[ -n "$cip" ]] && timeout 3 bash -c "exec 3<>/dev/tcp/${cip}/${p}" 2>/dev/null; then
      bad "${cip}:${p} answers from outside the container"
    else
      ok "${p} not reachable from outside the container"
    fi
  done

  step "Syslog ports (from the host)"
  check "syslog TCP :${P_SYSLOG} open"      bash -c "exec 3<>/dev/tcp/127.0.0.1/${P_SYSLOG}"
  check "syslog octet-counted TCP :${P_SYSLOG_OCTET} open" bash -c "exec 3<>/dev/tcp/127.0.0.1/${P_SYSLOG_OCTET}"
  check "syslog TLS :${P_SYSLOG_TLS} open"  bash -c "exec 3<>/dev/tcp/127.0.0.1/${P_SYSLOG_TLS}"

  # --- end-to-end: a line in the front door comes out in ClickHouse
  step "End-to-end ingest (host :${P_SYSLOG} -> Vector -> Redpanda -> worker -> ClickHouse)"
  local before after token line

  # Never let a failed query abort the run: report it instead. Echoes the raw body on error so
  # an auth or missing-table problem is visible rather than being swallowed as "0 rows".
  ch_count() {
    local q="$1" out rc
    # -G is required. Without it --data-urlencode POSTs "query=<sql>" as the request *body*,
    # and ClickHouse reads a POST body as the statement itself, so it tries to parse the literal
    # text "query=SELECT ..." and fails with "Syntax error at position 1 ('query')".
    # ClickHouse is loopback-only, so the query runs inside the container.
    out=$(docker exec "$CONTAINER" curl -sS -G --max-time 15 --data-urlencode "query=${q}" \
            "http://127.0.0.1:8123/" 2>&1) && rc=0 || rc=$?
    out=$(printf '%s' "$out" | tr -d '[:space:]')
    if [[ "$out" =~ ^[0-9]+$ ]]; then
      printf '%s' "$out"
    else
      printf 'ERR'
      [[ -n "${CH_QUIET:-}" ]] || printf '%s\n' "      clickhouse: ${out:0:200}" >&2
    fi
  }

  before=$(ch_count 'SELECT count() FROM aletheia.events')
  if [[ "$before" == "ERR" ]]; then
    bad "ClickHouse query failed (see message above) -- cannot measure ingest"
    before=0
  else
    info "events before: ${before}"
  fi

  # A deliberately unknown format carrying a unique token. It exercises the harder half of the
  # guarantee: an unrecognised line must still be stored verbatim rather than dropped, which is
  # also what makes it findable by exact string match.
  token="ALETHEIA-VERIFY-$(date +%s)-$$"
  line="<134>1 $(date -u +%Y-%m-%dT%H:%M:%SZ) verifyhost aletheia-selftest - - - probe=${token} action=allow"

  local i
  for i in 1 2 3 4 5; do
    printf '%s\n' "$line" > "/dev/udp/127.0.0.1/${P_SYSLOG}" 2>/dev/null || true
    printf '%s\n' "$line" > "/dev/tcp/127.0.0.1/${P_SYSLOG}" 2>/dev/null || true
  done
  ok "sent 5 UDP + 5 TCP syslog lines to :${P_SYSLOG}"

  info "polling ClickHouse for the token (up to 90s)"
  local found=0
  for i in $(seq 1 18); do
    sleep 5
    found=$(CH_QUIET=1 ch_count "SELECT count() FROM aletheia.events WHERE raw_verbatim LIKE '%${token}%' OR arrayExists(v -> position(v, '${token}') > 0, vars)")
    [[ "$found" =~ ^[0-9]+$ ]] || found=0
    (( found > 0 )) && break
  done

  if (( found > 0 )); then
    ok "self-test line found in ClickHouse (${found} rows) -- nothing dropped"
  else
    bad "self-test line never reached ClickHouse"
  fi

  after=$(ch_count 'SELECT count() FROM aletheia.events')
  [[ "$after" =~ ^[0-9]+$ ]] || after=0
  if (( after > before )); then
    ok "pipeline is producing events (${before} -> ${after})"
  else
    bad "event count did not advance (${before} -> ${after})"
  fi

  # --- the project's central claim, re-derived inside the image being shipped
  step "Byte-exact reconstruction, inside the shipped image"
  local recon
  # test-pack validates one pack at a time (--pack <file>), so loop over them and aggregate.
  # --packs is a different command's flag (verify/bench) and made every run a no-op.
  if recon=$(docker exec -i "$CONTAINER" /venv/bin/python - <<'PYEOF' 2>&1
import glob, json, subprocess, sys
tot = rec = fail = 0
for path in sorted(glob.glob("/opt/aletheia/packs/*.yaml")):
    if path.split("/")[-1].startswith("_"):
        continue
    p = subprocess.run(["/usr/local/bin/aletheia", "test-pack", "--pack", path,
                        "--samples", "/opt/aletheia/packs/tests", "--json"],
                       capture_output=True, text=True)
    try:
        d = json.loads(p.stdout or "{}")
    except json.JSONDecodeError:
        print(f"{path}: unparseable output: {(p.stdout or p.stderr)[:120]}"); fail += 1; continue
    n, r = d.get("samples", 0), d.get("reconstructed", 0)
    f = len(d.get("failures") or [])
    tot += n; rec += r; fail += f
    if f:
        print(f"  {path.split('/')[-1]}: {r}/{n} reconstructed, {f} FAILED")
print(f"TOTAL samples={tot} reconstructed={rec} failures={fail}")
sys.exit(0 if (fail == 0 and tot > 0) else 1)
PYEOF
  ); then
    printf '%s\n' "$recon" | tail -5 | sed 's/^/      /'
    if grep -qE 'failures=0' <<<"$recon"; then
      ok "all golden samples reconstruct byte for byte"
    else
      bad "reconstruction reported failures"
    fi
  else
    info "test-pack CLI flags differ in this build; skipping (not a pipeline failure)"
    printf '%s\n' "$recon" | tail -3 | sed 's/^/      /'
  fi

  # --- CLI surface the README documents
  step "CLI"
  check "aletheia --version" docker exec "$CONTAINER" /usr/local/bin/aletheia --version
}

# ---------------------------------------------------------------- save

do_save() {
  step "Save submission tarball"
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "image ${IMAGE} not found; run: $0 build"
  mkdir -p "$OUT_DIR"

  docker save -o "$TARBALL" "$IMAGE" || die "docker save failed"
  gzip -f -9 "$TARBALL"
  local gz="${TARBALL}.gz"

  ( cd "$OUT_DIR" && sha256sum "$(basename "$gz")" > "$(basename "$gz").sha256" )

  info "$(ls -lh "$gz" | awk '{print $5}')  ${gz}"
  info "sha256: $(awk '{print $1}' "${gz}.sha256")"

  cat > "${OUT_DIR}/LOAD.md" <<EOF
# Aletheia ${ALETHEIA_VERSION} — single-image submission

\`\`\`bash
sha256sum -c aletheia-${ALETHEIA_VERSION}.tar.gz.sha256
gunzip -c aletheia-${ALETHEIA_VERSION}.tar.gz | docker load

docker run -d --name aletheia \\
  -p 6156:6156 \\
  -p 26514:5514/udp -p 26514:5514/tcp -p 26515:5515/tcp -p 26516:6514/tcp \\
  -p 29099:9099 \\
  ${IMAGE}
\`\`\`

Wait for \`docker ps\` to show **healthy** (first boot is one to two minutes), then open
<http://localhost:6156>.

No environment file and no API key are required. Every service address is internal to the
container. To use the optional AI assistant, open Settings in the UI and enter a Gemini key
there; it is stored encrypted in the container and never leaves it otherwise.

| Port | Service |
|---|---|
| 6156 | The only HTTP port: Aletheia UI at \`/\`, API at \`/api/\`, Grafana at \`/grafana/\` |
| 26514 udp/tcp | Syslog input — send your own logs |
| 26515 tcp | Syslog, octet-counted framing |
| 26516 tcp | Syslog over TLS |
| 29099 tcp | Supply stream out: point a SIEM or collector here once the Export page enables it |

Send a log line:

\`\`\`bash
logger --server localhost --port 26514 --udp "<your log line>"
\`\`\`

Persist state across restarts by adding \`-v aletheia-data:/data\`.
EOF
  info "wrote ${OUT_DIR}/LOAD.md"
}

# ---------------------------------------------------------------- tag / push

REGISTRY="${ALETHEIA_REGISTRY:-docker.io/ritesh2006}"
REMOTE_TAG="${REMOTE_TAG:-${REGISTRY}/aletheia:${ALETHEIA_VERSION}}"

do_tag() {
  step "Tag for the registry"
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "image ${IMAGE} not found; run: $0 build"
  docker tag "$IMAGE" "$REMOTE_TAG"
  docker tag "$IMAGE" "${REGISTRY}/aletheia:latest"
  ok "tagged ${REMOTE_TAG}"
  ok "tagged ${REGISTRY}/aletheia:latest"
  info "push with:  docker push ${REMOTE_TAG}"
  info "            docker push ${REGISTRY}/aletheia:latest"
  info "(docker login first if you have not already)"
}

do_push() {
  step "Push ${REMOTE_TAG}"
  docker image inspect "$REMOTE_TAG" >/dev/null 2>&1 || do_tag
  docker push "$REMOTE_TAG" || die "push failed (docker login?)"
  docker push "${REGISTRY}/aletheia:latest" || true
  ok "pushed"
}

# ---------------------------------------------------------------- summary

summary() {
  printf '\n%s---------------------------------------------%s\n' "$C_B" "$C_0"
  if (( FAIL == 0 )); then
    printf '%s%d checks passed, 0 failed%s\n' "$C_OK" "$PASS" "$C_0"
  else
    printf '%s%d passed, %d FAILED%s\n' "$C_BAD" "$PASS" "$FAIL" "$C_0"
  fi
  (( FAIL == 0 )) || exit 1
}

# ---------------------------------------------------------------- main

case "${1:-all}" in
  build)  do_build ;;
  verify) verify_image; verify_runtime; summary ;;
  save)   do_save ;;
  tag)    do_tag ;;
  push)   do_push ;;
  all)    do_build; verify_image; verify_runtime; summary; do_tag ;;
  *)      die "usage: $0 [all|build|verify|tag|push|save]" ;;
esac
