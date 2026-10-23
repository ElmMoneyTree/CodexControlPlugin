Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-AgentDataDirectory {
  param([string]$Override = '')
  if ($Override) { return [IO.Path]::GetFullPath($Override) }
  if ($env:CODEX_CONTROL_AGENT_DATA) { return [IO.Path]::GetFullPath($env:CODEX_CONTROL_AGENT_DATA) }
  if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable.' }
  return Join-Path $env:LOCALAPPDATA 'Codex Control Agent Plugin'
}

function Get-PluginRoot {
  return [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}

function Write-Utf8JsonAtomically {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )
  $directory = Split-Path -Parent $Path
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  $temporary = "$Path.$PID.tmp"
  $json = $Value | ConvertTo-Json -Depth 20
  [IO.File]::WriteAllText($temporary, "$json`n", [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Protect-CurrentUserText {
  param([Parameter(Mandatory = $true)][string]$Value)
  Add-Type -AssemblyName System.Security
  $plain = [Text.Encoding]::UTF8.GetBytes($Value)
  try {
    $protected = [Security.Cryptography.ProtectedData]::Protect(
      $plain,
      $null,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    return [Convert]::ToBase64String($protected)
  } finally {
    [Array]::Clear($plain, 0, $plain.Length)
  }
}

function Unprotect-CurrentUserText {
  param([Parameter(Mandatory = $true)][string]$Value)
  Add-Type -AssemblyName System.Security
  $protected = [Convert]::FromBase64String($Value)
  $plain = [Security.Cryptography.ProtectedData]::Unprotect(
    $protected,
    $null,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  try {
    return [Text.Encoding]::UTF8.GetString($plain)
  } finally {
    [Array]::Clear($plain, 0, $plain.Length)
  }
}

function Get-UnixTimeMilliseconds {
  $epoch = [DateTime]::SpecifyKind([DateTime]::Parse('1970-01-01T00:00:00'), [DateTimeKind]::Utc)
  return [Int64](([DateTime]::UtcNow - $epoch).TotalMilliseconds)
}

function Get-ClaimWatcherMutexName {
  param([Parameter(Mandatory = $true)][string]$DataDirectory)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($DataDirectory).ToLowerInvariant())
    $digest = $sha.ComputeHash($bytes)
    $suffix = ([BitConverter]::ToString($digest)).Replace('-', '').Substring(0, 24).ToLowerInvariant()
    return "Local\CodexControlClaimWatcher-$suffix"
  } finally {
    $sha.Dispose()
  }
}

function Start-DeviceAgent {
  param([Parameter(Mandatory = $true)][string]$DataDirectory)
  $pluginRoot = Get-PluginRoot
  $node = Join-Path $pluginRoot 'runtime\node.exe'
  $daemon = Join-Path $pluginRoot 'scripts\agent-daemon.mjs'
  if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'The plugin runtime is incomplete: runtime\node.exe is missing.' }
  if (-not (Test-Path -LiteralPath $daemon -PathType Leaf)) { throw 'The plugin runtime is incomplete: scripts\agent-daemon.mjs is missing.' }
  $arguments = @("`"$daemon`"", '--data', "`"$DataDirectory`"")
  Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $pluginRoot -WindowStyle Hidden | Out-Null
}

function Start-ClaimWatcher {
  param([Parameter(Mandatory = $true)][string]$DataDirectory)
  $powershell = Join-Path ($env:SystemRoot) 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $watcher = Join-Path (Get-PluginRoot) 'scripts\watch-device-claim.ps1'
  $arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$watcher`"", '-DataDirectory', "`"$DataDirectory`"")
  Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden | Out-Null
}

function Set-CurrentUserOnlyAcl {
  param([Parameter(Mandatory = $true)][string]$Path)
  try {
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
    $output = & $icacls $Path '/inheritance:r' '/grant:r' "*$($currentSid):(F)" '*S-1-5-18:(F)' 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($output -join ' ') }
  } catch {
    [Console]::Error.WriteLine("Unable to tighten the Agent config ACL: $($_.Exception.Message)")
  }
}

function Get-RelayOrigin {
  param([Parameter(Mandatory = $true)][string]$Value)
  $uri = $null
  if (-not [Uri]::TryCreate($Value.Trim(), [UriKind]::Absolute, [ref]$uri)) {
    throw 'Relay URL must be an absolute HTTP(S) origin.'
  }
  if ($uri.Scheme -notin @('http', 'https') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
    throw 'Relay URL must be an HTTP(S) origin.'
  }
  if ($uri.AbsolutePath -and $uri.AbsolutePath -ne '/') {
    throw 'Relay URL cannot include a path.'
  }
  return $uri.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
}

function Get-DeviceClaimLinks {
  param(
    [Parameter(Mandatory = $true)][string]$RelayOrigin,
    [Parameter(Mandatory = $true)][string]$ClaimID,
    [Parameter(Mandatory = $true)][string]$ClaimSecret
  )
  $origin = Get-RelayOrigin -Value $RelayOrigin
  if (-not $ClaimID -or -not $ClaimSecret) { throw 'Claim ID and secret are required.' }
  $escapedClaimID = [Uri]::EscapeDataString($ClaimID)
  $escapedSecret = [Uri]::EscapeDataString($ClaimSecret)
  return [ordered]@{
    claimUrl = "$origin/claim/$escapedClaimID#secret=$escapedSecret"
    claimUri = "codexcontrol://claim?relay=$([Uri]::EscapeDataString($origin))&id=$escapedClaimID#secret=$escapedSecret"
  }
}
