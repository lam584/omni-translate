#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.IO.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Process.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Windows.Audio.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Bridge.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.AudioAnalysis.psm1') -Force

function Write-TestMediaReferencePcm {
  param(
    [string]$PathToMedia,
    [string]$OutputDirectory,
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
    [Parameter(Mandatory = $true)][int]$PlaybackSeconds,
    [string]$InjectorExecutablePath
  )
  if (-not $OutputDirectory) {
    return $null
  }
  $injectorExe = if ($InjectorExecutablePath) { $InjectorExecutablePath } else { Join-Path $WorkspaceRoot 'target/release/omni-watch-media-injector.exe' }
  if (-not (Test-Path -LiteralPath $injectorExe -PathType Leaf)) {
    throw "watch media injector was not built: $injectorExe. Run npm run build:bridge-service-native first."
  }
  $referencePcmPath = Join-Path $OutputDirectory "source-media-reference-16k-mono.pcm"
  $args = @(
    "--media", (Resolve-Path -LiteralPath $PathToMedia).Path,
    "--reference-pcm16k-mono-path", $referencePcmPath,
    "--reference-only"
  )
  if ($PlaybackSeconds -gt 0) {
    $args += @("--max-seconds", "$PlaybackSeconds")
  }
  $output = @(& $injectorExe @args)
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0 -or -not $output) {
    throw "watch media reference decoder failed. ExitCode=$exitCode Output=$output"
  }
  try {
    $result = ($output -join [Environment]::NewLine) | ConvertFrom-Json
  } catch {
    throw "watch media reference decoder returned invalid JSON: $($_.Exception.Message)"
  }
  if (-not $result.passed -or -not (Test-Path -LiteralPath $referencePcmPath -PathType Leaf)) {
    throw "watch media reference decoder failed: $($result.detail)"
  }
  return $referencePcmPath
}

function Start-TestMediaPlayback {
  param([string]$PathToMedia, [string]$PlaybackEndpointId, [string]$OutputDirectory, [Parameter(Mandatory = $true)][string]$WorkspaceRoot, [Parameter(Mandatory = $true)][int]$PlaybackSeconds)
  if (-not (Test-Path -LiteralPath $PathToMedia -PathType Leaf)) {
    throw "Test media file not found: $PathToMedia"
  }
  $injectorExe = Join-Path $WorkspaceRoot 'target/release/omni-watch-media-injector.exe'
  if (Test-Path -LiteralPath $injectorExe -PathType Leaf) {
    $resolvedMediaPath = (Resolve-Path -LiteralPath $PathToMedia).Path
    $mediaSha256 = (Get-FileHash -LiteralPath $resolvedMediaPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $strictSourceGainDb = -9
    $strictPostrollSilenceSeconds = 3
    $args = @(
      "--media", $resolvedMediaPath,
      "--gain-db", "$strictSourceGainDb",
      "--postroll-silence-seconds", "$strictPostrollSilenceSeconds"
    )
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
      sourceGainDb = $result.sourceGainDb
      postrollSilenceFrames = $result.postrollSilenceFrames
      postrollSilenceSeconds = $result.postrollSilenceSeconds
      referencePcmPath = $referencePcmPath
    }
  }

  throw "watch media injector was not built: $injectorExe. Run npm run build:bridge-service-native first."
}

function Start-TestMediaPlaybackViaDefaultEndpoint {
  param([string]$PathToMedia, [string]$PlaybackEndpointId, [string]$OutputDirectory, [Parameter(Mandatory = $true)][string]$WorkspaceRoot, [Parameter(Mandatory = $true)][int]$PlaybackSeconds)
  if (-not (Test-Path -LiteralPath $PathToMedia -PathType Leaf)) {
    throw "Test media file not found: $PathToMedia"
  }
  $resolvedMediaPath = (Resolve-Path -LiteralPath $PathToMedia).Path
  $mediaSha256 = (Get-FileHash -LiteralPath $resolvedMediaPath -Algorithm SHA256).Hash.ToLowerInvariant()
  # MCI exercises the Windows default-endpoint route but does not expose its
  # decoded samples. Produce the same 16 kHz mono authority without opening a
  # render stream, and do it before switching so a decoder failure cannot
  # strand the machine on the temporary Watch playback endpoint.
  $referencePcmPath = Write-TestMediaReferencePcm $resolvedMediaPath $OutputDirectory $WorkspaceRoot $PlaybackSeconds
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
    referencePcmPath = $referencePcmPath
  }
}


Export-ModuleMember -Function @(
  'Write-TestMediaReferencePcm',
  'Start-TestMediaPlayback',
  'Start-TestMediaPlaybackViaDefaultEndpoint'
)
