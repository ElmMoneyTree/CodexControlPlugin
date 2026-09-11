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
