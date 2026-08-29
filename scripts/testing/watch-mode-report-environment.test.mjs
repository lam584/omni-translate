// Split from watch-mode-report.test.mjs (kept as the package.json entry that
// imports this file): environment/driver prechecks, bridge source probe and
// pacer/watchdog diagnostics, WASAPI tone-capture failure attribution and the
// physical-output loopback layer.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classify,
  healthyPhysicalOutput,
  healthyProcessExclusionFingerprint,
  healthyProcessExclusionBridge,
  healthyProcessExclusionRestartLog,
} from './watch-mode-report-test-helpers.mjs';

test('marks environment precheck failures blocked before downstream recording failures', () => {
  const report = classify({
    driver: null,
    wasapi: null,
    physicalOutputContent: { passed: false, error: 'physical output recording did not run' },
    failure: { message: 'start physical output content recording failed: recorder executable not found' },
    steps: [
      { schemaVersion: 'watch-mode-step/v2', id: 'driver-probe', status: 'failed', data: null, error: { message: 'virtual endpoint unavailable' } },
      { schemaVersion: 'watch-mode-step/v2', id: 'start-physical-output-content-recording', status: 'failed', data: null, error: { message: 'recorder executable not found' } },
    ],
  });

  assert.equal(report.verdict, 'blocked');
  assert.equal(report.failureLayer, 'driver');
  assert.match(report.failureReason, /driver probe did not run|virtual endpoint unavailable/);
  assert.equal(report.layers.environment.status, 'blocked');
});

test('echo-cancel environment failure is not attributed to its skipped driver layer', () => {
  const report = classify({
    feedbackLoopPrevention: 'echo-cancel',
    driver: { error: 'virtual endpoint unavailable' },
    failure: { message: 'start physical output content recording failed: playback endpoint unresolved' },
    steps: [{ schemaVersion: 'watch-mode-step/v2', id: 'start-physical-output-content-recording', status: 'failed', data: null, error: { message: 'playback endpoint unresolved' } }],
  });
  assert.equal(report.verdict, 'blocked');
  assert.equal(report.failureLayer, 'environment');
  assert.equal(report.layers.driver.status, 'skipped');
});

test('frozen runtime policy skips are not environment precheck failures', () => {
  const report = classify({
    steps: [{
      schemaVersion: 'watch-mode-step/v2',
      id: 'build-bridge-service-native',
      phase: 'initialize',
      status: 'skipped',
      data: { reason: 'frozen runtime authority forbids rebuilding inside evidence collection' },
      error: null,
    }],
  });

  assert.equal(report.layers.environment.status, 'passed');
  assert.equal(report.diagnostics.failedSteps.some((step) => step.name === 'build bridge service native'), false);
});

