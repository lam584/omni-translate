#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.IO.psm1') -Force

function Get-TextSha256 {
  param([Parameter(Mandatory = $true)][string]$Value)
  $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Assert-RequiredProperties {
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][string[]]$Names,
    [Parameter(Mandatory = $true)][string]$Label
  )
  foreach ($name in $Names) {
    if ($null -eq $Value.PSObject.Properties[$name]) {
      throw "$Label is missing required property $name"
    }
  }
}

if (-not ('OmniInteractiveControl.NativeMethods' -as [type])) {
  Add-Type -TypeDefinition @'
namespace OmniInteractiveControl {
  public static class NativeMethods {
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    public static extern uint WTSGetActiveConsoleSessionId();
  }
}
'@
}

function Resolve-OmniInteractiveTaskRequest {
  param([Parameter(Mandatory = $true)][string]$PayloadBase64)
  
  $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64)) |
    ConvertFrom-Json
  if ($payload.schemaVersion -ne 1 -or $payload.artifactKind -ne 'watch-mode-interactive-task-request') {
    throw 'unsupported interactive control payload'
  }
  $workspace = [IO.Path]::GetFullPath([string]$payload.workspaceRoot)
  $remoteRoot = [IO.Path]::GetFullPath([string]$payload.remoteRoot)
  $launcherPath = Join-Path $workspace 'scripts\testing\run-watch-mode-interactive-task.ps1'
  $collectorPath = Join-Path $workspace 'scripts\testing\collect-watch-mode-interactive-process-authority.ps1'
  $mode = [string]$payload.mode
  if ($mode -notin @('endpoint-readiness', 'shard-cell', 'incident-plus-cell')) {
    throw 'interactive task request mode is unsupported'
  }
  $runnerRelativePath = if ($mode -eq 'incident-plus-cell') {
    'scripts\testing\run-watch-mode-incident-plus-cell.mjs'
  } else {
    'scripts\testing\run-watch-mode-live-shard.mjs'
  }
  $runnerPath = Join-Path $workspace $runnerRelativePath
  foreach ($entry in @(
    @($launcherPath, [string]$payload.launcherSha256, 'interactive launcher'),
    @($collectorPath, [string]$payload.processAuthorityCollectorSha256, 'process authority collector'),
    @($runnerPath, [string]$payload.shardRunnerSha256, 'shard runner')
  )) {
    if (-not (Test-Path -LiteralPath $entry[0] -PathType Leaf) -or (Get-OmniSha256 -LiteralPath $entry[0]) -cne $entry[1]) {
      throw "$($entry[2]) does not match the signed orchestration inventory"
    }
  }
  $activeSessionId = [int][OmniInteractiveControl.NativeMethods]::WTSGetActiveConsoleSessionId()
  if ($activeSessionId -ne 1) {
    throw 'interactive task requires active console session 1'
  }
  if ([bool]$payload.requireSeparateControlPlane -and
      [Diagnostics.Process]::GetCurrentProcess().SessionId -eq $activeSessionId) {
    throw 'SSH control plane must be outside the active console session 1'
  }
  $expectedUser = [string]$payload.user
  $account = New-Object Security.Principal.NTAccount($env:COMPUTERNAME, $expectedUser)
  $expectedSid = $account.Translate([Security.Principal.SecurityIdentifier]).Value
  $explorers = @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | Where-Object {
    [int]$_.SessionId -eq $activeSessionId
  })
  if ($explorers.Count -ne 1) { throw 'control plane requires exactly one Explorer in console session 1' }
  $explorerSid = Invoke-CimMethod -InputObject $explorers[0] -MethodName GetOwnerSid -ErrorAction Stop
  if ([string]$explorerSid.Sid -cne $expectedSid) { throw 'console Explorer owner does not match configured VMUser' }
  
  Assert-RequiredProperties $payload @(
    'schemaVersion', 'artifactKind', 'mode', 'workspaceRoot', 'remoteRoot',
    'executionId', 'planDigest', 'workerId', 'vmIdentityDigest',
    'expectedVmUuidBios', 'user', 'timeoutMs', 'launcherSha256',
    'processAuthorityCollectorSha256', 'shardRunnerSha256',
    'expectedCredentialReference', 'requireSeparateControlPlane'
  ) 'interactive task request'
  $cellFields = $null
  $endpointReadinessFields = $null
  if ($mode -in @('shard-cell', 'incident-plus-cell')) {
    Assert-RequiredProperties $payload @(
      'leaseId', 'leaseDigest', 'cellId', 'feedbackLoopPrevention', 'planPath',
      'planSha256', 'leasePath', 'leaseSha256', 'readinessPath'
    ) 'interactive cell request'
    $cellFields = [ordered]@{
      leaseId = [string]$payload.leaseId
      leaseDigest = [string]$payload.leaseDigest
      cellId = [string]$payload.cellId
      feedbackLoopPrevention = [string]$payload.feedbackLoopPrevention
      planPath = [string]$payload.planPath
      planSha256 = [string]$payload.planSha256
      leasePath = [string]$payload.leasePath
      leaseSha256 = [string]$payload.leaseSha256
      readinessPath = [string]$payload.readinessPath
    }
    if ($mode -eq 'incident-plus-cell') {
      Assert-RequiredProperties $payload @('readinessRequestPath') 'interactive incident-plus-cell request'
      $cellFields['readinessRequestPath'] = [string]$payload.readinessRequestPath
      if ($null -ne $payload.PSObject.Properties['driverReadinessPath']) {
        $cellFields['driverReadinessPath'] = [string]$payload.driverReadinessPath
      }
    }
  } else {
    Assert-RequiredProperties $payload @(
      'readinessRequestDigest', 'profiles', 'probeExecutable', 'bridgeExecutable'
    ) 'interactive endpoint-readiness request'
    $endpointReadinessFields = [ordered]@{
      readinessRequestDigest = [string]$payload.readinessRequestDigest
      profiles = @($payload.profiles)
      probeExecutable = [string]$payload.probeExecutable
      bridgeExecutable = [string]$payload.bridgeExecutable
    }
  }
  $identity = if ($mode -in @('shard-cell', 'incident-plus-cell')) { $cellFields.leaseId } else { 'readiness' }
  $authorityRoot = Join-Path $remoteRoot ('interactive\' + $identity)
  if (Test-Path -LiteralPath $authorityRoot) { throw 'interactive authority root already exists' }
  [void](New-Item -ItemType Directory -Path $authorityRoot)
  $commandPath = Join-Path $authorityRoot 'command.json'
  $launchPath = Join-Path $authorityRoot 'launch.json'
  $releasePath = Join-Path $authorityRoot 'claim-release.json'
  $terminalPath = Join-Path $authorityRoot 'terminal.json'
  $taskTerminalPath = Join-Path $authorityRoot 'task-terminal.json'
  $processAuthorityPath = Join-Path $authorityRoot 'process-authority.json'
  $executionReceiptPath = Join-Path $authorityRoot 'execution.json'
  $finalizationRequestPath = Join-Path $authorityRoot 'finalization-request.json'
  $stdoutPath = Join-Path $authorityRoot 'stdout.log'
  $stderrPath = Join-Path $authorityRoot 'stderr.log'
  $interactiveAuthorityPath = Join-Path $authorityRoot 'interactive-readiness.json'
  $taskToken = (Get-TextSha256 (([string]$payload.executionId) + '|' + ([string]$payload.workerId) + '|' + $identity)).Substring(0, 32)
  $taskName = 'OmniPaid-' + $taskToken
  $taskPath = '\OmniTranslate\'
  $nodeExecutable = [IO.Path]::GetFullPath((Get-Command node.exe -ErrorAction Stop).Source)
  $command = [ordered]@{
    schemaVersion = 1
    artifactKind = 'watch-mode-interactive-task-command'
    mode = $mode
    executionId = [string]$payload.executionId
    planDigest = [string]$payload.planDigest
    workerId = [string]$payload.workerId
    vmIdentityDigest = [string]$payload.vmIdentityDigest
    expectedVmUuidBios = [string]$payload.expectedVmUuidBios
    expectedUser = $expectedUser
    expectedUserSid = $expectedSid
    expectedSessionId = 1
    workspaceRoot = $workspace
    shardRoot = $remoteRoot
    authorityRoot = $authorityRoot
    expectedCredentialReference = [string]$payload.expectedCredentialReference
    launcherPath = $launcherPath
    launcherSha256 = [string]$payload.launcherSha256
    processAuthorityCollectorPath = $collectorPath
    processAuthorityCollectorSha256 = [string]$payload.processAuthorityCollectorSha256
    shardRunnerPath = $runnerPath
    shardRunnerSha256 = [string]$payload.shardRunnerSha256
    nodeExecutable = $nodeExecutable
    nodeSha256 = Get-OmniSha256 -LiteralPath $nodeExecutable
    taskName = $taskName
    taskPath = $taskPath
    scheduledCommandPath = $commandPath
    expectedUserId = $env:COMPUTERNAME + '\' + $expectedUser
    launchPath = $launchPath
    releasePath = $releasePath
    terminalPath = $terminalPath
    taskTerminalPath = $taskTerminalPath
    processAuthorityPath = $processAuthorityPath
    executionReceiptPath = $executionReceiptPath
    finalizationRequestPath = $finalizationRequestPath
    interactiveAuthorityPath = $interactiveAuthorityPath
    stdoutPath = $stdoutPath
    stderrPath = $stderrPath
  }
  if ($mode -in @('shard-cell', 'incident-plus-cell')) {
    foreach ($name in $cellFields.Keys) { $command[$name] = $cellFields[$name] }
    $command['requireRecorder'] = $cellFields.feedbackLoopPrevention -ne 'echo-cancel'
    if ((Get-OmniSha256 -LiteralPath $command.planPath) -cne $command.planSha256 -or (Get-OmniSha256 -LiteralPath $command.leasePath) -cne $command.leaseSha256) {
      throw 'interactive task plan/lease bytes do not match coordinator authority'
    }
  } else {
    foreach ($name in $endpointReadinessFields.Keys) { $command[$name] = $endpointReadinessFields[$name] }
  }
  return [pscustomobject]@{
    payload = $payload; workspace = $workspace; remoteRoot = $remoteRoot
    launcherPath = $launcherPath; collectorPath = $collectorPath; mode = $mode; runnerPath = $runnerPath
    cellFields = $cellFields; endpointReadinessFields = $endpointReadinessFields; authorityRoot = $authorityRoot
    commandPath = $commandPath; launchPath = $launchPath; releasePath = $releasePath; terminalPath = $terminalPath
    taskTerminalPath = $taskTerminalPath; processAuthorityPath = $processAuthorityPath
    executionReceiptPath = $executionReceiptPath; finalizationRequestPath = $finalizationRequestPath
    stdoutPath = $stdoutPath; stderrPath = $stderrPath; interactiveAuthorityPath = $interactiveAuthorityPath
    taskName = $taskName; taskPath = $taskPath; nodeExecutable = $nodeExecutable; command = $command
  }
}

Export-ModuleMember -Function 'Resolve-OmniInteractiveTaskRequest'
