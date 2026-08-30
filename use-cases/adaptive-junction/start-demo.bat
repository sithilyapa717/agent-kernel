@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo === Adaptive Junction — check / install / run ===
echo.

if not exist "%~dp0server.py" (
  echo server.py is missing. Copy all 5 person folders into this directory first.
  pause
  exit /b 1
)

set "VENV_PY=%~dp0.venv\Scripts\python.exe"

REM --- Python ---
set "PY=python"
where python >nul 2>&1
if errorlevel 1 (
  where py >nul 2>&1
  if errorlevel 1 (
    echo Python not found. Install Python 3.12+ from https://www.python.org/downloads/
    echo Enable "Add python.exe to PATH", then run this file again.
    pause
    exit /b 1
  )
  set "PY=py -3"
)
echo [ok] Python

REM --- Node / npm ---
where npm >nul 2>&1
if errorlevel 1 (
  echo npm not found. Install Node.js from https://nodejs.org/ then retry.
  pause
  exit /b 1
)
echo [ok] npm

REM Always use a local venv so the API window does not depend on uv being on PATH
if not exist "%VENV_PY%" (
  echo Creating .venv ...
  %PY% -m venv "%~dp0.venv"
  if errorlevel 1 (
    echo Could not create .venv
    pause
    exit /b 1
  )
)

echo Installing / updating Python packages...
"%VENV_PY%" -m pip install -U pip
REM Dashboard needs these even if Agent Kernel is slow to install
"%VENV_PY%" -m pip install fastapi uvicorn sqlalchemy pydantic websockets python-multipart
"%VENV_PY%" -m pip install "agentkernel[cli,openai,api,slack]>=0.8.1"
if errorlevel 1 (
  echo Warning: agentkernel install failed. Dashboard can still run in pitch mode.
)

"%VENV_PY%" -c "import fastapi,uvicorn,sqlalchemy,pydantic" >nul 2>&1
if errorlevel 1 (
  echo Required packages failed to import. Check internet and Python 3.12+.
  pause
  exit /b 1
)
echo [ok] Python packages

if not exist "%~dp0frontend\package.json" (
  echo frontend\package.json missing.
  pause
  exit /b 1
)

if not exist "%~dp0frontend\node_modules\" (
  echo Installing frontend packages...
  pushd "%~dp0frontend"
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    popd
    pause
    exit /b 1
  )
  popd
)
echo [ok] Frontend

for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"TCP.*:8000 .*LISTENING"') do taskkill /f /pid %%p >nul 2>&1

echo.
echo Starting API on port 8000 ^(leave that window open^)...
start "junction-api" /D "%~dp0" "%VENV_PY%" -u server.py

echo Waiting for API...
set /a _n=0
:waitapi
set /a _n+=1
if !_n! GTR 45 (
  echo API did not start. Open the "junction-api" window and read the error.
  pause
  exit /b 1
)
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/api/health | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto waitapi
)
echo [ok] API is up

echo Starting UI...
start "junction-ui" /D "%~dp0frontend" cmd /k npm run dev -- --host 0.0.0.0
start "junction-ui-phone" /D "%~dp0frontend" cmd /k npm run dev:lan

netsh advfirewall firewall show rule name="junction-phone-https" >nul 2>&1
if errorlevel 1 (
  echo.
  echo NOTE: phones are still blocked by Windows Firewall.
  echo Run allow-phone.bat once ^(it asks for admin^) to open ports 5173/5174/8000.
)

echo.
echo Roboflow: start the Windows Inference Server app so it listens on :9001
echo           then put ROBOFLOW_API_KEY in use-cases\adaptive-junction\.env
echo Backend:  http://localhost:8000/docs
echo This PC:  http://localhost:5173
echo Phones:   https://THIS-PC-LAN-IP:5174/capture/north
echo           ^(Chrome: Advanced -^> Proceed, THEN Allow camera. http://LAN never prompts.^)
echo.
echo Leave BOTH extra windows open. Pitch UI needs no API keys.
pause