test('process-exclusion reports unsupported capability at the bridge layer', () => {
  const report = classify({
    feedbackLoopPrevention: 'process-exclusion',
    bridge: {
      ...healthyProcessExclusionBridge,
      processLoopbackSupported: false,
      processLoopbackStatus: 'unsupported',
      windowsBuildNumber: 19045,
      excludedProcessId: null,
    },
    driver: { error: 'virtual endpoint unavailable' },
    wasapi: null,
    physicalOutput: null,
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'bridge');
  assert.match(report.failureReason, /unsupported.*19045.*20348/i);
  assert.equal(report.layers.driver.status, 'skipped');
  assert.equal(report.layers.physicalOutput.status, 'failed');
});

test('process-exclusion rejects capability-only evidence without a real fingerprint probe', () => {
  const report = classify({
    feedbackLoopPrevention: 'process-exclusion',
    bridge: healthyProcessExclusionBridge,
    driver: null,
    wasapi: null,
    physicalOutput: null,
    bridgeLogText: '',
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'physicalOutput');
  assert.match(report.failureReason, /fingerprint probe did not run|physical output probe did not run/i);
});

test('process-exclusion rejects Bridge and Bridge-child fingerprint leakage', () => {
  const physicalOutput = structuredClone(healthyProcessExclusionFingerprint);
  physicalOutput.processExclusionFingerprint.sourceTranslationComponent = 0.02;
  physicalOutput.processExclusionFingerprint.sourceBridgeChildComponent = 0.03;

  const report = classify({
    feedbackLoopPrevention: 'process-exclusion',
    bridge: healthyProcessExclusionBridge,
    driver: null,
    wasapi: null,
    physicalOutput,
    bridgeLogText: '',
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'physicalOutput');
  assert.match(report.failureReason, /fingerprint leaked/i);
});

test('process-exclusion rejects missing external audio and invalid child ancestry', () => {
  const physicalOutput = structuredClone(healthyProcessExclusionFingerprint);
  physicalOutput.processExclusionFingerprint.sourceExternalComponent = 0;
  physicalOutput.processExclusionFingerprint.bridgeChildParentProcessId = 7777;

  const report = classify({
    feedbackLoopPrevention: 'process-exclusion',
    bridge: healthyProcessExclusionBridge,
    driver: null,
    wasapi: null,
    physicalOutput,
    bridgeLogText: '',
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'physicalOutput');
  assert.match(report.failureReason, /invalid ancestry/i);
});

test('process-exclusion requires an explicit excluded Bridge process id', () => {
  const report = classify({
    feedbackLoopPrevention: 'process-exclusion',
    bridge: {
      ...healthyProcessExclusionBridge,
      excludedProcessId: null,
    },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'bridge');
  assert.match(report.failureReason, /excludedProcessId.*missing/);
});

test('process-exclusion cannot weaken the Windows build floor in captured evidence', () => {
  const report = classify({
    feedbackLoopPrevention: 'process-exclusion',
    bridge: {
      ...healthyProcessExclusionBridge,
      windowsBuildNumber: 19045,
      processLoopbackMinimumWindowsBuild: null,
    },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'bridge');
  assert.match(report.failureReason, /detected=19045 minimum=20348/);
});

test('process-exclusion live report rejects a route that never performed the controlled Bridge restart', () => {
  const report = classify({
    feedbackLoopPrevention: 'process-exclusion',
    bridge: healthyProcessExclusionBridge,
    driver: null,
    wasapi: null,
    physicalOutput: healthyProcessExclusionFingerprint,
    appLogText: '',
    systemMetrics: null,
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'bridge');
  assert.match(report.failureReason, /controlled live Bridge restart/i);
  assert.equal(report.stableErrorCode, 'bridge.restart-authority-failed');
  assert.equal(report.lifecyclePhase, 'bridge-restart');
});

test('process-exclusion restart idle timeout has a stable quiescence fingerprint', () => {
  const report = classify({
    feedbackLoopPrevention: 'process-exclusion',
    bridge: healthyProcessExclusionBridge,
    driver: null,
    wasapi: null,
    physicalOutput: healthyProcessExclusionFingerprint,
    appLogText: 'event=process_exclusion_restart_failed phase=restart-quiescence error=restart-quiescence-timeout: pendingNativeAudio=true queuedCommands=1 activeCommands=0 pendingBridgeAcks=0',
    systemMetrics: null,
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.stableErrorCode, 'bridge.restart-quiescence-timeout');
  assert.equal(report.lifecyclePhase, 'bridge-restart-quiescence');
});

test('process-exclusion restart owner failure has a stable authority fingerprint and transition', () => {
  const report = classify({
    feedbackLoopPrevention: 'process-exclusion',
    bridge: healthyProcessExclusionBridge,
    driver: null,
    wasapi: null,
    physicalOutput: healthyProcessExclusionFingerprint,
    appLogText: healthyProcessExclusionRestartLog.replace(
      'newPlaybackOwnerGeneration=2002',
      'newPlaybackOwnerGeneration=1000',
    ),
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'bridge');
  assert.equal(report.stableErrorCode, 'playback.physical-owner-authority-failed');
  assert.equal(report.lifecyclePhase, 'bridge-playback-rebind');
  assert.equal(report.failureContext.endpointId, '{hda-test-endpoint}');
  assert.deepEqual(report.failureContext.ownerGenerationTransition, {
    before: 1001,
    after: 1000,
  });
});

test('translated PCM authority failure has a stable physical proof fingerprint', () => {
  const report = classify({
    physicalOutputContent: {
      passed: false,
      error: 'translated-pcm-authority-failed: no complete cue matched the physical endpoint',
    },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'physicalOutputContent');
  assert.equal(report.stableErrorCode, 'playback.translated-pcm-authority-failed');
  assert.equal(report.lifecyclePhase, 'physical-playback-proof');
});

test('surfaces bridge source probe diagnostics before generic bridge counters', () => {
  const report = classify({
    bridge: {
      probePassed: false,
      error: 'bridge source probe failed during source_frame: timed out waiting for a bridge.source.frame',
      phase: 'source_frame',
      pipeName: 'omni-watch-mode-probe-1234',
      sourcePipeName: 'omni-watch-mode-probe-1234-source',
    },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'bridge');
  assert.match(report.failureReason, /bridge source frame probe failed/);
  assert.match(report.failureReason, /source_frame/);
});

test('classifies silent physical output after bridge success', () => {
  const report = classify({
    physicalOutput: {
      ...healthyPhysicalOutput,
      passed: false,
      rms: 0,
      toneComponent: 0,
      detail: 'physical output RMS 0.000000 is below 0.015000',
    },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'physicalOutput');
  assert.match(report.failureReason, /physical output/i);
});

test('classifies missing driver before higher layers', () => {
  const report = classify({
    driver: { error: 'Root\\OmniTranslateVirtualSpeaker endpoint was not found' },
    app: { routeState: 'idle', overlayVisible: false, subtitleCueCount: 0 },
    provider: { failedCalls: 1 },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'driver');
  assert.match(report.failureReason, /endpoint/);
  assert(report.suspectFiles.some((file) => file.includes('drivers/windows-virtual-mic')));
});

test('classifies bridge queue failures with queue metrics', () => {
  const report = classify({
    bridge: {
      bridgeState: 'running',
      driverHealth: 'running',
      sourceSubscriberActive: true,
      sourceReadCalls: 12,
      droppedFrameCount: 0,
      sourceFramePayloadBytes: 3840,
    },
    bridgeLogText: 'source pacer summary: releasedFrames=12 queuedFrames=99 pendingBytes=384000 underruns=0 droppedFrames=0 driverBufferedBytes=0 driverDroppedBytes=0 monitorQueuedFrames=0 staleSourceFramesDropped=0',
  });

  assert.equal(report.failureLayer, 'bridge');
  assert.match(report.failureReason, /queuedFrames=99/);
  assert.match(report.failureReason, /pendingBytes=384000/);
  assert.equal(report.diagnostics.evidence.bridgeMetrics.queuedFrames, 99);
});

test('classifies physical output loopback failures with captured metrics', () => {
  const report = classify({
    physicalOutput: {
      ...healthyPhysicalOutput,
      capturedFrames: 0,
      rms: 0,
      toneComponent: 0,
    },
  });

  assert.equal(report.failureLayer, 'physicalOutput');
  assert.match(report.failureReason, /capturedFrames=0/);
  assert.match(report.failureReason, /rms=0/);
  assert.equal(report.diagnostics.evidence.physicalOutput.capturedFrames, 0);
});

test('classifies silent WASAPI tone as wasapi failure', () => {
  const report = classify({
    wasapi: { ToneFrames: 48000, ToneRms: 0, InvalidSamples: 0 },
  });

  assert.equal(report.failureLayer, 'wasapi');
  assert.match(report.failureReason, /silent/);
});

test('classifies injected playback with fixed baseline capture as wasapi failure', () => {
  const report = classify({
    wasapi: {
      ToneFrames: 57600,
      IdleRms: 0.3535265,
      ToneRms: 0.3535265,
      PostToneIdleRms: 0.3535265,
      ToneFrequencyHz: 3000,
      ToneComponent: 0,
      InvalidSamples: 0,
    },
    app: { routeState: null, overlayVisible: null, subtitleCueCount: null },
    playback: { playbackMode: 'sapi-endpoint-speech' },
    appLogText: [
      'watch_mode.route_start | direction=inbound routeMode=watch',
      'ws.send.input_audio_buffer.append.summary chunks=100',
    ].join('\n'),
  });

  assert.equal(report.failureLayer, 'wasapi');
  assert.match(report.failureReason, /fixed 3 kHz baseline/);
});

test('classifies fixed baseline with unchanged driver counters as render path failure evidence', () => {
  const report = classify({
    wasapi: {
      ToneFrames: 57600,
      IdleRms: 0.3535265,
      ToneRms: 0.3535265,
      PostToneIdleRms: 0.3535265,
      ToneFrequencyHz: 3000,
      ToneComponent: 0,
      CapturedBytesBeforeTone: 0,
      CapturedBytesAfterTone: 0,
      InvalidSamples: 0,
    },
    app: { routeState: null, overlayVisible: null, subtitleCueCount: null },
    appLogText: 'watch_mode.route_start | direction=inbound routeMode=watch',
  });

  assert.equal(report.failureLayer, 'wasapi');
  assert.match(report.failureReason, /capturedBytes did not increase/);
});

test('classifies fixed baseline with no render stream as render stream creation failure', () => {
  const report = classify({
    wasapi: {
      ToneFrames: 57600,
      IdleRms: 0.3535265,
      ToneRms: 0.3535265,
      PostToneIdleRms: 0.3535265,
      ToneFrequencyHz: 3000,
      ToneComponent: 0,
      CapturedBytesBeforeTone: 0,
      CapturedBytesAfterTone: 0,
      RenderStreamsCreatedAfterTone: 0,
      InvalidSamples: 0,
    },
    app: { routeState: null, overlayVisible: null, subtitleCueCount: null },
    appLogText: 'watch_mode.route_start | direction=inbound routeMode=watch',
  });

  assert.equal(report.failureLayer, 'wasapi');
  assert.match(report.failureReason, /no system render stream creation/);
});


test('classifies bridge source stalls from logs', () => {
  const report = classify({
    bridgeLogText: 'event=source_watchdog sourceSubscriberActive=true workerPhase=reading-driver lastProgressAgeMs=6000',
  });

  assert.equal(report.failureLayer, 'bridge');
  assert.match(report.failureReason, /watchdog|source frames/);
});

test('treats healthy bridge source watchdog events as progress evidence', () => {
  const report = classify({
    bridge: {
      bridgeState: 'running',
      driverHealth: 'running',
      sourceSubscriberActive: true,
      sourceReadCalls: 0,
      droppedFrameCount: 0,
      sourceFramePayloadBytes: 3840,
    },
    bridgeLogText: 'event=source_watchdog sourceSubscriberActive=true workerPhase=wasapi-loopback-running lastProgressAgeMs=17 capturePackets=487 captureFrames=467520 readCalls=0 bytesRead=0 releasedFrames=487',
  });

  assert.notEqual(report.failureLayer, 'bridge');
});
