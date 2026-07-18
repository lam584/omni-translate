import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const script = fs.readFileSync('scripts/testing/run-watch-mode-live.ps1', 'utf8');

test('SkipDesktopLaunch start failure is recorded before readiness, playback, recording, and STT', () => {
  const startFailureIndex = script.indexOf('$criticalFailureMessage = "start watch mode via existing desktop shell failed:');
  const readinessGateIndex = script.indexOf('if (-not $criticalFailureMessage) {', startFailureIndex);
  const recordingGateIndex = script.indexOf('if (-not $criticalFailureMessage) {', readinessGateIndex + 1);
  const recorderStepIndex = script.indexOf('start physical output content recording', recordingGateIndex);
  const playbackStepIndex = script.indexOf('play watch-mode media', readinessGateIndex);
  const contentSttIndex = script.indexOf('transcribe and compare physical output content', recorderStepIndex);
  const saveArtifactsIndex = script.indexOf('Save-WatchModeRunArtifacts $outputDir $driverProbe $playbackStep $steps $runMarker $startedAtLocal $criticalFailureMessage');

  assert.notEqual(startFailureIndex, -1, 'runner must record SkipDesktopLaunch start failures');
  assert.notEqual(readinessGateIndex, -1, 'runner must gate readiness after a critical start failure');
  assert.notEqual(recordingGateIndex, -1, 'runner must gate recording and playback after readiness failures');
  assert.notEqual(recorderStepIndex, -1, 'runner must keep physical output recording inside the critical-failure gate');
  assert.notEqual(playbackStepIndex, -1, 'runner must keep playback inside the critical-failure gate');
  assert.notEqual(contentSttIndex, -1, 'runner must keep physical output content STT inside the critical-failure gate');
  assert.notEqual(saveArtifactsIndex, -1, 'runner must persist the critical failure into failure.json');
  assert(startFailureIndex < readinessGateIndex);
  assert(readinessGateIndex < recordingGateIndex);
  assert(recordingGateIndex < recorderStepIndex);
  assert(recorderStepIndex < playbackStepIndex);
  assert(playbackStepIndex < contentSttIndex);
  assert(playbackStepIndex < saveArtifactsIndex);
});

test('SkipDesktopLaunch CLI start fails fast when Omni preconnect fails', () => {
  const startFunctionIndex = script.indexOf('function Invoke-StartWatchModeViaTauriCli');
  const preconnectIndex = script.indexOf('$preconnect = Invoke-ProcessWithTimeout', startFunctionIndex);
  const preconnectGateIndex = script.indexOf('if ($preconnect.exitCode -ne 0 -or $preconnect.timedOut)', preconnectIndex);
  const preconnectThrowIndex = script.indexOf('preconnect_omni_realtime failed. ExitCode=', preconnectGateIndex);
  const modelDetailIndex = script.indexOf('ModelId=$WatchModelId', preconnectThrowIndex);
  const deviceDetailIndex = script.indexOf('PhysicalDeviceId=$PhysicalDeviceId', preconnectThrowIndex);
  const stdoutDetailIndex = script.indexOf('Stdout=$($preconnect.stdout)', preconnectThrowIndex);
  const stderrDetailIndex = script.indexOf('Stderr=$($preconnect.stderr)', preconnectThrowIndex);
  const bridgeIndex = script.indexOf('$bridge = Invoke-ProcessWithTimeout', preconnectIndex);

  assert.notEqual(startFunctionIndex, -1, 'runner must define the SkipDesktopLaunch CLI start helper');
  assert.notEqual(preconnectIndex, -1, 'runner must call preconnect_omni_realtime before route start');
  assert.notEqual(preconnectGateIndex, -1, 'runner must check preconnect exit code and timeout');
  assert.notEqual(preconnectThrowIndex, -1, 'runner must preserve the preconnect command name in failure output');
  assert.notEqual(modelDetailIndex, -1, 'preconnect failure must include the watch model id');
  assert.notEqual(deviceDetailIndex, -1, 'preconnect failure must include the physical device id');
  assert.notEqual(stdoutDetailIndex, -1, 'preconnect failure must include stdout');
  assert.notEqual(stderrDetailIndex, -1, 'preconnect failure must include stderr');
  assert.notEqual(bridgeIndex, -1, 'runner must start the bridge after preconnect succeeds');
  assert(preconnectIndex < preconnectGateIndex);
  assert(preconnectGateIndex < preconnectThrowIndex);
  assert(preconnectThrowIndex < bridgeIndex);
});

