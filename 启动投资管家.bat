@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [Error] Node.js not found in PATH.
  echo Please install Node.js from https://nodejs.org
  pause
  exit /b 1
)
echo ============================================
echo   Investment Manager is running...
echo   Open: http://localhost:8080
echo   Close this window to stop the server.
echo ============================================
start "" http://localhost:8080
node server.js
pause
