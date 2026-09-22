# Aletheia — Shared Contracts (frozen)

Every component codes against this file. **Do not change anything here without saying so loudly
in your final report** — other components are being built in parallel against it.

Source of truth for intent: `personal/Aletheia_Technical_Specification.md` (read your own sections).

---

## 0. Module / package identity

- Go module: `github.com/Ritesh2006M/aletheia` (dir `backend/engine`, Go 1.23)
- Python package root: `backend/studio` (Python 3.12, FastAPI)
- UI: `frontend/` (React 18 + Vite + TypeScript)

## 1. Template token model (backend/engine/template)

A template is an ordered list of tokens. JSON/YAML shape:

```json
{"lit": "<"}
{"slot": "pri", "type": "int"}
{"slot": "direction", "type": "enum", "values": ["inbound","outbound"]}
{"slot": "msg", "type": "custom", "pattern": "[A-Z]+"}
```

Go:

```go
type Token struct {
    Lit     string   `json:"lit,omitempty"     yaml:"lit,omitempty"`
    Slot    string   `json:"slot,omitempty"    yaml:"slot,omitempty"`
    Type    string   `json:"type,omitempty"    yaml:"type,omitempty"`
    Values  []string `json:"values,omitempty"  yaml:"values,omitempty"`
    Pattern string   `json:"pattern,omitempty" yaml:"pattern,omitempty"`
}
func (t Token) IsLit() bool { return t.Slot == "" }
```

**Slot types** (exact strings). Compiler emits these RE2 sub-patterns:

| type | pattern |
|---|---|
| `int` | `\d+` |
| `port` | `\d{1,5}` |
| `ipv4` | `(?:\d{1,3}\.){3}\d{1,3}` |
| `ipv6` | `[0-9A-Fa-f:]{2,45}` |
| `ip` | ipv4 \| ipv6 alternation |
| `mac` | `(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}` |
| `hostname` | `[A-Za-z0-9._-]+` |
| `syslog3164_ts` | `[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}` |
| `iso8601_ts` | `\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z\|[+-]\d{2}:?\d{2})?` |
| `epoch_ts` | `\d{9,10}(?:\.\d+)?` |
| `enum` | alternation of `QuoteMeta(values)`, longest first |
| `word` | `\S+` |
| `quoted` | `"(?:[^"\\]\|\\.)*"` |
| `ws` | `[ \t]+` (whitespace run, keeps Squid alignment byte-exact) |
| `text` | `.*?` — **only** legal if followed by a literal or last token |
| `custom` | `pattern` field verbatim |

**Compile rule:** `^` + for each token (`QuoteMeta(lit)` | `(` + pattern + `)`) + `$`.
Every slot is exactly one capture group, in order. RE2 only (Go `regexp`), never backtracking.

**Validation rule (compiler must enforce):** two adjacent slots are rejected unless both are
fixed-width types. Reject `text` that is followed by a **slot**; `text` followed by a literal, or
as the **last** token, is legal — every envelope in `_envelopes.yaml` ends in
`{slot: body, type: text}`, and a trailing lazy `.*?` under the `$` anchor is unambiguous in RE2.

**Reconstruct:** concatenate `lit` bytes and `vars[i]` in token order. Must be byte-identical.

**Lineage spans:** walk tokens, `offset += len(lit)`; for a slot record `[offset, offset+len(v))`.
Never stored — recomputed on demand.

## 2. Parser pack YAML (packs/*.yaml)

Exactly as spec §7.3. Canonical skeleton:

```yaml
pack: cisco_asa
version: 1
applies_to: {vendor: Cisco, product: ASA}
envelopes: [rfc3164_std, rfc3164_nohost]
templates:
  - id: asa_302013
    discriminator: "%ASA-6-302013"
    body: [ {lit: "..."}, {slot: x, type: ip} ]
    ocsf:
      class_uid: 4001
      activity_id: 1
      constants: {connection_info.protocol_name: tcp}
      map: {conn_id: connection_info.uid}
      conditional:
        - when: {direction: outbound}
          map: {ip_b: src_endpoint.ip, direction: {path: connection_info.direction_id, enum: {outbound: 2}}}
      unmapped_keep: [mip_a, mport_a]
    tests: {samples: "tests/asa_302013/*.log", expected: "tests/asa_302013/*.json"}
```

