param([string]$DataDirectory = '')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$data = Get-AgentDataDirectory -Override $DataDirectory
$statusPath = Join-Path $data 'status.json'
$configPath = Join-Path $data 'agent-config.json'

if (-not (Test-Path -LiteralPath $statusPath -PathType Leaf)) {
  [ordered]@{
    state = if (Test-Path -LiteralPath $configPath -PathType Leaf) { 'not-started' } else { 'setup-required' }
    dataDirectory = $data
  } | ConvertTo-Json
  exit 0
}

Get-Content -LiteralPath $statusPath -Raw
