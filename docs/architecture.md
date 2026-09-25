# Aletheia — Architecture

[← Documentation index](README.md) · [Project README](../README.md)

**Universal Lossless Log Pre-processing Framework — SIH PS 26156**
*Normalize everything. Lose nothing. Prove it.*

---

## Page 1 — What it does and how

### Objective

Ingest logs from any perimeter device — firewall, router, IDS/IPS, VPN, proxy, WAF — in any format,
and produce a standard, analytics-ready OCSF event **while preserving every original byte** and
maintaining traceability from any normalized field back to the exact bytes it came from.

### The core insight

A log line is *literal text that repeats on every event of its type* plus *variable values that
change per event*. Separate the two and one representation serves three purposes at once.

```
raw: <166>Sep 19 14:31:02 fw01 %ASA-6-302013: Built outbound TCP connection 1234
     for outside:203.0.113.5/443 (203.0.113.5/443) to inside:10.0.0.5/52144 (198.51.100.7/52144)

template (stored once):  "<" PRI ">" TS " " HOST " %ASA-6-302013: Built " DIR
                         " TCP connection " CONN_ID " for " IF_A ":" IP_A "/" PORT_A …
vars (stored per event): ["166","Sep 19 14:31:02","fw01","outbound","1234","outside",
                          "203.0.113.5","443", …]
```

| From this one parse | |
|---|---|
| **Normalization** | each slot has a meaning → `IP_B` maps to OCSF `src_endpoint.ip` |
| **Compression** | the long literal text is stored once per template, not once per event |
| **Reconstruction** | literals + vars concatenated returns the original line, byte for byte |

The reconstruction is hashed and compared with the SHA-256 taken at arrival. Equal → the event is
*provably* lossless. Not equal → the raw bytes are stored verbatim instead. Either way nothing is lost.

### Main data path — eight stages

```
 Perimeter devices ──syslog UDP/TCP/TLS, files──▶
 [1] COLLECTORS (Vector)            exact bytes; metadata in Kafka headers, never in the value
 [2] INGEST BUS (Redpanda "raw")    replicated to disk BEFORE any parsing — the "raw first" guarantee
 ┌─ WORKER (Go, stateless, horizontally scaled) ──────────────────────────────────┐
 │ [3] EVIDENCE STAMP    deterministic ULID, SHA-256 of raw, Merkle leaf           │
 │ [4] ENVELOPE DECODER  RFC 3164 / RFC 5424 / CEF / LEEF, body type, discriminator │
 │ [5] TEMPLATE MATCHER  index lookup + anchored RE2 ──miss──▶ verbatim + quarantine│
 │ [6] RECONSTRUCT+VERIFY  rebuild, compare hashes ──mismatch──▶ verbatim + dlq     │
 │ [7] OCSF NORMALIZER   typed values, class/activity, mapping, unmapped, status    │
 └────────────────────────────────┬────────────────────────────────────────────────┘
 [8] SINKS   ClickHouse (system of record) · Redpanda "normalized" → Loki / Splunk HEC /
             Kafka consumers / CEF re-emit · periodic Parquet export → MinIO
```

### Studio, observability and alerting

```
 sources (tcp, udp, http stream, websocket, Loki pull, REST cursor, HTTP/Loki push)
        │
        ▼
 STUDIO (FastAPI) ── raw store: every line verbatim ──▶ Loki  {source, severity, format} + sha256
        │           ── forward to Redpanda "raw" once the source is approved
        │           ── onboarding: cluster → template → AI-first mapping → gate → human approval
        │           ── export & supply (JSON/CSV/TSV/XML/syslog/CEF/LEEF, TCP push or listen)
        │           ── Lyra: guarded read-only SQL ──▶ ClickHouse
        │           ── alerting: rules, contact points, policy tree (Postgres alerting_objects)
        │                    │ provisioning API                ▲ webhook /alerting/receive
        ▼                    ▼                                 │
 Redpanda "normalized" ─▶ Vector ─▶ Loki  {vendor, product, source_id, ocsf_class, parse_status}
                                         │
 ClickHouse · Loki · Prometheus ─────────┴──▶ GRAFANA  dashboards + unified alerting
                                                    ──▶ browser / webhook / email / Slack
```

