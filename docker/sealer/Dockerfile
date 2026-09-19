# syntax=docker/dockerfile:1.7
# Merkle sealer — same engine binary, sealer role. Build context is the repo root.
ARG GO_VERSION=1.23
ARG DEBIAN_SUITE=bookworm

FROM golang:${GO_VERSION}-${DEBIAN_SUITE} AS build
WORKDIR /src
COPY backend/engine/go.mod backend/engine/go.su[m] ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download || true
COPY backend/engine ./
ARG ALETHEIA_VERSION=dev
ARG TARGETOS
ARG TARGETARCH
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
    go build -trimpath -ldflags "-s -w -X main.version=${ALETHEIA_VERSION}" -o /out/aletheia ./cmd/aletheia && \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
    go build -trimpath -ldflags "-s -w -X main.version=${ALETHEIA_VERSION}" -o /out/worker ./cmd/worker

FROM debian:${DEBIAN_SUITE}-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 --create-home --home-dir /home/aletheia aletheia
COPY --from=build /out/worker /usr/local/bin/worker
COPY --from=build /out/aletheia /usr/local/bin/aletheia
ENV ALETHEIA_ROLE=sealer \
    ALETHEIA_METRICS_ADDR=:9109
USER aletheia
EXPOSE 9109
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9109/healthz | grep -q ok || exit 1
ENTRYPOINT ["/usr/local/bin/worker", "--role", "sealer"]
