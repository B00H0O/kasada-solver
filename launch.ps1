$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js 20+ not found - install it from https://nodejs.org first." -ForegroundColor Red
    exit 1
}

if (-not $env:CHROME_BIN) {
    $paths = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    foreach ($p in $paths) { if (Test-Path $p) { $env:CHROME_BIN = $p; break } }
}

if (-not (Test-Path "$scriptDir\node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Cyan
    npm install
    if (-not $?) { exit 1 }
}

if (-not $env:PORT) { $env:PORT = "8787" }
if (-not $env:MAX_CONCURRENT) { $env:MAX_CONCURRENT = "2" }
if (-not $env:HIDDEN) { $env:HIDDEN = "1" }

Write-Host "Starting Kasada Solver on port $env:PORT (MAX_CONCURRENT=$env:MAX_CONCURRENT)" -ForegroundColor Green
node server.mjs
