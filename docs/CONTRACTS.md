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
`audit_log`, plus `settings` (see §9) and `alerting_objects` (see §13).

`alerting_objects`: `(kind TEXT, id TEXT, doc JSONB, updated_at TIMESTAMPTZ)`, `kind` ∈
`rule|contact_point|policy`. Studio keeps a write-through cache over it (`alerting/store.py`)
and also creates it on first use if `init.sql` predates it.

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

Settings keys (`core/settings.py` `SPEC`), each with its env default:

| key | env | default |
|---|---|---|
| `llm.provider` | `ALETHEIA_LLM_PROVIDER` | `gemini` |
| `llm.model` | `ALETHEIA_LLM_MODEL` | `gemini-3.5-flash-lite` |
| `llm.chat_model` | `ALETHEIA_LLM_CHAT_MODEL` | `""` (Lyra uses `llm.model`) |
| `llm.base_url` | `ALETHEIA_LLM_BASE_URL` | per provider (table below) |
| `llm.api_key` | — (encrypted; settings table only) | `""` |
| `llm.send_samples` | `ALETHEIA_LLM_SEND_SAMPLES` | `masked` (`masked\|none\|raw`) |
| `llm.timeout_s` / `llm.max_output_tokens` / `llm.requests_per_hour` | `ALETHEIA_LLM_TIMEOUT_S` / `_MAX_OUTPUT_TOKENS` / `_REQUESTS_PER_HOUR` | `120` / `8192` / `60` |
| `airgap` | `ALETHEIA_AIRGAP` | `false` |
| `engine.bin` | `ALETHEIA_ENGINE_BIN` | `aletheia` |
| `bus.brokers` | `ALETHEIA_BUS_BROKERS` | `""` (no bus: raw forwarding and `ocsf` supply off) |
| `supply.enabled\|host\|port\|format\|allow\|mode\|target` | `ALETHEIA_SUPPLY_*` | `false`, `127.0.0.1`, `9099`, `raw`, `""`, `listen`, `""` |
| `supply.source_id` | — | `""` |

`ALETHEIA_SECRET` is the sealing key. **The LLM API key has no env path in Studio:** `llm.api_key`
maps to no variable and `_key_from_file()` (`ALETHEIA_LLM_API_KEY_FILE`) is defined but never
called, so the key must be saved from the Settings page, or by `make seed`, which reads
`ALETHEIA_LLM_API_KEY` from `deploy/secrets/aletheia.env` and writes it sealed into the table.
The compose files and `aletheia.env.example` still pass both variables; Studio ignores them.

Settings endpoints (prefix `/api/v1`):

| Method & path | Body → Response |
|---|---|
| `GET /settings/llm` | → `{provider, model, base_url, send_samples, api_key_last4, api_key_set, airgap, sources, usage: {requests, tokens, window: "hour", cap_per_hour}, updated_at}` (`sources`: key → `db\|env\|default`) |
| `PUT /settings/llm` | `{provider, model?, base_url?, send_samples?, api_key?}` → same shape. `api_key` omitted keeps it, `""` clears it. Non-`gemini-*` model on `gemini` → 422 |
| `POST /settings/llm/test` | → `ConnTest`; provider not configured or blocked by air-gap → 400 |
| `POST /settings/airgap` | `{airgap: bool}` → settings shape |
| `POST /settings/reset` | Wipes sources, raw store, proposals, approvals, Studio packs, ClickHouse `events`/`baseline_events`/`templates`, supply settings and Lyra sessions; keeps LLM config and air-gap → settings shape |

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
`provider=gemini`, `model=gemini-3.5-flash-lite` (fast, reliable cloud model). **Only `gemini-*`
models are supported** on this provider: saving another model is rejected (HTTP 422), a stale
non-Gemini value from env or the settings table falls back to the default, and model lists only
show `gemini-*`.

Lyra (the chat assistant) uses `llm.chat_model` if set (Gemini only), otherwise the main
`llm.model`.

**Gemini adapter behaviour** (measured, not assumed):
1. `system_instruction` works on `gemini-*` models.
2. `response_mime_type="application/json"` + `response_schema` is the structured-output mode.
   Replies are still parsed tolerantly (a code fence or trailing prose is stripped).