- `map` value is either a **string** (OCSF path) or an **object**
  `{path: <str>, enum: {<raw>: <int>}, transform: to_int|to_ip|lowercase|ts_parse}`.
- Envelope templates live in `backend/packs/_envelopes.yaml` under key `envelopes: {id: [tokens]}`.
  The full raw line = envelope tokens with the `body` slot substituted by the body template's
  tokens, so reconstruction covers the **entire** raw event including the syslog header.

## 3. Bus contract (Redpanda / Kafka)

Topics: `raw`, `quarantine`, `normalized`, `control`, `dlq`. Key = `source_id`.

`raw` message: **value = exact raw bytes, no wrapper**. Metadata in Kafka headers:

| header | content |
|---|---|
| `pr_recv_ms` | receive time, epoch ms, ASCII decimal |
| `pr_peer` | `ip:port` of sender |
| `pr_listener` | e.g. `udp:5514` |

## 4. Identity & integrity (backend/engine/stamp, backend/engine/merkle)

```
event_uid = Crockford-base32( uint48(recv_ms) || first80bits(sha256(topic|partition|offset)) )  → 26 chars
raw_sha256 = sha256(raw bytes)
merkle batch key = (source_id, partition, floor(recv_ms → minute))
leaf   = sha256(0x00 || raw_sha256)          # domain separation
node   = sha256(0x01 || left || right)       # odd node paired with itself
root   = tree over leaves ordered by event_uid
chained_root_n = sha256(chained_root_(n-1) || root_n || KEY)
   where KEY is the batch key's canonical string form, exactly as below —
   any reimplementation must use this serialization or chains will not match
```

`merkle_batch` string form: `<source_id>/p<partition>/<RFC3339 minute>` e.g. `fw01/p3/2026-09-19T14:31Z`.

## 5. Normalized event JSON (backend/engine/normalize → topic `normalized`, and UI)

OCSF 1.x object plus an `aletheia` provenance block. Full example in spec §7.4. Required invariants:

- `type_uid = class_uid * 100 + activity_id`
- `category_uid`: 4001/4002/4003 → 4, 3002 → 3, 2004 → 2
- `time`: epoch **milliseconds** (int)
- `metadata.original_time`: the original timestamp **string** as it appeared
- `unmapped`: object, slot name → exact raw substring (string values only)
- `aletheia`: `{event_uid, source_id, parse_status, storage_mode, template_id, pack,
  pack_version, raw_sha256 (hex), verified (bool), merkle_batch}`

Enums: `parse_status` ∈ `full|partial|raw_only`; `storage_mode` ∈ `template|verbatim`.

Severity: syslog `PRI mod 8` → OCSF `severity_id` via
`{0:6,1:6,2:5,3:4,4:3,5:2,6:1,7:1}` unless the pack overrides.

Canonical action enum table (`backend/ocsf/enums.yaml`, shared by engine + studio):
allow/accept/permit/pass/allowed → `action_id: 1` (Allowed);
deny/drop/block/reject/denied → `action_id: 2` (Denied).

## 6. ClickHouse schema

Frozen in `deploy/clickhouse/init.sql`, exactly spec §7.5 (`templates`, `events`,
`baseline_events`). Engine sink and Studio replay both read/write it. Column order and names
are fixed; do not rename.

## 7. PostgreSQL schema

Frozen in `deploy/postgres/init.sql`: `sources`, `packs`, `merkle_batches`, `anchors`,
`audit_log`, plus `settings` (see §9).

`backend/packs/_sources.yaml` is the file-driven mirror of the `sources` table, for a run with
no PostgreSQL. An unregistered source still works — it resolves to a synthetic UTC entry — but
it reaches only the wildcard matcher scope, and RFC3164 syslog carries no year or offset, so an
undeclared timezone silently reconstructs to the wrong absolute time.

## 8. Studio ↔ Engine boundary

The Studio never re-implements matching. It shells out to the engine CLI:

```
aletheia test-pack --pack <file.yaml> --samples <dir>  --json     # reconstruction gate
aletheia replay --source <id> --from-version A --to-version B --last N --json
aletheia verify --source <id> --last 15m --json
aletheia seal   --source <id> --last 24h --json                   # merkle batches for stored events
aletheia bench  --workers 1,2,4 --duration 60s --json
```

