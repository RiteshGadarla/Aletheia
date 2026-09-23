# Aletheia - Windows Setup Script (PowerShell)
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts as ANSI, and UTF-8
# dashes/ticks decode into smart quotes that break string parsing before a single line runs.
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1                 # Docker containerized setup (default)
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Mode Native    # Local Python, Node, Go + datastores in Docker

[CmdletBinding()]
param(
    [ValidateSet("Container", "Docker", "Native", "Auto")]
    [string]$Mode = "Container"
)

$ErrorActionPreference = "Stop"

# Relative paths below assume the repo root, whatever directory the script was started from.
Set-Location -LiteralPath $PSScriptRoot

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host " Aletheia - Windows Setup (PowerShell)" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

# Normalize Mode alias
if ($Mode -eq "Docker") { $Mode = "Container" }

# Helper: run a native command silently and report whether it exited 0.
# EAP=Stop would turn any stderr line (e.g. docker info warnings) into a terminating error in PS 5.1.
function Test-NativeCommand {
    param([string]$Exe, [string[]]$CmdArgs)
    if (-not (Get-Command $Exe -ErrorAction SilentlyContinue)) { return $false }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $Exe @CmdArgs *> $null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    } finally {
        $ErrorActionPreference = $prev
    }
}

# Helper: run a native command in the foreground and stop the script if it fails.
function Invoke-Checked {
    param([string]$Exe, [string[]]$CmdArgs)
    # A missing exe leaves $LASTEXITCODE at its previous value, which could read as success.
    if (-not (Get-Command $Exe -ErrorAction SilentlyContinue)) {
        Write-Host "[X] '$Exe' was not found in PATH." -ForegroundColor Red
        exit 1
    }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & $Exe @CmdArgs } finally { $ErrorActionPreference = $prev }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[X] '$Exe $($CmdArgs -join ' ')' failed (exit code $LASTEXITCODE)." -ForegroundColor Red
        exit 1
    }
}

# Helper: returns the compose invocation as an exe + leading args pair, or $null.
function Get-DockerCompose {
    if (Test-NativeCommand "docker" @("compose", "version")) { return @{ Exe = "docker"; Args = @("compose") } }
    if (Test-NativeCommand "docker-compose" @("version")) { return @{ Exe = "docker-compose"; Args = @() } }
    return $null
}

function Test-DockerRunning { return (Test-NativeCommand "docker" @("info")) }

# Helper: Ensure Secrets file exists
function Initialize-AletheiaSecrets {
    $secretsDir = "deploy/secrets"
    $secretsFile = "$secretsDir/aletheia.env"
    $exampleFile = "$secretsDir/aletheia.env.example"

    if (-not (Test-Path $secretsFile)) {
        if (-not (Test-Path $secretsDir)) {
            New-Item -ItemType Directory -Force -Path $secretsDir | Out-Null
        }
        if (Test-Path $exampleFile) {
            Copy-Item $exampleFile $secretsFile
            Write-Host "[OK] Created $secretsFile from template" -ForegroundColor Green
        } else {
            Write-Host "[!] Warning: Template $exampleFile not found" -ForegroundColor Yellow
        }
    } else {
        Write-Host "[OK] Secrets file already exists: $secretsFile" -ForegroundColor Green
    }
}

# Vector's syslog TLS listener refuses to start without a certificate; mint a demo one
# inside a throwaway container so Windows hosts need no OpenSSL.
function Initialize-VectorTls {
    $tlsDir = Join-Path $PSScriptRoot "deploy\vector\tls"
    if (Test-Path (Join-Path $tlsDir "server.crt")) { return }
    Write-Host "[OK] Generating demo TLS certificate for the syslog listener..." -ForegroundColor Green
    New-Item -ItemType Directory -Force -Path $tlsDir | Out-Null
    $gen = "apk add -q --no-cache openssl >/dev/null && " +
           "openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes " +
           "-keyout /tls/server.key -out /tls/server.crt -subj /CN=aletheia " +
           "-addext subjectAltName=DNS:aletheia,DNS:localhost,IP:127.0.0.1 && " +
           "cp /tls/server.crt /tls/ca.crt && chmod 644 /tls/*"
    Invoke-Checked "docker" @("run", "--rm", "-v", "${tlsDir}:/tls", "alpine:3.20", "sh", "-c", $gen)
}

# Auto-detect mode if set to Auto
if ($Mode -eq "Auto") {
    if ((Test-NativeCommand "python" @("--version")) -and (Test-NativeCommand "node" @("--version"))) {
        $Mode = "Native"
        Write-Host "[i] Auto-detected local toolchain (Python & Node found). Running Native Dev Mode..." -ForegroundColor Yellow
    } else {
        $Mode = "Container"
        Write-Host "[i] Host toolchain incomplete. Running Docker Containerized Mode..." -ForegroundColor Yellow
    }
}

