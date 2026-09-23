# syntax=docker/dockerfile:1.7
# Aletheia all-in-one evaluation image (spec §13.2).
# One `docker run` gives an evaluator the whole stack. s6-overlay is PID 1.
# Deliberately absent: AI model weights and any inference runtime, API keys,
# production credentials. Build context is the repo root.

ARG GO_VERSION=1.23
ARG NODE_VERSION=22
ARG PYTHON_VERSION=3.12
ARG DEBIAN_SUITE=bookworm

# Pinned upstream components — keep in sync with docker/versions.env.
ARG VECTOR_VERSION=0.44.0
ARG REDPANDA_VERSION=v24.3.6
ARG CLICKHOUSE_VERSION=24.8.14.39
ARG POSTGRES_VERSION=16.6
ARG LOKI_VERSION=3.3.2
ARG GRAFANA_VERSION=11.4.0
ARG PROMETHEUS_VERSION=v3.1.0
ARG S6_OVERLAY_VERSION=3.2.0.2

# BuildKit cache mounts below (npm, pip, apt) live outside the image: nothing they hold ends up
# in a layer, so they make rebuilds faster AND the image slightly smaller than the previous
# `rm -rf /var/lib/apt/lists/*` approach. `rm -f docker-clean` is required because Debian images
# ship an apt hook that deletes downloaded .debs, which would empty the cache on every run.
# Each stage uses its own cache id so the three apt steps still run in parallel.

# ---------------------------------------------------------------- builders

FROM golang:${GO_VERSION}-${DEBIAN_SUITE} AS go-build
WORKDIR /src
COPY backend/engine/go.mod backend/engine/go.su[m] ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download || true
COPY backend/engine ./
ARG ALETHEIA_VERSION=dev
ARG TARGETOS
ARG TARGETARCH
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
      go build -trimpath -ldflags "-s -w -X main.version=${ALETHEIA_VERSION}" -o /out/worker ./cmd/worker && \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
      go build -trimpath -ldflags "-s -w -X main.version=${ALETHEIA_VERSION}" -o /out/aletheia ./cmd/aletheia

FROM node:${NODE_VERSION}-${DEBIAN_SUITE} AS ui-build
WORKDIR /app
ENV npm_config_fund=false npm_config_audit=false
COPY frontend/package.json frontend/package-lock.jso[n] ./
RUN --mount=type=cache,id=aletheia-npm,target=/root/.npm \
    npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY frontend ./
ARG ALETHEIA_VERSION=dev
ENV VITE_ALETHEIA_VERSION=${ALETHEIA_VERSION}
RUN npm run build

FROM python:${PYTHON_VERSION}-slim-${DEBIAN_SUITE} AS py-build
RUN --mount=type=cache,id=aletheia-apt-py,target=/var/cache/apt \
    --mount=type=cache,id=aletheia-aptlib-py,target=/var/lib/apt \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && apt-get install -y --no-install-recommends build-essential librdkafka-dev
COPY backend/studio/requirements.txt /tmp/requirements.txt
RUN --mount=type=cache,id=aletheia-pip,target=/root/.cache/pip \
    python -m venv /venv && \
    /venv/bin/pip install --retries 10 --timeout 120 -r /tmp/requirements.txt

# s6-overlay: process supervision, dependency-ordered start, clean signal forwarding.
FROM debian:${DEBIAN_SUITE}-slim AS s6
ARG S6_OVERLAY_VERSION
ARG TARGETARCH
# ca-certificates is not optional here: debian-slim ships no CA bundle, so curl fails the s6
# download with "error setting certificate file" (exit 77) before it ever reaches the network.
RUN --mount=type=cache,id=aletheia-apt-s6,target=/var/cache/apt \
    --mount=type=cache,id=aletheia-aptlib-s6,target=/var/lib/apt \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) S6_ARCH=x86_64 ;; \
      arm64) S6_ARCH=aarch64 ;; \
      *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    mkdir -p /s6; \
    base="https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}"; \
    curl -fsSL "${base}/s6-overlay-noarch.tar.xz"      -o /tmp/noarch.tar.xz; \
    curl -fsSL "${base}/s6-overlay-${S6_ARCH}.tar.xz"  -o /tmp/arch.tar.xz; \
    tar -C /s6 -Jxpf /tmp/noarch.tar.xz; \
    tar -C /s6 -Jxpf /tmp/arch.tar.xz

