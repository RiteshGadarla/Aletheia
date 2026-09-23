# Aletheia

### Universal Lossless Log Pre-processing Framework
**Smart India Hackathon — Problem Statement 26156**

> **Normalize everything. Lose nothing. Prove it.**

Aletheia turns any perimeter-device log — whatever the vendor, format or firmware — into a
standard OCSF event, **without ever losing a byte of the original**, and it can prove that claim
for every single event.

It learns a **template** for each log format and stores each event as *template + the variable
values*. That one representation does three jobs at once:

| | |
|---|---|
| **Normalization** | every variable slot has a meaning, so it maps to an OCSF field |
| **Compression** | the long literal text is stored once per template, not once per event |
| **Reconstruction** | concatenating literals and variables returns the original line, byte for byte |

Every event's reconstruction is checked against a SHA-256 taken at arrival, and those hashes are
sealed into a per-minute **Merkle chain**, so tampering with stored data is detectable after the fact.

---

## 1. What it does, in three lines

1. Receives logs exactly as sent, hashes the raw bytes **before** parsing anything.
2. Matches a compiled template, extracts typed variables, **reconstructs the original and verifies the hash**, then maps to OCSF.
3. Anything that does not match is still stored verbatim and queued for onboarding. Nothing is ever dropped.

```
devices ──▶ Vector ──▶ Redpanda(raw) ──▶ Worker ──▶ ClickHouse / Loki / HEC / CEF
                                            │           evidence stamp → envelope → match
                                            │           → reconstruct+verify → OCSF
                                            └──▶ quarantine ──▶ Onboarding Studio ──▶ gated parser pack
```

Full architecture: [`docs/architecture.md`](docs/architecture.md).
Complete design: [`docs/technical-specification.md`](docs/technical-specification.md).
Frozen interfaces between components: [`docs/CONTRACTS.md`](docs/CONTRACTS.md).

## 2. Requirements

Docker Engine or Docker Desktop. **4+ CPU cores, 8 GB RAM allocated to Docker, 10 GB free disk.**
(Docker Desktop's default memory allocation is often lower than 8 GB — raise it, or the container
will not reach `healthy`.)

## 3. Run it on this machine (no Docker for the app)

Docker is used **only for the four datastores**. The engine, Studio and frontend run natively.

```bash
make setup        # venv, npm install, local LLM config
make doctor       # what is installed, what each target needs
make check        # packs + engine + studio + frontend, with nothing running
make services     # ClickHouse, PostgreSQL, Redpanda in Docker
make run          # services + engine/Studio/frontend natively
```

| | |
|---|---|
| Product landing page | <http://localhost:5173> |
| Dashboard (Overview, Events, Lyra, Sources, Export, Demo, Settings) | <http://localhost:5173/dashboard> |
| Studio API | <http://localhost:8081> |
| Grafana (admin / `aletheia`) | <http://localhost:3000> · logs dashboard `/d/aletheia-logs` |
| ClickHouse | :8123 · PostgreSQL :5432 · Redpanda :9092 · Loki :3100 · Prometheus :9090 |

`make services` also runs a small Vector that ships the `normalized` topic to Loki, so the Grafana
logs dashboard fills as soon as the worker runs. Alerting (rules, contact points, notification
policies) lives in the dashboard's Alerting page; Grafana evaluates, Studio owns the configuration.
See [docs/alerting.md](docs/alerting.md).

Go is not required up front — `make install-go` drops Go 1.23 into `~/.local/go` without root.

### Prove the core claim with no services at all

```bash
make lite
```

Generates nothing, needs nothing running, and re-derives the project's central guarantee: every
golden sample is parsed, reconstructed from its template plus variables, and checked byte for byte.
Two independent implementations — the Go engine and a Python reference verifier — must agree.

```
pack                    tmpl  samples   recon   fail
cisco_asa                  8       11      11      0
fortigate                  3        5       5      0
cef_generic                3        3       3      0
leef_generic               3        3       3      0
pfsense_filterlog          4        4       4      0
openvpn                    2        2       2      0
squid_access               1        1       1      0
suricata_eve               1        1       1      0
TOTAL                     25       30      30      0
```

## 4. Quick start with Docker (evaluator path)

### One image, one command

```bash
docker pull docker.io/ritesh2006/aletheia:1.0.0

docker run -d --name aletheia \
  -p 6156:6156 -p 3000:3000 \
  -p 5514:5514/udp -p 5514:5514/tcp \
  docker.io/ritesh2006/aletheia:1.0.0
```

Wait until `docker ps` shows `healthy` (typically one to two minutes), then open
**<http://localhost:6156>**.

