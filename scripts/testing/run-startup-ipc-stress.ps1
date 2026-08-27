#requires -Version 5.1
param(
  [switch]$DryRun,
  [int]$Runs = 10,
  [string]$OutputRoot = "artifacts/testing/startup-ipc-stress",
  [string]$ReleaseExecutablePath = "",
  [string]$RuntimeAppLogPath = "",
  [int]$PingTimeoutMs = 90000,
  [int]$PollIntervalMs = 250,
  [int]$BetweenRunsSettleMs = 1500
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$runId = "startup-ipc-stress-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$runDir = Join-Path $workspaceRoot (Join-Path $OutputRoot $runId)
$effectiveRuns = if (-not $PSBoundParameters.ContainsKey('Runs') -and $env:OMNI_STARTUP_IPC_STRESS_RUNS) {
  $env:OMNI_STARTUP_IPC_STRESS_RUNS
} else { "$Runs" }
$arguments = @('--mode','run','--workspace-root',$workspaceRoot,'--output',$runDir,'--output-root',$OutputRoot,
  '--runs',$effectiveRuns,'--ping-timeout-ms',"$PingTimeoutMs",'--poll-interval-ms',"$PollIntervalMs",
  '--between-runs-settle-ms',"$BetweenRunsSettleMs")
if ($ReleaseExecutablePath) { $arguments += @('--release-executable-path',$ReleaseExecutablePath) }
if ($RuntimeAppLogPath) { $arguments += @('--app-log-path',[System.IO.Path]::GetFullPath($RuntimeAppLogPath)) }
if ($DryRun -or $env:OMNI_STARTUP_IPC_STRESS_DRY_RUN -eq '1') { $arguments += '--dry-run' }
& node (Join-Path $PSScriptRoot 'startup-ipc-stress.mjs') @arguments
exit $LASTEXITCODE
