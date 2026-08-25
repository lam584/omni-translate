#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.IO.psm1') -Force

function Set-DesktopAutostartEnvFile {
  param([string]$RunMarker, [string]$OutputDirectory, [string]$WorkspaceRoot, $Context)
  $envPath = Join-Path $WorkspaceRoot "apps/desktop/.env.local"
  $backupPath = Join-Path $OutputDirectory "desktop-env.local.backup"
  $hadFile = Test-Path -LiteralPath $envPath -PathType Leaf
  $original = if ($hadFile) { Get-Content -LiteralPath $envPath -Raw } else { "" }
  if ($hadFile) {
    Set-OmniUtf8NoBomContent $backupPath $original
  }
  $lines = @()
  if ($original.Length -gt 0) {
    $lines = @($original -split "`r?`n" | Where-Object {
      $_ -notmatch '^VITE_OMNI_WATCH_MODE_AUTOSTART=' -and
      $_ -notmatch '^VITE_OMNI_WATCH_MODE_RUN_MARKER=' -and
      $_ -notmatch '^VITE_OMNI_WATCH_MODE_EXPIRES_AT_MS=' -and
      $_ -notmatch '^VITE_OMNI_WATCH_MODE_OUTPUT_DEVICE_ID=' -and
      $_ -notmatch '^VITE_OMNI_WATCH_MODE_OUTPUT_LEVEL=' -and
      $_ -notmatch '^VITE_OMNI_WATCH_MODE_MODEL_ID=' -and
      $_ -notmatch '^VITE_OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODE=' -and
      $_ -notmatch '^VITE_OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE=' -and
      $_ -notmatch '^VITE_OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID=' -and
      $_ -notmatch '^VITE_OMNI_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID=' -and
      $_ -notmatch '^VITE_OMNI_WATCH_MODE_FEEDBACK_LOOP_PREVENTION='
    })
  }
  $expiresAtMs = [DateTimeOffset]::UtcNow.AddMinutes(45).ToUnixTimeMilliseconds()
  # The paid matrix may explicitly request native Omni output even on the
  # process-exclusion route.  Route choice and subtitle translation mode are
  # independent; do not silently downgrade native output to the secondary
  # translator based on the feedback mode.
  $diagnosticSubtitleTranslationMode = [string]$Context.model.subtitleTranslationMode
  $diagnosticTranslationAudioSource = if ($diagnosticSubtitleTranslationMode -eq "native") { "omni-native" } else { "subtitle-tts" }
  $next = @($lines | Where-Object { $_ -ne "" })
  $next += "VITE_OMNI_WATCH_MODE_AUTOSTART=1"
  $next += "VITE_OMNI_WATCH_MODE_RUN_MARKER=$RunMarker"
  $next += "VITE_OMNI_WATCH_MODE_EXPIRES_AT_MS=$expiresAtMs"
  $next += "VITE_OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODE=$diagnosticSubtitleTranslationMode"
  $next += "VITE_OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE=$diagnosticTranslationAudioSource"
  if ($Context.physicalDevice.id) {
    $next += "VITE_OMNI_WATCH_MODE_OUTPUT_DEVICE_ID=$($Context.physicalDevice.id)"
    $next += "VITE_OMNI_WATCH_MODE_OUTPUT_LEVEL=50"
  }
  if ($Context.model.id) {
    $next += "VITE_OMNI_WATCH_MODE_MODEL_ID=$($Context.model.id)"
  }
  if ($diagnosticSubtitleTranslationMode -eq "secondary" -and $Context.model.subtitleModelId) {
    $next += "VITE_OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID=$($Context.model.subtitleModelId)"
  }
  if ($diagnosticSubtitleTranslationMode -eq "secondary" -and $Context.model.secondaryAudioModelId) {
    $next += "VITE_OMNI_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID=$($Context.model.secondaryAudioModelId)"
  }
  $next += "VITE_OMNI_WATCH_MODE_FEEDBACK_LOOP_PREVENTION=$($Context.audioRoute)"
  Set-OmniUtf8NoBomContent $envPath (($next -join "`r`n") + "`r`n")
  return [pscustomobject]@{
    path = $envPath
    backupPath = if ($hadFile) { $backupPath } else { $null }
    hadFile = $hadFile
  }
}

