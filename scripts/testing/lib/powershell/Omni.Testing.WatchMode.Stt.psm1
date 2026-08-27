#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Evidence.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Process.psm1') -Force -DisableNameChecking

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
      Stop-OmniManagedProcessHandle -Process $process | Out-Null
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

function Get-PhysicalOutputSttApiKey {
  param([Parameter(Mandatory = $true)][string]$WorkspaceRoot)
  $configPath = Join-Path $WorkspaceRoot "scripts/testing/llm-integration.config.json"
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

function Resolve-OmniRealtimeDiagnostic {
  param([Parameter(Mandatory = $true)][string]$WorkspaceRoot)
  $exe = Join-Path $workspaceRoot "target/debug/omni-realtime-diagnostic.exe"
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "frozen omni realtime STT diagnostic executable is missing"
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

function Invoke-CanonicalSourceAuthorityNode {
  param(
    [string]$OutputDirectory,
    [ValidateSet("Reference", "Source", "Combined")][string]$Mode = "Combined",
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot
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
  param([string]$OutputDirectory, [string]$MediaPath, [Parameter(Mandatory = $true)][string]$WorkspaceRoot)
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
    $validated = Invoke-CanonicalSourceAuthorityNode $OutputDirectory "Reference" $WorkspaceRoot
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

function Get-SourceMediaReferenceTranscript {
  param([string]$OutputDirectory, [string]$MediaPath, [Parameter(Mandatory = $true)]$Context)
  $workspaceRoot = [string]$Context.paths.workspaceRoot
  $PlaybackSeconds = [int]$Context.request.media.playbackSeconds
  $authorityMode = [string]$Context.request.authorityMode
  # Both paid authorities must remain self-contained: the Plus incident replay
  # has the same zero-auxiliary-provider-audio rule as the strict release
  # matrix, while retaining a separate signing and result authority.
  if ($authorityMode -in @('strict-paid', 'incident-replay-plus', 'local-canonical-smoke')) {
    return Get-CanonicalSourceMediaReference $OutputDirectory $MediaPath $workspaceRoot
  }
  $resultPath = Join-Path $OutputDirectory "source-media-transcript.json"
  if (-not (Test-Path -LiteralPath $MediaPath -PathType Leaf)) {
    [pscustomobject]@{ passed = $false; error = "source media file not found: $MediaPath" } | ConvertTo-Json -Depth 8 | Set-Content -Path $resultPath -Encoding UTF8
    return Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  }
  $apiKey = Get-PhysicalOutputSttApiKey $workspaceRoot
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
    $exe = Resolve-OmniRealtimeDiagnostic $workspaceRoot
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

Export-ModuleMember -Function @(
  'Invoke-NativeProcessToLog',
  'Get-PhysicalOutputSttApiKey',
  'Resolve-OmniRealtimeDiagnostic',
  'Parse-OmniRealtimeDiagnosticText',
  'Invoke-CanonicalSourceAuthorityNode',
  'Get-CanonicalSourceMediaReference',
  'Get-SourceMediaReferenceTranscript'
)
