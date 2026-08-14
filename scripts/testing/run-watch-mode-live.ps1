param(
  [switch]$DryRun,
  [string]$Fixture = "pass",
  [string]$FixtureRoot = "scripts/testing/fixtures/watch-mode-live",
  [string]$OutputRoot = "artifacts/testing/watch-mode-live",
  [string]$RuntimeRoot = "artifacts/diagnostics/logs",
  # Some clean test VMs intentionally do not install the full WDK. When a
  # Microsoft-signed devcon.exe has been staged inside the workspace, pass it
  # explicitly to the development-driver health probe instead of falling back
  # to a machine-wide WDK location.
  [string]$DevconPath = "",
  [int]$WarmupSeconds = 12,
  [int]$PlaybackSeconds = 0,
  [int]$PostPlaybackWaitSeconds = 120,
  [ValidateRange(1, 100)]
  [int]$SessionReadyTimeoutSeconds = 90,
  # The budget-approved paid release plan assigns an exact 180-second ceiling
  # to every cell. Longer values remain available only to non-strict diagnostics.
  [ValidateRange(180, 7200)]
  [int]$WatchAutoStopAfterSeconds = 180,
  [switch]$SkipDesktopLaunch,
  [switch]$SkipDriverRepair,
  [switch]$AllowDriverRepair,
  [switch]$UseDefaultEndpointPlayback,
  [switch]$StopDesktopAfterPlayback,
  [switch]$AllowElevatedDesktopLaunch,
  [switch]$SkipPhysicalOutputContentStt,
  # Strict paid matrix contract: only the selected native realtime model may
  # access DashScope. Source-reference and physical-output authority are built
  # from canonical fixture hashes, local PCM, cue receipts, and playback logs.
  [switch]$StrictPaidAuthority,
  # A signed Plus incident replay uses the same audio budget boundary but is
  # deliberately distinct from the immutable eight-cell release matrix.
  [switch]$IncidentReplayAuthority,
  [string]$MatrixCellId = "",
  # A production shard has already validated this signed, zero-provider
  # readiness receipt before claiming its lease. Virtual-driver cells consume
  # the exact installed/package authority from it so the limited Session-1
  # task never repeats administrator-only DriverStore enumeration.
  [string]$WorkerReadinessReceiptPath = "",
  # Re-run only the paid physical-output STT/comparison against artifacts from
  # an already completed live session. This never starts Desktop, Bridge, media
  # playback, or a new Watch provider session.
  [string]$RecoverPhysicalOutputContentRunDirectory = "",
  [switch]$ReuseExistingPhysicalOutputStt,
  [string]$MediaPath = "scripts/testing/fixtures/watch-mode-en-original.wav",
  [string]$WatchModelId = "",
  [ValidateSet("", "dashscope-omni", "dashscope-livetranslate", "dashscope-asr", "openai-conversation", "openai-translation", "openai-transcription", "openai-flat", "gemini-live")]
  [string]$WatchRealtimeProtocol = "",
  [ValidateSet("native", "secondary")]
  [string]$SubtitleTranslationMode = "secondary",
  [string]$SubtitleTranslationModelId = "template-dashscope-realtime::qwen3.6-flash-2026-04-16",
  [string]$InboundSecondaryAudioModelId = "template-dashscope-realtime::qwen3.5-omni-plus-realtime",
  [string]$PhysicalPlaybackDeviceId = "default",
  [ValidateSet("default-speaker", "usb", "bluetooth")]
  [string]$PhysicalPlaybackDeviceClass = "default-speaker",
  [string]$PhysicalPlaybackDeviceProfileId = "default-speaker",
  [ValidateSet("process-exclusion", "virtual-driver", "echo-cancel")]
  [string]$FeedbackLoopPrevention = "virtual-driver",
  [string]$ExpectedPhysicalPlaybackDeviceName = ""
)

$ErrorActionPreference = 'Stop'

# The native Rust diagnostics emit UTF-8 JSON. Windows PowerShell 5.1 decodes
# native stdout with Console.OutputEncoding, so make that byte boundary
# explicit before any probe output is captured or parsed.
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

if ($StrictPaidAuthority -and $IncidentReplayAuthority) {
  throw "StrictPaidAuthority and IncidentReplayAuthority are mutually exclusive."
}
$paidAuthorityEnabled = [bool]$StrictPaidAuthority -or [bool]$IncidentReplayAuthority
$providerAuthorityMode = if ($StrictPaidAuthority) {
  "strict-paid"
} elseif ($IncidentReplayAuthority) {
  "incident-replay-plus"
} else {
  "none"
}

if ($PhysicalPlaybackDeviceProfileId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
  throw "PhysicalPlaybackDeviceProfileId must contain only letters, digits, '.', '_', or '-'."
}

# Production Tauri builds always write diagnostics under LocalAppData; the
# workspace diagnostics root is a debug-only convention. The live runner now
# launches the production shell so its default must follow the same location,
# otherwise readiness watches a marker-only file while the real session logs
# somewhere else.
if (-not $DryRun -and -not $PSBoundParameters.ContainsKey("RuntimeRoot")) {
  $RuntimeRoot = Join-Path $env:LOCALAPPDATA "OmniTranslate\diagnostics\logs"
}

# npm 11 swallows PowerShell-style single-dash options after "npm run ... --"
# and forwards only their values, so "-FixtureRoot X:\fixtures" or
# "-FeedbackLoopPrevention echo-cancel" arrives here as a bare value that binds
# positionally to -Fixture. Because "-Fixture" itself can never survive npm
# forwarding, any caller-bound value under these lifecycles is an orphaned
# value of some swallowed option. Fail fast with npm-safe alternatives instead
# of running with silently misbound arguments.
if (
  $env:npm_lifecycle_event -in @("test:watch-mode-live", "test:watch-mode-live:dry-run") -and
  $PSBoundParameters.ContainsKey("Fixture")
) {
  throw (
    "npm forwarded only the value '$Fixture' because npm 11 swallows single-dash options after 'npm run ... --'. " +
    "Set OMNI_WATCH_MODE_LIVE_FIXTURE, OMNI_WATCH_MODE_LIVE_FIXTURE_ROOT, or " +
    "OMNI_WATCH_MODE_LIVE_FEEDBACK_LOOP_PREVENTION before 'npm run', or invoke the runner directly: " +
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./scripts/testing/run-watch-mode-live.ps1 [-DryRun] -FeedbackLoopPrevention echo-cancel"
  )
}

# npm-safe environment overrides for parameters that npm cannot forward as
# single-dash options. Explicit parameters always win over these fallbacks.
if (-not $PSBoundParameters.ContainsKey("Fixture") -and $env:OMNI_WATCH_MODE_LIVE_FIXTURE) {
  $Fixture = $env:OMNI_WATCH_MODE_LIVE_FIXTURE
}
if (-not $PSBoundParameters.ContainsKey("FixtureRoot") -and $env:OMNI_WATCH_MODE_LIVE_FIXTURE_ROOT) {
  $FixtureRoot = $env:OMNI_WATCH_MODE_LIVE_FIXTURE_ROOT
}
if (-not $PSBoundParameters.ContainsKey("FeedbackLoopPrevention") -and $env:OMNI_WATCH_MODE_LIVE_FEEDBACK_LOOP_PREVENTION) {
  if ($env:OMNI_WATCH_MODE_LIVE_FEEDBACK_LOOP_PREVENTION -notin @("process-exclusion", "virtual-driver", "echo-cancel")) {
    throw "OMNI_WATCH_MODE_LIVE_FEEDBACK_LOOP_PREVENTION must be 'process-exclusion', 'virtual-driver', or 'echo-cancel'; got '$($env:OMNI_WATCH_MODE_LIVE_FEEDBACK_LOOP_PREVENTION)'."
  }
  $FeedbackLoopPrevention = $env:OMNI_WATCH_MODE_LIVE_FEEDBACK_LOOP_PREVENTION
}
if (-not $PSBoundParameters.ContainsKey("DevconPath") -and $env:OMNI_WATCH_MODE_DEVCON_PATH) {
  $DevconPath = $env:OMNI_WATCH_MODE_DEVCON_PATH
}

function New-WatchModeOutputDirectory {
  param([string]$Root)
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $modelSuffix = if ($WatchModelId) { "-$($WatchModelId -replace '[^A-Za-z0-9_.-]', '_')" } else { "" }
  $feedbackSuffix = if ($FeedbackLoopPrevention -eq "virtual-driver") { "" } else { "-$FeedbackLoopPrevention" }
  $deviceSuffix = "-$($PhysicalPlaybackDeviceProfileId -replace '[^A-Za-z0-9_.-]', '_')"
  $resolvedRoot = if ([System.IO.Path]::IsPathRooted($Root)) {
    [System.IO.Path]::GetFullPath($Root)
  } else {
    Join-Path (Resolve-Path ".").Path $Root
  }
  $target = Join-Path $resolvedRoot "$timestamp$modelSuffix$feedbackSuffix$deviceSuffix"
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  return $target
}

function Resolve-OmniBuiltExecutable {
  # Every workspace member builds into the root Cargo target directory.
  param(
    [Parameter(Mandatory = $true)][string]$BuildProfile,
    [Parameter(Mandatory = $true)][string]$ExecutableName
  )
  return (Join-Path $workspaceRoot "target/$BuildProfile/$ExecutableName")
}

function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Script,
    [switch]$ContinueOnError
  )
  Write-Host "==> $Name"
  try {
    $global:LASTEXITCODE = 0
    $result = & $Script
    if ($LASTEXITCODE -ne 0) {
      throw "$Name failed with exit code $LASTEXITCODE"
    }
    return [pscustomobject]@{
      name = $Name
      ok = $true
      result = $result
      error = $null
    }
  } catch {
    if (-not $ContinueOnError) {
      throw
    }
    return [pscustomobject]@{
      name = $Name
      ok = $false
      result = $null
      error = $_.Exception.Message
    }
  }
}

function Copy-IfExists {
  param([string]$Source, [string]$Destination)
  if (Test-Path -LiteralPath $Source -PathType Leaf) {
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
    return $Destination
  }
  return $null
}

function Assert-WatchSessionReportFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "required Watch session report was not generated: $Path"
  }
  try {
    $report = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw "required Watch session report is invalid JSON at '$Path': $($_.Exception.Message)"
  }
  if ($null -eq $report -or -not $report.sessionId) {
    throw "required Watch session report is empty or missing sessionId: $Path"
  }
  if ($report.status -ne "completed") {
    throw "required Watch session report is not completed at '$Path': status=$($report.status)"
  }
  return $report
}

function Wait-WatchSessionReportAndDesktopExit {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][DateTime]$DeadlineUtc
  )
  do {
    $reportReady = Test-Path -LiteralPath $Path -PathType Leaf
    $desktopRunning = $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
    if ($reportReady -and -not $desktopRunning) {
      Assert-WatchSessionReportFile $Path | Out-Null
      return [pscustomobject]@{
        reportPath = $Path
        desktopExited = $true
      }
    }
    if (-not $desktopRunning -and -not $reportReady) {
      throw "Watch desktop exited before writing the required session report: $Path"
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $DeadlineUtc)

  throw "timed out waiting for same-process Watch report and desktop exit. ProcessId=$ProcessId ReportReady=$reportReady DeadlineUtc=$($DeadlineUtc.ToString('o')) Path=$Path"
}

function Get-WatchSessionReportDeadlineUtc {
  param(
    [Parameter(Mandatory = $true)][DateTime]$LaunchedAtUtc,
    [Parameter(Mandatory = $true)][int]$ReadyTimeoutSeconds,
    [Parameter(Mandatory = $true)][int]$AutoStopAfterSeconds,
    [int]$CompletionGraceSeconds = 120
  )
  return $LaunchedAtUtc.AddSeconds($ReadyTimeoutSeconds + $AutoStopAfterSeconds + $CompletionGraceSeconds)
}

function Set-Utf8NoBomContent {
  param([string]$Path, [string]$Value)
  $encoding = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Add-CoreAudioPolicyConfig {
  if ([type]::GetType("OmniTranslate.AudioPolicyConfigClient", $false)) {
    return
  }
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace OmniTranslate {
  public enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
  public enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

  [ComImport]
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    int NotImpl1();
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint);
  }

  [ComImport]
  [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr activationParams, out IntPtr interfacePointer);
    int OpenPropertyStore(int stgmAccess, out IntPtr properties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
  }

  [ComImport]
  [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  public class MMDeviceEnumerator {}

  [ComImport]
  [Guid("F8679F50-850A-41CF-9C72-430F290290C8")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPolicyConfig {
    int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId, out IntPtr format);
    int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int defaultFormat, out IntPtr format);
    int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId);
    int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr endpointFormat, IntPtr mixFormat);
    int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int defaultPeriod, out long defaultProcessingPeriod, out long minimumProcessingPeriod);
    int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string deviceId, ref long processingPeriod);
    int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr mode);
    int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr mode);
    int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string deviceId, ref Guid key, IntPtr value);
    int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string deviceId, ref Guid key, IntPtr value);
    int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, ERole role);
    int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int visible);
  }

  [ComImport]
  [Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
  public class AudioPolicyConfigClient {}

  public static class AudioEndpointSwitcher {
    public static string GetDefaultRenderEndpointId() {
      var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
      IMMDevice device;
      enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device);
      if (device == null) {
        return null;
      }
      string id;
      device.GetId(out id);
      return id;
    }

    public static void SetDefaultRenderEndpoint(string endpointId) {
      if (String.IsNullOrWhiteSpace(endpointId)) {
        return;
      }
      var policy = (IPolicyConfig)(new AudioPolicyConfigClient());
      policy.SetDefaultEndpoint(endpointId, ERole.eConsole);
      policy.SetDefaultEndpoint(endpointId, ERole.eMultimedia);
      policy.SetDefaultEndpoint(endpointId, ERole.eCommunications);
    }
  }
}
"@
}

function Convert-ComObjectToInterface {
  param([object]$ComObject, [type]$InterfaceType)
  $unknown = [System.Runtime.InteropServices.Marshal]::GetIUnknownForObject($ComObject)
  try {
    return [System.Runtime.InteropServices.Marshal]::GetTypedObjectForIUnknown($unknown, $InterfaceType)
  } finally {
    [void][System.Runtime.InteropServices.Marshal]::Release($unknown)
  }
}

function Get-DefaultRenderEndpointId {
  Add-CoreAudioPolicyConfig
  return [OmniTranslate.AudioEndpointSwitcher]::GetDefaultRenderEndpointId()
}

function Get-PhysicalPlaybackDeviceClassFromSignals {
  param([string[]]$Signals)
  $classificationText = (@($Signals) | Where-Object { $_ } | ForEach-Object { [string]$_ }) -join " "
  if ($classificationText -match '(?i)bluetooth|\bbth(?:enum|hf|a2dp)?\b|a2dp|hands[ -]?free') {
    return "bluetooth"
  }
  if ($classificationText -match '(?i)\busb\b|usb[\\#_-]|vid_[0-9a-f]{4}') {
    return "usb"
  }
  if ($classificationText.Trim()) {
    return "default-speaker"
  }
  return $null
}

function Get-RenderEndpointRegistryIdentity {
  param([string]$RequestedDeviceId)
  $resolvedDeviceId = if (-not $RequestedDeviceId -or $RequestedDeviceId -eq "default") {
    Get-DefaultRenderEndpointId
  } else {
    $RequestedDeviceId
  }
  if (-not $resolvedDeviceId) {
    throw "Windows did not resolve a physical render endpoint id for '$RequestedDeviceId'."
  }
  # MMDevices stores the endpoint under the GUID suffix, while the Core Audio
  # API commonly returns the full {flow}.{guid} device id.
  $registryDeviceId = if ($resolvedDeviceId -match '^\{[^}]+\}\.\{[^}]+\}$') {
    $resolvedDeviceId.Substring($resolvedDeviceId.IndexOf('}.') + 2)
  } else {
    $resolvedDeviceId
  }
  $registryPath = "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render\$registryDeviceId\Properties"
  if (-not (Test-Path -LiteralPath $registryPath -PathType Container)) {
    throw "physical render endpoint '$resolvedDeviceId' has no Windows MMDevice registry evidence"
  }
  $properties = Get-ItemProperty -LiteralPath $registryPath
  $friendlyName = [string]$properties.'{a45c254e-df1c-4efd-8020-67d146a850e0},14'
  if (-not $friendlyName.Trim()) {
    $endpointName = [string]$properties.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
    $deviceName = [string]$properties.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6'
    $friendlyName = if ($endpointName.Trim() -and $deviceName.Trim()) {
      "$($endpointName.Trim()) ($($deviceName.Trim()))"
    } elseif ($endpointName.Trim()) {
      $endpointName
    } else {
      $deviceName
    }
  }
  if (-not $friendlyName.Trim()) {
    throw "physical render endpoint '$resolvedDeviceId' has no Windows MMDevice friendly name"
  }
  $signals = @($resolvedDeviceId, $friendlyName)
  foreach ($property in $properties.PSObject.Properties) {
    if ($property.Name -like 'PS*' -or $null -eq $property.Value) { continue }
    if ($property.Value -is [string]) {
      $signals += [string]$property.Value
    } elseif ($property.Value -is [string[]]) {
      $signals += @($property.Value)
    }
  }
  return [pscustomobject]@{
    resolvedDeviceId = $resolvedDeviceId
    resolvedDeviceName = $friendlyName.Trim()
    classificationSignals = @($signals | Where-Object { $_ } | Select-Object -Unique -First 32)
  }
}

function New-PhysicalPlaybackDeviceEvidence {
  param(
    [string]$ProfileId,
    [string]$ExpectedDeviceClass,
    [string]$RequestedDeviceId,
    [string]$ResolvedDeviceId,
    [string]$ResolvedDeviceName,
    [string[]]$ClassificationSignals,
    [string]$RouteEvidenceSource,
    [bool]$FixtureOnly = $false
  )
  $inferredClass = Get-PhysicalPlaybackDeviceClassFromSignals @(
    $ResolvedDeviceId,
    $ResolvedDeviceName,
    $ClassificationSignals
  )
  if ($inferredClass -ne $ExpectedDeviceClass) {
    throw "physical endpoint class mismatch: profile=$ProfileId expected=$ExpectedDeviceClass inferred=$inferredClass id=$ResolvedDeviceId name=$ResolvedDeviceName"
  }
  return [pscustomobject]@{
    profileId = $ProfileId
    deviceClass = $ExpectedDeviceClass
    requestedDeviceId = $RequestedDeviceId
    resolvedDeviceId = $ResolvedDeviceId
    resolvedDeviceName = $ResolvedDeviceName
    classificationSignals = @($ClassificationSignals)
    classificationSource = "windows-mmdevice-registry"
    routeEvidenceSource = $RouteEvidenceSource
    verified = -not $FixtureOnly
    fixtureOnly = $FixtureOnly
  }
}

function Resolve-PhysicalPlaybackDeviceEvidence {
  param($PhysicalOutputProbe)
  $probeResult = if ($PhysicalOutputProbe -and $PhysicalOutputProbe.ok) {
    $PhysicalOutputProbe.result
  } else {
    $null
  }
  if ($FeedbackLoopPrevention -ne "echo-cancel") {
    if (-not $probeResult -or $probeResult.skipped -or -not $probeResult.passed) {
      throw "the $FeedbackLoopPrevention route has no passed physical-output endpoint probe"
    }
  }
  $probeResolvedId = if ($probeResult) { [string]$probeResult.resolvedPhysicalPlaybackDeviceId } else { "" }
  $identity = Get-RenderEndpointRegistryIdentity $(
    if ($probeResolvedId) { $probeResolvedId } else { $PhysicalPlaybackDeviceId }
  )
  $probeResolvedName = if ($probeResult) { [string]$probeResult.resolvedPhysicalPlaybackDeviceName } else { "" }
  if ($ExpectedPhysicalPlaybackDeviceName) {
    $nameMatches = $identity.resolvedDeviceName -like "*$ExpectedPhysicalPlaybackDeviceName*" -or
      ($probeResolvedName -and $probeResolvedName -like "*$ExpectedPhysicalPlaybackDeviceName*")
    if (-not $nameMatches) {
      throw "resolved endpoint '$($identity.resolvedDeviceName)' does not match expected device name '$ExpectedPhysicalPlaybackDeviceName'"
    }
  }
  $signals = @($identity.classificationSignals)
  if ($probeResolvedName) { $signals += $probeResolvedName }
  $routeEvidenceSource = if ($FeedbackLoopPrevention -eq "echo-cancel") {
    "desktop-runtime-route+windows-mmdevice"
  } else {
    "physical-output-probe+runtime-route"
  }
  return New-PhysicalPlaybackDeviceEvidence `
    -ProfileId $PhysicalPlaybackDeviceProfileId `
    -ExpectedDeviceClass $PhysicalPlaybackDeviceClass `
    -RequestedDeviceId $PhysicalPlaybackDeviceId `
    -ResolvedDeviceId $identity.resolvedDeviceId `
    -ResolvedDeviceName $identity.resolvedDeviceName `
    -ClassificationSignals $signals `
    -RouteEvidenceSource $routeEvidenceSource
}

function Set-DefaultRenderEndpoint {
  param([string]$EndpointId)
  if (-not $EndpointId) {
    return
  }
  Add-CoreAudioPolicyConfig
  [OmniTranslate.AudioEndpointSwitcher]::SetDefaultRenderEndpoint($EndpointId)
}

function Set-DesktopAutostartEnvFile {
  param([string]$RunMarker, [string]$OutputDirectory)
  $envPath = Join-Path $workspaceRoot "apps/desktop/.env.local"
  $backupPath = Join-Path $OutputDirectory "desktop-env.local.backup"
  $hadFile = Test-Path -LiteralPath $envPath -PathType Leaf
  $original = if ($hadFile) { Get-Content -LiteralPath $envPath -Raw } else { "" }
  if ($hadFile) {
    Set-Utf8NoBomContent $backupPath $original
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
  $diagnosticSubtitleTranslationMode = $SubtitleTranslationMode
  $diagnosticTranslationAudioSource = if ($SubtitleTranslationMode -eq "native") { "omni-native" } else { "subtitle-tts" }
  $next = @($lines | Where-Object { $_ -ne "" })
  $next += "VITE_OMNI_WATCH_MODE_AUTOSTART=1"
  $next += "VITE_OMNI_WATCH_MODE_RUN_MARKER=$RunMarker"
  $next += "VITE_OMNI_WATCH_MODE_EXPIRES_AT_MS=$expiresAtMs"
  $next += "VITE_OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODE=$diagnosticSubtitleTranslationMode"
  $next += "VITE_OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE=$diagnosticTranslationAudioSource"
  if ($PhysicalPlaybackDeviceId) {
    $next += "VITE_OMNI_WATCH_MODE_OUTPUT_DEVICE_ID=$PhysicalPlaybackDeviceId"
    $next += "VITE_OMNI_WATCH_MODE_OUTPUT_LEVEL=50"
  }
  if ($WatchModelId) {
    $next += "VITE_OMNI_WATCH_MODE_MODEL_ID=$WatchModelId"
  }
  if ($SubtitleTranslationMode -eq "secondary" -and $SubtitleTranslationModelId) {
    $next += "VITE_OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID=$SubtitleTranslationModelId"
  }
  if ($SubtitleTranslationMode -eq "secondary" -and $InboundSecondaryAudioModelId) {
    $next += "VITE_OMNI_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID=$InboundSecondaryAudioModelId"
  }
  $next += "VITE_OMNI_WATCH_MODE_FEEDBACK_LOOP_PREVENTION=$FeedbackLoopPrevention"
  Set-Utf8NoBomContent $envPath (($next -join "`r`n") + "`r`n")
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
  param([string]$DeviceId)
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
  Set-Utf8NoBomContent $envPath (($lines -join "`r`n") + "`r`n")
}

function Get-PhysicalOutputResolvedDeviceId {
  param($PhysicalOutputProbeStep)
  if (-not ($PhysicalOutputProbeStep -and $PhysicalOutputProbeStep.ok -and $PhysicalOutputProbeStep.result)) {
    return $null
  }
  return [string]$PhysicalOutputProbeStep.result.resolvedPhysicalPlaybackDeviceId
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
  if ($DriverProbe.ok -eq $true) {
    return $null
  }
  $detail = [string]$DriverProbe.error
  if ([string]::IsNullOrWhiteSpace($detail)) {
    $detail = "the driver probe returned ok=false without diagnostics"
  }
  return "virtual-driver preflight failed before the Desktop/LLM session: $detail"
}

function Convert-DriverProbeToJsonFile {
  param($DriverProbe, [string]$TargetPath)
  if ($DriverProbe.ok) {
    $DriverProbe.result | ConvertTo-Json -Depth 8 | Set-Content -Path $TargetPath -Encoding UTF8
  } else {
    [pscustomobject]@{ error = $DriverProbe.error } | ConvertTo-Json -Depth 8 | Set-Content -Path $TargetPath -Encoding UTF8
  }
}

function Get-SignedWorkerReadinessDriverProbe {
  param([string]$ReceiptPath)
  . (Join-Path $workspaceRoot 'scripts\installer\virtual-speaker-device.ps1')
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

function Stop-StaleBridgeService {
  param([string]$RootForRuntime)
  $resolvedRuntimeRoot = if ([System.IO.Path]::IsPathRooted($RootForRuntime)) {
    $RootForRuntime
  } else {
    Join-Path $workspaceRoot $RootForRuntime
  }
  & (Join-Path $workspaceRoot "scripts/installer/stop-stale-bridge-service.ps1") -WorkspaceRoot $workspaceRoot -RuntimeRoot $resolvedRuntimeRoot
}

function Stop-ElevatedWatchModeProcesses {
  $runnerProcess = [System.Diagnostics.Process]::GetCurrentProcess()
  $runnerStartTimeUtcTicks = [long]$runnerProcess.StartTime.ToUniversalTime().Ticks
  $command = "Get-Process omni-desktop-shell,omni-bridge-service -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"
  $encodedCommand = New-ParentGuardedPowerShellCommand `
    -ParentProcessId $PID `
    -ParentStartTimeUtcTicks $runnerStartTimeUtcTicks `
    -CommandBody $command
  $process = Start-Process -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encodedCommand) `
    -Verb RunAs `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
  return [pscustomobject]@{
    exitCode = $process.ExitCode
  }
}

function Invoke-ReportGenerator {
  param([string]$InputDirectory, [string]$Mode)
  node ./scripts/testing/watch-mode-report.mjs --input $InputDirectory --output $InputDirectory --mode $Mode
  if ($LASTEXITCODE -ne 0) {
    throw "watch-mode report generator failed with exit code $LASTEXITCODE"
  }
  node ./scripts/testing/watch-mode-score.mjs --input $InputDirectory
  if ($LASTEXITCODE -ne 0) {
    throw "watch-mode benchmark scorer failed with exit code $LASTEXITCODE"
  }
  if ($Mode -eq "live") {
    Write-LatestWatchModeSummary $InputDirectory
  }
}

