# Aletheia — Development & Setup Guide (Windows & Linux)

This document provides step-by-step instructions to set up, build, test, and run **Aletheia** on both **Windows** (using PowerShell or Command Prompt, without needing WSL2/Ubuntu) and **Linux**.

---

## 1. System Requirements & Setup Options

### Recommended Hardware
- **CPU**: 4+ cores
- **RAM**: 8 GB minimum (16 GB recommended for full datastore services)
- **Disk**: 10 GB free space

### Windows Setup Modes

| Setup Mode | Pre-requisites Required | Setup Command | Primary Use Case |
| :--- | :--- | :--- | :--- |
| **Mode 1: Docker Automated** *(Recommended)* | **Docker Desktop / Docker Engine** only | `.\setup.ps1` *(PowerShell)*<br>`setup.bat` *(CMD)* | Quickstart, evaluators, zero toolchain configuration required |
| **Mode 2: IDE Native Dev** | **Docker Desktop** + **Python 3.10+**, **Node.js 18+**, **Go 1.23+** *(optional)* | `.\setup.ps1 -Mode Native`<br>`setup.bat native` | Active code development in **VS Code** with live hot-reloading |

---

## 2. Windows Setup Guide

### Option A: Automated Docker Setup (Zero Host Toolchain Dependencies)

If you only have **Docker Engine / Docker Desktop** installed on Windows, you can start the entire stack in containerized mode with a single command:

#### PowerShell:
```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```
*(or explicitly: `powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Mode Container`)*

> *Execution Policy Note*: `-ExecutionPolicy Bypass` applies to this one run only. Plain `.\setup.ps1` is
> refused by default, and even `RemoteSigned` refuses it if the repo was downloaded as a ZIP.

#### Command Prompt:
```cmd
setup.bat
```

What this does automatically:
1. Verifies Docker Desktop is running.
2. Creates local secret configuration (`deploy/secrets/aletheia.env`) from template.
3. Builds and launches the complete containerized stack (`deploy/docker-compose.yml`).
4. Serves the **Aletheia UI on `http://localhost:8080`** (dashboard at `/dashboard`), the Studio API through the UI proxy (it is not published on its own port), Grafana on `http://localhost:3000` (also `http://localhost:8080/grafana/`), and syslog on `5514` UDP/TCP and `6514` TLS.

