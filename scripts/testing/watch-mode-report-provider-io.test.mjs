// Split from watch-mode-report.test.mjs (kept as the package.json entry that
// imports this file): provider-layer classification (auth/quota/timeout/VAD,
// Omni realtime diagnostics) plus report IO — writeReport artifact handling,
// markdown rendering and bridge-log parsing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyWatchModeRun,
  normalizeSteps,
  parseBridgeLog,
  renderMarkdownReport,
  writeReport,
} from './watch-mode-report.mjs';

test('report rejects legacy or missing step schemas instead of migrating them', () => {
  assert.throws(
    () => normalizeSteps([{ schemaVersion: 'watch-mode-step/v1', id: 'legacy', status: 'passed' }]),
    /unsupported watch-mode step schema/,
  );
  assert.throws(
    () => normalizeSteps([{ id: 'missing', status: 'passed' }]),
    /unsupported watch-mode step schema/,
  );
});
import {
  classify,
  healthyApp,
  healthyAppLog,
  healthyBridge,
  healthyBridgeLog,
  healthyDriver,
  healthyPhysicalOutput,
  healthyPhysicalOutputContent,
  healthyProvider,
  healthyWatchSessionReport,
  healthyWasapi,
} from './watch-mode-report-test-helpers.mjs';
import { WATCH_MODE_RUN_COLLECTION_SCHEMA, writeWatchModeRunCollection } from './watch-mode-run-collection.mjs';

function writeCollection(directory, evidence, { failure = null, steps = [], marker = null, startedAtLocal = null } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'fixture-evidence.raw.json'), JSON.stringify(evidence), 'utf8');
  fs.writeFileSync(path.join(directory, 'run-metadata.json'), JSON.stringify({
    schemaVersion: 'watch-mode-run-metadata/v1', runMarker: marker, startedAtLocal,
    modelId: evidence.modelId ?? null,
    feedbackMode: evidence.feedbackLoopPrevention ?? null,
  }), 'utf8');
  writeWatchModeRunCollection(directory, {
    schemaVersion: WATCH_MODE_RUN_COLLECTION_SCHEMA,
    artifactKind: 'watch-mode-run-collection',
    request: { schemaVersion: 'watch-mode-run-request/v1', runMode: 'live' },
    collectionStatus: failure ? 'failed' : 'completed',
    steps,
    ownedProcesses: [],
    artifacts: {
      appLog: 'app.log', bridgeLog: 'bridge-service.log',
      runMetadata: 'run-metadata.json', fixtureEvidence: 'fixture-evidence.raw.json',
    },
    primaryError: failure,
    cleanupErrors: [],
  });
}

test('preserves physical output mixed-output detail in markdown', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-report-physical-detail-'));
  const physicalOutputContent = {
    ...healthyPhysicalOutputContent,
    originalPassthrough: { passed: true, transcriptChars: 120 },
    translatedSpeech: { passed: true, queuedSegments: 8, playedSegments: 8 },
    mixedOutput: {
      passed: false,
      detail: 'mixed rms=0.001 peak=0.004',
      rms: 0.001,
      peak: 0.004,
    },
  };
  writeCollection(tempDir, {
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContentRaw: physicalOutputContent,
    app: healthyApp,
    watchSessionReport: healthyWatchSessionReport,
    provider: healthyProvider,
  });
  fs.writeFileSync(path.join(tempDir, 'app.log'), healthyAppLog);
  fs.writeFileSync(path.join(tempDir, 'bridge-service.log'), healthyBridgeLog);

  const { report, reportMarkdownPath } = writeReport({ inputDir: tempDir, outputDir: tempDir, mode: 'live' });
  const markdown = fs.readFileSync(reportMarkdownPath, 'utf8');

  assert.equal(report.failureLayer, 'physicalOutputContent');
  assert.match(report.failureReason, /mixed rms=0\.001/);
  assert.match(markdown, /mixed rms=0\.001 peak=0\.004/);
});

