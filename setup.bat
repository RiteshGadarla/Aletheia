@echo off
echo ==================================================
echo  Aletheia — Windows Native Setup (Command Prompt)
echo ==================================================
echo.

IF NOT EXIST .venv (
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

IF NOT EXIST deploy\secrets\aletheia.env (
    if not exist deploy\secrets mkdir deploy\secrets
    copy deploy\secrets\aletheia.env.example deploy\secrets\aletheia.env
)

echo Building Go binaries...
if not exist bin mkdir bin
cd backend\engine
go build -o ..\..\bin\aletheia.exe .\cmd\aletheia
go build -o ..\..\bin\aletheia-worker.exe .\cmd\worker
cd ..\..

echo Verifying parser packs...
.venv\Scripts\python.exe backend\packs\verify_packs.py

echo.
echo ==================================================
echo  Setup Complete!
echo ==================================================
pause