function Ensure-ObjectProperty {
  param($Object, [string]$Name)
  if (-not $Object.PSObject.Properties[$Name] -or $null -eq $Object.$Name) {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  return $Object.$Name
}

function Ensure-ValueProperty {
  param($Object, [string]$Name)
  if (-not $Object.PSObject.Properties[$Name]) {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $null
  }
}

function Enter-StrictPaidProviderEnvironment {
  param(
    [bool]$Enabled,
    [bool]$IncidentReplay = $false
  )
  $fixed = [ordered]@{
    OMNI_WATCH_MODE_EXPECTED_PROVIDER_ID = "provider-dashscope"
    OMNI_WATCH_MODE_EXPECTED_PROVIDER_TEMPLATE_ID = "template-dashscope-realtime"
    OMNI_WATCH_MODE_EXPECTED_PROVIDER_KIND = "dashscope"
    OMNI_WATCH_MODE_EXPECTED_PROVIDER_ENDPOINT_HOST = "dashscope.aliyuncs.com"
    OMNI_WATCH_MODE_EXPECTED_PROVIDER_CREDENTIAL_REFERENCE = "credential://provider/dashscope/default"
  }
  if ($Enabled) {
    $fixed.OMNI_WATCH_MODE_STRICT_PAID_AUTHORITY = "1"
  }
  if ($IncidentReplay) {
    $fixed.OMNI_WATCH_MODE_INCIDENT_REPLAY_AUTHORITY = "1"
    $fixed.OMNI_WATCH_MODE_INCIDENT_ID = "watch-mode-loss-incident-plus-v1"
  }
  $previous = [ordered]@{}
  foreach ($entry in $fixed.GetEnumerator()) {
    $previous[$entry.Key] = [Environment]::GetEnvironmentVariable(
      $entry.Key,
      [EnvironmentVariableTarget]::Process
    )
    if ($Enabled -or $IncidentReplay) {
      [Environment]::SetEnvironmentVariable(
        $entry.Key,
        [string]$entry.Value,
        [EnvironmentVariableTarget]::Process
      )
    }
  }
  return [pscustomobject]@{
    enabled = $Enabled -or $IncidentReplay
    names = @($fixed.Keys)
    values = $fixed
    previous = $previous
  }
}

function Exit-StrictPaidProviderEnvironment {
  param($State)
  if (-not $State) { return }
  foreach ($name in @($State.names)) {
    [Environment]::SetEnvironmentVariable(
      [string]$name,
      $State.previous[[string]$name],
      [EnvironmentVariableTarget]::Process
    )
  }
}

function Set-WatchModelOnConfig {
  param(
    $Config,
    [string]$ModelId,
    [string]$RealtimeProtocol = "",
    [bool]$RequireStrictProvider = $false
  )
  if (-not $ModelId) {
    return
  }
  if (-not $Config.devices) {
    $Config | Add-Member -NotePropertyName devices -NotePropertyValue ([pscustomobject]@{})
  }
  $Config.devices.inboundVoiceModelId = $ModelId
  $Config.devices.outboundVoiceModelId = $ModelId
  $Config.devices.textToSpeechModelId = $ModelId
  if (-not $Config.speech) {
    $Config | Add-Member -NotePropertyName speech -NotePropertyValue ([pscustomobject]@{})
  }
  $Config.speech.textToSpeechModelId = $ModelId
  if ($RealtimeProtocol) {
    $separator = $ModelId.IndexOf("::")
    $templateId = if ($separator -ge 0) { $ModelId.Substring(0, $separator) } else { "" }
    $resolvedModelId = if ($separator -ge 0) { $ModelId.Substring($separator + 2) } else { $ModelId }
    if ($RequireStrictProvider) {
      if ($RealtimeProtocol -notin @("dashscope-omni", "dashscope-livetranslate")) {
        throw "Strict paid Watch provider requires a budget-approved DashScope realtime protocol."
      }
      $strictProviders = @($Config.providers | Where-Object {
        $_.providerId -ceq "provider-dashscope" -and
        $_.templateId -ceq "template-dashscope-realtime"
      })
      if ($strictProviders.Count -ne 1) {
        throw "Strict paid Watch provider requires exactly one provider-dashscope/template-dashscope-realtime entry."
      }
      $provider = $strictProviders[0]
      $providerUri = $null
      if (-not [Uri]::TryCreate([string]$provider.baseUrl, [UriKind]::Absolute, [ref]$providerUri)) {
        throw "Strict paid Watch provider baseUrl is not an absolute URI."
      }
      if (
        $provider.kind -cne "dashscope" -or
        $providerUri.Scheme -cne "https" -or
        -not [string]::IsNullOrEmpty($providerUri.UserInfo) -or
        -not $providerUri.IsDefaultPort -or
        $providerUri.Host -cne "dashscope.aliyuncs.com" -or
        $provider.streamEnabled -ne $true -or
        $provider.authRef.kind -cne "credential-ref" -or
        $provider.authRef.reference -cne "credential://provider/dashscope/default" -or
        $provider.authRef.headerName -cne "Authorization" -or
        $provider.authRef.scheme -cne "bearer" -or
        @($provider.customHeaders).Count -ne 0 -or
        $provider.systemPromptTemplate -cne "game-live-translation-cn" -or
        $provider.timeoutMs -ne 12000 -or
        [double]$provider.temperature -ne 0.2 -or
        $provider.maxOutputTokens -ne 256 -or
        @($provider.responseModalities).Count -ne 1 -or
        @($provider.responseModalities)[0] -cne "text"
      ) {
        throw "Strict paid Watch provider identity, endpoint, or credential reference does not match the signed authority."
      }
    } else {
      $provider = @($Config.providers | Where-Object {
        ($templateId -and $_.templateId -eq $templateId) -or
        (-not $templateId -and (
          ($RealtimeProtocol -like "dashscope-*" -and $_.kind -eq "dashscope") -or
          ($RealtimeProtocol -like "openai-*" -and $_.kind -eq "openai-compatible") -or
          ($RealtimeProtocol -eq "gemini-live" -and $_.templateId -like "*gemini*")
        ))
      } | Select-Object -First 1)
    }
    if (-not $provider) {
      throw "No provider can host explicit Watch realtime protocol '$RealtimeProtocol'."
    }
    $provider.model = $resolvedModelId
    $capabilities = if ($RealtimeProtocol -in @("dashscope-asr", "openai-transcription")) {
      @("speech-to-text")
    } else {
      @("speech-to-text", "speech-to-speech")
    }
    $entry = [pscustomobject]@{
      id = "watch-live-explicit-alias"
      modelId = $resolvedModelId
      capabilities = $capabilities
      realtimeProtocol = $RealtimeProtocol
      realtimeAudioMode = if ($RealtimeProtocol -eq "dashscope-omni") { "manual" } else { "server_vad" }
      interactionCapabilities = if ($RealtimeProtocol -eq "dashscope-omni") {
        @("manual_commit", "streaming")
      } else {
        @("streaming", "auto_vad")
      }
    }
    $existing = @($provider.localModelCapabilityRegistry | Where-Object { $_.modelId -ne $resolvedModelId })
    $provider.localModelCapabilityRegistry = @($entry) + $existing
  }
}

function Set-WatchModeSecondaryConfig {
  param(
    $Config,
    [string]$SubtitleModelId,
    [string]$SecondaryAudioModelId,
    [string]$FeedbackMode = $FeedbackLoopPrevention,
    [ValidateSet("native", "secondary")]
    [string]$TranslationMode = $SubtitleTranslationMode
  )
  if (-not $Config.devices) {
    $Config | Add-Member -NotePropertyName devices -NotePropertyValue ([pscustomobject]@{})
  }
  if (-not $Config.speech) {
    $Config | Add-Member -NotePropertyName speech -NotePropertyValue ([pscustomobject]@{})
  }
  $inboundRoute = Ensure-ObjectProperty $Config.devices "inboundRoute"
  $mixControl = Ensure-ObjectProperty $inboundRoute "mixControl"
  foreach ($name in @(
    "subtitleTranslationMode",
    "subtitleTranslationModelId",
    "inboundSecondaryAudioModelId",
    "textToSpeechModelId",
    "outputSpeechEnabled",
    "feedbackLoopPrevention"
  )) {
    Ensure-ValueProperty $Config.devices $name
  }
  foreach ($name in @(
    "textToSpeechModelId",
    "enabled",
    "outputTarget",
    "localPlaybackEnabled",
    "virtualMicOutputEnabled",
    "translationAudioSource"
  )) {
    Ensure-ValueProperty $Config.speech $name
  }
  foreach ($name in @(
    "keepOriginalAudio",
    "translatedAudioEnabled",
    "originalAudioGainDb",
    "translatedAudioGainDb",
    "duckingEnabled",
    "monitorMode"
  )) {
    Ensure-ValueProperty $mixControl $name
  }
  if ($TranslationMode -eq "native") {
    $Config.devices.subtitleTranslationMode = "native"
    $Config.devices.subtitleTranslationModelId = ""
    $Config.devices.inboundSecondaryAudioModelId = ""
    $Config.devices.outputSpeechEnabled = $true
    $Config.devices.feedbackLoopPrevention = $FeedbackMode
    $mixControl.keepOriginalAudio = $true
    $mixControl.translatedAudioEnabled = $true
    $mixControl.originalAudioGainDb = 0
    $mixControl.translatedAudioGainDb = 0
    $mixControl.duckingEnabled = $true
    $mixControl.monitorMode = "original-and-translated"
    $Config.speech.enabled = $true
    $Config.speech.outputTarget = "speaker"
    $Config.speech.localPlaybackEnabled = $true
    $Config.speech.virtualMicOutputEnabled = $false
    $Config.speech.translationAudioSource = "omni-native"
    return
  }
  $Config.devices.subtitleTranslationMode = "secondary"
  if ($SubtitleModelId) {
    $Config.devices.subtitleTranslationModelId = $SubtitleModelId
  }
  if ($SecondaryAudioModelId) {
    $Config.devices.inboundSecondaryAudioModelId = $SecondaryAudioModelId
    $Config.devices.textToSpeechModelId = $SecondaryAudioModelId
    $Config.speech.textToSpeechModelId = $SecondaryAudioModelId
  }
  $Config.devices.outputSpeechEnabled = $true
  $Config.devices.feedbackLoopPrevention = $FeedbackMode
  $mixControl.keepOriginalAudio = $true
  $mixControl.translatedAudioEnabled = $true
  $mixControl.originalAudioGainDb = 0
  $mixControl.translatedAudioGainDb = 0
  $mixControl.duckingEnabled = $true
  $mixControl.monitorMode = "original-and-translated"
  $Config.speech.enabled = $true
  $Config.speech.outputTarget = "speaker"
  $Config.speech.localPlaybackEnabled = $true
  $Config.speech.virtualMicOutputEnabled = $false
  $Config.speech.translationAudioSource = "subtitle-tts"
}

function Write-LatestWatchModeSummary {
  param([string]$RunDirectory)
  $reportPath = Join-Path $RunDirectory "report.json"
  if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) {
    throw "watch-mode report was not generated: $reportPath"
  }
  $report = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $summaryPath = Join-Path (Split-Path -Parent $RunDirectory) "latest-watch-mode-live.json"
  [ordered]@{
    timestamp = Split-Path -Leaf $RunDirectory
    reportPath = $reportPath
    verdict = $report.verdict
    failureLayer = $report.failureLayer
    modelId = $report.modelId
    feedbackLoopPrevention = $report.feedbackLoopPrevention
  } | ConvertTo-Json -Depth 4 | Set-Content -Path $summaryPath -Encoding UTF8
}

function Invoke-ElevatedDriverReinstall {
  param([string]$OutputDirectory)
  $operationId = "watch-mode-live-reinstall-$([System.Guid]::NewGuid().ToString('N'))"
  $resultPath = Join-Path $OutputDirectory "driver-reinstall-result.json"
  & (Join-Path $workspaceRoot "scripts/installer/request-elevated-driver-operation.ps1") `
    -Action reinstall `
    -OperationId $operationId `
    -ResultPath $resultPath `
    -WorkspaceRoot $workspaceRoot `
    -RuntimeRoot $RuntimeRoot `
    -InstallChannel development `
    -DriverVersion 0.10.0-dev `
    -BridgeVersion 0.1.0 `
    -TargetDeviceId virtual-mic-default `
    -VirtualRenderDeviceId omni-virtual-speaker-default
  if (Test-Path -LiteralPath $resultPath -PathType Leaf) {
    return Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  }
  throw "driver.elevated-reinstall-result-missing: $resultPath"
}

function Invoke-NativeProcessToLog {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory,
    [string]$StdoutPath,
    [string]$StderrPath,
    [int]$TimeoutSeconds = 0
  )
  $process = Start-Process -FilePath $FilePath `
    -ArgumentList $ArgumentList `
    -WorkingDirectory $WorkingDirectory `
    -RedirectStandardOutput $StdoutPath `
    -RedirectStandardError $StderrPath `
    -WindowStyle Hidden `
    -PassThru
  if ($TimeoutSeconds -gt 0) {
    $exited = $process.WaitForExit($TimeoutSeconds * 1000)
    if (-not $exited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      return 124
    }
  } else {
    $process.WaitForExit()
  }
  try {
    $process.Refresh()
  } catch {
  }
  if ($null -eq $process.ExitCode) {
    return 0
  }
  return $process.ExitCode
}

function New-ParentGuardedPowerShellCommand {
  param(
    [Parameter(Mandatory = $true)][int]$ParentProcessId,
    [Parameter(Mandatory = $true)][long]$ParentStartTimeUtcTicks,
    [Parameter(Mandatory = $true)][string]$CommandBody
  )
  $guardedCommand = @"
`$parentAlive = `$false
try {
  `$parentProcess = Get-Process -Id $ParentProcessId -ErrorAction Stop
  `$parentProcess.Refresh()
  `$parentAlive = ([long]`$parentProcess.StartTime.ToUniversalTime().Ticks -eq $ParentStartTimeUtcTicks)
} catch {
  `$parentAlive = `$false
}
if (-not `$parentAlive) {
  exit 125
}
$CommandBody
"@
  return [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($guardedCommand))
}

function ConvertTo-PowerShellSingleQuotedLiteral {
  param([AllowEmptyString()][string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

function New-ElevatedDesktopGuardianCommand {
  param(
    [Parameter(Mandatory = $true)][int]$ParentProcessId,
    [Parameter(Mandatory = $true)][long]$ParentStartTimeUtcTicks,
    [Parameter(Mandatory = $true)][string]$LeasePath,
    [Parameter(Mandatory = $true)][string]$EnvironmentPath,
    [Parameter(Mandatory = $true)][string]$ReceiptPath,
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$StdoutPath,
    [Parameter(Mandatory = $true)][string]$StderrPath
  )
  $leaseLiteral = ConvertTo-PowerShellSingleQuotedLiteral $LeasePath
  $environmentLiteral = ConvertTo-PowerShellSingleQuotedLiteral $EnvironmentPath
  $receiptLiteral = ConvertTo-PowerShellSingleQuotedLiteral $ReceiptPath
  $executableLiteral = ConvertTo-PowerShellSingleQuotedLiteral $ExecutablePath
  $workingDirectoryLiteral = ConvertTo-PowerShellSingleQuotedLiteral $WorkingDirectory
  $stdoutLiteral = ConvertTo-PowerShellSingleQuotedLiteral $StdoutPath
  $stderrLiteral = ConvertTo-PowerShellSingleQuotedLiteral $StderrPath
  $guardianCommand = @"
`$ErrorActionPreference = 'Stop'
`$expectedParentId = $ParentProcessId
`$expectedParentStartTicks = [long]$ParentStartTimeUtcTicks
`$leasePath = $leaseLiteral
`$environmentPath = $environmentLiteral
`$receiptPath = $receiptLiteral
`$desktopProcess = `$null

function Test-RunnerLease {
  if (-not (Test-Path -LiteralPath `$leasePath -PathType Leaf)) {
    return `$false
  }
  try {
    `$parentProcess = Get-Process -Id `$expectedParentId -ErrorAction Stop
    `$parentProcess.Refresh()
    return ([long]`$parentProcess.StartTime.ToUniversalTime().Ticks -eq `$expectedParentStartTicks)
  } catch {
    return `$false
  }
}

function Write-LaunchReceipt {
  param([bool]`$Ok, [string]`$ErrorMessage = '')
  `$payload = if (`$Ok) {
    [ordered]@{
      ok = `$true
      pid = `$desktopProcess.Id
      guardianPid = `$PID
      launchedAtUtc = [DateTime]::UtcNow.ToString('o')
    }
  } else {
    [ordered]@{
      ok = `$false
      guardianPid = `$PID
      error = `$ErrorMessage
    }
  }
  `$temporaryReceiptPath = "`$receiptPath.`$PID.tmp"
  `$utf8 = [System.Text.UTF8Encoding]::new(`$false)
  [System.IO.File]::WriteAllText(`$temporaryReceiptPath, (`$payload | ConvertTo-Json -Compress), `$utf8)
  Move-Item -LiteralPath `$temporaryReceiptPath -Destination `$receiptPath -Force
}

try {
  # ShellExecute can finish long after its requesting runner was terminated.
  # Validate both PID and start time before doing anything irreversible so a
  # recycled PID cannot revive an expired Watch run.
  if (-not (Test-RunnerLease)) {
    exit 125
  }
  `$launchEnvironment = Get-Content -LiteralPath $environmentLiteral -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach (`$property in `$launchEnvironment.PSObject.Properties) {
    `$value = if (`$null -eq `$property.Value) { `$null } else { [string]`$property.Value }
    [System.Environment]::SetEnvironmentVariable(`$property.Name, `$value, [System.EnvironmentVariableTarget]::Process)
  }
  if (-not (Test-RunnerLease)) {
    exit 125
  }
  # Do not use backtick continuations inside this expandable here-string. The
  # outer parser consumes them while constructing the guardian script, which
  # leaves parameters such as -WorkingDirectory as standalone commands.
  `$desktopStartArguments = @{
    FilePath = $executableLiteral
    WorkingDirectory = $workingDirectoryLiteral
    RedirectStandardOutput = $stdoutLiteral
    RedirectStandardError = $stderrLiteral
    WindowStyle = 'Hidden'
    PassThru = `$true
  }
  `$desktopProcess = Start-Process @desktopStartArguments
  Write-LaunchReceipt -Ok `$true

  while (-not `$desktopProcess.HasExited) {
    if (-not (Test-RunnerLease)) {
      Start-Process -FilePath 'taskkill.exe' `
        -ArgumentList @('/PID', "`$(`$desktopProcess.Id)", '/F', '/T') `
        -WindowStyle Hidden `
        -Wait `
        -ErrorAction SilentlyContinue | Out-Null
      exit 125
    }
    Start-Sleep -Milliseconds 200
    `$desktopProcess.Refresh()
  }
  exit `$desktopProcess.ExitCode
} catch {
  try {
    Write-LaunchReceipt -Ok `$false -ErrorMessage `$_.Exception.Message
  } catch {
  }
  if (`$desktopProcess -and -not `$desktopProcess.HasExited) {
    Start-Process -FilePath 'taskkill.exe' `
      -ArgumentList @('/PID', "`$(`$desktopProcess.Id)", '/F', '/T') `
      -WindowStyle Hidden `
      -Wait `
      -ErrorAction SilentlyContinue | Out-Null
  }
  exit 1
}
"@
  return [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($guardianCommand))
}

function Start-ElevatedWatchModeDesktopShell {
  param(
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)][hashtable]$LaunchEnvironment,
    [Parameter(Mandatory = $true)][string]$StdoutPath,
    [Parameter(Mandatory = $true)][string]$StderrPath
  )
  $environmentPath = Join-Path $OutputDirectory 'desktop-shell.elevated-environment.json'
  $receiptPath = Join-Path $OutputDirectory 'desktop-shell.elevated-launch.json'
  $leasePath = Join-Path $OutputDirectory 'desktop-shell.elevated-launch.lease'
  Remove-Item -LiteralPath $receiptPath, $leasePath -Force -ErrorAction SilentlyContinue
  Set-Utf8NoBomContent -Path $environmentPath -Value ($LaunchEnvironment | ConvertTo-Json -Compress)
  Set-Utf8NoBomContent -Path $leasePath -Value ([guid]::NewGuid().ToString('N'))

  $runnerProcess = [System.Diagnostics.Process]::GetCurrentProcess()
  $runnerStartTimeUtcTicks = [long]$runnerProcess.StartTime.ToUniversalTime().Ticks
  $encodedCommand = New-ElevatedDesktopGuardianCommand `
    -ParentProcessId $PID `
    -ParentStartTimeUtcTicks $runnerStartTimeUtcTicks `
    -LeasePath $leasePath `
    -EnvironmentPath $environmentPath `
    -ReceiptPath $receiptPath `
    -ExecutablePath $ExecutablePath `
    -WorkingDirectory $WorkingDirectory `
    -StdoutPath $StdoutPath `
    -StderrPath $StderrPath
  try {
    # UAC/ShellExecute is not part of this process tree. The elevated helper
    # therefore owns the desktop and continuously enforces the runner lease.
    $guardianProcess = Start-Process -FilePath 'powershell.exe' `
      -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encodedCommand) `
      -Verb RunAs `
      -WindowStyle Hidden `
      -PassThru
  } catch {
    Remove-Item -LiteralPath $leasePath -Force -ErrorAction SilentlyContinue
    throw
  }

  $receiptDeadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    if (Test-Path -LiteralPath $receiptPath -PathType Leaf) {
      $receipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if (-not $receipt.ok) {
        Remove-Item -LiteralPath $leasePath -Force -ErrorAction SilentlyContinue
        throw "elevated desktop guardian failed: $($receipt.error)"
      }
      return [pscustomobject]@{
        pid = [int]$receipt.pid
        guardianPid = [int]$receipt.guardianPid
        guardianLeasePath = $leasePath
        guardianEnvironmentPath = $environmentPath
        guardianReceiptPath = $receiptPath
        launchedAtUtc = [DateTime]::Parse([string]$receipt.launchedAtUtc).ToUniversalTime()
      }
    }
    $guardianProcess.Refresh()
    if ($guardianProcess.HasExited) {
      Remove-Item -LiteralPath $leasePath -Force -ErrorAction SilentlyContinue
      throw "elevated desktop guardian exited before launching the desktop shell. ExitCode=$($guardianProcess.ExitCode)"
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $receiptDeadline)

  Remove-Item -LiteralPath $leasePath -Force -ErrorAction SilentlyContinue
  throw "timed out waiting for elevated desktop guardian launch receipt: $receiptPath"
}

function Stop-ElevatedWatchModeDesktopLaunch {
  param($Launch)
  if (-not $Launch) {
    return [pscustomobject]@{ stopped = $false; reason = 'no tracked elevated desktop launch' }
  }
  if ($Launch.guardianLeasePath) {
    Remove-Item -LiteralPath $Launch.guardianLeasePath -Force -ErrorAction SilentlyContinue
  }
  $guardianPid = if ($Launch.guardianPid) { [int]$Launch.guardianPid } else { 0 }
  $deadline = [DateTime]::UtcNow.AddSeconds(3)
  while ($guardianPid -gt 0 -and (Get-Process -Id $guardianPid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
  }
  return [pscustomobject]@{
    stopped = $true
    pid = $Launch.pid
    guardianPid = $guardianPid
    guardianExited = ($guardianPid -le 0 -or -not (Get-Process -Id $guardianPid -ErrorAction SilentlyContinue))
  }
}

function Start-DesktopFrontendServer {
  param([string]$OutputDirectory)
  Stop-DesktopFrontendServer $null
  $stdout = Join-Path $OutputDirectory "desktop-frontend.stdout.log"
  $stderr = Join-Path $OutputDirectory "desktop-frontend.stderr.log"
  $process = Start-Process -FilePath "node.exe" `
    -ArgumentList @((Join-Path $workspaceRoot "scripts/testing/watch-mode-diagnostic-devurl-server.mjs")) `
    -WorkingDirectory $workspaceRoot `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -WindowStyle Hidden `
    -PassThru
  $deadline = (Get-Date).AddSeconds(25)
  do {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:4173" -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        return [pscustomobject]@{
          pid = $process.Id
          stdout = $stdout
          stderr = $stderr
          url = "http://127.0.0.1:4173"
        }
      }
    } catch {
      if ($process.HasExited) {
        $err = if (Test-Path -LiteralPath $stderr -PathType Leaf) { Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue } else { "" }
        throw "desktop frontend dev server exited before it became ready. ExitCode=$($process.ExitCode) Error=$err"
      }
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $deadline)
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  throw "timed out waiting for desktop frontend dev server at http://127.0.0.1:4173"
}

function Stop-DesktopFrontendServer {
  param($Server)
  if ($Server -and $Server.pid) {
    Stop-Process -Id $Server.pid -Force -ErrorAction SilentlyContinue
    Start-Process -FilePath "taskkill.exe" -ArgumentList @("/PID", "$($Server.pid)", "/F", "/T") -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue | Out-Null
  }
  Get-CimInstance Win32_Process -Filter "name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*watch-mode-diagnostic-devurl-server.mjs*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Start-WatchModeSystemMetricsSampler {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
  )
  $collectorPath = Join-Path $workspaceRoot "scripts/testing/collect-watch-mode-system-metrics.ps1"
  $metricsPath = Join-Path $OutputDirectory "system-metrics.json"
  $stdoutPath = Join-Path $OutputDirectory "system-metrics.stdout.log"
  $stderrPath = Join-Path $OutputDirectory "system-metrics.stderr.log"
  Remove-Item -LiteralPath $metricsPath -Force -ErrorAction SilentlyContinue
  $process = Start-Process -FilePath "powershell.exe" `
    -ArgumentList @(
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', "`"$collectorPath`"",
      '-RootProcessId', "$ProcessId",
      '-OutputPath', "`"$metricsPath`"",
      '-SampleIntervalMs', '1000'
    ) `
    -WorkingDirectory $workspaceRoot `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -WindowStyle Hidden `
    -PassThru
  $script:systemMetricsSamplerProcess = $process
  return [pscustomobject]@{
    pid = $process.Id
    rootProcessId = $ProcessId
    outputPath = $metricsPath
    stdout = $stdoutPath
    stderr = $stderrPath
    sampleIntervalMs = 1000
  }
}

function Complete-WatchModeSystemMetricsSampler {
  param($Sampler)
  if (-not $Sampler -or -not $Sampler.pid) {
    throw "system metrics sampler was not started"
  }
  $process = $script:systemMetricsSamplerProcess
  if ($process -and -not $process.HasExited) {
    Wait-Process -Id $process.Id -Timeout 15 -ErrorAction SilentlyContinue
    $process.Refresh()
  }
  if ($process -and -not $process.HasExited) {
    throw "system metrics sampler did not exit after desktop process $($Sampler.rootProcessId) exited"
  }
  if (-not (Test-Path -LiteralPath $Sampler.outputPath -PathType Leaf)) {
    $collectorError = if (Test-Path -LiteralPath $Sampler.stderr -PathType Leaf) {
      Get-Content -LiteralPath $Sampler.stderr -Raw -Encoding UTF8
    } else { '' }
    throw "system metrics sampler did not write $($Sampler.outputPath): $collectorError"
  }
  $metrics = Get-Content -LiteralPath $Sampler.outputPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (
    $metrics.artifactKind -ne 'watch-mode-system-metrics' -or
    $metrics.completionReason -ne 'root-process-exited' -or
    [int]$metrics.sampleCount -le 0 -or
    @($metrics.collectionErrors).Count -gt 0
  ) {
    throw (
      "system metrics sampler emitted unusable evidence: " +
      "completionReason=$($metrics.completionReason) sampleCount=$($metrics.sampleCount) " +
      "errors=$(@($metrics.collectionErrors) -join '; ')"
    )
  }
  return [pscustomobject]@{
    outputPath = $Sampler.outputPath
    sampleCount = [int]$metrics.sampleCount
    startedAt = $metrics.startedAt
    finishedAt = $metrics.finishedAt
    completionReason = $metrics.completionReason
  }
}

function Stop-WatchModeSystemMetricsSampler {
  $process = $script:systemMetricsSamplerProcess
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  $script:systemMetricsSamplerProcess = $null
}

function Get-WatchModeLiveScenarioEnvironment {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('virtual-driver', 'process-exclusion', 'echo-cancel')]
    [string]$FeedbackMode,
    [Parameter(Mandatory = $true)]
    [ValidateRange(180000, 7200000)]
    [int64]$AutoStopAfterMs
  )
  return [pscustomobject]@{
    autoStopAfterMs = "$AutoStopAfterMs"
    processExclusionRestartAfterMs = if ($FeedbackMode -eq 'process-exclusion') {
      "$([Math]::Floor($AutoStopAfterMs / 2))"
    } else { $null }
    aecLiveScenario = if ($FeedbackMode -eq 'echo-cancel') { '1' } else { $null }
  }
}

