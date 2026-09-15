param(
  [Parameter(Mandatory = $true)][int]$ExpectedParentProcessId,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$ExecutionId,
  [Parameter(Mandatory = $true)][string]$PlanDigest,
  [Parameter(Mandatory = $true)][string]$LeaseId,
  [Parameter(Mandatory = $true)][string]$LeaseDigest,
  [Parameter(Mandatory = $true)][string]$CellId,
  [Parameter(Mandatory = $true)][string]$WorkerId,
  [Parameter(Mandatory = $true)][string]$VmIdentityDigest
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'lib/powershell/Omni.Testing.IO.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'lib/powershell/Omni.Testing.WatchMode.InteractiveDesktopIdentity.psm1') -Force
$helper = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop
if ([int]$helper.ParentProcessId -ne $ExpectedParentProcessId) { throw 'desktop reporter parent PID mismatch' }
$parent = Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedParentProcessId" -ErrorAction Stop
$parentRuntime = Get-Process -Id $ExpectedParentProcessId -ErrorAction Stop
$parentStartedAt = $parentRuntime.StartTime.ToUniversalTime().ToString('o')
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$receipt = [ordered]@{
  schemaVersion = 1; artifactKind = 'watch-mode-process-desktop-identity'; reportedAt = [DateTime]::UtcNow.ToString('o')
  executionId = $ExecutionId; planDigest = $PlanDigest; leaseId = $LeaseId; leaseDigest = $LeaseDigest
  cellId = $CellId; workerId = $WorkerId; vmIdentityDigest = $VmIdentityDigest
  desktop = Get-OmniCurrentDesktopIdentity; sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
  ownerSid = $identity.User.Value; reporterPid = $PID; reporterParentPid = [int]$helper.ParentProcessId
  parentProcess = [ordered]@{ pid = $ExpectedParentProcessId; startedAt = $parentStartedAt; imagePath = [IO.Path]::GetFullPath([string]$parent.ExecutablePath); imageSha256 = Get-OmniSha256 -LiteralPath ([string]$parent.ExecutablePath) }
}
Write-OmniImmutableJson -LiteralPath $OutputPath -Value $receipt
