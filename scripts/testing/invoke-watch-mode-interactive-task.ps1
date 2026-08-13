param(
  [Parameter(Mandatory = $true)]
  [string]$PayloadBase64
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  $bytes = [IO.File]::ReadAllBytes([IO.Path]::GetFullPath($Path))
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

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

function Write-ImmutableJson {
  param([string]$Path, $Value)
  $resolved = [IO.Path]::GetFullPath($Path)
  [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($resolved))
  $encoding = New-Object Text.UTF8Encoding($false)
  $bytes = $encoding.GetBytes((($Value | ConvertTo-Json -Depth 20 -Compress) + "`n"))
  $stream = New-Object IO.FileStream(
    $resolved,
    [IO.FileMode]::CreateNew,
    [IO.FileAccess]::Write,
    [IO.FileShare]::Read,
    4096,
    [IO.FileOptions]::WriteThrough
  )
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
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

function Stop-GuardedNode {
  param([string]$LaunchPath)
  if (-not (Test-Path -LiteralPath $LaunchPath -PathType Leaf)) { return }
  try {
    $launch = Get-Content -LiteralPath $LaunchPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $processId = [int]$launch.nodeProcess.pid
    $actual = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
    if (-not $actual) { return }
    $process = Get-Process -Id $processId -ErrorAction Stop
    $actualStart = $process.StartTime.ToUniversalTime().ToString('o')
    $actualPath = [string]$actual.ExecutablePath
    if (
      [int]$actual.SessionId -eq [int]$launch.nodeProcess.sessionId -and
      $actualStart -ceq [string]$launch.nodeProcess.startedAt -and
      (Get-Sha256 $actualPath) -ceq [string]$launch.nodeProcess.imageSha256
    ) { & taskkill.exe /PID $processId /F /T 2>$null | Out-Null }
  } catch {
    # A stale or malformed receipt must never authorize an unguarded process kill.
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

$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64)) |
  ConvertFrom-Json
if ($payload.schemaVersion -ne 1 -or $payload.artifactKind -ne 'watch-mode-interactive-task-request') {
  throw 'unsupported interactive control payload'
}
$workspace = [IO.Path]::GetFullPath([string]$payload.workspaceRoot)
$remoteRoot = [IO.Path]::GetFullPath([string]$payload.remoteRoot)
$launcherPath = Join-Path $workspace 'scripts\testing\run-watch-mode-interactive-task.ps1'
$collectorPath = Join-Path $workspace 'scripts\testing\collect-watch-mode-interactive-process-authority.ps1'
$runnerPath = Join-Path $workspace 'scripts\testing\run-watch-mode-live-shard.mjs'
foreach ($entry in @(
  @($launcherPath, [string]$payload.launcherSha256, 'interactive launcher'),
  @($collectorPath, [string]$payload.processAuthorityCollectorSha256, 'process authority collector'),
  @($runnerPath, [string]$payload.shardRunnerSha256, 'shard runner')
)) {
  if (-not (Test-Path -LiteralPath $entry[0] -PathType Leaf) -or (Get-Sha256 $entry[0]) -cne $entry[1]) {
    throw "$($entry[2]) does not match the signed orchestration inventory"
  }
}
$activeSessionId = [int][OmniInteractiveControl.NativeMethods]::WTSGetActiveConsoleSessionId()
if ($activeSessionId -ne 1 -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq $activeSessionId) {
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

$mode = [string]$payload.mode
if ($mode -notin @('endpoint-readiness', 'shard-cell')) {
  throw 'interactive task request mode is unsupported'
}
Assert-RequiredProperties $payload @(
  'schemaVersion', 'artifactKind', 'mode', 'workspaceRoot', 'remoteRoot',
  'executionId', 'planDigest', 'workerId', 'vmIdentityDigest',
  'expectedVmUuidBios', 'user', 'timeoutMs', 'launcherSha256',
  'processAuthorityCollectorSha256', 'shardRunnerSha256',
  'expectedCredentialReference'
) 'interactive task request'
$shardFields = $null
$endpointReadinessFields = $null
if ($mode -eq 'shard-cell') {
  Assert-RequiredProperties $payload @(
    'leaseId', 'leaseDigest', 'cellId', 'feedbackLoopPrevention', 'planPath',
    'planSha256', 'leasePath', 'leaseSha256', 'readinessPath'
  ) 'interactive shard-cell request'
  $shardFields = [ordered]@{
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
$identity = if ($mode -eq 'shard-cell') { $shardFields.leaseId } else { 'readiness' }
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
  nodeSha256 = Get-Sha256 $nodeExecutable
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
if ($mode -eq 'shard-cell') {
  foreach ($name in $shardFields.Keys) { $command[$name] = $shardFields[$name] }
  $command['requireRecorder'] = $shardFields.feedbackLoopPrevention -ne 'echo-cancel'
  if ((Get-Sha256 $command.planPath) -cne $command.planSha256 -or (Get-Sha256 $command.leasePath) -cne $command.leaseSha256) {
    throw 'interactive task plan/lease bytes do not match coordinator authority'
  }
} else {
  foreach ($name in $endpointReadinessFields.Keys) { $command[$name] = $endpointReadinessFields[$name] }
}
Write-ImmutableJson $commandPath $command
$commandSha256 = Get-Sha256 $commandPath
$arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcherPath`" -RequestPath `"$commandPath`" -ExpectedRequestSha256 $commandSha256"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
  $principal = New-ScheduledTaskPrincipal -UserId $command.expectedUserId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 12) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$registered = $false
try {
  if (Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue) {
    throw 'interactive scheduled task name already exists'
  }
  Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
  $registered = $true
  $recorded = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop
  $recordedXml = [xml](Export-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop)
  if (
    @($recorded.Actions).Count -ne 1 -or
    [string]$recorded.Actions[0].Execute -cne 'powershell.exe' -or
    [string]$recorded.Actions[0].Arguments -cne $arguments -or
    [string]$recorded.Principal.RunLevel -cne 'Limited' -or
    [string]$recordedXml.Task.Actions.Exec.Command -cne 'powershell.exe' -or
    [string]$recordedXml.Task.Actions.Exec.Arguments -cne $arguments -or
    [string]$recordedXml.Task.Principals.Principal.UserId -cne $expectedSid -or
    [string]$recordedXml.Task.Principals.Principal.LogonType -cne 'InteractiveToken'
  ) { throw 'registered interactive task does not match the immutable action/principal' }
  $taskInfoBeforeStart = Get-ScheduledTaskInfo -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop
  Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName
  $deadline = [DateTime]::UtcNow.AddMilliseconds([int]$payload.timeoutMs)
  $taskObservedRunning = $false
  $taskObservedStarted = $false
  $successfulTaskExitObservedAt = $null
  $terminalVisibilityGraceMilliseconds = 5000
  while (-not (Test-Path -LiteralPath $terminalPath -PathType Leaf)) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'interactive task timed out before terminal authority' }
    $taskState = (Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop).State
    $taskInfo = Get-ScheduledTaskInfo -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop
    if ($taskState -eq 'Running') { $taskObservedRunning = $true }
    if ($taskObservedRunning -or $taskInfo.LastRunTime -ne $taskInfoBeforeStart.LastRunTime) {
      $taskObservedStarted = $true
    }
    $taskIsActive = $taskState -in @('Running', 'Queued')
    if (
      $taskObservedStarted -and
      -not $taskIsActive -and
      -not (Test-Path -LiteralPath $terminalPath -PathType Leaf)
    ) {
      $lastTaskResult = [int]$taskInfo.LastTaskResult
      if ($lastTaskResult -ne 0) {
        throw "interactive task exited before terminal authority (LastTaskResult=$lastTaskResult)"
      }
      if ($null -eq $successfulTaskExitObservedAt) {
        $successfulTaskExitObservedAt = [DateTime]::UtcNow
      } elseif (([DateTime]::UtcNow - $successfulTaskExitObservedAt).TotalMilliseconds -ge $terminalVisibilityGraceMilliseconds) {
        throw 'interactive task completed successfully without publishing terminal authority after the visibility grace period'
      }
    }
    Start-Sleep -Milliseconds 250
  }
  while ((Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName).State -eq 'Running') {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'interactive task did not reach scheduler terminal state' }
    Start-Sleep -Milliseconds 250
  }
  $taskInfo = Get-ScheduledTaskInfo -TaskPath $taskPath -TaskName $taskName
  $terminal = Get-Content -LiteralPath $terminalPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $taskTerminal = [ordered]@{
    schemaVersion = 1
    artifactKind = 'watch-mode-interactive-scheduled-task-terminal'
    mode = $mode
    executionId = [string]$payload.executionId
    planDigest = [string]$payload.planDigest
    workerId = [string]$payload.workerId
    vmIdentityDigest = [string]$payload.vmIdentityDigest
    commandSha256 = $commandSha256
    taskName = $taskName
    taskPath = $taskPath
    actionExecute = 'powershell.exe'
    actionArguments = $arguments
    userId = [string]$command.expectedUserId
    logonType = 'InteractiveToken'
    runLevel = 'Limited'
    lastTaskResult = [int]$taskInfo.LastTaskResult
    terminalSha256 = Get-Sha256 $terminalPath
    completedAt = [DateTime]::UtcNow.ToString('o')
  }
  if ($mode -eq 'shard-cell') {
    $taskTerminal['leaseId'] = $shardFields.leaseId
    $taskTerminal['leaseDigest'] = $shardFields.leaseDigest
    $taskTerminal['cellId'] = $shardFields.cellId
  } else {
    $taskTerminal['readinessRequestDigest'] = $endpointReadinessFields.readinessRequestDigest
  }
  Write-ImmutableJson $taskTerminalPath $taskTerminal
  if ([int]$terminal.exitCode -ne 0 -or [int]$taskInfo.LastTaskResult -ne 0) {
    throw 'interactive task terminal or Task Scheduler result failed'
  }
  if ($command.mode -eq 'shard-cell') {
    if ($terminal.executionReceiptObserved -ne $true -or -not (Test-Path -LiteralPath $executionReceiptPath -PathType Leaf)) {
      throw 'interactive shard did not publish its execution receipt'
    }
    $finalizationRequest = [ordered]@{
      schemaVersion = 1
      artifactKind = 'watch-mode-interactive-cell-finalization-request'
      planPath = [string]$command.planPath
      leasePath = [string]$command.leasePath
      workerId = [string]$command.workerId
      vmUuidBios = [string]$command.expectedVmUuidBios
      shardRoot = [string]$command.shardRoot
      executionReceiptPath = $executionReceiptPath
      readinessReceiptPath = [string]$command.readinessPath
      commandPath = $commandPath
      launchPath = $launchPath
      releasePath = $releasePath
      processAuthorityPath = $processAuthorityPath
      terminalPath = $terminalPath
      taskTerminalPath = $taskTerminalPath
    }
    Write-ImmutableJson $finalizationRequestPath $finalizationRequest
    $finalizerOutput = @(& $nodeExecutable $runnerPath '--finalize-interactive-request' $finalizationRequestPath 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "interactive cell guest finalizer failed: $($finalizerOutput -join ' | ')" }
    $finalResultPath = [string](@($finalizerOutput | Where-Object { $_ } | Select-Object -Last 1)[0])
    if (-not (Test-Path -LiteralPath $finalResultPath -PathType Leaf)) {
      throw 'interactive cell guest finalizer returned no immutable result'
    }
  } else {
    $finalResultPath = [string]$terminal.authorityPath
  }
  [ordered]@{
    commandPath = $commandPath
    commandSha256 = $commandSha256
    launchPath = $launchPath
    terminalPath = $terminalPath
    taskTerminalPath = $taskTerminalPath
    processAuthorityPath = $processAuthorityPath
    interactiveAuthorityPath = $interactiveAuthorityPath
    finalizationRequestPath = $finalizationRequestPath
    finalResultPath = $finalResultPath
    terminal = $terminal
    taskTerminal = $taskTerminal
  } | ConvertTo-Json -Depth 20 -Compress
} finally {
  if ($registered) {
    Stop-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
    Stop-GuardedNode $launchPath
    Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  }
}