| Port | Service |
|---|---|
| 6156 | Aletheia UI — product landing, Overview dashboard, Events explorer, Lyra chat assistant, Sources & onboarding, Export & Supply, Demo Console, Settings |
| 3000 | Grafana — dashboards over ClickHouse, Loki and Prometheus |
| 5514 UDP/TCP | Syslog input — send your own logs |
| 6514 | Syslog over TLS (optional) |
| 8123 | ClickHouse HTTP, read-only demo user (optional) |

## 5. Guided evaluation

Open the **Demo Console** at <http://localhost:6156/demo> and run the scenarios in order. Each card
states what is being proven and what success looks like, and shows the equivalent CLI command.

| # | Scenario | Proves |
|---|---|---|
| 0 | One-command start | k |
| 1 | Unified output — eight source types, one OCSF table | b, c, f |
| 2 | **Byte lineage** — click `src_endpoint.ip`, the exact source bytes highlight | d, at byte level |
| 3 | **Integrity** — verify passes, tamper one stored byte, verify fails at the exact event | a |
| 4 | Storage economy — live comparison against raw + normalized copies | Economy |
| 5 | Drift and gated onboarding | e, i |
| 5b | Gate rejection — a faulty template is refused at a named byte offset | Safety |
| 5c | AI-assisted proposal (optional) | AI useful, never trusted blindly |
| 6 | Replay diff, approval, hot reload, backfill | Safe plug-and-play |
| 7 | Reach — same events in Loki, Kafka, CEF re-emit | g |
| 8 | Throughput on your own machine | Scalability |
| 9 | Air-gapped operation | j |
| 10 | Bring your own log | "any source" |

## 6. Bring your own log

```bash
logger --server localhost --port 5514 --udp "<your log line>"
# or
echo "<your log line>" | nc -u -w1 localhost 5514
```

A recognised format normalizes immediately. An unknown format is stored verbatim, appears in
quarantine, and can be onboarded in the Studio on the spot.

## 7. CLI

```bash
docker exec aletheia aletheia verify  --source fw01 --last 15m
docker exec aletheia aletheia replay  --source fw01 --from-version 4 --to-version 5 --last 5000
docker exec aletheia aletheia test-pack --pack packs/cisco_asa.yaml --samples packs/tests/
docker exec aletheia aletheia bench   --workers 1,2,4 --duration 60s
```

All accept `--json` and print a single JSON object.

## 8. Air-gapped installation

```bash
# on a connected machine
docker pull docker.io/ritesh2006/aletheia:1.0.0
docker save -o aletheia-1.0.0.tar docker.io/ritesh2006/aletheia:1.0.0
sha256sum aletheia-1.0.0.tar        # compare against the value published below

# transfer via the organization's approved media process

# on the air-gapped machine
sha256sum aletheia-1.0.0.tar
docker load -i aletheia-1.0.0.tar
docker run -d --name aletheia -e ALETHEIA_AIRGAP=true \
  -p 6156:6156 -p 3000:3000 -p 5514:5514/udp -p 5514:5514/tcp \
  docker.io/ritesh2006/aletheia:1.0.0
```

Nothing is downloaded at start or at run time — no packages, no models, no fonts, no update checks.
Helper scripts for multi-image production mode: [`deploy/offline/`](deploy/offline/).

**To prove the air-gap claim:** pull the image, disconnect the machine from all networks (or block
all egress at the host firewall), start the container and run every Demo Console scenario. All must
pass. Do not use `--network none` — it also blocks the published ports you need for the UI.

## 9. Configuration

All state lives under `/data`. Without a mounted volume every `docker run` starts a fresh, identical
demo. Use `-v aletheia-data:/data` to persist across restarts.

| Variable | Default | Effect |
|---|---|---|
| `ALETHEIA_DEMO_AUTOSTART` | `true` | Start demo traffic once healthy |
| `ALETHEIA_DEMO_RATE` | `200` | Demo events per second |
| `ALETHEIA_WORKERS` | `2` | Worker processes in the container |
| `ALETHEIA_ADMIN_PASSWORD` | documented demo value | UI and Grafana admin password |
| `ALETHEIA_AIRGAP` | `false` | `true` refuses all cloud AI providers |
| `ALETHEIA_SECRET` | generated at first start | Key material for secrets stored via the UI |
| `ALETHEIA_SMTP_ENABLED` / `_HOST` / `_USER` / `_PASSWORD` / `_FROM_ADDRESS` | off | Grafana SMTP, for email alert contact points ([docs/alerting.md](docs/alerting.md)) |
| `ALETHEIA_GRAFANA_PUBLIC_URL` | `http://localhost:3000` | Grafana as the browser reaches it, for alert and event deep links |

## 10. Lyra — data assistant

Lyra is a guarded, tool-using chat assistant built into the dashboard at `/dashboard/lyra`.
It answers ad-hoc questions about ingested events, sources and parser packs by running
read-only SQL against ClickHouse.

