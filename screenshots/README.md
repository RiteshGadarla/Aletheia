# Screenshots

Captured from a live local stack: five sources connected and approved across five transports
(TCP, HTTP NDJSON, Loki pull, REST cursor, UDP syslog), ~290 lines/s, zero ingest errors,
100% of events parsed into OCSF, posture score 97. All 3200x2000 (1600x1000 at 2x), dark theme.

The README's own screenshot is `docs/assets/dashboard-overview.png` (light theme, 1600x1000).

---

## Studio

### 01. Overview

Posture score, auto-written findings and live ingest KPIs.

![Overview](images/01-overview-dark.png)

### 02. Events Explorer

Normalized OCSF records, each traceable back to its raw line.

![Events Explorer](images/02-events-explorer-dark.png)

### 03. Sources

Five transports at once, each with its own severity mix and error count.

![Sources](images/03-sources-connected-dark.png)

### 04. Lyra

Ask-your-data console with the read-only guard active.

![Lyra](images/04-lyra-dark.png)

### 05. Export & Supply

Evidence-grade datasets, generated reports and the live SIEM feed.

![Export and Supply](images/05-export-supply-dark.png)

### 06. Alerting

Grafana-synced rules with health and state at a glance.

![Alerting](images/06-alerting-rules-dark.png)

### 07. Landing

Hero statement over the animated fiber field.

![Landing hero](images/07-landing-hero-dark.png)

---

## Grafana

### 08. Overview

Ingest rate, per-source activity, severity over time and share of volume.

![Grafana Overview](images/08-grafana-overview-dark.png)

### 09. Pipeline health

Reconstruct mismatch holding at 0 beside sustained throughput.

![Grafana Pipeline health](images/09-grafana-pipeline-health-dark.png)

### 10. Logs (Loki)

Raw ingest by source and by severity, straight from the raw store.

![Grafana Logs](images/10-grafana-logs-loki-dark.png)
