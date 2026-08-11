# Start OpenCluely Electron with Clyra API + Gemini vision (via Clyra server).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$App = Join-Path $Root "apps\opencluely"
$env:CLYRA_API_BASE = if ($env:CLYRA_API_BASE) { $env:CLYRA_API_BASE } else { "http://127.0.0.1:31415" }
$env:CLYRA_CONTROL_PORT = if ($env:CLYRA_CONTROL_PORT) { $env:CLYRA_CONTROL_PORT } else { "3847" }
$env:ELECTRON_DISABLE_SECURITY_WARNINGS = "1"
# Clyra may have been started through Electron's Node-mode fallback. The
# nested OpenCluely instance must always boot as an Electron application.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

function Import-DotEnv($path) {
  if (-not (Test-Path $path)) { return }
  Get-Content $path | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
    $parts = $_ -split '=', 2
    $name = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"').Trim("'")
    if ($name) { Set-Item -Path "env:$name" -Value $value }
  }
}

Import-DotEnv (Join-Path $Root ".env.local")
Import-DotEnv (Join-Path $Root ".env")

if (-not $env:GEMINI_API_KEY) {
  Write-Host "WARN: GEMINI_API_KEY is not set — OpenCluely screen vision requires it on the Clyra server."
}

$ElectronBin = Join-Path $App "node_modules\.bin\electron.cmd"
if (-not (Test-Path $ElectronBin)) {
  Write-Error "electron binary missing — run: bash scripts/clone-opencluely.sh"
}

Set-Location $App
& $ElectronBin .
