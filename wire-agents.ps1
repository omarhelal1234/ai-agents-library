# wire-agents.ps1
# Copies every category agent (top-level .md files under each domain folder) into
# %USERPROFILE%\.claude\agents so Claude Code can discover them.
#
# Usage (from PowerShell, in this folder):
#   .\wire-agents.ps1
# To also include the integrations/ wrappers (cursor/copilot/etc are skipped — claude-code only):
#   .\wire-agents.ps1 -IncludeIntegrations

param(
    [switch]$IncludeIntegrations
)

$ErrorActionPreference = "Stop"

$src = $PSScriptRoot
$dst = Join-Path $env:USERPROFILE ".claude\agents"

Write-Host "Source : $src"
Write-Host "Target : $dst"
Write-Host ""

if (-not (Test-Path $dst)) {
    Write-Host "Creating $dst"
    New-Item -ItemType Directory -Path $dst -Force | Out-Null
}

# Category folders to install (top-level domain folders only).
$categories = @(
    "academic","design","engineering","finance","game-development",
    "marketing","paid-media","product","project-management","sales",
    "spatial-computing","specialized","strategy","support","testing"
)

$count = 0
foreach ($cat in $categories) {
    $catPath = Join-Path $src $cat
    if (-not (Test-Path $catPath)) { continue }
    Get-ChildItem -Path $catPath -Filter *.md -File -Recurse | ForEach-Object {
        Copy-Item $_.FullName -Destination $dst -Force
        $count++
    }
}

if ($IncludeIntegrations) {
    $intPath = Join-Path $src "integrations\claude-code"
    if (Test-Path $intPath) {
        Get-ChildItem -Path $intPath -Filter *.md -File | ForEach-Object {
            Copy-Item $_.FullName -Destination $dst -Force
            $count++
        }
    }
}

Write-Host ""
Write-Host "[OK] Installed $count agent files to $dst"
Write-Host "Restart Claude Code (or open a new session) to pick up the new agents."
