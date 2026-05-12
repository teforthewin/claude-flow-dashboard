# ─────────────────────────────────────────────────────────────────────────────
# Install Claude Code hooks into a project's .claude/settings.json
# Configures PreToolUse, PostToolUse, and UserPromptSubmit hooks
# to feed into the Flow Dashboard logger.
#
# Usage:
#   .\install-hooks.ps1                       # install in current directory
#   .\install-hooks.ps1 -TargetDir C:\myproj  # install in specified project
# ─────────────────────────────────────────────────────────────────────────────
param(
    [string]$TargetDir = (Get-Location).Path,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

if ($Help) {
    Write-Host @"
Usage: .\install-hooks.ps1 [-TargetDir <path>] [-Help]

Options:
  -TargetDir <path>  Project directory to install hooks in (default: current dir)
  -Help              Show this help
"@
    exit 0
}

$RootDir  = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Logger   = Join-Path $RootDir "flow-dashboard\flow_logger.py"

if (-not (Test-Path $Logger)) {
    Write-Host "ERROR: flow_logger.py not found at $Logger" -ForegroundColor Red
    exit 1
}

$TargetDir    = (Resolve-Path $TargetDir).Path
$SettingsDir  = Join-Path $TargetDir ".claude"
$SettingsFile = Join-Path $SettingsDir "settings.json"

Write-Host "Installing Flow Dashboard hooks"
Write-Host "  Logger:  $Logger"
Write-Host "  Target:  $SettingsFile"
Write-Host ""

if (-not (Test-Path $SettingsDir)) {
    New-Item -ItemType Directory -Path $SettingsDir -Force | Out-Null
}

$Hooks = @{
    UserPromptSubmit = @(
        @{
            hooks = @(
                @{
                    type    = "command"
                    command = "python3 $Logger prompt || true"
                }
            )
        }
    )
    PreToolUse = @(
        @{
            matcher = ".*"
            hooks   = @(
                @{
                    type    = "command"
                    command = "python3 $Logger pre"
                }
            )
        }
    )
    PostToolUse = @(
        @{
            matcher = ".*"
            hooks   = @(
                @{
                    type    = "command"
                    command = "python3 $Logger post"
                }
            )
        }
    )
}

if (Test-Path $SettingsFile) {
    $Settings = Get-Content $SettingsFile -Raw | ConvertFrom-Json -AsHashtable
    $Settings["hooks"] = $Hooks
    Write-Host "Updated existing $SettingsFile"
} else {
    $Settings = @{ hooks = $Hooks }
    Write-Host "Created $SettingsFile"
}

$Settings | ConvertTo-Json -Depth 10 | Set-Content $SettingsFile -Encoding UTF8

Write-Host ""
Write-Host "Done. Hooks installed. Claude Code will now log to the Flow Dashboard."
Write-Host "Start the dashboard with: $RootDir\scripts\start.ps1"
