param(
  [string]$RelayUrl = 'https://codex-relay.kuajingvs.com',
  [string]$DataDirectory = '',
  [switch]$BeginClaim,
  [ValidateRange(30, 600)][int]$TimeoutSeconds = 360
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'This acceptance check must run on Windows.'
}

$origin = Get-RelayOrigin -Value $RelayUrl
$data = Get-AgentDataDirectory -Override $DataDirectory
$pluginRoot = Get-PluginRoot
$node = Join-Path $pluginRoot 'runtime\node.exe'
$daemon = Join-Path $pluginRoot 'scripts\agent-daemon.mjs'
$claimScript = Join-Path $pluginRoot 'scripts\start-device-claim.ps1'
$configPath = Join-Path $data 'agent-config.json'
$statusPath = Join-Path $data 'status.json'

function Test-AccountClaimedConfiguration {
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { return $false }
  try {
    $candidate = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $schemaVersion = if ($candidate.PSObject.Properties['schemaVersion']) { [int]$candidate.schemaVersion } else { 1 }
    return $schemaVersion -ge 2 -and [bool]$candidate.PSObject.Properties['devicePublicKey']
  } catch {
    return $false
  }
}

foreach ($file in @($node, $daemon, $claimScript)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Plugin runtime file is missing: $file" }
}

$nodeVersion = (& $node '--version').Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v\d+') { throw 'The bundled Node.js runtime did not start.' }

$health = Invoke-RestMethod -Method Get -Uri "$origin/health" -TimeoutSec 15
$ready = Invoke-RestMethod -Method Get -Uri "$origin/ready" -TimeoutSec 15
if (-not $health.ok -or -not $ready.ok) { throw 'The connection service is not healthy and ready.' }

$v1Status = 0
try {
  $response = Invoke-WebRequest -UseBasicParsing -Method Get -Uri "$origin/v1/me" -TimeoutSec 15
  $v1Status = [int]$response.StatusCode
} catch {
  if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
    $v1Status = [int]$_.Exception.Response.StatusCode
  } else {
    throw
  }
}
if ($v1Status -ne 401) {
  throw "The account/device-claim API is not active at $origin (expected /v1/me to return 401, received $v1Status)."
}

$random = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($random) } finally { $rng.Dispose() }
$plain = [Convert]::ToBase64String($random)
try {
  $protected = Protect-CurrentUserText -Value $plain
  if (-not $protected -or $protected -eq $plain -or (Unprotect-CurrentUserText -Value $protected) -ne $plain) {
    throw 'Windows DPAPI current-user round trip failed.'
  }
} finally {
  [Array]::Clear($random, 0, $random.Length)
  $plain = $null
  $protected = $null
}

if (-not (Test-AccountClaimedConfiguration)) {
  if (-not $BeginClaim) {
    [ordered]@{
      ok = $true
      phase = 'preflight'
      relayUrl = $origin
      nodeVersion = $nodeVersion
      message = 'Preflight passed. Run again with -BeginClaim while Codex Desktop is open to perform device claiming or legacy migration.'
    } | ConvertTo-Json -Depth 4
    exit 0
  }

  $claimOutput = & $claimScript -RelayUrl $origin -DataDirectory $data
  if ($LASTEXITCODE -ne 0 -or -not $claimOutput) { throw 'Unable to begin or resume the device claim.' }
  $claim = $claimOutput | ConvertFrom-Json
  Write-Host "Claim page opened. Fingerprint: $($claim.deviceKeyFingerprint)"
  Write-Host 'Approve it in the signed-in iPhone App or browser. No credential will be printed here.'

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline -and -not (Test-AccountClaimedConfiguration)) {
    Start-Sleep -Seconds 2
  }
  if (-not (Test-AccountClaimedConfiguration)) {
    throw "The device claim was not approved within $TimeoutSeconds seconds."
  }
}

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
foreach ($field in @('schemaVersion', 'relayUrl', 'workspaceId', 'deviceId', 'encryptedDeviceToken', 'encryptedDevicePrivateKey', 'devicePublicKey', 'deviceKeyFingerprint')) {
  if (-not $config.$field) { throw "Claimed Agent configuration is missing $field." }
}
if ([int]$config.schemaVersion -lt 2) { throw 'The device still uses a legacy pairing configuration.' }
if ((Get-RelayOrigin -Value ([string]$config.relayUrl)) -ne $origin) { throw 'The claimed device was assigned to an unexpected Relay.' }

$deviceToken = Unprotect-CurrentUserText -Value ([string]$config.encryptedDeviceToken)
$privateKey = Unprotect-CurrentUserText -Value ([string]$config.encryptedDevicePrivateKey)
try {
  if (-not $deviceToken -or -not $privateKey) { throw 'A claimed device credential could not be decrypted by the current Windows user.' }
} finally {
  $deviceToken = $null
  $privateKey = $null
}

$arguments = @("`"$daemon`"", '--data', "`"$data`"")
Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $pluginRoot -WindowStyle Hidden | Out-Null
$connectedDeadline = [DateTime]::UtcNow.AddSeconds([Math]::Min($TimeoutSeconds, 120))
$status = $null
while ([DateTime]::UtcNow -lt $connectedDeadline) {
  if (Test-Path -LiteralPath $statusPath -PathType Leaf) {
    try { $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json } catch { $status = $null }
    if ($status -and $status.state -eq 'connected') { break }
  }
  Start-Sleep -Seconds 2
}
if (-not $status -or $status.state -ne 'connected') {
  $detail = if ($status -and $status.PSObject.Properties['detail']) { [string]$status.detail } else { 'No connected status was reported.' }
  throw "The claimed Agent did not connect to Codex Desktop and Relay: $detail"
}

[ordered]@{
  ok = $true
  phase = 'connected'
  relayUrl = $origin
  workspaceId = [string]$config.workspaceId
  deviceId = [string]$config.deviceId
  deviceKeyFingerprint = [string]$config.deviceKeyFingerprint
  nodeVersion = $nodeVersion
  lastSyncAt = [string]$status.lastSyncAt
  taskCount = [int]$status.taskCount
  pendingRequestCount = [int]$status.pendingRequestCount
} | ConvertTo-Json -Depth 4
