# Aletheia — Development & Setup Guide (Linux & Native Windows)

This document provides step-by-step instructions to set up, build, test, and run **Aletheia** on both **Linux** and **Native Windows (without Ubuntu / WSL2)**.

---

## 1. System Requirements & Toolchain

### Recommended Hardware
- **CPU**: 4+ cores
- **RAM**: 8 GB minimum (16 GB recommended for full datastore services)
- **Disk**: 10 GB free space

### Required Software (Both Windows & Linux)

| Tool | Minimum Version | Installation Link / Command |
| :--- | :--- | :--- |
| **Python** | `3.10+` | [python.org](https://www.python.org/downloads/) (*Check "Add python.exe to PATH"*) |
| **Node.js** | `18.0+` | [nodejs.org](https://nodejs.org/) (LTS) |
| **npm** | `9.0+` | Included with Node.js |
| **Go** | `1.22+` / `1.23+` | [go.dev](https://go.dev/dl/) |
| **Git** | `2.30+` | [git-scm.com](https://git-scm.com/) |
| **Docker Desktop** | `4.0+` | [docker.com](https://www.docker.com/products/docker-desktop/) *(Optional: Datastores only)* |

---

## 2. Native Windows Setup Guide (Without Ubuntu / WSL2)

You can run Aletheia natively on Windows using **PowerShell** or **Command Prompt** without needing Ubuntu or WSL2.

### Quick Start: Automated Windows Setup Scripts

We provide two pre-configured setup scripts for Windows:

#### Option A: PowerShell Script (`setup.ps1`)
Open **PowerShell** in the project directory and run:
```powershell
.\setup.ps1
```

> *Note*: If PowerShell displays a script execution policy restriction, run:
> `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`

#### Option B: Command Prompt Batch Script (`setup.bat`)
Open **Command Prompt** (or double-click `setup.bat`) in the project directory:
```cmd
setup.bat
```

---

### Step-by-Step Manual Commands for Windows

If you prefer to run the commands manually step-by-step in **PowerShell**:

#### 1. Clone & Open Project
```powershell
git clone https://github.com/Ritesh2006M/Aletheia.git
cd Aletheia
```

#### 2. Create & Activate Python Virtual Environment
```powershell
# Create venv
python -m venv .venv

# Activate venv
.\.venv\Scripts\Activate.ps1

# Upgrade pip & install backend dependencies
python -m pip install --upgrade pip
pip install -r backend/studio/requirements.txt
```

#### 3. Install Frontend Node Dependencies
```powershell
cd frontend
npm install
cd ..
```

#### 4. Configure Local Environment File
```powershell
New-Item -ItemType Directory -Force -Path deploy/secrets
Copy-Item deploy/secrets/aletheia.env.example deploy/secrets/aletheia.env
```

#### 5. Build Go Engine Executables (`.exe`)
```powershell
New-Item -ItemType Directory -Force -Path bin
cd backend/engine
go build -o ../../bin/aletheia.exe ./cmd/aletheia
go build -o ../../bin/aletheia-worker.exe ./cmd/worker
cd ../..
```

#### 6. Verify Parser Packs (Offline Sanity Check)
```powershell
.\.venv\Scripts\python.exe backend/packs/verify_packs.py
```

---

### Running Aletheia on Windows

#### Step 1: Start Datastores in Docker Desktop (Optional but Recommended)
Ensure **Docker Desktop for Windows** is running, then open PowerShell:
```powershell
docker-compose -f docker/docker-compose.yml up -d clickhouse postgres redpanda minio
```

#### Step 2: Start Studio Backend API (Port 8081)
In PowerShell (with `.venv` active):
```powershell
$env:ALETHEIA_MODE="lite"
$env:ALETHEIA_PG_DSN="postgres://aletheia:aletheia@127.0.0.1:5432/aletheia"
.\.venv\Scripts\python.exe -m uvicorn backend.studio.main:app --reload --host 0.0.0.0 --port 8081
```

#### Step 3: Start Frontend Dev Server (Port 5173)
In a **second PowerShell window**:
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

| Component | Host URL / Port | Protocol / Description |
| :--- | :--- | :--- |
| **Frontend Web App** | `http://localhost:5173` | React + Vite UI |
| **Studio API Server** | `http://localhost:8081` | FastAPI Control Plane & Studio |
| **ClickHouse HTTP** | `http://localhost:8123` | Log & Event Columnar Database |
| **ClickHouse Native** | `localhost:9000` | Native TCP interface |
| **PostgreSQL** | `localhost:5432` | Source & Pack Metadata database |
| **Redpanda Kafka API** | `localhost:9092` | Log Message Bus |
| **MinIO Console** | `http://localhost:9001` | Parquet / Object Archive Storage |
| **Syslog Listener** | `udp://localhost:5514` | High-throughput Log Ingestion |

---

## 5. Troubleshooting for Windows Users

### 1. PowerShell Script Execution Error
If PowerShell says `...script cannot be loaded because running scripts is disabled on this system`:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### 2. Go command not recognized (`go : The term 'go' is not recognized...`)
- Ensure Go is installed from [go.dev/dl](https://go.dev/dl/).
- Restart PowerShell after installing Go so your `PATH` environment variable updates.

### 3. Docker Desktop Memory Settings
- Open Docker Desktop Settings $\rightarrow$ Resources $\rightarrow$ Memory.
- Ensure at least **6 GB - 8 GB** of RAM is allocated to Docker Desktop.

### 4. Port Conflicts (`port 8081 or 5173 already in use`)
- Change the frontend port: `npm run dev -- --port 5174`.
- Change the backend port: `.\.venv\Scripts\python.exe -m uvicorn backend.studio.main:app --port 8082`.
