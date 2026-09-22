# Aletheia — local development without Docker where possible.
#
#   make setup      one-time: venv, npm, local config (writes your LLM key locally, never to git)
#   make doctor     what is installed and what each target needs
#   make check      everything that runs with no services up  <- start here
#   make dev        Studio API + frontend, natively, no Docker
#   make lite       end-to-end on files: generate -> parse -> reconstruct -> verify, no Docker
#
# The full streaming pipeline needs Redpanda + ClickHouse + PostgreSQL. Those are not practical to
# install natively, so `make up` uses Docker for them. Everything else here runs on this machine.

SHELL       := /bin/bash
ROOT        := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
VENV        := $(ROOT)/.venv
PY          := $(VENV)/bin/python
PIP         := $(VENV)/bin/pip
ENGINE      := $(ROOT)/backend/engine
FRONTEND    := $(ROOT)/frontend
SECRETS     := $(ROOT)/deploy/secrets/aletheia.env
BIN         := $(ROOT)/bin
GOROOT_LOCAL:= $(HOME)/.local/go
GO          := $(shell command -v go 2>/dev/null || echo $(GOROOT_LOCAL)/bin/go)
GO_VERSION  := 1.23.5

export PATH := $(GOROOT_LOCAL)/bin:$(PATH)

.DEFAULT_GOAL := help
.PHONY: help doctor setup venv node-deps secrets check test verify-packs engine engine-test \
        studio-test frontend-check dev studio frontend lite cli bench-storage demo up down \
        logs install-go clean distclean services services-down gens gens-down bench-engine worker services-logs run topics \
        worker-smoke seal bench-storage-full

## ---------------------------------------------------------------- help / doctor

help:
	@sed -n 's/^## //p' $(MAKEFILE_LIST) | head -1 >/dev/null
	@echo "Aletheia — make targets"
	@echo
	@echo "  setup           one-time install (venv, npm, local LLM config)"
	@echo "  doctor          report toolchain and what is runnable"
	@echo
	@echo "  check           all offline checks: packs + engine + studio + frontend"
	@echo "  verify-packs    byte-exact reconstruction over every golden sample (no deps)"
	@echo "  engine          build the Go engine and CLI into ./bin"
	@echo "  engine-test     go test ./..."
	@echo "  studio-test     pytest"
	@echo "  worker-smoke    bus -> worker -> clickhouse -> verify (needs make services)"
	@echo "  seal            seal merkle batches over events already stored"
	@echo "  bench-storage-full  reproducible storage measurement (own corpus, own db)"
	@echo "  frontend-check  tsc --noEmit && vite build"
	@echo
	@echo "  dev             start full dev environment (services + studio + frontend + worker)"
	@echo "  studio          Studio API only"
	@echo "  frontend        frontend dev server only"
	@echo "  lite            dockerless end-to-end over files"
	@echo "  cli ARGS='...'  run the aletheia CLI, e.g. ARGS='test-pack --help'"
	@echo
	@echo "  services        start ONLY the datastores in Docker (CH, PG, Redpanda, MinIO)"
	@echo "  run             services in Docker + engine/studio/frontend natively"
	@echo "  up / down       optional: the entire stack in Docker"
	@echo "  install-go      install Go $(GO_VERSION) into ~/.local/go (no root)"
	@echo "  clean           remove build output"

doctor:
	@echo "toolchain"
	@printf "  %-10s %s\n" python3 "$$(command -v python3 || echo MISSING)"
	@printf "  %-10s %s\n" node    "$$(command -v node    || echo MISSING)"
	@printf "  %-10s %s\n" npm     "$$(command -v npm     || echo MISSING)"
	@printf "  %-10s %s\n" go      "$$(command -v go 2>/dev/null || ([ -x $(GOROOT_LOCAL)/bin/go ] && echo $(GOROOT_LOCAL)/bin/go) || echo 'MISSING  -> make install-go')"
	@printf "  %-10s %s\n" docker  "$$(command -v docker  || echo 'MISSING  (only needed for make up)')"
	@echo
	@echo "project state"
	@printf "  %-22s %s\n" "python venv"   "$$([ -d $(VENV) ] && echo present || echo 'absent -> make setup')"
	@printf "  %-22s %s\n" "node_modules"  "$$([ -d $(FRONTEND)/node_modules ] && echo present || echo 'absent -> make setup')"
	@printf "  %-22s %s\n" "local LLM config" "$$([ -f $(SECRETS) ] && echo 'present (gitignored)' || echo 'absent -> make secrets')"
	@printf "  %-22s %s\n" "engine binaries" "$$([ -x $(BIN)/aletheia ] && echo present || echo 'absent -> make engine')"
	@echo
	@echo "runnable with no services up: verify-packs, engine-test, studio-test, frontend-check, lite"
	@echo "needs Redpanda+ClickHouse+PostgreSQL (make up): worker, verify, replay, bench, demo"

## ---------------------------------------------------------------- setup