test('readiness timeout reports marker state and diagnostic log excerpts', () => {
  const logReadIndex = script.indexOf('Get-Content -LiteralPath $Path -Raw -Encoding UTF8');
  const diagnosticHelperIndex = script.indexOf('function Get-DiagnosticLogLines');
  const diagnosticLocalIndex = script.indexOf('$matchedLines = @()', diagnosticHelperIndex);
  const forbiddenMatchesLocalIndex = script.indexOf('$matches = @()', diagnosticHelperIndex);
  const waitFunctionIndex = script.indexOf('function Wait-AppLogPattern');
  const markerFoundIndex = script.indexOf('$markerFound = $false', waitFunctionIndex);
  const readinessLinesIndex = script.indexOf('$readinessLines = Get-DiagnosticLogLines', waitFunctionIndex);
  const providerLinesIndex = script.indexOf('$providerLines = Get-DiagnosticLogLines', waitFunctionIndex);
  const tailLinesIndex = script.indexOf('$tailLines = Get-DiagnosticLogLines', waitFunctionIndex);
  const throwIndex = script.indexOf('timed out waiting for app log pattern. Pattern=$Pattern TimeoutSeconds=$TimeoutSeconds Path=$Path MarkerFound=$markerFound RunMarker=$RunMarker', waitFunctionIndex);
  const readinessDetailIndex = script.indexOf('ReadinessLines=$(Format-DiagnosticLogLines $readinessLines)', throwIndex);
  const providerDetailIndex = script.indexOf('ProviderLines=$(Format-DiagnosticLogLines $providerLines)', throwIndex);
  const tailDetailIndex = script.indexOf('Tail=$(Format-DiagnosticLogLines $tailLines)', throwIndex);

  assert.notEqual(logReadIndex, -1, 'runner must read app logs as UTF-8 for diagnostics');
  assert.notEqual(diagnosticHelperIndex, -1, 'runner must define log excerpt helper');
  assert.notEqual(diagnosticLocalIndex, -1, 'diagnostic helper must avoid the PowerShell automatic $Matches variable');
  assert.equal(forbiddenMatchesLocalIndex, -1, 'diagnostic helper must not shadow the automatic $Matches hashtable');
  assert.notEqual(waitFunctionIndex, -1, 'runner must define readiness wait helper');
  assert.notEqual(markerFoundIndex, -1, 'readiness timeout must report whether the run marker was found');
  assert.notEqual(readinessLinesIndex, -1, 'readiness timeout must capture readiness/preconnect lines');
  assert.notEqual(providerLinesIndex, -1, 'readiness timeout must capture provider error lines');
  assert.notEqual(tailLinesIndex, -1, 'readiness timeout must capture a log tail');
  assert.notEqual(throwIndex, -1, 'readiness timeout must include timeout, path, pattern, and marker state');
  assert.notEqual(readinessDetailIndex, -1, 'readiness timeout must include readiness excerpts');
  assert.notEqual(providerDetailIndex, -1, 'readiness timeout must include provider excerpts');
  assert.notEqual(tailDetailIndex, -1, 'readiness timeout must include tail excerpts');
});

test('live runner scopes log readers from the first run marker', () => {
  const helperIndex = script.indexOf('function Get-LogTextAfterMarker');
  const firstMarkerIndex = script.indexOf('$markerIndex = $text.IndexOf($RunMarker)', helperIndex);
  const subtitleReaderIndex = script.indexOf('function Get-RecentSubtitleText');
  const finalSegmentReaderIndex = script.indexOf('function Get-RecentFinalSegmentTranslationText');
  const queueReaderIndex = script.indexOf('function Read-SubtitleQueueTimeline');
  const providerReaderIndex = script.indexOf('function Read-RecentProviderSummary');
  const routeReaderIndex = script.indexOf('function Read-WatchModeTranslationRoute');
  const speechReaderIndex = script.indexOf('function Read-SpeechSegmentationSummary');

  assert.notEqual(helperIndex, -1, 'runner must define a shared run-marker scoping helper');
  assert.notEqual(firstMarkerIndex, -1, 'runner must scope from the first marker emitted for the run');
  assert.equal(script.includes('LastIndexOf($RunMarker)'), false, 'runner must not scope from the last marker');
  for (const index of [
    subtitleReaderIndex,
    finalSegmentReaderIndex,
    queueReaderIndex,
    providerReaderIndex,
    routeReaderIndex,
    speechReaderIndex,
  ]) {
    assert.notEqual(index, -1, 'runner must define each app-log reader');
    assert.notEqual(
      script.indexOf('Get-LogTextAfterMarker', index),
      -1,
      'app-log readers must use the shared first-marker helper',
    );
  }
});

