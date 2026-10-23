param([string]$DataDirectory = '')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$data = Get-AgentDataDirectory -Override $DataDirectory
$configPath = Join-Path $data 'agent-config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
  throw 'This device has not completed claiming yet.'
}
$pluginRoot = Get-PluginRoot
$node = Join-Path $pluginRoot 'runtime\node.exe'
$daemon = Join-Path $pluginRoot 'scripts\agent-daemon.mjs'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'The plugin runtime is incomplete: runtime\node.exe is missing.' }
& $node $daemon --data $data --stop | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'The previous Agent did not stop; device credentials were preserved.' }
Start-DeviceAgent -DataDirectory $data
[ordered]@{
  state = 'starting'
  message = 'Agent restarted with the existing device identity. Keep Codex Desktop open and run scripts/get-agent-status.ps1 to check for connected.'
} | ConvertTo-Json