Without Grafana (`make dev`), Studio evaluates the same rules itself (`mode: local`); without
Loki, the raw store falls back to memory. Neither is required for the main data path.

Supporting services: **Merkle sealer** (closes batches, chains roots), **parser registry**
(Git + PostgreSQL, hot reload via the `control` topic), **Onboarding Studio** (Python),
**replay engine**, **verify tool**, **Lyra** (guarded chat assistant, read-only SQL over
ClickHouse), **Loki** (raw-line store and normalized-event log search), **Grafana** (dashboards
and the unified-alerting engine), **Prometheus** (pipeline metrics), **alerting service** (in
Studio: rules, contact points, notification policies, pushed to Grafana), **UI** (product
landing, Overview dashboard, Events explorer, Lyra, Sources & onboarding, Export & Supply,
Alerting, Demo Console, Settings).

### The universal schema

Output is **OCSF** (Open Cybersecurity Schema Framework), pinned to one version for the whole
deployment — an open, vendor-neutral standard rather than an invented one. Classes used for
perimeter devices: Network Activity (4001), HTTP Activity (4002), DNS Activity (4003),
Authentication (3002), Detection Finding (2004).

Three additions make it honest:

- **`unmapped`** — every slot with no mapping is kept under its own name, so vendor-specific
  attributes are never discarded.
- **`parse_status`** — `full` | `partial` | `raw_only`, stated explicitly per event rather than implied.
- **`aletheia`** — a provenance block: `event_uid`, `raw_sha256`, `verified`, `storage_mode`,
  `template_id`, `pack`, `pack_version`, `merkle_batch`.

`storage_mode` (how bytes are kept) and `parse_status` (how well it was understood) are
**independent** — a JSON event can be stored verbatim *and* fully normalized.

---

## Page 2 — Why it can be trusted, and how it scales

### Losslessness and forensics

| Mechanism | Guarantee |
|---|---|
| Raw committed to the bus and hashed **before** parsing | The preserved bytes are exactly what the device sent |
| Deterministic ULID from `(topic, partition, offset)` | Redelivery after a crash yields the same id → idempotent writes |
| Byte-exact reconstruction verified per event | Losslessness is *proven* per event, not asserted once |
| Verbatim fallback on any miss or mismatch | Unparseable and anomalous events are still stored in full |
| Per-minute **Merkle roots, chained** over time | Altering one past event breaks every later link |
| Signed daily anchors held off-system | A hash beside its data can be recomputed by an attacker; an anchor cannot be forged |
| Byte-level **lineage spans**, recomputed on demand | Any OCSF field highlights the exact source bytes in the UI |

Verification is end-to-end, not merely a parsing check: because the regex is fully anchored and
every byte is covered by a literal or a capture group, a successful match reconstructs exactly *by
construction*. The hash comparison therefore guards encoding handling, engine defects and storage
round-trips as well.

### Safe onboarding — why a new source is cheap *and* safe

```
quarantine ─▶ Drain3 cluster ─▶ derive byte-exact template ─▶ type slots ─▶ propose OCSF mapping
                                        (heuristics first; optional AI assistant)
           ─▶ RECONSTRUCTION GATE ─▶ REPLAY DIFF ─▶ human approval ─▶ new pack version ─▶ hot reload
```

The entire onboarding workflow — connecting a source, collecting samples, reviewing proposals,
approving packs — lives on a single **Sources** page (`/dashboard/sources`).

- **Reconstruction gate** — a proposed template is rejected unless it rebuilds **100 %** of its
  sample lines byte-exactly, every slot validates, existing golden tests still pass, and no two
  ambiguous slots are adjacent.
- **Replay diff** — re-runs recent real events through both pack versions and reports precisely what
  would change, flagging any regression (`full` → `partial`/`raw_only`) as blocking. Its SHA-256 is
  stored with the approval.
- **Hot reload** — workers compile the new index in the background and swap an atomic pointer.
  No restart, no downtime, no dropped events.
- **AI-first mapping, rules as the safety net.** With a provider configured, each unique format
  (cluster) gets one LLM request, two in flight at a time; the allow-list of OCSF paths is per
  class. Rules fill slots the AI left unmapped, and replace the AI mapping when the provider is
  off, the call fails, or the AI mapping fails the gate while the rules mapping passes. Each
  cluster records why rules were used. A reviewer's retry feedback goes to the model verbatim.
