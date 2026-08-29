// Split from watch-mode-report.test.mjs (kept as the package.json entry that
// imports this file): translation-route classification (native/secondary,
// preconnect, fallback), app-layer subtitle evidence, subtitle queue ordering
// gates, the echo-cancel feedback variant and runner-failure attribution.
import assert from 'node:assert/strict';
import test from 'node:test';

import { renderMarkdownReport } from './watch-mode-report.mjs';
import {
  classify,
  healthyApp,
  healthyAppLog,
  healthyBridge,
  healthyDriver,
  healthyPhysicalOutput,
  healthyPhysicalOutputContent,
  healthyProcessExclusionFingerprint,
  healthyProcessExclusionBridge,
  healthyProvider,
  healthyWatchSessionReport,
  healthyWasapi,
} from './watch-mode-report-test-helpers.mjs';

test('classifies healthy watch-mode evidence as passed', () => {
  const report = classify();

  assert.equal(report.verdict, 'passed');
  assert.equal(report.failureLayer, null);
  assert.equal(report.suspectFiles.length, 0);
});

test('accepts frozen driver readiness projection without legacy tone counters', () => {
  const readiness = {
    InstalledDriverAuthority: {
      installedServiceState: 'Running',
      installedSysSignatureStatus: 'Valid',
      packageCatalogSignatureStatus: 'Valid',
    },
    WasapiEndpointId: '{0.0.0.00000000}.{virtual-speaker}',
    providerCalls: 0,
  };
  const report = classify({ driver: readiness, wasapi: readiness });
  assert.equal(report.layers.driver.status, 'passed');
  assert.equal(report.layers.wasapi.status, 'passed');
});

test('requires a saved Watch report with a complete visible three-stage cue', () => {
  const missing = classify({ watchSessionReport: null });
  assert.equal(missing.failureLayer, 'app');
  assert.match(missing.failureReason, /watch session report evidence is missing/);

  const unrendered = classify({
    watchSessionReport: {
      ...healthyWatchSessionReport,
      summary: {
        ...healthyWatchSessionReport.summary,
        unrenderedCueCount: 1,
      },
      cues: [{
        ...healthyWatchSessionReport.cues[0],
        comparisonStatus: 'not-rendered',
        renderedFirstAtMs: null,
        issues: [{ code: 'publish-without-render' }],
      }],
    },
  });
  assert.equal(unrendered.failureLayer, 'app');
  assert.match(unrendered.failureReason, /without visible rendering/);
});

test('treats an explicit interrupted source tail as a session warning, not an app failure', () => {
  const interruptedTail = {
    cueId: 'cue-interrupted-tail',
    revision: 1,
    comparisonStatus: 'not-published',
    llmFirstAtMs: null,
    publishedFirstAtMs: null,
    renderedFirstAtMs: null,
    llmFirstToRenderMs: null,
    publishToRenderMs: null,
    issues: [{
      category: 'session',
      code: 'session-ended-before-model-output',
      severity: 'warning',
    }],
  };
  const report = classify({
    watchSessionReport: {
      ...healthyWatchSessionReport,
      cues: [...healthyWatchSessionReport.cues, interruptedTail],
    },
  });

  assert.equal(report.verdict, 'passed');
  assert.equal(report.failureLayer, null);

  const realError = classify({
    watchSessionReport: {
      ...healthyWatchSessionReport,
      cues: [
        ...healthyWatchSessionReport.cues,
        {
          ...interruptedTail,
          issues: [{
            category: 'model',
            code: 'model-no-output',
            severity: 'error',
          }],
        },
      ],
    },
  });
  assert.equal(realError.failureLayer, 'app');
  assert.match(realError.failureReason, /explicit cue issue/);
});

test('does not fail on retry errors retained only by superseded revisions', () => {
  const report = classify({
    watchSessionReport: {
      ...healthyWatchSessionReport,
      cues: [
        ...healthyWatchSessionReport.cues,
        {
          ...healthyWatchSessionReport.cues[0],
          cueId: 'cue-old-revision',
          comparisonStatus: 'superseded',
          issues: [{
            category: 'model',
            code: 'retry-exhausted',
            severity: 'error',
          }],
        },
      ],
    },
  });
  assert.equal(report.verdict, 'passed');
  assert.equal(report.failureLayer, null);
});

