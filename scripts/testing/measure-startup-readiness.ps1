param(
  [string]$OutputRoot = "artifacts/testing/startup-readiness",
  [int]$TimeoutSeconds = 120,
  [int]$WindowPollMs = 100,
  [int]$LogPollMs = 250,
  [int]$DevServerPort = 4173,
  [int]$MaxWindowToReadyMs = 10000,
  [int]$MaxWindowToFrontendMountMs = 1000,
  [int]$MaxFrontendBootstrapMs = 8500,
  [int]$MaxReadySignalToNativeLogMs = 500,
  [switch]$UseExistingDevServer,
  [switch]$UseFastDev,
  [int]$CriticalWarmupTimeoutMs = 1200,
  [switch]$NoWarmup,
  [switch]$NoStop,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Import-Module (Join-Path $PSScriptRoot 'lib/powershell/Omni.Testing.Startup.Runner.psm1') -Force -DisableNameChecking
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Invoke-StartupReadinessRun -WorkspaceRoot $workspaceRoot -OutputRoot $OutputRoot -TimeoutSeconds $TimeoutSeconds `
  -WindowPollMs $WindowPollMs -LogPollMs $LogPollMs -DevServerPort $DevServerPort `
  -MaxWindowToReadyMs $MaxWindowToReadyMs -MaxWindowToFrontendMountMs $MaxWindowToFrontendMountMs `
  -MaxFrontendBootstrapMs $MaxFrontendBootstrapMs -MaxReadySignalToNativeLogMs $MaxReadySignalToNativeLogMs `
  -UseExistingDevServer ([bool]$UseExistingDevServer) -UseFastDev ([bool]$UseFastDev) `
  -CriticalWarmupTimeoutMs $CriticalWarmupTimeoutMs -NoWarmup ([bool]$NoWarmup) `
  -NoStop ([bool]$NoStop) -DryRun ([bool]$DryRun)