function Start-WatchModeDesktopShell {
  param([string]$OutputDirectory, [string]$RunMarker, [string]$PhysicalDeviceId)
  if ($SkipDesktopLaunch) {
    $existing = Get-Process -Name "omni-desktop-shell" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $existing) {
      throw "SkipDesktopLaunch was provided but no existing omni-desktop-shell process is running"
    }
    return [pscustomobject]@{
      pid = $existing.Id
      external = $true
      stdout = $null
      stderr = $null
      buildLog = $null
      cargoBuildLog = $null
      buildErrorLog = $null
      cargoBuildErrorLog = $null
      frontendServer = $null
    }
  }
  $stdout = Join-Path $OutputDirectory "desktop-shell.stdout.log"
  $stderr = Join-Path $OutputDirectory "desktop-shell.stderr.log"
  # A debug cargo build resolves Tauri's devUrl and the old harness paired it
  # with a placeholder HTML server. That path cannot exercise the real React
  # overlay or generate render receipts. Live evidence must use the production
  # binary whose frontendDist contains the actual main and overlay pages. Build
  # it once before the model matrix with `npm run build:tauri --workspace
  # @omni/desktop`; model timing begins only when this executable launches.
  $buildLog = $null
  $buildErrLog = $null
  $cargoLog = $null
  $cargoErrLog = $null
  $frontendServer = $null
  $exe = Resolve-OmniBuiltExecutable -BuildProfile "release" -ExecutableName "omni-desktop-shell.exe"
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "production desktop shell was not built: $exe. Run 'npm run build:tauri --workspace @omni/desktop' first."
  }
  $providerInputPcmPath = Join-Path $OutputDirectory "provider-input-16k-mono.pcm"
  $watchSessionReportPath = Join-Path $OutputDirectory "watch-session-report.json"
  $watchReportAutoStopAfterMs = $WatchAutoStopAfterSeconds * 1000
  $liveScenarioEnvironment = Get-WatchModeLiveScenarioEnvironment `
    -FeedbackMode $FeedbackLoopPrevention `
    -AutoStopAfterMs $watchReportAutoStopAfterMs
  Remove-Item -LiteralPath $watchSessionReportPath -Force -ErrorAction SilentlyContinue
  $previousAutostart = $env:OMNI_WATCH_MODE_AUTOSTART
  $previousRunMarker = $env:OMNI_WATCH_MODE_RUN_MARKER
  $previousOutputDevice = $env:OMNI_WATCH_MODE_OUTPUT_DEVICE_ID
  $previousOutputLevel = $env:OMNI_WATCH_MODE_OUTPUT_LEVEL
  $previousSubtitleTranslationMode = $env:OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODE
  $previousTranslationAudioSource = $env:OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE
  $previousProviderInputPcmPath = $env:OMNI_WATCH_MODE_PROVIDER_INPUT_PCM_PATH
  $previousProviderInputMaxSamples = $env:OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES
  $previousProviderInputLedgerPath = $env:OMNI_WATCH_MODE_PROVIDER_INPUT_LEDGER_PATH
  $previousProviderInputCellId = $env:OMNI_WATCH_MODE_CELL_ID
  $previousProviderInputLeaseId = $env:OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID
  $previousIncidentReplayAuthority = $env:OMNI_WATCH_MODE_INCIDENT_REPLAY_AUTHORITY
  $previousIncidentId = $env:OMNI_WATCH_MODE_INCIDENT_ID
  $previousTranslatedPcmAuthorityDir = $env:OMNI_WATCH_MODE_TRANSLATED_PCM_AUTHORITY_DIR
  $previousWatchModelId = $env:OMNI_WATCH_MODE_MODEL_ID
  $previousWatchRealtimeProtocol = $env:OMNI_WATCH_MODE_REALTIME_PROTOCOL
  $previousSubtitleTranslationModelId = $env:OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID
  $previousInboundSecondaryAudioModelId = $env:OMNI_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID
  $previousFeedbackLoopPrevention = $env:OMNI_WATCH_MODE_FEEDBACK_LOOP_PREVENTION
  $previousProcessExclusionRestartAfterMs = $env:OMNI_WATCH_MODE_PROCESS_EXCLUSION_RESTART_AFTER_MS
  $previousAecLiveScenario = $env:OMNI_WATCH_MODE_AEC_LIVE_SCENARIO
  $previousAutoStopAfterMs = $env:OMNI_WATCH_MODE_AUTO_STOP_AFTER_MS
  $previousReportPath = $env:OMNI_WATCH_MODE_REPORT_PATH
  $previousExitAfterReport = $env:OMNI_WATCH_MODE_EXIT_AFTER_REPORT
  $previousLogLevel = $env:OMNI_LOG_LEVEL
  $elevatedLaunch = $null
  $strictPaidProviderEnvironment = $null
  try {
    $strictPaidProviderEnvironment = Enter-StrictPaidProviderEnvironment `
      -Enabled $StrictPaidAuthority `
      -IncidentReplay $IncidentReplayAuthority
    $env:OMNI_WATCH_MODE_AUTOSTART = "1"
    $env:OMNI_WATCH_MODE_RUN_MARKER = $RunMarker
    $diagnosticOutputDeviceId = if ($PhysicalDeviceId) { $PhysicalDeviceId } else { "default" }
    $diagnosticSubtitleTranslationMode = $SubtitleTranslationMode
    $env:OMNI_WATCH_MODE_OUTPUT_DEVICE_ID = $diagnosticOutputDeviceId
    $env:OMNI_WATCH_MODE_OUTPUT_LEVEL = "50"
    # Echo-cancel evidence replays the realtime model's native output so AEC
    # observes the exact speaker signal. The virtual-driver route retains the
    # secondary subtitle-TTS path that it isolates from inbound capture.
    $env:OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODE = $diagnosticSubtitleTranslationMode
    $env:OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE = if ($SubtitleTranslationMode -eq "native") { "omni-native" } else { "subtitle-tts" }
    $env:OMNI_WATCH_MODE_PROVIDER_INPUT_PCM_PATH = $providerInputPcmPath
    if ($paidAuthorityEnabled) {
      $env:OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES = "$($WatchAutoStopAfterSeconds * 16000)"
      $env:OMNI_WATCH_MODE_PROVIDER_INPUT_LEDGER_PATH = Join-Path $OutputDirectory "provider-input-budget-ledger.json"
      $env:OMNI_WATCH_MODE_CELL_ID = $MatrixCellId
      $translatedPcmAuthorityDirectory = Join-Path $OutputDirectory "translated-cue-pcm"
      # The Rust authority owns exclusive creation of this directory. Creating
      # it here would turn a clean strict-paid launch into a deterministic
      # fail-closed collision before the first provider connection.
      $env:OMNI_WATCH_MODE_TRANSLATED_PCM_AUTHORITY_DIR = $translatedPcmAuthorityDirectory
      # The matrix/shard coordinator must issue this lease before the paid
      # process starts. Never mint or reuse an implicit ambient lease here.
      $env:OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID = $previousProviderInputLeaseId.Trim()
      $leaseReceipt = [ordered]@{
        schemaVersion = 1
        artifactKind = "watch-mode-provider-input-budget-lease"
        cellId = $MatrixCellId
        leaseId = $env:OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID
        runMarker = $RunMarker
        maxSamples = [int]$env:OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES
      }
      $leaseReceiptJson = $leaseReceipt | ConvertTo-Json -Depth 3
      [System.IO.File]::WriteAllText(
        (Join-Path $OutputDirectory "provider-input-budget-lease.json"),
        $leaseReceiptJson,
        [System.Text.UTF8Encoding]::new($false)
      )
    }
    if ($WatchModelId) {
      $env:OMNI_WATCH_MODE_MODEL_ID = $WatchModelId
    }
    if ($WatchRealtimeProtocol) {
      $env:OMNI_WATCH_MODE_REALTIME_PROTOCOL = $WatchRealtimeProtocol
    }
    if ($SubtitleTranslationMode -eq "secondary" -and $SubtitleTranslationModelId) {
      $env:OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID = $SubtitleTranslationModelId
    } elseif ($SubtitleTranslationMode -eq "native") {
      $env:OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID = ""
    }
    if ($SubtitleTranslationMode -eq "secondary" -and $InboundSecondaryAudioModelId) {
      $env:OMNI_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID = $InboundSecondaryAudioModelId
    } elseif ($SubtitleTranslationMode -eq "native") {
      $env:OMNI_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID = ""
    }
    $env:OMNI_WATCH_MODE_FEEDBACK_LOOP_PREVENTION = $FeedbackLoopPrevention
    $env:OMNI_WATCH_MODE_PROCESS_EXCLUSION_RESTART_AFTER_MS = $liveScenarioEnvironment.processExclusionRestartAfterMs
    $env:OMNI_WATCH_MODE_AEC_LIVE_SCENARIO = $liveScenarioEnvironment.aecLiveScenario
    $env:OMNI_WATCH_MODE_AUTO_STOP_AFTER_MS = $liveScenarioEnvironment.autoStopAfterMs
    $env:OMNI_WATCH_MODE_REPORT_PATH = $watchSessionReportPath
    $env:OMNI_WATCH_MODE_EXIT_AFTER_REPORT = "1"
    if ($paidAuthorityEnabled) {
      # Debug model-trace summaries and the PCM dump cross-check the Rust
      # send-boundary ledger, which remains the paid-input authority.
      $env:OMNI_LOG_LEVEL = "debug"
    }
    if ($AllowElevatedDesktopLaunch) {
      $watchEnvironmentNames = @(
        "OMNI_WATCH_MODE_AUTOSTART",
        "OMNI_WATCH_MODE_RUN_MARKER",
        "OMNI_WATCH_MODE_OUTPUT_DEVICE_ID",
        "OMNI_WATCH_MODE_OUTPUT_LEVEL",
        "OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODE",
        "OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE",
        "OMNI_WATCH_MODE_PROVIDER_INPUT_PCM_PATH",
        "OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES",
        "OMNI_WATCH_MODE_PROVIDER_INPUT_LEDGER_PATH",
        "OMNI_WATCH_MODE_CELL_ID",
        "OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID",
        "OMNI_WATCH_MODE_INCIDENT_REPLAY_AUTHORITY",
        "OMNI_WATCH_MODE_INCIDENT_ID",
        "OMNI_WATCH_MODE_TRANSLATED_PCM_AUTHORITY_DIR",
        "OMNI_WATCH_MODE_MODEL_ID",
        "OMNI_WATCH_MODE_REALTIME_PROTOCOL",
        "OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID",
        "OMNI_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID",
        "OMNI_WATCH_MODE_FEEDBACK_LOOP_PREVENTION",
        "OMNI_WATCH_MODE_PROCESS_EXCLUSION_RESTART_AFTER_MS",
        "OMNI_WATCH_MODE_AEC_LIVE_SCENARIO",
        "OMNI_WATCH_MODE_AUTO_STOP_AFTER_MS",
        "OMNI_WATCH_MODE_REPORT_PATH",
        "OMNI_WATCH_MODE_EXIT_AFTER_REPORT",
        "OMNI_LOG_LEVEL"
      )
      if ($paidAuthorityEnabled) {
        $watchEnvironmentNames += @($strictPaidProviderEnvironment.names)
      }
      $launchEnvironment = @{}
      foreach ($name in $watchEnvironmentNames) {
        $launchEnvironment[$name] = [System.Environment]::GetEnvironmentVariable($name, [System.EnvironmentVariableTarget]::Process)
      }
      $elevatedLaunch = Start-ElevatedWatchModeDesktopShell `
        -ExecutablePath $exe `
        -WorkingDirectory (Join-Path $workspaceRoot "apps/desktop/src-tauri") `
        -OutputDirectory $OutputDirectory `
        -LaunchEnvironment $launchEnvironment `
        -StdoutPath $stdout `
        -StderrPath $stderr
      $script:elevatedDesktopLaunch = $elevatedLaunch
      $desktopLaunchedAtUtc = $elevatedLaunch.launchedAtUtc
      $process = [pscustomobject]@{ Id = $elevatedLaunch.pid }
    } else {
      try {
        $desktopLaunchedAtUtc = [DateTime]::UtcNow
        $process = Start-Process -FilePath $exe -WorkingDirectory (Join-Path $workspaceRoot "apps/desktop/src-tauri") -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
      } catch {
        if ($_.Exception.Message -match "requires elevation|requires elevated|740") {
          throw "desktop shell requires elevation; rerun with -AllowElevatedDesktopLaunch so the runner can start it via UAC"
        }
        throw
      }
    }
  } finally {
    $env:OMNI_WATCH_MODE_AUTOSTART = $previousAutostart
    $env:OMNI_WATCH_MODE_RUN_MARKER = $previousRunMarker
    $env:OMNI_WATCH_MODE_OUTPUT_DEVICE_ID = $previousOutputDevice
    $env:OMNI_WATCH_MODE_OUTPUT_LEVEL = $previousOutputLevel
    $env:OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODE = $previousSubtitleTranslationMode
    $env:OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE = $previousTranslationAudioSource
    $env:OMNI_WATCH_MODE_PROVIDER_INPUT_PCM_PATH = $previousProviderInputPcmPath
    $env:OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES = $previousProviderInputMaxSamples
    $env:OMNI_WATCH_MODE_PROVIDER_INPUT_LEDGER_PATH = $previousProviderInputLedgerPath
    $env:OMNI_WATCH_MODE_CELL_ID = $previousProviderInputCellId
    $env:OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID = $previousProviderInputLeaseId
    $env:OMNI_WATCH_MODE_INCIDENT_REPLAY_AUTHORITY = $previousIncidentReplayAuthority
    $env:OMNI_WATCH_MODE_INCIDENT_ID = $previousIncidentId
    Exit-StrictPaidProviderEnvironment $strictPaidProviderEnvironment
    $env:OMNI_WATCH_MODE_TRANSLATED_PCM_AUTHORITY_DIR = $previousTranslatedPcmAuthorityDir
    $env:OMNI_WATCH_MODE_MODEL_ID = $previousWatchModelId
    $env:OMNI_WATCH_MODE_REALTIME_PROTOCOL = $previousWatchRealtimeProtocol
    $env:OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID = $previousSubtitleTranslationModelId
    $env:OMNI_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID = $previousInboundSecondaryAudioModelId
    $env:OMNI_WATCH_MODE_FEEDBACK_LOOP_PREVENTION = $previousFeedbackLoopPrevention
    $env:OMNI_WATCH_MODE_PROCESS_EXCLUSION_RESTART_AFTER_MS = $previousProcessExclusionRestartAfterMs
    $env:OMNI_WATCH_MODE_AEC_LIVE_SCENARIO = $previousAecLiveScenario
    $env:OMNI_WATCH_MODE_AUTO_STOP_AFTER_MS = $previousAutoStopAfterMs
    $env:OMNI_WATCH_MODE_REPORT_PATH = $previousReportPath
    $env:OMNI_WATCH_MODE_EXIT_AFTER_REPORT = $previousExitAfterReport
    $env:OMNI_LOG_LEVEL = $previousLogLevel
  }
  $systemMetricsSampler = $null
  try {
    $systemMetricsSampler = Start-WatchModeSystemMetricsSampler `
      -ProcessId ([int]$process.Id) `
      -OutputDirectory $OutputDirectory
    Start-Sleep -Seconds $WarmupSeconds
  } catch {
    if ($elevatedLaunch) {
      Stop-ElevatedWatchModeDesktopLaunch $elevatedLaunch | Out-Null
    } else {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    Stop-WatchModeSystemMetricsSampler
    throw
  }
  return [pscustomobject]@{
    pid = $process.Id
    stdout = $stdout
    stderr = $stderr
    buildLog = $buildLog
    cargoBuildLog = $cargoLog
    buildErrorLog = $buildErrLog
    cargoBuildErrorLog = $cargoErrLog
    frontendServer = $frontendServer
    watchSessionReportPath = $watchSessionReportPath
    watchReportAutoStopAfterMs = $watchReportAutoStopAfterMs
    launchedAtUtc = $desktopLaunchedAtUtc
    systemMetricsSampler = $systemMetricsSampler
    guardianPid = if ($elevatedLaunch) { $elevatedLaunch.guardianPid } else { $null }
    guardianLeasePath = if ($elevatedLaunch) { $elevatedLaunch.guardianLeasePath } else { $null }
    guardianEnvironmentPath = if ($elevatedLaunch) { $elevatedLaunch.guardianEnvironmentPath } else { $null }
    guardianReceiptPath = if ($elevatedLaunch) { $elevatedLaunch.guardianReceiptPath } else { $null }
  }
}

function Stop-WatchModeDesktopShell {
  param($DesktopProcessStep)
  if ($DesktopProcessStep -and $DesktopProcessStep.ok -and $DesktopProcessStep.result) {
    Stop-DesktopFrontendServer $DesktopProcessStep.result.frontendServer
  }
  if ($DesktopProcessStep -and $DesktopProcessStep.ok -and $DesktopProcessStep.result -and $DesktopProcessStep.result.external) {
    return Invoke-StopWatchRouteViaTauriCli
  }
  if ($AllowElevatedDesktopLaunch) {
    $trackedLaunch = if ($DesktopProcessStep -and $DesktopProcessStep.ok -and $DesktopProcessStep.result -and $DesktopProcessStep.result.guardianLeasePath) {
      $DesktopProcessStep.result
    } elseif ($script:elevatedDesktopLaunch) {
      $script:elevatedDesktopLaunch
    } else {
      $null
    }
    if ($trackedLaunch) {
      return Stop-ElevatedWatchModeDesktopLaunch $trackedLaunch
    }
    return [pscustomobject]@{
      stopped = $false
      reason = 'elevated desktop launch never produced a tracked guardian receipt'
    }
  }
  if ($DesktopProcessStep -and $DesktopProcessStep.ok -and $DesktopProcessStep.result -and $DesktopProcessStep.result.pid) {
    Stop-Process -Id $DesktopProcessStep.result.pid -ErrorAction SilentlyContinue
    Start-Process -FilePath "taskkill.exe" -ArgumentList @("/PID", "$($DesktopProcessStep.result.pid)", "/F", "/T") -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue | Out-Null
    Start-Sleep -Milliseconds 500
  }
  Get-Process -Name "omni-desktop-shell" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-Process -Name "omni-desktop-shell" -ErrorAction SilentlyContinue | ForEach-Object {
    Start-Process -FilePath "taskkill.exe" -ArgumentList @("/PID", "$($_.Id)", "/F", "/T") -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue | Out-Null
  }
}

function Invoke-ProcessWithTimeout {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [int]$TimeoutSeconds = 5
  )
  function Read-TrimmedTextFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
      return ""
    }
    $content = Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue
    if ($null -eq $content) {
      return ""
    }
    return ([string]$content).Trim()
  }
  $stdout = [System.IO.Path]::GetTempFileName()
  $stderr = [System.IO.Path]::GetTempFileName()
  $process = $null
  try {
    $process = Start-Process -FilePath $FilePath `
      -ArgumentList $ArgumentList `
      -RedirectStandardOutput $stdout `
      -RedirectStandardError $stderr `
      -WindowStyle Hidden `
      -PassThru
    $exited = $process.WaitForExit($TimeoutSeconds * 1000)
    if (-not $exited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    return [pscustomobject]@{
      exitCode = if ($exited) { $process.ExitCode } else { $null }
      timedOut = -not $exited
      stdout = Read-TrimmedTextFile $stdout
      stderr = Read-TrimmedTextFile $stderr
    }
  } finally {
    Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-StopWatchRouteViaTauriCli {
  $candidates = @(
    (Join-Path $workspaceRoot "target/debug/omni-desktop-shell.exe"),
    (Join-Path $workspaceRoot "target/release/omni-desktop-shell.exe")
  )
  $exe = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $exe) {
    return [pscustomobject]@{
      ok = $false
      error = "omni-desktop-shell.exe was not found"
    }
  }
  try {
    $ping = Invoke-ProcessWithTimeout -FilePath $exe -ArgumentList @("tauri", "invoke", "debug_ipc_ping") -TimeoutSeconds 5
    $stop = Invoke-ProcessWithTimeout -FilePath $exe -ArgumentList @("tauri", "invoke", "stop_audio_route", "--args", '{"direction":"inbound"}') -TimeoutSeconds 5
    return [pscustomobject]@{
      ok = ($ping.exitCode -eq 0 -and $stop.exitCode -eq 0 -and -not $ping.timedOut -and -not $stop.timedOut)
      exe = $exe
      pingExitCode = $ping.exitCode
      stopExitCode = $stop.exitCode
      pingTimedOut = $ping.timedOut
      stopTimedOut = $stop.timedOut
      pingOutput = $ping.stdout
      pingError = $ping.stderr
      stopOutput = $stop.stdout
      stopError = $stop.stderr
    }
  } catch {
    return [pscustomobject]@{
      ok = $false
      exe = $exe
      error = $_.Exception.Message
    }
  }
}

function Invoke-StartWatchModeViaTauriCli {
  param($DesktopProcessStep, [string]$PhysicalDeviceId)
  if (-not ($DesktopProcessStep -and $DesktopProcessStep.ok -and $DesktopProcessStep.result -and $DesktopProcessStep.result.pid)) {
    throw "desktop shell is not running; cannot start watch mode via Tauri CLI"
  }
  $exe = Resolve-OmniBuiltExecutable -BuildProfile "debug" -ExecutableName "omni-desktop-shell.exe"
  $ping = Invoke-ProcessWithTimeout -FilePath $exe -ArgumentList @("tauri", "invoke", "debug_ipc_ping") -TimeoutSeconds 10
  if ($ping.exitCode -ne 0 -or $ping.timedOut) {
    throw "desktop shell IPC ping failed. ExitCode=$($ping.exitCode) TimedOut=$($ping.timedOut) Stdout=$($ping.stdout) Stderr=$($ping.stderr)"
  }
  $loaded = Invoke-ProcessWithTimeout -FilePath $exe -ArgumentList @("tauri", "invoke", "load_config_draft") -TimeoutSeconds 10
  if ($loaded.exitCode -ne 0 -or $loaded.timedOut -or -not $loaded.stdout) {
    throw "load_config_draft failed. ExitCode=$($loaded.exitCode) TimedOut=$($loaded.timedOut) Stdout=$($loaded.stdout) Stderr=$($loaded.stderr)"
  }
  try {
    $config = $loaded.stdout | ConvertFrom-Json
  } catch {
    throw "load_config_draft returned invalid JSON: $($loaded.stdout)"
  }
  if (-not $config.devices) {
    $config | Add-Member -NotePropertyName devices -NotePropertyValue ([pscustomobject]@{})
  }
  $config.devices.routeMode = "watch"
  if (-not $config.speech) {
    $config | Add-Member -NotePropertyName speech -NotePropertyValue ([pscustomobject]@{})
  }
  $config.speech.translationAudioSource = "subtitle-tts"
  Set-WatchModelOnConfig $config $WatchModelId $WatchRealtimeProtocol $paidAuthorityEnabled
  Set-WatchModeSecondaryConfig $config $SubtitleTranslationModelId $InboundSecondaryAudioModelId $FeedbackLoopPrevention $SubtitleTranslationMode
  if ($PhysicalDeviceId) {
    $config.devices.outputDeviceId = $PhysicalDeviceId
    $config.devices.outputLevel = 50
  }
  $configJson = $config | ConvertTo-Json -Depth 100 -Compress
  $argsJson = (@{ config = $config } | ConvertTo-Json -Depth 100 -Compress)
  $preconnect = Invoke-ProcessWithTimeout -FilePath $exe -ArgumentList @("tauri", "invoke", "preconnect_omni_realtime", "--args", $argsJson) -TimeoutSeconds 20
  if ($preconnect.exitCode -ne 0 -or $preconnect.timedOut) {
    throw "preconnect_omni_realtime failed. ExitCode=$($preconnect.exitCode) TimedOut=$($preconnect.timedOut) ModelId=$WatchModelId PhysicalDeviceId=$PhysicalDeviceId Stdout=$($preconnect.stdout) Stderr=$($preconnect.stderr)"
  }
  $bridge = Invoke-ProcessWithTimeout -FilePath $exe -ArgumentList @("tauri", "invoke", "start_bridge_service", "--args", $argsJson) -TimeoutSeconds 20
  if ($bridge.exitCode -ne 0 -or $bridge.timedOut) {
    throw "start_bridge_service failed. ExitCode=$($bridge.exitCode) TimedOut=$($bridge.timedOut) Stdout=$($bridge.stdout) Stderr=$($bridge.stderr)"
  }
  $routeArgsJson = (@{ direction = "inbound"; config = $config } | ConvertTo-Json -Depth 100 -Compress)
  $route = Invoke-ProcessWithTimeout -FilePath $exe -ArgumentList @("tauri", "invoke", "start_audio_route", "--args", $routeArgsJson) -TimeoutSeconds 30
  if ($route.exitCode -ne 0 -or $route.timedOut) {
    throw "start_audio_route failed. ExitCode=$($route.exitCode) TimedOut=$($route.timedOut) Stdout=$($route.stdout) Stderr=$($route.stderr)"
  }
  return [pscustomobject]@{
    ping = $ping
    preconnect = $preconnect
    bridge = $bridge
    route = $route
    outputDeviceId = $PhysicalDeviceId
  }
}

function Stop-StaleWatchModeDesktopShell {
  if ($AllowElevatedDesktopLaunch) {
    return [pscustomobject]@{
      routeStop = $null
      elevatedCleanup = Stop-ElevatedWatchModeProcesses
    }
  }
  # There is no cross-process Tauri CLI transport: launching the executable
  # with `tauri invoke` starts a second shell and waits on an IPC channel it can
  # never share with the stale process. Kill only the explicitly discovered
  # desktop process trees; the live session itself uses same-process auto-stop.
  $staleProcesses = @(Get-Process -Name "omni-desktop-shell" -ErrorAction SilentlyContinue)
  $staleProcesses | ForEach-Object {
    Start-Process -FilePath "taskkill.exe" -ArgumentList @("/PID", "$($_.Id)", "/F", "/T") -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue | Out-Null
  }
  Start-Sleep -Milliseconds 500
  $remaining = @(Get-Process -Name "omni-desktop-shell" -ErrorAction SilentlyContinue)
  if ($remaining.Count -gt 0) {
    $ids = ($remaining | ForEach-Object { "$($_.Id)" }) -join ","
    throw "stale omni-desktop-shell could not be stopped; pid=$ids"
  }
  return [pscustomobject]@{
    stoppedProcessCount = $staleProcesses.Count
  }
}

function Get-LogTextAfterMarker {
  param([string]$Path, [string]$RunMarker)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return ""
  }
  $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
  if (-not $text) {
    return ""
  }
  $text = [string]$text
  if ($RunMarker) {
    $markerIndex = $text.IndexOf($RunMarker)
    if ($markerIndex -ge 0) {
      return $text.Substring($markerIndex)
    }
  }
  return $text
}

function Get-DiagnosticLogLines {
  param(
    [string]$Text,
    [string[]]$Patterns,
    [int]$Limit = 8
  )
  if (-not $Text) {
    return @()
  }
  $matchedLines = @()
  foreach ($line in ($Text -split "`r?`n")) {
    if (-not $line.Trim()) {
      continue
    }
    foreach ($pattern in $Patterns) {
      if ($line -match $pattern) {
        $matchedLines += $line
        break
      }
    }
  }
  if ($matchedLines.Count -le $Limit) {
    return $matchedLines
  }
  return $matchedLines[($matchedLines.Count - $Limit)..($matchedLines.Count - 1)]
}

function Format-DiagnosticLogLines {
  param([object[]]$Lines)
  if (-not $Lines -or $Lines.Count -eq 0) {
    return "-"
  }
  return (($Lines | ForEach-Object { [string]$_ }) -join " || ")
}

function Wait-AppLogPattern {
  param(
    [string]$Path,
    [string]$RunMarker,
    [string]$Pattern,
    [int]$TimeoutSeconds = 45
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $text = Get-LogTextAfterMarker $Path $RunMarker
    $infrastructureFailureLines = Get-DiagnosticLogLines $text @(
      "watch_mode\.diagnostic_autostart_infrastructure_failed"
    ) 1
    if ($infrastructureFailureLines.Count -gt 0) {
      throw "watch-mode infrastructure failure while waiting for app readiness: $(Format-DiagnosticLogLines $infrastructureFailureLines)"
    }
    if ($text -match $Pattern) {
      return [pscustomobject]@{
        matched = $true
        pattern = $Pattern
        path = $Path
      }
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  $fullText = ""
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    $fullText = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
  }
  $markerFound = $false
  if ($RunMarker -and $fullText) {
    $markerFound = $fullText.IndexOf($RunMarker) -ge 0
  }
  $scopedText = Get-LogTextAfterMarker $Path $RunMarker
  $readinessLines = Get-DiagnosticLogLines $scopedText @(
    "watch_mode\.diagnostic_autostart",
    "watch_mode\.omni_preconnect",
    "watch_mode\.omni_session",
    "watch_mode\.route",
    "ws\.recv\.session",
    "start_audio_route",
    "preconnect_omni_realtime"
  ) 12
  $providerLines = Get-DiagnosticLogLines $scopedText @(
    "provider",
    "dashscope",
    "openai",
    "model_trace",
    "401|403|429|quota|rate limit|timeout|timed out|websocket|authentication|authorization"
  ) 12
  $tailLines = Get-DiagnosticLogLines $scopedText @(".+") 16
  throw "timed out waiting for app log pattern. Pattern=$Pattern TimeoutSeconds=$TimeoutSeconds Path=$Path MarkerFound=$markerFound RunMarker=$RunMarker ReadinessLines=$(Format-DiagnosticLogLines $readinessLines) ProviderLines=$(Format-DiagnosticLogLines $providerLines) Tail=$(Format-DiagnosticLogLines $tailLines)"
}

function Get-WatchModeRunSessionId {
  param(
    [string]$Text,
    [string]$RunMarker
  )
  if (-not $Text -or -not $RunMarker) {
    return $null
  }
  $sessionId = $null
  foreach ($line in ($Text -split "`r?`n")) {
    if (
      $line -match 'watch_mode\.diagnostic_autostart_requested' -and
      $line.Contains($RunMarker) -and
      $line -match '\bsid=([A-Za-z0-9_-]+)(?:\s|$)'
    ) {
      $sessionId = $Matches[1]
    }
  }
  return $sessionId
}

function Get-OptionalDiagnosticFileTail {
  param(
    [string]$Path,
    [int]$Limit = 8
  )
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return @()
  }
  $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
  return @(Get-DiagnosticLogLines $text @('.+') $Limit)
}

function Wait-WatchModeAppReadiness {
  param(
    [string]$Path,
    [string]$RunMarker,
    [int]$ProcessId,
    [DateTime]$DeadlineUtc,
    [string]$DesktopStdoutPath = '',
    [string]$DesktopStderrPath = ''
  )
  $startedAtUtc = [DateTime]::UtcNow
  $sessionId = $null
  $providerReady = $false
  $frontendIpcReady = $false
  do {
    $text = Get-LogTextAfterMarker $Path $RunMarker
    $infrastructureFailureLines = @(
      (Get-DiagnosticLogLines $text @('watch_mode\.diagnostic_autostart_infrastructure_failed') 8) |
        Where-Object { ([string]$_).Contains($RunMarker) } |
        Select-Object -Last 1
    )
    if ($infrastructureFailureLines.Count -gt 0) {
      throw (
        "infrastructure/frontend not ready before playback: native startup watchdog reported frontend-ipc-not-ready. " +
        "Pid=$ProcessId Path=$Path Evidence=$(Format-DiagnosticLogLines $infrastructureFailureLines) " +
        "DesktopStdout=$DesktopStdoutPath DesktopStderr=$DesktopStderrPath"
      )
    }
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
      $sessionIdLabel = if ($sessionId) { $sessionId } else { '-' }
      throw (
        "infrastructure/frontend not ready before playback: desktop process exited before the same-process frontend IPC handshake completed. " +
        "Pid=$ProcessId SessionId=$sessionIdLabel Path=$Path " +
        "DesktopStdout=$DesktopStdoutPath DesktopStderr=$DesktopStderrPath"
      )
    }
    $nextSessionId = Get-WatchModeRunSessionId $text $RunMarker
    if ($nextSessionId) {
      $sessionId = $nextSessionId
      $escapedSessionId = [regex]::Escape($sessionId)
      $escapedRunMarker = [regex]::Escape($RunMarker)
      $providerReady = $text -match "(?m)^.*(?:watch_mode\.omni_session_ready|ws\.recv\.session\.(?:created|updated)).*\bsid=$escapedSessionId(?:\s|$)"
      $frontendIpcReady = $text -match "(?m)^.*(?:startup\.step check-ipc=done|watch_mode\.diagnostic_autostart_ipc_ready.*$escapedRunMarker).*\bsid=$escapedSessionId(?:\s|$)"
      $frontendIpcFailed = $text -match "(?m)^.*(?:startup\.step check-ipc=error|startup\.bootstrap_failed).*\bsid=$escapedSessionId(?:\s|$)"
      if ($frontendIpcFailed) {
        $frontendFailureLines = Get-DiagnosticLogLines $text @(
          'startup\.step check-ipc=error',
          'startup\.bootstrap_failed',
          'startup\.bootstrap_settled_forced_overlay_close'
        ) 8
        throw (
          "infrastructure/frontend not ready before playback: same-process frontend IPC bootstrap failed. " +
          "Pid=$ProcessId SessionId=$sessionId FrontendFailureLines=$(Format-DiagnosticLogLines $frontendFailureLines) " +
          "DesktopStdout=$DesktopStdoutPath DesktopStderr=$DesktopStderrPath"
        )
      }
      if ($providerReady -and $frontendIpcReady) {
        return [pscustomobject]@{
          matched = $true
          path = $Path
          pid = $ProcessId
          sessionId = $sessionId
          providerReady = $true
          frontendIpcReady = $true
          elapsedMs = [Math]::Max(0, [int](([DateTime]::UtcNow - $startedAtUtc).TotalMilliseconds))
        }
      }
    }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $DeadlineUtc.ToUniversalTime())

  $scopedText = Get-LogTextAfterMarker $Path $RunMarker
  $readinessLines = Get-DiagnosticLogLines $scopedText @(
    'watch_mode\.diagnostic_autostart_requested',
    'watch_mode\.omni_session_ready',
    'ws\.recv\.session\.(?:created|updated)',
    'startup\.step check-ipc',
    'startup\.bootstrap',
    'watch_mode\.diagnostic_autostart_ipc_ready',
    'watch_mode\.diagnostic_autostart_infrastructure_failed',
    'watch_mode\.diagnostic_autostart'
  ) 16
  $stdoutLines = Get-OptionalDiagnosticFileTail $DesktopStdoutPath 8
  $stderrLines = Get-OptionalDiagnosticFileTail $DesktopStderrPath 8
  $elapsedMs = [Math]::Max(0, [int](([DateTime]::UtcNow - $startedAtUtc).TotalMilliseconds))
  $sessionIdLabel = if ($sessionId) { $sessionId } else { '-' }
  throw (
    "infrastructure/frontend not ready before playback: timed out waiting for provider readiness and same-process frontend IPC evidence " +
    "('startup.step check-ipc=done' or 'watch_mode.diagnostic_autostart_ipc_ready'). Pid=$ProcessId SessionId=$sessionIdLabel " +
    "ProviderReady=$providerReady FrontendIpcReady=$frontendIpcReady ElapsedMs=$elapsedMs Path=$Path RunMarker=$RunMarker " +
    "ReadinessLines=$(Format-DiagnosticLogLines $readinessLines) " +
    "DesktopStdoutPath=$DesktopStdoutPath DesktopStdoutTail=$(Format-DiagnosticLogLines $stdoutLines) " +
    "DesktopStderrPath=$DesktopStderrPath DesktopStderrTail=$(Format-DiagnosticLogLines $stderrLines)"
  )
}

function Start-TestMediaPlayback {
  param([string]$PathToMedia, [string]$PlaybackEndpointId, [string]$OutputDirectory)
  if (-not (Test-Path -LiteralPath $PathToMedia -PathType Leaf)) {
    throw "Test media file not found: $PathToMedia"
  }
  $injectorExe = Resolve-OmniBuiltExecutable -BuildProfile "release" -ExecutableName "omni-watch-media-injector.exe"
  if (Test-Path -LiteralPath $injectorExe -PathType Leaf) {
    $resolvedMediaPath = (Resolve-Path -LiteralPath $PathToMedia).Path
    $mediaSha256 = (Get-FileHash -LiteralPath $resolvedMediaPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $args = @("--media", $resolvedMediaPath)
    $referencePcmPath = $null
    if ($OutputDirectory) {
      $referencePcmPath = Join-Path $OutputDirectory "source-media-reference-16k-mono.pcm"
      $args += @("--reference-pcm16k-mono-path", $referencePcmPath)
    }
    if ($PlaybackEndpointId) {
      $args += @("--endpoint-id", $PlaybackEndpointId)
    }
    if ($PlaybackSeconds -gt 0) {
      $args += @("--max-seconds", "$PlaybackSeconds")
    }
    $playbackStartedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $output = & $injectorExe @args
    $playbackFinishedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0 -or -not $output) {
      throw "watch media injector failed. ExitCode=$exitCode Output=$output"
    }
    $result = ($output -join [Environment]::NewLine) | ConvertFrom-Json
    if (-not $result.passed) {
      throw "watch media injector failed: $($result.detail)"
    }
    return [pscustomobject]@{
      playbackMode = "wasapi-media-injector"
      endpointId = $result.endpointId
      mediaPath = $result.mediaPath
      mediaSha256 = $mediaSha256
      injectorProcessId = $result.processId
      startedAtMs = if ($result.startedAtMs) { $result.startedAtMs } else { $playbackStartedAtMs }
      finishedAtMs = if ($result.finishedAtMs) { $result.finishedAtMs } else { $playbackFinishedAtMs }
      renderedFrames = $result.renderedFrames
      renderedSeconds = $result.renderedSeconds
      referencePcmPath = $referencePcmPath
    }
  }

  throw "watch media injector was not built: $injectorExe. Run npm run build:bridge-service-native first."
}

function Start-TestMediaPlaybackViaDefaultEndpoint {
  param([string]$PathToMedia, [string]$PlaybackEndpointId)
  if (-not (Test-Path -LiteralPath $PathToMedia -PathType Leaf)) {
    throw "Test media file not found: $PathToMedia"
  }
  $previousEndpointId = $null
  $defaultEndpointSwitched = $false
  if ($PlaybackEndpointId) {
    $previousEndpointId = Get-DefaultRenderEndpointId
    Set-DefaultRenderEndpoint $PlaybackEndpointId
    $defaultEndpointSwitched = $true
    Start-Sleep -Milliseconds 500
  }
  if (-not ([type]::GetType("OmniTranslate.WinmmMci", $false))) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace OmniTranslate {
  public static class WinmmMci {
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    private static extern int mciSendString(string command, StringBuilder returnValue, int returnLength, IntPtr hwndCallback);

    public static string Send(string command, int returnLength) {
      var buffer = new StringBuilder(returnLength);
      int result = mciSendString(command, buffer, returnLength, IntPtr.Zero);
      if (result != 0) {
        throw new InvalidOperationException("mciSendString failed result=" + result + " command=" + command);
      }
      return buffer.ToString();
    }
  }
}
"@
  }
  $alias = "omni_watch_test_$PID"
  $resolvedMediaPath = (Resolve-Path -LiteralPath $PathToMedia).Path
  $mediaSha256 = (Get-FileHash -LiteralPath $resolvedMediaPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $playbackStartedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $durationSeconds = $null
  $volumeWarning = $null
  try {
    [void][OmniTranslate.WinmmMci]::Send("open `"$resolvedMediaPath`" alias $alias", 0)
    $lengthMsText = [OmniTranslate.WinmmMci]::Send("status $alias length", 64)
    $lengthMs = 0
    if ([int]::TryParse($lengthMsText.Trim(), [ref]$lengthMs) -and $lengthMs -gt 0) {
      $durationSeconds = [Math]::Round($lengthMs / 1000.0, 3)
    }
    try {
      [void][OmniTranslate.WinmmMci]::Send("setaudio $alias volume to 600", 0)
    } catch {
      # Some WinMM waveaudio devices reject setaudio even though play works.
      # Preserve this diagnostic but do not suppress the real media playback.
      $volumeWarning = $_.Exception.Message
    }
    [void][OmniTranslate.WinmmMci]::Send("play $alias from 0", 0)
    $sleepSeconds = if ($PlaybackSeconds -gt 0) {
      $PlaybackSeconds
    } elseif ($durationSeconds -and $durationSeconds -gt 0) {
      [Math]::Ceiling($durationSeconds)
    } else {
      0
    }
    if ($sleepSeconds -gt 0) {
      Start-Sleep -Seconds $sleepSeconds
    }
    [void][OmniTranslate.WinmmMci]::Send("stop $alias", 0)
  } finally {
    try {
      [void][OmniTranslate.WinmmMci]::Send("close $alias", 0)
    } catch {
    }
    if ($defaultEndpointSwitched -and $previousEndpointId) {
      Set-DefaultRenderEndpoint $previousEndpointId
    }
  }
  return [pscustomobject]@{
    playbackMode = "mci-default-endpoint"
    endpointId = $PlaybackEndpointId
    mediaPath = $resolvedMediaPath
    mediaSha256 = $mediaSha256
    injectorProcessId = $PID
    startedAtMs = $playbackStartedAtMs
    finishedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    playedSeconds = if ($PlaybackSeconds -gt 0) { $PlaybackSeconds } else { $durationSeconds }
    naturalDurationSeconds = $durationSeconds
    volumeWarning = $volumeWarning
    defaultEndpointSwitched = $defaultEndpointSwitched
  }
}