function Restore-DesktopAutostartEnvFile {
  param($State)
  if (-not $State) {
    return
  }
  if ($State.hadFile -and $State.backupPath -and (Test-Path -LiteralPath $State.backupPath -PathType Leaf)) {
    Copy-Item -LiteralPath $State.backupPath -Destination $State.path -Force
    return
  }
  if (Test-Path -LiteralPath $State.path -PathType Leaf) {
    Remove-Item -LiteralPath $State.path -Force
  }
}

function Set-DesktopPhysicalPlaybackOverride {
  param([string]$DeviceId, [Parameter(Mandatory = $true)][string]$WorkspaceRoot)
  if (-not $DeviceId) {
    return
  }
  $envPath = Join-Path $workspaceRoot "apps/desktop/.env.local"
  if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
    return
  }
  $lines = @(Get-Content -LiteralPath $envPath | Where-Object {
    $_ -notmatch '^VITE_OMNI_WATCH_MODE_OUTPUT_DEVICE_ID='
  })
  $lines += "VITE_OMNI_WATCH_MODE_OUTPUT_DEVICE_ID=$DeviceId"
  Set-OmniUtf8NoBomContent $envPath (($lines -join "`r`n") + "`r`n")
}

function Get-PhysicalOutputResolvedDeviceId {
  param($PhysicalOutputProbeStep)
  if (-not ($PhysicalOutputProbeStep -and $PhysicalOutputProbeStep.status -eq 'passed' -and $PhysicalOutputProbeStep.data)) {
    return $null
  }
  return [string]$PhysicalOutputProbeStep.data.resolvedPhysicalPlaybackDeviceId
}

function Get-PhysicalOutputContentSkipReason {
  param(
    [string]$FeedbackMode,
    [bool]$SkipContentStt
  )
  if ($FeedbackMode -eq "echo-cancel") {
    return "echo-cancel Watch capture does not require the virtual-driver physical-output content recorder"
  }
  if ($SkipContentStt) {
    return "SkipPhysicalOutputContentStt was provided"
  }
  return $null
}

function Test-UsesVirtualDriverBackend {
  param([string]$FeedbackMode)
  return $FeedbackMode -eq "virtual-driver"
}

function Get-WatchModeDriverProbeArguments {
  param(
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
    [string]$RequestedDevconPath = ""
  )
  $arguments = @{ WorkspaceRoot = $WorkspaceRoot }
  if (-not [string]::IsNullOrWhiteSpace($RequestedDevconPath)) {
    $arguments.DevconPath = $RequestedDevconPath
  }
  return $arguments
}

function Get-VirtualDriverPreflightFailure {
  param(
    [Parameter(Mandatory = $true)][string]$FeedbackMode,
    $DriverProbe
  )
  if (-not (Test-UsesVirtualDriverBackend $FeedbackMode)) {
    return $null
  }
  if ($null -eq $DriverProbe) {
    return "virtual-driver preflight did not produce a driver probe result"
  }
  if ($DriverProbe.status -eq 'passed') {
    return $null
  }
  $detail = [string]$DriverProbe.error.message
  if ([string]::IsNullOrWhiteSpace($detail)) {
    $detail = "the driver probe returned ok=false without diagnostics"
  }
  return "virtual-driver preflight failed before the Desktop/LLM session: $detail"
}

function Convert-DriverProbeToJsonFile {
  param($DriverProbe, [string]$TargetPath)
  if ($DriverProbe.status -eq 'passed') {
    $DriverProbe.data | ConvertTo-Json -Depth 8 | Set-Content -Path $TargetPath -Encoding UTF8
  } else {
    [pscustomobject]@{ error = $DriverProbe.error.message } | ConvertTo-Json -Depth 8 | Set-Content -Path $TargetPath -Encoding UTF8
  }
}

