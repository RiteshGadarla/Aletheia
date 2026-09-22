# syntax=docker/dockerfile:1.7
# Onboarding Studio (FastAPI) + the engine CLI it shells out to (CONTRACTS §8).
# Ships with NO API key: the operator supplies one at run time (CONTRACTS §9).
ARG GO_VERSION=1.23
ARG PYTHON_VERSION=3.12
ARG DEBIAN_SUITE=bookworm

FROM golang:${GO_VERSION}-${DEBIAN_SUITE} AS engine
WORKDIR /src
COPY backend/engine/go.mod backend/engine/go.su[m] ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download || true
COPY backend/engine ./
ARG TARGETOS
ARG TARGETARCH
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
    go build -trimpath -ldflags "-s -w" -o /out/aletheia ./cmd/aletheia

FROM python:${PYTHON_VERSION}-slim-${DEBIAN_SUITE} AS deps
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update && apt-get install -y --no-install-recommends build-essential librdkafka-dev \
    && rm -rf /var/lib/apt/lists/*
COPY backend/studio/requirements.txt /tmp/requirements.txt
RUN python -m venv /venv && /venv/bin/pip install -r /tmp/requirements.txt

FROM python:${PYTHON_VERSION}-slim-${DEBIAN_SUITE}
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates librdkafka1 \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 --create-home --home-dir /home/aletheia aletheia
COPY --from=deps /venv /venv
COPY --from=engine /out/aletheia /usr/local/bin/aletheia
COPY backend/studio /app/studio
COPY backend/ocsf /app/ocsf
COPY demo /app/demo
WORKDIR /app
ENV PATH=/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    ALETHEIA_ENGINE_BIN=/usr/local/bin/aletheia \
    ALETHEIA_OCSF_DIR=/app/ocsf \
    ALETHEIA_PACKS_DIR=/packs \
    ALETHEIA_DEMO_DIR=/app/demo \
    ALETHEIA_LLM_PROVIDER=none
# No key, no base URL, no secret: all supplied at run time.
USER aletheia
EXPOSE 8081
HEALTHCHECK --interval=10s --timeout=5s --start-period=25s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8081/healthz', timeout=3).status==200 else 1)"
ENTRYPOINT ["uvicorn", "studio.main:app", "--host", "0.0.0.0", "--port", "8081"]