`seal` exists because the worker seals on the hot path only. A corpus loaded without the bus
(the seeder, or `make demo`) has rows but no batches, so `verify` would report `chain_ok:false`
for want of anything to check. Sealing is idempotent: the batch key is
`(source_id, partition, minute)`, so re-running over a window rebuilds the same roots.

All four print a single JSON object to stdout and exit non-zero on failure.
`test-pack` JSON: `{"ok":bool,"samples":n,"reconstructed":n,"failures":[{"sample","reason","offset"}]}`.

## 9. LLM provider config — **runtime configurable, not baked in**

Precedence: **PostgreSQL `settings` table (set via UI) > environment variable > default.**
This matters: the Docker image ships with no key, and the operator sets provider/model/key on the
Studio Settings page after the container is running.

`settings` table: `(key TEXT PRIMARY KEY, value TEXT, encrypted BOOL, updated_at TIMESTAMPTZ)`.
Values with `encrypted=true` are AES-GCM sealed with a key derived (HKDF-SHA256) from
`ALETHEIA_SECRET`. The API **never** returns a key — only `last4`.

Env defaults: `ALETHEIA_LLM_PROVIDER|_MODEL|_BASE_URL|_API_KEY|_API_KEY_FILE|_SEND_SAMPLES`,
`ALETHEIA_AIRGAP`, `ALETHEIA_SECRET`.

### Supported providers — exactly three

