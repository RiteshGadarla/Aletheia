# Aletheia — Windows Native Setup Script (PowerShell)
# Run this in PowerShell from the project root directory (No WSL / No Ubuntu required).

$ErrorActionPreference = "Stop"

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host " Aletheia — Windows Setup (Native PowerShell)     " -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Check Python
try {
    $pyVer = & python --version 2>&1
    Write-Host "[✓] Python found: $pyVer" -ForegroundColor Green
} catch {
    Write-Host "[X] Python not found. Please install Python 3.10+ from python.org" -ForegroundColor Red
    exit 1
}

# 2. Check Node & npm
try {
    $nodeVer = & node --version 2>&1
    Write-Host "[✓] Node.js found: $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "[X] Node.js not found. Please install Node.js 18+ from nodejs.org" -ForegroundColor Red
    exit 1
}

# 3. Check Go
try {
    $goVer = & go version 2>&1
    Write-Host "[✓] Go found: $goVer" -ForegroundColor Green
} catch {
    Write-Host "[!] Warning: Go not found in PATH. Make engine target will be skipped." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Step 1: Setting up Python Virtual Environment (.venv)..." -ForegroundColor Yellow
if (-not (Test-Path ".venv")) {
    python -m venv .venv
}
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\pip.exe install -r backend/studio/requirements.txt

Write-Host ""
Write-Host "Step 2: Installing Frontend Node Modules..." -ForegroundColor Yellow
Set-Location frontend
npm install
Set-Location ..

Write-Host ""
Write-Host "Step 3: Creating Local Secrets Configuration..." -ForegroundColor Yellow
if (-not (Test-Path "deploy/secrets/aletheia.env")) {
    New-Item -ItemType Directory -Force -Path "deploy/secrets" | Out-Null
    Copy-Item "deploy/secrets/aletheia.env.example" "deploy/secrets/aletheia.env"
    Write-Host "[✓] Created deploy/secrets/aletheia.env" -ForegroundColor Green
} else {
    Write-Host "[✓] deploy/secrets/aletheia.env already exists" -ForegroundColor Green
}

Write-Host ""
Write-Host "Step 4: Building Go Engine Binaries (bin/aletheia.exe)..." -ForegroundColor Yellow
if (Get-Command go -ErrorAction SilentlyContinue) {
    New-Item -ItemType Directory -Force -Path "bin" | Out-Null
    Set-Location backend/engine
    go build -o ../../bin/aletheia.exe ./cmd/aletheia
    go build -o ../../bin/aletheia-worker.exe ./cmd/worker
    Set-Location ../..
    Write-Host "[✓] Built bin/aletheia.exe and bin/aletheia-worker.exe" -ForegroundColor Green
} else {
    Write-Host "[!] Skipping Go engine build (Go not installed)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Step 5: Verifying Parser Packs..." -ForegroundColor Yellow
& .\.venv\Scripts\python.exe backend/packs/verify_packs.py

Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host " Setup Complete! Next steps for Windows:           " -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "1. Datastores (Docker Desktop):" -ForegroundColor White
Write-Host "   docker-compose -f docker/docker-compose.yml up -d clickhouse postgres redpanda minio" -ForegroundColor Gray
Write-Host "2. Start Backend Studio API:" -ForegroundColor White
Write-Host "   .\.venv\Scripts\python.exe -m uvicorn backend.studio.main:app --reload --port 8081" -ForegroundColor Gray
Write-Host "3. Start Frontend UI:" -ForegroundColor White
Write-Host "   cd frontend; npm run dev" -ForegroundColor Gray
Write-Host ""