test('prioritizes physical output content failure over transient provider timeout', () => {
  const report = classify({
    physicalOutputContent: {
      ...healthyPhysicalOutputContent,
      passed: false,
      recording: {
        passed: false,
        capturedFrames: 0,
        rms: 0,
        detail: 'physical output recording captured only 0 frame(s)',
      },
    },
    provider: {
      totalCalls: 10,
      failedCalls: 1,
    },
    appLogText: [
      healthyAppLog,
      'provider.translate_text end_call | {"payload":{"error":"timeout: upstream request timed out","status":"failed"}}',
    ].join('\n'),
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'physicalOutputContent');
  assert.match(report.failureReason, /captured only 0 frame/);
});

test('keeps hard provider auth and quota failures ahead of physical output content', () => {
  const report = classify({
    physicalOutputContent: {
      ...healthyPhysicalOutputContent,
      passed: false,
      recording: {
        passed: false,
        capturedFrames: 0,
        rms: 0,
        detail: 'physical output recording captured only 0 frame(s)',
      },
    },
    appLogText: [
      healthyAppLog,
      'provider.translate_text end_call | {"payload":{"error":"HTTP 401 invalid api key","status":"failed"}}',
    ].join('\n'),
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'provider');
  assert.match(report.failureReason, /credential|rate-limit/);
});

test('does not classify a successful credential-vault read as a provider failure', () => {
  const report = classify({
    appLogText: [
      healthyAppLog,
      '[storage] [omni][credential] start action=读取 API Key timeoutMs=5000',
      '[storage] [omni][credential] calling CredReadW target=provider-dashscope',
      '[storage] [omni][credential] CredReadW succeeded target=provider-dashscope',
      '[storage] [omni][credential] finish action=读取 API Key outcome=ok',
      'realtime profile: {"providerId":"provider-dashscope","timeoutBudgetMs":95000}',
    ].join('\n'),
  });

  assert.equal(report.verdict, 'passed');
  assert.notEqual(report.failureLayer, 'provider');
  assert.deepEqual(report.layers.app.parsedLog.providerErrorLines, []);
  assert.deepEqual(report.diagnostics.evidence.appErrors, []);
});

test('uses live source watchdog progress when the preflight snapshot was waiting for a subscriber', () => {
  const report = classify({
    bridge: {
      ...healthyBridge,
      sourceSubscriberActive: false,
      sourceReadCalls: 30,
    },
    bridgeLogText: [
      healthyBridgeLog,
      '2026-01-01 00:00:01.000 [NORMAL] [bridge] - - event=source_watchdog captureBackend=driver-virtual-speaker sourceSubscriberActive=true workerPhase=driver-read-returned lastProgressAgeMs=1 capturePackets=0 captureFrames=0 readCalls=48570 bytesRead=24253440 capturedBytes=24253440 releasedFrames=6316 droppedFrames=0 sid=bridge-0198testsid-1000',
    ].join('\n'),
  });

  assert.notEqual(report.failureLayer, 'bridge');
  assert.notEqual(report.failureReason, 'bridge source subscriber is not active');
});

test('does not treat post-session waiting-subscriber watchdog tails as a live source stall', () => {
  const activeProgress = '2026-01-01 00:00:05.000 event=source_watchdog sourceSubscriberActive=true workerPhase=driver-read-returned lastProgressAgeMs=1 readCalls=48570 bytesRead=24253440 capturedBytes=24253440 releasedFrames=6316 droppedFrames=0';
  const idleTail = Array.from({ length: 6 }, (_, index) => (
    `2026-01-01 00:00:${String(20 + index).padStart(2, '0')}.000 event=source_watchdog sourceSubscriberActive=false workerPhase=waiting-subscriber lastProgressAgeMs=${10_000 + index * 5_000} readCalls=48570 bytesRead=24253440 capturedBytes=24253440 releasedFrames=6316 droppedFrames=0`
  ));
  const bridgeLogText = [healthyBridgeLog, activeProgress, ...idleTail].join('\n');
  const watchSessionReport = {
    ...healthyWatchSessionReport,
    status: 'completed',
    startedAt: '2026-01-01T00:00:00',
    endedAt: '2026-01-01T00:00:10',
  };
  const report = classify({
    bridge: {
      ...healthyBridge,
      sourceSubscriberActive: false,
      sourceReadCalls: 30,
      sourceFramePayloadBytes: 0,
    },
    watchSessionReport,
    bridgeLogText,
  });
  const parsedLog = parseBridgeLog(bridgeLogText, { watchSessionReport });

  assert.notEqual(report.failureLayer, 'bridge');
  assert.equal(parsedLog.watchdogLines.length, 1);
  assert.equal(parsedLog.watchdogSummaries.length, 1);
  assert.equal(parsedLog.watchdogSummaries[0].sourceSubscriberActive, 'true');
});

test('keeps an inactive waiting-subscriber watchdog fail-closed inside an active session', () => {
  const report = classify({
    bridgeLogText: '2026-01-01 00:00:05.000 event=source_watchdog sourceSubscriberActive=false workerPhase=waiting-subscriber lastProgressAgeMs=6000 readCalls=20 bytesRead=38400 releasedFrames=10',
    watchSessionReport: {
      ...healthyWatchSessionReport,
      status: 'completed',
      startedAt: '2026-01-01T00:00:00',
      endedAt: '2026-01-01T00:00:10',
    },
  });

  assert.equal(report.failureLayer, 'bridge');
  assert.match(report.failureReason, /watchdog|subscriber|source frames/);
});

test('keeps an explicitly skipped physical-content STT layer out of balanced diagnostics', () => {
  const report = classify({
    physicalOutputContent: {
      skipped: true,
      reason: 'SkipPhysicalOutputContentStt was provided',
    },
  });

  assert.equal(report.verdict, 'passed');
  assert.equal(report.layers.physicalOutputContent.status, 'skipped');
  assert.equal(report.layers.strictContent.status, 'skipped');
  assert.match(report.layers.strictContent.reason, /explicitly skipped/);
  assert.equal(report.failureLayer, null);
});

test('echo-cancel suppresses virtual-driver evidence but preserves a real provider failure', () => {
  const providerError = 'provider.translate_text end_call | {"payload":{"error":"HTTP 429 rate limit exceeded","status":"failed"}}';
  const report = classify({
    feedbackLoopPrevention: 'echo-cancel',
    bridgeLogText: [
      'driver open failed: error=file not found',
      'event=source_watchdog workerPhase=driver-open-failed sourceSubscriberActive=false',
    ].join('\n'),
    physicalOutputContent: null,
    provider: { totalCalls: 2, failedCalls: 1 },
    appLogText: [healthyAppLog, providerError].join('\n'),
  });
  const markdown = renderMarkdownReport(report);

  assert.equal(report.failureLayer, 'provider');
  assert.match(report.failureReason, /credential|rate-limit/);
  assert.deepEqual(report.diagnostics.evidence.bridgeErrors, []);
  assert.deepEqual(report.diagnostics.evidence.bridgeWatchdog, []);
  assert(report.diagnostics.evidence.providerErrors.includes(providerError));
  assert.match(markdown, /HTTP 429 rate limit exceeded/);
  assert.doesNotMatch(markdown, /driver open failed|source_watchdog/);
});

test('writeReport prioritizes failure artifact over stale healthy app log', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-report-failure-'));
  writeCollection(tempDir, {
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContent: healthyPhysicalOutputContent,
    app: healthyApp,
    provider: healthyProvider,
  }, { failure: { message: 'start watch mode via existing desktop shell failed: elevation required' } });
  fs.writeFileSync(path.join(tempDir, 'app.log'), healthyAppLog);
  fs.writeFileSync(path.join(tempDir, 'bridge-service.log'), healthyBridgeLog);

  const { report } = writeReport({ inputDir: tempDir, outputDir: tempDir, mode: 'live' });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'app');
  assert.match(report.failureReason, /start watch mode via existing desktop shell failed/);
});