function Write-NamedPipeJsonLine {
  param(
    [string]$PipeName,
    [object]$Payload,
    [int]$TimeoutMs = 5000
  )
  $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, [System.IO.Pipes.PipeDirection]::InOut)
  $client.Connect($TimeoutMs)
  try {
    $writer = [System.IO.StreamWriter]::new($client)
    $writer.AutoFlush = $true
    $reader = [System.IO.StreamReader]::new($client)
    $writer.WriteLine(($Payload | ConvertTo-Json -Depth 12 -Compress))
    $line = $reader.ReadLine()
    if (-not $line) {
      throw "named pipe $PipeName returned no response"
    }
    return $line | ConvertFrom-Json
  } finally {
    $client.Dispose()
  }
}

function Read-BridgeSourceFrame {
  param(
    [string]$PipeName,
    [int]$TimeoutMs = 8000
  )
  $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, [System.IO.Pipes.PipeDirection]::In)
  $client.Connect($TimeoutMs)
  try {
    $reader = [System.IO.BinaryReader]::new($client)
    $started = [DateTimeOffset]::UtcNow
    while (([DateTimeOffset]::UtcNow - $started).TotalMilliseconds -lt $TimeoutMs) {
      $headerLength = $reader.ReadUInt32()
      $headerBytes = $reader.ReadBytes($headerLength)
      $header = [System.Text.Encoding]::UTF8.GetString($headerBytes) | ConvertFrom-Json
      $payloadBytes = 0
      if ($header.payloadBytes -gt 0) {
        $payload = $reader.ReadBytes($header.payloadBytes)
        $payloadBytes = $payload.Length
      }
      if ($header.type -eq 'bridge.source.frame' -and $payloadBytes -gt 0) {
        return [pscustomobject]@{
          eventType = $header.type
          frameId = $header.frameId
          frameCount = $header.frameCount
          payloadBytes = $payloadBytes
          sampleRateHz = $header.sampleRateHz
          channelCount = $header.channelCount
        }
      }
    }
    throw "timed out waiting for a bridge.source.frame"
  } finally {
    $client.Dispose()
  }
}

function New-BridgeSourceProbeInitPayload {
  param(
    [string]$FeedbackMode,
    [string]$SessionId
  )
  $sourceCaptureMode = if ($FeedbackMode -eq "process-exclusion") { "process-exclusion" } else { "virtual-driver" }
  return [ordered]@{
    type = 'bridge.init'
    requestId = "watch-mode-probe-init-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    protocolVersion = '2026-08-13-audio-routing-v7'
    sessionId = $SessionId
    installChannel = 'development'
    targetDeviceId = 'virtual-mic-default'
    virtualRenderDeviceId = 'virtual-speaker-default'
    physicalPlaybackDeviceId = 'default'
    physicalPlaybackLevel = 50
    monitorPlaybackEnabled = $false
    translationPlaybackEnabled = $true
    sourceCaptureMode = $sourceCaptureMode
    expectedDriverVersion = '0.10.0-dev'
    expectedBridgeVersion = '0.1.0'
    mixControl = [ordered]@{
      keepOriginalAudio = $true
      translatedAudioEnabled = $true
      translatedAudioGainDb = 0
      originalAudioGainDb = 0
      duckingEnabled = $false
      duckingDepthPercent = 0
      monitorMode = 'translated-only'
    }
  }
}

function Invoke-BridgeSourceProbe {
  param(
    [string]$OutputDirectory,
    [string]$FeedbackMode = "virtual-driver"
  )
  $bridgeExe = Resolve-OmniBuiltExecutable -BuildProfile "release" -ExecutableName "omni-bridge-service.exe"
  if (-not (Test-Path -LiteralPath $bridgeExe -PathType Leaf)) {
    throw "Bridge executable not found: $bridgeExe"
  }
  $probeRuntimeRoot = Join-Path $OutputDirectory "bridge-source-probe-runtime"
  New-Item -ItemType Directory -Force -Path $probeRuntimeRoot | Out-Null
  $installStateJson = [ordered]@{
    protocolVersion = '2026-08-13-audio-routing-v7'
    installChannel = 'development'
    driverVersion = '0.10.0-dev'
    bridgeVersion = '0.1.0'
    driverHealth = 'running'
    installedAt = (Get-Date -Format s)
    targetDeviceId = 'virtual-mic-default'
    virtualRenderDeviceId = 'virtual-speaker-default'
    driverBackend = 'sysvad-wave-rt'
  } | ConvertTo-Json -Depth 6
  Set-Utf8NoBomContent (Join-Path $probeRuntimeRoot "driver-install-state.json") $installStateJson
  $pipeName = "omni-watch-mode-probe-$PID"
  $stdout = Join-Path $OutputDirectory "bridge-source-probe.stdout.log"
  $stderr = Join-Path $OutputDirectory "bridge-source-probe.stderr.log"
  $diagnosticsPath = Join-Path $OutputDirectory "bridge-source-probe-diagnostics.json"
  $process = Start-Process -FilePath $bridgeExe -ArgumentList @(
    "--pipe-name", $pipeName,
    "--runtime-root", $probeRuntimeRoot,
    "--bridge-version", "0.1.0"
  ) -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
  $init = $null
  $state = $null
  $frame = $null
  $audioProbeProcess = $null
  $phase = "init"
  try {
    Start-Sleep -Milliseconds 600
    $phase = "init"
    $sessionId = "watch-mode-probe-session-$PID"
    $initPayload = New-BridgeSourceProbeInitPayload $FeedbackMode $sessionId
    $init = Write-NamedPipeJsonLine $pipeName $initPayload
    if (Test-UsesVirtualDriverBackend $FeedbackMode) {
      $phase = "source_frame"
      $audioProbeExe = Resolve-OmniBuiltExecutable -BuildProfile "release" -ExecutableName "omni-driver-audio-probe.exe"
      if (-not (Test-Path -LiteralPath $audioProbeExe -PathType Leaf)) {
        throw "Driver audio probe executable not found: $audioProbeExe"
      }
      $audioProbeStdout = Join-Path $probeRuntimeRoot "audio-probe.stdout.log"
      $audioProbeStderr = Join-Path $probeRuntimeRoot "audio-probe.stderr.log"
      $audioProbeProcess = Start-Process -FilePath $audioProbeExe `
        -ArgumentList @("--inject-only") `
        -RedirectStandardOutput $audioProbeStdout `
        -RedirectStandardError $audioProbeStderr `
        -WindowStyle Hidden -PassThru
      Start-Sleep -Milliseconds 250
      $frame = Read-BridgeSourceFrame "$pipeName-source"
      if (-not $audioProbeProcess.WaitForExit(15000)) {
        throw "driver audio probe did not exit after source frame injection"
      }
      $audioProbeProcess.Refresh()
      $probeOutput = if (Test-Path -LiteralPath $audioProbeStdout) {
        Get-Content -LiteralPath $audioProbeStdout -Raw -ErrorAction SilentlyContinue
      } else { "" }
      $probeResult = $null
      try {
        if ($probeOutput.Trim()) {
          $probeResult = $probeOutput | ConvertFrom-Json
        }
      } catch {
        throw "driver audio probe produced invalid JSON: $($_.Exception.Message)"
      }
      if ($null -eq $probeResult -or $probeResult.passed -ne $true) {
        $probeError = if (Test-Path -LiteralPath $audioProbeStderr) {
          Get-Content -LiteralPath $audioProbeStderr -Raw -ErrorAction SilentlyContinue
        } else { "" }
        throw "driver audio probe did not report passed=true: $probeError $probeOutput"
      }
      if ($null -ne $audioProbeProcess.ExitCode -and $audioProbeProcess.ExitCode -ne 0) {
        throw "driver audio probe reported exit code $($audioProbeProcess.ExitCode) after passed=true"
      }
      $resetStdout = Join-Path $probeRuntimeRoot "audio-probe-reset.stdout.log"
      $resetStderr = Join-Path $probeRuntimeRoot "audio-probe-reset.stderr.log"
      $resetProcess = Start-Process -FilePath $audioProbeExe `
        -ArgumentList @("--reset-only") `
        -RedirectStandardOutput $resetStdout `
        -RedirectStandardError $resetStderr `
        -WindowStyle Hidden -Wait -PassThru
      $resetOutput = if (Test-Path -LiteralPath $resetStdout) {
        Get-Content -LiteralPath $resetStdout -Raw -ErrorAction SilentlyContinue
      } else { "" }
      $resetResult = $null
      try {
        if ($resetOutput.Trim()) {
          $resetResult = $resetOutput | ConvertFrom-Json
        }
      } catch {
        throw "driver reset produced invalid JSON: $($_.Exception.Message)"
      }
      if ($resetProcess.ExitCode -ne 0 -or $null -eq $resetResult -or $resetResult.passed -ne $true) {
        $resetError = if (Test-Path -LiteralPath $resetStderr) {
          Get-Content -LiteralPath $resetStderr -Raw -ErrorAction SilentlyContinue
        } else { "" }
        throw "driver reset after source frame probe did not report passed=true: $resetError $resetOutput"
      }
    }
    $phase = "state_query"
    $state = Write-NamedPipeJsonLine $pipeName ([ordered]@{
      type = 'bridge.state.query'
      requestId = "watch-mode-probe-state-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    })
    $phase = "shutdown"
    [void](Write-NamedPipeJsonLine $pipeName ([ordered]@{
      type = 'bridge.shutdown'
      requestId = "watch-mode-probe-shutdown-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
      sessionId = "watch-mode-probe-session-$PID"
      reason = 'watch-mode-probe-complete'
    }))
    return [pscustomobject]@{
      passed = $true
      init = $init
      state = $state
      sourceFrame = $frame
      pipeName = $pipeName
      sourcePipeName = "$pipeName-source"
      stdout = $stdout
      stderr = $stderr
    }
  } catch {
    $errorMessage = $_.Exception.Message
    $stateQueryError = $null
    if ($init -and -not $state) {
      try {
        $state = Write-NamedPipeJsonLine $pipeName ([ordered]@{
          type = 'bridge.state.query'
          requestId = "watch-mode-probe-state-after-failure-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
        })
      } catch {
        $stateQueryError = $_.Exception.Message
      }
    }
    if ($init) {
      try {
        [void](Write-NamedPipeJsonLine $pipeName ([ordered]@{
          type = 'bridge.shutdown'
          requestId = "watch-mode-probe-shutdown-after-failure-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
          sessionId = "watch-mode-probe-session-$PID"
          reason = 'watch-mode-probe-failed'
        }))
      } catch {
        if (-not $stateQueryError) {
          $stateQueryError = "shutdown failed: $($_.Exception.Message)"
        }
      }
    }
    [pscustomobject]@{
      passed = $false
      phase = $phase
      error = $errorMessage
      init = $init
      state = $state
      stateQueryError = $stateQueryError
      pipeName = $pipeName
      sourcePipeName = "$pipeName-source"
      stdout = $stdout
      stderr = $stderr
    } | ConvertTo-Json -Depth 12 | Set-Content -Path $diagnosticsPath -Encoding UTF8
    throw "bridge source probe failed during ${phase}: $errorMessage Diagnostics=$diagnosticsPath"
  } finally {
    if ($audioProbeProcess -and -not $audioProbeProcess.HasExited) {
      Stop-Process -Id $audioProbeProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if (-not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
  }
}

function Invoke-VirtualDriverMediaSourcePreflight {
  param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)][string]$VirtualRenderEndpointId,
    [Parameter(Mandatory = $true)][string]$PathToMedia
  )
  # The development-driver health probe injects directly through the IOCTL
  # surface. That proves the ring and source pipe, but it does not prove that
  # the exact WASAPI media injector used by a paid Watch cell reached the
  # virtual render endpoint. Keep this zero-LLM probe separate and require a
  # freshly observed source frame before the Desktop can preconnect a model.
  if ([string]::IsNullOrWhiteSpace($VirtualRenderEndpointId)) {
    throw "virtual-driver media source preflight requires the driver probe WasapiEndpointId"
  }
  if (-not (Test-Path -LiteralPath $PathToMedia -PathType Leaf)) {
    throw "virtual-driver media source preflight media file was not found: $PathToMedia"
  }
  $bridgeExe = Resolve-OmniBuiltExecutable -BuildProfile "release" -ExecutableName "omni-bridge-service.exe"
  $injectorExe = Resolve-OmniBuiltExecutable -BuildProfile "release" -ExecutableName "omni-watch-media-injector.exe"
  $audioProbeExe = Resolve-OmniBuiltExecutable -BuildProfile "release" -ExecutableName "omni-driver-audio-probe.exe"
  foreach ($requiredExe in @($bridgeExe, $injectorExe, $audioProbeExe)) {
    if (-not (Test-Path -LiteralPath $requiredExe -PathType Leaf)) {
      throw "virtual-driver media source preflight executable was not built: $requiredExe"
    }
  }

  $preflightRoot = Join-Path $OutputDirectory "virtual-driver-media-source-preflight-runtime"
  New-Item -ItemType Directory -Force -Path $preflightRoot | Out-Null
  $installStateJson = [ordered]@{
    protocolVersion = '2026-08-13-audio-routing-v7'
    installChannel = 'development'
    driverVersion = '0.10.0-dev'
    bridgeVersion = '0.1.0'
    driverHealth = 'running'
    installedAt = (Get-Date -Format s)
    targetDeviceId = 'virtual-mic-default'
    virtualRenderDeviceId = 'virtual-speaker-default'
    driverBackend = 'sysvad-wave-rt'
  } | ConvertTo-Json -Depth 6
  Set-Utf8NoBomContent (Join-Path $preflightRoot "driver-install-state.json") $installStateJson

  $resetStdout = Join-Path $preflightRoot "driver-reset.stdout.log"
  $resetStderr = Join-Path $preflightRoot "driver-reset.stderr.log"
  $resetProcess = Start-Process -FilePath $audioProbeExe `
    -ArgumentList @("--reset-only") `
    -RedirectStandardOutput $resetStdout `
    -RedirectStandardError $resetStderr `
    -WindowStyle Hidden -Wait -PassThru
  $resetOutput = if (Test-Path -LiteralPath $resetStdout -PathType Leaf) {
    Get-Content -LiteralPath $resetStdout -Raw -Encoding UTF8
  } else { "" }
  $resetResult = $null
  try {
    if ($resetOutput.Trim()) {
      $resetResult = $resetOutput | ConvertFrom-Json
    }
  } catch {
    throw "virtual-driver media source preflight reset emitted invalid JSON: $($_.Exception.Message)"
  }
  if ($resetProcess.ExitCode -ne 0 -or $null -eq $resetResult -or $resetResult.passed -ne $true) {
    $resetError = if (Test-Path -LiteralPath $resetStderr -PathType Leaf) {
      Get-Content -LiteralPath $resetStderr -Raw -Encoding UTF8
    } else { "" }
    throw "virtual-driver media source preflight could not reset the driver ring: $resetError $resetOutput"
  }

  $pipeName = "omni-watch-media-preflight-$PID"
  $bridgeStdout = Join-Path $OutputDirectory "virtual-driver-media-source-preflight.bridge.stdout.log"
  $bridgeStderr = Join-Path $OutputDirectory "virtual-driver-media-source-preflight.bridge.stderr.log"
  $injectorStdout = Join-Path $OutputDirectory "virtual-driver-media-source-preflight.injector.stdout.log"
  $injectorStderr = Join-Path $OutputDirectory "virtual-driver-media-source-preflight.injector.stderr.log"
  $diagnosticsPath = Join-Path $OutputDirectory "virtual-driver-media-source-preflight-diagnostics.json"
  $bridgeProcess = $null
  $injectorProcess = $null
  $init = $null
  $frame = $null
  $injectorResult = $null
  $phase = "start_bridge"
  try {
    $bridgeProcess = Start-Process -FilePath $bridgeExe -ArgumentList @(
      "--pipe-name", $pipeName,
      "--runtime-root", $preflightRoot,
      "--bridge-version", "0.1.0"
    ) -RedirectStandardOutput $bridgeStdout -RedirectStandardError $bridgeStderr -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 600
    $phase = "init"
    $sessionId = "watch-mode-media-preflight-$PID"
    $init = Write-NamedPipeJsonLine $pipeName (New-BridgeSourceProbeInitPayload "virtual-driver" $sessionId)
    $phase = "render_media"
    $injectorProcess = Start-Process -FilePath $injectorExe `
      -ArgumentList @("--media", (Resolve-Path -LiteralPath $PathToMedia).Path, "--endpoint-id", $VirtualRenderEndpointId, "--max-seconds", "5") `
      -RedirectStandardOutput $injectorStdout `
      -RedirectStandardError $injectorStderr `
      -WindowStyle Hidden -PassThru
    $phase = "read_source_frame"
    $frame = Read-BridgeSourceFrame "$pipeName-source" -TimeoutMs 12000
    if (-not $injectorProcess.WaitForExit(20000)) {
      throw "watch media injector did not exit after the virtual-driver source frame"
    }
    $injectorProcess.Refresh()
    $injectorOutput = if (Test-Path -LiteralPath $injectorStdout -PathType Leaf) {
      Get-Content -LiteralPath $injectorStdout -Raw -Encoding UTF8
    } else { "" }
    try {
      if ($injectorOutput.Trim()) {
        $injectorResult = $injectorOutput | ConvertFrom-Json
      }
    } catch {
      throw "watch media injector emitted invalid JSON: $($_.Exception.Message)"
    }
    if ((($null -ne $injectorProcess.ExitCode) -and $injectorProcess.ExitCode -ne 0) -or $null -eq $injectorResult -or $injectorResult.passed -ne $true) {
      $injectorError = if (Test-Path -LiteralPath $injectorStderr -PathType Leaf) {
        Get-Content -LiteralPath $injectorStderr -Raw -Encoding UTF8
      } else { "" }
      throw "watch media injector did not report passed=true: $injectorError $injectorOutput"
    }
    $phase = "shutdown"
    [void](Write-NamedPipeJsonLine $pipeName ([ordered]@{
      type = 'bridge.shutdown'
      requestId = "watch-mode-media-preflight-shutdown-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
      sessionId = $sessionId
      reason = 'watch-mode-media-preflight-complete'
    }))
    return [pscustomobject]@{
      passed = $true
      reset = $resetResult
      init = $init
      sourceFrame = $frame
      injector = $injectorResult
      virtualRenderEndpointId = $VirtualRenderEndpointId
      pipeName = $pipeName
      sourcePipeName = "$pipeName-source"
      bridgeStdout = $bridgeStdout
      bridgeStderr = $bridgeStderr
      injectorStdout = $injectorStdout
      injectorStderr = $injectorStderr
    }
  } catch {
    $errorMessage = $_.Exception.Message
    [pscustomobject]@{
      passed = $false
      phase = $phase
      error = $errorMessage
      init = $init
      sourceFrame = $frame
      injector = $injectorResult
      virtualRenderEndpointId = $VirtualRenderEndpointId
      pipeName = $pipeName
      sourcePipeName = "$pipeName-source"
      bridgeStdout = $bridgeStdout
      bridgeStderr = $bridgeStderr
      injectorStdout = $injectorStdout
      injectorStderr = $injectorStderr
    } | ConvertTo-Json -Depth 12 | Set-Content -Path $diagnosticsPath -Encoding UTF8
    throw "virtual-driver media source preflight failed during ${phase}: $errorMessage Diagnostics=$diagnosticsPath"
  } finally {
    if ($injectorProcess -and -not $injectorProcess.HasExited) {
      Stop-Process -Id $injectorProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($bridgeProcess -and -not $bridgeProcess.HasExited) {
      Stop-Process -Id $bridgeProcess.Id -Force -ErrorAction SilentlyContinue
    }
  }
}

function Invoke-PhysicalOutputProbe {
  param([string]$OutputDirectory, [string]$FeedbackMode)
  $probeExe = Resolve-OmniBuiltExecutable -BuildProfile "release" -ExecutableName "omni-physical-output-probe.exe"
  $bridgeExe = Resolve-OmniBuiltExecutable -BuildProfile "release" -ExecutableName "omni-bridge-service.exe"
  $tonePlayerExe = Resolve-OmniBuiltExecutable -BuildProfile "release" -ExecutableName "omni-tone-render-probe.exe"
  if (-not (Test-Path -LiteralPath $probeExe -PathType Leaf)) {
    throw "Physical output probe executable not found: $probeExe"
  }
  if (-not (Test-Path -LiteralPath $bridgeExe -PathType Leaf)) {
    throw "Bridge executable not found: $bridgeExe"
  }
  if ($FeedbackMode -eq "process-exclusion" -and -not (Test-Path -LiteralPath $tonePlayerExe -PathType Leaf)) {
    throw "Tone render probe executable not found: $tonePlayerExe"
  }
  $probeRuntimeRoot = Join-Path $OutputDirectory "physical-output-probe-runtime"
  New-Item -ItemType Directory -Force -Path $probeRuntimeRoot | Out-Null
  $stdout = Join-Path $OutputDirectory "physical-output-probe.stdout.log"
  $stderr = Join-Path $OutputDirectory "physical-output-probe.stderr.log"
  $probeDeviceId = $PhysicalPlaybackDeviceId
  if (($probeDeviceId -eq "default" -or [string]::IsNullOrWhiteSpace($probeDeviceId)) -and $ExpectedPhysicalPlaybackDeviceName) {
    $probeDeviceId = $ExpectedPhysicalPlaybackDeviceName
  }
  $probeArgs = @(
    "--bridge-exe", $bridgeExe,
    "--runtime-root", $probeRuntimeRoot,
    "--physical-playback-device-id", $probeDeviceId,
    "--physical-playback-level", "50"
  )
  if ($FeedbackMode -eq "process-exclusion") {
    $probeArgs += @(
      "--tone-player-exe", $tonePlayerExe,
      "--process-exclusion-fingerprint"
    )
  }
  $output = & $probeExe @probeArgs 2> $stderr
  $exitCode = $LASTEXITCODE
  $text = ($output -join [Environment]::NewLine)
  Set-Utf8NoBomContent $stdout $text
  if (-not $text) {
    throw "physical output probe returned no JSON output. ExitCode=$exitCode"
  }
  try {
    $result = $text | ConvertFrom-Json
  } catch {
    throw "physical output probe returned invalid JSON. ExitCode=$exitCode Output=$text"
  }
  if ($exitCode -ne 0 -or (-not $result.passed -and -not $result.skipped)) {
    throw "physical output probe failed. ExitCode=$exitCode Detail=$($result.detail)"
  }
  if ($ExpectedPhysicalPlaybackDeviceName -and -not $result.skipped) {
    $resolvedName = [string]$result.resolvedPhysicalPlaybackDeviceName
    if ($resolvedName -notlike "*$ExpectedPhysicalPlaybackDeviceName*") {
      throw "physical output probe resolved '$resolvedName', expected device name containing '$ExpectedPhysicalPlaybackDeviceName'"
    }
  }
  return $result
}

function Start-PhysicalOutputContentRecorder {
  param([string]$OutputDirectory, [string]$PhysicalDeviceId)
  $probeExe = Resolve-OmniBuiltExecutable -BuildProfile "release" -ExecutableName "omni-physical-output-probe.exe"
  if (-not (Test-Path -LiteralPath $probeExe -PathType Leaf)) {
    throw "Physical output recorder executable not found: $probeExe"
  }
  if (-not $PhysicalDeviceId) {
    throw "Physical output recorder requires a resolved physical playback endpoint id"
  }
  $mediaBudgetSeconds = if ($PlaybackSeconds -gt 0) { $PlaybackSeconds } else { 180 }
  $recordSeconds = [Math]::Max(8, $mediaBudgetSeconds + $PostPlaybackWaitSeconds + 8)
  $recordingPath = Join-Path $OutputDirectory "physical-output-recording.wav"
  $transcriptionPcmPath = Join-Path $OutputDirectory "physical-output-recording-16k-mono.pcm"
  $stdout = Join-Path $OutputDirectory "physical-output-recorder.stdout.log"
  $stderr = Join-Path $OutputDirectory "physical-output-recorder.stderr.log"
  $startedAtEpochMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $process = Start-Process -FilePath $probeExe -ArgumentList @(
    "--record-only",
    "--record-seconds", "$recordSeconds",
    "--physical-playback-device-id", $PhysicalDeviceId,
    "--record-path", $recordingPath,
    "--transcription-pcm-path", $transcriptionPcmPath
  ) -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
  return [pscustomobject]@{
    pid = $process.Id
    process = $process
    recordSeconds = $recordSeconds
    startedAtEpochMs = $startedAtEpochMs
    recordingPath = $recordingPath
    transcriptionPcmPath = $transcriptionPcmPath
    stdout = $stdout
    stderr = $stderr
  }
}

function Complete-PhysicalOutputContentRecorder {
  param($Recorder)
  if (-not $Recorder) {
    return $null
  }
  $timeoutMs = ([int]$Recorder.recordSeconds + 20) * 1000
  $exited = $Recorder.process.WaitForExit($timeoutMs)
  if (-not $exited) {
    Stop-Process -Id $Recorder.pid -Force -ErrorAction SilentlyContinue
  }
  $text = if (Test-Path -LiteralPath $Recorder.stdout -PathType Leaf) {
    Get-Content -LiteralPath $Recorder.stdout -Raw -ErrorAction SilentlyContinue
  } else {
    ""
  }
  $parsed = $null
  if ($text) {
    $jsonLine = @($text -split "`r?`n" | Where-Object { $_.Trim().StartsWith("{") } | Select-Object -Last 1)
    if ($jsonLine.Count -gt 0) {
      try {
        $parsed = $jsonLine[0] | ConvertFrom-Json
      } catch {
        $parsed = $null
      }
    }
  }
  if (-not $parsed) {
    $stderrText = if (Test-Path -LiteralPath $Recorder.stderr -PathType Leaf) { Get-Content -LiteralPath $Recorder.stderr -Raw -ErrorAction SilentlyContinue } else { "" }
    $parsed = [pscustomobject]@{
      passed = $false
      error = "physical output recorder returned no JSON output"
      stderr = $stderrText
      recordingPath = $Recorder.recordingPath
      transcriptionPcmPath = $Recorder.transcriptionPcmPath
    }
  }
  $quality = Measure-PcmAudioQuality $Recorder.transcriptionPcmPath 16000
  if ($quality) {
    $parsed | Add-Member -NotePropertyName audioQuality -NotePropertyValue $quality -Force
  }
  $parsed | Add-Member -NotePropertyName recordingStartedAtEpochMs -NotePropertyValue ([int64]$Recorder.startedAtEpochMs) -Force
  $parsed | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path (Split-Path -Parent $Recorder.recordingPath) "physical-output-recording.json") -Encoding UTF8
  return $parsed
}

function Measure-PcmAudioQuality {
  param([string]$PcmPath, [int]$SampleRateHz)
  if (-not (Test-Path -LiteralPath $PcmPath -PathType Leaf)) {
    return $null
  }
  $bytes = [System.IO.File]::ReadAllBytes($PcmPath)
  $sampleCount = [Math]::Floor($bytes.Length / 2)
  if ($sampleCount -le 0) {
    return [pscustomobject]@{
      passed = $false
      error = "PCM file contains no samples"
      sampleCount = 0
    }
  }
  $sumSquares = 0.0
  $peak = 0.0
  $clipped = 0
  $zeroCrossings = 0
  $discontinuities = 0
  $previous = 0.0
  $nonSilent = 0
  for ($i = 0; $i -lt $sampleCount; $i++) {
    $offset = $i * 2
    $sample = [System.BitConverter]::ToInt16($bytes, $offset)
    $value = $sample / 32768.0
    $abs = [Math]::Abs($value)
    $sumSquares += $value * $value
    if ($abs -gt $peak) { $peak = $abs }
    if ([Math]::Abs($sample) -ge 32700) { $clipped++ }
    if ($i -gt 0 -and (($value -ge 0 -and $previous -lt 0) -or ($value -lt 0 -and $previous -ge 0))) {
      $zeroCrossings++
    }
    if ($i -gt 0 -and [Math]::Abs($value - $previous) -ge 0.35) {
      $discontinuities++
    }
    if ($abs -ge 0.003) { $nonSilent++ }
    $previous = $value
  }
  $rms = [Math]::Sqrt($sumSquares / [Math]::Max(1, $sampleCount))
  $clippingRatio = $clipped / [Math]::Max(1, $sampleCount)
  $zeroCrossingRate = $zeroCrossings / [Math]::Max(1, $sampleCount - 1)
  $discontinuityRate = $discontinuities / [Math]::Max(1, $sampleCount - 1)
  $nonSilentRatio = $nonSilent / [Math]::Max(1, $sampleCount)
  $crestFactor = if ($rms -gt 0) { $peak / $rms } else { 0.0 }
  $hardFailure = ($clippingRatio -gt 0.01 -or $peak -ge 0.9999 -or $discontinuityRate -gt 0.005)
  $noiseRisk = ($zeroCrossingRate -gt 0.28 -and $rms -gt 0.015)
  return [pscustomobject]@{
    passed = -not $hardFailure
    sampleRateHz = $SampleRateHz
    sampleCount = $sampleCount
    durationSeconds = [Math]::Round($sampleCount / [Math]::Max(1, $SampleRateHz), 3)
    rms = [Math]::Round($rms, 6)
    peak = [Math]::Round($peak, 6)
    crestFactor = [Math]::Round($crestFactor, 3)
    clippingRatio = [Math]::Round($clippingRatio, 6)
    clippedSamples = $clipped
    zeroCrossingRate = [Math]::Round($zeroCrossingRate, 6)
    discontinuityRate = [Math]::Round($discontinuityRate, 6)
    discontinuities = $discontinuities
    nonSilentRatio = [Math]::Round($nonSilentRatio, 6)
    noiseRisk = $noiseRisk
    detail = if ($clippingRatio -gt 0.01 -or $peak -ge 0.9999) { "physical output recording is clipped: clippingRatio=$([Math]::Round($clippingRatio, 6)) peak=$([Math]::Round($peak, 6))" } elseif ($discontinuityRate -gt 0.005) { "physical output recording has discontinuities: discontinuityRate=$([Math]::Round($discontinuityRate, 6))" } elseif ($noiseRisk) { "physical output recording has high zero-crossing noise risk" } else { $null }
  }
}

function Copy-PcmWindow {
  param(
    [string]$SourcePath,
    [string]$DestinationPath,
    [int]$SampleRateHz,
    [int]$Seconds
  )
  if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
    return $null
  }
  $bytes = [System.IO.File]::ReadAllBytes($SourcePath)
  $maxBytes = [Math]::Min($bytes.Length, [Math]::Max(1, $SampleRateHz) * [Math]::Max(1, $Seconds) * 2)
  $windowBytes = New-Object byte[] $maxBytes
  [Array]::Copy($bytes, 0, $windowBytes, 0, $maxBytes)
  [System.IO.File]::WriteAllBytes($DestinationPath, $windowBytes)
  return [pscustomobject]@{
    path = $DestinationPath
    sampleRateHz = $SampleRateHz
    seconds = $Seconds
    bytes = $maxBytes
  }
}

