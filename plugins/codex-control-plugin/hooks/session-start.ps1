param([string]$DataDirectory = '')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\common.ps1')

$null = [Console]::In.ReadToEnd()
$pluginRoot = Get-PluginRoot
$data = Get-AgentDataDirectory -Override $DataDirectory
$node = Join-Path $pluginRoot 'runtime\node.exe'
$daemon = Join-Path $pluginRoot 'scripts\agent-daemon.mjs'
$startClaim = Join-Path $pluginRoot 'scripts\start-device-claim.ps1'

function Write-SessionContext {
  param([Parameter(Mandatory = $true)][string]$Message)
  [ordered]@{
    hookSpecificOutput = [ordered]@{
      hookEventName = 'SessionStart'
      additionalContext = $Message
    }
  } | ConvertTo-Json -Depth 4 -Compress
}

if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
  throw 'The plugin runtime is incomplete: runtime\node.exe is missing.'
}
if (-not (Test-Path -LiteralPath $daemon -PathType Leaf)) {
  throw 'The plugin runtime is incomplete: scripts\agent-daemon.mjs is missing.'
}

[IO.Directory]::CreateDirectory($data) | Out-Null
$configPath = Join-Path $data 'agent-config.json'
$pendingPath = Join-Path $data 'pending-claim.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
  if (Test-Path -LiteralPath $pendingPath -PathType Leaf) {
    Start-ClaimWatcher -DataDirectory $data
    try {
      $pending = Get-Content -LiteralPath $pendingPath -Raw | ConvertFrom-Json
      Write-SessionContext -Message "Codex Control is waiting for this device claim to be approved. The device fingerprint is $($pending.deviceKeyFingerprint), and the claim expires at Unix milliseconds $($pending.expiresAt). Ask the user to finish the already-open browser or mobile claim; never reveal local claim files or credentials."
    } catch {
      Write-SessionContext -Message 'Codex Control has a pending device claim. Ask the user to finish the already-open browser or mobile claim, or run the CodexControlPlugin claim flow again after it expires.'
    }
    exit 0
  }

  try {
    if (-not (Test-Path -LiteralPath $startClaim -PathType Leaf)) { throw 'scripts\start-device-claim.ps1 is missing.' }
    $claimOutput = & $startClaim -DataDirectory $data
    $claim = $claimOutput | ConvertFrom-Json
    Write-SessionContext -Message "Codex Control created a short-lived claim for this device and opened the claim page. Ask the user to scan its QR code with the signed-in mobile app or sign in in the browser, compare fingerprint $($claim.deviceKeyFingerprint), choose a personal or team workspace, and confirm. Never reveal device credentials, the private key, poll token, or local claim files."
  } catch {
    Write-SessionContext -Message "Codex Control could not start automatic device claiming: $($_.Exception.Message) Ask the user to check the Relay and run the CodexControlPlugin claim flow again."
  }
  exit 0
}
$arguments = @("`"$daemon`"", '--data', "`"$data`"")
Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $pluginRoot -WindowStyle Hidden | Out-Null
