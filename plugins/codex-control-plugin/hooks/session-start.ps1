param([string]$DataDirectory = '')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\common.ps1')

$null = [Console]::In.ReadToEnd()
$pluginRoot = Get-PluginRoot
$data = Get-AgentDataDirectory -Override $DataDirectory
$node = Join-Path $pluginRoot 'runtime\node.exe'
$daemon = Join-Path $pluginRoot 'scripts\agent-daemon.mjs'

if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
  throw 'The plugin runtime is incomplete: runtime\node.exe is missing.'
}
if (-not (Test-Path -LiteralPath $daemon -PathType Leaf)) {
  throw 'The plugin runtime is incomplete: scripts\agent-daemon.mjs is missing.'
}

[IO.Directory]::CreateDirectory($data) | Out-Null
$arguments = @("`"$daemon`"", '--data', "`"$data`"")
Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $pluginRoot -WindowStyle Hidden | Out-Null