test('live runner parses escaped and multiline translated text fields', () => {
  const quotedTranslationPattern = String.raw`translated="((?:\\.|[^"\\])*)"`;
  const quotedJsonPattern = String.raw`"translatedText"\s*:\s*"((?:\\.|[^"\\])*)"`;
  const transWritePattern = String.raw`\[TRANS_WRITE\]\s+cue_id=(omni-cue-\d+)\s+rank=(\w+)\s+seq=(\d+)\s+translated="((?:\\.|[^"\\])*)"`;

  assert.notEqual(script.indexOf(quotedTranslationPattern), -1, 'subtitle text parser must accept escaped quoted strings');
  assert.notEqual(script.indexOf(quotedJsonPattern), -1, 'JSON translatedText parser must accept escaped quoted strings');
  assert.notEqual(script.indexOf(transWritePattern), -1, 'TRANS_WRITE parser must accept escaped quoted strings');
  assert.match(script, /\$value = \$value -replace '\\\\n', "`n"/, 'translation parser must unescape newline markers');
  assert.match(script, /\$value = \$value -replace '\\\\"', '\"'/, 'translation parser must unescape quotes');
});

test('bridge source probe failure persists diagnostics without fake state', () => {
  const probeFunctionIndex = script.indexOf('function Invoke-BridgeSourceProbe');
  const diagnosticsPathIndex = script.indexOf('$diagnosticsPath = Join-Path $OutputDirectory "bridge-source-probe-diagnostics.json"', probeFunctionIndex);
  const phaseIndex = script.indexOf('phase = $phase', diagnosticsPathIndex);
  const sourcePipeIndex = script.indexOf('sourcePipeName = "$pipeName-source"', diagnosticsPathIndex);
  const stateErrorIndex = script.indexOf('stateQueryError = $stateQueryError', diagnosticsPathIndex);
  const callerDiagnosticIndex = script.indexOf('$bridgeDiagnosticsPath = Join-Path $outputDir "bridge-source-probe-diagnostics.json"');
  const snapshotGuardIndex = script.indexOf('if ($bridgeProbe -and $bridgeProbe.state -and $bridgeProbe.sourceFrame)');
  const probePassedFalseIndex = script.indexOf('probePassed = $false', snapshotGuardIndex);

  assert.notEqual(probeFunctionIndex, -1, 'runner must define bridge source probe helper');
  assert.notEqual(diagnosticsPathIndex, -1, 'bridge source probe must write a diagnostics file');
  assert.notEqual(phaseIndex, -1, 'bridge diagnostics must include the failed phase');
  assert.notEqual(sourcePipeIndex, -1, 'bridge diagnostics must include source pipe name');
  assert.notEqual(stateErrorIndex, -1, 'bridge diagnostics must include state query failure');
  assert.notEqual(callerDiagnosticIndex, -1, 'runner must preserve structured bridge diagnostics on step failure');
  assert.notEqual(snapshotGuardIndex, -1, 'snapshots must only read bridge state after a successful source frame');
  assert.notEqual(probePassedFalseIndex, -1, 'snapshots must mark failed bridge probes explicitly');
});

