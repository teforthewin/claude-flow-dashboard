# ─────────────────────────────────────────────────────────────────────────────
# Claude Code Flow Dashboard — Start script (Windows PowerShell)
# Creates venv, installs deps, starts the FastAPI server.
# ─────────────────────────────────────────────────────────────────────────────
param(
    [string]$Port = $env:FLOW_SERVER_PORT,
    [string]$LogsDir = $env:FLOW_LOG_DIR,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

$RootDir  = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$DashDir  = Join-Path $RootDir "flow-dashboard"

if ($Help) {
    Write-Host @"
Usage: .\start.ps1 [-Port <port>] [-LogsDir <path>] [-Help]

Options:
  -Port <port>       Server port            (default: 7842)
  -LogsDir <path>    JSONL logs directory   (default: ~/.claude/flow-logs)
  -Help              Show this help

Examples:
  .\start.ps1
  .\start.ps1 -Port 9000
  .\start.ps1 -LogsDir C:\temp\flow-logs -Port 8080
"@
    exit 0
}

if (-not $Port)    { $Port    = "7842" }
if (-not $LogsDir) { $LogsDir = Join-Path $env:USERPROFILE ".claude\flow-logs" }

# ── Python check ─────────────────────────────────────────────────────────────
$Python = $null
foreach ($cmd in @("python3", "python", "py")) {
    try {
        $ver = & $cmd -c "import sys; print(sys.version_info >= (3,11))" 2>$null
        if ($ver -eq "True") {
            $Python = $cmd
            break
        }
    } catch {}
}

if (-not $Python) {
    Write-Host "ERROR: Python 3.11+ is required but not found." -ForegroundColor Red
    Write-Host "Install from https://www.python.org/downloads/"
    exit 1
}

$pyVer = & $Python --version
Write-Host "[info] Using $pyVer"

# ── Virtualenv ───────────────────────────────────────────────────────────────
$Venv      = Join-Path $DashDir ".venv"
$Reqs      = Join-Path $DashDir "requirements.txt"
$Stamp     = Join-Path $Venv ".reqs_hash"
$VenvPy    = Join-Path $Venv "Scripts\python.exe"
$VenvPip   = Join-Path $Venv "Scripts\pip.exe"

if (-not (Test-Path $VenvPy)) {
    Write-Host "[setup] Creating virtualenv in $Venv ..."
    & $Python -m venv $Venv
}

# Install / refresh deps
$Hash = (Get-FileHash $Reqs -Algorithm MD5).Hash
$NeedInstall = $true
if (Test-Path $Stamp) {
    $Saved = Get-Content $Stamp -Raw
    if ($Saved.Trim() -eq $Hash) { $NeedInstall = $false }
}

if ($NeedInstall) {
    Write-Host "[setup] Installing dependencies ..."
    & $VenvPip install -q --upgrade pip
    & $VenvPip install -q -r $Reqs
    Set-Content $Stamp -Value $Hash
}

# ── Start ────────────────────────────────────────────────────────────────────
if (-not (Test-Path $LogsDir)) { New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null }

$env:FLOW_LOG_DIR     = $LogsDir
$env:FLOW_SERVER_PORT = $Port

Write-Host ""
Write-Host "  Flow Dashboard starting on http://localhost:$Port"
Write-Host "  Logs directory: $LogsDir"
Write-Host ""

& $VenvPy (Join-Path $DashDir "flow_server.py")
