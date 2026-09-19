# syntax=docker/dockerfile:1.7
# Aletheia streaming worker — slim production image. Build context is the repo root.
ARG GO_VERSION=1.23
ARG DEBIAN_SUITE=bookworm

FROM golang:${GO_VERSION}-${DEBIAN_SUITE} AS build
WORKDIR /src
COPY backend/engine/go.mod backend/engine/go.su[m] ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download || true
COPY backend/engine ./
COPY backend/ocsf /ocsf
ARG ALETHEIA_VERSION=dev
ARG TARGETOS
ARG TARGETARCH
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
    go build -trimpath -ldflags "-s -w -X main.version=${ALETHEIA_VERSION}" -o /out/worker ./cmd/worker && \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
    go build -trimpath -ldflags "-s -w -X main.version=${ALETHEIA_VERSION}" -o /out/aletheia ./cmd/aletheia

FROM debian:${DEBIAN_SUITE}-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 --create-home --home-dir /home/aletheia aletheia
COPY --from=build /out/worker /usr/local/bin/worker
COPY --from=build /out/aletheia /usr/local/bin/aletheia
COPY --from=build /ocsf /ocsf
COPY backend/packs /packs
ENV ALETHEIA_PACKS_DIR=/packs \
    ALETHEIA_OCSF_DIR=/ocsf \
    ALETHEIA_METRICS_ADDR=:9108
USER aletheia
EXPOSE 9108
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9108/healthz | grep -q ok || exit 1
ENTRYPOINT ["/usr/local/bin/worker"]