test('physical output recorder start failure is critical and stops playback/STT', () => {
  const recorderAssignIndex = script.indexOf('$physicalOutputRecorderStep = Invoke-Step "start physical output content recording"');
  const recorderStepPersistIndex = script.indexOf('$steps += $physicalOutputRecorderStep', recorderAssignIndex);
  const recorderFailureGateIndex = script.indexOf('if (-not $physicalOutputRecorderStep.ok)', recorderStepPersistIndex);
  const recorderCriticalIndex = script.indexOf('$criticalFailureMessage = "start physical output content recording failed:', recorderFailureGateIndex);
  const playbackGateIndex = script.indexOf('if (-not $criticalFailureMessage) {', recorderCriticalIndex);
  const playbackIndex = script.indexOf('play watch-mode media', playbackGateIndex);
  const contentSttIndex = script.indexOf('transcribe and compare physical output content', playbackIndex);
  const saveArtifactsIndex = script.indexOf('Save-WatchModeRunArtifacts $outputDir $driverProbe $playbackStep $steps $runMarker $startedAtLocal $criticalFailureMessage');

  assert.notEqual(recorderAssignIndex, -1, 'runner must capture the physical recorder start step');
  assert.notEqual(recorderStepPersistIndex, -1, 'runner must persist the recorder start step to steps.json');
  assert.notEqual(recorderFailureGateIndex, -1, 'runner must check recorder start failure');
  assert.notEqual(recorderCriticalIndex, -1, 'runner must make recorder start failure a critical failure');
  assert.notEqual(playbackGateIndex, -1, 'runner must gate playback after recorder start failure');
  assert.notEqual(playbackIndex, -1, 'runner must keep playback behind the recorder failure gate');
  assert.notEqual(contentSttIndex, -1, 'runner must keep physical output content STT behind the recorder failure gate');
  assert.notEqual(saveArtifactsIndex, -1, 'runner must persist recorder critical failure into failure.json');
  assert(recorderAssignIndex < recorderStepPersistIndex);
  assert(recorderStepPersistIndex < recorderFailureGateIndex);
  assert(recorderFailureGateIndex < recorderCriticalIndex);
  assert(recorderCriticalIndex < playbackGateIndex);
  assert(playbackGateIndex < playbackIndex);
  assert(playbackIndex < contentSttIndex);
  assert(contentSttIndex < saveArtifactsIndex);
});

test('live runner writes latest watch-mode summary after generating reports', () => {
  const reportGeneratorIndex = script.indexOf('function Invoke-ReportGenerator');
  const latestSummaryFunctionIndex = script.indexOf('function Write-LatestWatchModeSummary');
  const modeGateIndex = script.indexOf('if ($Mode -eq "live")', reportGeneratorIndex);
  const latestSummaryCallIndex = script.indexOf('Write-LatestWatchModeSummary $InputDirectory', modeGateIndex);
  const latestSummaryFileIndex = script.indexOf('"latest-watch-mode-live.json"', latestSummaryFunctionIndex);
  const utf8ReportReadIndex = script.indexOf('Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8', latestSummaryFunctionIndex);

  assert.notEqual(reportGeneratorIndex, -1, 'runner must define report generation');
  assert.notEqual(latestSummaryFunctionIndex, -1, 'runner must define latest summary writer');
  assert.notEqual(modeGateIndex, -1, 'runner must only write latest summary for live reports');
  assert.notEqual(latestSummaryCallIndex, -1, 'runner must write latest summary after live report generation');
  assert.notEqual(latestSummaryFileIndex, -1, 'runner must write latest-watch-mode-live.json');
  assert.notEqual(utf8ReportReadIndex, -1, 'runner must read report.json as UTF-8 before ConvertFrom-Json');
  assert(reportGeneratorIndex < latestSummaryCallIndex);
  assert(latestSummaryFunctionIndex < latestSummaryFileIndex);
});

test('live runner supports explicit watch model override end to end', () => {
  const paramIndex = script.indexOf('[string]$WatchModelId = ""');
  const envFileIndex = script.indexOf('VITE_OMNI_WATCH_MODE_MODEL_ID=$WatchModelId');
  const processEnvIndex = script.indexOf('$env:OMNI_WATCH_MODE_MODEL_ID = $WatchModelId');
  const userEnvIndex = script.indexOf('Set-UserEnvironmentVariable "OMNI_WATCH_MODE_MODEL_ID" $WatchModelId');
  const configOverrideIndex = script.indexOf('Set-WatchModelOnConfig $config $WatchModelId');
  const snapshotModelIndex = script.indexOf('modelId = if ($WatchModelId) { $WatchModelId } else { $null }');
  const latestModelIndex = script.indexOf('modelId = $report.modelId');

  assert.notEqual(paramIndex, -1, 'runner must expose -WatchModelId');
  assert.notEqual(envFileIndex, -1, 'runner must pass model override through .env.local autostart');
  assert.notEqual(processEnvIndex, -1, 'runner must pass model override through process env autostart');
  assert.notEqual(userEnvIndex, -1, 'runner must pass model override through elevated user env autostart');
  assert.notEqual(configOverrideIndex, -1, 'runner must apply model override when starting through Tauri CLI');
  assert.notEqual(snapshotModelIndex, -1, 'runner must persist modelId in snapshots.json');
  assert.notEqual(latestModelIndex, -1, 'runner must persist modelId in latest-watch-mode-live.json');
});