To enable the AI assistant (onboarding mappings and the Lyra chat), put a Gemini key in
`deploy/secrets/aletheia.env` before running it, or set it later in **Settings** at
`http://localhost:8080/dashboard/settings`. See [Local configuration](#5-local-configuration-deploysecretsaletheiaenv).

---

### Option B: VS Code Native Development Setup

If you want to edit and debug Python, TypeScript/React, or Go code directly on Windows inside **VS Code**:

#### 1. Automated Native IDE Setup
Open PowerShell or Command Prompt in the project root:

**PowerShell:**
```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Mode Native
```

**Command Prompt:**
```cmd
setup.bat native
```

What this does automatically:
1. Creates Python `.venv` virtual environment and installs backend dependencies (`backend/studio/requirements-dev.txt`).
2. Installs frontend Node modules (`frontend/node_modules`).
3. Compiles Go engine binaries into `bin/aletheia.exe` and `bin/aletheia-worker.exe` (if Go is installed).
4. Generates local secrets (`deploy/secrets/aletheia.env`).
5. Starts backing services (PostgreSQL, ClickHouse, Redpanda, Loki, Grafana, Prometheus, and a small Vector that ships normalized events to Loki) via Docker (`deploy/docker-compose.services.yml`).
6. Verifies all parser packs with an offline golden sample check.

#### 2. Developing in VS Code
Pre-configured IDE tasks and debug configurations are included in `.vscode/`:

- **Launch Tasks (`Ctrl+Shift+B` or Command Palette -> `Tasks: Run Task`)**:
  - `Aletheia: Start Datastores in Docker` — Starts database services.
  - `Aletheia: Start Backend Studio API` — Launches FastAPI with hot reload on port 8081.
  - `Aletheia: Start Frontend Dev Server` — Launches Vite dev server with hot reload on port 5173.
  - `Aletheia: Verify Parser Packs` — Runs golden sample verification test.
- **Debugging (`F5` or Run & Debug tab)**:
  - Select **"Studio API (FastAPI Backend)"** to attach Python debugger with breakpoints.

#### 3. Manual Command Line Dev Commands (Powershell)

**Step 1: Start Backing Datastores in Docker**
```powershell
docker compose -f deploy/docker-compose.services.yml up -d
# Create the bus topics once Redpanda is healthy (make services does this on Linux)
foreach ($t in "raw","quarantine","normalized","control","dlq") { docker exec aletheia-services-redpanda-1 rpk topic create $t -p 4 -r 1 }
```

**Step 2: Start Studio Backend API (Port 8081 with Hot Reload)**
```powershell
$env:ALETHEIA_MODE="lite"
$env:ALETHEIA_PG_DSN="postgres://aletheia:aletheia@127.0.0.1:5432/aletheia"
$env:ALETHEIA_BUS_BROKERS="127.0.0.1:9092"
# AI provider: optional; can also be set from Settings in the UI. Only gemini-* models are accepted.
$env:ALETHEIA_LLM_PROVIDER="gemini"
$env:ALETHEIA_LLM_MODEL="gemini-3.5-flash-lite"
$env:ALETHEIA_LLM_API_KEY="<your Gemini key>"
# Alerting + logs (docs/alerting.md). Leave ALETHEIA_GRAFANA_URL unset to use local alert evaluation.
$env:ALETHEIA_GRAFANA_URL="http://127.0.0.1:3000"
$env:ALETHEIA_GRAFANA_PUBLIC_URL="http://localhost:3000"
$env:ALETHEIA_LOKI_URL="http://127.0.0.1:3100"
$env:ALETHEIA_PROMETHEUS_URL="http://127.0.0.1:9090"
$env:ALETHEIA_ALERT_RECEIVER_URL="http://host.docker.internal:8081"
.\.venv\Scripts\python.exe -m uvicorn backend.studio.main:app --reload --host 0.0.0.0 --port 8081
```

**Step 3: Start Frontend Dev Server (Port 5173 with Hot Reload)**
In a second terminal window:
```powershell
cd frontend
npm run dev
```

**Step 4 (optional): Start the Engine Worker**
Approved sources only reach Events, Lineage and the Grafana dashboards while the worker runs
(needs Go; `setup.ps1 -Mode Native` builds it). In a third terminal:
```powershell
$env:ALETHEIA_PACKS_DIR="backend/packs"
$env:ALETHEIA_OCSF_DIR="backend/ocsf"
$env:ALETHEIA_CLICKHOUSE_ADDR="127.0.0.1:9000"
$env:ALETHEIA_CLICKHOUSE_USER="aletheia"
$env:ALETHEIA_CLICKHOUSE_PASSWORD="aletheia"
$env:ALETHEIA_PG_DSN="postgres://aletheia:aletheia@127.0.0.1:5432/aletheia"
$env:ALETHEIA_BUS_BROKERS="127.0.0.1:9092"
.\bin\aletheia-worker.exe
```

Open your browser at **`http://localhost:5173`** (landing page) or **`http://localhost:5173/dashboard`**.

---

## 3. Linux Setup Guide

### Step 1: Clone Repository & Install Dependencies
```bash
git clone https://github.com/Ritesh2006M/Aletheia.git
cd Aletheia
```

### Step 2: Install Go (No Root Required)
```bash
make install-go
export PATH=$HOME/.local/go/bin:$PATH
```

### Step 3: Run Automated Linux Setup
```bash
make setup      # .venv, npm install, and deploy/secrets/aletheia.env from the example
make check      # offline: packs + engine + studio + frontend
```

Optionally put your Gemini key in `deploy/secrets/aletheia.env` (`ALETHEIA_LLM_API_KEY=`); `make studio`,
`make worker` and `make seed` read it, so nothing has to be typed into the UI.

### Step 4: Run Application
```bash
# Backing services in Docker (ClickHouse, PostgreSQL, Redpanda, Loki, Grafana, Prometheus) + topics
make services

# Optional fresh demo: wipes data, sets Gemini as the LLM, connects two demo log servers,
# seeds alert rules. Needs the key above. Run it before `make dev`.
make seed

# Native engine worker + Studio + Frontend (also starts services if they are not up)
make dev
```

Then open the dashboard at `http://localhost:5173/dashboard`, the Studio API at
`http://localhost:8081`, and Grafana at `http://localhost:3000` (admin / `aletheia`).
`make help` lists every target; `make doctor` shows what is installed.

`make services` also starts Loki, Prometheus and a Loki-only Vector, so Grafana's logs dashboard
(`/d/aletheia-logs`) and the overview (`/d/aletheia-overview`) fill once the worker runs. Alerting rules, contact points and policies are on
the dashboard's **Alerting** page; `make studio` already points Studio at Grafana, Loki and
Prometheus. Email needs `ALETHEIA_SMTP_*` before `make services`. With `ufw` active, allow Grafana
to call Studio back — see [docs/alerting.md](docs/alerting.md#troubleshooting).

---

## 4. Service Endpoints & Port Map

Container mode is `deploy/docker-compose.yml` (Option A, `make up`); native mode is
`deploy/docker-compose.services.yml` plus the native Studio, frontend and worker (Option B, `make dev`).

| Component | Container Mode URL | Native Dev Mode URL | Description |
| :--- | :--- | :--- | :--- |
| **Frontend Web App** | `http://localhost:8080` | `http://localhost:5173` | React + Vite UI (landing page) |
| **Dashboard** | `http://localhost:8080/dashboard` | `http://localhost:5173/dashboard` | Overview, Events, Lineage, Lyra, Sources, Export, Alerting, Demo, Settings |
| **Studio API Server** | via UI proxy (`:8080/api/`) | `http://localhost:8081` | FastAPI Control Plane & Studio |
| **ClickHouse HTTP** | `http://localhost:8123` | `http://localhost:8123` | Log & Event Columnar Database |
| **ClickHouse Native** | internal | `localhost:9000` | Native TCP interface (used by the worker) |
| **PostgreSQL** | internal | `localhost:5432` | Source & Pack Metadata database |
| **Redpanda Kafka API** | internal | `localhost:9092` | Log Message Bus |
| **MinIO** | internal | not started | Parquet / Object Archive Storage |
| **Grafana** | `http://localhost:3000` (also `:8080/grafana/`) | `http://localhost:3000` | Dashboards and alert evaluation (admin / `aletheia`) |
| **Grafana Dashboards** | `/d/aletheia-overview`, `/d/aletheia-logs`, `/d/aletheia-event`, `/d/aletheia-events`, `/d/aletheia-pipeline` | same | Overview, Loki logs, single event, storage & integrity, pipeline health |
| **Loki** | internal | `http://localhost:3100` | Log store behind the logs dashboards |
| **Prometheus** | internal | `http://localhost:9090` | Worker metrics, pipeline dashboard |
| **Engine Worker Metrics** | internal | `http://localhost:9108` | Prometheus scrape target |
| **Syslog Listener** | `udp/tcp://localhost:5514`, TLS `:6514` | not started | Log Ingestion Port (Vector) |
| **Supply Stream** | off by default | `127.0.0.1:9099` when enabled | TCP feed to a SIEM/collector, configured on the Export page |
| **Demo Log Servers** | — | `:9101-9106` (`make gens`) | Live generator servers to connect as sources |

---

## 5. Local configuration (`deploy/secrets/aletheia.env`)

Created from `deploy/secrets/aletheia.env.example` by `make setup` / `make secrets` / `setup.ps1`.
It is gitignored; never commit the filled copy. Values set in the UI's **Settings** page override it.

| Variable | Example default | Effect |
| :--- | :--- | :--- |
| `ALETHEIA_LLM_PROVIDER` | `gemini` | `none` (heuristics only), `gemini`, or `local` (Ollama, vLLM, llama.cpp, LM Studio) |
| `ALETHEIA_LLM_MODEL` | `gemini-3.5-flash-lite` | On `gemini`, only `gemini-*` models are accepted; anything else falls back to this default |
| `ALETHEIA_LLM_API_KEY` / `_FILE` | empty | Gemini key, inline or from a mounted file (the file is preferred) |
| `ALETHEIA_LLM_BASE_URL` | unset | Required for `local`, e.g. `http://localhost:11434/v1` |
| `ALETHEIA_LLM_SEND_SAMPLES` | `masked` | `masked`, `none`, or `raw` (local providers only) |
| `ALETHEIA_AIRGAP` | `false` | `true` refuses all cloud providers |
| `ALETHEIA_SECRET` | generated | AES-GCM key for settings stored via the UI |

Alerting and Grafana variables (`ALETHEIA_GRAFANA_URL`, `ALETHEIA_GRAFANA_PUBLIC_URL`,
`ALETHEIA_LOKI_URL`, `ALETHEIA_PROMETHEUS_URL`, `ALETHEIA_ALERT_RECEIVER_URL`, `ALETHEIA_SMTP_*`) are
set by `make studio` / `make services` with the defaults shown in the Windows manual Step 2 above; see
[docs/alerting.md](docs/alerting.md).

---

## 6. Troubleshooting for Windows Users

### 1. PowerShell Script Execution Error
If PowerShell says `...script cannot be loaded because running scripts is disabled on this system`
(or `...is not digitally signed`), run it with a one-off bypass:
```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

### 1b. Shell scripts fail inside containers (`$'\r': command not found`, `set: -: invalid option`)
The repo was checked out with Windows (CRLF) line endings before `.gitattributes` existed. Re-checkout once (this discards uncommitted local changes):
```powershell
git rm -r --cached . ; git reset --hard
```

### 2. Docker Desktop Memory Settings
- Open Docker Desktop Settings $\rightarrow$ Resources $\rightarrow$ Memory.
- Ensure at least **6 GB - 8 GB** of RAM is allocated to Docker Desktop.

### 3. Port Conflicts (`port 8081 or 5173 already in use`)
- Change the frontend port: `npm run dev -- --port 5174`.
- Change the backend port: `.\.venv\Scripts\python.exe -m uvicorn backend.studio.main:app --port 8082`.