test('writeReport surfaces failed runner steps and readiness evidence in report output', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-report-steps-'));
  const steps = [
    { schemaVersion: 'watch-mode-step/v2', id: 'driver-probe', phase: 'driverProbe', status: 'passed', data: healthyDriver, error: null },
    {
      schemaVersion: 'watch-mode-step/v2', id: 'wait-for-watch-mode-app-readiness', phase: 'readiness', status: 'failed', data: null,
      error: { kind: 'timeout', code: 'testing.readiness.timeout', message: 'timed out waiting for structured readiness' },
    },
  ];
  writeCollection(tempDir, {
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContent: null,
    app: { routeState: null, overlayVisible: null, subtitleCueCount: null },
    provider: { totalCalls: 2, failedCalls: 1 },
    translationRoute: 'secondary',
  }, {
    failure: { message: 'wait for watch-mode app readiness failed: timed out waiting for structured readiness' },
    steps,
    marker: 'watch_mode_diagnostic.run_id=steps-test',
  });
  fs.writeFileSync(path.join(tempDir, 'bridge-service.log'), healthyBridgeLog);
  fs.writeFileSync(path.join(tempDir, 'app.log'), [
    'watch_mode_diagnostic.run_id=steps-test',
    'watch_mode.omni_preconnect_discarded | direction=inbound reason=readiness_timeout',
    'watch_mode.diagnostic_autostart_route_failed | Omni session readiness timed out after 90000ms: timed out waiting on channel',
  ].join('\n'));

  const { report, reportMarkdownPath } = writeReport({ inputDir: tempDir, outputDir: tempDir, mode: 'live' });
  const markdown = fs.readFileSync(reportMarkdownPath, 'utf8');

  assert.match(report.failureReason, /wait for watch-mode app readiness failed/);
  assert.equal(report.diagnostics.failedSteps.length, 1);
  assert.equal(report.diagnostics.failedSteps[0].name, 'wait for watch mode app readiness');
  assert(report.diagnostics.failedLayers.some((layer) => layer.layer === 'app'));
  assert(report.artifacts.collection.endsWith('run-collection.json'));
  assert.match(markdown, /RunnerFailure: wait for watch-mode app readiness failed/);
  assert.match(markdown, /wait for watch mode app readiness: timed out waiting/);
  assert.match(markdown, /omni_preconnect_discarded/);
});

