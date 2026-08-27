function Assert-OmniVirtualMicEvidenceCondition {
  param(
    [Parameter(Mandatory = $true)][object]$Condition,
    [Parameter(Mandatory = $true)][string]$Message
  )
  if (-not [bool]$Condition) {
    throw "Virtual microphone capture authority failed: $Message"
  }
}

function Assert-OmniVirtualMicEvidenceProperty {
  param(
    [Parameter(Mandatory = $true)][object]$Value,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if ($null -eq $Value.PSObject.Properties[$Name]) {
    throw "Virtual microphone capture authority failed: $Label is missing $Name"
  }
}

function ConvertTo-OmniEvidenceJson {
  param([Parameter(Mandatory = $true)][object]$Value)
  return ($Value | ConvertTo-Json -Depth 32 -Compress)
}

function Get-OmniEvidenceSha256 {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)
  $stream = [System.IO.File]::OpenRead($LiteralPath)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Invoke-OmniVirtualMicFingerprintAuthority {
  param(
    [Parameter(Mandatory = $true)][string]$CaptureProbePath,
    [Parameter(Mandatory = $true)][string]$RuntimeSnapshotPath,
    [Parameter(Mandatory = $true)][string]$CaptureWavPath
  )
  $verifierPath = Join-Path $PSScriptRoot 'virtual-mic-fingerprint-authority.mjs'
  Assert-OmniVirtualMicEvidenceCondition (Test-Path -LiteralPath $verifierPath -PathType Leaf) 'shared fingerprint authority verifier is missing'
  $node = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
  Assert-OmniVirtualMicEvidenceCondition ($null -ne $node) 'node.exe is unavailable for the shared fingerprint authority verifier'
  $previousNodeOptions = [Environment]::GetEnvironmentVariable('NODE_OPTIONS', 'Process')
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    [Environment]::SetEnvironmentVariable('NODE_OPTIONS', $null, 'Process')
    $ErrorActionPreference = 'Continue'
    $output = @(& $node.Source $verifierPath `
      '--capture-wav' ([System.IO.Path]::GetFullPath($CaptureWavPath)) `
      '--capture-probe' ([System.IO.Path]::GetFullPath($CaptureProbePath)) `
      '--runtime-snapshot' ([System.IO.Path]::GetFullPath($RuntimeSnapshotPath)) 2>&1)
    $status = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    [Environment]::SetEnvironmentVariable('NODE_OPTIONS', $previousNodeOptions, 'Process')
  }
  $text = ($output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
  Assert-OmniVirtualMicEvidenceCondition ($status -eq 0) "shared fingerprint authority verifier failed: $text"
  try {
    $authority = $text | ConvertFrom-Json
  } catch {
    throw "Virtual microphone capture authority failed: shared fingerprint verifier returned invalid JSON: $text"
  }
  Assert-OmniVirtualMicEvidenceCondition (
    $authority.passed -eq $true -and
    $authority.algorithm -ceq 'omni-vmic-fingerprint-pcm16-v1' -and
    [long]$authority.uniqueMatchCount -eq 1 -and
    [long]$authority.maxSampleDelta -le 1
  ) 'shared fingerprint authority result is incomplete'
  return $authority
}

function Assert-OmniVirtualMicCaptureAuthority {
  param(
    [Parameter(Mandatory = $true)][object]$CaptureProbe,
    [Parameter(Mandatory = $true)][object]$RuntimeSnapshot,
    [Parameter(Mandatory = $true)][string]$CaptureWavPath
  )

  foreach ($record in @(
    [pscustomobject]@{ Value = $CaptureProbe; Label = 'capture probe' },
    [pscustomobject]@{ Value = $RuntimeSnapshot; Label = 'runtime snapshot' }
  )) {
    foreach ($property in @(
      'schemaVersion', 'artifactKind', 'capturedAt', 'collectorId', 'collectorVersion',
      'parentCollectorProcessId', 'captureChildProcessId', 'bridgeProtocolVersion',
      'bridgeProcessId', 'bridgeInstanceId', 'bridgeSessionId', 'captureEndpointId',
      'captureEndpointName', 'rawCountersBefore', 'rawCountersAfter',
      'recomputedCounterDelta', 'cueId', 'cueStatusTimeline', 'cueLifecycle',
      'captureWav', 'captureWavSha256', 'capturedFrames', 'fingerprint'
    )) {
      Assert-OmniVirtualMicEvidenceProperty -Value $record.Value -Name $property -Label $record.Label
    }
  }
  foreach ($property in @('targetCaptureApplication', 'format')) {
    Assert-OmniVirtualMicEvidenceProperty -Value $CaptureProbe -Name $property -Label 'capture probe'
  }
  foreach ($property in @(
    'virtualMicOutputSupported', 'virtualMicOutputStatus', 'virtualMicFormat',
    'virtualMicFramesWritten', 'virtualMicFramesWrittenBefore',
    'virtualMicFramesWrittenAfter', 'virtualMicFramesWrittenForCue',
    'physicalPlaybackFramesWrittenBefore', 'physicalPlaybackFramesWrittenAfter',
    'physicalPlaybackFramesWrittenForCue'
  )) {
    Assert-OmniVirtualMicEvidenceProperty -Value $RuntimeSnapshot -Name $property -Label 'runtime snapshot'
  }

  Assert-OmniVirtualMicEvidenceCondition ($CaptureProbe.schemaVersion -eq 1) 'capture probe schemaVersion is not 1'
  Assert-OmniVirtualMicEvidenceCondition ($RuntimeSnapshot.schemaVersion -eq 1) 'runtime snapshot schemaVersion is not 1'
  Assert-OmniVirtualMicEvidenceCondition ($CaptureProbe.artifactKind -eq 'virtual-mic-real-capture-probe') 'capture probe artifactKind is invalid'
  Assert-OmniVirtualMicEvidenceCondition ($RuntimeSnapshot.artifactKind -eq 'virtual-mic-runtime-snapshot') 'runtime snapshot artifactKind is invalid'
  Assert-OmniVirtualMicEvidenceCondition ($CaptureProbe.collectorId -eq 'omni-virtual-mic-target-capture') 'collectorId is invalid'
  Assert-OmniVirtualMicEvidenceCondition (-not [string]::IsNullOrWhiteSpace([string]$CaptureProbe.collectorVersion)) 'collectorVersion is empty'
  Assert-OmniVirtualMicEvidenceCondition ($CaptureProbe.bridgeProtocolVersion -eq '2026-08-27-audio-routing-v8') 'Bridge protocol is not v8'
  Assert-OmniVirtualMicEvidenceCondition (-not [string]::IsNullOrWhiteSpace([string]$CaptureProbe.capturedAt)) 'capturedAt is empty'

  $authorityFields = @(
    'capturedAt', 'collectorId', 'collectorVersion', 'parentCollectorProcessId',
    'captureChildProcessId', 'bridgeProtocolVersion', 'bridgeProcessId',
    'bridgeInstanceId', 'bridgeSessionId', 'captureEndpointId', 'captureEndpointName',
    'rawCountersBefore', 'rawCountersAfter', 'recomputedCounterDelta', 'cueId',
    'cueStatusTimeline', 'cueLifecycle', 'captureWav', 'captureWavSha256',
    'capturedFrames', 'fingerprint'
  )
  foreach ($field in $authorityFields) {
    Assert-OmniVirtualMicEvidenceCondition `
      ((ConvertTo-OmniEvidenceJson $CaptureProbe.$field) -ceq (ConvertTo-OmniEvidenceJson $RuntimeSnapshot.$field)) `
      "capture probe/runtime snapshot field diverged: $field"
  }

  $parentPid = [long]$CaptureProbe.parentCollectorProcessId
  $capturePid = [long]$CaptureProbe.captureChildProcessId
  $bridgePid = [long]$CaptureProbe.bridgeProcessId
  Assert-OmniVirtualMicEvidenceCondition (
    $parentPid -gt 0 -and $capturePid -gt 0 -and $bridgePid -gt 0 -and
    $parentPid -ne $capturePid -and $parentPid -ne $bridgePid -and $capturePid -ne $bridgePid
  ) 'collector, capture child, and Bridge require three distinct non-zero PIDs'
  Assert-OmniVirtualMicEvidenceCondition (-not [string]::IsNullOrWhiteSpace([string]$CaptureProbe.bridgeInstanceId)) 'bridgeInstanceId is empty'
  Assert-OmniVirtualMicEvidenceCondition (-not [string]::IsNullOrWhiteSpace([string]$CaptureProbe.bridgeSessionId)) 'bridgeSessionId is empty'
  Assert-OmniVirtualMicEvidenceCondition (
    [string]$CaptureProbe.captureEndpointId -match '^\{0\.0\.1\.' -and
    [string]$CaptureProbe.captureEndpointName -like '*Omni Translate Virtual Microphone*'
  ) 'capture endpoint is not the Omni capture dataflow endpoint'

  foreach ($counterSet in @('rawCountersBefore', 'rawCountersAfter', 'recomputedCounterDelta')) {
    Assert-OmniVirtualMicEvidenceProperty -Value $CaptureProbe.$counterSet -Name 'virtualMicFramesWritten' -Label $counterSet
    Assert-OmniVirtualMicEvidenceProperty -Value $CaptureProbe.$counterSet -Name 'playbackFramesWritten' -Label $counterSet
  }
  $virtualBefore = [long]$CaptureProbe.rawCountersBefore.virtualMicFramesWritten
  $virtualAfter = [long]$CaptureProbe.rawCountersAfter.virtualMicFramesWritten
  $physicalBefore = [long]$CaptureProbe.rawCountersBefore.playbackFramesWritten
  $physicalAfter = [long]$CaptureProbe.rawCountersAfter.playbackFramesWritten
  Assert-OmniVirtualMicEvidenceCondition ($virtualAfter -ge $virtualBefore -and $physicalAfter -ge $physicalBefore) 'raw Bridge counters regressed'
  $virtualDelta = $virtualAfter - $virtualBefore
  $physicalDelta = $physicalAfter - $physicalBefore
  Assert-OmniVirtualMicEvidenceCondition (
    $virtualDelta -gt 0 -and
    $virtualDelta -eq [long]$CaptureProbe.recomputedCounterDelta.virtualMicFramesWritten -and
    $physicalDelta -eq 0 -and
    $physicalDelta -eq [long]$CaptureProbe.recomputedCounterDelta.playbackFramesWritten
  ) 'raw Bridge counter delta does not prove VMic-only routing'

  $timeline = @($CaptureProbe.cueStatusTimeline)
  Assert-OmniVirtualMicEvidenceCondition ($timeline.Count -eq 3) 'cue status timeline must contain exactly three events'
  $expectedStatuses = @('queued', 'started', 'completed')
  $seenStatusIds = @{}
  $previousReceipt = [long]-1
  for ($index = 0; $index -lt $timeline.Count; $index += 1) {
    $event = $timeline[$index]
    foreach ($property in @('type', 'statusId', 'requestId', 'sessionId', 'cueId', 'playbackStatus', 'collectorReceivedAtMonotonicNs')) {
      Assert-OmniVirtualMicEvidenceProperty -Value $event -Name $property -Label "cue status event $index"
    }
    Assert-OmniVirtualMicEvidenceCondition ($event.type -eq 'bridge.translation.status') "cue status event $index uses the wrong type field"
    Assert-OmniVirtualMicEvidenceCondition ($event.sessionId -ceq $CaptureProbe.bridgeSessionId) "cue status event $index is not bound to the Bridge session"
    Assert-OmniVirtualMicEvidenceCondition ($event.cueId -ceq $CaptureProbe.cueId) "cue status event $index is not bound to the cue"
    Assert-OmniVirtualMicEvidenceCondition ($event.playbackStatus -ceq $expectedStatuses[$index]) "cue status event $index has an invalid status/order"
    Assert-OmniVirtualMicEvidenceCondition (-not [string]::IsNullOrWhiteSpace([string]$event.statusId)) "cue status event $index has an empty statusId"
    Assert-OmniVirtualMicEvidenceCondition (-not [string]::IsNullOrWhiteSpace([string]$event.requestId)) "cue status event $index has an empty requestId"
    Assert-OmniVirtualMicEvidenceCondition (-not $seenStatusIds.ContainsKey([string]$event.statusId)) "cue status event $index reuses a statusId"
    $seenStatusIds[[string]$event.statusId] = $true
    $receipt = [long]$event.collectorReceivedAtMonotonicNs
    Assert-OmniVirtualMicEvidenceCondition ($receipt -gt $previousReceipt) "cue status event $index has a non-monotonic collector receipt"
    $previousReceipt = $receipt
  }
  Assert-OmniVirtualMicEvidenceCondition (-not [string]::IsNullOrWhiteSpace([string]$CaptureProbe.cueId)) 'cueId is empty'
  $lifecycle = $CaptureProbe.cueLifecycle
  Assert-OmniVirtualMicEvidenceCondition (
    $lifecycle.cueId -ceq $CaptureProbe.cueId -and
    [long]$lifecycle.queuedCount -eq 1 -and
    [long]$lifecycle.startedCount -eq 1 -and
    [long]$lifecycle.completedCount -eq 1 -and
    [long]$lifecycle.staleDroppedCount -eq 0 -and
    [long]$lifecycle.routeFailedCount -eq 0 -and
    [long]$lifecycle.terminalEventCount -eq 1 -and
    $lifecycle.terminalStatus -ceq 'completed'
  ) 'stored cue lifecycle does not prove exactly-once completion'

  foreach ($property in @('classification', 'processId', 'captureApi', 'openedEndpoint', 'endpointId', 'endpointName')) {
    Assert-OmniVirtualMicEvidenceProperty -Value $CaptureProbe.targetCaptureApplication -Name $property -Label 'target capture application'
  }
  $target = $CaptureProbe.targetCaptureApplication
  Assert-OmniVirtualMicEvidenceCondition (
    $target.classification -eq 'real-target' -and
    $target.captureApi -eq 'WASAPI' -and
    $target.openedEndpoint -eq $true -and
    [long]$target.processId -eq $capturePid -and
    $target.endpointId -ceq $CaptureProbe.captureEndpointId -and
    $target.endpointName -ceq $CaptureProbe.captureEndpointName
  ) 'target capture application is not bound to the captured endpoint/PID'

  foreach ($property in @('sampleRateHz', 'channelCount', 'bitsPerSample', 'encoding')) {
    Assert-OmniVirtualMicEvidenceProperty -Value $CaptureProbe.format -Name $property -Label 'capture format'
  }
  Assert-OmniVirtualMicEvidenceCondition (
    [long]$CaptureProbe.format.sampleRateHz -eq 48000 -and
    [long]$CaptureProbe.format.channelCount -eq 1 -and
    [long]$CaptureProbe.format.bitsPerSample -eq 16 -and
    $CaptureProbe.format.encoding -eq 'pcm16'
  ) 'capture format is not 48 kHz mono PCM16'
  Assert-OmniVirtualMicEvidenceCondition (
    $RuntimeSnapshot.virtualMicOutputSupported -eq $true -and
    $RuntimeSnapshot.virtualMicOutputStatus -eq 'ready' -and
    $RuntimeSnapshot.virtualMicFormat -eq '48000Hz/mono/pcm16'
  ) 'runtime snapshot does not prove ready 48 kHz mono PCM16 VMic output'

  Assert-OmniVirtualMicEvidenceCondition (Test-Path -LiteralPath $CaptureWavPath -PathType Leaf) 'capture WAV is missing'
  $wavBytes = [System.IO.File]::ReadAllBytes([System.IO.Path]::GetFullPath($CaptureWavPath))
  $capturedFrames = [long]$CaptureProbe.capturedFrames
  Assert-OmniVirtualMicEvidenceCondition ($CaptureProbe.captureWav -eq 'virtual-mic-capture.wav') 'captureWav filename is not canonical'
  Assert-OmniVirtualMicEvidenceCondition (
    $wavBytes.Length -eq (44 + ($capturedFrames * 2)) -and
    [Text.Encoding]::ASCII.GetString($wavBytes, 0, 4) -eq 'RIFF' -and
    [Text.Encoding]::ASCII.GetString($wavBytes, 8, 4) -eq 'WAVE' -and
    [Text.Encoding]::ASCII.GetString($wavBytes, 12, 4) -eq 'fmt ' -and
    [BitConverter]::ToUInt16($wavBytes, 20) -eq 1 -and
    [BitConverter]::ToUInt16($wavBytes, 22) -eq 1 -and
    [BitConverter]::ToUInt32($wavBytes, 24) -eq 48000 -and
    [BitConverter]::ToUInt16($wavBytes, 34) -eq 16 -and
    [Text.Encoding]::ASCII.GetString($wavBytes, 36, 4) -eq 'data' -and
    [BitConverter]::ToUInt32($wavBytes, 40) -eq ($capturedFrames * 2)
  ) 'capture WAV header/frame count is not canonical PCM16 evidence'
  $wavSha256 = Get-OmniEvidenceSha256 -LiteralPath $CaptureWavPath
  Assert-OmniVirtualMicEvidenceCondition ($CaptureProbe.captureWavSha256 -ceq $wavSha256) 'capture WAV SHA-256 does not match the raw WAV'

  foreach ($property in @('id', 'detected', 'frequencyHz', 'startFrame', 'frameCount', 'expectedPcmHex', 'expectedPcmSha256')) {
    Assert-OmniVirtualMicEvidenceProperty -Value $CaptureProbe.fingerprint -Name $property -Label 'fingerprint evidence'
  }
  $fingerprint = $CaptureProbe.fingerprint
  Assert-OmniVirtualMicEvidenceCondition (
    $fingerprint.detected -eq $true -and
    -not [string]::IsNullOrWhiteSpace([string]$fingerprint.id) -and
    [double]$fingerprint.frequencyHz -eq 997.0 -and
    [long]$fingerprint.frameCount -eq 24000 -and
    [long]$fingerprint.startFrame -ge 0 -and
    ([long]$fingerprint.startFrame + [long]$fingerprint.frameCount) -le $capturedFrames -and
    [string]$fingerprint.expectedPcmHex -match '^[a-f0-9]{96000}$' -and
    [string]$fingerprint.expectedPcmSha256 -match '^[a-f0-9]{64}$'
  ) 'fingerprint evidence is incomplete or outside the captured WAV'

  $captureProbePath = Join-Path ([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($CaptureWavPath))) 'virtual-mic-capture-probe.json'
  $runtimeSnapshotPath = Join-Path ([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($CaptureWavPath))) 'runtime-snapshot.json'
  Assert-OmniVirtualMicEvidenceCondition (Test-Path -LiteralPath $captureProbePath -PathType Leaf) 'capture probe raw artifact is missing beside the capture WAV'
  Assert-OmniVirtualMicEvidenceCondition (Test-Path -LiteralPath $runtimeSnapshotPath -PathType Leaf) 'runtime snapshot raw artifact is missing beside the capture WAV'
  $fingerprintAuthority = Invoke-OmniVirtualMicFingerprintAuthority `
    -CaptureProbePath $captureProbePath `
    -RuntimeSnapshotPath $runtimeSnapshotPath `
    -CaptureWavPath $CaptureWavPath

  Assert-OmniVirtualMicEvidenceCondition (
    [long]$RuntimeSnapshot.virtualMicFramesWrittenBefore -eq $virtualBefore -and
    [long]$RuntimeSnapshot.virtualMicFramesWrittenAfter -eq $virtualAfter -and
    [long]$RuntimeSnapshot.virtualMicFramesWritten -eq $virtualAfter -and
    [long]$RuntimeSnapshot.virtualMicFramesWrittenForCue -eq $virtualDelta -and
    [long]$RuntimeSnapshot.physicalPlaybackFramesWrittenBefore -eq $physicalBefore -and
    [long]$RuntimeSnapshot.physicalPlaybackFramesWrittenAfter -eq $physicalAfter -and
    [long]$RuntimeSnapshot.physicalPlaybackFramesWrittenForCue -eq $physicalDelta
  ) 'runtime snapshot counters diverge from raw Bridge counters'

  return [ordered]@{
    passed = $true
    protocolVersion = [string]$CaptureProbe.bridgeProtocolVersion
    bridgeProcessId = $bridgePid
    bridgeInstanceId = [string]$CaptureProbe.bridgeInstanceId
    bridgeSessionId = [string]$CaptureProbe.bridgeSessionId
    captureEndpointId = [string]$CaptureProbe.captureEndpointId
    captureEndpointName = [string]$CaptureProbe.captureEndpointName
    connectedAt = [string]$CaptureProbe.capturedAt
    fingerprintAuthority = $fingerprintAuthority
  }
}