| provider | what it is | base URL | key |
|---|---|---|---|
| `none` | heuristics only; always works, air-gap safe | — | no |
| `gemini` | the **only** cloud option | `https://generativelanguage.googleapis.com/v1beta` | yes |
| `local` | any local OpenAI-compatible server: Ollama, vLLM, llama.cpp, LM Studio | `http://localhost:11434/v1` (Ollama's port) | no |

OpenAI, Groq and Anthropic were removed from the product. `ollama` is still accepted as a legacy
alias for `local`, but must not appear in the UI — Ollama *is* local, so a separate entry is
redundant; the base URL is what distinguishes one local server from another.

### Default provider for this deployment
`provider=gemini`, `model=gemini-3.5-flash-lite` (fast, reliable cloud model).
`gemma-4-31b-it` is also supported for onboarding proposals but is slower and less reliable
(see `docs/llm-provider-notes.md`).

Lyra (the chat assistant) uses `llm.chat_model` if set, otherwise the main `llm.model`.
Default: the same `gemini-3.5-flash-lite`. `gemma-4-31b-it` is too slow (~34-50 s/call) and
too unreliable (~50% failure rate) for a chat agent that makes several sequential calls per turn.

**Gemma-specific facts that the adapter must honour** (measured, not assumed):
1. `gemma-4-31b-it` **rejects `systemInstruction`** (HTTP 500). Fold the system prompt into the
   first user message.
2. It is a **thinking model**: the native endpoint returns extra parts flagged `"thought": true`.
   Concatenate only parts **without** the thought flag. (The OpenAI-compat endpoint inlines
   `<thought>…</thought>` into the content string instead — which is why we use the **native**
   `generateContent` endpoint for `provider=gemini`.)
3. `generationConfig.responseMimeType="application/json"` + `responseSchema` **works** and is the
   preferred structured-output mode.
4. The endpoint returns **intermittent HTTP 500** — retry with exponential backoff (3 attempts)
   before declaring failure.

Adapter interface (all providers):

```python
class Provider(Protocol):
    def complete_json(self, system_prompt: str, user_prompt: str, schema: dict) -> dict: ...
    def test_connection(self) -> ConnTest: ...   # {ok, latency_ms, json_mode, models[], error}
```

Implementations: `GeminiProvider` (native endpoint, default) and `OpenAICompatibleProvider`
(every local server), plus `NoneProvider`.

## 10. Non-negotiable invariants

1. Raw bytes are hashed **before** any parsing, and never mutated.
2. Nothing is ever dropped. No match → `verbatim` + `raw_only` + quarantine. Never an exception path.
3. No LLM call on the hot path, ever. AI is onboarding-only, one request per **cluster**.
4. A proposed pack is rejected unless it reconstructs **100%** of samples byte-exactly.
5. No outbound network calls except to an operator-configured LLM endpoint.
6. `vars` hold **exact substrings**; typed values are derived, never replacing them.

## 11. Lyra chat agent contract

Lyra is a guarded, tool-using chat assistant (`backend/studio/chat/`). It answers ad-hoc
questions about ingested events by running read-only SQL against ClickHouse.

### Action schema

The model emits one JSON action per step:

```json
{"action": "run_sql", "sql": "SELECT ..."}
{"action": "list_sources"}
{"action": "list_packs"}
{"action": "final", "answer": "Here is what I found..."}
```

Up to **5 steps** per turn, **20 messages** of history context.

### SQL guardrail (`backend/studio/chat/guard.py`)

| Rule | Detail |
|---|---|
| Statement type | Only `SELECT` or `WITH ... SELECT` |
| Tables | `events`, `templates` only |
| Columns | Allow-listed: `event_uid`, `recv_time`, `event_time`, `source_id`, `template_id`, `pack_version`, `storage_mode`, `parse_status`, `class_uid`, `activity_id`, `severity_id`, `src_ip`, `src_port`, `dst_ip`, `dst_port`, `protocol`, `action_id`, `user_name`, `pack`, `created_at`, `envelope_id` |
| Functions | Allow-listed: `count`, `sum`, `avg`, `min`, `max`, `uniq`, `uniqexact`, `countif`, `sumif`, `tostring`, `tostartofminute`, `tostartofhour`, `now`, `today`, `replaceone`, `datediff`, `quantile`, etc. |
| Forbidden | `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `SET`, `INTO`, `FORMAT`, `SYSTEM`, `KILL`, etc. |
| `SELECT *` | Refused (raw payloads are off limits) |
| Max query length | 2000 chars |
| Max result rows | 200 (`MAX_LIMIT`) |
| Comments | Forbidden (`--`, `/*`, `#`) |
| Semicolons | Only one statement |
| Quoted identifiers | Forbidden (backticks, double quotes) |

Server-side enforcement: `readonly=1`, `max_execution_time=10`, `max_result_rows=200`,
`max_memory_usage=500MB`, `max_rows_to_read=200M`.

### Chat session persistence (`backend/studio/chat/store.py`)

Sessions are stored in a JSON file (`.chat_sessions.json`). Each session has:
`id` (UUID), `title` (auto-generated or user-set), `created_at`, `updated_at`,
`messages` (array of `{role, content, blocks?}`).

### Chat API endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/chat` | Synchronous chat turn |
| `POST` | `/api/v1/chat/stream` | SSE streaming (step events + final result) |
| `GET` | `/api/v1/chat/sessions` | List all sessions |
| `GET` | `/api/v1/chat/sessions/{id}` | Get full session with messages |
| `PATCH` | `/api/v1/chat/sessions/{id}` | Rename session |
| `DELETE` | `/api/v1/chat/sessions/{id}` | Delete session |
| `DELETE` | `/api/v1/chat/sessions` | Clear all sessions |
| `GET` | `/api/v1/chat/export` | Export session (PDF/Markdown/JSON/text) |

### SSE stream events

```
data: {"type": "step", "step": "Querying ClickHouse telemetry data store…"}
data: {"type": "done", "available": true, "answer": "...", "blocks": [...], "session_id": "..."}
```

## 12. Stats / Overview API contract

`GET /api/v1/stats/overview` returns a single JSON object with:

| Key | Content |
|---|---|
| `kpis` | `lines`, `bytes`, `eps`, `sources`, `connected`, `in_review`, `approved`, `rejected`, `risk_pct`, `errors`, `buffered`, `forwarded`, `packs` |
| `insights` | Derived analytics: `posture` (0-100), `peak_eps`, `mean_eps`, `z` (z-score), `spike` (bool), `noisiest`, `risk_rank`, `stale`, `trend_pct`, `onboarded_pct`, `health_pct`, `error_rate`, `bytes_per_line` |
| `insights.ch` | Deep ClickHouse aggregates: `top_src`, `top_dst`, `top_ports`, `top_users`, `top_templates`, `top_denied`, `scanners`, `fanout`, `protocols`, `actions`, `classes`, `ocsf_sev`, `modes`, `timeline`, `hours`, `lag`, `unique`, `disk` |
| `by_severity` | `{info, notice, warn, risk}` counts |
| `series` | 5-second-bucket sparkline over the last 5 minutes |
| `sources` | Per-source stats with sparklines |
| `normalized` | ClickHouse parse-status breakdown: `total`, `full`, `partial`, `raw_only`, `templates`, `normalized_pct` |
| `history` | Recent approval/rejection activity |
