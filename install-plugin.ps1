param([string]$CodexPath = '')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$marketplaceRoot = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$marketplace = Join-Path $marketplaceRoot '.agents\plugins\marketplace.json'
if (-not (Test-Path -LiteralPath $marketplace -PathType Leaf)) {
  throw "The package is incomplete: $marketplace is missing."
}

if (-not $CodexPath) {
  $command = Get-Command codex -ErrorAction Stop
  $CodexPath = $command.Source
}

& $CodexPath plugin marketplace add $marketplaceRoot --json
if ($LASTEXITCODE -ne 0) { throw 'Unable to add the Codex Control local marketplace.' }

& $CodexPath plugin add 'codex-control-plugin@codex-control' --json
if ($LASTEXITCODE -ne 0) { throw 'Unable to install CodexControlPlugin.' }

Write-Host ''
Write-Host 'CodexControlPlugin installed.' -ForegroundColor Green
Write-Host 'Restart Codex, review and trust the plugin hook, then start a new task and ask Codex to connect this device.'