test('does not use old subtitle evidence when marker is absent and startedAtLocal is current', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-report-'));
  writeCollection(tempDir, {
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContent: healthyPhysicalOutputContent,
    app: { routeState: null, overlayVisible: null, subtitleCueCount: null },
    provider: healthyProvider,
  }, { marker: 'watch_mode_diagnostic.run_id=missing', startedAtLocal: '2026-06-04 09:32:00' });
  fs.writeFileSync(path.join(tempDir, 'app.log'), [
    '2026-06-01 00:12:28.696 [NORMAL] [omni] cue_id=old-cue',
    '2026-06-04 09:32:10.846 [NORMAL] [audio] watch_mode.route_start | direction=inbound routeMode=watch',
    '2026-06-04 09:32:13.078 [DEBUG] [model-trace] ws.send.input_audio_buffer.append.summary',
  ].join('\n'));
  fs.writeFileSync(path.join(tempDir, 'bridge-service.log'), healthyBridgeLog);

  const { report } = writeReport({ inputDir: tempDir, outputDir: tempDir, mode: 'live' });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'app');
  assert.equal(report.failureReason, 'no subtitle cue evidence was found');
});

test('writeReport infers secondary route from app log instead of stale snapshot route', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-report-'));
  writeCollection(tempDir, {
    translationRoute: 'native',
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContent: healthyPhysicalOutputContent,
    app: { routeState: 'preview', overlayVisible: true, subtitleCueCount: 0 },
    provider: healthyProvider,
  });
  fs.writeFileSync(path.join(tempDir, 'bridge-service.log'), healthyBridgeLog);
  fs.writeFileSync(path.join(tempDir, 'app.log'), [
    'watch_mode.route_start | direction=inbound routeMode=watch',
    'start_audio_route subtitleTranslationMode=secondary subtitleTranslationModelId=template-deepseek::deepseek-v4-flash st_active=true',
    'start_audio_route secondary speech decision: translationAudioSource=SubtitleTts',
  ].join('\n'));

  const { report } = writeReport({ inputDir: tempDir, outputDir: tempDir, mode: 'live' });

  assert.equal(report.translationRoute, 'secondary');
  assert.equal(report.layers.speechSegmentation.status, 'failed');
});