# Upstream components, pulled as pinned images and copied in. Nothing is fetched at run time.
FROM timberio/vector:${VECTOR_VERSION}-debian            AS up-vector
FROM redpandadata/redpanda:${REDPANDA_VERSION}           AS up-redpanda
FROM clickhouse/clickhouse-server:${CLICKHOUSE_VERSION}  AS up-clickhouse
FROM postgres:${POSTGRES_VERSION}-bookworm               AS up-postgres
FROM grafana/loki:${LOKI_VERSION}                        AS up-loki
FROM grafana/grafana:${GRAFANA_VERSION}-ubuntu           AS up-grafana
FROM prom/prometheus:${PROMETHEUS_VERSION}               AS up-prometheus

# ---------------------------------------------------------------- final

FROM python:${PYTHON_VERSION}-slim-${DEBIAN_SUITE}

ARG ALETHEIA_VERSION=dev
ARG VECTOR_VERSION
ARG REDPANDA_VERSION
ARG CLICKHOUSE_VERSION
ARG POSTGRES_VERSION
ARG LOKI_VERSION
ARG GRAFANA_VERSION
ARG PROMETHEUS_VERSION

LABEL org.opencontainers.image.title="Aletheia" \
      org.opencontainers.image.description="Universal lossless log pre-processing framework — all-in-one evaluation image" \
      org.opencontainers.image.version="${ALETHEIA_VERSION}" \
      org.opencontainers.image.source="https://github.com/Ritesh2006M/aletheia" \
      org.opencontainers.image.licenses="Apache-2.0" \
      io.aletheia.components="vector=${VECTOR_VERSION} redpanda=${REDPANDA_VERSION} clickhouse=${CLICKHOUSE_VERSION} postgres=${POSTGRES_VERSION} loki=${LOKI_VERSION} grafana=${GRAFANA_VERSION} prometheus=${PROMETHEUS_VERSION}" \
      io.aletheia.ai-weights="none"

ENV DEBIAN_FRONTEND=noninteractive
RUN --mount=type=cache,id=aletheia-apt-final,target=/var/cache/apt \
    --mount=type=cache,id=aletheia-aptlib-final,target=/var/lib/apt \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates nginx openssl procps netcat-openbsd wget curl jq xz-utils tzdata locales \
      libicu72 libssl3 liblz4-1 libzstd1 libxml2 libxslt1.1 libldap-2.5-0 libnuma1 libatomic1 \
      libpq5 \
    && localedef -i en_US -c -f UTF-8 -A /usr/share/locale/locale.alias en_US.UTF-8 \
    && rm -rf /usr/share/doc /usr/share/man /usr/share/info /usr/share/lintian /usr/share/linda
ENV LANG=en_US.UTF-8

# --- s6-overlay as PID 1
COPY --from=s6 /s6/ /

# --- upstream binaries (pinned; no downloads at run time)
COPY --from=up-vector     /usr/bin/vector            /usr/local/bin/vector
COPY --from=up-vector     /usr/share/vector          /usr/share/vector
COPY --from=up-redpanda   /opt/redpanda              /opt/redpanda
COPY --from=up-clickhouse /usr/bin/clickhouse        /usr/local/bin/clickhouse
COPY --from=up-clickhouse /etc/clickhouse-server    /etc/aletheia/clickhouse
COPY --from=up-postgres   /usr/lib/postgresql        /usr/lib/postgresql
COPY --from=up-postgres   /usr/share/postgresql      /usr/share/postgresql
COPY --from=up-loki       /usr/bin/loki              /usr/local/bin/loki
COPY --from=up-grafana    /usr/share/grafana         /usr/share/grafana
COPY --from=up-prometheus /bin/prometheus            /usr/local/bin/prometheus
COPY --from=up-prometheus /bin/promtool              /usr/local/bin/promtool
# Prometheus v3 removed the bundled console templates (/usr/share/prometheus), and the run
# script passes no --web.console.* flags, so there is nothing left to copy from that path.