function Get-PcmRmsEnvelope {
  param([string]$PcmPath, [int]$FrameSamples)
  if (-not (Test-Path -LiteralPath $PcmPath -PathType Leaf)) {
    return @()
  }
  $bytes = [System.IO.File]::ReadAllBytes($PcmPath)
  $sampleCount = [Math]::Floor($bytes.Length / 2)
  if ($sampleCount -lt $FrameSamples) {
    return @()
  }
  $frames = [Math]::Floor($sampleCount / $FrameSamples)
  $envelope = New-Object double[] $frames
  for ($frame = 0; $frame -lt $frames; $frame++) {
    $sumSquares = 0.0
    $base = $frame * $FrameSamples * 2
    for ($i = 0; $i -lt $FrameSamples; $i++) {
      $sample = [System.BitConverter]::ToInt16($bytes, $base + ($i * 2))
      $value = $sample / 32768.0
      $sumSquares += $value * $value
    }
    $envelope[$frame] = [Math]::Sqrt($sumSquares / [Math]::Max(1, $FrameSamples))
  }
  return @($envelope)
}

function Get-PearsonCorrelation {
  param([double[]]$Left, [double[]]$Right, [int]$LeftStart, [int]$RightStart, [int]$Count)
  if ($Count -lt 12) {
    return 0.0
  }
  $sumL = 0.0
  $sumR = 0.0
  for ($i = 0; $i -lt $Count; $i++) {
    $sumL += $Left[$LeftStart + $i]
    $sumR += $Right[$RightStart + $i]
  }
  $meanL = $sumL / $Count
  $meanR = $sumR / $Count
  $num = 0.0
  $denL = 0.0
  $denR = 0.0
  for ($i = 0; $i -lt $Count; $i++) {
    $l = $Left[$LeftStart + $i] - $meanL
    $r = $Right[$RightStart + $i] - $meanR
    $num += $l * $r
    $denL += $l * $l
    $denR += $r * $r
  }
  $den = [Math]::Sqrt($denL * $denR)
  if ($den -le 0) {
    return 0.0
  }
  return $num / $den
}

function Measure-PcmReferenceSimilarity {
  param(
    [string]$ReferencePcmPath,
    [string]$RecordedPcmPath,
    [int]$SampleRateHz
  )
  if (-not (Test-Path -LiteralPath $ReferencePcmPath -PathType Leaf)) {
    return [pscustomobject]@{
      passed = $false
      error = "source reference PCM was not created"
      referencePcmPath = $ReferencePcmPath
      recordedPcmPath = $RecordedPcmPath
    }
  }
  if (-not (Test-Path -LiteralPath $RecordedPcmPath -PathType Leaf)) {
    return [pscustomobject]@{
      passed = $false
      error = "physical output PCM window was not created"
      referencePcmPath = $ReferencePcmPath
      recordedPcmPath = $RecordedPcmPath
    }
  }
  $frameSamples = [Math]::Max(80, [Math]::Floor($SampleRateHz * 0.02))
  $reference = @(Get-PcmRmsEnvelope $ReferencePcmPath $frameSamples)
  $recorded = @(Get-PcmRmsEnvelope $RecordedPcmPath $frameSamples)
  if ($reference.Count -lt 40 -or $recorded.Count -lt 40) {
    return [pscustomobject]@{
      passed = $false
      error = "not enough PCM frames for similarity analysis"
      referenceFrames = $reference.Count
      recordedFrames = $recorded.Count
      referencePcmPath = $ReferencePcmPath
      recordedPcmPath = $RecordedPcmPath
    }
  }
  $maxOffset = [Math]::Min($recorded.Count - 20, [Math]::Floor($SampleRateHz * 8 / $frameSamples))
  $bestCorrelation = -1.0
  $bestOffset = 0
  $bestCount = 0
  for ($offset = 0; $offset -le $maxOffset; $offset++) {
    $count = [Math]::Min($reference.Count, $recorded.Count - $offset)
    if ($count -lt 40) { continue }
    $corr = Get-PearsonCorrelation $reference $recorded 0 $offset $count
    if ($corr -gt $bestCorrelation) {
      $bestCorrelation = $corr
      $bestOffset = $offset
      $bestCount = $count
    }
  }
  $refMean = (($reference | Measure-Object -Average).Average)
  $recMean = (($recorded | Measure-Object -Average).Average)
  $levelRatio = if ($refMean -gt 0) { $recMean / $refMean } else { 0.0 }
  $passed = ($bestCorrelation -ge 0.35 -and $levelRatio -ge 0.05 -and $levelRatio -le 8.0)
  return [pscustomobject]@{
    passed = $passed
    referencePcmPath = $ReferencePcmPath
    recordedPcmPath = $RecordedPcmPath
    sampleRateHz = $SampleRateHz
    frameMilliseconds = [Math]::Round($frameSamples * 1000 / $SampleRateHz, 3)
    referenceFrames = $reference.Count
    recordedFrames = $recorded.Count
    comparedFrames = $bestCount
    bestOffsetFrames = $bestOffset
    bestOffsetSeconds = [Math]::Round($bestOffset * $frameSamples / $SampleRateHz, 3)
    envelopeCorrelation = [Math]::Round($bestCorrelation, 4)
    levelRatio = [Math]::Round($levelRatio, 4)
    detail = if (-not $passed) { "physical output original passthrough does not resemble source media reference: correlation=$([Math]::Round($bestCorrelation, 4)) levelRatio=$([Math]::Round($levelRatio, 4))" } else { $null }
  }
}

function Get-RecentSubtitleText {
  param([string]$AppLogPath, [string]$RunMarker)
  if (-not (Test-Path -LiteralPath $AppLogPath -PathType Leaf)) {
    return ""
  }
  $raw = Get-LogTextAfterMarker $AppLogPath $RunMarker
  $items = New-Object System.Collections.Generic.List[string]
  foreach ($match in [regex]::Matches($raw, 'translated="((?:\\.|[^"\\])*)"', [Text.RegularExpressions.RegexOptions]::Multiline)) {
    $decoded = Convert-LoggedTranslationText $match.Groups[1].Value
    if ($decoded.Length -ge 2) {
      [void]$items.Add($decoded)
    }
  }
  foreach ($match in [regex]::Matches($raw, '"translatedText"\s*:\s*"((?:\\.|[^"\\])*)"', [Text.RegularExpressions.RegexOptions]::Multiline)) {
    $decoded = Convert-LoggedTranslationText $match.Groups[1].Value
    if ($decoded.Length -ge 2) {
      [void]$items.Add($decoded)
    }
  }
  return (($items | Select-Object -Last 12) -join "`n")
}

function Convert-LoggedTranslationText {
  param([string]$Text)
  if ($null -eq $Text) {
    return ""
  }
  $value = $Text -replace '\\r', "`r"
  $value = $value -replace '\\n', "`n"
  $value = $value -replace '\\"', '"'
  $value = $value -replace '\\\\', '\'
  return $value
}

function Get-RecentFinalSegmentTranslationText {
  param([string]$AppLogPath, [string]$RunMarker)
  if (-not (Test-Path -LiteralPath $AppLogPath -PathType Leaf)) {
    return ""
  }
  $raw = Get-LogTextAfterMarker $AppLogPath $RunMarker
  $items = New-Object System.Collections.Generic.List[string]
  foreach ($match in [regex]::Matches($raw, '(?ms)^[^\r\n]*rank=(Final|Replacement|Forced)[^\r\n]*translated="((?:\\.|[^"\\])*)"', [Text.RegularExpressions.RegexOptions]::Multiline)) {
    $decoded = Convert-LoggedTranslationText $match.Groups[2].Value
    if ($decoded.Length -ge 2) {
      [void]$items.Add($decoded)
    }
  }
  return (($items | Select-Object -Last 12) -join "`n")
}

function Read-SubtitleQueueTimeline {
  param([string]$AppLogPath, [string]$RunMarker)
  if (-not (Test-Path -LiteralPath $AppLogPath -PathType Leaf)) {
    return [pscustomobject]@{
      eventCount = 0
      cueOrderInversions = 0
      duplicateFinalTranslations = 0
      events = @()
      error = "app.log not found"
    }
  }
  $raw = Get-LogTextAfterMarker $AppLogPath $RunMarker
  $events = New-Object System.Collections.Generic.List[object]
  foreach ($match in [regex]::Matches($raw, '(?m)^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})[^\r\n]*speech_started received[^\r\n]*cue_id=(omni-cue-\d+)', [Text.RegularExpressions.RegexOptions]::Multiline)) {
    [void]$events.Add([pscustomobject]@{ index = $match.Index; at = $match.Groups[1].Value; kind = "cue_started"; cueId = $match.Groups[2].Value; rank = $null; seq = $null; text = "" })
  }
  foreach ($match in [regex]::Matches($raw, '(?ms)^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})[^\r\n]*\[TRANS_WRITE\]\s+cue_id=(omni-cue-\d+)\s+rank=(\w+)\s+seq=(\d+)\s+translated="((?:\\.|[^"\\])*)"', [Text.RegularExpressions.RegexOptions]::Multiline)) {
    [void]$events.Add([pscustomobject]@{
      index = $match.Index
      at = $match.Groups[1].Value
      kind = "translation_write"
      cueId = $match.Groups[2].Value
      rank = $match.Groups[3].Value
      seq = [int]$match.Groups[4].Value
      text = Convert-LoggedTranslationText $match.Groups[5].Value
    })
  }
  foreach ($match in [regex]::Matches($raw, '(?m)^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})[^\r\n]*speech\.segment_tts_queued\s+\|\s+cue=(omni-cue-\d+)\s+segmentIndex=(\d+)', [Text.RegularExpressions.RegexOptions]::Multiline)) {
    [void]$events.Add([pscustomobject]@{ index = $match.Index; at = $match.Groups[1].Value; kind = "segment_tts_queued"; cueId = $match.Groups[2].Value; rank = $null; seq = [int]$match.Groups[3].Value; text = "" })
  }
  foreach ($match in [regex]::Matches($raw, '(?m)^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})[^\r\n]*speech\.segment_playback_written\s+\|\s+cue=(omni-cue-\d+)\s+segmentIndex=(\d+)', [Text.RegularExpressions.RegexOptions]::Multiline)) {
    [void]$events.Add([pscustomobject]@{ index = $match.Index; at = $match.Groups[1].Value; kind = "segment_playback_written"; cueId = $match.Groups[2].Value; rank = $null; seq = [int]$match.Groups[3].Value; text = "" })
  }
  foreach ($match in [regex]::Matches($raw, '(?m)^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})[^\r\n]*event=translation_playback_status\s+\|[^\r\n]*cueId=(omni-cue-\d+)[^\r\n]*\bstatus=completed\b[^\r\n]*\breason=physical-playback-completed\b', [Text.RegularExpressions.RegexOptions]::Multiline)) {
    [void]$events.Add([pscustomobject]@{ index = $match.Index; at = $match.Groups[1].Value; kind = "bridge_playback_completed"; cueId = $match.Groups[2].Value; rank = $null; seq = $null; text = "" })
  }
  $orderedEvents = @($events | Sort-Object index)
  $finalWrites = @($orderedEvents | Where-Object { $_.kind -eq "translation_write" -and $_.rank -match '^(Final|Forced)$' })
  $lastCueTs = 0L
  $inversions = 0
  foreach ($event in $finalWrites) {
    $cueMatch = [regex]::Match([string]$event.cueId, '(\d+)$')
    if (-not $cueMatch.Success) { continue }
    $cueTs = [int64]$cueMatch.Groups[1].Value
    if ($lastCueTs -gt 0 -and $cueTs -lt $lastCueTs) {
      $inversions++
    }
    $lastCueTs = $cueTs
  }
  $seenFinalText = @{}
  $duplicates = 0
  $duplicateDetails = @()
  foreach ($event in $finalWrites) {
    $normalized = (([string]$event.text).Normalize([Text.NormalizationForm]::FormKC).ToLowerInvariant() -replace '[^\p{L}\p{N}]+', '')
    if ($normalized.Length -lt 8) { continue }
    if ($seenFinalText.ContainsKey($normalized)) {
      $duplicates++
      $duplicateDetails += [pscustomobject]@{
        at = $event.at
        cueId = $event.cueId
        seq = $event.seq
        text = $event.text
      }
    } else {
      $seenFinalText[$normalized] = $true
    }
  }
  $startedCueCount = 0
  $queuedSegmentCount = 0
  $playedSegmentCount = 0
  foreach ($event in $orderedEvents) {
    if ($event.kind -eq "cue_started") { $startedCueCount++ }
    elseif ($event.kind -eq "segment_tts_queued") { $queuedSegmentCount++ }
    elseif ($event.kind -eq "segment_playback_written" -or $event.kind -eq "bridge_playback_completed") { $playedSegmentCount++ }
  }
  $firstCueStarted = @($orderedEvents | Where-Object { $_.kind -eq "cue_started" } | Select-Object -First 1)
  $firstTranslationWrite = @($orderedEvents | Where-Object { $_.kind -eq "translation_write" } | Select-Object -First 1)
  $firstFinalTranslationWrite = @($orderedEvents | Where-Object { $_.kind -eq "translation_write" -and $_.rank -match '^(Final|Forced|Replacement)$' } | Select-Object -First 1)
  $firstTtsQueued = @($orderedEvents | Where-Object { $_.kind -eq "segment_tts_queued" } | Select-Object -First 1)
  $firstPlaybackWritten = @($orderedEvents | Where-Object { $_.kind -eq "segment_playback_written" -or $_.kind -eq "bridge_playback_completed" } | Select-Object -First 1)
  function Get-EventLatencySeconds {
    param($StartEvent, $EndEvent)
    if (-not ($StartEvent -and $EndEvent)) { return $null }
    try {
      $start = [DateTime]::ParseExact([string]$StartEvent.at, "yyyy-MM-dd HH:mm:ss", [Globalization.CultureInfo]::InvariantCulture)
      $end = [DateTime]::ParseExact([string]$EndEvent.at, "yyyy-MM-dd HH:mm:ss", [Globalization.CultureInfo]::InvariantCulture)
      return [Math]::Round(($end - $start).TotalSeconds, 3)
    } catch {
      return $null
    }
  }
  $firstVisibleTranslationLatencySeconds = Get-EventLatencySeconds $firstCueStarted $firstTranslationWrite
  $firstFinalTranslationLatencySeconds = Get-EventLatencySeconds $firstCueStarted $firstFinalTranslationWrite
  $firstTtsQueuedLatencySeconds = Get-EventLatencySeconds $firstCueStarted $firstTtsQueued
  $firstPlaybackLatencySeconds = Get-EventLatencySeconds $firstCueStarted $firstPlaybackWritten
  $recentEvents = @()
  $skip = [Math]::Max(0, $orderedEvents.Count - 80)
  for ($i = $skip; $i -lt $orderedEvents.Count; $i++) {
    $event = $orderedEvents[$i]
    $recentEvents += [pscustomobject]@{
      at = $event.at
      kind = $event.kind
      cueId = $event.cueId
      rank = $event.rank
      seq = $event.seq
      text = $event.text
    }
  }
  return [pscustomobject]@{
    eventCount = $orderedEvents.Count
    startedCueCount = $startedCueCount
    finalWriteCount = $finalWrites.Count
    queuedSegmentCount = $queuedSegmentCount
    playedSegmentCount = $playedSegmentCount
    cueOrderInversions = $inversions
    duplicateFinalTranslations = $duplicates
    duplicateFinalTranslationDetails = @($duplicateDetails)
    firstVisibleTranslationLatencySeconds = $firstVisibleTranslationLatencySeconds
    firstFinalTranslationLatencySeconds = $firstFinalTranslationLatencySeconds
    firstTtsQueuedLatencySeconds = $firstTtsQueuedLatencySeconds
    firstPlaybackLatencySeconds = $firstPlaybackLatencySeconds
    displayOrder = "newest-first"
    events = @($recentEvents)
  }
}

function Get-PhysicalOutputSttApiKey {
  $configPath = Join-Path $workspaceRoot "scripts/testing/llm-integration.config.json"
  $envName = "OMNI_TEST_DASHSCOPE_API_KEY"
  $apiKey = [System.Environment]::GetEnvironmentVariable($envName)
  if ($apiKey) {
    return $apiKey
  }
  if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    try {
      $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
      $configuredEnv = [string]$config.audio.apiKeyEnv
      if ($configuredEnv) {
        $apiKey = [System.Environment]::GetEnvironmentVariable($configuredEnv)
        if ($apiKey) {
          return $apiKey
        }
        if ($config.environment -and $config.environment.$configuredEnv) {
          return [string]$config.environment.$configuredEnv
        }
      }
    } catch {
    }
  }
  try {
    $reference = "credential://provider/dashscope/default"
    $normalized = $reference -replace '[:/\\ ]', '_'
    $targetName = "OmniTranslate:$normalized"
    if (-not ("OmniWatchCredentialReader" -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class OmniWatchCredentialReader {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
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

  [DllImport("Advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

  [DllImport("Advapi32.dll", SetLastError = true)]
  private static extern void CredFree(IntPtr buffer);

  public static string ReadGenericSecret(string target) {
    IntPtr pointer;
    if (!CredRead(target, 1, 0, out pointer)) return null;
    try {
      var credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
      if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0) return null;
      var bytes = new byte[credential.CredentialBlobSize];
      Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
      return System.Text.Encoding.UTF8.GetString(bytes);
    } finally {
      CredFree(pointer);
    }
  }
}
'@
    }
    $credentialKey = [OmniWatchCredentialReader]::ReadGenericSecret($targetName)
    if (-not [string]::IsNullOrWhiteSpace($credentialKey)) {
      return $credentialKey
    }
  } catch {
    # Credential Manager is an optional local source for the subprocess-only
    # physical-output verifier. Do not expose the secret or error details.
  }
  return $null
}

function Build-OmniRealtimeDiagnostic {
  param([string]$OutputDirectory)
  $buildLog = Join-Path $OutputDirectory "omni-realtime-diagnostic.build.log"
  $buildErr = Join-Path $OutputDirectory "omni-realtime-diagnostic.build.stderr.log"
  $previousCargoTargetDir = $env:CARGO_TARGET_DIR
  try {
    # This diagnostic crate is not a workspace member. Pin its output to the
    # repository target directory here instead of relying on the matrix
    # caller's environment; diagnostic-single-device uses the same verifier.
    $env:CARGO_TARGET_DIR = Join-Path $workspaceRoot "target"
    $buildExit = Invoke-NativeProcessToLog "cargo.exe" @("build", "--manifest-path", "scripts/diagnostics/omni-realtime/Cargo.toml") $workspaceRoot $buildLog $buildErr
  } finally {
    $env:CARGO_TARGET_DIR = $previousCargoTargetDir
  }
  if ($buildExit -ne 0) {
    throw "omni realtime STT diagnostic build failed with exit code $buildExit; see $buildLog and $buildErr"
  }
  # The strict matrix fixes CARGO_TARGET_DIR to the workspace target. Never
  # prefer a stale standalone-crate target over the just-built current-HEAD binary.
  $exe = Join-Path $workspaceRoot "target/debug/omni-realtime-diagnostic.exe"
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "omni realtime STT diagnostic executable was not built"
  }
  return $exe
}