test('writeReport keeps early route config when run marker appears again later', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-report-'));
  writeCollection(tempDir, {
    translationRoute: 'native',
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContent: healthyPhysicalOutputContent,
    app: { routeState: 'preview', overlayVisible: true, subtitleCueCount: 0 },
    provider: healthyProvider,
  }, { marker: 'watch_mode_diagnostic.run_id=abc123' });
  fs.writeFileSync(path.join(tempDir, 'bridge-service.log'), healthyBridgeLog);
  fs.writeFileSync(path.join(tempDir, 'app.log'), [
    'old stale cue_id=old-cue',
    'watch_mode.diagnostic_autostart_requested | watch_mode_diagnostic.run_id=abc123',
    'start_audio_route subtitleTranslationMode=secondary subtitleTranslationModelId=template-deepseek::deepseek-v4-flash st_active=true',
    'start_audio_route secondary speech decision: translationAudioSource=SubtitleTts',
    'watch_mode.diagnostic_autostart_route_started | watch_mode_diagnostic.run_id=abc123',
    'ws.send.input_audio_buffer.append.summary | {"payload":{"audioRms":{"avg":0.18,"max":0.39,"min":0.05},"chunks":{"count":100}}}',
  ].join('\n'));

  const { report } = writeReport({ inputDir: tempDir, outputDir: tempDir, mode: 'live' });

  assert.equal(report.translationRoute, 'secondary');
  assert.equal(report.failureLayer, 'provider');
});

test('classifies provider errors after local layers pass', () => {
  const report = classify({
    provider: { totalCalls: 1, failedCalls: 1 },
    appLogText: `${healthyAppLog}\nmodel_trace failed status=401 invalid api key`,
  });

  assert.equal(report.failureLayer, 'provider');
  assert.match(report.failureReason, /provider|failed/);
});

test('preserves provider status code and model evidence in report and markdown', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-report-provider-'));
  const providerErrorLine = 'provider.translate_text end_call | {"payload":{"error":"HTTP 429 quota exceeded code=QuotaExceeded providerId=provider-dashscope modelId=qwen3.6-flash-2026-04-16","status":"failed"}}';
  writeCollection(tempDir, {
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContent: null,
    app: healthyApp,
    provider: { totalCalls: 3, failedCalls: 1 },
  });
  fs.writeFileSync(path.join(tempDir, 'bridge-service.log'), healthyBridgeLog);
  fs.writeFileSync(path.join(tempDir, 'app.log'), [
    healthyAppLog,
    providerErrorLine,
  ].join('\n'));

  const { report, reportMarkdownPath } = writeReport({ inputDir: tempDir, outputDir: tempDir, mode: 'live' });
  const markdown = fs.readFileSync(reportMarkdownPath, 'utf8');

  assert.equal(report.failureLayer, 'provider');
  assert.match(report.failureReason, /429 quota exceeded/);
  assert.match(report.failureReason, /provider-dashscope/);
  assert(report.diagnostics.evidence.providerErrors.some((line) => /modelId=qwen3\.6/.test(line)));
  assert.match(markdown, /HTTP 429 quota exceeded/);
});