RUN set -eux; \
    ln -sf /usr/local/bin/clickhouse /usr/local/bin/clickhouse-server; \
    ln -sf /usr/local/bin/clickhouse /usr/local/bin/clickhouse-client; \
    ln -sf /opt/redpanda/bin/redpanda /usr/local/bin/redpanda; \
    ln -sf /opt/redpanda/bin/rpk /usr/local/bin/rpk; \
    ln -sf /usr/lib/postgresql/16/bin/postgres /usr/local/bin/postgres; \
    ln -sf /usr/lib/postgresql/16/bin/initdb /usr/local/bin/initdb; \
    ln -sf /usr/lib/postgresql/16/bin/psql /usr/local/bin/psql; \
    ln -sf /usr/lib/postgresql/16/bin/pg_isready /usr/local/bin/pg_isready; \
    ln -sf /usr/lib/postgresql/16/bin/pg_ctl /usr/local/bin/pg_ctl; \
    ln -sf /usr/share/grafana/bin/grafana /usr/local/bin/grafana

# --- Aletheia artefacts
COPY --from=go-build /out/worker    /usr/local/bin/worker
COPY --from=go-build /out/aletheia  /usr/local/bin/aletheia
COPY --from=py-build /venv          /venv
COPY --from=ui-build /app/dist      /usr/share/aletheia/ui
COPY backend/studio  /app/studio
COPY backend/ocsf    /app/ocsf
COPY backend/packs   /opt/aletheia/packs
COPY demo            /app/demo
COPY bench           /app/bench
COPY sources         /opt/aletheia/sources

# --- configuration (component configs live in the image, state never does)
COPY deploy/clickhouse/init.sql          /opt/aletheia/sql/clickhouse-init.sql
COPY deploy/clickhouse/config.d/         /etc/aletheia/clickhouse/config.d/
COPY deploy/postgres/init.sql            /opt/aletheia/sql/postgres-init.sql
COPY deploy/vector/ingest.toml           /etc/aletheia/vector/ingest.toml
COPY deploy/vector/sinks.toml            /etc/aletheia/vector/sinks.toml
COPY deploy/vector/loki.toml             /etc/aletheia/vector/loki.toml
COPY deploy/vector/sources.csv           /etc/aletheia/vector/sources.csv
COPY deploy/loki/loki.yml                /etc/aletheia/loki/loki.yml
COPY deploy/prometheus/prometheus.yml    /etc/aletheia/prometheus/prometheus.yml
COPY deploy/prometheus/rules             /etc/aletheia/prometheus/rules
COPY deploy/grafana/grafana.ini          /etc/aletheia/grafana/grafana.ini
COPY deploy/grafana/provisioning         /etc/aletheia/grafana/provisioning
COPY deploy/grafana/dashboards           /etc/aletheia/grafana/dashboards
COPY deploy/redpanda/create-topics.sh    /opt/aletheia/init/create-topics.sh
COPY docker/allinone/rootfs/             /
COPY docker/allinone/init/               /opt/aletheia/init/
COPY docker/allinone/s6-rc.d/            /etc/s6-overlay/s6-rc.d/
COPY docker/allinone/healthcheck.sh      /usr/local/bin/healthcheck.sh

