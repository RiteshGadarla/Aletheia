# Aletheia — Alerting and the Loki logs dashboard

[← Documentation index](README.md) · [Project README](../README.md)

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

## Contents

- [Modes](#modes)
- [The Alerting page](#the-alerting-page)
- [Where each deployment points Studio](#where-each-deployment-points-studio)
- [Contact points](#contact-points)
- [Rule queries](#rule-queries)
- [Dashboards](#dashboards)
- [Logs dashboard](#logs-dashboard)
- [Overview dashboard](#overview-dashboard)
- [Event dashboard](#event-dashboard)
- [Troubleshooting](#troubleshooting)

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

On first start Studio seeds the built-in **Browser** contact point, a default policy (group by
`alertname`, 30s / 5m / 4h) with one nested route for `severity=critical`, and four rules:
reconstruction mismatch, format drift and consumer lag (Prometheus), and raw-only lines (Loki).

## The Alerting page

The page header shows the mode, whether Grafana, Loki and Prometheus are reachable, and a **Sync**
button. Three tabs sit below it, each with a count:

- **Alert rules.** State tiles (Firing, Pending, Normal, Error / No data, Paused) filter the list,
  and a search box matches name, query and labels. Clicking a rule opens its details in a compact
  popup rather than expanding it inline: the last error if evaluation failed, the query with a copy
  button, summary, description, last value, evaluation and sync times, labels, and **Edit rule**,
  **View in Grafana** and, for Loki rules, **Explore logs**. The editor has a **Preview** button
  that runs the query through Studio and shows the value, the series count and whether the
  condition would fire. A **Recent notifications** panel lists the last 20 deliveries (firing,
  resolved, test), refreshes every 10 s, and jumps to the rule on click.
- **Contact points.** Create, edit, test and delete points. Each shows whether a policy uses it.
  A banner asks for OS notification permission, so Browser alerts also pop up while the tab is in
  the background. In-app toasts work without it.
- **Notification policies.** The policy tree, top to bottom, where the first match wins unless a
  route has `continue`. Routes can be reordered, nested, and given their own grouping and timing.
  Edits are held until you save. **Test routing** runs a set of alert labels (typed in, or filled
  from a rule) through the tree as edited, saved or not, and shows which contact points get it.

## Where each deployment points Studio

| | `make run` / `make studio` | `deploy/docker-compose.yml` | all-in-one image |
|---|---|---|---|
| `ALETHEIA_GRAFANA_URL` | `http://127.0.0.1:3000` | `http://grafana:3000/grafana` | `http://127.0.0.1:3000/grafana` |
| `ALETHEIA_GRAFANA_PUBLIC_URL` | `http://localhost:3000` | `/grafana` | `/grafana` |
| `ALETHEIA_LOKI_URL` | `http://127.0.0.1:3100` | `http://loki:3100` | `http://127.0.0.1:3100` |
| `ALETHEIA_PROMETHEUS_URL` | `http://127.0.0.1:9090` | `http://prometheus:9090` | `http://127.0.0.1:9090` |
| `ALETHEIA_ALERT_RECEIVER_URL` | `http://host.docker.internal:8081` | `http://aletheia-studio:8081` | `http://127.0.0.1:8081` |

Any of these can be overridden in the environment. Studio logs in to Grafana as
`ALETHEIA_GRAFANA_USER` / `ALETHEIA_GRAFANA_PASSWORD` (default `admin` / `aletheia`; the full compose
stack sets the password from `ALETHEIA_ADMIN_PASSWORD`). A service-account token in
`ALETHEIA_GRAFANA_TOKEN` takes precedence over them. `ALETHEIA_LOKI_TENANT` sets the Loki tenant
header for the local evaluator when Loki runs multi-tenant.

In the compose stack and the all-in-one image Grafana is served under `/grafana/` and is not
published on a port of its own: the only way in is the UI's nginx, at
`http://localhost:6156/grafana/`. The public URL is relative, so Aletheia's "Open in Grafana" links
work whatever host name or port the UI is reached on. `ALETHEIA_PUBLIC_URL` (default
`http://localhost:6156`) is the origin Grafana writes into links it renders itself, such as alert
emails.

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

ClickHouse queries must be a single `SELECT`. Grafana here ships without the ClickHouse plugin, so
in `grafana` mode a ClickHouse rule has no datasource to run on and shows an error. **Preview**
still works, because Studio runs it. Use Loki or Prometheus for rules that Grafana evaluates.

Loki labels: normalized events carry `vendor`, `product`, `source_id`, `ocsf_class` and
`parse_status`. Raw lines pushed by Studio carry `source`, `severity` and `format`. `event_uid`,
`template_id` and `sha256` are structured metadata, so they work as filters (`| event_uid="…"`) but
not as stream selectors.

## Dashboards

All five are file-provisioned from `deploy/grafana/dashboards/` into the **Aletheia** folder.

| Dashboard | uid | Datasources |
|---|---|---|
| Aletheia — Overview | `aletheia-overview` | Loki, Prometheus |
| Aletheia — Event | `aletheia-event` | Loki |
| Aletheia — Logs (Loki) | `aletheia-logs` | Loki |
| Aletheia — Pipeline health | `aletheia-pipeline` | Prometheus |
| Aletheia — Events, storage and integrity | `aletheia-events` | ClickHouse, Loki. Its ClickHouse panels stay empty without the plugin |

## Logs dashboard

`Aletheia — Logs (Loki)`, uid `aletheia-logs`. It has variables `event_uid` (a text box, empty
matches all), `vendor` and `source_id`, and shows:

- log volume by vendor and by parse status
- `raw_only` share, the drift signal
- top sources
- raw ingest volume by source and by severity
- the normalized event lines and the raw lines

## Overview dashboard

`Aletheia — Overview`, uid `aletheia-overview`, is the Studio Overview page rebuilt on Loki and Prometheus
for any time range. It covers ingest, threat signals, normalization and integrity, traffic, and a per-source
table. Studio's Overview page links to it with "View in Grafana". Grafana cannot see what lives only in
Studio (connection state, approvals), the storage figures (ClickHouse), or port-scan and fan-out counts,
because distinct counts per IP need more series than Loki can return. Top-IP panels group by a parsed field
before `topk`, so `deploy/loki/loki.yml` raises `max_query_series` to 20000. Port panels leave out ports of
10000 and above: ephemeral ports would put every connection in its own series.

## Event dashboard

`Aletheia — Event`, uid `aletheia-event`, is where Studio's "Open in Grafana" buttons go. For one event it
shows every field of the normalized event, the raw line as received (matched on `sha256`), the pretty-printed
OCSF JSON, and the source's volume and lines around it, with the event marked on the chart. Link to it with
`${ALETHEIA_GRAFANA_PUBLIC_URL}/d/aletheia-event/aletheia-event?var-event_uid=<uid>&var-source_id=<id>&var-raw_sha256=<hex>`
plus `from`/`to`. Studio sets these to two minutes either side of the receive time, which it reads from
the event_uid (a ULID). It is Loki-only, because Grafana here has no ClickHouse plugin.

Loki lines also get two links from `event_uid`: to the full ClickHouse record and to the event dashboard.
Only `event_uid` is available there, so the raw line panel stays empty when you arrive that way.

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
