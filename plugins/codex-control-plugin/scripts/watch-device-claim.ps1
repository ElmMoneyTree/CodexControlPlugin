param([Parameter(Mandatory = $true)][string]$DataDirectory)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$data = Get-AgentDataDirectory -Override $DataDirectory
$pendingPath = Join-Path $data 'pending-claim.json'
$statusPath = Join-Path $data 'status.json'
if (-not (Test-Path -LiteralPath $pendingPath -PathType Leaf)) { exit 0 }

$mutexName = Get-ClaimWatcherMutexName -DataDirectory $data
$created = $false
$mutex = [Threading.Mutex]::new($false, $mutexName, [ref]$created)
if (-not $mutex.WaitOne(0)) { $mutex.Dispose(); exit 0 }

try {
  $pending = Get-Content -LiteralPath $pendingPath -Raw | ConvertFrom-Json
  foreach ($field in @('relayUrl', 'claimId', 'encryptedPollToken', 'encryptedDevicePrivateKey', 'expiresAt', 'name', 'devicePublicKey', 'deviceKeyFingerprint')) {
    if (-not $pending.$field) { throw "Pending device claim is missing $field." }
  }
  $pollToken = Unprotect-CurrentUserText -Value ([string]$pending.encryptedPollToken)
  $headers = @{ Authorization = "Claim $pollToken"; Accept = 'application/json' }

  while ((Get-UnixTimeMilliseconds) -lt [Int64]$pending.expiresAt) {
    try {
      $claim = Invoke-RestMethod -Method Get -Uri "$($pending.relayUrl)/v1/device-claims/$($pending.claimId)/poll" -Headers $headers -TimeoutSec 15
      if ($claim.status -eq 'approved') {
        if (-not $claim.deviceId -or -not $claim.deviceToken -or -not $claim.workspaceId -or -not $claim.relayUrl) { throw 'Approved device claim response is incomplete.' }
        $targetRelay = Get-RelayOrigin -Value ([string]$claim.relayUrl)
        $isMigration = $pending.PSObject.Properties['migration'] -and [bool]$pending.migration
        if ($isMigration) {
          $pluginRoot = Get-PluginRoot
          $node = Join-Path $pluginRoot 'runtime\node.exe'
          $daemon = Join-Path $pluginRoot 'scripts\agent-daemon.mjs'
          & $node $daemon --data $data --stop | Out-Null
          if ($LASTEXITCODE -ne 0) { throw 'The legacy Agent did not stop during account migration.' }
        }
        $configPath = Join-Path $data 'agent-config.json'
        $config = [ordered]@{
          schemaVersion = 2
          relayUrl = $targetRelay
          workspaceId = [string]$claim.workspaceId
          deviceId = [string]$claim.deviceId
          encryptedDeviceToken = Protect-CurrentUserText -Value ([string]$claim.deviceToken)
          encryptedDevicePrivateKey = [string]$pending.encryptedDevicePrivateKey
          devicePublicKey = [string]$pending.devicePublicKey
          deviceKeyFingerprint = [string]$pending.deviceKeyFingerprint
          name = [string]$pending.name
          accountLabel = [string]$pending.accountLabel
          configuredAt = [DateTimeOffset]::UtcNow.ToString('o')
          migratedFromLegacy = [bool]$isMigration
        }
        Write-Utf8JsonAtomically -Path $configPath -Value $config
        Set-CurrentUserOnlyAcl -Path $configPath
        Remove-Item -LiteralPath $pendingPath -Force
        Write-Utf8JsonAtomically -Path $statusPath -Value ([ordered]@{
          source = 'codex-plugin'; version = '0.2.2'; state = 'claimed'; relayUrl = $targetRelay
          workspaceId = [string]$claim.workspaceId; deviceId = [string]$claim.deviceId; name = [string]$pending.name
          deviceKeyFingerprint = [string]$pending.deviceKeyFingerprint; updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
          migratedFromLegacy = [bool]$isMigration
        })
        # The SessionStart hook consumes stdin; a background watcher must launch directly.
        try {
          Start-DeviceAgent -DataDirectory $data
        } catch {
          Write-Utf8JsonAtomically -Path $statusPath -Value ([ordered]@{
            source = 'codex-plugin'; version = '0.2.2'; state = 'error'
            deviceId = [string]$claim.deviceId; name = [string]$pending.name
            detail = "Device claimed, but Agent startup failed: $($_.Exception.Message)"
            updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
          })
          exit 1
        }
        exit 0
      }
      if ($claim.status -in @('expired', 'rejected')) { break }
    } catch {
      Write-Utf8JsonAtomically -Path $statusPath -Value ([ordered]@{
        source = 'codex-plugin'; version = '0.2.2'; state = 'claim-waiting'; claimId = [string]$pending.claimId
        deviceKeyFingerprint = [string]$pending.deviceKeyFingerprint; detail = $_.Exception.Message
        expiresAt = [Int64]$pending.expiresAt; name = [string]$pending.name; updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
      })
    }
    Start-Sleep -Seconds 2
  }

  if (Test-Path -LiteralPath $pendingPath -PathType Leaf) { Remove-Item -LiteralPath $pendingPath -Force }
  Write-Utf8JsonAtomically -Path $statusPath -Value ([ordered]@{
    source = 'codex-plugin'; version = '0.2.2'; state = 'claim-expired'; name = [string]$pending.name
    deviceKeyFingerprint = [string]$pending.deviceKeyFingerprint; updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  })
} catch {
  Write-Utf8JsonAtomically -Path $statusPath -Value ([ordered]@{
    source = 'codex-plugin'; version = '0.2.2'; state = 'claim-error'; detail = $_.Exception.Message
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  })
  exit 1
} finally {
  try { $mutex.ReleaseMutex() } catch { }
  $mutex.Dispose()
}