test('does not classify auth substring inside trace ids as provider auth failure', () => {
  const report = classify({
    appLogText: [
      healthyAppLog,
      'omni.websocket_session ws.recv.response.audio_transcript.delta | {"payload":{"event_id":"event_UiAuTHNW6doW4VCAt1qmq","type":"response.audio_transcript.delta"},"providerId":"provider-dashscope"}',
    ].join('\n'),
  });

  assert.equal(report.verdict, 'passed');
  assert.equal(report.failureLayer, null);
  assert.equal(report.layers.app.parsedLog.providerErrorLines.length, 0);
});

test('classifies audible Omni input without VAD events as provider failure before app cue failure', () => {
  const report = classify({
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContent: healthyPhysicalOutputContent,
    app: { routeState: 'preview', overlayVisible: true, subtitleCueCount: 0 },
    provider: { totalCalls: 1, failedCalls: 0 },
    appLogText: [
      'watch_mode.route_start | direction=inbound routeMode=watch',
      'watch_mode.overlay_visible | label=subtitle-overlay visible=true',
      'start_audio_route subtitleTranslationMode=secondary subtitleTranslationModelId=template-deepseek::deepseek-v4-flash st_active=true',
      'ws.send.input_audio_buffer.append.summary | {"payload":{"audioRms":{"avg":0.18,"max":0.39,"min":0.05},"chunks":{"count":100}}}',
    ].join('\n'),
  });

  assert.equal(report.failureLayer, 'provider');
  assert.equal(report.failureReason, 'audible audio was sent to Omni, but no VAD/transcription event was received');
});

test('records Omni realtime diagnostics and classifies response.done before ASR final as provider suspect', () => {
  const report = classifyWatchModeRun({
    mode: 'live',
    modelId: 'qwen3.5-omni-plus-realtime',
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContent: healthyPhysicalOutputContent,
    speechSegmentation: { passed: true, queuedSegments: 1, playedSegments: 1 },
    strictContent: { passed: true, applicable: true, coverage: 1 },
    app: { routeState: 'capturing', overlayVisible: true, subtitleCueCount: 1 },
    watchSessionReport: healthyWatchSessionReport,
    provider: { totalCalls: 1, failedCalls: 0 },
    appLogText: [
      'watch_mode.route_start | direction=inbound routeMode=watch',
      'watch_mode.omni_preconnect_started | detail=direction=inbound',
      'watch_mode.omni_preconnect_reused | detail=direction=inbound',
      'start_audio_route subtitleTranslationMode=secondary subtitleTranslationModelId=template-deepseek::deepseek-v4-flash st_active=true',
      'watch_mode.omni_session_config | model=qwen3.5-omni-plus-realtime realtimeAudioMode=manual inputAudioFormat=pcm16 isLivetranslate=false subtitleTranslateActive=true turnDetection=null',
      'watch_mode.omni_session_ready | event=session.created queuedAudioChunks=0 droppedBeforeReady=0',
      '[EVENT_CONTEXT] response.done cue_id=omni-cue-1 responseDoneCount=2 responseDoneAtMs=38000 firstResponseDoneAtMs=22000 readinessEvent=session.created cueOrigin=speech_started sourceLen=0 translatedLen=0 lastAsrDeltaAtMs=- lastAsrDelta="" lastAsrCompletedAtMs=- lastAsrCompleted="" firstNonEmptyAsrCompletedAtMs=- emptyAsrCompletedCount=2 lastOutputDoneAtMs=21000 lastOutputDone="那里！" st_active=true nativeTranslationReuse=false',
    ].join('\n'),
  });

  assert.equal(report.failureLayer, 'provider');
  assert.match(report.failureReason, /response\.done arrived before non-empty ASR completed/);
  assert.equal(report.realtimeSession.realtimeAudioMode, 'manual');
  assert.equal(report.realtimeSession.inputAudioFormat, 'pcm16');
  assert.equal(report.realtimeSession.readinessEvent, 'session.created');
  assert.equal(report.realtimeSession.responseDoneCount, 2);
  assert.equal(report.realtimeSession.duplicateResponseDoneCount, 1);
  assert.equal(report.diagnostics.evidence.realtimeSession.emptyAsrCompletedCount, 2);
});