test('does not fail a fully rendered cue whose retry error was recovered by a final output', () => {
  const report = classify({
    watchSessionReport: {
      ...healthyWatchSessionReport,
      cues: [{
        ...healthyWatchSessionReport.cues[0],
        comparisonStatus: 'formatting-only',
        issues: [{
          category: 'model',
          code: 'retry-exhausted',
          severity: 'error',
        }],
      }],
    },
  });
  assert.equal(report.verdict, 'passed');
  assert.equal(report.failureLayer, null);
});

test('report records explicit git HEAD and clean-worktree provenance', () => {
  const provenance = {
    schemaVersion: 1,
    source: 'git',
    captureStatus: 'captured',
    headCommit: 'fixture-exact-head',
    worktreeClean: true,
    dirtyEntryCount: 0,
  };
  const report = classify({ provenance });

  assert.deepEqual(report.provenance, provenance);
  assert.equal(report.commit, provenance.headCommit);
});

test('keeps cue timeline retention warnings non-blocking after a complete render', () => {
  const report = classify({
    watchSessionReport: {
      ...healthyWatchSessionReport,
      cues: [{
        ...healthyWatchSessionReport.cues[0],
        issues: [{
          category: 'data',
          code: 'cue-events-truncated',
          severity: 'warning',
        }],
      }],
    },
  });

  assert.equal(report.verdict, 'passed');
  assert.equal(report.failureLayer, null);
});

