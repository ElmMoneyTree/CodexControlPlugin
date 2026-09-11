param(
  [string]$CodexPath = '',
  [string]$DataDirectory = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$marketplaceRoot = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$disconnect = Join-Path $marketplaceRoot 'plugins\codex-control-plugin\scripts\disconnect-agent.ps1'
if (Test-Path -LiteralPath $disconnect -PathType Leaf) {
  $disconnectArguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $disconnect)
  if ($DataDirectory) { $disconnectArguments += @('-DataDirectory', $DataDirectory) }
  & 'powershell.exe' @disconnectArguments | Out-Host
}

if (-not $CodexPath) {
  $command = Get-Command codex -ErrorAction Stop
  $CodexPath = $command.Source
}

& $CodexPath plugin remove 'codex-control-plugin@codex-control' --json
if ($LASTEXITCODE -ne 0) { throw 'Unable to remove CodexControlPlugin.' }

& $CodexPath plugin marketplace remove 'codex-control' --json
if ($LASTEXITCODE -ne 0) { throw 'Unable to remove the Codex Control local marketplace.' }

Write-Host 'CodexControlPlugin removed.' -ForegroundColor Green
