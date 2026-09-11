param(
  [Parameter(Mandatory = $true)][string]$RelayUrl,
  [Parameter(Mandatory = $true)][string]$PairingCode,
  [string]$DeviceName = $env:COMPUTERNAME,
  [string]$AccountLabel = '',
  [string]$DataDirectory = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$origin = Get-RelayOrigin -Value $RelayUrl
$code = $PairingCode.Trim().ToUpperInvariant()
$name = $DeviceName.Trim()
if (-not $code) { throw 'Pairing code is required.' }
if (-not $name) { throw 'Device name is required.' }

$body = @{
  code = $code
  name = $name
  accountLabel = $AccountLabel.Trim()
} | ConvertTo-Json -Compress

$enrollment = Invoke-RestMethod -Method Post -Uri "$origin/agent/enroll" -ContentType 'application/json' -Body $body -TimeoutSec 15
if (-not $enrollment.deviceId -or -not $enrollment.token) { throw 'Relay returned an incomplete enrollment response.' }

$data = Get-AgentDataDirectory -Override $DataDirectory
$pluginRoot = Get-PluginRoot
$node = Join-Path $pluginRoot 'runtime\node.exe'
$daemon = Join-Path $pluginRoot 'scripts\agent-daemon.mjs'
if ((Test-Path -LiteralPath $node -PathType Leaf) -and (Test-Path -LiteralPath $daemon -PathType Leaf)) {
  & $node $daemon --data $data --stop | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'The existing plugin Agent did not stop before reconfiguration.' }
}
$configPath = Join-Path $data 'agent-config.json'
$config = [ordered]@{
  schemaVersion = 1
  relayUrl = $origin
  deviceId = [string]$enrollment.deviceId
  encryptedDeviceToken = Protect-CurrentUserText -Value ([string]$enrollment.token)
  name = $name
  accountLabel = $AccountLabel.Trim()
  configuredAt = [DateTimeOffset]::UtcNow.ToString('o')
}
Write-Utf8JsonAtomically -Path $configPath -Value $config
Set-CurrentUserOnlyAcl -Path $configPath

& (Join-Path $PSScriptRoot '..\hooks\session-start.ps1') -DataDirectory $data

[ordered]@{
  configured = $true
  relayUrl = $origin
  deviceId = [string]$enrollment.deviceId
  name = $name
  accountLabel = $AccountLabel.Trim()
  dataDirectory = $data
} | ConvertTo-Json -Depth 5
