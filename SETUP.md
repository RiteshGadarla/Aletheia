# Aletheia — Setup Guide

How to install and start Aletheia. Pick one:

| | Best for | You install |
| :--- | :--- | :--- |
| **[1. Docker](#1-docker-recommended)** (recommended) | Evaluating and running Aletheia | Docker only |
| **[2. Linux / macOS from source](#2-linux--macos-from-source)** | Development with hot reload | Docker, Python, Node.js, Go |
| **[3. Windows from source](#3-windows-from-source)** | Development in PowerShell | Docker Desktop, Python, Node.js, Go |

Then see the [port map](#4-port-map) and [troubleshooting](#5-troubleshooting). Once it runs,
continue with the [README](README.md): [connect an AI provider](README.md#connect-an-ai-provider)
(optional) and the [guided evaluation](README.md#guided-evaluation).

---

## 1. Docker (recommended)

### Requirements

- **Docker Desktop** (Windows, macOS) or **Docker Engine** (Linux).
- **4+ CPU cores, 8 GB RAM allocated to Docker, 10 GB free disk.** Docker Desktop's default memory
  limit is often lower than 8 GB: raise it under *Settings → Resources → Memory*, or the container
  will not reach `healthy`.

### Pull and run

> The image name below, `<docker-repo>/aletheia:1.0.0`, is a placeholder until the registry URL is
> published. Replace it in the commands in this section.

```bash
docker pull <docker-repo>/aletheia:1.0.0

docker run -d --name aletheia -p 6156:6156 -p 26514:5514/udp -p 26514:5514/tcp -v aletheia-data:/data --add-host=host.docker.internal:host-gateway <docker-repo>/aletheia:1.0.0
```

The command is one line so it pastes unchanged into bash, zsh, PowerShell and Command Prompt.

| Flag | Why |
| :--- | :--- |
| `-p 6156:6156` | The only web port. nginx inside the container serves the UI, the API and Grafana on it |
| `-p 26514:5514/udp -p 26514:5514/tcp` | Syslog input for your own logs (optional) |
| `-v aletheia-data:/data` | Keeps data and **saved settings, including your AI key**, across restarts. Without it every `docker run` starts a fresh demo |
| `--add-host=host.docker.internal:host-gateway` | Lets the container reach a local AI model (Ollama) on this machine. Harmless if you never use one |

No environment file and no API key are needed to start.

### Wait until it is ready

First boot takes one to two minutes (database initialisation, schema, topics).

```bash
docker ps --filter name=aletheia        # STATUS shows "(healthy)" when ready
```

Then open **<http://localhost:6156>**.

| What | URL |
| :--- | :--- |
| Landing page | <http://localhost:6156> |
| Dashboard | <http://localhost:6156/dashboard> |
| Demo Console | <http://localhost:6156/dashboard/demo> |
| Settings (AI provider) | <http://localhost:6156/dashboard/settings> |
| Grafana (admin / `aletheia`) | <http://localhost:6156/grafana/> |
| Readiness | <http://localhost:6156/healthz> |

### Ports

Everything HTTP goes through **one port, 6156**. Grafana, ClickHouse, PostgreSQL, Redpanda, Loki and
Prometheus run inside the container on its loopback and are never published. The syslog ports are
deliberately uncommon, so they never collide with a syslog daemon or SIEM agent already on the host.

| Host port | Container port | Service |
| :--- | :--- | :--- |
| **6156** | 6156 | UI at `/`, Studio API at `/api/`, Grafana at `/grafana/` |
| **26514** UDP/TCP | 5514 | Syslog input |
| 26515 TCP (optional) | 5515 | Syslog with RFC 6587 octet counting — add `-p 26515:5515` |
| 26516 TCP (optional) | 6514 | Syslog over TLS — add `-p 26516:6514` |

If a port is already taken, change only the host side, e.g. `-p 16156:6156`, and open
`http://localhost:16156`. Links inside the app are relative and keep working.

### Everyday commands

```bash
docker logs -f aletheia            # follow the logs
docker stop aletheia               # stop (data stays in the aletheia-data volume)
docker start aletheia              # start again
docker rm -f aletheia              # remove the container; the volume keeps the data
docker volume rm aletheia-data     # delete all data and settings for a clean start
```

To upgrade, pull the new tag, `docker rm -f aletheia`, and run the same `docker run` command with the
new tag. The volume carries your data and settings over.

### Air-gapped machines

```bash
# on a machine with internet
docker pull <docker-repo>/aletheia:1.0.0
docker save -o aletheia-1.0.0.tar <docker-repo>/aletheia:1.0.0
sha256sum aletheia-1.0.0.tar

# on the air-gapped machine, after copying the file across
sha256sum aletheia-1.0.0.tar          # must match
docker load -i aletheia-1.0.0.tar
docker run -d --name aletheia -e ALETHEIA_AIRGAP=true -p 6156:6156 -p 26514:5514/udp -p 26514:5514/tcp -v aletheia-data:/data <docker-repo>/aletheia:1.0.0
```

Nothing is downloaded at start or run time. `ALETHEIA_AIRGAP=true` refuses cloud AI providers; a
local model still works.

### Building the image from source (optional)

On Linux or macOS with the repository checked out:

```bash
./docker/build.sh build      # builds aletheia:1.0.0 locally
./docker/build.sh verify     # boots it and runs the end-to-end checks
```

---

## 2. Linux / macOS from source

For development: Studio (Python), the frontend (Vite) and the engine worker (Go) run natively with hot
reload. Docker runs only the datastores (PostgreSQL, ClickHouse, Redpanda, Loki, Grafana, Prometheus).

### Requirements

| Tool | Version | Linux | macOS |
| :--- | :--- | :--- | :--- |
| Docker | Engine 24+ / Desktop | distro packages or Docker's repo | Docker Desktop |
| Python | 3.10+ with `venv` | `sudo apt install python3 python3-venv` | `brew install python` |
| Node.js | 18+ LTS | [nodejs.org](https://nodejs.org) or `nvm` | `brew install node` |
| Go | 1.23+ | `make install-go` (no root, amd64) | `brew install go` |
| make, git, curl | any | usually present | `xcode-select --install` |

Same hardware as Docker: 4+ cores, 8 GB RAM for Docker, 10 GB disk.

### Step 1: Clone

```bash
git clone https://github.com/RiteshGadarla/Aletheia.git
cd Aletheia
```

### Step 2: Install Go (Linux amd64, only if you do not have it)

```bash
make install-go
export PATH=$HOME/.local/go/bin:$PATH     # add this line to ~/.bashrc or ~/.zshrc too
```

On macOS or ARM Linux, install Go 1.23+ from your package manager or [go.dev/dl](https://go.dev/dl/) instead.

### Step 3: Install dependencies and check

```bash
make setup      # .venv with backend deps, npm install, deploy/secrets/aletheia.env from the example
make doctor     # shows what is installed and what each target needs
make check      # offline: parser packs + engine + studio + frontend tests
```

### Step 4: Run

```bash
make services   # datastores in Docker, waits for health, creates the Redpanda topics
make dev        # engine worker + Studio + frontend, natively (also starts services if not up)
```

| What | URL |
| :--- | :--- |
| Landing page | <http://localhost:5173> |
| Dashboard | <http://localhost:5173/dashboard> |
| Studio API | <http://localhost:8081> |
| Grafana (admin / `aletheia`) | <http://localhost:3000> |

`Ctrl+C` stops the native processes; `make services-down` stops the datastores. `make help` lists every
target. `make studio`, `make frontend` and `make worker` run one piece each.

Optional extras:

```bash
make seed       # fresh demo: wipes data, sets Gemini from aletheia.env, connects two demo log
                # servers, seeds alert rules. Run it before `make dev`
make gens       # six live log generator servers on :9101-9106 to connect as sources
```

With `ufw` active on Linux, allow Grafana (in Docker) to call Studio back for browser alerts — see
[docs/alerting.md](docs/alerting.md#troubleshooting). Email alerts need `ALETHEIA_SMTP_*` set before
`make services`.

---

## 3. Windows from source

The same development setup as Section 2, run from **PowerShell**. If you only want to use Aletheia,
the [Docker image](#1-docker-recommended) is simpler. With WSL2 you can also follow the
[Linux steps](#2-linux--macos-from-source) inside an Ubuntu shell.

### Requirements

| Tool | Version | Install |
| :--- | :--- | :--- |
| Docker Desktop | current | [docker.com](https://www.docker.com/products/docker-desktop/) — give it 8 GB of memory |
| Git | any | [git-scm.com](https://git-scm.com/download/win) |
| Python | 3.10+ | [python.org](https://www.python.org/downloads/) — tick **Add python.exe to PATH** |
| Node.js | 18+ LTS | [nodejs.org](https://nodejs.org) |
| Go | 1.23+ (for the engine worker) | [go.dev/dl](https://go.dev/dl/) |

Open a new PowerShell window after installing so the tools are on `PATH`, then check:
`docker version; python --version; node --version; go version`.

### Step 1: Clone

```powershell
git clone https://github.com/RiteshGadarla/Aletheia.git
cd Aletheia
```

### Step 2: Install dependencies

```powershell
# Python virtual environment with the backend dependencies
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r backend\studio\requirements-dev.txt

# Frontend
cd frontend; npm install; cd ..

# Engine CLI and worker (Go)
New-Item -ItemType Directory -Force bin | Out-Null
cd backend\engine
go build -o ..\..\bin\aletheia.exe .\cmd\aletheia
go build -o ..\..\bin\aletheia-worker.exe .\cmd\worker
cd ..\..

# Local config file (gitignored) and an offline check of every parser pack
Copy-Item deploy\secrets\aletheia.env.example deploy\secrets\aletheia.env
.\.venv\Scripts\python.exe backend\packs\verify_packs.py
```

### Step 3: Start the datastores

```powershell
docker compose -f deploy/docker-compose.services.yml up -d
docker compose -f deploy/docker-compose.services.yml ps     # repeat until all show "healthy"

# Create the bus topics once Redpanda is healthy
foreach ($t in "raw","quarantine","normalized","control","dlq") { docker exec aletheia-services-redpanda-1 rpk topic create $t -p 4 -r 1 }
```

### Step 4: Run Studio, the frontend and the worker

Use three PowerShell windows, each opened in the repository root.

**Window 1 — Studio API (port 8081, hot reload):**

```powershell
$env:ALETHEIA_MODE="lite"
$env:ALETHEIA_PG_DSN="postgres://aletheia:aletheia@127.0.0.1:5432/aletheia"
$env:ALETHEIA_BUS_BROKERS="127.0.0.1:9092"
$env:ALETHEIA_GRAFANA_URL="http://127.0.0.1:3000"
$env:ALETHEIA_GRAFANA_PUBLIC_URL="http://localhost:3000"
$env:ALETHEIA_LOKI_URL="http://127.0.0.1:3100"
$env:ALETHEIA_PROMETHEUS_URL="http://127.0.0.1:9090"
$env:ALETHEIA_ALERT_RECEIVER_URL="http://host.docker.internal:8081"
cd backend
..\.venv\Scripts\python.exe -m uvicorn studio.main:app --reload --host 0.0.0.0 --port 8081
```

It listens on all interfaces so Grafana (in Docker) can deliver browser alerts back to it. If Windows
Firewall asks, allow Python on **private** networks.

**Window 2 — frontend (port 5173, hot reload):**

```powershell
cd frontend
npm run dev
```

**Window 3 — engine worker** (approved sources reach Events, Lineage and Grafana only while it runs):

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

Open **<http://localhost:5173/dashboard>**. Grafana is at <http://localhost:3000> (admin / `aletheia`).

To stop: `Ctrl+C` in each window, then `docker compose -f deploy/docker-compose.services.yml down`.

### Developing in VS Code

`.vscode/` has ready-made tasks (*Terminal → Run Task*) for starting the datastores, Studio and the
frontend and for verifying packs, and a debug configuration **"Studio API (FastAPI Backend)"** (`F5`)
that runs Studio under the Python debugger with breakpoints.

---

## 4. Port map

| Component | Docker image | From source |
| :--- | :--- | :--- |
| Frontend (landing page) | `http://localhost:6156` | `http://localhost:5173` |
| Dashboard | `http://localhost:6156/dashboard` | `http://localhost:5173/dashboard` |
| Studio API | `http://localhost:6156/api/` | `http://localhost:8081` |
| Grafana (admin / `aletheia`) | `http://localhost:6156/grafana/` | `http://localhost:3000` |
| Grafana dashboards | `/grafana/d/aletheia-overview`, `-logs`, `-event`, `-events`, `-pipeline` | `/d/aletheia-overview`, … on `:3000` |
| Syslog input | `udp/tcp :26514`, octet `:26515`, TLS `:26516` | not started |
| ClickHouse HTTP / native | internal | `:8123` / `:9000` |
| PostgreSQL | internal | `:5432` |
| Redpanda (Kafka API) | internal | `:9092` |
| Loki | internal | `:3100` |
| Prometheus | internal | `:9090` |
| Engine worker metrics | internal | `:9108` |
| Supply stream | off by default | `127.0.0.1:9099` when enabled on the Export page |
| Demo log servers | — | `:9101-9106` (`make gens`) |

"Internal" means the service runs inside the container and is not reachable from the host.

---

## 5. Troubleshooting

| Symptom | Fix |
| :--- | :--- |
| Container never becomes `healthy` | Almost always memory: give Docker 8 GB. Then check `docker logs aletheia` |
| `port is already allocated` | Change the host side of the mapping, e.g. `-p 16156:6156` or `-p 36514:5514/udp` |
| Settings and AI key gone after restart | The container ran without `-v aletheia-data:/data`. Recreate it with the volume and save the key again |
| Shell scripts fail in containers with `$'\r': command not found` (Windows) | The repo was checked out with CRLF line endings. Re-checkout once (discards uncommitted changes): `git rm -r --cached . ; git reset --hard` |
| From source: port 8081 or 5173 in use | Frontend: `npm run dev -- --port 5174`. Studio: change `--port 8081` and start the frontend with `VITE_API_TARGET=http://127.0.0.1:<port>` |
| From source: Events stay empty | The engine worker is not running (`make worker`, or Window 3 on Windows) |
| Browser alerts never arrive (Linux, from source) | A firewall blocks Grafana → Studio on 8081; see [docs/alerting.md](docs/alerting.md#troubleshooting) |

For problems after installation (AI provider, Settings, alerts), see
[README → Troubleshooting](README.md#troubleshooting).

---

## Next steps

1. **Connect an AI provider** (optional): Google Gemini or a local model. See
   [README → Connect an AI provider](README.md#connect-an-ai-provider).
2. **Run the guided evaluation** in the Demo Console. See
   [README → Guided evaluation](README.md#guided-evaluation).
3. **Configuration reference** (environment variables, `deploy/secrets/aletheia.env`): see
   [README → Configuration](README.md#configuration).
