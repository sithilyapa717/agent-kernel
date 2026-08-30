@echo off
setlocal EnableExtensions
title Allow phones to reach the junction demo

net session >nul 2>&1
if errorlevel 1 (
  echo Asking for administrator rights ^(needed to open the firewall^)...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

echo Opening Windows Firewall for the demo ports...
netsh advfirewall firewall delete rule name="junction-ui-http" >nul 2>&1
netsh advfirewall firewall delete rule name="junction-phone-https" >nul 2>&1
netsh advfirewall firewall delete rule name="junction-api" >nul 2>&1

netsh advfirewall firewall add rule name="junction-ui-http" dir=in action=allow protocol=TCP localport=5173 profile=private,domain
netsh advfirewall firewall add rule name="junction-phone-https" dir=in action=allow protocol=TCP localport=5174 profile=private,domain
netsh advfirewall firewall add rule name="junction-api" dir=in action=allow protocol=TCP localport=8000 profile=private,domain

echo.
echo Done. Your Wi-Fi must be set to "Private network" for these rules to apply.
echo.
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /c:"IPv4 Address"') do echo Phone camera: https://%%i:5174/capture/north
echo.
echo On the phone: Advanced -^> Proceed, then Allow camera.
pause
