// Split from watch-mode-report.test.mjs (kept as the package.json entry that
// imports this file): translation-route classification (native/secondary,
// preconnect, fallback), app-layer subtitle evidence, subtitle queue ordering
// gates, the echo-cancel feedback variant and runner-failure attribution.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classify,
  healthyApp,
  healthyAppLog,
  healthyBridge,
  healthyDriver,
  healthyPhysicalOutput,
  healthyPhysicalOutputContent,
  healthyProvider,
  healthyWasapi,
} from './watch-mode-report-test-helpers.mjs';

test('classifies healthy watch-mode evidence as passed', () => {
  const report = classify();

  assert.equal(report.verdict, 'passed');
  assert.equal(report.failureLayer, null);
  assert.equal(report.suspectFiles.length, 0);
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
  for (const layer of ['bridge', 'physicalOutput', 'physicalOutputContent', 'speechSegmentation', 'strictContent']) {
    assert.equal(report.layers[layer].status, 'skipped');
  }
  assert.equal(report.layers.driver.status, 'passed');
  assert.equal(report.layers.app.status, 'passed');
  assert.equal(report.layers.provider.status, 'passed');
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

test('does not count diagnostic run markers as watch route evidence', () => {
  const report = classify({
    app: { routeState: null, overlayVisible: null, subtitleCueCount: null },
    provider: { totalCalls: 0, failedCalls: 0 },
    appLogText: 'watch_mode_diagnostic.run_id=abc123',
  });

  assert.equal(report.failureLayer, 'app');
  assert.equal(report.failureReason, 'no current watch route evidence was found');
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
