param(
  [Parameter(Mandatory = $true)]
  [string]$PayloadBase64
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'lib/powershell/Omni.Testing.WatchMode.InteractiveRequest.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'lib/powershell/Omni.Testing.WatchMode.InteractiveScheduler.psm1') -Force

$context = Resolve-OmniInteractiveTaskRequest -PayloadBase64 $PayloadBase64
Invoke-OmniInteractiveScheduledTask -Context $context