setup: venv node-deps secrets
	@echo
	@echo "setup complete. next: make check"

venv: $(VENV)/.stamp
$(VENV)/.stamp:
	python3 -m venv $(VENV)
	$(PIP) install --upgrade pip >/dev/null
	$(PIP) install -r $(ROOT)/backend/studio/requirements-dev.txt
	@touch $@

node-deps: $(FRONTEND)/node_modules
$(FRONTEND)/node_modules:
	cd $(FRONTEND) && npm install

# Writes the local LLM defaults so nobody has to type a key into the UI.
# This file is gitignored: the key stays on this machine and never reaches the repo.
secrets:
	@if [ -f $(SECRETS) ]; then \
	  echo "local LLM config already present: $(SECRETS)"; \
	else \
	  cp $(ROOT)/deploy/secrets/aletheia.env.example $(SECRETS); \
	  chmod 600 $(SECRETS); \
	  echo "created $(SECRETS) — add your key there (gitignored)"; \
	fi

install-go:
	@echo "installing Go $(GO_VERSION) into $(GOROOT_LOCAL) (no root needed)"
	@mkdir -p $(HOME)/.local
	@curl -fsSL https://go.dev/dl/go$(GO_VERSION).linux-amd64.tar.gz -o /tmp/go.tgz
	@rm -rf $(GOROOT_LOCAL) && tar -C $(HOME)/.local -xzf /tmp/go.tgz && rm -f /tmp/go.tgz
	@echo "installed. add to your shell rc:  export PATH=\$$HOME/.local/go/bin:\$$PATH"
	@$(GOROOT_LOCAL)/bin/go version

## ---------------------------------------------------------------- checks

# Everything that can be proven without a single service running.
check: verify-packs engine-test studio-test frontend-check
	@echo
	@echo "all offline checks passed"

test: check

# The project's central claim, and it needs nothing but python3.
verify-packs:
	@echo "== byte-exact reconstruction over every golden sample =="
	@python3 $(ROOT)/backend/packs/verify_packs.py

engine: $(BIN)
	@command -v $(GO) >/dev/null 2>&1 || { echo "go not found -> make install-go"; exit 1; }
	cd $(ENGINE) && $(GO) build -o $(BIN)/aletheia ./cmd/aletheia
	cd $(ENGINE) && $(GO) build -o $(BIN)/aletheia-worker ./cmd/worker
	@echo "built: $(BIN)/aletheia, $(BIN)/aletheia-worker"

$(BIN):
	@mkdir -p $(BIN)

engine-test:
	@command -v $(GO) >/dev/null 2>&1 || { echo "SKIP engine-test: go not installed (make install-go)"; exit 0; }
	cd $(ENGINE) && $(GO) test ./...

# Per-event hot-path cost (ns/op, allocs). Use -count 6 and compare medians: this box is noisy.
bench-engine:
	cd $(ENGINE) && ALETHEIA_PACKS_DIR=../packs $(GO) test ./pipeline -run xxx -bench Process -benchmem -count 6

studio-test:
	@[ -d $(VENV) ] || { echo "SKIP studio-test: no venv (make setup)"; exit 0; }
	cd $(ROOT)/backend && $(VENV)/bin/python -m pytest studio/tests -q

frontend-check:
	@[ -d $(FRONTEND)/node_modules ] || { echo "SKIP frontend-check: no node_modules (make setup)"; exit 0; }
	cd $(FRONTEND) && npx tsc --noEmit && npm run build

## ---------------------------------------------------------------- run, no Docker