3. `gemini-3*` take `thinking_level`, `gemini-2*` take `thinking_budget=0`.
4. 5xx and timeouts retry with exponential backoff; **429 waits for the server's `retryDelay`**
   (or 20/40/60 s), because free-tier limits are per-minute windows.

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

Sessions are stored in a JSON file (`.chat_sessions.json` in Studio's working directory). Each session has:
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
| `GET` | `/api/v1/chat/export?session_id=&format=` | Export session; `format` ∈ `pdf` (default), `markdown`, `json`, `text`; empty `session_id` = latest; none → 404 |

Request body for both chat endpoints:

```json
{"messages": [{"role": "user", "content": "≤4000 chars", "blocks": []}],
 "session_id": "optional, append to this session", "title": "optional"}
```

At most 40 messages. Only `user`/`assistant` roles reach the model. `POST /chat` returns
`{available, answer, blocks, session_id, session_title}`; `blocks` holds result tables
(`{"type": "table", "rows": [...]}`, max 200 rows). With `provider=none` both answer
`available: false`; `/chat` still saves the turn, `/chat/stream` saves only when `available`. List returns `{sessions: [...]}`; delete returns
`{ok: true, deleted}`; clear returns `{ok: true}`.

### SSE stream events

```
data: {"type": "step", "step": "Querying ClickHouse telemetry data store…"}
data: {"type": "done", "available": true, "answer": "...", "blocks": [...], "session_id": "...", "session_title": "..."}
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
| `generated_at`, `window_s`, `bucket_s` | Snapshot time (epoch s), 300 s window, 5 s buckets |
| `store`, `bus` | Raw store kind (`loki\|memory`); whether a Redpanda bus is configured |

## 13. Alerting API contract (Grafana-backed)

Grafana unified alerting is the engine. Studio is the store of truth for alert rules, contact
points and the notification policy tree, and pushes them to Grafana's provisioning API
(`X-Disable-Provenance: true`, so they stay editable in Grafana too). Grafana alerting objects
are **not** file-provisioned: Studio owns them. When Grafana is not configured or unreachable,
Studio's own evaluator runs the same rules (`mode: "local"`), so the feature works on `make dev`.

### 13.1 Environment

| Variable | Default | Meaning |
|---|---|---|
| `ALETHEIA_GRAFANA_URL` | unset → local mode | Grafana base URL as Studio reaches it (`http://grafana:3000`, `http://127.0.0.1:3000`) |
| `ALETHEIA_GRAFANA_PUBLIC_URL` | `ALETHEIA_GRAFANA_URL` or `http://localhost:3000` | Grafana URL as the browser reaches it (deep links) |
| `ALETHEIA_GRAFANA_TOKEN` | unset | Service-account token; else basic auth below |
| `ALETHEIA_GRAFANA_USER` / `ALETHEIA_GRAFANA_PASSWORD` | `admin` / `aletheia` | Basic auth fallback |
| `ALETHEIA_ALERT_RECEIVER_URL` | `http://host.docker.internal:8081` | Studio base URL as **Grafana** reaches it, for the browser webhook |
| `ALETHEIA_LOKI_URL` | unset | Loki base URL; raw store (only if `/ready` answers) and `loki` rule queries |
| `ALETHEIA_LOKI_TENANT` | unset | Sent as `X-Scope-OrgID` by the raw store and the local evaluator |
| `ALETHEIA_PROMETHEUS_URL` | unset | Prometheus base URL for `prometheus` rule queries in local mode |

### 13.2 Objects

Server-owned fields (never accepted on create/update): `id`, `created_at`, `updated_at`, `sync`,
`state`, `last_value`, `last_eval`, `builtin`, `secure_fields`. Times are ISO-8601 UTC strings.

```ts
type Sync = { state: 'synced' | 'pending' | 'error' | 'local'; error?: string; at?: string };

interface AlertRule {
  id: string;                       // also the Grafana rule uid
  name: string;                     // unique
  group: string;                    // default "aletheia"; Grafana rule group in folder "Aletheia"
  datasource: 'loki' | 'prometheus' | 'clickhouse';
  query: string;                    // LogQL metric query / PromQL / ClickHouse SQL returning one number
  reducer: 'last' | 'mean' | 'max' | 'min' | 'sum' | 'count';           // default "last"
  condition: { op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne'; threshold: number };
  for: string;                      // pending period, Go duration: "0s", "2m"
  interval: string;                 // evaluation interval, default "1m"
  severity: 'critical' | 'warning' | 'info';                          // also sent as label severity
  labels: Record<string, string>;
  summary: string;                  // annotation; may use {{ $labels.x }} / {{ $values }}
  description: string;
  enabled: boolean;                 // false = paused
  no_data_state: 'OK' | 'NoData' | 'Alerting';                        // default "OK"
  created_at: string; updated_at: string; sync: Sync;
  state: 'normal' | 'pending' | 'firing' | 'nodata' | 'error' | 'paused';
  last_value: number | null; last_eval: string | null; last_error?: string;
}

interface ContactPoint {
  id: string;
  name: string;                     // unique; also the Grafana receiver name
  type: 'browser' | 'webhook' | 'email' | 'slack';
  settings: Record<string, unknown>;
  //  browser: {}                                  -> Grafana webhook to Studio /alerting/receive
  //  webhook: { url: string; http_method?: 'POST' | 'PUT' }
  //  email:   { addresses: string; single_email?: boolean }   // ';' or ',' separated
  //  slack:   { url?: string; recipient?: string; token?: string }  // url OR token+recipient
  secure_fields: string[];          // secret keys that are set (slack url/token); values never returned
  disable_resolve_message: boolean;
  builtin: boolean;                 // the seeded "Browser" point: cannot be deleted
  created_at: string; updated_at: string; sync: Sync;
}
// On update, an omitted secret key keeps its stored value; "" clears it.

interface Matcher { label: string; op: '=' | '!=' | '=~' | '!~'; value: string }
interface PolicyRoute {
  id: string;                       // client-generated, stable within the tree
  receiver: string;                 // ContactPoint.id
  matchers: Matcher[];
  continue: boolean;
  group_by?: string[]; group_wait?: string; group_interval?: string; repeat_interval?: string;
  routes: PolicyRoute[];            // nested
}
interface NotificationPolicy {      // the root / default policy
  receiver: string;                 // ContactPoint.id
  group_by: string[];               // default ["alertname"]
  group_wait: string;               // default "30s"
  group_interval: string;           // default "5m"
  repeat_interval: string;          // default "4h"
  routes: PolicyRoute[];
}

interface AlertNotification {       // one delivery to a *browser* contact point
  id: number;                       // monotonic
  received_at: string;
  status: 'firing' | 'resolved';
  source: 'grafana' | 'local' | 'test';
  rule_id: string | null; rule_name: string;
  severity: string; summary: string; description: string;
  labels: Record<string, string>;
  value: number | null;
  contact_point_id: string; contact_point_name: string;
  starts_at: string | null; ends_at: string | null;
  link: string | null;              // Grafana link when known
}

interface AlertingStatus {
  mode: 'grafana' | 'local';
  grafana: { url: string | null; public_url: string; reachable: boolean; version?: string; error?: string };
  loki: { url: string | null; reachable: boolean; error?: string };
  prometheus: { url: string | null; reachable: boolean; error?: string };
  receiver_url: string;
  last_sync_at: string | null; last_sync_error: string | null;
  counts: { rules: number; firing: number; pending: number; contact_points: number };
}
```

### 13.3 Endpoints (prefix `/api/v1`)

| Method & path | Body → Response |
|---|---|
| `GET /alerting/status` | → `AlertingStatus` |
| `POST /alerting/sync` | full push to Grafana → `AlertingStatus` |
| `GET /alerting/rules` | → `{ rules: AlertRule[] }` |
| `POST /alerting/rules` | rule fields → `AlertRule` (201) |
| `GET /alerting/rules/{id}` | → `AlertRule` |
| `PUT /alerting/rules/{id}` | rule fields (full replace) → `AlertRule` |
| `DELETE /alerting/rules/{id}` | → 204 |
| `POST /alerting/rules/preview` | `{datasource, query, reducer, condition}` → `{ value: number \| null; firing: boolean; error?: string; series: number }` (evaluated by Studio against the datasource) |
| `GET /alerting/contact-points` | → `{ contact_points: ContactPoint[] }` |
| `POST /alerting/contact-points` | → `ContactPoint` (201) |
| `GET/PUT/DELETE /alerting/contact-points/{id}` | → `ContactPoint` / `ContactPoint` / 204; DELETE of a point referenced by the policy tree or builtin → 409 |
| `POST /alerting/contact-points/{id}/test` | → `{ ok: boolean; detail: string }`; browser: emits a `source:"test"` notification |
| `GET /alerting/policies` | → `{ policy: NotificationPolicy; sync: Sync }` |
| `PUT /alerting/policies` | `NotificationPolicy` → `{ policy, sync }`; unknown receiver id → 400 |
| `GET /alerting/notifications?after=<id>&limit=<n≤200>` | → `{ items: AlertNotification[]; last_id: number }` (ascending id; `after` omitted → latest `limit`) |
| `POST /alerting/receive?contact_point=<id>` | Grafana/Alertmanager webhook payload → 204 |

Validation failures are 400/422 with `detail`. Unknown id → 404.

### 13.4 Seed (first start, empty store)

Contact point `Browser` (builtin, type `browser`); root policy → Browser with a route
`severity=critical` → Browser; starter rules converted from `deploy/prometheus/rules`
(reconstruction mismatch, format drift, consumer lag) plus a Loki rule
`sum(count_over_time({parse_status="raw_only"}[5m]))` > 100.

### 13.5 Grafana deep links

Loki log dashboard uid `aletheia-logs`, variables `var-event_uid`, `var-source_id`, `var-vendor`.
Single-event dashboard uid `aletheia-event`, variables `var-event_uid`, `var-source_id`, `var-raw_sha256`.
Event link: `${public_url}/d/aletheia-event/aletheia-event?var-event_uid=<uid>&var-source_id=<id>&var-raw_sha256=<hex>&from=<ms>&to=<ms>`,
with `from`/`to` two minutes either side of the receive time held in the event_uid's ULID prefix.
Overview dashboard uid `aletheia-overview`, variable `var-source` (multi, default all): `${public_url}/d/aletheia-overview/aletheia-overview`.
Also provisioned from `deploy/grafana/dashboards/`: `aletheia-events` (`var-event_uid`, `var-source_id`)
and `aletheia-pipeline` (`var-source`). Datasource uids: `aletheia-clickhouse`, `aletheia-loki`,
`aletheia-prometheus`. The Loki datasource's `event_uid` derived field links to `aletheia-event`.

### 13.6 Loki streams

Two writers, disjoint label sets. Loki keeps at most 12 label names per series
(`deploy/loki/loki.yml`); `max_query_series` is 20000 for the overview dashboard's top-k panels.

| Writer | Line | Labels | Structured metadata |
|---|---|---|---|
| Studio raw store (`ingest/rawstore.py`) | the raw line, verbatim | `source`, `severity` (`info\|notice\|warn\|risk`), `format` | `sha256` (of the line) |
| Vector `deploy/vector/loki.toml` (tails topic `normalized`) | normalized OCSF JSON | `vendor`, `product`, `source_id`, `ocsf_class`, `parse_status` | `event_uid`, `template_id`, `merkle_batch`, `storage_mode` |

No other value may become a label: IPs, ports, users and `event_uid` stay in metadata or the line.

## 14. Export & log supply (`backend/studio/api/export.py`, `backend/studio/ingest/supply.py`)

### 14.1 Log export

`GET /api/v1/export/logs` downloads one dataset, newest first.

| Param | Values |
|---|---|
| `log_type` | `raw` (verbatim lines from the raw store), `ocsf` (normalized events from ClickHouse), `system` (audit log plus source lifecycle) |
| `format` | `json`, `jsonl`, `csv`, `tsv`, `xml`, `syslog` (RFC 5424), `cef`, `leef` (2.0, tab-delimited), `text` (the original lines, byte for byte) |
| `source_id`, `severity` (`info\|notice\|warn\|risk`), `q` | Filters. For `ocsf`, `q` also searches `vars`, so template-mode events match on their content |
| `since_s`, or `start`/`end` | Time range. `start`/`end` take ISO-8601 or epoch seconds; `start` overrides `since_s` |
| `limit` | 1 to 50,000. Raw reads page past Loki's 5,000-row query cap |

Raw records: `{time, timestamp_ns, source_id, severity, sha256, line}`, where `sha256` is over `line`.
OCSF records are the §5 event plus OCSF `raw_data`, the original rebuilt from template + vars, so
`sha256(raw_data) == aletheia.raw_sha256` whenever `aletheia.verified` is true. Hashes are lowercase hex.

Response headers: `X-Aletheia-Record-Count`, and `X-Aletheia-SHA256` (the body's SHA-256, so the
receiver can check the file with `sha256sum`). Every export is written to the audit log as
`export.logs` / `export.report`. Errors: 422 bad parameter, 503 ClickHouse down (`ocsf`), 502 raw store failure.

`GET /api/v1/export/report` (`pdf|html|markdown|csv|json`) is a snapshot of §12. With `source_id`,
KPIs, severity and history are that source's figures; an unknown source is 404. `categories`
(comma-separated `kpis,sources,severity,normalized,usage,history,insights,traffic,storage`, empty = all)
picks sections; `window_s` (5 to 86400) is accepted but rates always use the live 5-minute window.

Renderers live in `backend/studio/ingest/logformats.py`, shared by export and supply. Severity maps:
ingest word → OCSF `{info:1, notice:2, warn:3, risk:4}`, → syslog `{info:6, notice:5, warn:4, risk:3}`;
OCSF `severity_id` → CEF `{0:0,1:2,2:3,3:5,4:7,5:9,6:10}`. Syslog uses facility 16 (local0) and SD-ID
`aletheia@32473` (RFC 5612 documentation PEN). Nested fields flatten to dotted keys; lists stay
whole as JSON. The audit actor is the `X-Aletheia-Actor` header (default `unknown`).

### 14.2 Supply stream

`POST /api/v1/export/supply/configure`, `GET /api/v1/export/supply/status`.

| Field | Meaning |
|---|---|
| `mode` | `push`: dial out to `target` (`host:port`), buffer while it is down, reconnect with backoff (1 s to 30 s), resend the chunk whose send failed. `listen`: serve receivers on `host:port` |
| `host` | `listen` bind address, default `127.0.0.1`. `allow` (IPs/CIDRs) refuses other clients |
| `log_type` | `raw` (original line + `\n`), `syslog` (RFC 5424, original as MSG, `[aletheia@32473 source sha256]`, RFC 6587 octet counting), `cef`, `json`, `tagged`, `ocsf` (tails topic `normalized` under a private group from the latest offset; needs `bus.brokers`) |
| `source_id` | Empty for all sources |
| `enabled`, `port`, `allow`, `target` | Start/stop; listen port 1024 to 65535 (default 9099); allow-list as a list; `push` target `host:port` |

Every field is optional; omitted fields keep their value. Both endpoints return the status:
`{active, enabled, mode, target, host, port, log_type, source_id, allow, clients_count, clients[],
lines_sent, bytes_sent, dropped_lines, refused, started_at, last_error, bus, formats[], modes[]}`.

Each receiver has its own bounded queue (512 chunks); a receiver that falls behind loses its
own backlog, counted in `dropped_lines`, and never blocks ingest. A client that reads nothing for
30 s is disconnected. Errors: 422 invalid option, 409 cannot start (port taken, no bus); the
reason is also kept in `last_error`. Settings persist as `supply.*` (§9) and are restored at startup.

## 15. Studio HTTP API index (`backend/studio/main.py`, `backend/studio/api/`)

Every route is under `/api/v1` except `/healthz`. Routes already specified above: settings (§9),
chat (§11), stats (§12), alerting (§13), export and supply (§14). The rest:

### 15.1 Health, packs, events

| Method & path | Response |
|---|---|
| `GET /healthz`, `GET /api/v1/health` | `{status: "ready"\|"degraded", checks: {settings, repo, engine_cli}, version}` |
| `GET /packs/verify` | JSON from `backend/packs/verify_packs.py` (golden-sample reconstruction); 503 if not installed |
| `GET /events?source_id=&class_uid=&parse_status=&q=&limit=≤1000&offset=` | `{events[], total, sources[], classes: [{class_uid, name}]}`; ClickHouse down → empty page, not an error |
| `GET /events/{event_uid}/lineage` | `{event_uid, raw, raw_sha256, verified, storage_mode, parse_status, template_id, pack, pack_version, merkle_batch, tokens, vars, spans: {slot: [start, end)}, field_map, event}`; spans are **byte** offsets. 404 unknown, 503 ClickHouse down |

### 15.2 Sources and push ingest (`api/sources.py`)

Source types: `tcp` (`host`, `port`), `udp_listen` (`port`), `http_stream` (`url`), `websocket`
(`url`), `loki_pull` (`url`, `query`), `rest_cursor` (`url`), `push` (none). States:
`collecting → review → approved | rejected`. Id: `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,62}$`.

| Method & path | Body → Response |
|---|---|
| `GET /sources` | → `{store, bus, worker, types[], sources: SourceView[]}` |
| `POST /sources` | `{id, type, name?, config?, enabled?}` → `SourceView` (201); duplicate 409, invalid 422 |
| `PATCH /sources/{sid}` | `{name?, config?, enabled?}` → `SourceView` |
| `DELETE /sources/{sid}` | → `{deleted}` (also drops its proposal) |
| `GET /sources/{sid}/raw?limit=≤1000&q=&severity=` | → `{source_id, count, lines: [{ts_ns, line, severity}]}`; raw store down 503 |
| `POST /ingest/{sid}` | newline-delimited text (gzip allowed) → `{source_id, accepted}` (202); unknown id self-registers as `push` |
| `POST /ingest/loki/push` | Loki JSON push `{streams: [{stream, values}]}` → 204; source id from label `source`, `job` or `service_name` |
| `POST /sources/{sid}/propose` | `{class_hint?, feedback?}` → proposal; no lines 409, already approved 409 |
| `GET /sources/{sid}/review` | → `{source: SourceView, proposal \| null}` |
| `POST /sources/{sid}/decision` | `{action: approve\|reject\|retry, approver, reason?, cluster_ids?, class_hint?, feedback?}`. Empty `approver` 422. Approve → `{source, packs[], backfilled, bus}`; a cluster whose gate failed 409 |

`SourceView`: `{id, name, type, config, enabled, state, attempts, created_at, history[≤10],
<connector status>, lines, bytes, errors, eps, last_seen, by_severity, has_proposal, ready_for_review}`.
A `collecting` source with ≥100 lines is proposed automatically every 10 s.

Proposal: `{source_id, attempt, sim_th, class_hint, feedback, lines_examined, generated_at, covered,
clusters: [{cluster_id, size, share, samples[≤5], format, warnings, tokens, mapping, gate}]}`, where
`mapping` = `{class_uid, class_name, activity_id, confidence, origin, unmapped_keep, rows:
[{slot, type, sample, path, confidence, transform, evidence}], ai_note}`. Mapping is **AI-first**:
one LLM request per cluster (2 in parallel), the allow-list is per `class_uid`, and reviewer
`feedback` is passed to the model on retry. Rules fill slots and paths the AI left free, and take
over when the AI is off or fails, or when the AI mapping fails the gate but the rules mapping
passes. `ai_note` says why rules were used (`null` = AI mapping kept).

### 15.3 Quarantine studio (`main.py`)

| Method & path | Body → Response |
|---|---|
| `GET /studio/clusters` | → Drain3 clusters over ClickHouse `raw_only` events |
| `GET /studio/clusters/{id}/proposal` | → `{proposal_id, cluster_id, source_id, template: {tokens, slots, method, format, discriminator, warnings}, mapping, samples, origin}` |
| `POST /studio/clusters/{id}/ask-ai` | → `{available, origin, proposal, suggestion?, reason?}`; never an error, heuristics stand |
| `POST /studio/proposals/{id}/gate` | `{faulty?: bool}` → `{ok, samples, reconstructed, failures, type_validation_ok, golden_tests_ok, no_adjacent_slots_ok, coverage, ran_at, cli, checks}` |
| `POST /studio/proposals/{id}/replay` | → `{proposal_id, source_id, events_examined, from_version, to_version, newly_matched, template_changed, fields, regressions, blocking, report_sha256, cli}` |
| `GET /studio/proposals/{id}/approval` | → `{proposal_id, state, approver, approved_at, report_sha256, reason}` |
| `POST /studio/proposals/{id}/approve` | `{approver, report_sha256?}` → approval record |
| `POST /studio/proposals/{id}/reject` | `{approver, reason?}` → approval record |

### 15.4 Demo Console and sample servers

| Method & path | Body → Response |
|---|---|
| `GET /demo/scenarios` | → scenario catalogue `[{id, number, title, action_label, proves, expected, link, cli, requirements, runnable}]` |
| `POST /demo/scenarios/{id}/run` | → `{scenario_id, ok, started_at, duration_ms, output, link}`; not runnable 404 |
| `POST /demo/reset` | → `{ok, output}` |
| `GET /demo/samples` | → `{available, samples: [{id, title, format, transport, port, preset, purpose, category, running, managed, stats}]}` |
| `POST /demo/samples/{id}/start` \| `/stop` | → sample view; generators absent 503 |
| `GET /demo/samples/{id}/logs?after=&tail=` | → generator's `/logs` page; not running 409 |
| `POST /demo/samples/{id}/control` | `{rate?, risk?, paused?, drift?, clear_risk?}` → sample view |

Sample ids: `asa`, `fortigate`, `web`, `vpn`, `cef`, `app`, `shop`, `defense`, `llm`; each `preset`
pre-fills a Sources connector.

### 15.5 Other Studio environment

| Variable | Default | Meaning |
|---|---|---|
| `ALETHEIA_PG_DSN` (or `ALETHEIA_POSTGRES_DSN`, `DATABASE_URL`) | unset → in-memory repo | PostgreSQL |
| `ALETHEIA_CH_URL` / `_USER` / `_PASSWORD` / `_DB` | `http://localhost:8123` / `aletheia` ×3 | ClickHouse for events, lineage, Lyra |
| `ALETHEIA_BIN`, `ALETHEIA_ENGINE_BIN` | repo `bin/aletheia`, then `PATH` | Engine CLI (§8) |
| `ALETHEIA_WORKER_METRICS` | `127.0.0.1:9108` | Probed to report `worker` on `GET /sources` |
| `ALETHEIA_CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Dev-server origins |
| `ALETHEIA_DEMO_SCRIPT`, `ALETHEIA_VERIFY_PACKS`, `ALETHEIA_SERVE_PY`, `ALETHEIA_PACKS_DIR`, `ALETHEIA_OCSF_DIR` | repo paths | Install locations in the all-in-one image |
| `ALETHEIA_SAMPLES_HOST` / `ALETHEIA_SAMPLES_UDP_TARGET` | `127.0.0.1` / `127.0.0.1:5514` | Sample generators |

Grafana and Loki variables are in §13.1; LLM and supply variables in §9.

### 15.6 Demo seeding (`make seed`, `backend/studio/seed_demo.py`)

Needs `ALETHEIA_LLM_API_KEY` in `deploy/secrets/aletheia.env`. Resets the services stack
(`docker compose down -v`, `make services`; `ARGS=--no-reset` keeps data), starts the `asa`
and `web` generators, writes `llm.provider=gemini`, `llm.model` and the sealed key to Postgres,
registers `asa-fw` (`tcp`) and `web-proxy` (`loki_pull`), then seeds and syncs alerting (§13.4).
Studio loads sources at startup, so run it before `make dev` or restart Studio afterwards.