function Get-SignedWorkerReadinessDriverProbe {
  param([string]$ReceiptPath, [Parameter(Mandatory = $true)][string]$WorkspaceRoot)
  . (Join-Path $WorkspaceRoot 'scripts\installer\virtual-speaker-device.ps1')
  if ([string]::IsNullOrWhiteSpace($ReceiptPath)) {
    throw 'strict virtual-driver cell requires WorkerReadinessReceiptPath'
  }
  $resolved = (Resolve-Path -LiteralPath $ReceiptPath -ErrorAction Stop).Path
  $receipt = Get-Content -LiteralPath $resolved -Raw -Encoding UTF8 | ConvertFrom-Json
  if (
    [string]$receipt.artifactKind -ne 'watch-mode-production-worker-zero-provider-readiness' -or
    [string]$receipt.executionId -ne [string]$env:OMNI_SHARD_EXECUTION_ID -or
    [string]$receipt.workerId -ne [string]$env:OMNI_SHARD_WORKER_ID -or
    [string]$receipt.vmIdentityDigest -ne [string]$env:OMNI_SHARD_VM_IDENTITY_DIGEST -or
    [int]$receipt.providerCalls -ne 0 -or
    $receipt.driverRequired -ne $true -or
    $null -eq $receipt.driver
  ) { throw 'worker readiness receipt identity is invalid for this strict virtual-driver cell' }
  $driver = $receipt.driver
  $packageRoot = Join-Path $workspaceRoot 'drivers\windows-virtual-mic\package'
  $packageSys = Join-Path $packageRoot 'omni-virtual-speaker.sys'
  $packageCat = Join-Path $packageRoot 'omni-virtual-speaker.cat'
  $packageInf = Join-Path $packageRoot 'omni-virtual-speaker.inf'
  $service = Get-CimInstance Win32_SystemDriver -Filter "Name='omni_translate_virtual_speaker'" -ErrorAction Stop
  $installedPath = [string]$service.PathName
  $installedPath = $installedPath.Trim().Trim('"')
  if ($installedPath.StartsWith('\??\', [StringComparison]::Ordinal)) { $installedPath = $installedPath.Substring(4) }
  if ($installedPath.StartsWith('\SystemRoot\', [StringComparison]::OrdinalIgnoreCase)) {
    $installedPath = Join-Path $env:SystemRoot $installedPath.Substring(12)
  }
  $installedPath = [Environment]::ExpandEnvironmentVariables($installedPath)
  foreach ($required in @($packageSys, $packageCat, $packageInf, $installedPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "readiness-bound driver file is missing: $required" }
  }
  $sysHash = (Get-FileHash -LiteralPath $packageSys -Algorithm SHA256).Hash.ToLowerInvariant()
  $catHash = (Get-FileHash -LiteralPath $packageCat -Algorithm SHA256).Hash.ToLowerInvariant()
  $infHash = (Get-FileHash -LiteralPath $packageInf -Algorithm SHA256).Hash.ToLowerInvariant()
  $installedHash = (Get-FileHash -LiteralPath $installedPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if (
    [string]$service.State -ne 'Running' -or
    $sysHash -ne [string]$driver.packageSysSha256 -or
    $catHash -ne [string]$driver.packageCatSha256 -or
    $infHash -ne [string]$driver.packageInfSha256 -or
    $installedHash -ne [string]$driver.installedSysSha256 -or
    $installedHash -ne $sysHash
  ) { throw 'current limited-session driver identity no longer matches signed worker readiness' }
  $endpoint = Get-OmniVirtualSpeakerEndpoint 'Omni Translate Virtual Speaker'
  if (-not $endpoint) { throw 'signed worker readiness driver endpoint is no longer available' }
  $endpointId = [string]$endpoint.InstanceId
  if ($endpointId.StartsWith('SWD\MMDEVAPI\', [StringComparison]::OrdinalIgnoreCase)) {
    $endpointId = $endpointId.Substring('SWD\MMDEVAPI\'.Length)
  }
  if ([string]::IsNullOrWhiteSpace($endpointId) -or -not $endpointId.StartsWith('{0.0.0.', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'signed worker readiness virtual render endpoint has no canonical WASAPI id'
  }
  return [pscustomobject]@{
    InstalledDriverAuthority = $driver
    WasapiEndpointId = $endpointId
    readinessReceiptPath = $resolved
    providerCalls = 0
  }
}


Export-ModuleMember -Function @(
  'Set-DesktopAutostartEnvFile',
  'Restore-DesktopAutostartEnvFile',
  'Set-DesktopPhysicalPlaybackOverride',
  'Get-PhysicalOutputResolvedDeviceId',
  'Get-PhysicalOutputContentSkipReason',
  'Test-UsesVirtualDriverBackend',
  'Get-WatchModeDriverProbeArguments',
  'Get-VirtualDriverPreflightFailure',
  'Convert-DriverProbeToJsonFile',
  'Get-SignedWorkerReadinessDriverProbe'
)
