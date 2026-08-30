@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PY=python"
where python >nul 2>&1 || set "PY=py"

where uv >nul 2>&1
if errorlevel 1 (
  echo uv not found. Install from https://github.com/astral-sh/uv then retry.
  echo Falling back to pip + uvicorn if packages exist...
)

if exist "%~dp0.venv\Scripts\python.exe" (
  set "PY=%~dp0.venv\Scripts\python.exe"
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

for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"TCP.*:8000 .*LISTENING"') do taskkill /f /pid %%p >nul 2>&1

start "junction-api" /D "%~dp0" cmd /k uv run python server.py
timeout /t 2 /nobreak >nul
start "junction-ui" /D "%~dp0frontend" cmd /k npm run dev -- --host 0.0.0.0

echo.
echo Backend:  http://localhost:8000/docs
echo Frontend: http://localhost:5173
echo Capture:  http://localhost:5173/capture/north  (and east/south/west)
echo Slack webhook: https://YOUR-TUNNEL/slack/events
echo.
echo On phones use your PC LAN IP instead of localhost.
pause
