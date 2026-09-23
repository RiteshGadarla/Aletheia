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
4. Serves the **Aletheia UI on `http://localhost:8080`**, Studio API through the UI proxy, and Grafana on `http://localhost:3000`.

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
1. Creates Python `.venv` virtual environment and installs backend dependencies (`backend/studio/requirements.txt`).
2. Installs frontend Node modules (`frontend/node_modules`).
3. Compiles Go engine binaries into `bin/aletheia.exe` and `bin/aletheia-worker.exe` (if Go is installed).
4. Generates local secrets (`deploy/secrets/aletheia.env`).
5. Starts backing datastores (PostgreSQL, ClickHouse, Redpanda, MinIO) via Docker (`deploy/docker-compose.services.yml`).
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
```

**Step 2: Start Studio Backend API (Port 8081 with Hot Reload)**
```powershell
$env:ALETHEIA_MODE="lite"
$env:ALETHEIA_PG_DSN="postgres://aletheia:aletheia@127.0.0.1:5432/aletheia"
.\.venv\Scripts\python.exe -m uvicorn backend.studio.main:app --reload --host 0.0.0.0 --port 8081
```

**Step 3: Start Frontend Dev Server (Port 5173 with Hot Reload)**
In a second terminal window:
```powershell
cd frontend
npm run dev
```

Open your browser at **`http://localhost:5173`**.

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
make setup
make check
```

### Step 4: Run Application
```bash
# Datastores in Docker
make services

# Native engine + Studio + Frontend
make dev
```

---

## 4. Service Endpoints & Port Map

| Component | Container Mode URL | Native Dev Mode URL | Description |
| :--- | :--- | :--- | :--- |
| **Frontend Web App** | `http://localhost:8080` | `http://localhost:5173` | React + Vite UI |
| **Studio API Server** | `http://localhost:8081` | `http://localhost:8081` | FastAPI Control Plane & Studio |
| **ClickHouse HTTP** | `http://localhost:8123` | `http://localhost:8123` | Log & Event Columnar Database |
| **ClickHouse Native** | `localhost:9000` | `localhost:9000` | Native TCP interface |
| **PostgreSQL** | `localhost:5432` | `localhost:5432` | Source & Pack Metadata database |
| **Redpanda Kafka API** | `localhost:9092` | `localhost:9092` | Log Message Bus |
| **MinIO Console** | `http://localhost:9001` | `http://localhost:9001` | Parquet / Object Archive Storage |
| **Grafana Dashboard** | `http://localhost:3000` | `http://localhost:3000` | Observability & Metrics |
| **Syslog Listener** | `udp://localhost:5514` | `udp://localhost:5514` | Log Ingestion Port |

---

## 5. Troubleshooting for Windows Users

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