test('live runner captures provider-bound PCM for watch diagnostics', () => {
  const pcmPathIndex = script.indexOf('$providerInputPcmPath = Join-Path $OutputDirectory "provider-input-16k-mono.pcm"');
  const processEnvIndex = script.indexOf('$env:OMNI_WATCH_MODE_PROVIDER_INPUT_PCM_PATH = $providerInputPcmPath');
  const userEnvIndex = script.indexOf('Set-UserEnvironmentVariable "OMNI_WATCH_MODE_PROVIDER_INPUT_PCM_PATH" $providerInputPcmPath');
  const restoreProcessEnvIndex = script.indexOf('$env:OMNI_WATCH_MODE_PROVIDER_INPUT_PCM_PATH = $previousProviderInputPcmPath');
  const restoreUserEnvIndex = script.indexOf('Set-UserEnvironmentVariable "OMNI_WATCH_MODE_PROVIDER_INPUT_PCM_PATH" $previousUserProviderInputPcmPath');

  assert.notEqual(pcmPathIndex, -1, 'runner must define provider input PCM artifact path');
  assert.notEqual(processEnvIndex, -1, 'runner must pass provider input PCM path through process env');
  assert.notEqual(userEnvIndex, -1, 'runner must pass provider input PCM path through elevated user env');
  assert.notEqual(restoreProcessEnvIndex, -1, 'runner must restore process provider PCM env');
  assert.notEqual(restoreUserEnvIndex, -1, 'runner must restore user provider PCM env');
  assert(pcmPathIndex < processEnvIndex);
  assert(processEnvIndex < restoreProcessEnvIndex);
});

test('live runner writes subtitle TTS source to frontend, process, and user autostart env', () => {
  const frontendCleanupIndex = script.indexOf("$_ -notmatch '^VITE_OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE='");
  const frontendEnvIndex = script.indexOf('VITE_OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE=subtitle-tts');
  const previousProcessIndex = script.indexOf('$previousTranslationAudioSource = $env:OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE');
  const processEnvIndex = script.indexOf('$env:OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE = "subtitle-tts"');
  const previousUserIndex = script.indexOf('$previousUserTranslationAudioSource = Get-UserEnvironmentVariable "OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE"');
  const userEnvIndex = script.indexOf('Set-UserEnvironmentVariable "OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE" "subtitle-tts"');
  const restoreProcessIndex = script.indexOf('$env:OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE = $previousTranslationAudioSource');
  const restoreUserIndex = script.indexOf('Set-UserEnvironmentVariable "OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE" $previousUserTranslationAudioSource');

  assert.notEqual(frontendCleanupIndex, -1, 'runner must remove stale frontend translation audio source from .env.local');
  assert.notEqual(frontendEnvIndex, -1, 'runner must write frontend translation audio source into .env.local');
  assert.notEqual(previousProcessIndex, -1, 'runner must capture previous process translation source env');
  assert.notEqual(processEnvIndex, -1, 'runner must set process translation source env');
  assert.notEqual(previousUserIndex, -1, 'runner must capture previous user translation source env');
  assert.notEqual(userEnvIndex, -1, 'runner must set elevated user translation source env');
  assert.notEqual(restoreProcessIndex, -1, 'runner must restore process translation source env');
  assert.notEqual(restoreUserIndex, -1, 'runner must restore elevated user translation source env');
  assert(frontendCleanupIndex < frontendEnvIndex);
  assert(previousProcessIndex < processEnvIndex);
  assert(processEnvIndex < restoreProcessIndex);
  assert(previousUserIndex < userEnvIndex);
  assert(userEnvIndex < restoreUserIndex);
});