function Parse-OmniRealtimeDiagnosticText {
  param([string]$Text)
  $source = ""
  $translation = ""
  $sourceMatch = [regex]::Matches($Text, "source='([^']*)'") | Select-Object -Last 1
  if ($sourceMatch) { $source = $sourceMatch.Groups[1].Value }
  $translationMatch = [regex]::Matches($Text, "translation='([^']*)'") | Select-Object -Last 1
  if ($translationMatch) { $translation = $translationMatch.Groups[1].Value }
  return [pscustomobject]@{
    source = $source
    translation = $translation
  }
}

function Get-TextClauses {
  param([string]$Text)
  $items = New-Object System.Collections.Generic.List[string]
  $normalized = ([string]$Text).Normalize([Text.NormalizationForm]::FormKC)
  foreach ($piece in ($normalized -split '[\u3002\uff01\uff1f\uff1b\uff0c!?;,?\.\r\n]+')) {
    $clean = ($piece -replace '[^\p{L}\p{N}]+', '').Trim().ToLowerInvariant()
    if ($clean.Length -ge 2) {
      [void]$items.Add($clean)
    }
  }
  return @($items)
}

function Get-UniqueClauseText {
  param([string[]]$Texts)
  $seen = @{}
  $items = New-Object System.Collections.Generic.List[string]
  foreach ($text in $Texts) {
    foreach ($clause in @(Get-TextClauses $text)) {
      if (-not $seen.ContainsKey($clause)) {
        $seen[$clause] = $true
        [void]$items.Add($clause)
      }
    }
  }
  return ($items -join "`n")
}

function Get-CharacterOverlapScore {
  param([string]$Left, [string]$Right)
  $a = (($Left.Normalize([Text.NormalizationForm]::FormKC).ToLowerInvariant()) -replace '[^\p{L}\p{N}]+', '')
  $b = (($Right.Normalize([Text.NormalizationForm]::FormKC).ToLowerInvariant()) -replace '[^\p{L}\p{N}]+', '')
  if (-not $a -or -not $b) { return 0.0 }
  $counts = @{}
  foreach ($ch in $b.ToCharArray()) {
    $key = [string]$ch
    $current = 0
    if ($counts.ContainsKey($key)) {
      $current = [int]$counts[$key]
    }
    $counts[$key] = 1 + $current
  }
  $overlap = 0
  foreach ($ch in $a.ToCharArray()) {
    $key = [string]$ch
    $count = 0
    if ($counts.ContainsKey($key)) {
      $count = [int]$counts[$key]
    }
    if ($count -gt 0) {
      $overlap += 1
      $counts[$key] = $count - 1
    }
  }
  return $overlap / [Math]::Max(1, [Math]::Min($a.Length, $b.Length))
}

function Compare-WatchModeContent {
  param(
    $ReferenceTranscript,
    [string]$OutputSource,
    [string]$OutputTranslation,
    [string]$StructuredEvidence = ""
  )
  $sourceReferenceText = [string]$ReferenceTranscript.source
  $translationReferenceText = [string]$ReferenceTranscript.translation
  # The manual realtime diagnostic can finish the source transcript while its
  # translated stream is cut at provider/session close. A short prefix is not
  # an authoritative translation reference and must not make a complete
  # physical translation look like excessive output. The strict report gate
  # independently checks native subtitle concepts and physical cue delivery.
  if ($translationReferenceText.Trim().Length -lt 200) {
    $translationReferenceText = ""
  }
  if (-not $sourceReferenceText -and -not $translationReferenceText) {
    return [pscustomobject]@{
      passed = $false
      error = "source media reference transcript was empty"
    }
  }
  $physicalSourceText = Get-UniqueClauseText @([string]$OutputSource)
  $physicalTranslationText = Get-UniqueClauseText @([string]$OutputTranslation)
  $structuredText = Get-UniqueClauseText @([string]$StructuredEvidence)
  $translationEvidenceText = Get-UniqueClauseText @($physicalTranslationText, $structuredText)
  $warnings = New-Object System.Collections.Generic.List[string]
  $sourceResult = if ($sourceReferenceText) { Compare-WatchModeTextPair $sourceReferenceText $physicalSourceText } else { $null }
  $translationPhysicalResult = if ($translationReferenceText) { Compare-WatchModeTextPair $translationReferenceText $physicalTranslationText } else { $null }
  $translationStructuredResult = if ($translationReferenceText) { Compare-WatchModeTextPair $translationReferenceText $structuredText } else { $null }
  $translationCombinedResult = if ($translationReferenceText) { Compare-WatchModeTextPair $translationReferenceText $translationEvidenceText } else { $null }
  if ($sourceResult -and -not $sourceResult.passed) {
    [void]$warnings.Add("physical source transcript did not cover the source media reference")
  }
  if ($translationPhysicalResult -and -not $translationPhysicalResult.passed) {
    [void]$warnings.Add("physical translation transcript alone did not cover the translated source reference; using structured subtitle/TTS evidence for overlapped audio")
  }
  if ($translationStructuredResult -and -not $translationStructuredResult.passed) {
    [void]$warnings.Add("structured subtitle/TTS evidence alone did not cover the translated source reference")
  }
  $sourceSevereRepetition = ($sourceResult -and $sourceResult.lengthRatio -gt 2.2)
  $translationSevereRepetition = ($translationPhysicalResult -and $translationPhysicalResult.lengthRatio -gt 2.2)
  $sourceTooManyExtras = ($sourceResult -and @($sourceResult.extraClauses).Count -gt 2)
  $translationTooManyExtras = ($translationPhysicalResult -and @($translationPhysicalResult.extraClauses).Count -gt 2)
  if ($sourceSevereRepetition -or $translationSevereRepetition) {
    [void]$warnings.Add("physical recording transcript is much longer than the matching source reference")
  }
  if ($sourceTooManyExtras -or $translationTooManyExtras) {
    [void]$warnings.Add("physical recording transcript has too many extra clauses")
  }
  $sourceCoverage = if ($sourceResult) { [double]$sourceResult.coverage } else { 1.0 }
  $translationCoverage = if ($translationCombinedResult) { [double]$translationCombinedResult.coverage } else { 1.0 }
  $missingClauses = @()
  if ($sourceResult) { $missingClauses += @($sourceResult.missingClauses) }
  if ($translationCombinedResult) { $missingClauses += @($translationCombinedResult.missingClauses) }
  $extraClauses = @()
  if ($sourceResult) { $extraClauses += @($sourceResult.extraClauses) }
  if ($translationPhysicalResult) { $extraClauses += @($translationPhysicalResult.extraClauses) }
  $referenceClauseCount = 0
  if ($sourceResult) { $referenceClauseCount += [int]$sourceResult.referenceClauseCount }
  if ($translationCombinedResult) { $referenceClauseCount += [int]$translationCombinedResult.referenceClauseCount }
  $outputClauseCount = 0
  if ($sourceResult) { $outputClauseCount += [int]$sourceResult.outputClauseCount }
  if ($translationCombinedResult) { $outputClauseCount += [int]$translationCombinedResult.outputClauseCount }
  $referenceChars = 0
  if ($sourceResult) { $referenceChars += [int]$sourceResult.referenceChars }
  if ($translationCombinedResult) { $referenceChars += [int]$translationCombinedResult.referenceChars }
  $outputChars = 0
  if ($sourceResult) { $outputChars += [int]$sourceResult.outputChars }
  if ($translationPhysicalResult) { $outputChars += [int]$translationPhysicalResult.outputChars }
  $passed = ($sourceCoverage -ge 0.85 -and $translationCoverage -ge 0.72 -and @($missingClauses).Count -le 2 -and @($extraClauses).Count -le 2 -and -not $sourceSevereRepetition -and -not $translationSevereRepetition -and -not $sourceTooManyExtras -and -not $translationTooManyExtras)
  return [pscustomobject]@{
    passed = $passed
    coverage = [Math]::Round([Math]::Min($sourceCoverage, $translationCoverage), 3)
    lengthRatio = if ($referenceChars -gt 0) { [Math]::Round($outputChars / $referenceChars, 3) } else { 0.0 }
    referenceClauseCount = $referenceClauseCount
    outputClauseCount = $outputClauseCount
    missingClauses = @($missingClauses)
    extraClauses = @($extraClauses)
    referenceChars = $referenceChars
    outputChars = $outputChars
    physicalTranscript = $sourceResult
    physicalTranslation = $translationPhysicalResult
    structuredEvidence = $translationStructuredResult
    combinedEvidence = $translationCombinedResult
    warnings = @($warnings)
  }
}

function Compare-WatchModeTextPair {
  param([string]$ReferenceText, [string]$OutputText)
  $referenceClauses = @(Get-TextClauses $referenceText)
  $outputClauses = @(Get-TextClauses $outputText)
  $missing = New-Object System.Collections.Generic.List[string]
  foreach ($clause in $referenceClauses) {
    $best = 0.0
    foreach ($candidate in $outputClauses) {
      $best = [Math]::Max($best, (Get-CharacterOverlapScore $clause $candidate))
    }
    if ($best -lt 0.45) {
      [void]$missing.Add($clause)
    }
  }
  $extra = New-Object System.Collections.Generic.List[string]
  foreach ($clause in $outputClauses) {
    $best = 0.0
    foreach ($candidate in $referenceClauses) {
      $best = [Math]::Max($best, (Get-CharacterOverlapScore $clause $candidate))
    }
    if ($best -lt 0.35 -and $clause.Length -ge 4) {
      [void]$extra.Add($clause)
    }
  }
  $refChars = (($referenceText.Normalize([Text.NormalizationForm]::FormKC).ToLowerInvariant()) -replace '[^\p{L}\p{N}]+', '').Length
  $outChars = (($outputText.Normalize([Text.NormalizationForm]::FormKC).ToLowerInvariant()) -replace '[^\p{L}\p{N}]+', '').Length
  $coverage = if ($referenceClauses.Count -gt 0) { ($referenceClauses.Count - $missing.Count) / $referenceClauses.Count } else { 0.0 }
  $lengthRatio = if ($refChars -gt 0) { $outChars / $refChars } else { 0.0 }
  $passed = ($referenceClauses.Count -gt 0 -and $coverage -ge 0.72 -and $missing.Count -le 1 -and $extra.Count -le 2 -and $lengthRatio -le 2.2)
  return [pscustomobject]@{
    passed = $passed
    coverage = [Math]::Round($coverage, 3)
    lengthRatio = [Math]::Round($lengthRatio, 3)
    referenceClauseCount = $referenceClauses.Count
    outputClauseCount = $outputClauses.Count
    missingClauses = @($missing)
    extraClauses = @($extra)
    referenceChars = $refChars
    outputChars = $outChars
  }
}

function Invoke-CanonicalSourceAuthorityNode {
  param(
    [string]$OutputDirectory,
    [ValidateSet("Reference", "Source", "Combined")][string]$Mode = "Combined"
  )
  $authorityScript = Join-Path $workspaceRoot "scripts/testing/watch-mode-canonical-source-authority.mjs"
  if (-not (Test-Path -LiteralPath $authorityScript -PathType Leaf)) {
    throw "canonical source authority implementation is missing: $authorityScript"
  }
  $arguments = @(
    $authorityScript,
    "--run-directory", $OutputDirectory,
    "--workspace-root", $workspaceRoot
  )
  if ($Mode -eq "Reference") { $arguments += "--reference-only" }
  if ($Mode -eq "Source") { $arguments += "--source-only" }
  $output = @(& node @arguments 2>&1 | ForEach-Object { [string]$_ })
  $exitCode = $LASTEXITCODE
  $text = ($output -join "`n").Trim()
  if ($exitCode -ne 0) {
    throw "canonical source authority failed ($Mode, exit=$exitCode): $text"
  }
  try {
    $result = $text | ConvertFrom-Json
  } catch {
    throw "canonical source authority returned invalid JSON ($Mode): $($_.Exception.Message)"
  }
  if (-not $result -or $result.passed -ne $true -or $result.remoteProviderCalls -ne 0 -or $result.externalAudioSeconds -ne 0) {
    throw "canonical source authority did not return an exact zero-provider PASS ($Mode)"
  }
  return $result
}

function Get-CanonicalSourceMediaReference {
  param([string]$OutputDirectory, [string]$MediaPath)
  $resultPath = Join-Path $OutputDirectory "source-media-transcript.json"
  $canonicalMediaPath = Join-Path $workspaceRoot "scripts/testing/fixtures/watch-mode-en-original.wav"
  try {
    $resolvedMediaPath = (Resolve-Path -LiteralPath $MediaPath -ErrorAction Stop).Path
    $resolvedCanonicalPath = (Resolve-Path -LiteralPath $canonicalMediaPath -ErrorAction Stop).Path
    if (-not $resolvedMediaPath.Equals($resolvedCanonicalPath, [StringComparison]::OrdinalIgnoreCase)) {
      throw "strict paid authority requires canonical media: $resolvedCanonicalPath"
    }
    # This reconstructs the injector's complete 16 kHz mono PCM from the
    # canonical RIFF/WAVE bytes and compares it byte-for-byte before a passed
    # source authority can be written. It also binds the checksum, metadata,
    # and exact UTF-8 fixture texts without any Provider call.
    $validated = Invoke-CanonicalSourceAuthorityNode $OutputDirectory "Reference"
    $result = [pscustomobject]@{
      schemaVersion = 2
      authorityMode = "canonical-fixture-local-v2"
      passed = $true
      remoteProviderCalls = 0
      externalAudioSeconds = 0
      mediaPath = [string]$validated.media.path
      mediaSha256 = [string]$validated.media.sha256
      mediaBytes = [long]$validated.media.bytes
      checksumPath = [string]$validated.checksum.path
      metadataPath = [string]$validated.metadata.path
      playbackSeconds = $null
      fullMedia = $true
      source = [string]$validated.source
      translation = [string]$validated.translation
      sourceText = $validated.sourceText
      translationText = $validated.translationText
      referencePcm = $validated.referencePcm
      fixture = $validated.fixture
    }
  } catch {
    $result = [pscustomobject]@{
      schemaVersion = 2
      authorityMode = "canonical-fixture-local-v2"
      passed = $false
      remoteProviderCalls = 0
      externalAudioSeconds = 0
      error = $_.Exception.Message
    }
  }
  # Windows PowerShell 5.1's ConvertTo-Json can recurse pathologically through
  # long strings at unnecessarily high depths. This schema is only two nested
  # object levels deep, so four is both complete and bounded.
  $json = $result | ConvertTo-Json -Depth 4
  [System.IO.File]::WriteAllText($resultPath, $json, [System.Text.UTF8Encoding]::new($false))
  return $result
}

function Read-TranslatedCuePlaybackAuthority {
  param([string]$OutputDirectory, [string]$AppLogPath, [string]$RunMarker)
  $watchReportPath = Join-Path $OutputDirectory "watch-session-report.json"
  if (-not (Test-Path -LiteralPath $watchReportPath -PathType Leaf)) {
    return [pscustomobject]@{ passed = $false; error = "watch-session-report.json is missing" }
  }
  $watchReport = Get-Content -LiteralPath $watchReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $completeCues = @($watchReport.cues | Where-Object {
    $_.comparisonStatus -in @("exact", "formatting-only") -and
    -not [string]::IsNullOrWhiteSpace([string]$_.llmText) -and
    -not [string]::IsNullOrWhiteSpace([string]$_.publishedText) -and
    -not [string]::IsNullOrWhiteSpace([string]$_.renderedText)
  })
  $raw = if (Test-Path -LiteralPath $AppLogPath -PathType Leaf) {
    Get-LogTextAfterMarker $AppLogPath $RunMarker
  } else {
    ""
  }
  $events = @()
  $eventIndex = 0
  foreach ($line in ($raw -split "`r?`n")) {
    if ($line -notmatch 'event=translation_playback_status') { continue }
    $cueMatch = [regex]::Match($line, '\bcueId=([A-Za-z0-9._:-]+)')
    $statusMatch = [regex]::Match($line, '\bstatus=(queued|started|completed)\b')
    if (-not $cueMatch.Success -or -not $statusMatch.Success) { continue }
    $eventIndex += 1
    $events += [pscustomobject]@{
      cueId = $cueMatch.Groups[1].Value
      status = $statusMatch.Groups[1].Value
      eventIndex = $eventIndex
    }
  }
  $matched = @()
  $invalid = @()
  $completeCueIds = @($completeCues | ForEach-Object { [string]$_.cueId } | Select-Object -Unique)
  foreach ($cueId in $completeCueIds) {
    $cueEvents = @($events | Where-Object { $_.cueId -eq $cueId })
    $queuedEvents = @($cueEvents | Where-Object { $_.status -eq "queued" })
    $startedEvents = @($cueEvents | Where-Object { $_.status -eq "started" })
    $completedEvents = @($cueEvents | Where-Object { $_.status -eq "completed" })
    $exactlyOnce = (
      $queuedEvents.Count -eq 1 -and
      $startedEvents.Count -eq 1 -and
      $completedEvents.Count -eq 1
    )
    $ordered = (
      $exactlyOnce -and
      $queuedEvents[0].eventIndex -lt $startedEvents[0].eventIndex -and
      $startedEvents[0].eventIndex -lt $completedEvents[0].eventIndex
    )
    if ($exactlyOnce -and $ordered) {
      $matched += $cueId
    } else {
      $invalid += [pscustomobject]@{
        cueId = $cueId
        queuedCount = $queuedEvents.Count
        startedCount = $startedEvents.Count
        completedCount = $completedEvents.Count
        ordered = $ordered
      }
    }
  }
  $devicePath = Join-Path $OutputDirectory "physical-playback-device.json"
  $device = if (Test-Path -LiteralPath $devicePath -PathType Leaf) {
    Get-Content -LiteralPath $devicePath -Raw -Encoding UTF8 | ConvertFrom-Json
  } else {
    $null
  }
  return [pscustomobject]@{
    passed = ($completeCueIds.Count -gt 0 -and $matched.Count -eq $completeCueIds.Count -and $invalid.Count -eq 0 -and $device -and $device.verified)
    completeCueCount = $completeCueIds.Count
    queuedCueCount = @($events | Where-Object { $_.status -eq "queued" } | Select-Object -ExpandProperty cueId -Unique).Count
    startedCueCount = @($events | Where-Object { $_.status -eq "started" } | Select-Object -ExpandProperty cueId -Unique).Count
    completedCueCount = @($events | Where-Object { $_.status -eq "completed" } | Select-Object -ExpandProperty cueId -Unique).Count
    matchedCueIds = @($matched)
    matchedCueCount = $matched.Count
    invalidCues = @($invalid)
    resolvedPhysicalDeviceId = if ($device) { [string]$device.resolvedDeviceId } else { $null }
    resolvedPhysicalDeviceName = if ($device) { [string]$device.resolvedDeviceName } else { $null }
    deviceVerified = if ($device) { [bool]$device.verified } else { $false }
    detail = if ($completeCueIds.Count -eq 0) { "no fully published/rendered native cue was available" } elseif ($invalid.Count -gt 0) { "every complete native cue must have exactly one ordered queued, started, and completed physical playback event" } elseif (-not $device -or -not $device.verified) { "physical playback endpoint authority is missing or unverified" } else { $null }
  }
}

function Get-TranslatedPcmLoopbackAuthority {
  param([string]$OutputDirectory, $Recording, $PlaybackAuthority)
  $matcherPath = Join-Path $workspaceRoot "scripts/testing/watch-mode-translated-pcm-loopback.mjs"
  $leasePath = Join-Path $OutputDirectory "provider-input-budget-lease.json"
  if (-not (Test-Path -LiteralPath $leasePath -PathType Leaf)) {
    return [pscustomobject]@{ passed = $false; authorityMode = "translated-pcm-loopback-correlation-v1"; error = "provider input budget lease is missing" }
  }
  $lease = Get-Content -LiteralPath $leasePath -Raw -Encoding UTF8 | ConvertFrom-Json
  $protocol = if ($WatchRealtimeProtocol) {
    $WatchRealtimeProtocol
  } elseif ($WatchModelId -eq "qwen3.5-livetranslate-flash-realtime") {
    "dashscope-livetranslate"
  } else {
    "dashscope-omni"
  }
  $arguments = @(
    $matcherPath,
    "--run-directory", $OutputDirectory,
    "--app-log", $AppLogPath,
    "--run-marker", $RunMarker,
    "--recording-started-at-ms", ([string]$Recording.recordingStartedAtEpochMs),
    "--cell-id", $MatrixCellId,
    "--lease-id", ([string]$lease.leaseId),
    "--model-id", $WatchModelId,
    "--protocol", $protocol
  )
  $stdoutPath = Join-Path $OutputDirectory "translated-pcm-loopback.stdout.json"
  $stderrPath = Join-Path $OutputDirectory "translated-pcm-loopback.stderr.log"
  $process = Start-Process -FilePath "node" -ArgumentList $arguments -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden -Wait -PassThru
  if (-not (Test-Path -LiteralPath $stdoutPath -PathType Leaf)) {
    return [pscustomobject]@{ passed = $false; authorityMode = "translated-pcm-loopback-correlation-v1"; error = "translated PCM matcher returned no JSON"; exitCode = $process.ExitCode }
  }
  try {
    $authority = Get-Content -LiteralPath $stdoutPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    return [pscustomobject]@{ passed = $false; authorityMode = "translated-pcm-loopback-correlation-v1"; error = "translated PCM matcher JSON is invalid: $($_.Exception.Message)"; exitCode = $process.ExitCode }
  }
  if ($process.ExitCode -ne 0 -and $authority.passed) {
    $authority.passed = $false
    $authority | Add-Member -NotePropertyName error -NotePropertyValue "translated PCM matcher exited with $($process.ExitCode)" -Force
  }
  return $authority
}