# rootfs ships all-in-one overrides (everything on 127.0.0.1) for prometheus.yml
# and the Grafana datasources; they land on top of the deploy/ copies above.
RUN chmod +x /usr/local/bin/healthcheck.sh /opt/aletheia/init/*.sh && \
    find /etc/s6-overlay/s6-rc.d -type f \( -name run -o -name up -o -name finish \) -exec chmod +x {} +

# libpq5 is there for initdb specifically: the server binary links statically enough to run,
# but initdb needs libpq.so.5, which the copied /usr/lib/postgresql tree does not carry.
# Without it the very first boot dies in init-dirs with exit 127 and s6 stops the container.

# Non-root component users; /data is the only mutable tree.
# The directory list is a POSIX loop, not brace expansion: RUN uses /bin/sh, which is dash on
# Debian, and dash does not expand {a,b,c}. The brace form silently created one directory
# literally named "{postgres,clickhouse,...}" and the chown of /data/postgres then failed.
RUN set -eux; \
    groupadd -r aletheia; \
    useradd -r -g aletheia -d /data -s /usr/sbin/nologin aletheia; \
    useradd -r -g aletheia -d /data/postgres -s /usr/sbin/nologin pgrun; \
    for d in postgres clickhouse redpanda loki prometheus grafana vector tls run logs bench demo; do \
      mkdir -p "/data/$d"; \
    done; \
    chown -R aletheia:aletheia /data /opt/aletheia /app /usr/share/aletheia; \
    chown -R pgrun:aletheia /data/postgres

# --- telemetry off in every component at build time (spec §13.6)
ENV GF_ANALYTICS_REPORTING_ENABLED=false \
    GF_ANALYTICS_CHECK_FOR_UPDATES=false \
    GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false \
    GF_ANALYTICS_FEEDBACK_LINKS_ENABLED=false \
    GF_NEWS_NEWS_FEED_ENABLED=false \
    GF_USAGE_STATS_ENABLED=false \
    GF_PLUGINS_PLUGIN_ADMIN_ENABLED=false \
    DO_NOT_TRACK=1 \
    CHECKPOINT_DISABLE=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    RPK_ADDITIONAL_START_FLAGS="--set redpanda.enable_usage_stats=false"

# --- runtime defaults (spec §13.3). No API key is ever baked in.
ENV PATH=/venv/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin \
    ALETHEIA_VERSION=${ALETHEIA_VERSION} \
    ALETHEIA_UI_PORT=6156 \
    ALETHEIA_PACKS_DIR=/opt/aletheia/packs \
    ALETHEIA_OCSF_DIR=/app/ocsf \
    ALETHEIA_ENGINE_BIN=/usr/local/bin/aletheia \
    ALETHEIA_BIN=/usr/local/bin/aletheia \
    ALETHEIA_DEMO_AUTOSTART=true \
    ALETHEIA_DEMO_RATE=200 \
    ALETHEIA_DEMO_SAMPLES=asa,fortigate,cef \
    ALETHEIA_SERVE_PY=/opt/aletheia/sources/generators/servers/serve.py \
    ALETHEIA_DEMO_SCRIPT=/app/demo/scenarios.py \
    ALETHEIA_VERIFY_PACKS=/opt/aletheia/packs/verify_packs.py \
    ALETHEIA_LOKI_URL=http://127.0.0.1:3100 \
    ALETHEIA_WORKERS=2 \
    ALETHEIA_ADMIN_PASSWORD=aletheia \
    ALETHEIA_BUS_BROKERS=127.0.0.1:9092 \
    ALETHEIA_CLICKHOUSE_ADDR=127.0.0.1:9000 \
    ALETHEIA_CLICKHOUSE_HTTP=http://127.0.0.1:8123 \
    ALETHEIA_POSTGRES_DSN=postgres://aletheia:aletheia@127.0.0.1:5432/aletheia?sslmode=disable \
    ALETHEIA_PG_DSN=postgres://aletheia:aletheia@127.0.0.1:5432/aletheia?sslmode=disable \
    ALETHEIA_CLICKHOUSE_USER=aletheia \
    ALETHEIA_CLICKHOUSE_PASSWORD=aletheia \
    ALETHEIA_LLM_PROVIDER=none \
    ALETHEIA_LLM_MODEL= \
    ALETHEIA_LLM_BASE_URL= \
    ALETHEIA_LLM_API_KEY= \
    ALETHEIA_LLM_API_KEY_FILE= \
    ALETHEIA_LLM_SEND_SAMPLES=masked \
    ALETHEIA_AIRGAP=false \
    S6_KEEP_ENV=1 \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0 \
    S6_SERVICES_GRACETIME=15000 \
    S6_KILL_GRACETIME=15000

VOLUME ["/data"]

# 6156 UI  3000 Grafana  5514 syslog udp/tcp  5515 octet-counted  6514 syslog TLS  8123 ClickHouse HTTP
EXPOSE 6156 3000 5514/udp 5514/tcp 5515/tcp 6514/tcp 8123

HEALTHCHECK --interval=15s --timeout=10s --start-period=180s --retries=10 \
  CMD /usr/local/bin/healthcheck.sh

ENTRYPOINT ["/init"]