test('fails the app gate for a session-level speaker playback failure', () => {
  const report = classify({
    feedbackLoopPrevention: 'echo-cancel',
    watchSessionReport: {
      ...healthyWatchSessionReport,
      issues: [{
        category: 'output',
        code: 'speaker-playback-failed',
        severity: 'error',
      }],
    },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'app');
  assert.match(report.failureReason, /session-level error.*speaker-playback-failed/i);
});

test('native route does not require secondary segment TTS evidence', () => {
  const report = classify({
    translationRoute: 'native',
    appLogText: healthyAppLog,
  });

  assert.equal(report.verdict, 'passed');
  assert.equal(report.translationRoute, 'native');
  assert.equal(report.layers.speechSegmentation.status, 'passed');
});

test('secondary route requires final segment TTS playback evidence', () => {
  const report = classify({
    translationRoute: 'secondary',
    appLogText: healthyAppLog,
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'speechSegmentation');
  assert.match(report.failureReason, /segment TTS/i);
});

test('secondary route passes with segment TTS playback evidence', () => {
  const report = classify({
    translationRoute: 'secondary',
    appLogText: [
      healthyAppLog,
      'speech.segment_tts_queued | cue=cue-1 segmentIndex=0 segmentMode=true sourceChars=12 translatedChars=6',
      'speech.segment_tts_requested | cue=cue-1 segmentIndex=0 translatedChars=6 provider=provider model=tts',
      'speech.segment_playback_written | cue=cue-1 segmentIndex=0 frames=24000 sampleRateHz=24000 channels=1 outputLevel=50 deviceId=real-speaker',
    ].join('\n'),
  });

  assert.equal(report.verdict, 'passed');
  assert.equal(report.translationRoute, 'secondary');
  assert.equal(report.layers.speechSegmentation.data.queuedSegments, 1);
});

test('secondary route fails when Omni preconnect reuse evidence is missing', () => {
  const report = classify({
    translationRoute: 'secondary',
    appLogText: [
      'watch_mode.omni_preconnect_started detail=direction=inbound',
      'watch route ensured subtitle overlay visible detail=label=subtitle-overlay visible=true',
      'subtitle cue appended id=cue-1',
      'model_trace finished status=ok elapsedMs=1200',
      'speech.segment_tts_queued | cue=cue-1 segmentIndex=0 segmentMode=true sourceChars=12 translatedChars=6',
      'speech.segment_playback_written | cue=cue-1 segmentIndex=0 frames=24000 sampleRateHz=24000 channels=1 outputLevel=50 deviceId=real-speaker',
    ].join('\n'),
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'app');
  assert.match(report.failureReason, /reuse the Omni preconnect/i);
});

test('native fallback log classifies route as native and does not require secondary segment TTS', () => {
  const report = classify({
    translationRoute: 'secondary',
    appLogText: [
      healthyAppLog,
      'watch_mode.subtitle_translate_config_failed detail=phase=route subtitleTranslationMode=secondary fallback=native reason=provider_not_found',
      'watch_mode.subtitle_translate_fallback_native_applied detail=reason=provider_unresolved translationAudioSource=omni-native',
    ].join('\n'),
  });

  assert.equal(report.verdict, 'passed');
  assert.equal(report.translationRoute, 'native');
  assert.equal(report.layers.speechSegmentation.status, 'passed');
});

test('classifies subtitle queue final translation order inversions as app failure', () => {
  const report = classify({
    app: {
      ...healthyApp,
      subtitleQueue: {
        eventCount: 8,
        cueOrderInversions: 1,
        duplicateFinalTranslations: 0,
      },
    },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'app');
  assert.match(report.failureReason, /out of cue order/);
});

test('classifies any duplicate final translation as app failure', () => {
  const report = classify({
    app: {
      ...healthyApp,
      subtitleQueue: {
        eventCount: 8,
        cueOrderInversions: 0,
        duplicateFinalTranslations: 1,
      },
    },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'app');
  assert.match(report.failureReason, /duplicate final translations/);
});

test('echo-cancel variant skips virtual-driver evidence layers and passes on healthy app evidence', () => {
  const report = classify({
    feedbackLoopPrevention: 'echo-cancel',
    bridge: {
      bridgeState: 'running',
      driverHealth: 'running',
      sourceSubscriberActive: false,
      sourceReadCalls: 0,
      droppedFrameCount: 0,
    },
    physicalOutput: {
      ...healthyPhysicalOutput,
      passed: false,
      rms: 0,
      toneComponent: 0,
    },
  });

  assert.equal(report.verdict, 'passed');
  assert.equal(report.failureLayer, null);
  assert.equal(report.feedbackLoopPrevention, 'echo-cancel');
  for (const layer of ['driver', 'wasapi', 'bridge', 'physicalOutput', 'physicalOutputContent', 'speechSegmentation', 'strictContent']) {
    assert.equal(report.layers[layer].status, 'skipped');
  }
  assert.equal(report.layers.app.status, 'passed');
  assert.equal(report.layers.provider.status, 'passed');
  assert.equal(report.layers.aec.status, 'passed');
  assert.equal(report.layers.aec.data.outputMode, 'text-and-audio');
  assert.equal(report.layers.aec.data.backend, 'webrtc-aec3');
  assert.equal(report.layers.aec.data.maxRender10msFrames, 100);
  assert.equal(report.layers.aec.data.maxProcessedCapture10msFrames, 100);
  assert.equal(report.layers.aec.data.maxErleDb, 20);
  assert.equal(report.layers.aec.data.maxAsrForwardedChunks, 100);
  assert.equal(report.layers.aec.data.maxAsrDeletedChunks, 0);
  assert.equal(report.layers.aec.data.speakerPlaybackSeconds, 1);
  assert.equal(
    report.layers.aec.data.liveScenario.expectedSubtitles.acceptedSource,
    'watch-session-report-cues',
  );
  assert.equal(
    report.layers.aec.data.liveScenario.expectedSubtitles.watchSessionId,
    healthyWatchSessionReport.sessionId,
  );
  assert.deepEqual(
    report.layers.aec.data.liveScenario.expectedSubtitles.acceptedCueIds,
    ['cue-1'],
  );
});

test('process-exclusion passes with real process fingerprint evidence and no driver probes', () => {
  const report = classify({
    feedbackLoopPrevention: 'process-exclusion',
    bridge: healthyProcessExclusionBridge,
    driver: null,
    wasapi: null,
    physicalOutput: healthyProcessExclusionFingerprint,
    bridgeLogText: '',
  });

  assert.equal(report.verdict, 'passed');
  assert.equal(report.failureLayer, null);
  assert.equal(report.feedbackLoopPrevention, 'process-exclusion');
  for (const layer of ['driver', 'wasapi', 'aec']) {
    assert.equal(report.layers[layer].status, 'skipped');
  }
  assert.equal(report.layers.physicalOutput.status, 'passed');
  assert.equal(report.layers.bridge.status, 'passed');
  assert.equal(report.layers.physicalOutputContent.status, 'passed');
  assert.equal(report.layers.app.status, 'passed');
});

test('echo-cancel rejects text-only sessions even when virtual-driver evidence is skipped', () => {
  const report = classify({
    feedbackLoopPrevention: 'echo-cancel',
    appLogText: healthyAppLog.replace('outputMode=text-and-audio', 'outputMode=text-only'),
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'aec');
  assert.match(report.failureReason, /text-and-audio.*text-only/i);
});

test('echo-cancel records runtime ERLE without applying the pure-echo fixture threshold to double-talk', () => {
  const report = classify({
    feedbackLoopPrevention: 'echo-cancel',
    appLogText: healthyAppLog.replace('erleDb=20.0', 'erleDb=14.9'),
  });

  assert.equal(report.verdict, 'passed');
  assert.equal(report.failureLayer, null);
  assert.equal(report.layers.aec.data.maxErleDb, 14.9);
});

test('echo-cancel missing residual telemetry has a stable AEC evidence fingerprint', () => {
  const report = classify({
    feedbackLoopPrevention: 'echo-cancel',
    appLogText: healthyAppLog.replaceAll(/ residualEchoLikelihood=[^ ]+/g, ''),
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'aec');
  assert.equal(report.stableErrorCode, 'aec.residual-echo-likelihood-unavailable');
  assert.equal(report.lifecyclePhase, 'aec-evidence');
});

test('echo-cancel requires the build-time native pure-echo fixture gate', () => {
  const report = classify({
    feedbackLoopPrevention: 'echo-cancel',
    appLogText: healthyAppLog.replace('fixtureVerified=true', 'fixtureVerified=false'),
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'aec');
  assert.match(report.failureReason, /native 15 dB pure-echo fixture gate/i);
});

test('echo-cancel requires submit position and padding from its physical WASAPI render client', () => {
  const report = classify({
    feedbackLoopPrevention: 'echo-cancel',
    appLogText: healthyAppLog
      .replace('renderClock=wasapi-submit-position', 'renderClock=wall-clock-guess')
      .replace(
        'endpointRenderPadding=same-client-get-current-padding',
        'endpointRenderPadding=unavailable',
      ),
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'aec');
  assert.match(report.failureReason, /same-client WASAPI render timing/i);
});

test('echo-cancel rejects a non-WebRTC engine masquerading as the production backend', () => {
  const report = classify({
    feedbackLoopPrevention: 'echo-cancel',
    appLogText: healthyAppLog.replace('backend=webrtc-aec3', 'backend=scripted-test'),
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'aec');
  assert.match(report.failureReason, /linked WebRTC AEC3 backend/i);
});

test('echo-cancel rejects any ASR chunk deletion even when AEC3 metrics look healthy', () => {
  const report = classify({
    feedbackLoopPrevention: 'echo-cancel',
    appLogText: healthyAppLog.replace(
      'asrDeletedChunks=0',
      'asrDeletedChunks=1',
    ),
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'aec');
  assert.match(report.failureReason, /deleted capture chunks/i);
});

test('echo-cancel still rejects historical deletion-counter evidence', () => {
  const report = classify({
    feedbackLoopPrevention: 'echo-cancel',
    appLogText: healthyAppLog.replace(
      'asrDeletedChunks=0',
      'effectiveSuppressedChunks=1',
    ),
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'aec');
  assert.match(report.failureReason, /deleted capture chunks/i);
});

test('echo-cancel surfaces native stats read failures instead of treating them as zero metrics', () => {
  const report = classify({
    feedbackLoopPrevention: 'echo-cancel',
    appLogText: healthyAppLog.replace('statsReadFailures=0', 'statsReadFailures=2'),
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'aec');
  assert.match(report.failureReason, /failed to read native AEC3 statistics 2 times/i);
});

test('echo-cancel requires numeric double-talk frame telemetry from the linked backend', () => {
  const report = classify({
    feedbackLoopPrevention: 'echo-cancel',
    appLogText: healthyAppLog.replace('doubleTalkFrames=12', 'doubleTalkFrames=unavailable'),
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'aec');
  assert.match(report.failureReason, /double-talk frame telemetry is unavailable/i);
});

test('echo-cancel live report rejects missing real three-stage physical-render evidence', () => {
  const report = classify({
    feedbackLoopPrevention: 'echo-cancel',
    appLogText: healthyAppLog
      .split('\n')
      .filter((line) => !line.includes('event=aec_live_scenario_stage'))
      .join('\n'),
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'aec');
  assert.match(report.failureReason, /double-talk, dynamic-delay, and nonlinear physical-render scenario/i);
});

test('echo-cancel live report requires every expected source segment to survive AEC', () => {
  const report = classify({
    feedbackLoopPrevention: 'echo-cancel',
    watchSessionReport: {
      ...healthyWatchSessionReport,
      cues: [{ ...healthyWatchSessionReport.cues[0], sourceText: 'Good morning.' }],
    },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'aec');
  assert.match(report.failureReason, /accept every expected reference-media subtitle segment/i);
  assert.equal(report.layers.aec.data.liveScenario.expectedSubtitles.acceptanceRate < 1, true);
});

test('echo-cancel live report rejects a static delay metric despite staged render requests', () => {
  const report = classify({
    feedbackLoopPrevention: 'echo-cancel',
    appLogText: healthyAppLog.replace('reportedDelayMs=125', 'reportedDelayMs=0'),
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'aec');
  assert.match(report.failureReason, /dynamic-delay injection did not change/i);
});

test('echo-cancel live report rejects a nonlinear label without changed physical PCM', () => {
  const report = classify({
    feedbackLoopPrevention: 'echo-cancel',
    appLogText: healthyAppLog
      .replace('changedSamples=9600 changedRatio=1.000000', 'changedSamples=0 changedRatio=0.000000'),
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'aec');
  assert.match(report.failureReason, /nonlinear physical-render scenario/i);
});

test('echo-cancel keeps a failed virtual-driver probe as non-blocking diagnostics', () => {
  const driverFailure = { error: 'virtual audio endpoint was not found' };
  const bridgeNoise = [
    '2026-01-01 00:00:00.000 [NORMAL] [bridge] - - driver open failed: error=file not found',
    '2026-01-01 00:00:05.000 [NORMAL] [bridge] - - event=source_watchdog workerPhase=driver-open-failed sourceSubscriberActive=false',
  ].join('\n');
  const echoCancel = classify({
    feedbackLoopPrevention: 'echo-cancel',
    driver: driverFailure,
    wasapi: driverFailure,
    bridgeLogText: bridgeNoise,
    physicalOutputContent: null,
    provider: { totalCalls: 197, failedCalls: 13 },
    appLogText: [
      healthyAppLog,
      '[storage] [omni][credential] start action=读取 API Key timeoutMs=5000',
      '[storage] [omni][credential] calling CredReadW target=provider-dashscope',
      '[storage] [omni][credential] CredReadW succeeded target=provider-dashscope',
      '[storage] [omni][credential] finish action=读取 API Key outcome=ok',
      '[ERROR] [subtitle-translate] real application error: response.empty',
    ].join('\n'),
    steps: [{
      schemaVersion: 'watch-mode-step/v2',
      id: 'driver-probe',
      status: 'failed',
      data: null,
      error: { message: driverFailure.error },
    }],
    failure: { message: `driver probe failed: ${driverFailure.error}` },
  });

  assert.equal(echoCancel.verdict, 'passed');
  assert.equal(echoCancel.failureLayer, null);
  assert.equal(echoCancel.layers.driver.status, 'skipped');
  assert.equal(echoCancel.layers.wasapi.status, 'skipped');
  assert.deepEqual(echoCancel.layers.driver.data, driverFailure);
  assert.deepEqual(echoCancel.layers.wasapi.data, driverFailure);
  assert.equal(echoCancel.layers.provider.status, 'passed');
  assert.deepEqual(echoCancel.diagnostics.failedSteps, []);
  assert.equal(echoCancel.diagnostics.runnerFailure, null);
  assert.deepEqual(echoCancel.diagnostics.evidence.bridgeErrors, []);
  assert.deepEqual(echoCancel.diagnostics.evidence.bridgeWatchdog, []);
  assert.deepEqual(echoCancel.layers.app.parsedLog.providerErrorLines, []);
  const markdown = renderMarkdownReport(echoCancel);
  assert.doesNotMatch(markdown, /FailedStep:|driver open failed|source_watchdog|timeoutMs=5000/);
  assert.match(markdown, /real application error: response\.empty/);

  const virtualDriver = classify({
    feedbackLoopPrevention: 'virtual-driver',
    driver: driverFailure,
    wasapi: driverFailure,
  });
  assert.equal(virtualDriver.verdict, 'failed');
  assert.equal(virtualDriver.failureLayer, 'driver');
  assert.match(virtualDriver.failureReason, /virtual audio endpoint/i);
});

test('echo-cancel variant keeps the duplicate final translation detector as a failing gate', () => {
  const report = classify({
    feedbackLoopPrevention: 'echo-cancel',
    app: {
      ...healthyApp,
      subtitleQueue: {
        eventCount: 8,
        cueOrderInversions: 0,
        duplicateFinalTranslations: 1,
      },
    },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'app');
  assert.match(report.failureReason, /duplicate final translations/);
  assert.equal(report.feedbackLoopPrevention, 'echo-cancel');
});

test('reports default to the virtual-driver variant and honor snapshots feedbackLoopPrevention', () => {
  assert.equal(classify().feedbackLoopPrevention, 'virtual-driver');

  const fromSnapshots = classify({ snapshots: { feedbackLoopPrevention: 'echo-cancel' } });
  assert.equal(fromSnapshots.feedbackLoopPrevention, 'echo-cancel');
  assert.equal(fromSnapshots.layers.strictContent.status, 'skipped');
});

test('classifies slow secondary subtitle first translation as app failure', () => {
  const report = classify({
    translationRoute: 'secondary',
    app: {
      ...healthyApp,
      subtitleQueue: {
        eventCount: 8,
        cueOrderInversions: 0,
        duplicateFinalTranslations: 0,
        firstVisibleTranslationLatencySeconds: 34,
        firstFinalTranslationLatencySeconds: 41,
      },
    },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'app');
  assert.match(report.failureReason, /first visible subtitle translation latency/);
});

test('classifies missing subtitle evidence as app failure', () => {
  const report = classify({
    app: { routeState: 'capturing', overlayVisible: true, subtitleCueCount: 0 },
    appLogText: 'watch route ensured subtitle overlay visible',
    watchSessionReport: null,
  });

  assert.equal(report.failureLayer, 'app');
  assert.match(report.failureReason, /subtitle/);
});

test('classifies runner failure before healthy log evidence', () => {
  const report = classify({
    failure: { message: 'stale omni-desktop-shell could not be stopped; pid=25452' },
    appLogText: healthyAppLog,
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'app');
  assert.match(report.failureReason, /stale omni-desktop-shell/);
  assert(report.suspectFiles.some((file) => file.includes('run-watch-mode-live.ps1')));
});

test('keeps runner failure as primary app reason while preserving secondary symptoms', () => {
  const report = classify({
    translationRoute: 'secondary',
    failure: {
      message: 'wait for watch-mode app readiness failed: timed out waiting for app log pattern: watch_mode\\.omni_session_ready',
    },
    appLogText: [
      'watch_mode.diagnostic_autostart_requested | watch_mode_diagnostic.run_id=abc123',
      'watch_mode.omni_preconnect_discarded | direction=inbound reason=readiness_timeout',
      'watch_mode.diagnostic_autostart_route_failed | Omni session readiness timed out after 90000ms: timed out waiting on channel',
      'start_audio_route subtitleTranslationMode=secondary subtitleTranslationModelId=template-deepseek::deepseek-v4-flash st_active=true',
    ].join('\n'),
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'app');
  assert.match(report.failureReason, /wait for watch-mode app readiness failed/);
  assert.match(report.layers.app.reason, /wait for watch-mode app readiness failed/);
  assert(report.layers.app.reasons.some((reason) => /did not start Omni preconnect/.test(reason)));
  assert.equal(report.diagnostics.runnerFailure, report.failureReason);
  assert(report.diagnostics.evidence.appOmniPreconnect.some((line) => /omni_preconnect_discarded/.test(line)));
});

test('preserves diagnostic IPC gate failure as infrastructure readiness evidence', () => {
  const infrastructureLine = [
    'watch_mode.diagnostic_autostart_infrastructure_failed',
    'category=infrastructure code=frontend-ipc-not-ready runMarker=abc123 waitedMs=30001',
  ].join(' | ');
  const report = classify({
    failure: {
      message: `wait for watch-mode app readiness failed: watch-mode infrastructure failure: ${infrastructureLine}`,
    },
    appLogText: infrastructureLine,
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'app');
  assert.match(report.failureReason, /frontend-ipc-not-ready/);
  assert(report.diagnostics.evidence.appOmniPreconnect.includes(infrastructureLine));
  assert(report.diagnostics.evidence.appReadiness.includes(infrastructureLine));
});

test('does not count diagnostic run markers as watch route evidence', () => {
  const report = classify({
    app: { routeState: null, overlayVisible: null, subtitleCueCount: null },
    provider: { totalCalls: 0, failedCalls: 0 },
    appLogText: 'watch_mode_diagnostic.run_id=abc123',
    watchSessionReport: null,
  });

  assert.equal(report.failureLayer, 'app');
  assert.equal(report.failureReason, 'no current watch route evidence was found');
});

test('uses the completed structured Watch session as route and subtitle evidence', () => {
  const report = classify({
    app: { routeState: null, overlayVisible: null, subtitleCueCount: null },
    appLogText: 'watch_mode_diagnostic.run_id=abc123',
  });

  assert.equal(report.verdict, 'passed');
  assert.equal(report.failureLayer, null);
});

test('infers secondary route from early route config after append summaries flood route tail', () => {
  const appendSummaries = Array.from({ length: 40 }, (_, index) =>
    `2026-06-04 09:32:${String(13 + index).padStart(2, '0')}.078 [DEBUG] [model-trace] ws.send.input_audio_buffer.append.summary chunks=100`,
  );
  const report = classify({
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContent: healthyPhysicalOutputContent,
    app: { routeState: 'preview', overlayVisible: true, subtitleCueCount: 0 },
    provider: healthyProvider,
    appLogText: [
      '2026-06-04 09:32:10.846 [NORMAL] [audio] start_audio_route 二次翻译判定: subtitleTranslationMode=secondary subtitleTranslationModelId=template-deepseek::deepseek-v4-flash st_active=true',
      '2026-06-04 09:32:10.900 [NORMAL] [audio] start_audio_route secondary speech decision: translationAudioSource=SubtitleTts',
      ...appendSummaries,
    ].join('\n'),
  });

  assert.equal(report.translationRoute, 'secondary');
  assert.equal(report.layers.speechSegmentation.status, 'failed');
});

test('app route config overrides stale native snapshot route', () => {
  const report = classify({
    snapshots: { translationRoute: 'native' },
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContent: healthyPhysicalOutputContent,
    app: { routeState: 'preview', overlayVisible: true, subtitleCueCount: 0 },
    provider: healthyProvider,
    appLogText: [
      'watch_mode.route_start | direction=inbound routeMode=watch',
      'watch_mode.omni_preconnect_started | detail=direction=inbound',
      'watch_mode.omni_preconnect_reused | detail=direction=inbound',
      'start_audio_route subtitleTranslationMode=secondary subtitleTranslationModelId=template-deepseek::deepseek-v4-flash st_active=true',
      'start_audio_route secondary speech decision: translationAudioSource=SubtitleTts',
    ].join('\n'),
  });

  assert.equal(report.translationRoute, 'secondary');
  assert.equal(report.layers.speechSegmentation.status, 'failed');
});

test('classifies subtitle translate config failure before physical content failure', () => {
  const report = classify({
    app: { routeState: 'capturing', overlayVisible: true, subtitleCueCount: 0 },
    physicalOutputContent: {
      ...healthyPhysicalOutputContent,
      passed: false,
      error: 'physical output STT returned no usable transcript',
    },
    appLogText: [
      'watch_mode.route_start | direction=inbound routeMode=watch',
      'resolve_model_provider_from_config: purpose=subtitle-translate no provider matched target_template=template-deepseek composite_model_id=template-deepseek::deepseek-v4-flash linkedProviders=1',
      'watch_mode.subtitle_translate_config_failed | phase=route subtitleTranslationMode=secondary subtitleTranslationModelId=template-deepseek::deepseek-v4-flash fallback=native reason=provider_not_found',
    ].join('\n'),
  });

  assert.equal(report.failureLayer, 'app');
  assert.match(report.failureReason, /subtitle translate provider\/worker configuration failed/);
});
