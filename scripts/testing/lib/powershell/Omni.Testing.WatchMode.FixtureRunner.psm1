#requires -Version 5.1
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Configuration.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Provider.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Report.psm1') -Force -DisableNameChecking

function Invoke-WatchModeFixtureRun {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)]$Request,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
  )
  $workspaceRoot = [string]$Context.paths.workspaceRoot
  $feedbackMode = [string]$Request.feedbackMode
  $modelId = [string]$Request.model.id
  $protocol = [string]$Request.model.protocol
  $paidAuthorityEnabled = [string]$Request.authorityMode -in @('strict-paid', 'incident-replay-plus')
  $fixtureRoot = Join-Path $workspaceRoot 'scripts/testing/fixtures/watch-mode-live'
  $fixtureDirectory = Join-Path $fixtureRoot 'pass'

  $variants = foreach ($mode in @('process-exclusion', 'virtual-driver', 'echo-cancel')) {
    $configPath = Join-Path $workspaceRoot 'apps/desktop/src-tauri/defaults/app-config.default.json'
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Set-WatchModelOnConfig $config $modelId $protocol $paidAuthorityEnabled
    Set-WatchModeSecondaryConfig `
      $config `
      ([string]$Request.model.subtitleModelId) `
      ([string]$Request.model.secondaryAudioModelId) `
      $mode `
      ([string]$Request.model.subtitleTranslationMode)
    if ($config.devices.feedbackLoopPrevention -ne $mode) {
      throw "dry-run feedback config injection mismatch: requested=$mode injected=$($config.devices.feedbackLoopPrevention)"
    }
    [ordered]@{
      requested = $mode
      injected = $config.devices.feedbackLoopPrevention
      outputSpeechEnabled = $config.devices.outputSpeechEnabled
      monitorMode = $config.devices.inboundRoute.mixControl.monitorMode
    }
  }
  [ordered]@{
    generatedAt = Get-Date -Format o
    selectedFeedbackLoopPrevention = $feedbackMode
    variants = @($variants)
  } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'config-injection.json') -Encoding UTF8
  Write-Host "==> dry-run feedback config injection verified: process-exclusion, virtual-driver, echo-cancel (selected=$feedbackMode)"

  $requiredFiles = @('run-collection.json', 'run-metadata.json', 'fixture-evidence.raw.json', 'app.log', 'bridge-service.log')
  $missingFiles = @($requiredFiles | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $fixtureDirectory $_) -PathType Leaf)
  })
  if ($missingFiles.Count -gt 0) {
    Write-Host "==> generating built-in Watch Mode dry-run fixture: $fixtureDirectory"
    node ./scripts/testing/generate-watch-mode-live-fixtures.mjs --root $fixtureRoot --fixture pass
    if ($LASTEXITCODE -ne 0) { throw "Watch-mode fixture generation failed with exit code $LASTEXITCODE" }
    $missingFiles = @($requiredFiles | Where-Object {
      -not (Test-Path -LiteralPath (Join-Path $fixtureDirectory $_) -PathType Leaf)
    })
  }
  if ($missingFiles.Count -gt 0) {
    throw "Watch-mode fixture is missing required files under $fixtureDirectory`: $($missingFiles -join ', ')"
  }
  Get-ChildItem -LiteralPath $fixtureDirectory | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $OutputDirectory -Recurse -Force
  }

  $collectionPath = Join-Path $OutputDirectory 'run-collection.json'
  $collection = Get-Content -LiteralPath $collectionPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $evidencePath = Join-Path $OutputDirectory ([string]$collection.artifacts.fixtureEvidence)
  $evidence = Get-Content -LiteralPath $evidencePath -Raw -Encoding UTF8 | ConvertFrom-Json
  $evidence | Add-Member -NotePropertyName feedbackLoopPrevention -NotePropertyValue $feedbackMode -Force
  $deviceClass = [string]$Request.physicalDevice.class
  $profileId = [string]$Request.physicalDevice.profileId
  $device = switch ($deviceClass) {
    'usb' { [pscustomobject]@{ id = "USB\VID_1234&PID_5678\dry-run-$profileId"; name = 'Dry-run USB Speakers'; signals = @('USB\VID_1234&PID_5678', 'USB Audio Device') } }
    'bluetooth' { [pscustomobject]@{ id = "BTHENUM\DEV_DRYRUN_$profileId"; name = 'Dry-run Bluetooth A2DP Speakers'; signals = @('BTHENUM\DEV_DRYRUN', 'Bluetooth A2DP') } }
    default { [pscustomobject]@{ id = "HDAUDIO\FUNC_01&VEN_DRYRUN\$profileId"; name = 'Dry-run Default Speakers'; signals = @('HDAUDIO\FUNC_01', 'High Definition Audio') } }
  }
  $evidence | Add-Member -NotePropertyName deviceEvidence -NotePropertyValue ([pscustomobject]@{
    profileId = $profileId
    deviceClass = $deviceClass
    requestedDeviceId = [string]$Request.physicalDevice.id
    resolvedDeviceId = $device.id
    resolvedDeviceName = $device.name
    classificationSignals = @($device.signals)
    classificationSource = 'fixture'
    routeEvidenceSource = 'fixture'
    verified = $false
    fixtureOnly = $true
  }) -Force
  if ($feedbackMode -eq 'process-exclusion') {
    $evidence.driver = $null
    $evidence.wasapi = $null
    $fingerprint = [pscustomobject]@{
      bridgeProcessId = 4242; excludedProcessId = 4242; externalPlayerProcessId = 5001
      bridgeChildPlayerProcessId = 5002; bridgeChildParentProcessId = 4242; bridgeChildExitCode = 0
      sourceCaptureMode = 'process-exclusion'; captureBackend = 'wasapi-process-exclusion'; processLoopbackStatus = 'ready'
      physicalTranslationComponent = 0.08; physicalExternalComponent = 0.16; physicalBridgeChildComponent = 0.16
      sourceTranslationComponent = 0.0004; sourceExternalComponent = 0.15; sourceBridgeChildComponent = 0.0002
      sourceToPhysicalTranslationRatio = 0.005; sourceTranslationToExternalRatio = 0.0027
      sourceToPhysicalBridgeChildRatio = 0.00125; translationComponentLimit = 0.003
      sourceToPhysicalRatioLimit = 0.05; sourceToExternalRatioLimit = 0.05
    }
    $evidence.physicalOutput = [pscustomobject]@{
      passed = $true; status = 'passed'; probeKind = 'process-exclusion-fingerprint'; fixtureOnly = $true
      physicalPlaybackDeviceId = 'dry-run-speaker'; resolvedPhysicalPlaybackDeviceId = 'dry-run-speaker'
      resolvedPhysicalPlaybackDeviceName = 'Dry-run Speakers'; playbackFramesWrittenBefore = 0
      playbackFramesWrittenAfter = 96000; capturedFrames = 134400; rms = 0.2; toneComponent = 0.08
      invalidSamples = 0; processExclusionFingerprint = $fingerprint
    }
    $evidence.bridge = [pscustomobject]@{
      probePassed = $true; bridgeState = 'running'; driverHealth = 'not-installed'
      sourceCaptureMode = 'process-exclusion'; captureBackend = 'wasapi-process-exclusion'
      processLoopbackSupported = $true; processLoopbackStatus = 'ready'; windowsBuildNumber = 26100
      processLoopbackMinimumWindowsBuild = 20348; excludedProcessId = 4242; processLoopbackFailureDetail = $null
      sourceSubscriberActive = $false; sourceReadCalls = 0; sourceFramePayloadBytes = 0; droppedFrameCount = 0
    }
  }
  $collection.request = $Request
  $collection.collectionStatus = 'completed'
  $evidence | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $evidencePath -Encoding UTF8
  $collection | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $collectionPath -Encoding UTF8
  Invoke-WatchModeReportGenerator $OutputDirectory 'dry-run' $workspaceRoot
  $reportPath = Join-Path $OutputDirectory 'report.json'
  $report = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($report.verdict -ne 'passed') {
    throw "Watch-mode dry-run fixture report did not pass: verdict=$($report.verdict) failureLayer=$($report.failureLayer) report=$reportPath"
  }
  Write-Output $OutputDirectory
}

Export-ModuleMember -Function 'Invoke-WatchModeFixtureRun'
