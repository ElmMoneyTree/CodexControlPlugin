param(
  [string]$RelayUrl = '',
  [string]$DeviceName = $env:COMPUTERNAME,
  [string]$AccountLabel = '',
  [string]$DataDirectory = '',
  [switch]$NoBrowser,
  [switch]$RevealClaimLink
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$name = $DeviceName.Trim()
if (-not $name) { throw 'Device name is required.' }
$data = Get-AgentDataDirectory -Override $DataDirectory
$configPath = Join-Path $data 'agent-config.json'
$pendingPath = Join-Path $data 'pending-claim.json'
if (Test-Path -LiteralPath $pendingPath -PathType Leaf) {
  $existingPending = Get-Content -LiteralPath $pendingPath -Raw | ConvertFrom-Json
  if ($existingPending.expiresAt -and (Get-UnixTimeMilliseconds) -lt [Int64]$existingPending.expiresAt) {
    foreach ($field in @('relayUrl', 'claimId', 'encryptedClaimSecret', 'deviceKeyFingerprint', 'expiresAt', 'name')) {
      if (-not $existingPending.$field) {
        throw 'A device claim is already waiting for approval, but this older pending record cannot reopen its link. Finish the open page or wait for it to expire.'
      }
    }
    $existingOrigin = Get-RelayOrigin -Value ([string]$existingPending.relayUrl)
    if ($RelayUrl -and (Get-RelayOrigin -Value $RelayUrl) -ne $existingOrigin) {
      throw 'The pending device claim belongs to a different connection service.'
    }
    $existingSecret = Unprotect-CurrentUserText -Value ([string]$existingPending.encryptedClaimSecret)
    try {
      $existingLinks = Get-DeviceClaimLinks -RelayOrigin $existingOrigin -ClaimID ([string]$existingPending.claimId) -ClaimSecret $existingSecret
      Start-ClaimWatcher -DataDirectory $data
      if (-not $NoBrowser) { Start-Process ([string]$existingLinks.claimUrl) | Out-Null }
      $result = [ordered]@{
        state = 'claim-pending'
        resumed = $true
        deviceKeyFingerprint = [string]$existingPending.deviceKeyFingerprint
        expiresAt = [Int64]$existingPending.expiresAt
        name = [string]$existingPending.name
        migration = [bool]($existingPending.PSObject.Properties['migration'] -and $existingPending.migration)
      }
      if ($RevealClaimLink) {
        $result.claimUrl = [string]$existingLinks.claimUrl
        $result.claimUri = [string]$existingLinks.claimUri
      }
      $result | ConvertTo-Json -Depth 5
      return
    } finally {
      $existingSecret = $null
    }
  }
  Remove-Item -LiteralPath $pendingPath -Force
}

$migration = $false
$legacyToken = ''
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
  $existingConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  $schemaVersion = if ($existingConfig.PSObject.Properties['schemaVersion']) { [Int32]$existingConfig.schemaVersion } else { 1 }
  $hasDevicePublicKey = $existingConfig.PSObject.Properties['devicePublicKey'] -and [string]$existingConfig.devicePublicKey
  if ($schemaVersion -ge 2 -or $hasDevicePublicKey) {
    throw 'This device is already claimed by an account. Revoke or disconnect it before claiming again.'
  }
  if (-not $existingConfig.relayUrl -or -not $existingConfig.encryptedDeviceToken) {
    throw 'The existing legacy Agent configuration is incomplete.'
  }
  $storedOrigin = Get-RelayOrigin -Value ([string]$existingConfig.relayUrl)
  if ($RelayUrl -and (Get-RelayOrigin -Value $RelayUrl) -ne $storedOrigin) {
    throw 'A legacy device must be migrated through the Relay it is already connected to.'
  }
  $origin = $storedOrigin
  $legacyToken = Unprotect-CurrentUserText -Value ([string]$existingConfig.encryptedDeviceToken)
  if (-not $AccountLabel -and $existingConfig.PSObject.Properties['accountLabel']) { $AccountLabel = [string]$existingConfig.accountLabel }
  $migration = $true
} else {
  if (-not $RelayUrl) { $RelayUrl = 'https://codex-relay.kuajingvs.com' }
  $origin = Get-RelayOrigin -Value $RelayUrl
}

$pluginRoot = Get-PluginRoot
$node = Join-Path $pluginRoot 'runtime\node.exe'
$creator = Join-Path $pluginRoot 'scripts\create-device-claim.mjs'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'The plugin runtime is incomplete: runtime\node.exe is missing.' }
if (-not (Test-Path -LiteralPath $creator -PathType Leaf)) { throw 'The plugin runtime is incomplete: create-device-claim.mjs is missing.' }

try {
  if ($migration) { $env:CODEX_CONTROL_LEGACY_DEVICE_TOKEN = $legacyToken }
  $claimArguments = @($creator, '--relay-url', $origin, '--device-name', $name)
  if ($AccountLabel.Trim()) { $claimArguments += @('--account-label', $AccountLabel.Trim()) }
  $output = & $node @claimArguments
} finally {
  Remove-Item Env:CODEX_CONTROL_LEGACY_DEVICE_TOKEN -ErrorAction SilentlyContinue
  $legacyToken = $null
}
if ($LASTEXITCODE -ne 0 -or -not $output) { throw 'Unable to create a device claim.' }
$claim = $output | ConvertFrom-Json
foreach ($field in @('id', 'claimSecret', 'pollToken', 'claimUrl', 'deviceKeyFingerprint', 'expiresAt', 'devicePublicKey', 'privateKeyPkcs8')) {
  if (-not $claim.$field) { throw "Connection service response is missing $field." }
}

$pending = [ordered]@{
  schemaVersion = 2
  relayUrl = $origin
  claimId = [string]$claim.id
  encryptedClaimSecret = Protect-CurrentUserText -Value ([string]$claim.claimSecret)
  encryptedPollToken = Protect-CurrentUserText -Value ([string]$claim.pollToken)
  encryptedDevicePrivateKey = Protect-CurrentUserText -Value ([string]$claim.privateKeyPkcs8)
  devicePublicKey = [string]$claim.devicePublicKey
  deviceKeyFingerprint = [string]$claim.deviceKeyFingerprint
  expiresAt = [Int64]$claim.expiresAt
  name = $name
  accountLabel = $AccountLabel.Trim()
  migration = $migration
  createdAt = [DateTimeOffset]::UtcNow.ToString('o')
}
Write-Utf8JsonAtomically -Path $pendingPath -Value $pending
Set-CurrentUserOnlyAcl -Path $pendingPath

$statusPath = Join-Path $data 'status.json'
Write-Utf8JsonAtomically -Path $statusPath -Value ([ordered]@{
  source = 'codex-plugin'
  version = '0.2.2'
  state = 'claim-pending'
  claimId = [string]$claim.id
  deviceKeyFingerprint = [string]$claim.deviceKeyFingerprint
  expiresAt = [Int64]$claim.expiresAt
  name = $name
  migration = $migration
  updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
})

Start-ClaimWatcher -DataDirectory $data
if (-not $NoBrowser) { Start-Process ([string]$claim.claimUrl) | Out-Null }

$result = [ordered]@{
  state = 'claim-pending'
  deviceKeyFingerprint = [string]$claim.deviceKeyFingerprint
  expiresAt = [Int64]$claim.expiresAt
  name = $name
  migration = $migration
}
if ($RevealClaimLink) {
  $result.claimUrl = [string]$claim.claimUrl
  $result.claimUri = [string]$claim.claimUri
}
$result | ConvertTo-Json -Depth 5