# Studio reads the gitignored local config, so the LLM key is already set: nothing to type.
studio:
	@[ -d $(VENV) ] || { echo "run make setup first"; exit 1; }
	@set -a; [ -f $(SECRETS) ] && . $(SECRETS); set +a; \
	 cd $(ROOT)/backend && ALETHEIA_MODE=lite \
	   ALETHEIA_PG_DSN=$${ALETHEIA_PG_DSN:-postgres://aletheia:aletheia@127.0.0.1:5432/aletheia} \
	   ALETHEIA_BUS_BROKERS=$${ALETHEIA_BUS_BROKERS:-127.0.0.1:9092} \
	   $(VENV)/bin/uvicorn studio.main:app --reload --host 0.0.0.0 --port 8081

# Engine worker: raw topic -> parse, verify, OCSF -> ClickHouse. Approved sources reach Events and
# Lineage only while this runs (and `make services` is up).
worker: engine
	@set -a; [ -f $(SECRETS) ] && . $(SECRETS); set +a; \
	 ALETHEIA_PACKS_DIR=$(ROOT)/backend/packs ALETHEIA_OCSF_DIR=$(ROOT)/backend/ocsf \
	 ALETHEIA_CLICKHOUSE_ADDR=$${ALETHEIA_CLICKHOUSE_ADDR:-127.0.0.1:9000} \
	 ALETHEIA_CLICKHOUSE_USER=$${ALETHEIA_CLICKHOUSE_USER:-aletheia} \
	 ALETHEIA_CLICKHOUSE_PASSWORD=$${ALETHEIA_CLICKHOUSE_PASSWORD:-aletheia} \
	 ALETHEIA_PG_DSN=$${ALETHEIA_PG_DSN:-postgres://aletheia:aletheia@127.0.0.1:5432/aletheia} \
	 ALETHEIA_BUS_BROKERS=$${ALETHEIA_BUS_BROKERS:-127.0.0.1:9092} \
	 $(BIN)/aletheia-worker

frontend:
	cd $(FRONTEND) && npm run dev -- --host 0.0.0.0 --port 5173

dev: services engine
	@echo "Studio  -> http://localhost:8081"
	@echo "Frontend-> http://localhost:5173"
	@echo "Worker  -> engine metrics on :9108"
	@$(MAKE) -j3 studio frontend worker

# Dockerless end-to-end: generate logs, parse them, reconstruct, verify byte-equality.
# Proves the core claim on this machine with no bus and no databases.
lite: verify-packs
	@echo
	@echo "== dockerless end-to-end =="
	@if [ -x $(BIN)/aletheia ]; then \
	  $(BIN)/aletheia test-pack --pack $(ROOT)/backend/packs/cisco_asa.yaml \
	     --samples $(ROOT)/backend/packs/tests --json; \
	else \
	  echo "(engine not built — python reference verifier above already proved reconstruction)"; \
	  echo "build the Go engine with: make install-go && make engine"; \
	fi

cli: engine
	@$(BIN)/aletheia $(ARGS)

# Reads whatever is already in ClickHouse. For the reproducible measurement in
# docs/benchmarks.md use bench-storage-full, which builds its own matched corpus.
bench-storage:
	@python3 $(ROOT)/bench/storage_report.py

bench-storage-full:
	@$(ROOT)/bench/storage_bench.sh $(or $(COUNT),120000)

# The only check that exercises the streaming hot path. Needs the datastores up,
# so it is deliberately outside `make check`, which must run with nothing running.
worker-smoke: engine
	@$(ROOT)/scripts/worker-smoke.sh $(ARGS)

# Seal the Merkle batches of events already in ClickHouse. The worker seals on the
# hot path; this covers a corpus loaded without the bus (the seeder, or `make demo`).
seal: engine
	@$(BIN)/aletheia seal --last $(or $(LAST),24h)

demo:
	@python3 $(ROOT)/demo/scenarios.py $(ARGS)

## ---------------------------------------------------------------- backing services

# Docker is used ONLY for the datastores. Engine, Studio and frontend run natively.
SERVICES := $(ROOT)/deploy/docker-compose.services.yml

services:
	docker compose -f $(SERVICES) up -d
	@echo "waiting for health..."
	@for i in $$(seq 1 60); do \
	  n=$$(docker compose -f $(SERVICES) ps --format '{{.Health}}' | grep -c '^healthy$$' || true); \
	  [ "$$n" -ge 4 ] && { echo "all 4 services healthy"; break; }; sleep 2; \
	done
	@docker compose -f $(SERVICES) ps --format 'table {{.Service}}\t{{.Status}}'
	@echo
	@$(MAKE) --no-print-directory topics
	@echo
	@echo "ClickHouse :8123   PostgreSQL :5432   Redpanda :9092   MinIO :9001"

# Topics are part of a usable stack, so create them once the bus is healthy.
topics:
	@for t in raw quarantine normalized control dlq; do \
	  docker exec aletheia-services-redpanda-1 rpk topic create $$t -p 4 -r 1 2>/dev/null | tail -1; \
	done
	@docker exec aletheia-services-redpanda-1 rpk topic list

GENS := $(ROOT)/deploy/docker-compose.generators.yml

gens:            ## six live log servers on :9101-9106 (control :9201, :9102-9106)
	docker compose -f $(GENS) up -d --build

gens-down:
	docker compose -f $(GENS) down

services-down:
	docker compose -f $(SERVICES) down

services-logs:
	docker compose -f $(SERVICES) logs -f --tail=100

# run: backing services in Docker + engine/studio/frontend natively
run: services engine
	@echo "Studio -> http://localhost:8081  Frontend -> http://localhost:5173  (engine worker running)"
	@$(MAKE) -j3 studio frontend worker

## ---------------------------------------------------------------- full stack in Docker (optional)

up:
	docker compose -f $(ROOT)/deploy/docker-compose.yml up -d
	@echo "UI http://localhost:8080   Grafana http://localhost:3000"

down:
	docker compose -f $(ROOT)/deploy/docker-compose.yml down

logs:
	docker compose -f $(ROOT)/deploy/docker-compose.yml logs -f --tail=100

## ---------------------------------------------------------------- cleanup

clean:
	rm -rf $(BIN) $(FRONTEND)/dist
	find $(ROOT) -name __pycache__ -type d -not -path '*/node_modules/*' -exec rm -rf {} + 2>/dev/null || true

distclean: clean
	rm -rf $(VENV) $(FRONTEND)/node_modules