| | |
|---|---|
| **Guard** | Every SQL query passes a strict allow-list of tables (`events`, `templates`), columns, functions and keywords. `SELECT *` is refused. `readonly=1` and server-side resource caps are enforced. |
| **Tools** | `run_sql`, `list_sources`, `list_packs`, `final` — the model emits one JSON action per step, up to 5 steps per turn. |
| **Provider** | Uses the configured LLM provider (Settings page). A separate `llm.chat_model` setting can point Lyra at a faster model than the onboarding assistant. Default: `gemini-3.5-flash-lite`. |
| **Sessions** | Chat history is persisted and can be exported as PDF, Markdown, JSON or plain text. |
| **Streaming** | Real-time step-by-step execution events via SSE (`POST /api/v1/chat/stream`). |

Lyra requires an AI provider — with `provider=none` it shows a prompt to configure one.
It never writes, deletes or changes settings; every SQL query and its result are audit-logged.

Sinks: ClickHouse (system of record), Grafana Loki, Kafka topic `normalized`, Splunk HEC,
and CEF re-emit over syslog.

## 11. AI assistant (optional)

Aletheia works **fully without any AI.** The Onboarding Studio always runs its heuristics first.
An AI model is an optional second opinion during onboarding only — **it never touches a live event**,
and any suggestion it makes must still pass the byte-exact reconstruction gate, the replay diff and
human approval. The image ships **no model weights and no inference runtime**.

Three modes:

| Mode | You provide | Data leaves the machine? | Air-gap |
|---|---|---|---|
| **None** (default) | nothing | no | yes |
| **Local** | a URL of a model server you run (Ollama, vLLM, llama.cpp, LM Studio) | only to that server | yes, if the address is private |
| **Cloud** | a Gemini API key | masked samples only | no |

### Configuring it from the UI (recommended)

**No key is baked into the image.** Start the container, open
**Settings** at <http://localhost:6156/dashboard/settings>, pick a provider, enter the model and key, and press
**Test connection**. Settings are stored encrypted (AES-GCM) in PostgreSQL and take effect
immediately — no restart. The UI only ever displays the last four characters of a stored key.

### Configuring it by environment instead

```bash
cp deploy/secrets/aletheia.env.example deploy/secrets/aletheia.env
# edit it, then:
docker run -d --name aletheia --env-file deploy/secrets/aletheia.env \
  -p 6156:6156 -p 3000:3000 -p 5514:5514/udp -p 5514:5514/tcp \
  docker.io/ritesh2006/aletheia:1.0.0
```

A mounted secret file is preferred over `-e`, which leaves the key visible in `docker inspect`:

```bash
-v ./llm.key:/run/secrets/llm_key:ro -e ALETHEIA_LLM_API_KEY_FILE=/run/secrets/llm_key
```

Precedence is **UI setting > environment variable > default**.

### Tested at release

| Provider | Model | Notes |
|---|---|---|
| `gemini` | **`gemini-3.5-flash-lite`** (default) | Fast, reliable cloud model used for both onboarding proposals and Lyra. `gemma-4-31b-it` is also supported but slower (~34-50 s/call) and less reliable (~50% success rate on free tier). |
| `local` | any instruction-following model, e.g. `qwen2.5-coder:7b` | Ollama, vLLM, llama.cpp or LM Studio — they share one API, so the base URL is what picks the server. Air-gap friendly; a 4-bit 7–8B model runs on CPU in ~5–8 GB RAM. |

Provider quirks we measured and handle (retries, thinking-part filtering, JSON-schema mode) are
documented in [`docs/llm-provider-notes.md`](docs/llm-provider-notes.md).

### What is sent

Controlled by `ALETHEIA_LLM_SEND_SAMPLES`: `masked` (default for cloud) replaces sample values with
consistent, format-preserving placeholders — an IPv4 stays an IPv4, so the model can still infer the
slot's meaning; `none` sends only the template and slot types; `raw` sends real values and is
**refused for cloud providers**. One request per cluster during onboarding, never per event.

Running a local model with Ollama:

```bash
ollama pull qwen2.5-coder:7b
OLLAMA_HOST=0.0.0.0 ollama serve          # Linux only

docker run -d --name aletheia \
  --add-host=host.docker.internal:host-gateway \
  -e ALETHEIA_LLM_PROVIDER=local -e ALETHEIA_LLM_MODEL=qwen2.5-coder:7b \
  -p 6156:6156 -p 3000:3000 -p 5514:5514/udp -p 5514:5514/tcp \
  docker.io/ritesh2006/aletheia:1.0.0
```

## 12. Production mode and building from source

