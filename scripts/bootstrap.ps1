# One-command entry point for Windows PowerShell.
# Installs Bun only with your confirmation, then delegates to scripts/cli.ts.
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Host "Bun is not installed. It is the only runtime this project needs."
  Write-Host 'Install command: powershell -c "irm bun.sh/install.ps1|iex"'
  $answer = Read-Host "Run that now? [y/N]"
  if ($answer -match '^[yY]') {
    powershell -c "irm bun.sh/install.ps1|iex"
    $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
  } else {
    Write-Host "Install Bun with the command above, then re-run this script."
    exit 1
  }
}

& bun (Join-Path $Root 'scripts\cli.ts') @args
exit $LASTEXITCODE
