@echo off
setlocal enabledelayedexpansion

rem Run from the repo root even when launched elsewhere ("Run as administrator" starts in System32).
cd /d "%~dp0"

echo ==================================================
echo  Aletheia - Windows Setup Script (Command Prompt)
echo ==================================================
echo.

set "MODE=container"
if /I "%~1"=="native" set "MODE=native"
if /I "%~1"=="docker" set "MODE=container"
if /I "%~1"=="container" set "MODE=container"

rem Ensure Secrets configuration file exists
if exist "deploy\secrets\aletheia.env" goto secrets_ok
if not exist "deploy\secrets" mkdir "deploy\secrets"
if not exist "deploy\secrets\aletheia.env.example" goto secrets_missing
copy "deploy\secrets\aletheia.env.example" "deploy\secrets\aletheia.env" >nul
echo [OK] Created deploy\secrets\aletheia.env from template
goto secrets_done
:secrets_missing
echo [WARN] Template deploy\secrets\aletheia.env.example not found
goto secrets_done
:secrets_ok
echo [OK] Secrets file already exists: deploy\secrets\aletheia.env
:secrets_done

if "%MODE%"=="native" goto native

rem ---------------- Docker containerized mode ----------------
echo.
echo ^>^>^> Mode: Docker Containerized Setup ^(Zero Host Dependencies^)
echo.

call :detect_docker
if errorlevel 1 goto fail

call :ensure_tls
if errorlevel 1 goto fail

echo [OK] Launching Aletheia full stack via Docker ^(first build takes several minutes^)...
%COMPOSE_CMD% -f deploy\docker-compose.yml up -d --build
if errorlevel 1 (
    echo [X] Docker Compose execution failed. See the output above.
    goto fail
)

echo.
echo ==================================================
echo  Setup Complete. Aletheia services are running:
echo ==================================================
echo  Frontend Web App:  http://localhost:8080
echo  Grafana Dashboard: http://localhost:3000
echo  ClickHouse HTTP:   http://localhost:8123
echo  ^(Studio API is reachable via the Frontend Web App proxy^)
echo ==================================================
echo  Status:  %COMPOSE_CMD% -f deploy\docker-compose.yml ps
echo  To stop: %COMPOSE_CMD% -f deploy\docker-compose.yml down
echo.
pause
exit /b 0

rem ---------------- Native development mode ----------------
:native
echo.
echo ^>^>^> Mode: Native Development Setup ^(VS Code^)
echo.

rem "where python" also matches the Microsoft Store stub, so actually run it.
python --version >nul 2>&1
if errorlevel 1 (
    echo [X] Python not found. Install Python 3.10+ from python.org ^(tick "Add python.exe to PATH"^)
    goto fail
)

node --version >nul 2>&1
if errorlevel 1 (
    echo [X] Node.js not found. Please install Node.js 18+ from nodejs.org
    goto fail
)

if not exist ".venv\Scripts\python.exe" (
    echo Creating Python virtual environment...
    python -m venv .venv
    if errorlevel 1 goto fail
)

echo Upgrading pip and installing backend requirements...
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 goto fail
".venv\Scripts\python.exe" -m pip install -r backend\studio\requirements-dev.txt
if errorlevel 1 goto fail

echo Installing frontend dependencies...
pushd frontend
call npm install
set "NPM_RC=!errorlevel!"
popd
if not "!NPM_RC!"=="0" goto fail

go version >nul 2>&1
if errorlevel 1 (
    echo [WARN] Skipping Go build ^(Go CLI not found in PATH^)
    goto native_datastores
)
echo Building Go engine binaries...
if not exist bin mkdir bin
pushd backend\engine
go build -o ..\..\bin\aletheia.exe .\cmd\aletheia
set "GO_RC=!errorlevel!"
if "!GO_RC!"=="0" go build -o ..\..\bin\aletheia-worker.exe .\cmd\worker
if "!GO_RC!"=="0" set "GO_RC=!errorlevel!"
popd
if not "!GO_RC!"=="0" goto fail

:native_datastores
echo Starting backing datastores in Docker...
call :detect_docker
if errorlevel 1 (
    echo [WARN] Datastores skipped. Start Docker Desktop, then run:
    echo     docker compose -f deploy\docker-compose.services.yml up -d
) else (
    %COMPOSE_CMD% -f deploy\docker-compose.services.yml up -d
)

echo Verifying parser packs...
".venv\Scripts\python.exe" backend\packs\verify_packs.py

echo.
echo ==================================================
echo  Native Setup Complete. IDE Run Commands:
echo ==================================================
echo  Backend Studio API:
echo    .\.venv\Scripts\python.exe -m uvicorn backend.studio.main:app --reload --port 8081
echo  Frontend Web App:
echo    cd frontend ^&^& npm run dev
echo ==================================================
echo.
pause
exit /b 0

rem ---------------- helpers ----------------
:detect_docker
docker info >nul 2>&1
if errorlevel 1 (
    echo [X] ERROR: Docker Engine / Docker Desktop is not running on this system.
    echo     Please start Docker Desktop for Windows and try again.
    exit /b 1
)
set "COMPOSE_CMD=docker compose"
docker compose version >nul 2>&1
if not errorlevel 1 exit /b 0
set "COMPOSE_CMD=docker-compose"
docker-compose version >nul 2>&1
if not errorlevel 1 exit /b 0
echo [X] ERROR: neither "docker compose" nor "docker-compose" is available.
exit /b 1

rem Vector's syslog TLS listener refuses to start without a certificate; mint a demo one
rem inside a throwaway container so Windows hosts need no OpenSSL.
:ensure_tls
if exist "deploy\vector\tls\server.crt" exit /b 0
echo [OK] Generating demo TLS certificate for the syslog listener...
if not exist "deploy\vector\tls" mkdir "deploy\vector\tls"
docker run --rm -v "%CD%\deploy\vector\tls:/tls" alpine:3.20 sh -c "apk add -q --no-cache openssl >/dev/null && openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes -keyout /tls/server.key -out /tls/server.crt -subj /CN=aletheia -addext subjectAltName=DNS:aletheia,DNS:localhost,IP:127.0.0.1 && cp /tls/server.crt /tls/ca.crt && chmod 644 /tls/*"
if errorlevel 1 (
    echo [X] Could not generate the TLS certificate.
    exit /b 1
)
exit /b 0

:fail
echo.
echo Setup did not finish. Fix the error above and run setup.bat again.
pause
exit /b 1