test('live runner defaults to full reference-media playback for strict evidence', () => {
  const defaultPlaybackIndex = script.indexOf('[int]$PlaybackSeconds = 0');
  const limitedPlaybackIndex = script.indexOf('if ($PlaybackSeconds -gt 0) {\r\n      $args += @("--max-seconds", "$PlaybackSeconds")');
  const fullSourceTranscriptIndex = script.indexOf('fullMedia = ($PlaybackSeconds -le 0)');
  const cacheFullIndex = script.indexOf('$cacheLimitLabel = if ($PlaybackSeconds -gt 0) { "$PlaybackSeconds-limit" } else { "full" }');

  assert.notEqual(defaultPlaybackIndex, -1, 'runner must default to full media playback');
  assert.notEqual(limitedPlaybackIndex, -1, 'runner must only pass --max-seconds for positive playback seconds');
  assert.notEqual(fullSourceTranscriptIndex, -1, 'runner must mark source transcript as full media when PlaybackSeconds <= 0');
  assert.notEqual(cacheFullIndex, -1, 'runner must separate full-media transcript cache entries');
});

test('matrix runner executes both strict watch models and verifies strict evidence', () => {
  const matrix = fs.readFileSync('scripts/testing/run-watch-mode-live-matrix.ps1', 'utf8');

  assert.match(matrix, /qwen3\.5-omni-flash-realtime/);
  assert.match(matrix, /qwen3\.5-livetranslate-flash-realtime/);
  assert.match(matrix, /WatchModelId = \$model/);
  assert.match(matrix, /WatchModelId = \$model/);
  assert.match(matrix, /PlaybackSeconds = \$PlaybackSeconds/);
  assert.doesNotMatch(matrix, /\$args = @\(/, 'matrix runner must not overwrite PowerShell automatic $args');
  assert.doesNotMatch(matrix, /& \$runScript @runArgs/);
  assert.match(matrix, /\$runnerParameters = @\{/);
  assert.match(matrix, /\$runnerParameters\.AllowElevatedDesktopLaunch = \$true/);
  assert.match(matrix, /& \$runScript @runnerParameters @RunnerArgs/);
  assert.match(matrix, /@RunnerArgs/);
  assert.match(matrix, /verify-watch-mode-evidence\.mjs --root \$OutputRoot --strict --models/);
});

test('live runner forces watch virtual-driver and mixed physical output config for CLI route starts', () => {
  const helperIndex = script.indexOf('function Ensure-ObjectProperty');
  const secondaryConfigIndex = script.indexOf('function Set-WatchModeSecondaryConfig');
  const feedbackIndex = script.indexOf('$Config.devices.feedbackLoopPrevention = "virtual-driver"', secondaryConfigIndex);
  const keepOriginalIndex = script.indexOf('$mixControl.keepOriginalAudio = $true', secondaryConfigIndex);
  const translatedAudioIndex = script.indexOf('$mixControl.translatedAudioEnabled = $true', secondaryConfigIndex);
  const monitorModeIndex = script.indexOf('$mixControl.monitorMode = "original-and-translated"', secondaryConfigIndex);
  const outputTargetIndex = script.indexOf('$Config.speech.outputTarget = "speaker"', secondaryConfigIndex);
  const cliStartIndex = script.indexOf('Invoke-StartWatchModeViaTauriCli');
  const cliSecondaryConfigIndex = script.indexOf('Set-WatchModeSecondaryConfig $config $SubtitleTranslationModelId $InboundSecondaryAudioModelId', cliStartIndex);

  assert.notEqual(helperIndex, -1, 'runner must safely create nested config objects before setting watch mix config');
  assert.notEqual(secondaryConfigIndex, -1, 'runner must centralize secondary watch route config');
  assert.notEqual(feedbackIndex, -1, 'CLI route config must force virtual-driver feedback prevention');
  assert.notEqual(keepOriginalIndex, -1, 'CLI route config must keep original audio');
  assert.notEqual(translatedAudioIndex, -1, 'CLI route config must enable translated audio');
  assert.notEqual(monitorModeIndex, -1, 'CLI route config must monitor original and translated output');
  assert.notEqual(outputTargetIndex, -1, 'CLI route config must target the physical speaker');
  assert.notEqual(cliSecondaryConfigIndex, -1, 'CLI route start must apply the shared secondary watch config');
  assert(helperIndex < secondaryConfigIndex);
  assert(secondaryConfigIndex < cliSecondaryConfigIndex);
});

test('live runner records physical output evidence in the required order', () => {
  const physicalProbeIndex = script.indexOf('Invoke-Step "physical output loopback probe"');
  const setDesktopOutputIndex = script.indexOf('Set-DesktopPhysicalPlaybackOverride (Get-PhysicalOutputResolvedDeviceId $physicalOutputProbe)', physicalProbeIndex);
  const resolvedDeviceIndex = script.indexOf('$resolvedPhysicalDeviceId = Get-PhysicalOutputResolvedDeviceId $physicalOutputProbe', physicalProbeIndex);
  const desktopStartIndex = script.indexOf('Start-WatchModeDesktopShell $outputDir $runMarker $resolvedPhysicalDeviceId', resolvedDeviceIndex);
  const cliStartIndex = script.indexOf('Invoke-StartWatchModeViaTauriCli $desktopProcess $resolvedPhysicalDeviceId', desktopStartIndex);
  const recorderStartIndex = script.indexOf('Start-PhysicalOutputContentRecorder $outputDir $resolvedPhysicalDeviceId', desktopStartIndex);
  const playbackIndex = script.indexOf('play watch-mode media', recorderStartIndex);
  const sourceTranscriptIndex = script.indexOf('transcribe source media reference', playbackIndex);
  const recorderCompleteIndex = script.indexOf('complete physical output content recording', sourceTranscriptIndex);
  const contentSttIndex = script.indexOf('Invoke-PhysicalOutputContentStt $outputDir $physicalOutputRecordingStep.result', recorderCompleteIndex);
  const snapshotReadIndex = script.indexOf('Get-Content -LiteralPath $physicalOutputContentPath -Raw -Encoding UTF8 | ConvertFrom-Json');

  assert.notEqual(physicalProbeIndex, -1, 'runner must probe physical output before launching the desktop route');
  assert.notEqual(setDesktopOutputIndex, -1, 'runner must write the resolved physical output to desktop env');
  assert.notEqual(resolvedDeviceIndex, -1, 'runner must resolve the physical playback endpoint from the probe');
  assert.notEqual(desktopStartIndex, -1, 'runner must pass the resolved physical endpoint to desktop launch');
  assert.notEqual(cliStartIndex, -1, 'runner must pass the resolved physical endpoint to SkipDesktopLaunch CLI route start');
  assert.notEqual(recorderStartIndex, -1, 'runner must pass the resolved physical endpoint to the content recorder');
  assert.notEqual(playbackIndex, -1, 'runner must play media after starting the physical output recorder');
  assert.notEqual(sourceTranscriptIndex, -1, 'runner must create the source transcript before comparing physical output content');
  assert.notEqual(recorderCompleteIndex, -1, 'runner must complete recording after playback and tail observation');
  assert.notEqual(contentSttIndex, -1, 'runner must run physical output content STT after recording completes');
  assert.notEqual(snapshotReadIndex, -1, 'snapshots must consume physical-output-content.json as UTF-8');
  assert(physicalProbeIndex < resolvedDeviceIndex);
  assert(resolvedDeviceIndex < desktopStartIndex);
  assert(desktopStartIndex < recorderStartIndex);
  assert(recorderStartIndex < playbackIndex);
  assert(playbackIndex < sourceTranscriptIndex);
  assert(sourceTranscriptIndex < recorderCompleteIndex);
  assert(recorderCompleteIndex < contentSttIndex);
});

test('live runner passes secondary subtitle/TTS config through env and CLI', () => {
  assert.match(script, /\[string\]\$SubtitleTranslationModelId = "template-dashscope-realtime::qwen3\.6-flash-2026-04-16"/);
  assert.match(script, /\[string\]\$InboundSecondaryAudioModelId = "template-dashscope-realtime::qwen3\.5-omni-plus-realtime"/);
  assert.match(script, /VITE_OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID=\$SubtitleTranslationModelId/);
  assert.match(script, /VITE_OMNI_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID=\$InboundSecondaryAudioModelId/);
  assert.match(script, /VITE_OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE=subtitle-tts/);
  assert.match(script, /\$env:OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID = \$SubtitleTranslationModelId/);
  assert.match(script, /\$env:OMNI_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID = \$InboundSecondaryAudioModelId/);
  assert.match(script, /\$env:OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE = "subtitle-tts"/);
  assert.match(script, /Set-UserEnvironmentVariable "OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID" \$SubtitleTranslationModelId/);
  assert.match(script, /Set-UserEnvironmentVariable "OMNI_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID" \$InboundSecondaryAudioModelId/);
  assert.match(script, /Set-UserEnvironmentVariable "OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE" "subtitle-tts"/);
  assert.match(script, /Set-WatchModeSecondaryConfig \$config \$SubtitleTranslationModelId \$InboundSecondaryAudioModelId/);
});