Initialize-AletheiaSecrets
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

    $compose = Get-DockerCompose
    if (-not $compose) {
        Write-Host "[X] ERROR: 'docker compose' or 'docker-compose' command not found." -ForegroundColor Red
        exit 1
    }

    Initialize-VectorTls

    Write-Host "[OK] Docker is running. Building and launching Aletheia full stack (first build takes several minutes)..." -ForegroundColor Green
    Write-Host ""
    Invoke-Checked $compose.Exe ($compose.Args + @("-f", "deploy/docker-compose.yml", "up", "-d", "--build"))

    Write-Host ""
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host "  Setup Complete! Aletheia services are running:" -ForegroundColor Cyan
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host "  Frontend Web App:  http://localhost:8080" -ForegroundColor White
    Write-Host "  Grafana Dashboard: http://localhost:3000" -ForegroundColor White
    Write-Host "  ClickHouse HTTP:   http://localhost:8123" -ForegroundColor White
    Write-Host "  (Studio API is reachable via the Frontend Web App proxy)" -ForegroundColor Gray
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host "  To view container status: docker compose -f deploy/docker-compose.yml ps" -ForegroundColor Gray
    Write-Host "  To stop services:         docker compose -f deploy/docker-compose.yml down" -ForegroundColor Gray
    Write-Host ""
    exit 0
}

if ($Mode -eq "Native") {
    Write-Host ">>> Mode: Native Development Setup (VS Code)" -ForegroundColor Yellow
    Write-Host ""

    # Running python (not just Get-Command) rules out the Microsoft Store "python" stub.
    if (-not (Test-NativeCommand "python" @("--version"))) {
        Write-Host "[X] Python not found. Required for native backend development." -ForegroundColor Red
        Write-Host "    Install Python 3.10+ from python.org (check 'Add python.exe to PATH')" -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] Python found: $(python --version)" -ForegroundColor Green

    if (-not (Test-NativeCommand "node" @("--version"))) {
        Write-Host "[X] Node.js not found. Required for native frontend development." -ForegroundColor Red
        Write-Host "    Install Node.js 18+ LTS from nodejs.org" -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] Node.js found: $(node --version)" -ForegroundColor Green

    $hasGo = Test-NativeCommand "go" @("version")
    if ($hasGo) {
        Write-Host "[OK] Go found: $(go version)" -ForegroundColor Green
    } else {
        Write-Host "[!] Warning: Go CLI not found in PATH. Go engine build will be skipped." -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "Step 1: Setting up Python Virtual Environment (.venv)..." -ForegroundColor Yellow
    if (-not (Test-Path ".venv/Scripts/python.exe")) {
        Invoke-Checked "python" @("-m", "venv", ".venv")
    }
    $venvPy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
    Invoke-Checked $venvPy @("-m", "pip", "install", "--upgrade", "pip")
    Invoke-Checked $venvPy @("-m", "pip", "install", "-r", "backend/studio/requirements-dev.txt")

    Write-Host ""
    Write-Host "Step 2: Installing Frontend Dependencies..." -ForegroundColor Yellow
    Push-Location frontend
    try { Invoke-Checked "npm" @("install") } finally { Pop-Location }

    Write-Host ""
    Write-Host "Step 3: Building Go Engine Binaries (bin/aletheia.exe)..." -ForegroundColor Yellow
    if ($hasGo) {
        New-Item -ItemType Directory -Force -Path "bin" | Out-Null
        Push-Location backend/engine
        try {
            Invoke-Checked "go" @("build", "-o", "../../bin/aletheia.exe", "./cmd/aletheia")
            Invoke-Checked "go" @("build", "-o", "../../bin/aletheia-worker.exe", "./cmd/worker")
        } finally { Pop-Location }
        Write-Host "[OK] Built bin/aletheia.exe and bin/aletheia-worker.exe" -ForegroundColor Green
    } else {
        Write-Host "[!] Skipping Go build (Go not installed on host)" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "Step 4: Starting Backing Datastores in Docker..." -ForegroundColor Yellow
    $compose = if (Test-DockerRunning) { Get-DockerCompose } else { $null }
    if ($compose) {
        Invoke-Checked $compose.Exe ($compose.Args + @("-f", "deploy/docker-compose.services.yml", "up", "-d"))
        Write-Host "[OK] Backing services (Postgres, ClickHouse, Redpanda, MinIO) started!" -ForegroundColor Green
    } else {
        Write-Host "[!] Warning: Docker is not running. Datastores skipped. Start Docker Desktop and run: docker compose -f deploy/docker-compose.services.yml up -d" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "Step 5: Verifying Parser Packs..." -ForegroundColor Yellow
    Invoke-Checked $venvPy @("backend/packs/verify_packs.py")

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
