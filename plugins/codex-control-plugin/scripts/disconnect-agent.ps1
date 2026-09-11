param([string]$DataDirectory = '')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$pluginRoot = Get-PluginRoot
$data = Get-AgentDataDirectory -Override $DataDirectory
$node = Join-Path $pluginRoot 'runtime\node.exe'
$daemon = Join-Path $pluginRoot 'scripts\agent-daemon.mjs'

if ((Test-Path -LiteralPath $node -PathType Leaf) -and (Test-Path -LiteralPath $daemon -PathType Leaf)) {
  & $node $daemon --data $data --stop | Out-Null
}

$configPath = Join-Path $data 'agent-config.json'
$journalPath = Join-Path $data 'agent-config.json.journal.json'
if (Test-Path -LiteralPath $configPath -PathType Leaf) { Remove-Item -LiteralPath $configPath -Force }
if (Test-Path -LiteralPath $journalPath -PathType Leaf) { Remove-Item -LiteralPath $journalPath -Force }

[ordered]@{
  disconnected = $true
  dataDirectory = $data
} | ConvertTo-Json