function Get-LocalPhysicalOutputContentAuthority {
  param([string]$OutputDirectory, $Recording, [string]$AppLogPath, [string]$RunMarker, $SourceReferenceTranscript)
  $resultPath = Join-Path $OutputDirectory "physical-output-content.json"
  $pcmPath = [string]$Recording.transcriptionPcmPath
  if (-not (Test-Path -LiteralPath $pcmPath -PathType Leaf)) {
    [pscustomobject]@{
      schemaVersion = 1
      authorityMode = "local-pcm-cue-playback-v1"
      passed = $false
      remoteProviderCalls = 0
      error = "physical output PCM file was not created"
      recording = $Recording
    } | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $resultPath -Encoding UTF8
    return Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
  }
  $sourceWindowSeconds = if ($PlaybackSeconds -gt 0) {
    [Math]::Max(8, $PlaybackSeconds + 8)
  } elseif ($Recording -and $Recording.audioQuality -and $Recording.audioQuality.durationSeconds) {
    [Math]::Max(8, [Math]::Min([double]$Recording.audioQuality.durationSeconds, 90))
  } else {
    90
  }
  $sourceWindow = Copy-PcmWindow $pcmPath (Join-Path $OutputDirectory "physical-output-recording-source-window-16k-mono.pcm") 16000 $sourceWindowSeconds
  $canonicalSourceAndPhysical = if ($sourceWindow) {
    try {
      Invoke-CanonicalSourceAuthorityNode $OutputDirectory "Combined"
    } catch {
      [pscustomobject]@{ passed = $false; error = $_.Exception.Message }
    }
  } else {
    [pscustomobject]@{ passed = $false; error = "physical output source window was not created" }
  }
  $originalSimilarity = if ($canonicalSourceAndPhysical.passed -and $canonicalSourceAndPhysical.physicalSourceWaveform) {
    $canonicalSourceAndPhysical.physicalSourceWaveform
  } else {
    [pscustomobject]@{ passed = $false; error = [string]$canonicalSourceAndPhysical.error }
  }
  $segmentation = Read-SpeechSegmentationSummary $AppLogPath $RunMarker
  $subtitleQueue = Read-SubtitleQueueTimeline $AppLogPath $RunMarker
  $subtitleText = Get-RecentSubtitleText $AppLogPath $RunMarker
  $segmentTranslationText = Get-RecentFinalSegmentTranslationText $AppLogPath $RunMarker
  $structuredText = Get-UniqueClauseText @($subtitleText, $segmentTranslationText)
  $structuredComparison = if ($SourceReferenceTranscript -and $SourceReferenceTranscript.passed) {
    Compare-WatchModeTextPair ([string]$SourceReferenceTranscript.translation) $structuredText
  } else {
    [pscustomobject]@{ passed = $false; error = "canonical source authority did not pass" }
  }
  $playbackAuthority = Read-TranslatedCuePlaybackAuthority $OutputDirectory $AppLogPath $RunMarker
  $translatedAcousticAuthority = Get-TranslatedPcmLoopbackAuthority $OutputDirectory $Recording $playbackAuthority
  $translatedSpeechPassed = ($segmentation.playedSegments -gt 0 -and $playbackAuthority.passed -and $translatedAcousticAuthority.passed)
  $recordingAudible = ($Recording -and $Recording.rms -gt 0 -and $Recording.peak -gt 0)
  $contentConsistency = [pscustomobject]@{
    passed = [bool]$structuredComparison.passed
    coverage = $structuredComparison.coverage
    lengthRatio = $structuredComparison.lengthRatio
    referenceClauseCount = $structuredComparison.referenceClauseCount
    outputClauseCount = $structuredComparison.outputClauseCount
    missingClauses = @($structuredComparison.missingClauses)
    extraClauses = @($structuredComparison.extraClauses)
    referenceChars = $structuredComparison.referenceChars
    outputChars = $structuredComparison.outputChars
    physicalTranscript = $null
    physicalTranslation = $null
    structuredEvidence = $structuredComparison
    combinedEvidence = $structuredComparison
    evidenceMode = "canonical-target-text-plus-cue-playback-plus-loopback-pcm"
    warnings = @()
  }
  [pscustomobject]@{
    schemaVersion = 1
    authorityMode = "local-pcm-cue-playback-v1"
    passed = ($originalSimilarity.passed -and $recordingAudible -and $translatedSpeechPassed -and $structuredComparison.passed)
    remoteProviderCalls = 0
    externalAudioSeconds = 0
    source = ""
    translation = ""
    sourceReference = $SourceReferenceTranscript
    contentConsistency = $contentConsistency
    subtitleText = $subtitleText
    segmentTranslationText = $segmentTranslationText
    subtitleQueue = $subtitleQueue
    sttSourceWindow = $sourceWindow
    originalPassthrough = [pscustomobject]@{
      passed = [bool]$originalSimilarity.passed
      transcriptChars = 0
      authority = "canonical-source-signed-waveform-v1"
      sourceSimilarity = $originalSimilarity
    }
    translatedSpeech = [pscustomobject]@{
      passed = $translatedSpeechPassed
      playedSegments = $segmentation.playedSegments
      queuedSegments = $segmentation.queuedSegments
      transcriptChars = 0
      authority = "structured-cue-plus-physical-playback-lifecycle"
      playbackAuthority = $playbackAuthority
      acousticAuthority = $translatedAcousticAuthority
    }
    mixedOutput = [pscustomobject]@{
      passed = $recordingAudible
      rms = $Recording.rms
      peak = $Recording.peak
    }
    recording = $Recording
    audioQuality = $Recording.audioQuality
  } | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $resultPath -Encoding UTF8
  return Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Get-SourceMediaReferenceTranscript {
  param([string]$OutputDirectory, [string]$MediaPath)
  # Both paid authorities must remain self-contained: the Plus incident replay
  # has the same zero-auxiliary-provider-audio rule as the strict release
  # matrix, while retaining a separate signing and result authority.
  if ($StrictPaidAuthority -or $IncidentReplayAuthority) {
    return Get-CanonicalSourceMediaReference $OutputDirectory $MediaPath
  }
  $resultPath = Join-Path $OutputDirectory "source-media-transcript.json"
  if (-not (Test-Path -LiteralPath $MediaPath -PathType Leaf)) {
    [pscustomobject]@{ passed = $false; error = "source media file not found: $MediaPath" } | ConvertTo-Json -Depth 8 | Set-Content -Path $resultPath -Encoding UTF8
    return Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  }
  $apiKey = Get-PhysicalOutputSttApiKey
  if (-not $apiKey) {
    [pscustomobject]@{ passed = $false; error = "DASHSCOPE_API_KEY or OMNI_TEST_DASHSCOPE_API_KEY is required for source media STT" } | ConvertTo-Json -Depth 8 | Set-Content -Path $resultPath -Encoding UTF8
    return Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  }
  $resolvedMediaPath = (Resolve-Path -LiteralPath $MediaPath).Path
  $hash = (Get-FileHash -LiteralPath $resolvedMediaPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $cacheDir = Join-Path $workspaceRoot "artifacts/testing/watch-mode-live/cache/source-transcripts"
  New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
  $cacheLimitLabel = if ($PlaybackSeconds -gt 0) { "$PlaybackSeconds-limit" } else { "full" }
  $cachePath = Join-Path $cacheDir "$hash-$cacheLimitLabel-v2.json"
  if (Test-Path -LiteralPath $cachePath -PathType Leaf) {
    Copy-Item -LiteralPath $cachePath -Destination $resultPath -Force
    return Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
  }
  try {
    $exe = Build-OmniRealtimeDiagnostic $OutputDirectory
    $stdout = Join-Path $OutputDirectory "source-media-stt.stdout.log"
    $stderr = Join-Path $OutputDirectory "source-media-stt.stderr.log"
    $previous = $env:DASHSCOPE_API_KEY
    try {
      $env:DASHSCOPE_API_KEY = $apiKey
      # The live injector writes the authoritative 16 kHz mono reference next
      # to the run.  Passing a WAV file through the diagnostic's MP3 decoder
      # produces a plausible-looking PCM length but garbage audio, which in
      # turn makes the paid source-content gate report "no audio".  Reuse the
      # injector reference when present; only use the MP3 path for actual
      # compressed media.
      $referencePcmPath = Join-Path $OutputDirectory "source-media-reference-16k-mono.pcm"
      if (Test-Path -LiteralPath $referencePcmPath -PathType Leaf) {
        $args = @("--pcm", $referencePcmPath, "--manual")
      } elseif ([IO.Path]::GetExtension($resolvedMediaPath).ToLowerInvariant() -eq ".wav") {
        throw "WAV source reference PCM was not produced by the media injector: $referencePcmPath"
      } else {
        $args = @("--mp3", $resolvedMediaPath, "--manual")
      }
      if ($PlaybackSeconds -gt 0) {
        $args += @("--limit-seconds", "$PlaybackSeconds")
      }
      $exit = Invoke-NativeProcessToLog $exe $args $workspaceRoot $stdout $stderr 240
    } finally {
      $env:DASHSCOPE_API_KEY = $previous
    }
    $text = if (Test-Path -LiteralPath $stdout -PathType Leaf) { Get-Content -LiteralPath $stdout -Raw -Encoding UTF8 -ErrorAction SilentlyContinue } else { "" }
    $parsed = Parse-OmniRealtimeDiagnosticText $text
    $result = [pscustomobject]@{
      passed = ($exit -eq 0 -and ([string]$parsed.source).Trim().Length -gt 0)
      exitCode = $exit
      mediaPath = $resolvedMediaPath
      mediaSha256 = $hash
      playbackSeconds = if ($PlaybackSeconds -gt 0) { $PlaybackSeconds } else { $null }
      fullMedia = ($PlaybackSeconds -le 0)
      source = $parsed.source
      translation = $parsed.translation
      stdout = $stdout
      stderr = $stderr
    }
  } catch {
    $result = [pscustomobject]@{
      passed = $false
      error = $_.Exception.Message
      mediaPath = $resolvedMediaPath
      mediaSha256 = $hash
      playbackSeconds = if ($PlaybackSeconds -gt 0) { $PlaybackSeconds } else { $null }
      fullMedia = ($PlaybackSeconds -le 0)
    }
  }
  $result | ConvertTo-Json -Depth 12 | Set-Content -Path $resultPath -Encoding UTF8
  if ($result.passed) {
    Copy-Item -LiteralPath $resultPath -Destination $cachePath -Force
  }
  return Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Invoke-PhysicalOutputContentStt {
  param([string]$OutputDirectory, $Recording, [string]$AppLogPath, [string]$RunMarker, $SourceReferenceTranscript)
  $resultPath = Join-Path $OutputDirectory "physical-output-content.json"
  if (-not $Recording) {
    [pscustomobject]@{ passed = $false; error = "physical output recording did not run" } | ConvertTo-Json -Depth 8 | Set-Content -Path $resultPath -Encoding UTF8
    return Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  }
  if ($paidAuthorityEnabled) {
    return Get-LocalPhysicalOutputContentAuthority `
      $OutputDirectory `
      $Recording `
      $AppLogPath `
      $RunMarker `
      $SourceReferenceTranscript
  }
  if ($SkipPhysicalOutputContentStt) {
    [pscustomobject]@{
      skipped = $true
      reason = "SkipPhysicalOutputContentStt was provided"
      recording = $Recording
      subtitleText = Get-RecentSubtitleText $AppLogPath $RunMarker
    } | ConvertTo-Json -Depth 12 | Set-Content -Path $resultPath -Encoding UTF8
    return Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  }
  $pcmPath = [string]$Recording.transcriptionPcmPath
  if (-not (Test-Path -LiteralPath $pcmPath -PathType Leaf)) {
    [pscustomobject]@{
      passed = $false
      error = "physical output transcription PCM file was not created"
      recording = $Recording
      subtitleText = Get-RecentSubtitleText $AppLogPath $RunMarker
    } | ConvertTo-Json -Depth 12 | Set-Content -Path $resultPath -Encoding UTF8
    return Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  }
  $apiKey = Get-PhysicalOutputSttApiKey
  if (-not $apiKey) {
    [pscustomobject]@{
      passed = $false
      error = "DASHSCOPE_API_KEY or OMNI_TEST_DASHSCOPE_API_KEY is required for physical output content STT"
      recording = $Recording
      subtitleText = Get-RecentSubtitleText $AppLogPath $RunMarker
    } | ConvertTo-Json -Depth 12 | Set-Content -Path $resultPath -Encoding UTF8
    return Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  }
  try {
    $exe = Build-OmniRealtimeDiagnostic $OutputDirectory
  } catch {
    [pscustomobject]@{
      passed = $false
      error = $_.Exception.Message
      recording = $Recording
      subtitleText = Get-RecentSubtitleText $AppLogPath $RunMarker
    } | ConvertTo-Json -Depth 12 | Set-Content -Path $resultPath -Encoding UTF8
    return Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  }
  $stdout = Join-Path $OutputDirectory "physical-output-stt.stdout.log"
  $stderr = Join-Path $OutputDirectory "physical-output-stt.stderr.log"
  $sourceWindowSeconds = if ($PlaybackSeconds -gt 0) {
    [Math]::Max(8, $PlaybackSeconds + 8)
  } elseif ($Recording -and $Recording.audioQuality -and $Recording.audioQuality.durationSeconds) {
    [Math]::Max(8, [Math]::Min([double]$Recording.audioQuality.durationSeconds, 90))
  } else {
    90
  }
  $sourceWindow = Copy-PcmWindow $pcmPath (Join-Path $OutputDirectory "physical-output-recording-source-window-16k-mono.pcm") 16000 $sourceWindowSeconds
  $sourceReferencePcmPath = Join-Path $OutputDirectory "source-media-reference-16k-mono.pcm"
  $originalSimilarity = if ($sourceWindow) {
    Measure-PcmReferenceSimilarity $sourceReferencePcmPath ([string]$sourceWindow.path) 16000
  } else {
    [pscustomobject]@{
      passed = $false
      error = "physical output source window was not created"
      referencePcmPath = $sourceReferencePcmPath
      recordedPcmPath = $null
    }
  }
  $sttPcmPath = if ($sourceWindow) { [string]$sourceWindow.path } else { $pcmPath }
  $previous = $env:DASHSCOPE_API_KEY
  try {
    $env:DASHSCOPE_API_KEY = $apiKey
    $exit = Invoke-NativeProcessToLog $exe @("--pcm", $sttPcmPath, "--manual") $workspaceRoot $stdout $stderr 240
  } finally {
    $env:DASHSCOPE_API_KEY = $previous
  }
  $text = if (Test-Path -LiteralPath $stdout -PathType Leaf) { Get-Content -LiteralPath $stdout -Raw -Encoding UTF8 -ErrorAction SilentlyContinue } else { "" }
  $parsed = Parse-OmniRealtimeDiagnosticText $text
  $source = $parsed.source
  $translation = $parsed.translation
  $segmentation = Read-SpeechSegmentationSummary $AppLogPath $RunMarker
  $subtitleQueue = Read-SubtitleQueueTimeline $AppLogPath $RunMarker
  $subtitleText = Get-RecentSubtitleText $AppLogPath $RunMarker
  $segmentTranslationText = Get-RecentFinalSegmentTranslationText $AppLogPath $RunMarker
  $originalPassed = ($exit -eq 0 -and $source.Trim().Length -gt 0)
  $translatedSpeechPassed = ($segmentation.playedSegments -gt 0)
  $contentConsistency = if ($SourceReferenceTranscript -and $SourceReferenceTranscript.passed) {
    Compare-WatchModeContent $SourceReferenceTranscript $source $translation (Get-UniqueClauseText @($subtitleText, $segmentTranslationText))
  } else {
    [pscustomobject]@{
      passed = $false
      error = if ($SourceReferenceTranscript) { $SourceReferenceTranscript.error } else { "source media reference transcript was not collected" }
    }
  }
  [pscustomobject]@{
    passed = ($originalPassed -and $translatedSpeechPassed -and $contentConsistency.passed)
    exitCode = $exit
    source = $source
    translation = $translation
    sourceReference = $SourceReferenceTranscript
    contentConsistency = $contentConsistency
    subtitleText = $subtitleText
    segmentTranslationText = $segmentTranslationText
    subtitleQueue = $subtitleQueue
    sttSourceWindow = $sourceWindow
    originalPassthrough = [pscustomobject]@{
      passed = ($originalPassed -and $originalSimilarity.passed)
      transcriptChars = $source.Trim().Length
      sourceSimilarity = $originalSimilarity
    }
    translatedSpeech = [pscustomobject]@{
      passed = $translatedSpeechPassed
      playedSegments = $segmentation.playedSegments
      queuedSegments = $segmentation.queuedSegments
      transcriptChars = $translation.Trim().Length
    }
    mixedOutput = [pscustomobject]@{
      passed = ($Recording -and $Recording.rms -gt 0 -and $originalPassed)
      rms = $Recording.rms
      peak = $Recording.peak
    }
    recording = $Recording
    audioQuality = $Recording.audioQuality
    stdout = $stdout
    stderr = $stderr
  } | ConvertTo-Json -Depth 12 | Set-Content -Path $resultPath -Encoding UTF8
  return Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
}

function Read-RecentProviderSummary {
  param([string]$AppLog, [string]$RunMarker)
  if (-not (Test-Path -LiteralPath $AppLog -PathType Leaf)) {
    return [pscustomobject]@{
      totalCalls = $null
      failedCalls = $null
      error = "app.log not found"
    }
  }
  $raw = Get-LogTextAfterMarker $AppLog $RunMarker
  $lines = $raw -split "`r?`n"
  $providerLines = @($lines | Where-Object { $_ -match 'model_trace|provider|dashscope|openai|omni' })
  # Keep this aligned with watch-mode-report.mjs providerErrorLines and
  # hardProviderError semantics. A credential lifecycle line is evidence only
  # when it is paired with a failure marker; successful vault reads such as
  # `outcome=ok` and `CredReadW succeeded` are normal provider setup traffic.
  $providerSuccessPattern = '\boutcome=ok\b|\bstatus[=:]succeeded\b|\bsuccess(?:ful(?:ly)?)?\b'
  $providerFailurePattern = '\b(?:status|httpStatus|code)=(?:401|403|429)\b|\bHTTP\s+(?:401|403|429)\b|"status"\s*:\s*"failed"|"error"\s*:\s*(?!"?null\b|null\b)[{\["0-9tfa-zA-Z_-]|unauthori[sz]ed|forbidden|invalid api key|(?:credential|\bauth(?:orization|entication)?\b).{0,80}(?:failed|error|missing|invalid|denied)|(?:failed|error|missing|invalid|denied).{0,80}(?:credential|\bauth(?:orization|entication)?\b)|rate limit|quota|insufficient|billing|\btimeout\b|timed out|ECONNRESET|ENOTFOUND|network error|websocket.*(?:failed|closed)|model_trace failed|provider.*failed'
  $failedLines = @($providerLines | Where-Object {
    $_ -notmatch $providerSuccessPattern -and $_ -match $providerFailurePattern
  })
  return [pscustomobject]@{
    totalCalls = $providerLines.Count
    failedCalls = $failedLines.Count
    error = $null
  }
}

function Read-WatchModeTranslationRoute {
  param([string]$AppLog, [string]$RunMarker)
  if (-not (Test-Path -LiteralPath $AppLog -PathType Leaf)) {
    return "native"
  }
  $text = Get-LogTextAfterMarker $AppLog $RunMarker
  $match = [regex]::Matches($text, "subtitleTranslationMode=(native|secondary)") | Select-Object -Last 1
  if ($match) {
    return $match.Groups[1].Value
  }
  if ($text -match "speech\.segment_tts_queued|speech\.segment_playback_written|speech\.bridge-playback-queued|event=translation_playback_status") {
    return "secondary"
  }
  return "native"
}

function Read-SpeechSegmentationSummary {
  param([string]$AppLog, [string]$RunMarker)
  if (-not (Test-Path -LiteralPath $AppLog -PathType Leaf)) {
    return [pscustomobject]@{
      queuedSegments = 0
      playedSegments = 0
      maxSourceChars = 0
      maxTranslatedChars = 0
    }
  }
  $text = Get-LogTextAfterMarker $AppLog $RunMarker
  $queuedLocal = [regex]::Matches($text, "speech\.segment_tts_queued[^\r\n]*")
  # Native Omni audio is submitted directly to the Bridge and therefore never
  # emits the secondary-TTS queue marker. Count the Bridge's stable cue status
  # so native and secondary routes expose the same evidence shape.
  $queuedBridge = [regex]::Matches($text, "event=translation_playback_status[^\r\n]*\bstatus=queued\b[^\r\n]*\breason=accepted\b")
  # Bridge-owned playback intentionally skips the local WASAPI writer event.
  # A long native response can legitimately still be playing when the bounded
  # paid provider window closes. `started` proves that the physical sink
  # accepted and began rendering the cue; the simultaneous loopback recording
  # and STT content checks below prove that translated audio was actually
  # audible. Requiring `completed` here made the evidence depend on TTS length
  # and silently extended the paid-session budget.
  $playedLocal = [regex]::Matches($text, "speech\.segment_playback_written[^\r\n]*")
  $playedBridge = [regex]::Matches($text, "event=translation_playback_status[^\r\n]*\bstatus=started\b[^\r\n]*\breason=physical-playback(?:-stream)?-started\b")
  $maxSource = 0
  $maxTranslated = 0
  foreach ($item in $queuedLocal) {
    $sourceMatch = [regex]::Match($item.Value, "sourceChars=(\d+)")
    if ($sourceMatch.Success) { $maxSource = [Math]::Max($maxSource, [int]$sourceMatch.Groups[1].Value) }
    $translatedMatch = [regex]::Match($item.Value, "translatedChars=(\d+)")
    if ($translatedMatch.Success) { $maxTranslated = [Math]::Max($maxTranslated, [int]$translatedMatch.Groups[1].Value) }
  }
  return [pscustomobject]@{
    queuedSegments = $queuedLocal.Count + $queuedBridge.Count
    playedSegments = $playedLocal.Count + $playedBridge.Count
    maxSourceChars = $maxSource
    maxTranslatedChars = $maxTranslated
  }
}

function Build-SnapshotsFile {
  param(
    [string]$OutputDirectory,
    $DriverProbe,
    [string]$AppLogPath,
    [string]$BridgeLogPath,
    [string]$RunMarker,
    [string]$StartedAtLocal,
    $Playback
  )
  $driver = if ($DriverProbe.ok) { $DriverProbe.result } else { [pscustomobject]@{ error = $DriverProbe.error } }
  $bridgeProbePath = Join-Path $OutputDirectory "bridge-source-probe.json"
  $bridgeProbe = if (Test-Path -LiteralPath $bridgeProbePath -PathType Leaf) {
    Get-Content -LiteralPath $bridgeProbePath -Raw | ConvertFrom-Json
  } else {
    $null
  }
  $bridge = [pscustomobject]@{}
  if (Test-Path -LiteralPath $BridgeLogPath -PathType Leaf) {
    if ($bridgeProbe -and $bridgeProbe.state -and ($bridgeProbe.sourceFrame -or $FeedbackLoopPrevention -eq "process-exclusion")) {
      $bridge = [pscustomobject]@{
        probePassed = $bridgeProbe.passed -ne $false
        bridgeState = $bridgeProbe.state.bridgeState
        driverHealth = $bridgeProbe.state.driverHealth
        sourceCaptureMode = $bridgeProbe.state.sourceCaptureMode
        captureBackend = $bridgeProbe.state.captureBackend
        processLoopbackSupported = $bridgeProbe.state.processLoopbackSupported
        processLoopbackStatus = $bridgeProbe.state.processLoopbackStatus
        windowsBuildNumber = $bridgeProbe.state.windowsBuildNumber
        processLoopbackMinimumWindowsBuild = $bridgeProbe.state.processLoopbackMinimumWindowsBuild
        excludedProcessId = $bridgeProbe.state.excludedProcessId
        processLoopbackFailureDetail = $bridgeProbe.state.processLoopbackFailureDetail
        sourceSubscriberActive = $bridgeProbe.state.sourceSubscriberActive
        sourceReadCalls = $bridgeProbe.state.sourceReadCalls
        droppedFrameCount = $bridgeProbe.state.droppedFrameCount
        lastErrorCode = $bridgeProbe.state.lastErrorCode
        sourceFramePayloadBytes = if ($bridgeProbe.sourceFrame) { $bridgeProbe.sourceFrame.payloadBytes } else { 0 }
        pipeName = $bridgeProbe.pipeName
        sourcePipeName = $bridgeProbe.sourcePipeName
      }
    } elseif ($bridgeProbe) {
      $bridge = [pscustomobject]@{
        probePassed = $false
        error = $bridgeProbe.error
        phase = $bridgeProbe.phase
        stateQueryError = $bridgeProbe.stateQueryError
        init = $bridgeProbe.init
        state = $bridgeProbe.state
        pipeName = $bridgeProbe.pipeName
        sourcePipeName = $bridgeProbe.sourcePipeName
        stdout = $bridgeProbe.stdout
        stderr = $bridgeProbe.stderr
      }
    } else {
      $bridge = [pscustomobject]@{
        probePassed = $false
        error = "bridge-source-probe.json not found"
      }
    }
  }
  $physicalOutputProbePath = Join-Path $OutputDirectory "physical-output-probe.json"
  $physicalOutput = if (Test-Path -LiteralPath $physicalOutputProbePath -PathType Leaf) {
    Get-Content -LiteralPath $physicalOutputProbePath -Raw -Encoding UTF8 | ConvertFrom-Json
  } else {
    $null
  }
  $physicalOutputContentPath = Join-Path $OutputDirectory "physical-output-content.json"
  $physicalOutputContent = if (Test-Path -LiteralPath $physicalOutputContentPath -PathType Leaf) {
    Get-Content -LiteralPath $physicalOutputContentPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } else {
    $null
  }
  $deviceEvidencePath = Join-Path $OutputDirectory "physical-playback-device.json"
  $deviceEvidence = if (Test-Path -LiteralPath $deviceEvidencePath -PathType Leaf) {
    Get-Content -LiteralPath $deviceEvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json
  } else {
    $null
  }
  $watchSessionReportPath = Join-Path $OutputDirectory "watch-session-report.json"
  $watchSessionReport = if (Test-Path -LiteralPath $watchSessionReportPath -PathType Leaf) {
    Get-Content -LiteralPath $watchSessionReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } else {
    $null
  }
  $app = [pscustomobject]@{
    routeState = $null
    overlayVisible = $null
    subtitleCueCount = $null
    speechDispatchState = $null
    subtitleQueue = Read-SubtitleQueueTimeline $AppLogPath $RunMarker
  }
  $provider = Read-RecentProviderSummary $AppLogPath $RunMarker
  $translationRoute = Read-WatchModeTranslationRoute $AppLogPath $RunMarker
  $speechSegmentation = Read-SpeechSegmentationSummary $AppLogPath $RunMarker
  $snapshots = [pscustomobject]@{
    runMarker = $RunMarker
    startedAtLocal = $StartedAtLocal
    modelId = if ($WatchModelId) { $WatchModelId } else { $null }
    feedbackLoopPrevention = $FeedbackLoopPrevention
    deviceEvidence = $deviceEvidence
    translationRoute = $translationRoute
    driver = $driver
    wasapi = $driver
    bridge = $bridge
    app = $app
    provider = $provider
    physicalOutput = $physicalOutput
    physicalOutputContent = $physicalOutputContent
    speechSegmentation = $speechSegmentation
    watchSessionReport = $watchSessionReport
    playback = $Playback
    diagnosticsBundle = $null
  }
  $path = Join-Path $OutputDirectory "snapshots.json"
  $snapshots | ConvertTo-Json -Depth 12 | Set-Content -Path $path -Encoding UTF8
  return $path
}

function Save-WatchModeRunArtifacts {
  param(
    [string]$OutputDirectory,
    $DriverProbe,
    $PlaybackStep,
    $Steps,
    [string]$RunMarker,
    [string]$StartedAtLocal,
    [string]$FailureMessage = $null
  )
  $runtimePath = Resolve-Path -LiteralPath $RuntimeRoot -ErrorAction SilentlyContinue
  $appLogSource = if ($runtimePath) { Join-Path $runtimePath.Path "app.log" } else { Join-Path $RuntimeRoot "app.log" }
  $bridgeLogSource = if ($runtimePath) { Join-Path $runtimePath.Path "bridge-service.log" } else { Join-Path $RuntimeRoot "bridge-service.log" }
  $appLogTarget = Copy-IfExists $appLogSource (Join-Path $OutputDirectory "app.log")
  $bridgeLogTarget = Copy-IfExists $bridgeLogSource (Join-Path $OutputDirectory "bridge-service.log")
  if (-not $appLogTarget) {
    "" | Set-Content -Path (Join-Path $OutputDirectory "app.log") -Encoding UTF8
  }
  if (-not $bridgeLogTarget) {
    "" | Set-Content -Path (Join-Path $OutputDirectory "bridge-service.log") -Encoding UTF8
  }
  if ($FailureMessage) {
    [pscustomobject]@{
      message = $FailureMessage
      generatedAt = Get-Date -Format o
    } | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $OutputDirectory "failure.json") -Encoding UTF8
  }
  $effectiveDriverProbe = if ($DriverProbe) {
    $DriverProbe
  } else {
    [pscustomobject]@{ ok = $false; result = $null; error = "driver probe did not run" }
  }
  $playbackSnapshot = if ($PlaybackStep -and $PlaybackStep.ok) { $PlaybackStep.result } else { $null }
  if ($playbackSnapshot) {
    $playbackSnapshot | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path $OutputDirectory "playback.json") -Encoding UTF8
  }
  $physicalContentStep = @($Steps | Where-Object {
    $_.name -eq "transcribe and compare physical output content"
  } | Select-Object -Last 1)
  if (
    $FeedbackLoopPrevention -ne "echo-cancel" -and
    $physicalContentStep -and
    $physicalContentStep.result -and
    $physicalContentStep.result.skipped
  ) {
    $physicalContentStep.result | ConvertTo-Json -Depth 12 | Set-Content `
      -Path (Join-Path $OutputDirectory "physical-output-content.json") -Encoding UTF8
  }
  Build-SnapshotsFile $OutputDirectory $effectiveDriverProbe (Join-Path $OutputDirectory "app.log") (Join-Path $OutputDirectory "bridge-service.log") $RunMarker $StartedAtLocal $playbackSnapshot | Out-Null
  $serializableSteps = if ($null -eq $Steps) { @() } else { @($Steps) }
  ConvertTo-Json -InputObject $serializableSteps -Depth 8 | Set-Content -Path (Join-Path $OutputDirectory "steps.json") -Encoding UTF8
  Invoke-ReportGenerator $OutputDirectory "live"
}

function Write-StrictPaidCellBudget {
  param([string]$OutputDirectory, [string]$AppLogPath, [string]$RunMarker)
  $budgetScript = Join-Path $workspaceRoot "scripts/testing/watch-mode-external-provider-budget.mjs"
  $arguments = @(
    $budgetScript,
    "--run-directory", $OutputDirectory,
    "--app-log", $AppLogPath,
    "--run-marker", $RunMarker,
    "--cell-id", $MatrixCellId,
    "--model-id", $WatchModelId,
    "--feedback-mode", $FeedbackLoopPrevention,
    "--translation-mode", $SubtitleTranslationMode,
    "--session-ceiling-seconds", "$WatchAutoStopAfterSeconds",
    "--authority-mode", $providerAuthorityMode
  )
  $output = @(& node @arguments 2>&1 | ForEach-Object { "$_" })
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "strict paid-cell provider budget failed before matrix continuation: $($output -join ' ')"
  }
  $budgetPath = Join-Path $OutputDirectory "external-provider-budget.json"
  if (-not (Test-Path -LiteralPath $budgetPath -PathType Leaf)) {
    throw "strict paid-cell provider budget did not create $budgetPath"
  }
  $ledger = Get-Content -LiteralPath $budgetPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $ledger.passed) {
    throw "strict paid-cell provider budget did not pass"
  }
  return $ledger
}

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $workspaceRoot

if ($paidAuthorityEnabled) {
  if ($DryRun) { throw "$providerAuthorityMode authority is only valid for a live paid cell" }
  if ($RecoverPhysicalOutputContentRunDirectory) { throw "$providerAuthorityMode authority forbids paid physical-output STT recovery" }
  $approvedAuthorityModels = if ($StrictPaidAuthority) {
    @("qwen3.5-omni-flash-realtime", "qwen3.5-livetranslate-flash-realtime")
  } else {
    @("qwen3.5-omni-plus-realtime")
  }
  if ($WatchModelId -notin $approvedAuthorityModels) {
    throw "$providerAuthorityMode allows only its signed Watch models; got '$WatchModelId'"
  }
  if ([string]::IsNullOrWhiteSpace($MatrixCellId)) {
    throw "$providerAuthorityMode requires MatrixCellId before provider launch"
  }
  if ([string]::IsNullOrWhiteSpace($env:OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID)) {
    throw "$providerAuthorityMode requires a coordinator-issued OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID before provider launch"
  }
  if ($SubtitleTranslationMode -ne "native") {
    throw "$providerAuthorityMode forbids secondary translation/TTS; SubtitleTranslationMode must be native"
  }
  if ($WatchAutoStopAfterSeconds -ne 180) {
    throw "$providerAuthorityMode requires a 180-second provider session ceiling; got $WatchAutoStopAfterSeconds"
  }
  if ($PlaybackSeconds -ne 0) {
    throw "$providerAuthorityMode requires complete canonical media playback; PlaybackSeconds must be 0"
  }
  if ($SkipPhysicalOutputContentStt) {
    throw "$providerAuthorityMode does not permit skipping local physical-output authority"
  }
  $strictCanonicalMedia = (Resolve-Path -LiteralPath (Join-Path $workspaceRoot "scripts/testing/fixtures/watch-mode-en-original.wav") -ErrorAction Stop).Path
  $strictRequestedMedia = (Resolve-Path -LiteralPath $MediaPath -ErrorAction Stop).Path
  if (-not $strictRequestedMedia.Equals($strictCanonicalMedia, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$providerAuthorityMode requires canonical media: $strictCanonicalMedia"
  }
  $strictDeclaredHash = ((Get-Content -LiteralPath (Join-Path $workspaceRoot "scripts/testing/fixtures/watch-mode-en-original.sha256") -Raw -Encoding UTF8).Trim() -split '\s+')[0].ToLowerInvariant()
  $strictActualHash = (Get-FileHash -LiteralPath $strictRequestedMedia -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($strictActualHash -ne $strictDeclaredHash) {
    throw "$providerAuthorityMode canonical media checksum mismatch before provider launch"
  }
}

if ($RecoverPhysicalOutputContentRunDirectory) {
  $recoveryDirectory = (Resolve-Path -LiteralPath $RecoverPhysicalOutputContentRunDirectory -ErrorAction Stop).Path
  $recordingPath = Join-Path $recoveryDirectory "physical-output-recording.json"
  $sourceTranscriptPath = Join-Path $recoveryDirectory "source-media-transcript.json"
  $appLogPath = Join-Path $recoveryDirectory "app.log"
  foreach ($requiredPath in @($recordingPath, $sourceTranscriptPath, $appLogPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      throw "physical-output recovery artifact is missing: $requiredPath"
    }
  }
  $markerMatches = [regex]::Matches(
    (Get-Content -LiteralPath $appLogPath -Raw -Encoding UTF8),
    'watch_mode_diagnostic\.run_id=[0-9a-fA-F]{32}'
  )
  if ($markerMatches.Count -eq 0) {
    throw "physical-output recovery app.log has no Watch run marker: $appLogPath"
  }
  $recoveryMarker = $markerMatches[$markerMatches.Count - 1].Value
  $recording = Get-Content -LiteralPath $recordingPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $sourceTranscript = Get-Content -LiteralPath $sourceTranscriptPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($ReuseExistingPhysicalOutputStt) {
    $contentPath = Join-Path $recoveryDirectory "physical-output-content.json"
    if (-not (Test-Path -LiteralPath $contentPath -PathType Leaf)) {
      throw "existing physical-output STT result is missing: $contentPath"
    }
    $result = Get-Content -LiteralPath $contentPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $segmentation = Read-SpeechSegmentationSummary $appLogPath $recoveryMarker
    $contentConsistency = Compare-WatchModeContent `
      $sourceTranscript `
      ([string]$result.source) `
      ([string]$result.translation) `
      (Get-UniqueClauseText @([string]$result.subtitleText, [string]$result.segmentTranslationText))
    $translatedSpeechPassed = ($segmentation.playedSegments -gt 0)
    $result.contentConsistency = $contentConsistency
    $result.translatedSpeech.passed = $translatedSpeechPassed
    $result.translatedSpeech.playedSegments = $segmentation.playedSegments
    $result.translatedSpeech.queuedSegments = $segmentation.queuedSegments
    $result.passed = ([bool]$result.originalPassthrough.passed -and $translatedSpeechPassed -and $contentConsistency.passed)
    $result | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $contentPath -Encoding UTF8
  } else {
    $result = Invoke-PhysicalOutputContentStt `
      $recoveryDirectory `
      $recording `
      $appLogPath `
      $recoveryMarker `
      $sourceTranscript
  }
  [ordered]@{
    schemaVersion = 1
    recoveredAt = Get-Date -Format o
    runDirectory = $recoveryDirectory
    runMarker = $recoveryMarker
    replayedWatchSession = $false
    replayedPhysicalOutput = $false
    invokedPhysicalOutputStt = (-not $ReuseExistingPhysicalOutputStt)
    reusedExistingPhysicalOutputStt = [bool]$ReuseExistingPhysicalOutputStt
    resultPassed = [bool]$result.passed
  } | ConvertTo-Json -Depth 6 | Set-Content `
    -LiteralPath (Join-Path $recoveryDirectory "physical-output-content-recovery.json") `
    -Encoding UTF8
  Invoke-ReportGenerator $recoveryDirectory "live"
  Write-Output $recoveryDirectory
  exit $(if ($result.passed) { 0 } else { 1 })
}

$outputDir = New-WatchModeOutputDirectory $OutputRoot
$runMarker = "watch_mode_diagnostic.run_id=$([System.Guid]::NewGuid().ToString('N'))"
$startedAtLocal = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

if ($DryRun) {
  $injectionVariants = @()
  $defaultConfigPath = Join-Path $workspaceRoot "apps/desktop/src-tauri/defaults/app-config.default.json"
  foreach ($mode in @("process-exclusion", "virtual-driver", "echo-cancel")) {
    $probeConfig = Get-Content -LiteralPath $defaultConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Set-WatchModelOnConfig $probeConfig $WatchModelId $WatchRealtimeProtocol $paidAuthorityEnabled
    Set-WatchModeSecondaryConfig $probeConfig $SubtitleTranslationModelId $InboundSecondaryAudioModelId $mode $SubtitleTranslationMode
    $injected = $probeConfig.devices.feedbackLoopPrevention
    if ($injected -ne $mode) {
      throw "dry-run feedback config injection mismatch: requested=$mode injected=$injected"
    }
    $injectionVariants += [ordered]@{
      requested = $mode
      injected = $injected
      outputSpeechEnabled = $probeConfig.devices.outputSpeechEnabled
      monitorMode = $probeConfig.devices.inboundRoute.mixControl.monitorMode
    }
  }
  [ordered]@{
    generatedAt = Get-Date -Format o
    selectedFeedbackLoopPrevention = $FeedbackLoopPrevention
    variants = $injectionVariants
  } | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $outputDir "config-injection.json") -Encoding UTF8
  Write-Host "==> dry-run feedback config injection verified: process-exclusion, virtual-driver, echo-cancel (selected=$FeedbackLoopPrevention)"
  $resolvedFixtureRoot = if ([System.IO.Path]::IsPathRooted($FixtureRoot)) {
    [System.IO.Path]::GetFullPath($FixtureRoot)
  } else {
    [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot $FixtureRoot))
  }
  $fixtureDir = Join-Path $resolvedFixtureRoot $Fixture
  $requiredFixtureFiles = @("snapshots.json", "steps.json", "app.log", "bridge-service.log")
  $missingFixtureFiles = @($requiredFixtureFiles | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $fixtureDir $_) -PathType Leaf)
  })
  if ($Fixture -eq "pass" -and $missingFixtureFiles.Count -gt 0) {
    Write-Host "==> generating built-in Watch Mode dry-run fixture: $fixtureDir"
    node ./scripts/testing/generate-watch-mode-live-fixtures.mjs --root $resolvedFixtureRoot --fixture pass
    if ($LASTEXITCODE -ne 0) {
      throw "Watch-mode fixture generation failed with exit code $LASTEXITCODE. Run 'npm run generate:watch-mode-live-fixtures' for diagnostics."
    }
    $missingFixtureFiles = @($requiredFixtureFiles | Where-Object {
      -not (Test-Path -LiteralPath (Join-Path $fixtureDir $_) -PathType Leaf)
    })
  }
  if ($missingFixtureFiles.Count -gt 0) {
    throw "Watch-mode fixture '$Fixture' is missing required file(s) under $fixtureDir`: $($missingFixtureFiles -join ', ')"
  }
  Get-ChildItem -LiteralPath $fixtureDir | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $outputDir -Recurse -Force
  }
  $dryRunSnapshotsPath = Join-Path $outputDir "snapshots.json"
  $dryRunSnapshots = Get-Content -LiteralPath $dryRunSnapshotsPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $dryRunSnapshots | Add-Member -NotePropertyName feedbackLoopPrevention -NotePropertyValue $FeedbackLoopPrevention -Force
  $dryRunDeviceIdentity = switch ($PhysicalPlaybackDeviceClass) {
    "usb" {
      [pscustomobject]@{
        id = "USB\VID_1234&PID_5678\dry-run-$PhysicalPlaybackDeviceProfileId"
        name = "Dry-run USB Speakers"
        signals = @("USB\VID_1234&PID_5678", "USB Audio Device")
      }
    }
    "bluetooth" {
      [pscustomobject]@{
        id = "BTHENUM\DEV_DRYRUN_$PhysicalPlaybackDeviceProfileId"
        name = "Dry-run Bluetooth A2DP Speakers"
        signals = @("BTHENUM\DEV_DRYRUN", "Bluetooth A2DP")
      }
    }
    default {
      [pscustomobject]@{
        id = "HDAUDIO\FUNC_01&VEN_DRYRUN\$PhysicalPlaybackDeviceProfileId"
        name = "Dry-run Default Speakers"
        signals = @("HDAUDIO\FUNC_01", "High Definition Audio")
      }
    }
  }
  $dryRunSnapshots | Add-Member -NotePropertyName deviceEvidence -NotePropertyValue ([pscustomobject]@{
    profileId = $PhysicalPlaybackDeviceProfileId
    deviceClass = $PhysicalPlaybackDeviceClass
    requestedDeviceId = $PhysicalPlaybackDeviceId
    resolvedDeviceId = $dryRunDeviceIdentity.id
    resolvedDeviceName = $dryRunDeviceIdentity.name
    classificationSignals = @($dryRunDeviceIdentity.signals)
    classificationSource = "fixture"
    routeEvidenceSource = "fixture"
    verified = $false
    fixtureOnly = $true
  }) -Force
  if ($FeedbackLoopPrevention -eq "process-exclusion") {
    # The built-in fixture defaults to the virtual-driver route. Replace its
    # backend and synthetic fingerprint evidence so a process-exclusion dry
    # run exercises the same report schema without claiming to be live audio.
    $dryRunSnapshots.driver = $null
    $dryRunSnapshots.wasapi = $null
    $dryRunSnapshots.physicalOutput = [pscustomobject]@{
      passed = $true
      status = 'passed'
      probeKind = 'process-exclusion-fingerprint'
      fixtureOnly = $true
      physicalPlaybackDeviceId = 'dry-run-speaker'
      resolvedPhysicalPlaybackDeviceId = 'dry-run-speaker'
      resolvedPhysicalPlaybackDeviceName = 'Dry-run Speakers'
      playbackFramesWrittenBefore = 0
      playbackFramesWrittenAfter = 96000
      capturedFrames = 134400
      rms = 0.2
      toneComponent = 0.08
      invalidSamples = 0
      processExclusionFingerprint = [pscustomobject]@{
        bridgeProcessId = 4242
        excludedProcessId = 4242
        externalPlayerProcessId = 5001
        bridgeChildPlayerProcessId = 5002
        bridgeChildParentProcessId = 4242
        bridgeChildExitCode = 0
        sourceCaptureMode = 'process-exclusion'
        captureBackend = 'wasapi-process-exclusion'
        processLoopbackStatus = 'ready'
        physicalTranslationComponent = 0.08
        physicalExternalComponent = 0.16
        physicalBridgeChildComponent = 0.16
        sourceTranslationComponent = 0.0004
        sourceExternalComponent = 0.15
        sourceBridgeChildComponent = 0.0002
        sourceToPhysicalTranslationRatio = 0.005
        sourceTranslationToExternalRatio = 0.0027
        sourceToPhysicalBridgeChildRatio = 0.00125
        translationComponentLimit = 0.003
        sourceToPhysicalRatioLimit = 0.05
        sourceToExternalRatioLimit = 0.05
      }
    }
    $dryRunSnapshots.bridge = [pscustomobject]@{
      probePassed = $true
      bridgeState = 'running'
      driverHealth = 'not-installed'
      sourceCaptureMode = 'process-exclusion'
      captureBackend = 'wasapi-process-exclusion'
      processLoopbackSupported = $true
      processLoopbackStatus = 'ready'
      windowsBuildNumber = 26100
      processLoopbackMinimumWindowsBuild = 20348
      excludedProcessId = 4242
      processLoopbackFailureDetail = $null
      sourceSubscriberActive = $false
      sourceReadCalls = 0
      sourceFramePayloadBytes = 0
      droppedFrameCount = 0
    }
  }
  $dryRunSnapshots | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $dryRunSnapshotsPath -Encoding UTF8
  Invoke-ReportGenerator $outputDir "dry-run"
  $dryRunReportPath = Join-Path $outputDir "report.json"
  $dryRunReport = Get-Content -LiteralPath $dryRunReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($dryRunReport.verdict -ne "passed") {
    throw "Watch-mode dry-run fixture report did not pass: verdict=$($dryRunReport.verdict) failureLayer=$($dryRunReport.failureLayer) report=$dryRunReportPath"
  }
  Write-Output $outputDir
  exit 0
}

$steps = @()
$desktopProcess = $null
$script:systemMetricsSamplerProcess = $null
$script:elevatedDesktopLaunch = $null
$desktopEnvState = $null
$driverProbe = $null
$playbackStep = $null
$physicalOutputRecorder = $null
$physicalOutputRecorderStep = $null
$physicalOutputRecordingStep = $null
$physicalOutputContentStep = $null
$deviceEvidenceStep = $null
$sourceMediaTranscriptStep = $null
$virtualDriverMediaPreflight = $null
$artifactsSaved = $false
$criticalFailureMessage = $null
try {
  $runtimePathForMarker = Resolve-Path -LiteralPath $RuntimeRoot -ErrorAction SilentlyContinue
  $appLogForMarker = if ($runtimePathForMarker) { Join-Path $runtimePathForMarker.Path "app.log" } else { Join-Path $RuntimeRoot "app.log" }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $appLogForMarker) | Out-Null
  Add-Content -LiteralPath $appLogForMarker -Value $runMarker -Encoding UTF8
  $desktopEnvState = Set-DesktopAutostartEnvFile $runMarker $outputDir

  # Windows PowerShell promotes cargo's successful stderr progress line to a
  # NativeCommandError when ErrorActionPreference=Stop. Run npm through cmd
  # with stdout/stderr merged so a zero exit remains a successful build step.
  $steps += Invoke-Step "build bridge service native" {
    & cmd.exe /d /c 'npm.cmd run build:bridge-service-native 2>&1'
  } -ContinueOnError
  if (-not $SkipDesktopLaunch) {
    $steps += Invoke-Step "stop stale desktop shell before live run" {
      Stop-StaleWatchModeDesktopShell
    }
    $steps += Invoke-Step "stop stale bridge service before driver probe" {
      Stop-StaleBridgeService $RuntimeRoot
    } -ContinueOnError
  } else {
    $steps += Invoke-Step "stop existing watch route before live run" {
      Invoke-StopWatchRouteViaTauriCli
    } -ContinueOnError
  }
  if (Test-UsesVirtualDriverBackend $FeedbackLoopPrevention) {
    if ($paidAuthorityEnabled) {
      $driverProbe = Invoke-Step "driver probe from signed worker readiness" {
        Get-SignedWorkerReadinessDriverProbe $WorkerReadinessReceiptPath
      } -ContinueOnError
    } else {
      $driverProbeArguments = Get-WatchModeDriverProbeArguments `
        -WorkspaceRoot $workspaceRoot `
        -RequestedDevconPath $DevconPath
      $driverProbe = Invoke-Step "driver probe" {
        & (Join-Path $workspaceRoot "scripts/installer/test-development-driver.ps1") @driverProbeArguments
      } -ContinueOnError
    }

    if (-not $driverProbe.ok -and -not $SkipDriverRepair -and $AllowDriverRepair) {
      $steps += Invoke-Step "repair driver with explicit elevation" { Invoke-ElevatedDriverReinstall $outputDir } -ContinueOnError
      $driverProbe = Invoke-Step "driver probe after repair" {
        & (Join-Path $workspaceRoot "scripts/installer/test-development-driver.ps1") @driverProbeArguments
      } -ContinueOnError
    }
    elseif (-not $driverProbe.ok -and -not $SkipDriverRepair -and -not $AllowDriverRepair) {
      Write-Host "driver probe failed; skipping elevated repair because -AllowDriverRepair was not provided"
    }
  } else {
    $driverProbe = [pscustomobject]@{
      name = "driver probe"
      ok = $true
      result = [pscustomobject]@{
        skipped = $true
        reason = "$FeedbackLoopPrevention does not install, probe, or depend on the virtual driver"
      }
      error = $null
    }
  }
  $steps += $driverProbe
  Convert-DriverProbeToJsonFile $driverProbe (Join-Path $outputDir "driver.json")
  $criticalFailureMessage = Get-VirtualDriverPreflightFailure $FeedbackLoopPrevention $driverProbe

  $bridgeSourceProbe = if ($criticalFailureMessage) {
    [pscustomobject]@{
      name = "bridge source frame probe"
      ok = $true
      result = [pscustomobject]@{
        skipped = $true
        reason = $criticalFailureMessage
      }
      error = $null
    }
  } elseif ($FeedbackLoopPrevention -eq "echo-cancel") {
    [pscustomobject]@{
      name = "bridge source frame probe"
      ok = $true
      result = [pscustomobject]@{
        skipped = $true
        reason = "echo-cancel Watch capture does not use a Bridge source backend"
      }
      error = $null
    }
  } else {
    Invoke-Step "bridge source frame probe" {
      Invoke-BridgeSourceProbe $outputDir $FeedbackLoopPrevention
    } -ContinueOnError
  }
  $steps += $bridgeSourceProbe
  if ($bridgeSourceProbe.ok) {
    $bridgeSourceProbe.result | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path $outputDir "bridge-source-probe.json") -Encoding UTF8
  } else {
    $bridgeDiagnosticsPath = Join-Path $outputDir "bridge-source-probe-diagnostics.json"
    if (Test-Path -LiteralPath $bridgeDiagnosticsPath -PathType Leaf) {
      Get-Content -LiteralPath $bridgeDiagnosticsPath -Raw -Encoding UTF8 | Set-Content -Path (Join-Path $outputDir "bridge-source-probe.json") -Encoding UTF8
    } else {
      [pscustomobject]@{ passed = $false; error = $bridgeSourceProbe.error } | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $outputDir "bridge-source-probe.json") -Encoding UTF8
    }
  }
  if ($FeedbackLoopPrevention -ne "echo-cancel" -and -not $bridgeSourceProbe.ok -and -not $criticalFailureMessage) {
    $criticalFailureMessage = "bridge source frame preflight failed before the Desktop/LLM session: $($bridgeSourceProbe.error)"
  }

  $virtualDriverMediaPreflight = if (Test-UsesVirtualDriverBackend $FeedbackLoopPrevention) {
    if ($criticalFailureMessage) {
      [pscustomobject]@{
        name = "virtual-driver media source preflight"
        ok = $true
        result = [pscustomobject]@{
          skipped = $true
          reason = $criticalFailureMessage
        }
        error = $null
      }
    } else {
      Invoke-Step "virtual-driver media source preflight" {
        Invoke-VirtualDriverMediaSourcePreflight `
          -OutputDirectory $outputDir `
          -VirtualRenderEndpointId ([string]$driverProbe.result.WasapiEndpointId) `
          -PathToMedia $MediaPath
      } -ContinueOnError
    }
  } else {
    [pscustomobject]@{
      name = "virtual-driver media source preflight"
      ok = $true
      result = [pscustomobject]@{
        skipped = $true
        reason = "$FeedbackLoopPrevention does not use the virtual-driver media path"
      }
      error = $null
    }
  }
  $steps += $virtualDriverMediaPreflight
  if ($virtualDriverMediaPreflight.ok) {
    $virtualDriverMediaPreflight.result | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path $outputDir "virtual-driver-media-source-preflight.json") -Encoding UTF8
  } else {
    $preflightDiagnosticsPath = Join-Path $outputDir "virtual-driver-media-source-preflight-diagnostics.json"
    if (Test-Path -LiteralPath $preflightDiagnosticsPath -PathType Leaf) {
      Get-Content -LiteralPath $preflightDiagnosticsPath -Raw -Encoding UTF8 | Set-Content -Path (Join-Path $outputDir "virtual-driver-media-source-preflight.json") -Encoding UTF8
    } else {
      [pscustomobject]@{ passed = $false; error = $virtualDriverMediaPreflight.error } | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $outputDir "virtual-driver-media-source-preflight.json") -Encoding UTF8
    }
    $criticalFailureMessage = "virtual-driver media source preflight failed before the Desktop/LLM session: $($virtualDriverMediaPreflight.error)"
  }
  if ($criticalFailureMessage) {
    throw $criticalFailureMessage
  }

  $physicalOutputProbe = if ($FeedbackLoopPrevention -eq "echo-cancel") {
    [pscustomobject]@{
      name = "physical output loopback probe"
      ok = $true
      result = [pscustomobject]@{
        skipped = $true
        reason = "echo-cancel does not use a Bridge physical-output isolation probe"
      }
      error = $null
    }
  } else {
    Invoke-Step "physical output loopback probe" {
      Invoke-PhysicalOutputProbe $outputDir $FeedbackLoopPrevention
    } -ContinueOnError
  }
  $steps += $physicalOutputProbe
  if ($physicalOutputProbe.ok) {
    $physicalOutputProbe.result | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path $outputDir "physical-output-probe.json") -Encoding UTF8
    Set-DesktopPhysicalPlaybackOverride (Get-PhysicalOutputResolvedDeviceId $physicalOutputProbe)
  } else {
    [pscustomobject]@{ error = $physicalOutputProbe.error } | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $outputDir "physical-output-probe.json") -Encoding UTF8
  }

  $deviceEvidenceStep = Invoke-Step "resolve and classify physical playback endpoint" {
    Resolve-PhysicalPlaybackDeviceEvidence $physicalOutputProbe
  } -ContinueOnError
  $steps += $deviceEvidenceStep
  if (-not $deviceEvidenceStep.ok) {
    throw "physical playback device evidence failed: $($deviceEvidenceStep.error)"
  }
  $deviceEvidenceStep.result | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $outputDir "physical-playback-device.json") -Encoding UTF8
  $resolvedPhysicalDeviceId = [string]$deviceEvidenceStep.result.resolvedDeviceId
  Set-DesktopPhysicalPlaybackOverride $resolvedPhysicalDeviceId
  $desktopProcess = if ($criticalFailureMessage) {
    [pscustomobject]@{
      name = "start desktop shell"
      ok = $false
      result = $null
      error = "skipped because $criticalFailureMessage"
    }
  } else {
    Invoke-Step "start desktop shell" { Start-WatchModeDesktopShell $outputDir $runMarker $resolvedPhysicalDeviceId } -ContinueOnError
  }
  $steps += $desktopProcess

  if ($desktopProcess.ok) {
    if ($SkipDesktopLaunch) {
      $startViaCliStep = Invoke-Step "start watch mode via existing desktop shell" {
        Invoke-StartWatchModeViaTauriCli $desktopProcess $resolvedPhysicalDeviceId
      } -ContinueOnError
      $steps += $startViaCliStep
      if (-not $startViaCliStep.ok) {
        $criticalFailureMessage = "start watch mode via existing desktop shell failed: $($startViaCliStep.error)"
      } else {
        $criticalFailureMessage = "-SkipDesktopLaunch cannot inject the same-process Watch report capture environment; launch the desktop through this runner"
      }
    }
    if (-not $criticalFailureMessage) {
      # The virtual-driver route intentionally renders its source through the
      # installed virtual endpoint. The other routes must inject the source
      # into the same resolved physical endpoint that the recorder/probe uses;
      # letting the injector silently choose the OS default can select a
      # different endpoint (for example, the VM default changed after probe)
      # and make the physical-content evidence record only silence.
      $watchPlaybackEndpointId = if (
        $FeedbackLoopPrevention -eq "virtual-driver" -and
        $driverProbe.ok -and
        $driverProbe.result.WasapiEndpointId
      ) {
        [string]$driverProbe.result.WasapiEndpointId
      } else {
        [string]$resolvedPhysicalDeviceId
      }
      $runtimePathBeforePlayback = Resolve-Path -LiteralPath $RuntimeRoot -ErrorAction SilentlyContinue
      $appLogBeforePlayback = if ($runtimePathBeforePlayback) { Join-Path $runtimePathBeforePlayback.Path "app.log" } else { Join-Path $RuntimeRoot "app.log" }
      # Count the readiness budget from the desktop launch, not from this wait.
      # Warm-up therefore cannot silently extend a failed single-model run past
      # the configured limit.
      $readinessDeadlineUtc = ([DateTime]$desktopProcess.result.launchedAtUtc).AddSeconds($SessionReadyTimeoutSeconds)
      $readinessStep = Invoke-Step "wait for same-process provider and frontend IPC readiness" {
        Wait-WatchModeAppReadiness `
          -Path $appLogBeforePlayback `
          -RunMarker $runMarker `
          -ProcessId ([int]$desktopProcess.result.pid) `
          -DeadlineUtc $readinessDeadlineUtc `
          -DesktopStdoutPath ([string]$desktopProcess.result.stdout) `
          -DesktopStderrPath ([string]$desktopProcess.result.stderr)
      } -ContinueOnError
      $steps += $readinessStep
      if (-not $readinessStep.ok) {
        $criticalFailureMessage = "same-process Watch frontend readiness infrastructure check failed: $($readinessStep.error)"
      }
    }
    if (-not $criticalFailureMessage) {
      $physicalOutputContentSkipReason = Get-PhysicalOutputContentSkipReason `
        -FeedbackMode $FeedbackLoopPrevention `
        -SkipContentStt $SkipPhysicalOutputContentStt
      $physicalOutputRecorderStep = if ($physicalOutputContentSkipReason) {
        [pscustomobject]@{
          name = "start physical output content recording"
          ok = $true
          result = [pscustomobject]@{
            skipped = $true
            reason = $physicalOutputContentSkipReason
          }
          error = $null
        }
      } else {
        Invoke-Step "start physical output content recording" {
          $script:physicalOutputRecorder = Start-PhysicalOutputContentRecorder $outputDir $resolvedPhysicalDeviceId
          [pscustomobject]@{
            pid = $script:physicalOutputRecorder.pid
            recordSeconds = $script:physicalOutputRecorder.recordSeconds
            recordingPath = $script:physicalOutputRecorder.recordingPath
            transcriptionPcmPath = $script:physicalOutputRecorder.transcriptionPcmPath
          }
        } -ContinueOnError
      }
      $steps += $physicalOutputRecorderStep

      if (-not $physicalOutputRecorderStep.ok) {
        $criticalFailureMessage = "start physical output content recording failed: $($physicalOutputRecorderStep.error)"
      }

      if (-not $criticalFailureMessage) {
        if ($UseDefaultEndpointPlayback) {
          $playbackStep = Invoke-Step "play watch-mode media via default endpoint" {
            Start-TestMediaPlaybackViaDefaultEndpoint $MediaPath $watchPlaybackEndpointId
          } -ContinueOnError
        } else {
          $playbackStep = Invoke-Step "play watch-mode media" { Start-TestMediaPlayback $MediaPath $watchPlaybackEndpointId $outputDir } -ContinueOnError
        }
        $steps += $playbackStep
        $requiredWatchReportPath = Join-Path $outputDir "watch-session-report.json"
        $reportDeadlineUtc = Get-WatchSessionReportDeadlineUtc `
          -LaunchedAtUtc ([DateTime]$desktopProcess.result.launchedAtUtc) `
          -ReadyTimeoutSeconds $SessionReadyTimeoutSeconds `
          -AutoStopAfterSeconds $WatchAutoStopAfterSeconds
        $reportWaitStep = Invoke-Step "wait for same-process Watch report and desktop exit" {
          Wait-WatchSessionReportAndDesktopExit `
            -Path $requiredWatchReportPath `
            -ProcessId ([int]$desktopProcess.result.pid) `
            -DeadlineUtc $reportDeadlineUtc
        } -ContinueOnError
        $steps += $reportWaitStep
        if (-not $reportWaitStep.ok -and -not $criticalFailureMessage) {
          $criticalFailureMessage = "same-process Watch report capture failed: $($reportWaitStep.error)"
        }
        if ($StopDesktopAfterPlayback) {
          $steps += Invoke-Step "stop watch-mode desktop shell after playback" {
            Stop-WatchModeDesktopShell $desktopProcess
          } -ContinueOnError
        }
        $sourceMediaTranscriptStep = if ($physicalOutputContentSkipReason) {
          [pscustomobject]@{
            name = "transcribe source media reference"
            ok = $true
            result = [pscustomobject]@{
              skipped = $true
              reason = $physicalOutputContentSkipReason
            }
            error = $null
          }
        } else {
          Invoke-Step "transcribe source media reference" {
            Get-SourceMediaReferenceTranscript $outputDir $MediaPath
          } -ContinueOnError
        }
        $steps += $sourceMediaTranscriptStep
        $physicalOutputRecordingStep = if ($physicalOutputContentSkipReason) {
          [pscustomobject]@{
            name = "complete physical output content recording"
            ok = $true
            result = [pscustomobject]@{
              skipped = $true
              reason = $physicalOutputContentSkipReason
            }
            error = $null
          }
        } else {
          Invoke-Step "complete physical output content recording" {
            Complete-PhysicalOutputContentRecorder $script:physicalOutputRecorder
          } -ContinueOnError
        }
        $steps += $physicalOutputRecordingStep
        $physicalOutputContentStep = if ($physicalOutputContentSkipReason) {
          [pscustomobject]@{
            name = "transcribe and compare physical output content"
            ok = $true
            result = [pscustomobject]@{
              skipped = $true
              reason = $physicalOutputContentSkipReason
            }
            error = $null
          }
        } else {
          Invoke-Step "transcribe and compare physical output content" {
            Invoke-PhysicalOutputContentStt $outputDir $physicalOutputRecordingStep.result $appLogBeforePlayback $runMarker $sourceMediaTranscriptStep.result
          } -ContinueOnError
        }
        $steps += $physicalOutputContentStep
      }
    }
  } else {
    $playbackStep = [pscustomobject]@{
      name = "desktop shell did not start"
      ok = $false
      result = $null
      error = $desktopProcess.error
    }
    $steps += $playbackStep
    if (-not $criticalFailureMessage) {
      $criticalFailureMessage = "desktop shell did not start: $($desktopProcess.error)"
    }
  }

  $requiredWatchReportPath = Join-Path $outputDir "watch-session-report.json"
  $steps += Invoke-Step "stop bridge service after live run" {
    if ($AllowElevatedDesktopLaunch) {
      [pscustomobject]@{
        desktopStop = Stop-WatchModeDesktopShell $desktopProcess
        bridgeStop = Stop-StaleBridgeService $RuntimeRoot
      }
    } elseif ($SkipDesktopLaunch) {
      Invoke-StopWatchRouteViaTauriCli
    } else {
      [pscustomobject]@{
        reportSavedByDesktopProcess = Test-Path -LiteralPath $requiredWatchReportPath -PathType Leaf
        bridgeStop = Stop-StaleBridgeService $RuntimeRoot
      }
    }
  } -ContinueOnError

  $systemMetricsStep = if ($desktopProcess -and $desktopProcess.ok -and $desktopProcess.result -and $desktopProcess.result.systemMetricsSampler) {
    Invoke-Step "complete desktop process-tree system metrics sampling" {
      Complete-WatchModeSystemMetricsSampler $desktopProcess.result.systemMetricsSampler
    } -ContinueOnError
  } else {
    [pscustomobject]@{
      name = "complete desktop process-tree system metrics sampling"
      ok = $true
      result = [pscustomobject]@{
        skipped = $true
        reason = "desktop shell did not start"
      }
      error = $null
    }
  }
  $steps += $systemMetricsStep
  if (-not $systemMetricsStep.ok -and -not $criticalFailureMessage) {
    $criticalFailureMessage = "desktop system metrics evidence failed: $($systemMetricsStep.error)"
  }

  if ($criticalFailureMessage) {
    throw $criticalFailureMessage
  }
  Assert-WatchSessionReportFile $requiredWatchReportPath | Out-Null
  if ($reportWaitStep -and -not $reportWaitStep.ok) {
    throw "same-process Watch report did not complete within the desktop launch deadline: $($reportWaitStep.error)"
  }

  if ($paidAuthorityEnabled) {
    $strictBudgetStep = Invoke-Step "validate strict paid external provider budget" {
      Write-StrictPaidCellBudget $outputDir $appLogBeforePlayback $runMarker
    } -ContinueOnError
    $steps += $strictBudgetStep
    if (-not $strictBudgetStep.ok) {
      throw $strictBudgetStep.error
    }
  }

  Save-WatchModeRunArtifacts $outputDir $driverProbe $playbackStep $steps $runMarker $startedAtLocal $criticalFailureMessage
  $artifactsSaved = $true
  Write-Output $outputDir
} catch {
  $message = $_.Exception.Message
  $steps += [pscustomobject]@{
    name = "run failed"
    ok = $false
    result = $null
    error = $message
  }
  try {
    Save-WatchModeRunArtifacts $outputDir $driverProbe $playbackStep $steps $runMarker $startedAtLocal $message
    $artifactsSaved = $true
    Write-Output $outputDir
  } catch {
    Write-Warning "failed to save watch-mode run artifacts: $($_.Exception.Message)"
  }
  throw
} finally {
  Stop-WatchModeDesktopShell $desktopProcess | Out-Null
  Stop-WatchModeSystemMetricsSampler
  try {
    Stop-StaleBridgeService $RuntimeRoot | Out-Null
  } catch {
    Write-Warning "failed to stop bridge service during cleanup: $($_.Exception.Message)"
  }
  Restore-DesktopAutostartEnvFile $desktopEnvState
}
