# Aletheia — Windows Setup Script (PowerShell)
# Usage:
#   .\setup.ps1                     # Default: Automated Docker Containerized setup (Requires only Docker Engine / Desktop)
#   .\setup.ps1 -Mode Container     # Full Docker containerized stack (UI on :8080, Studio on :8081)
#   .\setup.ps1 -Mode Native        # Native Dev Mode for VS Code (Local Python, Node, Go + Datastores in Docker)

[CmdletBinding()]
param(
    [ValidateSet("Container", "Docker", "Native", "Auto")]
    [string]$Mode = "Container"
)

$ErrorActionPreference = "Stop"

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host " Aletheia — Windows Setup (PowerShell)            " -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

# Normalize Mode alias
if ($Mode -eq "Docker") { $Mode = "Container" }

# Helper: Detect Docker Compose command
function Get-DockerComposeCmd {
    try {
        & docker compose version *>$null
        if ($LASTEXITCODE -eq 0) { return "docker compose" }
    } catch {}
    try {
        & docker-compose version *>$null
        if ($LASTEXITCODE -eq 0) { return "docker-compose" }
    } catch {}
    return $null
}

# Helper: Check if Docker daemon is running
function Test-DockerRunning {
    try {
        & docker info *>$null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

# Helper: Ensure Secrets file exists
function Ensure-AletheiaSecrets {
    $secretsDir = "deploy/secrets"
    $secretsFile = "$secretsDir/aletheia.env"
    $exampleFile = "$secretsDir/aletheia.env.example"

    if (-not (Test-Path $secretsFile)) {
        if (-not (Test-Path $secretsDir)) {
            New-Item -ItemType Directory -Force -Path $secretsDir | Out-Null
        }
        if (Test-Path $exampleFile) {
            Copy-Item $exampleFile $secretsFile
            Write-Host "[✓] Created $secretsFile from template" -ForegroundColor Green
        } else {
            Write-Host "[!] Warning: Template $exampleFile not found" -ForegroundColor Yellow
        }
    } else {
        Write-Host "[✓] Secrets file already exists: $secretsFile" -ForegroundColor Green
    }
}

# Auto-detect mode if set to Auto
if ($Mode -eq "Auto") {
    $hasPython = Get-Command python -ErrorAction SilentlyContinue
    $hasNode   = Get-Command node -ErrorAction SilentlyContinue
    if ($hasPython -and $hasNode) {
        $Mode = "Native"
        Write-Host "[i] Auto-detected local toolchain (Python & Node found). Running Native Dev Mode..." -ForegroundColor Yellow
    } else {
        $Mode = "Container"
        Write-Host "[i] Host toolchain incomplete. Running Docker Containerized Mode..." -ForegroundColor Yellow
    }
}

Ensure-AletheiaSecrets
Write-Host ""

if ($Mode -eq "Container") {
    Write-Host ">>> Mode: Docker Containerized Setup (Zero Host Dependencies)" -ForegroundColor Yellow
    Write-Host ""

    if (-not (Test-DockerRunning)) {
        Write-Host "[X] ERROR: Docker Engine / Docker Desktop is not running on this machine." -ForegroundColor Red
        Write-Host "    Please install/start Docker Desktop for Windows and run this script again." -ForegroundColor Red
        Write-Host "    Download Docker Desktop: https://www.docker.com/products/docker-desktop/" -ForegroundColor Gray
        exit 1
    }

    $composeCmd = Get-DockerComposeCmd
    if (-not $composeCmd) {
        Write-Host "[X] ERROR: 'docker compose' or 'docker-compose' command not found." -ForegroundColor Red
        exit 1
    }

    Write-Host "[✓] Docker is running. Building and launching Aletheia full stack..." -ForegroundColor Green
    Write-Host ""

    if ($composeCmd -eq "docker compose") {
        docker compose -f deploy/docker-compose.yml up -d --build
    } else {
        docker-compose -f deploy/docker-compose.yml up -d --build
    }

    if ($LASTEXITCODE -ne 0) {
        Write-Host "[X] Docker Compose startup failed." -ForegroundColor Red
        exit 1
    }

    Write-Host ""
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host "  Setup Complete! Aletheia services are running:   " -ForegroundColor Cyan
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host "  Frontend Web App:  http://localhost:8080" -ForegroundColor White
    Write-Host "  Studio API Server: http://localhost:8081" -ForegroundColor White
    Write-Host "  Grafana Dashboard: http://localhost:3000" -ForegroundColor White
    Write-Host "  MinIO Storage:     http://localhost:9001" -ForegroundColor White
    Write-Host "  ClickHouse HTTP:   http://localhost:8123" -ForegroundColor White
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host "  To view container status: docker compose -f deploy/docker-compose.yml ps" -ForegroundColor Gray
    Write-Host "  To stop services:         docker compose -f deploy/docker-compose.yml down" -ForegroundColor Gray
    Write-Host ""
    exit 0
}

if ($Mode -eq "Native") {
    Write-Host ">>> Mode: Native Development Setup (VS Code)" -ForegroundColor Yellow
    Write-Host ""

    # Check Python
    try {
        $pyVer = & python --version 2>&1
        Write-Host "[✓] Python found: $pyVer" -ForegroundColor Green
    } catch {
        Write-Host "[X] Python not found. Required for native backend development." -ForegroundColor Red
        Write-Host "    Install Python 3.10+ from python.org (check 'Add python.exe to PATH')" -ForegroundColor Red
        exit 1
    }

    # Check Node & npm
    try {
        $nodeVer = & node --version 2>&1
        Write-Host "[✓] Node.js found: $nodeVer" -ForegroundColor Green
    } catch {
        Write-Host "[X] Node.js not found. Required for native frontend development." -ForegroundColor Red
        Write-Host "    Install Node.js 18+ LTS from nodejs.org" -ForegroundColor Red
        exit 1
    }

    # Check Go
    try {
        $goVer = & go version 2>&1
        Write-Host "[✓] Go found: $goVer" -ForegroundColor Green
    } catch {
        Write-Host "[!] Warning: Go CLI not found in PATH. Go engine build will be skipped." -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "Step 1: Setting up Python Virtual Environment (.venv)..." -ForegroundColor Yellow
    if (-not (Test-Path ".venv")) {
        python -m venv .venv
    }
    & .\.venv\Scripts\python.exe -m pip install --upgrade pip
    & .\.venv\Scripts\pip.exe install -r backend/studio/requirements.txt

    Write-Host ""
    Write-Host "Step 2: Installing Frontend Dependencies..." -ForegroundColor Yellow
    Set-Location frontend
    npm install
    Set-Location ..

    Write-Host ""
    Write-Host "Step 3: Building Go Engine Binaries (bin/aletheia.exe)..." -ForegroundColor Yellow
    if (Get-Command go -ErrorAction SilentlyContinue) {
        New-Item -ItemType Directory -Force -Path "bin" | Out-Null
        Set-Location backend/engine
        go build -o ../../bin/aletheia.exe ./cmd/aletheia
        go build -o ../../bin/aletheia-worker.exe ./cmd/worker
        Set-Location ../..
        Write-Host "[✓] Built bin/aletheia.exe and bin/aletheia-worker.exe" -ForegroundColor Green
    } else {
        Write-Host "[!] Skipping Go build (Go not installed on host)" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "Step 4: Starting Backing Datastores in Docker..." -ForegroundColor Yellow
    if (Test-DockerRunning) {
        $composeCmd = Get-DockerComposeCmd
        if ($composeCmd -eq "docker compose") {
            docker compose -f deploy/docker-compose.services.yml up -d
        } elseif ($composeCmd -eq "docker-compose") {
            docker-compose -f deploy/docker-compose.services.yml up -d
        }
        Write-Host "[✓] Backing services (Postgres, ClickHouse, Redpanda, MinIO) started!" -ForegroundColor Green
    } else {
        Write-Host "[!] Warning: Docker is not running. Datastores skipped. Start Docker Desktop and run: docker compose -f deploy/docker-compose.services.yml up -d" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "Step 5: Verifying Parser Packs..." -ForegroundColor Yellow
    & .\.venv\Scripts\python.exe backend/packs/verify_packs.py

    Write-Host ""
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host " Native Setup Complete! IDE Development Instructions:" -ForegroundColor Cyan
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host "1. Studio API Server (Hot Reload):" -ForegroundColor White
    Write-Host "   .\.venv\Scripts\python.exe -m uvicorn backend.studio.main:app --reload --port 8081" -ForegroundColor Gray
    Write-Host "2. Frontend UI Dev Server (Hot Reload):" -ForegroundColor White
    Write-Host "   cd frontend; npm run dev" -ForegroundColor Gray
    Write-Host "3. Open VS Code:" -ForegroundColor White
    Write-Host "   Use Ctrl+Shift+B or Task runner to launch services directly inside VS Code." -ForegroundColor Gray
    Write-Host "   Open browser at: http://localhost:5173" -ForegroundColor White
    Write-Host ""
}