- **AI is optional and never trusted.** No model weights ship in the image. An operator may point
  Aletheia at a Gemini API key or a self-hosted local model (Ollama, vLLM, llama.cpp, LM Studio);
  suggestions are constrained to an allow-list of OCSF paths, pass the same gate, and **can never
  approve**. No LLM ever touches a live event. Only three providers: `none`, `gemini`, `local`;
  on `gemini` only `gemini-*` models are accepted.

Sources connect by pull (`tcp`, `http_stream`, `websocket`, `loki_pull`, `rest_cursor`), listen
(`udp_listen`), or push (`POST /api/v1/ingest/{id}`, or a Loki-compatible
`/api/v1/ingest/loki/push` so Vector, Fluent Bit or Logstash can point at Aletheia). A source
moves `collecting → review → approved | rejected`; after 100 lines a proposal is generated
automatically. On approval the pack is published on `control` and the source's collected lines
are backfilled onto the bus.

### Lyra — data assistant

- A guarded, tool-using chat assistant at `/dashboard/lyra` that answers ad-hoc questions about
  ingested events by running read-only SQL against ClickHouse.
- The model emits one JSON action per step from a fixed enum (`run_sql`, `list_sources`,
  `list_packs`, `final`); SQL passes a strict allow-list guard (`readonly=1`, allow-listed
  tables/columns/functions, `SELECT *` refused, max 200 rows).
- Chat sessions are persisted, searchable and exportable (PDF, Markdown, JSON, text).
- Uses the configured LLM provider; a separate `llm.chat_model` setting can point it at a
  faster model (default: `gemini-3.5-flash-lite`).

### Observability and alerting (Grafana + Loki)

- **Loki** holds two streams. Studio writes every raw line verbatim, labelled
  `source`/`severity`/`format` with the line's SHA-256 as structured metadata. Vector tails
  `normalized` and writes OCSF JSON labelled `vendor`/`product`/`source_id`/`ocsf_class`/
  `parse_status`. `event_uid`, `template_id` and `merkle_batch` go in structured metadata, never
  labels. Retention is 7 days.
- **Grafana** is provisioned with ClickHouse, Loki and Prometheus datasources and five
  dashboards: `aletheia-overview`, `aletheia-event` (one event: raw line, OCSF, integrity),
  `aletheia-events`, `aletheia-logs`, `aletheia-pipeline`. The UI deep-links into them, and a
  Loki `event_uid` opens the single-event dashboard.
- **Alerting.** Studio stores the rules, contact points and notification policy tree in Postgres
  (`alerting_objects`), then pushes them to Grafana's provisioning API, where they stay editable.
  A rule is one LogQL, PromQL or ClickHouse query reduced to a number and compared with a
  threshold. Contact points: browser (Grafana webhook back to Studio, shown as in-app toasts),
  webhook, email, Slack. First start seeds a `Browser` point, a critical route, and starter
  rules for reconstruction mismatch, format drift, consumer lag and a `raw_only` surge. If
  Grafana is unreachable, Studio's own evaluator runs the same rules.

### Export and log supply

- **Export** downloads raw lines, OCSF events or the system audit trail as JSON, JSONL, CSV,
  TSV, XML, RFC 5424 syslog, CEF, LEEF or the original text. Every file carries its SHA-256 in a
  response header, and every record carries the SHA-256 of its original line. The renderers
  live in `ingest/logformats.py` and are shared with the supply stream. Reports cover the
  Overview snapshot (PDF, HTML, Markdown, CSV, JSON), optionally for one source.
- **Supply stream** feeds a SIEM over TCP: `listen` serves receivers behind an IP allow-list,
  and `push` dials a collector and buffers while it is down. Formats: raw, syslog (RFC 6587
  octet counting), CEF, JSON, tagged, or live OCSF from the bus. A slow receiver drops its own
  backlog and never stalls ingest. The settings persist and are restored at startup.

### Overview dashboard

- Real-time posture score, severity distribution, auto-generated plain-language findings.
- Deep ClickHouse aggregates: top source/destination IPs, port scanners, denied traffic,
  protocol mix, OCSF class distribution, timeline, storage comparison, Merkle batch stats.