```bash
docker compose -f deploy/docker-compose.yml up -d      # multi-image, workers scale by replicas
./docker/build.sh                                      # buildx, linux/amd64 + linux/arm64
```

Repository layout is described in [`docs/technical-specification.md`](docs/technical-specification.md) §20.

```
backend/engine    Go — the deterministic hot path and the CLI
backend/studio    Python FastAPI — clustering, derivation, gate, replay diff, LLM adapters
  studio/chat     Lyra chat agent, SQL guard, session store
  studio/api      REST endpoints: chat, stats, sources, samples, export, settings
backend/packs     parser packs + golden tests
backend/ocsf      pinned OCSF subset and validator
frontend          React + Vite + TypeScript
  pages           HomePage (landing), OverviewPage (dashboard), EventsPage, LyraPage,
                  SourcesPage (unified onboarding), ExportPage, DemoPage, SettingsPage
  components      Layout, Insights (posture gauge, donut, ranked bars, timeline, findings),
                  LineageModal, Icons, Bits
deploy            compose, Vector, Redpanda, ClickHouse, Postgres, Grafana, Prometheus, offline
docker            all-in-one evaluation image (s6-overlay) and per-component images
sources           seeded log generators and corpora
bench             benchmark harness (spec §17 methodology)
```

## 13. Image details

| | |
|---|---|
| Tag | `docker.io/ritesh2006/aletheia:1.0.0` |
| Digest | *published at release* |
| Architectures | `linux/amd64`, `linux/arm64` |
| Size | *measured at release* |
| Source commit | *recorded at release* |

Pinned upstream component versions are listed in [`docker/allinone/Dockerfile`](docker/allinone/Dockerfile).

## 14. Benchmarks and limitations

Measured results with machine specifications: [`docs/benchmarks.md`](docs/benchmarks.md).
Every figure there is measured by the harness in [`bench/`](bench/) — no estimated numbers.

Honest scope and known limitations are in
[`docs/technical-specification.md`](docs/technical-specification.md) §25. The main ones:

- JSON and XML are fully parsed and normalized but stored **verbatim** by default; the compression
  benefit applies mainly to syslog, CEF, LEEF, KV and CSV text formats.
- **Reconstruction proves no loss, not correct meaning.** A template can rebuild perfectly while a
  mapping points at the wrong OCSF field — that is what golden tests, replay diff and human review
  are for, not hashing.
- Merkle integrity proves stored data has not changed since sealing. It cannot prove a device sent
  truthful logs.
- Proprietary vendor formats in the prototype are generated from published vendor documentation,
  not captured from real devices.
- UDP syslog can lose packets on the network before they reach Aletheia; prefer TCP or TLS.

## 15. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Container never becomes `healthy` | Almost always memory. Give Docker 8 GB. Check `docker logs aletheia`. |
| Port already in use | Change the host side of the mapping, e.g. `-p 16156:6156`. |
| Apple Silicon warnings | The image is multi-arch; make sure you pulled the `arm64` variant. |
| Container cannot reach Ollama on Linux | Needs `--add-host=host.docker.internal:host-gateway`, and Ollama must listen beyond `127.0.0.1` (`OLLAMA_HOST=0.0.0.0`). Restrict with the host firewall. |
| "AI suggestion unavailable" | Expected fallback. Heuristic proposals still work. Check Settings → Test connection. |
| Alerts fire in Grafana but never reach the browser (`make run`) | Grafana cannot reach Studio on the host. See [docs/alerting.md](docs/alerting.md#troubleshooting) (usually the host firewall). |

---

## Requirement traceability

| Req | Met by |
|---|---|
| a. Preserve raw without loss | Raw committed to the bus and hashed before parsing; stored as verified template or verbatim; never dropped; `verify` tool |
| b. Extract source attributes | Templates capture every variable; unmapped slots kept in `unmapped` |
| c. Normalize to a taxonomy | OCSF, pinned version |
| d. Traceability | `event_uid`, `raw_sha256`, pack version, **byte-level lineage** |
| e. Plug-and-play onboarding | Parser packs, Onboarding Studio, hot reload with no restart |
| f. Unified visibility | One schema across all sources in ClickHouse, Grafana and Loki |
| g. SIEM / data lake integration | Kafka topic `normalized`, Splunk HEC, CEF re-emit over syslog, Loki |
| h. AI/ML ready | Typed OCSF columns in ClickHouse, queryable over HTTP on :8123 |
| i. Reduced parser effort | Automatic template derivation, slot typing, mapping proposals |
| j. Air-gapped | `docker save`/`docker load`, nothing fetched at run time, telemetry off, AI optional |
| k. Containerized | All-in-one image (amd64 + arm64); per-component images with Compose or Helm |

## License

See [`LICENSE`](LICENSE).
