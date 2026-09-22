param(
  [Parameter(Mandatory = $true)]
  [string]$RequestPath,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-f0-9]{64}$')]
  [string]$ExpectedRequestSha256
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'lib/powershell/Omni.Testing.WatchMode.InteractiveJob.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'lib/powershell/Omni.Testing.WatchMode.InteractiveCleanup.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'lib/powershell/Omni.Testing.WatchMode.InteractiveDesktopIdentity.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'lib/powershell/Omni.Testing.IO.psm1') -Force
function Invoke-Utf8JsonProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][string]$FailureContext
  )
  # Windows PowerShell 5.1 otherwise decodes native stdout with the active
  # console code page. The Rust probes emit UTF-8 JSON, so localized endpoint
  # names would be mojibake before ConvertFrom-Json and fail exact authority
  # matching even though the request and endpoint bytes were both correct.
  $previousOutputEncoding = [Console]::OutputEncoding
  try {
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    $output = @(& $FilePath @ArgumentList 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    [Console]::OutputEncoding = $previousOutputEncoding
  }
  if ($exitCode -ne 0) {
    throw "$FailureContext`: $($output -join ' | ')"
  }
  try {
    return (($output -join [Environment]::NewLine) | ConvertFrom-Json)
  } catch {
    throw "$FailureContext returned invalid UTF-8 JSON: $($_.Exception.Message)"
  }
}
function Get-ProcessIdentity {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
  $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwner -ErrorAction Stop
  $ownerSid = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
  $executable = [string]$process.ExecutablePath
  if (-not $executable -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "process $ProcessId has no regular executable path"
  }
  return [ordered]@{
    pid = [int]$process.ProcessId
    parentPid = [int]$process.ParentProcessId
    sessionId = [int]$process.SessionId
    imagePath = [IO.Path]::GetFullPath($executable)
    imageSha256 = Get-OmniSha256 -LiteralPath $executable
    startedAt = (Get-Process -Id $ProcessId -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')
    ownerUser = [string]$owner.User
    ownerDomain = [string]$owner.Domain
    ownerSid = [string]$ownerSid.Sid
  }
}
if (-not ('OmniCredentialStatus.NativeMethods' -as [type])) {
  Add-Type -TypeDefinition @'
namespace OmniCredentialStatus {
  using System;
  using System.Runtime.InteropServices;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public UInt32 Flags;
    public UInt32 Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }

  public sealed class CredentialMetadata {
    public bool Enumerated;
    public Int32 ErrorCode;
    public bool Found;
    public UInt32 CredentialBlobBytes;
  }

  public static class NativeMethods {
    [DllImport("Advapi32.dll", EntryPoint = "CredEnumerateW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredEnumerate(
      string filter,
      UInt32 flags,
      out UInt32 count,
      out IntPtr credentials
    );

    [DllImport("Advapi32.dll")]
    private static extern void CredFree(IntPtr buffer);

    // Keep the native out parameters and allocation lifetime inside managed C#.
    // Windows PowerShell 5.1 can incorrectly bind this P/Invoke through [ref]
    // and report ERROR_NOT_FOUND even when the exact credential is present.
    public static CredentialMetadata FindCredential(string targetName, UInt32 type) {
      UInt32 count = 0;
      IntPtr credentials = IntPtr.Zero;
      CredentialMetadata result = new CredentialMetadata();
      try {
        result.Enumerated = CredEnumerate(null, 0, out count, out credentials);
        result.ErrorCode = result.Enumerated ? 0 : Marshal.GetLastWin32Error();
        if (!result.Enumerated) return result;
        for (Int32 index = 0; index < checked((Int32)count); index += 1) {
          IntPtr credentialPointer = Marshal.ReadIntPtr(credentials, IntPtr.Size * index);
          if (credentialPointer == IntPtr.Zero) continue;
          Credential credential = (Credential)Marshal.PtrToStructure(
            credentialPointer,
            typeof(Credential)
          );
          string actualTargetName = Marshal.PtrToStringUni(credential.TargetName);
          if (
            credential.Type == type
            && String.Equals(actualTargetName, targetName, StringComparison.Ordinal)
          ) {
            result.Found = true;
            result.CredentialBlobBytes = credential.CredentialBlobSize;
            break;
          }
        }
        return result;
      } finally {
        if (credentials != IntPtr.Zero) CredFree(credentials);
      }
    }
  }
}
'@
}

function Get-RequiredCredentialStatus {
  param(
    [Parameter(Mandatory = $true)][string]$Reference,
    [Parameter(Mandatory = $true)][string]$TargetName,
    [Parameter(Mandatory = $true)][uint32]$Type,
    [Parameter(Mandatory = $true)]$ProbeProcess
  )
  # Enumerate only Credential Manager metadata.  Do not call CredReadW and do
  # not dereference CredentialBlob: the check proves only backend availability
  # and the signed target/type pair in VMUser's interactive session.
  $metadata = [OmniCredentialStatus.NativeMethods]::FindCredential($TargetName, $Type)
  if (-not $metadata.Enumerated) {
    if ($metadata.ErrorCode -eq 1168) { throw "required Credential Manager target is absent: $TargetName" }
    throw "CredEnumerateW failed with Win32 error $($metadata.ErrorCode)"
  }
  if (-not $metadata.Found) { throw "required Credential Manager target/type is absent: $TargetName" }
  [uint32]$credentialBlobBytes = $metadata.CredentialBlobBytes
  # CRED_MAX_CREDENTIAL_BLOB_SIZE is 5 * 512 bytes. Checking the size field
  # proves that the selected target is not an empty placeholder without ever
  # dereferencing CredentialBlob or exposing secret material.
  if ($credentialBlobBytes -eq 0 -or $credentialBlobBytes -gt 2560) {
    throw "required Credential Manager target has an empty or invalid blob size: $credentialBlobBytes"
  }
  return [ordered]@{
    backend = 'windows-credential-manager'
    exists = $true
    reference = $Reference
    targetName = $TargetName
    blobNonEmpty = $true
    credentialBlobBytes = [int]$credentialBlobBytes
    checkedAt = [DateTime]::UtcNow.ToString('o')
    probeProcess = $ProbeProcess
  }
}

if (-not ('OmniInteractiveSession.NativeMethods' -as [type])) {
  Add-Type -TypeDefinition @'
namespace OmniInteractiveSession {
  public static class NativeMethods {
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    public static extern uint WTSGetActiveConsoleSessionId();
  }
}
'@
}

$resolvedRequestPath = [IO.Path]::GetFullPath($RequestPath)
if (-not (Test-Path -LiteralPath $resolvedRequestPath -PathType Leaf)) {
  throw 'interactive task request is missing'
}
if ((Get-Item -LiteralPath $resolvedRequestPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
  throw 'interactive task request may not be a reparse point'
}
$requestSha256 = Get-OmniSha256 -LiteralPath $resolvedRequestPath
if ($requestSha256 -cne $ExpectedRequestSha256.ToLowerInvariant()) {
  throw 'interactive task request hash mismatch'
}
$request = Get-Content -LiteralPath $resolvedRequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($request.schemaVersion -ne 2 -or $request.artifactKind -ne 'watch-mode-interactive-task-command') {
  throw 'unsupported interactive task request'
}
if ((Get-OmniSha256 -LiteralPath ([IO.Path]::GetFullPath($MyInvocation.MyCommand.Path))) -cne [string]$request.launcherSha256) {
  throw 'interactive task launcher hash mismatch'
}

$activeConsoleSessionId = [int][OmniInteractiveSession.NativeMethods]::WTSGetActiveConsoleSessionId()
$currentIdentity = Get-ProcessIdentity $PID
$windowsIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$currentUser = $windowsIdentity.Name.Split('\')[-1]
if (
  $activeConsoleSessionId -ne 1 -or
  $currentIdentity.sessionId -ne $activeConsoleSessionId -or
  $currentUser -cne [string]$request.expectedUser -or
  $windowsIdentity.User.Value -cne [string]$request.expectedUserSid
) { throw 'interactive task is not running as the unique signed console identity in session 1' }
$explorers = @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | Where-Object {
  [int]$_.SessionId -eq $activeConsoleSessionId
})
if ($explorers.Count -ne 1) { throw 'interactive task requires exactly one Explorer in active console session 1' }
$explorerIdentity = Get-ProcessIdentity ([int]$explorers[0].ProcessId)
if ($explorerIdentity.ownerSid -cne $windowsIdentity.User.Value) {
  throw 'Explorer owner SID does not match interactive task identity'
}
$actualUuid = ([string](Get-CimInstance Win32_ComputerSystemProduct).UUID).ToLowerInvariant()
if ($actualUuid -cne ([string]$request.expectedVmUuidBios).ToLowerInvariant()) {
  throw 'interactive task VM BIOS UUID does not match the signed worker'
}

$taskDesktop = Get-OmniCurrentDesktopIdentity; if ([string]::IsNullOrWhiteSpace($taskDesktop)) { throw 'interactive task desktop identity is unavailable' }
$common = [ordered]@{
  schemaVersion = 2
  executionId = [string]$request.executionId
  workerId = [string]$request.workerId
  vmIdentityDigest = [string]$request.vmIdentityDigest
  actualVmUuidBios = $actualUuid
  commandSha256 = $requestSha256
  taskName = [string]$request.taskName
  user = $currentUser
  ownerSid = $windowsIdentity.User.Value
  sessionId = $activeConsoleSessionId
  desktop = $taskDesktop
  taskProcess = $currentIdentity
  explorerProcess = $explorerIdentity
}

if ($request.mode -eq 'endpoint-readiness') {
  $credentialReference = [string]$request.expectedCredentialReference
  # Keep this mapping byte-for-byte aligned with storage/credential.rs:
  # normalize_reference replaces ':', '/', '\\', and spaces with '_' and
  # credential_target_name prefixes the normalized value with OmniTranslate:.
  $credentialTargetName = 'OmniTranslate:credential___provider_dashscope_default'
  if (
    $credentialReference -cne 'credential://provider/dashscope/default' -or
    $credentialTargetName -cne 'OmniTranslate:credential___provider_dashscope_default'
  ) { throw 'interactive endpoint readiness credential binding is invalid' }
  $credentialStatus = Get-RequiredCredentialStatus -Reference $credentialReference -TargetName $credentialTargetName -Type ([uint32]1) -ProbeProcess $currentIdentity
  $profileResults = @()
  foreach ($profile in @($request.profiles)) {
    $profileRoot = Join-Path ([string]$request.authorityRoot) ('profile-' + [string]$profile.instanceId)
    [void](New-Item -ItemType Directory -Path $profileRoot)
    $requested = [string]$profile.physicalPlaybackDeviceId
    if (($requested -eq 'default' -or [string]::IsNullOrWhiteSpace($requested)) -and [string]$profile.expectedPhysicalPlaybackDeviceName) {
      $requested = [string]$profile.expectedPhysicalPlaybackDeviceName
    }
    $probe = Invoke-Utf8JsonProcess `
      -FilePath ([string]$request.probeExecutable) `
      -ArgumentList @(
        '--bridge-exe', ([string]$request.bridgeExecutable),
        '--runtime-root', $profileRoot,
        '--physical-playback-device-id', $requested,
        '--physical-playback-level', '50'
      ) `
      -FailureContext "interactive endpoint probe failed for $($profile.instanceId)"
    if ($probe.passed -ne $true -or $probe.skipped -eq $true -or -not [string]$probe.resolvedPhysicalPlaybackDeviceId) {
      throw "interactive endpoint profile is unavailable: $($profile.instanceId)"
    }
    if ([string]$profile.expectedPhysicalPlaybackDeviceName -and [string]$probe.resolvedPhysicalPlaybackDeviceName -notlike "*$($profile.expectedPhysicalPlaybackDeviceName)*") {
      throw "interactive endpoint profile name mismatch: $($profile.instanceId)"
    }
    $profileResults += [ordered]@{
      instanceId = [string]$profile.instanceId
      profileId = [string]$profile.profileId
      deviceClass = [string]$profile.deviceClass
      resolvedDeviceId = [string]$probe.resolvedPhysicalPlaybackDeviceId
      resolvedDeviceName = [string]$probe.resolvedPhysicalPlaybackDeviceName
    }
  }
  $authority = [ordered]@{
    schemaVersion = 1
    artifactKind = 'watch-mode-interactive-endpoint-readiness'
    generatedAt = [DateTime]::UtcNow.ToString('o')
    executionId = $common.executionId
    readinessRequestDigest = [string]$request.readinessRequestDigest
    workerId = $common.workerId
    vmIdentityDigest = $common.vmIdentityDigest
    providerCalls = 0
    commandSha256 = $common.commandSha256
    user = $common.user
    ownerSid = $common.ownerSid
    sessionId = $common.sessionId
    desktop = $common.desktop
    taskProcess = $common.taskProcess
    explorerProcess = $common.explorerProcess
    credentialStatus = $credentialStatus
    profiles = $profileResults
  }
  Write-OmniImmutableJson -LiteralPath ([string]$request.interactiveAuthorityPath) -Value $authority
  $terminal = [ordered]@{
    schemaVersion = 1
    artifactKind = 'watch-mode-interactive-task-terminal'
    mode = [string]$request.mode
    executionId = $common.executionId
    workerId = $common.workerId
    commandSha256 = $common.commandSha256
    sessionId = $common.sessionId
    user = $common.user
    exitCode = 0
    authorityPath = [string]$request.interactiveAuthorityPath
    completedAt = [DateTime]::UtcNow.ToString('o')
  }
  Write-OmniImmutableJson -LiteralPath ([string]$request.terminalPath) -Value $terminal
  exit 0
}

if ($request.mode -notin @('shard-cell', 'incident-plus-cell', 'local-aec-probe')) { throw 'interactive task mode is unsupported' }; if ((Get-OmniSha256 -LiteralPath ([string]$request.nodeExecutable)) -cne [string]$request.nodeSha256) {
  throw 'interactive task Node executable hash mismatch'
}; if ((Get-OmniSha256 -LiteralPath ([string]$request.shardRunnerPath)) -cne [string]$request.shardRunnerSha256) {
  throw 'interactive task shard runner hash mismatch'
}
if ($request.mode -eq 'local-aec-probe') { $arguments = @([string]$request.shardRunnerPath, '--execute-interactive-request', $resolvedRequestPath) } else {
  $env:OMNI_SHARD_ZERO_PROVIDER_READINESS_PATH = [string]$request.readinessPath
  $env:OMNI_SHARD_INTERACTIVE_COMMAND_PATH = $resolvedRequestPath
  $env:OMNI_SHARD_INTERACTIVE_LAUNCH_AUTHORITY_PATH = [string]$request.launchPath
  $env:OMNI_SHARD_INTERACTIVE_PROCESS_AUTHORITY_PATH = [string]$request.processAuthorityPath
  $env:OMNI_SHARD_INTERACTIVE_TERMINAL_PATH = [string]$request.terminalPath
  $env:OMNI_SHARD_INTERACTIVE_TASK_TERMINAL_PATH = [string]$request.taskTerminalPath
  $env:OMNI_SHARD_INTERACTIVE_RELEASE_PATH = [string]$request.releasePath
  $env:OMNI_SHARD_INTERACTIVE_EXECUTION_RECEIPT_PATH = [string]$request.executionReceiptPath
  $arguments = @([string]$request.shardRunnerPath, '--plan', [string]$request.planPath, '--lease', [string]$request.leasePath,
    '--worker-id', [string]$request.workerId, '--vm-uuid-bios', [string]$request.expectedVmUuidBios)
}
if ($request.mode -eq 'incident-plus-cell') {
  $arguments += @(
    '--execution-root', [string]$request.shardRoot,
    '--readiness-receipt', [string]$request.readinessPath,
    '--readiness-request', [string]$request.readinessRequestPath
  )
  if ($request.PSObject.Properties['driverReadinessPath'] -and -not [string]::IsNullOrWhiteSpace([string]$request.driverReadinessPath)) {
    $arguments += @('--driver-readiness-receipt', [string]$request.driverReadinessPath)
  }
} elseif ($request.mode -eq 'shard-cell') {
  $arguments += @('--shard-root', [string]$request.shardRoot)
}
# The outer finally covers every post-launch setup/identity/publication failure.
# Native Create itself closes/terminates suspended custody on partial failure.
$node = $null
$jobBinding = $null
$jobCleanupAcknowledged = $false
$launcherFailure = $null
$jobCleanupFailure = $null
try {
$cancellationBinding = Get-OmniInteractiveCancellationBinding -LaunchPath ([string]$request.launchPath) -ExpectedBinding $request
if (Test-OmniInteractiveCancellationIntent -LaunchPath ([string]$request.launchPath) -Binding $cancellationBinding) {
  Write-OmniInteractiveNotStartedAcknowledgment -LaunchPath ([string]$request.launchPath) -Binding $cancellationBinding
  throw 'interactive launch cancelled before Node creation'
}
$node = New-OmniInteractiveJob -Executable ([string]$request.nodeExecutable) -Arguments $arguments `
  -WorkingDirectory ([string]$request.workspaceRoot) -StdoutPath ([string]$request.stdoutPath) -StderrPath ([string]$request.stderrPath)
$nodeHandle = $node.Handle
$node.Resume()
$nodeIdentity = Get-ProcessIdentity $node.Id
if ($nodeIdentity.sessionId -ne $activeConsoleSessionId -or $nodeIdentity.ownerSid -cne $windowsIdentity.User.Value) { $node.Cancel(); throw 'interactive shard Node did not inherit the console session identity' }
$desktopReceipt = $null
if ($request.mode -eq 'local-aec-probe') {
  $limit=[DateTime]::UtcNow.AddSeconds(15); while(-not (Test-Path -LiteralPath ([string]$request.nodeDesktopAuthorityPath) -PathType Leaf) -and [DateTime]::UtcNow -lt $limit -and -not $node.HasExited){Start-Sleep -Milliseconds 50}
  if(-not (Test-Path -LiteralPath ([string]$request.nodeDesktopAuthorityPath) -PathType Leaf)){$node.Cancel(); throw 'target Node desktop identity receipt is missing'}
  $desktopReceipt=Get-Content -LiteralPath ([string]$request.nodeDesktopAuthorityPath) -Raw -Encoding UTF8 | ConvertFrom-Json
  $parent=$desktopReceipt.parentProcess; if($desktopReceipt.schemaVersion -ne 1 -or $desktopReceipt.artifactKind -cne 'watch-mode-process-desktop-identity' -or $desktopReceipt.executionId -cne $common.executionId -or $desktopReceipt.planDigest -cne $request.planDigest -or $desktopReceipt.leaseId -cne $request.leaseId -or $desktopReceipt.leaseDigest -cne $request.leaseDigest -or $desktopReceipt.cellId -cne $request.cellId -or $desktopReceipt.workerId -cne $common.workerId -or $desktopReceipt.vmIdentityDigest -cne $common.vmIdentityDigest -or $desktopReceipt.reporterParentPid -ne $node.Id -or $parent.pid -ne $nodeIdentity.pid -or $parent.startedAt -cne $nodeIdentity.startedAt -or ([IO.Path]::GetFullPath([string]$parent.imagePath)) -cne ([IO.Path]::GetFullPath([string]$nodeIdentity.imagePath)) -or $parent.imageSha256 -cne $nodeIdentity.imageSha256 -or $desktopReceipt.sessionId -ne $activeConsoleSessionId -or $desktopReceipt.ownerSid -cne $windowsIdentity.User.Value -or $desktopReceipt.desktop -cne $common.desktop){$node.Cancel(); throw 'target Node desktop identity receipt does not match interactive authority'}
}
$nodeDesktop = if($desktopReceipt){[string]$desktopReceipt.desktop}else{[string]$common.desktop}
$launch = [ordered]@{
  schemaVersion = 2
  artifactKind = 'watch-mode-interactive-shard-launch-authority'
  jobCustody = [ordered]@{ schemaVersion = 1; kind = 'unnamed-kill-on-close-job'; custodyId = [guid]::NewGuid().ToString('N') }
  launchedAt = [DateTime]::UtcNow.ToString('o')
  executionId = $common.executionId
  planDigest = [string]$request.planDigest
  leaseId = [string]$request.leaseId
  leaseDigest = [string]$request.leaseDigest
  cellId = [string]$request.cellId
  workerId = $common.workerId
  vmIdentityDigest = $common.vmIdentityDigest
  actualVmUuidBios = $common.actualVmUuidBios
  commandSha256 = $common.commandSha256
  user = $common.user
  ownerSid = $common.ownerSid
  sessionId = $common.sessionId
  desktop = $common.desktop
  nodeDesktop = $nodeDesktop
  nodeDesktopAuthorityPath = if($desktopReceipt){[string]$request.nodeDesktopAuthorityPath}else{$null}
  nodeDesktopAuthoritySha256 = if($desktopReceipt){Get-OmniSha256 -LiteralPath ([string]$request.nodeDesktopAuthorityPath)}else{$null}
  taskName = $common.taskName
  taskProcess = $common.taskProcess
  explorerProcess = $common.explorerProcess
  nodeProcess = $nodeIdentity
  launcherSha256 = [string]$request.launcherSha256
  shardRunnerSha256 = [string]$request.shardRunnerSha256
}
Write-OmniImmutableJson -LiteralPath ([string]$request.launchPath) -Value $launch
$jobBinding = Get-OmniInteractiveJobBinding -LaunchPath ([string]$request.launchPath) -ExpectedBinding $request
$release = [ordered]@{
  schemaVersion = 2
  artifactKind = 'watch-mode-interactive-shard-claim-release'
  executionId = $common.executionId
  planDigest = [string]$request.planDigest
  leaseId = [string]$request.leaseId
  leaseDigest = [string]$request.leaseDigest
  cellId = [string]$request.cellId
  workerId = $common.workerId
  vmIdentityDigest = $common.vmIdentityDigest
  commandSha256 = $common.commandSha256
  nodePid = [int]$nodeIdentity.pid
  nodeStartedAt = [string]$nodeIdentity.startedAt
  sessionId = $common.sessionId
  ownerSid = $common.ownerSid
  releasedAt = [DateTime]::UtcNow.ToString('o')
}
$traceArguments = @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', ('"' + [string]$request.processAuthorityCollectorPath + '"'),
    '-RootProcessId', [string]$node.Id,
    '-OutputPath', ('"' + [string]$request.processAuthorityPath + '"'),
    '-ExpectedSessionId', [string]$activeConsoleSessionId,
    '-ExpectedOwnerSid', ('"' + $windowsIdentity.User.Value + '"'),
    '-ExecutionId', ('"' + [string]$request.executionId + '"'),
    '-PlanDigest', [string]$request.planDigest,
    '-LeaseId', ('"' + [string]$request.leaseId + '"'),
    '-LeaseDigest', [string]$request.leaseDigest,
    '-CellId', ('"' + [string]$request.cellId + '"'),
    '-WorkerId', ('"' + [string]$request.workerId + '"'),
    '-VmIdentityDigest', [string]$request.vmIdentityDigest,
    '-ExecutionReceiptPath', ('"' + [string]$request.executionReceiptPath + '"'),
    '-Mode', ('"' + [string]$request.mode + '"')
  )
if ([bool]$request.requireRecorder) { $traceArguments += '-RequireRecorder' }
$trace = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList $traceArguments `
  -WindowStyle Hidden `
  -PassThru
$null = $trace.Handle
# The collector is deliberately a sibling outside the workload job. It may
# complete evidence after cancellation, but never authorizes cancellation.
$cancelled = Receive-OmniInteractiveJobCancellation -Job $node -LaunchPath ([string]$request.launchPath) -Binding $jobBinding
$collectorReadyPath = Join-Path ([IO.Path]::GetDirectoryName([string]$request.launchPath)) 'collector-ready.json'
# Readiness consumes the existing 15-second claim-authority window; no timeout
# extension. Cancellation stays serviceable during collection startup.
$collectorReadyDeadline = ([DateTimeOffset]::Parse([string]$nodeIdentity.startedAt)).UtcDateTime.AddSeconds(15)
while (-not $cancelled -and -not (Test-Path -LiteralPath $collectorReadyPath -PathType Leaf)) {
  $cancelled = Receive-OmniInteractiveJobCancellation -Job $node -LaunchPath ([string]$request.launchPath) -Binding $jobBinding
  if ($cancelled) { break }
  if ($trace.HasExited -or $node.HasExited -or [DateTime]::UtcNow -ge $collectorReadyDeadline) { throw 'collector did not establish pre-release observation' }
  Start-Sleep -Milliseconds 25
}
if (-not $cancelled) {
  $ready = Get-Content -LiteralPath $collectorReadyPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($ready.schemaVersion -ne 1 -or $ready.artifactKind -cne 'watch-mode-interactive-collector-ready' -or
    $ready.rootProcessId -ne $node.Id -or $ready.rootStartedAt -cne $nodeIdentity.startedAt -or
    $ready.expectedOwnerSid -cne $request.expectedUserSid -or $ready.expectedSessionId -ne $request.expectedSessionId) { throw 'invalid collector readiness' }
  foreach ($field in @('executionId','planDigest','leaseId','leaseDigest','cellId','workerId','vmIdentityDigest')) {
    if ([string]$ready.$field -cne [string]$request.$field) { throw 'collector readiness binding mismatch' }
  }
  $cancelled = Receive-OmniInteractiveJobCancellation -Job $node -LaunchPath ([string]$request.launchPath) -Binding $jobBinding
  if (-not $cancelled) { Write-OmniImmutableJson -LiteralPath ([string]$request.releasePath) -Value $release }
}
while ($node.ActiveProcesses -ne 0 -or -not $node.HasExited) {
  if (Receive-OmniInteractiveJobCancellation -Job $node -LaunchPath ([string]$request.launchPath) -Binding $jobBinding) { $cancelled = $true }
  Start-Sleep -Milliseconds 25
}
# Job-empty proof precedes terminal collector waits, including on cancellation.
Write-OmniInteractiveJobAcknowledgment -Job $node -LaunchPath ([string]$request.launchPath) -Binding $jobBinding -Cancelled $cancelled
$jobCleanupAcknowledged = $true
if ($null -eq $node.ExitCode) { throw 'interactive shard Node exit code is unavailable' }
$nodeExitCode = [int]$node.ExitCode
$trace.WaitForExit(30000) | Out-Null
if (-not $trace.HasExited) { $trace.Kill() }
$executionReceiptObserved = $false
if ($nodeExitCode -eq 0 -and (Test-Path -LiteralPath ([string]$request.executionReceiptPath) -PathType Leaf)) {
  $executionReceiptObserved = $true
}
$terminal = [ordered]@{
  schemaVersion = 2
  artifactKind = 'watch-mode-interactive-task-terminal'
  mode = [string]$request.mode
  executionId = $common.executionId
  planDigest = [string]$request.planDigest
  leaseId = [string]$request.leaseId
  leaseDigest = [string]$request.leaseDigest
  cellId = [string]$request.cellId
  workerId = $common.workerId
  vmIdentityDigest = $common.vmIdentityDigest
  commandSha256 = $common.commandSha256
  sessionId = $common.sessionId
  user = $common.user
  ownerSid = $common.ownerSid
  nodePid = $node.Id
  nodeStartedAt = $nodeIdentity.startedAt
  exitCode = $nodeExitCode
  processAuthorityExitCode = if ($trace.HasExited) { $trace.ExitCode } else { -1 }
  executionReceiptPath = ('interactive/' + [string]$request.leaseId + '/execution.json')
  executionReceiptObserved = $executionReceiptObserved
  completedAt = [DateTime]::UtcNow.ToString('o')
}
Write-OmniImmutableJson -LiteralPath ([string]$request.terminalPath) -Value $terminal
} catch {
  $launcherFailure = $_
} finally {
  if ($null -ne $node) {
    try {
      # Exceptions after publication (including collector startup/readiness) must
      # leave a reconcilable custody proof, not only a closed job handle.
      if (-not $jobCleanupAcknowledged) {
        Complete-OmniInteractiveJobCleanup -Job $node -LaunchPath ([string]$request.launchPath) -Binding $jobBinding -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(3)) -ExpectedBinding $request
      }
    } catch { $jobCleanupFailure = $_ }
    finally {
      try { $node.Dispose() }
      catch { if ($null -eq $jobCleanupFailure) { $jobCleanupFailure = $_ } }
    }
  }
}
if ($null -ne $jobCleanupFailure) {
  # Keep the original ErrorRecord/message. Cleanup remains independently failed;
  # neither an exception nor handle closure can stand in for a positive proof.
  if ($null -ne $launcherFailure) { $launcherFailure.Exception.Data['interactiveJobCleanupStatus'] = 'incomplete' }
  Write-Warning 'interactive job cleanup incomplete; positive custody proof is not confirmed' -WarningAction Continue
}
if ($null -ne $launcherFailure) { throw $launcherFailure }
if ($null -ne $jobCleanupFailure) { throw $jobCleanupFailure }
exit $nodeExitCode
