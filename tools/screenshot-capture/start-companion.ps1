# Starts the Local Capture Companion on Windows (PowerShell).
# Run: .\start-companion.ps1 --portal=<address> --code=<pairing code>
# To run it from any folder, use its full path: & '<full path>\start-companion.ps1' --portal=<address> --code=<pairing code>
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js is not installed. Install Node.js 20 or later from https://nodejs.org and run this again.'
  exit 1
}

if (-not (Test-Path 'node_modules/playwright')) {
  Write-Host "Installing the companion's browser tools. This happens once."
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'npm install did not finish. Check your internet connection and run this again.'
    exit 1
  }
}

node companion.mjs --check *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Installing the Chromium browser. This happens once.'
  npx playwright install chromium
}

# The companion prints this path so the person can start it again from any folder.
$env:COMPANION_LAUNCHER = $PSCommandPath
node companion.mjs @args
$exitCode = $LASTEXITCODE
Remove-Item Env:COMPANION_LAUNCHER -ErrorAction SilentlyContinue
exit $exitCode
