param(
  [Parameter(Mandatory = $true)][string]$ConfigPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if (-not $config.encryptedDeviceToken) { throw 'Agent config does not contain an encrypted device token.' }
$protected = [Convert]::FromBase64String([string]$config.encryptedDeviceToken)
$plain = [Security.Cryptography.ProtectedData]::Unprotect(
  $protected,
  $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
try {
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
} finally {
  [Array]::Clear($plain, 0, $plain.Length)
}