- Per-source sparklines, heatmap, trend detection and spike alerts.

### Scale

- Workers are **stateless**; scaling out means adding consumers to the group.
- Partitioned by `source_id`, preserving per-source ordering; hot sources can be salted.
- Per event: one SHA-256 over ~300 bytes, one map lookup, usually one anchored RE2 match, one
  reconstruction, one more SHA-256 — all CPU-bound and allocation-light.
- **RE2 only.** Linear-time matching; a backtracking engine (as grok-based tools use) can be stalled
  by adversarial input, which is a denial-of-service risk in a security pipeline.
- At-least-once delivery + deterministic `event_uid` + `ReplacingMergeTree` ⇒ no loss and duplicates
  collapse. Offsets commit only after a successful insert, so backpressure is safe.
- 1 billion events/day ≈ 11,574 eps average, ≈ 35,000 eps at a 3× peak. Measured throughput and
  scaling curves are in `docs/benchmarks.md` — no unmeasured figures are claimed.

### Deployment

| Mode | Artifact |
|---|---|
| **Evaluation** | one all-in-one image, `docker run`, s6-overlay supervising every service, multi-arch (amd64 + arm64) |
| **Production** | per-component images via Docker Compose; workers scale by replica count; Redpanda and ClickHouse as clusters |

Both build from the same repository and run the same engine binary and parser packs. The
Compose stack adds Loki, Prometheus and Grafana (port 3000) beside the core services.

**Demo seeding.** `make seed` resets the services stack, starts the Cisco ASA (TCP) and web-proxy
(Loki pull) sample generators, writes Gemini as the LLM provider with the key from
`deploy/secrets/aletheia.env` (sealed into Postgres), registers both as sources, and seeds and
syncs the alerting objects. `ARGS=--no-reset` keeps existing data. Studio loads sources at
startup, so start or restart it afterwards (`make dev`). The Demo Console can also start nine
sample servers (ASA, FortiGate, web proxy, VPN, CEF/LEEF WAF, app telemetry, online store,
defense network, LLM cluster), each with a one-click Sources preset.
**Air-gapped:** `docker save` → verify checksum → `docker load`. Nothing is fetched at install or
run time — no packages, no models, no fonts, no update checks; telemetry is disabled in every
bundled component at build time.

### Requirement map

| a | b | c | d | e | f | g | h | i | j | k |
|---|---|---|---|---|---|---|---|---|---|---|
| hash-verified reconstruction + verbatim fallback, never dropped | every variable captured; `unmapped` retains the rest | OCSF, pinned | `event_uid`, `raw_sha256`, pack version, byte-level lineage | packs + Studio + hot reload | one schema across sources | Kafka, HEC, CEF, Loki, Parquet | typed columns, Parquet by class/date | derivation, typing, mapping proposals | `save`/`load`, no run-time fetches | multi-arch image + Compose |

### What Aletheia is not

Not a SIEM — it prepares data for one. Not an "AI log parser" — AI is an optional onboarding helper
whose output must rebuild the original byte for byte. Not a new schema — it adopts OCSF and adds a
small provenance block.

### UI structure

| Path | Page | Purpose |
|---|---|---|
| `/` | Product landing | Introduction, feature highlights, entry point to the dashboard |
| `/dashboard` | Overview | Real-time KPIs, posture gauge, severity distribution, insights, timeline, heatmap |
| `/dashboard/events` | Events explorer | Searchable OCSF event table with lineage modal |
| `/dashboard/lyra` | Lyra | Guarded chat assistant over ClickHouse |
| `/dashboard/sources` | Sources & onboarding | Connect sources, collect samples, review proposals, approve packs |
| `/dashboard/lineage/:eventUid` | Lineage | Byte-level lineage from an OCSF field to its source bytes |
| `/dashboard/export` | Export & Supply | Reports (PDF/JSON/CSV/MD/HTML), log export, live supply stream |
| `/dashboard/alerting/{rules,contact-points,policies}` | Alerting | Alert rules, contact points, notification policy tree (Grafana-backed) |
| `/dashboard/demo` | Demo Console | Guided evaluation scenarios with sample servers |
| `/dashboard/settings` | Settings | LLM provider, air-gap mode, connection test, full data reset |
