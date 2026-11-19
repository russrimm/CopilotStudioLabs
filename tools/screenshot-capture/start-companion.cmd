@echo off
rem Starts the Local Capture Companion on Windows.
rem Double-click this file, or run it with: start-companion.cmd --portal=<address> --code=<pairing code>
rem To run it from any folder, use its full path (in quotes if the path has spaces).
setlocal
set "COMPANION_LAUNCHER=%~f0"
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 20 or later from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist "node_modules\playwright" (
  echo Installing the companion's browser tools. This happens once.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo npm install did not finish. Check your internet connection and run this again.
    pause
    exit /b 1
  )
)

node companion.mjs --check >nul 2>nul
if errorlevel 1 (
  echo Installing the Chromium browser. This happens once.
  call npx playwright install chromium
)

node companion.mjs %*
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" pause
exit /b %EXITCODE%