test('does not fail the run for recovered transient provider timeouts after subtitles are visible', () => {
  const report = classify({
    provider: { totalCalls: 40, failedCalls: 2 },
    appLogText: [
      'watch_mode.route_start | direction=inbound routeMode=watch',
      'watch_mode.overlay_visible | label=subtitle-overlay visible=true',
      'subtitle translate success: cue_id=omni-cue-1 translated="你好"',
      '[TRANS_WRITE] cue_id=omni-cue-1 rank=Final translated="你好"',
      'provider.translate_text end_call | {"payload":{"error":"timeout: upstream request timed out","status":"failed"}}',
      'provider.translate_text end_call | {"payload":{"error":null,"status":"succeeded"}}',
    ].join('\n'),
  });

  assert.equal(report.verdict, 'passed');
  assert.equal(report.failureLayer, null);
  assert.equal(report.layers.provider.status, 'passed');
  assert.equal(report.layers.app.parsedLog.providerErrorLines.length, 1);
});

test('does not fail recovered provider timeout when physical output content passed', () => {
  const report = classify({
    provider: { totalCalls: 40, failedCalls: 2 },
    appLogText: [
      'watch_mode.route_start | direction=inbound routeMode=watch',
      'provider.translate_text end_call | {"payload":{"error":"timeout: upstream request timed out","status":"failed"}}',
      'speech.speaker_playback_written | cue=cue-1 frames=48000',
    ].join('\n'),
    physicalOutputContent: {
      ...healthyPhysicalOutputContent,
      passed: true,
      source: '浣犲ソ涓栫晫',
      subtitleText: '浣犲ソ涓栫晫',
      sourceReference: { passed: true, source: '浣犲ソ涓栫晫', translation: '' },
    },
  });

  assert.equal(report.verdict, 'passed');
  assert.equal(report.failureLayer, null);
  assert.equal(report.layers.provider.status, 'passed');
});

test('parses bridge source pacer metrics', () => {
  const parsed = parseBridgeLog('2026-01-01 00:00:01.000 [NORMAL] [bridge] - - source pacer summary: releasedFrames=10 queuedFrames=2 pendingBytes=3840 underruns=1 droppedFrames=0 driverBufferedBytes=960 driverDroppedBytes=0 monitorQueuedFrames=1 staleSourceFramesDropped=0 sid=bridge-0198testsid-1000');

  assert.equal(parsed.metrics.releasedFrames, 10);
  assert.equal(parsed.metrics.queuedFrames, 2);
  assert.equal(parsed.metrics.pendingBytes, 3840);
});

test('parses bridge source pacer metrics from legacy unprefixed lines', () => {
  // Logs written before the unified `{timestamp} [{LEVEL}] [bridge]` prefix
  // must keep parsing (rotated files can span the format change).
  const parsed = parseBridgeLog('source pacer summary: releasedFrames=10 queuedFrames=2 pendingBytes=3840 underruns=1 droppedFrames=0 driverBufferedBytes=960 driverDroppedBytes=0 monitorQueuedFrames=1 staleSourceFramesDropped=0');

  assert.equal(parsed.metrics.releasedFrames, 10);
  assert.equal(parsed.metrics.queuedFrames, 2);
  assert.equal(parsed.metrics.pendingBytes, 3840);
});

test('renders markdown with verdict and suspect files', () => {
  const markdown = renderMarkdownReport(classify({
    provider: { totalCalls: 1, failedCalls: 1, error: 'invalid api key' },
  }));

  assert.match(markdown, /Verdict: failed/);
  assert.match(markdown, /FailureLayer: provider/);
  assert.match(markdown, /apps\/desktop\/src-tauri\/src\/audio\/omni.rs/);
});
