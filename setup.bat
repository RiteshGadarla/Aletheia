@echo off
setlocal enabledelayedexpansion

echo ==================================================
echo  Aletheia — Windows Setup Script (Command Prompt)
echo ==================================================
echo.

set MODE=container
if /I "%~1"=="native" set MODE=native
if /I "%~1"=="docker" set MODE=container
if /I "%~1"=="container" set MODE=container

rem Ensure Secrets configuration file exists
if not exist deploy\secrets\aletheia.env (
    if not exist deploy\secrets mkdir deploy\secrets
    if exist deploy\secrets\aletheia.env.example (
        copy deploy\secrets\aletheia.env.example deploy\secrets\aletheia.env >nul
        echo [✓] Created deploy\secrets\aletheia.env from template
    )
) else (
    echo [✓] Secrets file already exists: deploy\secrets\aletheia.env
)

if "%MODE%"=="container" (
    echo.
    echo >>> Mode: Docker Containerized Setup (Zero Host Dependencies)
    echo.
    
    docker info >nul 2>&1
    if errorlevel 1 (
        echo [X] ERROR: Docker Engine / Docker Desktop is not running on this system.
        echo     Please start Docker Desktop for Windows and try again.
        echo.
        pause
        exit /b 1
    )

    set COMPOSE_CMD=docker compose
    docker compose version >nul 2>&1
    if errorlevel 1 (
        set COMPOSE_CMD=docker-compose
    )

    echo [✓] Launching Aletheia full stack via Docker...
    !COMPOSE_CMD! -f deploy\docker-compose.yml up -d --build
    if errorlevel 1 (
        echo [X] Docker Compose execution failed.
        pause
        exit /b 1
    )

    echo.
    echo ==================================================
    echo  Setup Complete! Aletheia services are running:
    echo ==================================================
    echo  Frontend Web App:  http://localhost:8080
    echo  Studio API Server: http://localhost:8081
    echo  Grafana Dashboard: http://localhost:3000
    echo  MinIO Storage:     http://localhost:9001
    echo  ClickHouse HTTP:   http://localhost:8123
    echo ==================================================
    echo  To stop: !COMPOSE_CMD! -f deploy\docker-compose.yml down
    echo.
    pause
    exit /b 0
)

if "%MODE%"=="native" (
    echo.
    echo >>> Mode: Native Development Setup (VS Code)
    echo.

    where python >nul 2>&1
    if errorlevel 1 (
        echo [X] Python not found. Please install Python 3.10+ from python.org
        pause
        exit /b 1
    )

    where node >nul 2>&1
    if errorlevel 1 (
        echo [X] Node.js not found. Please install Node.js 18+ from nodejs.org
        pause
        exit /b 1
    )

    if not exist .venv (
        echo Creating Python virtual environment...
        python -m venv .venv
    )

    echo Upgrading pip and installing backend requirements...
    .venv\Scripts\python.exe -m pip install --upgrade pip
    .venv\Scripts\pip.exe install -r backend\studio\requirements.txt

    echo Installing frontend dependencies...
    cd frontend
    call npm install
    cd ..

    where go >nul 2>&1
    if not errorlevel 1 (
        echo Building Go engine binaries...
        if not exist bin mkdir bin
        cd backend\engine
        go build -o ..\..\bin\aletheia.exe .\cmd\aletheia
        go build -o ..\..\bin\aletheia-worker.exe .\cmd\worker
        cd ..\..
    ) else (
        echo [!] Skipping Go build (Go CLI not found in PATH)
    )

    echo Starting backing datastores in Docker...
    docker info >nul 2>&1
    if not errorlevel 1 (
        set COMPOSE_CMD=docker compose
        docker compose version >nul 2>&1
        if errorlevel 1 set COMPOSE_CMD=docker-compose
        !COMPOSE_CMD! -f deploy\docker-compose.services.yml up -d
    )

    echo Verifying parser packs...
    .venv\Scripts\python.exe backend\packs\verify_packs.py

    echo.
    echo ==================================================
    echo  Native Setup Complete! IDE Run Commands:
    echo ==================================================
    echo  Backend Studio API:
    echo    .\.venv\Scripts\python.exe -m uvicorn backend.studio.main:app --reload --port 8081
    echo  Frontend Web App:
    echo    cd frontend ^&& npm run dev
    echo ==================================================
    echo.
    pause
    exit /b 0
)
