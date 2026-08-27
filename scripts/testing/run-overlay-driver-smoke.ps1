#requires -Version 5.1
param(
  [switch]$DryRun,
  [string]$OutputRoot = "artifacts/testing/overlay-driver-smoke",
  [string]$NativeDriverPath = "",
  [string]$ReleaseExecutablePath = "",
  [string]$DriverHost = "127.0.0.1",
  [int]$DriverPort = 4444,
  [int]$NativeDriverPort = 4445,
  [ValidateSet("self-check", "toggle")][string]$OverlayShowMode = "self-check",
  [int]$SessionTimeoutSeconds = 120,
  [int]$OverlayCommandTimeoutSeconds = 30,
  [int]$DriverStartTimeoutSeconds = 30
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$module = Join-Path $PSScriptRoot 'overlay-driver-smoke.mjs'
if ($env:OMNI_SKIP_DRIVER_SMOKE -eq '1') {
  & node $module --mode skip-banner --reason 'OMNI_SKIP_DRIVER_SMOKE=1 was set in the environment'
  exit $LASTEXITCODE
}
$runDir = Join-Path $workspaceRoot (Join-Path $OutputRoot "overlay-driver-smoke-$(Get-Date -Format 'yyyyMMdd-HHmmss')")
$nativeDriver = if ($NativeDriverPath) { $NativeDriverPath } elseif ($env:OMNI_OVERLAY_DRIVER_SMOKE_NATIVE_DRIVER_PATH) {
  $env:OMNI_OVERLAY_DRIVER_SMOKE_NATIVE_DRIVER_PATH
} else { 'msedgedriver.exe' }
$arguments = @('--mode','run','--workspace-root',$workspaceRoot,'--output',$runDir,'--output-root',$OutputRoot,
  '--driver-host',$DriverHost,'--driver-port',"$DriverPort",'--native-driver-port',"$NativeDriverPort",
  '--native-driver-path',$nativeDriver,'--show-mode',$OverlayShowMode,'--session-timeout-seconds',"$SessionTimeoutSeconds",
  '--overlay-command-timeout-seconds',"$OverlayCommandTimeoutSeconds",'--driver-start-timeout-seconds',"$DriverStartTimeoutSeconds")
if ($ReleaseExecutablePath) { $arguments += @('--release-executable-path',$ReleaseExecutablePath) }
if ($DryRun -or $env:OMNI_OVERLAY_DRIVER_SMOKE_DRY_RUN -eq '1') { $arguments += '--dry-run' }
& node $module @arguments
exit $LASTEXITCODE
