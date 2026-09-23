# Aletheia — Alerting and the Loki logs dashboard

Alert rules, contact points and the notification policy tree are edited on the dashboard's
**Alerting** page. Grafana's unified alerting evaluates them and sends the notifications. The API
contract is [CONTRACTS §13](CONTRACTS.md#13-alerting-api-contract-grafana-backed).

```
 UI Alerting page ──▶ Studio (store of truth, PostgreSQL)
                          │  provisioning HTTP API, X-Disable-Provenance
                          ▼
                       Grafana ── evaluates rules over Loki / Prometheus / ClickHouse
                          │
          ┌───────────────┼──────────────────┬──────────────┐
          ▼               ▼                  ▼              ▼
   "browser" point    webhook             email (SMTP)    Slack
   = webhook to Studio /api/v1/alerting/receive ──▶ UI notification feed
```

## Modes

| Mode | When | Who evaluates |
|---|---|---|
| `grafana` | `ALETHEIA_GRAFANA_URL` is set and Grafana answers | Grafana. Studio pushes every change, and **Sync** re-pushes everything |
| `local` | Grafana not configured or unreachable (`make dev` without `make services`) | Studio's own evaluator, same rules and the same notification feed |

`GET /api/v1/alerting/status` (and the page header) shows the mode, and whether Grafana, Loki and
Prometheus are reachable.

Studio is the store of truth. Rules go into the Grafana folder **Aletheia**, next to the
provisioned dashboards. Grafana alerting objects are **never file-provisioned**. A provisioned
policy tree would lock out Studio's API writes, so do not add `provisioning/alerting/`. Rules stay
editable in Grafana, but the next sync from Studio overwrites those edits.

## Where each deployment points Studio

| | `make run` / `make studio` | `deploy/docker-compose.yml` | all-in-one image |
|---|---|---|---|
| `ALETHEIA_GRAFANA_URL` | `http://127.0.0.1:3000` | `http://grafana:3000/grafana` | `http://127.0.0.1:3000` |
| `ALETHEIA_GRAFANA_PUBLIC_URL` | `http://localhost:3000` | `http://localhost:3000/grafana` | `http://localhost:3000` |
| `ALETHEIA_LOKI_URL` | `http://127.0.0.1:3100` | `http://loki:3100` | `http://127.0.0.1:3100` |
| `ALETHEIA_PROMETHEUS_URL` | `http://127.0.0.1:9090` | `http://prometheus:9090` | `http://127.0.0.1:9090` |
| `ALETHEIA_ALERT_RECEIVER_URL` | `http://host.docker.internal:8081` | `http://aletheia-studio:8081` | `http://127.0.0.1:8081` |

Any of these can be overridden in the environment. Grafana credentials default to `admin` /
`ALETHEIA_ADMIN_PASSWORD` (`aletheia`). A service-account token in `ALETHEIA_GRAFANA_TOKEN` takes
precedence over them.

In the full compose stack Grafana is served under `/grafana/`, so the UI's nginx proxies it at
`http://localhost:8080/grafana/`. Bare `:3000` paths still work because they redirect.

## Contact points

| Type | Settings | Needs |
|---|---|---|
| `browser` | none | Grafana must reach `ALETHEIA_ALERT_RECEIVER_URL`. The built-in **Browser** point cannot be deleted |
| `webhook` | `url`, optional `http_method` | Grafana must reach the URL |
| `email` | `addresses` (`;` or `,` separated) | SMTP, see below |
| `slack` | incoming-webhook `url`, **or** bot `token` + `recipient` channel | Grafana needs egress to Slack. Not available when air-gapped |

Secrets such as the Slack url or token are write-only: the API reports that they are set, never
their value. Use **Test** on a contact point to send a test notification. For the browser point
the test appears straight away in the notification feed.

### Email (SMTP)

Grafana sends the email. SMTP is off by default. Set these variables before starting Grafana (`make
services`, `make up`, or `docker run -e …` for the all-in-one image):

| Variable | Maps to | Example |
|---|---|---|
| `ALETHEIA_SMTP_ENABLED` | `GF_SMTP_ENABLED` | `true` |
| `ALETHEIA_SMTP_HOST` | `GF_SMTP_HOST` | `smtp.example.org:587` |
| `ALETHEIA_SMTP_USER` | `GF_SMTP_USER` | `alerts@example.org` |
| `ALETHEIA_SMTP_PASSWORD` | `GF_SMTP_PASSWORD` | an app password |
| `ALETHEIA_SMTP_FROM_ADDRESS` | `GF_SMTP_FROM_ADDRESS` | `alerts@example.org` (default `aletheia@aletheia.localhost`) |

```bash
export ALETHEIA_SMTP_ENABLED=true ALETHEIA_SMTP_HOST=smtp.example.org:587 \
       ALETHEIA_SMTP_USER=alerts@example.org ALETHEIA_SMTP_PASSWORD=… \
       ALETHEIA_SMTP_FROM_ADDRESS=alerts@example.org
docker compose -f deploy/docker-compose.services.yml up -d grafana   # recreate with SMTP on
```

STARTTLS is opportunistic (`deploy/grafana/grafana.ini`, `[smtp]`).

## Rule queries

| Datasource | Query returns | Example |
|---|---|---|
| `loki` | a LogQL metric query | `sum(count_over_time({parse_status="raw_only"}[5m]))` |
| `prometheus` | PromQL | `increase(aletheia_reconstruct_mismatch_total[5m])` |
| `clickhouse` | SQL returning one number | `SELECT count() FROM aletheia.events WHERE recv_time > now() - INTERVAL 5 MINUTE` |

Loki labels: normalized events carry `vendor`, `product`, `source_id`, `ocsf_class` and
`parse_status`. Raw lines pushed by Studio carry `source`, `severity` and `format`. `event_uid`,
`template_id` and `sha256` are structured metadata, so they work as filters (`| event_uid="…"`) but
not as stream selectors.

## Logs dashboard

`Aletheia — Logs (Loki)`, uid `aletheia-logs`. It has variables `event_uid` (a text box, empty
matches all), `vendor` and `source_id`, and shows:

- log volume by vendor and by parse status
- `raw_only` share, the drift signal
- top sources
- raw ingest volume by source and by severity
- the normalized event lines and the raw lines

Link to one event with `${ALETHEIA_GRAFANA_PUBLIC_URL}/d/aletheia-logs/aletheia-logs?var-event_uid=<uid>`.
Loki lines also get two links from `event_uid`: to the full ClickHouse record and to this dashboard.

In `make services` mode a small `vector-loki` container runs only the `normalized` → Loki sink
(`deploy/vector/loki.toml`). The full stack and the all-in-one image run the same file together
with the HEC/CEF sinks.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Status says `local` although Grafana is up | Studio cannot reach `ALETHEIA_GRAFANA_URL`, or basic auth fails. Grafana applies `GF_SECURITY_ADMIN_PASSWORD` only the first time it creates its volume. Reset it with `docker exec aletheia-services-grafana-1 grafana cli admin reset-admin-password aletheia` |
| Rules fire in Grafana, but nothing arrives in the browser (`make run`) | Grafana, in Docker, cannot reach Studio on the host. The services compose already maps `host.docker.internal` to the host gateway. On Linux the usual blocker is the host firewall: `sudo ufw allow from 172.16.0.0/12 to any port 8081,9108 proto tcp`. Check with `docker exec aletheia-services-grafana-1 wget -qO- -T3 http://host.docker.internal:8081/healthz` |
| Studio also listens only on `127.0.0.1` | `make studio` binds `0.0.0.0:8081`. A custom launch must do the same, or Grafana cannot call back |
| Prometheus target `aletheia-worker` down | Same firewall rule (port 9108), and `make worker` must be running |
| Logs dashboard empty | The worker must be running and the `normalized` topic must exist (`make topics`). Check `docker compose -f deploy/docker-compose.services.yml logs vector-loki`. An "Unknown topic" error before `make topics` clears by itself |
| Grafana exits with `invalid email address for SMTP from_address` | `ALETHEIA_SMTP_FROM_ADDRESS` must be a full address with a dotted domain |
| Email contact point test fails | SMTP is not enabled in Grafana (`ALETHEIA_SMTP_ENABLED=true`, then recreate the grafana container) |
| Rules missing in Grafana after it was reset | Click **Sync** on the Alerting page (or `POST /api/v1/alerting/sync`) |
