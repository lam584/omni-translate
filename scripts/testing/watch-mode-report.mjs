import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** HEAD commit of the checkout producing this evidence (null outside git). */
export function currentGitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

const DEFAULT_SUSPECT_FILES = {
  driver: [
    'drivers/windows-virtual-mic/sysvad/omni_bridge_ring.cpp',
    'drivers/windows-virtual-mic/sysvad/EndpointsCommon/minwavertstream.cpp',
    'scripts/installer/virtual-speaker-device.ps1',
  ],
  wasapi: [
    'drivers/windows-virtual-mic/sysvad/EndpointsCommon/minwavertstream.cpp',
    'drivers/windows-virtual-mic/sysvad/EndpointsCommon/speakerwavtable.h',
    'apps/bridge-service-native/src/bin/omni-driver-audio-probe.rs',
    'scripts/installer/virtual-speaker-device.ps1',
  ],
  bridge: [
    'apps/bridge-service-native/src/main.rs',
    'apps/desktop/src-tauri/src/bridge/ipc.rs',
    'apps/desktop/src-tauri/src/bridge/events.rs',
  ],
  physicalOutput: [
    'apps/bridge-service-native/src/main.rs',
    'apps/bridge-service-native/src/bin/omni-physical-output-probe.rs',
    'apps/desktop/src-tauri/src/bridge/events.rs',
    'apps/desktop/src-tauri/src/audio/speech.rs',
  ],
  physicalOutputContent: [
    'apps/bridge-service-native/src/bin/omni-physical-output-probe.rs',
    'scripts/testing/run-watch-mode-live.ps1',
    'apps/desktop/src-tauri/src/audio/speech.rs',
    'apps/desktop/src-tauri/src/audio/subtitle_translate.rs',
  ],
  app: [
    'scripts/testing/run-watch-mode-live.ps1',
    'apps/desktop/src-tauri/src/audio/events.rs',
    'apps/desktop/src-tauri/src/audio/engine.rs',
    'apps/desktop/src/pages/AudioRoutingPage.tsx',
  ],
  provider: [
    'apps/desktop/src-tauri/src/audio/omni.rs',
    'apps/desktop/src-tauri/src/audio/stt.rs',
    'apps/desktop/src-tauri/src/provider/gateway.rs',
  ],
  speechSegmentation: [
    'apps/desktop/src-tauri/src/audio/sentence.rs',
    'apps/desktop/src-tauri/src/audio/subtitle_translate.rs',
    'apps/desktop/src-tauri/src/audio/speech.rs',
  ],
  strictContent: [
    'scripts/testing/run-watch-mode-live.ps1',
    'scripts/testing/watch-mode-report.mjs',
    'apps/desktop/src-tauri/src/audio/subtitle_translate.rs',
    'apps/desktop/src-tauri/src/audio/speech.rs',
  ],
};

const PROVIDER_ERROR_PATTERNS = [
  /401|403|unauthori[sz]ed|forbidden|invalid api key|credential|\bauth(?:orization|entication)?\b/i,
  /429|rate limit|quota|insufficient|billing/i,
  /timeout|timed out|ECONNRESET|ENOTFOUND|network|websocket/i,
  /provider|dashscope|openai|model_trace|model trace|omni/i,
];

const DEFAULT_STRICT_REFERENCE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'watch-mode-en-original.zh-CN.txt',
);
const TEST_MEDIA_SHA256 = '7fd64ecd6cf0762cac5ac0ab16eba37cc733765c55cc8264f87a94cb46962131';
const STRICT_REQUIRED_CONCEPTS = [
  '十亿美元',
  '火星',
  '五亿美元',
  '人工生物圈',
  '濒危物种',
  '飞行汽车',
  '一美元的灯泡',
];
const STRICT_FORBIDDEN_ERRORS = [
  { text: '一亿美元', reason: 'one-billion amount was mistranslated as one hundred million' },
  { text: '一亿美金', reason: 'one-billion amount was mistranslated as one hundred million' },
];

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function readTextIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
}

function textAfterMarker(text, marker) {
  if (!text || !marker) return text;
  const index = text.indexOf(marker);
  return index >= 0 ? text.slice(index) : '';
}

function textAfterLocalTimestamp(text, localTimestamp) {
  if (!text || !localTimestamp) return text;
  const normalized = String(localTimestamp).replace('T', ' ').slice(0, 19);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized)) return text;
  const lines = text.split(/\r?\n/);
  const firstCurrentLine = lines.findIndex((line) => {
    const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
    return match && match[1] >= normalized;
  });
  return firstCurrentLine >= 0 ? lines.slice(firstCurrentLine).join('\n') : '';
}

function tailLines(text, pattern, limit = 12) {
  if (!text) return [];
  const matcher = typeof pattern === 'string' ? (line) => line.includes(pattern) : (line) => pattern.test(line);
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() && matcher(line))
    .slice(-limit);
}

function matchingLines(text, pattern) {
  if (!text) return [];
  const matcher = typeof pattern === 'string' ? (line) => line.includes(pattern) : (line) => pattern.test(line);
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() && matcher(line));
}

function uniqueTail(lines, limit = 12) {
  const seen = new Set();
  const output = [];
  for (const line of lines.filter(Boolean).reverse()) {
    const key = String(line);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(key);
    if (output.length >= limit) break;
  }
  return output.reverse();
}

function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.map((step) => ({
    name: String(step?.name ?? '(unnamed step)'),
    ok: step?.ok === true,
    error: step?.error ? String(step.error) : null,
    result: step?.result ?? null,
    details: step?.details ?? null,
    exitCode: step?.exitCode ?? step?.result?.exitCode ?? null,
    timedOut: step?.timedOut ?? step?.result?.timedOut ?? null,
    stdout: step?.stdout ?? step?.result?.stdout ?? null,
    stderr: step?.stderr ?? step?.result?.stderr ?? null,
  }));
}

function summarizeStepDetails(step) {
  const details = {};
  for (const key of ['exitCode', 'timedOut', 'stdout', 'stderr']) {
    if (step[key] != null) details[key] = step[key];
  }
  if (step.details != null) details.details = step.details;
  if (step.result && typeof step.result === 'object') {
    for (const key of [
      'exitCode',
      'timedOut',
      'stdout',
      'stderr',
      'outputDeviceId',
      'recordingPath',
      'transcriptionPcmPath',
      'recordSeconds',
    ]) {
      if (step.result[key] != null && details[key] == null) details[key] = step.result[key];
    }
  }
  return details;
}

function parseKeyValueLine(line) {
  const output = {};
  for (const match of line.matchAll(/([A-Za-z][A-Za-z0-9]*)=("[^"]*"|[^ ]+)/g)) {
    output[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return output;
}

export function parseBridgeLog(text) {
  const sourceSummaryLines = tailLines(text, 'source pacer summary', 5);
  const lastSourceSummary = sourceSummaryLines.at(-1) ?? '';
  const summary = parseKeyValueLine(lastSourceSummary);
  const watchdogLines = tailLines(text, 'source_watchdog', 5);
  const watchdogSummaries = watchdogLines.map(parseKeyValueLine);
  const errorLines = tailLines(text, /error|failed|blocked/i, 20);
  return {
    sourceSummaryLines,
    watchdogLines,
    watchdogSummaries,
    errorLines,
    metrics: {
      releasedFrames: asNumber(summary.releasedFrames),
      queuedFrames: asNumber(summary.queuedFrames),
      pendingBytes: asNumber(summary.pendingBytes),
      underruns: asNumber(summary.underruns),
      droppedFrames: asNumber(summary.droppedFrames),
      driverBufferedBytes: asNumber(summary.driverBufferedBytes),
      driverDroppedBytes: asNumber(summary.driverDroppedBytes),
      monitorQueuedFrames: asNumber(summary.monitorQueuedFrames),
      staleSourceFramesDropped: asNumber(summary.staleSourceFramesDropped),
    },
  };
}

function watchdogIndicatesStall(watchdog) {
  const lastProgressAgeMs = asNumber(watchdog.lastProgressAgeMs, 0);
  const capturePackets = asNumber(watchdog.capturePackets, 0);
  const captureFrames = asNumber(watchdog.captureFrames, 0);
  const readCalls = asNumber(watchdog.readCalls, 0);
  const bytesRead = asNumber(watchdog.bytesRead, 0);
  const releasedFrames = asNumber(watchdog.releasedFrames, 0);
  const phase = String(watchdog.workerPhase ?? '');
  if (/stall|stuck|blocked|error|failed/i.test(phase)) return true;
  if (lastProgressAgeMs >= 5000) return true;
  if (capturePackets === 0 && captureFrames === 0 && readCalls === 0 && bytesRead === 0 && releasedFrames === 0) {
    return true;
  }
  return false;
}

export function parseAppLog(text) {
  const nonMarkerText = text
    .split(/\r?\n/)
    .filter((line) => !line.includes('watch_mode_diagnostic.run_id='))
    .join('\n');
  return {
    routeLines: tailLines(nonMarkerText, /watch_mode\.route_start|watch route|start_audio_route|watch-mode|routeMode["=:]+"?watch|input_audio_buffer\.append/i, 20),
    routeConfigLines: tailLines(nonMarkerText, /subtitleTranslationMode=(?:native|secondary)|translationAudioSource=(?:SubtitleTts|subtitle-tts|native|auto|omni-native)|watch_mode\.omni_preconnect_(?:started|reused)|watch_mode\.subtitle_translate_fallback_native_applied/i, 30),
    omniPreconnectStartedLines: matchingLines(nonMarkerText, /watch_mode\.omni_preconnect_started/i),
    omniPreconnectReusedLines: matchingLines(nonMarkerText, /watch_mode\.omni_preconnect_reused/i),
    subtitleFallbackNativeLines: matchingLines(nonMarkerText, /watch_mode\.subtitle_translate_fallback_native_applied/i),
    overlayLines: tailLines(nonMarkerText, /watch_mode\.overlay_visible|subtitle overlay|overlay visible|subtitle-overlay/i, 20),
    subtitleLines: tailLines(nonMarkerText, /subtitle cue|cue appended|cue_id|translated=|字幕生成|翻译结果/i, 20),
    speechLines: tailLines(nonMarkerText, /speech dispatch|tts|语音|音频输出/i, 20),
    segmentSpeechLines: matchingLines(nonMarkerText, /speech\.segment_tts_queued|speech\.segment_tts_requested|speech\.segment_playback_written/i),
    subtitleConfigErrorLines: tailLines(nonMarkerText, /watch_mode\.subtitle_translate_(?:config_failed|worker_unavailable)|resolve_model_provider_from_config: purpose=subtitle-translate no provider matched|resolve_text_model_from_config/i, 20),
    omniAudioSummaryLines: tailLines(nonMarkerText, /ws\.send\.input_audio_buffer\.append\.summary.*audioRms/i, 30),
    omniVadLines: tailLines(nonMarkerText, /speech_started|transcription\.delta|conversation\.item\.input_audio_transcription|response\.audio\.delta/i, 30),
    omniSessionConfigLines: tailLines(nonMarkerText, /watch_mode\.omni_session_config/i, 20),
    omniSessionReadyLines: matchingLines(nonMarkerText, /watch_mode\.omni_session_ready/i),
    omniResponseDoneContextLines: tailLines(nonMarkerText, /\[EVENT_CONTEXT\]\s+response\.done/i, 40),
    omniResponseDoneLines: matchingLines(nonMarkerText, /response\.done/i),
    omniAsrCompletedLines: matchingLines(nonMarkerText, /conversation\.item\.input_audio_transcription\.completed|transcription\.completed/i),
    providerLines: tailLines(nonMarkerText, PROVIDER_ERROR_PATTERNS[3], 30),
    providerErrorLines: tailLines(nonMarkerText, /\b(?:status|httpStatus|code)=(?:401|403|429)\b|\bHTTP\s+(?:401|403|429)\b|"status"\s*:\s*"failed"|"error"\s*:\s*(?!"?null\b|null\b)[{\["0-9tfa-zA-Z_-]|unauthori[sz]ed|forbidden|invalid api key|credential|\bauth(?:orization|entication)?\b|rate limit|quota|insufficient|billing|timeout|timed out|ECONNRESET|ENOTFOUND|network error|websocket.*(?:failed|closed)|model_trace failed|provider.*failed/i, 30),
    errorLines: tailLines(nonMarkerText, /error|failed|panic|timeout|unauthori[sz]ed|rate limit|credential/i, 30),
  };
}

function parseOptionalNumber(value) {
  if (value == null || value === '-' || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseOmniRealtimeDiagnostics(appLog) {
  const configLine = appLog.omniSessionConfigLines.at(-1) ?? '';
  const config = parseKeyValueLine(configLine);
  const contextMetrics = appLog.omniResponseDoneContextLines
    .map(parseKeyValueLine)
    .filter((item) => Object.keys(item).length > 0);
  const latestContext = contextMetrics.at(-1) ?? {};
  const readinessLine = appLog.omniSessionReadyLines.at(-1) ?? '';
  const readiness = parseKeyValueLine(readinessLine);
  const emptyCompletedFromContext = asNumber(latestContext.emptyAsrCompletedCount, null);
  const responseDoneCountFromContext = asNumber(latestContext.responseDoneCount, null);
  const firstResponseDoneAtMs = parseOptionalNumber(latestContext.firstResponseDoneAtMs);
  const firstNonEmptyAsrCompletedAtMs = parseOptionalNumber(latestContext.firstNonEmptyAsrCompletedAtMs);
  const stActive = latestContext.st_active === 'true'
    || latestContext.subtitleTranslateActive === 'true'
    || appLog.routeConfigLines.some((line) => /st_active=true/.test(line));
  const readinessEvent = latestContext.readinessEvent
    ?? readiness.event
    ?? config.readinessEvent
    ?? null;
  const responseDoneBeforeAsrFinal = stActive
    && firstResponseDoneAtMs != null
    && (firstNonEmptyAsrCompletedAtMs == null || firstResponseDoneAtMs < firstNonEmptyAsrCompletedAtMs);

  return {
    realtimeAudioMode: config.realtimeAudioMode ?? null,
    inputAudioFormat: config.inputAudioFormat ?? null,
    isLivetranslate: config.isLivetranslate === 'true' ? true : config.isLivetranslate === 'false' ? false : null,
    subtitleTranslateActive: stActive,
    readinessEvent,
    firstNonEmptyAsrCompletedAtMs,
    firstResponseDoneAtMs,
    emptyAsrCompletedCount: emptyCompletedFromContext ?? appLog.omniAsrCompletedLines.filter((line) => /source=""|source=''|completed.*(?:source|transcript)=""|completed.*(?:source|transcript)=''/i.test(line)).length,
    responseDoneCount: responseDoneCountFromContext ?? appLog.omniResponseDoneLines.length,
    duplicateResponseDoneCount: Math.max(0, (responseDoneCountFromContext ?? appLog.omniResponseDoneLines.length) - 1),
    responseDoneBeforeAsrFinal,
    latestContextLine: appLog.omniResponseDoneContextLines.at(-1) ?? null,
  };
}

function maxOmniAudioRms(appLog) {
  return appLog.omniAudioSummaryLines.reduce((max, line) => {
    const values = [...line.matchAll(/"max"\s*:\s*([0-9.]+)/g)]
      .map((match) => Number(match[1]))
      .filter(Number.isFinite);
    return Math.max(max, ...values);
  }, 0);
}

function omniAudibleNoVadReason(appLog) {
  if (
    appLog.omniAudioSummaryLines.length > 0
    && appLog.omniVadLines.length === 0
    && maxOmniAudioRms(appLog) >= 0.02
    && appLog.subtitleLines.length === 0
  ) {
    return 'audible audio was sent to Omni, but no VAD/transcription event was received';
  }
  return null;
}

function inferTranslationRoute(input, appLog) {
  if (appLog.subtitleFallbackNativeLines.length > 0) return 'native';
  const explicit = input.translationRoute;
  if (explicit === 'native' || explicit === 'secondary') return explicit;
  const configMode = input.app?.translationRoute ?? input.app?.subtitleTranslationMode;
  if (configMode === 'native' || configMode === 'secondary') return configMode;
  const modeLine = [
    ...appLog.routeConfigLines,
    ...appLog.routeLines,
    ...appLog.providerLines,
    ...appLog.speechLines,
  ].find((line) => /subtitleTranslationMode=(native|secondary)/.test(line));
  const match = modeLine?.match(/subtitleTranslationMode=(native|secondary)/);
  if (match) return match[1];
  const snapshotRoute = input.snapshots?.translationRoute;
  if (snapshotRoute === 'native' || snapshotRoute === 'secondary') return snapshotRoute;
  return appLog.segmentSpeechLines.length > 0 ? 'secondary' : 'native';
}

function parseSpeechSegmentation(appLog) {
  const queued = appLog.segmentSpeechLines.filter((line) => line.includes('speech.segment_tts_queued'));
  const playback = appLog.segmentSpeechLines.filter((line) => line.includes('speech.segment_playback_written'));
  const queuedMetrics = queued.map(parseKeyValueLine);
  const maxTranslatedChars = queuedMetrics.reduce(
    (max, item) => Math.max(max, asNumber(item.translatedChars, 0)),
    0,
  );
  const maxSourceChars = queuedMetrics.reduce(
    (max, item) => Math.max(max, asNumber(item.sourceChars, 0)),
    0,
  );
  return {
    queuedSegments: queued.length,
    playedSegments: playback.length,
    maxSourceChars,
    maxTranslatedChars,
    evidenceLines: appLog.segmentSpeechLines,
  };
}

function driverLayerFailed(driver) {
  if (!driver) return 'driver probe did not run';
  if (driver.error && /WASAPI audio probe failed|tone|idle peak|InvalidSamples|invalid samples/i.test(driver.error)) {
    return null;
  }
  if (driver.error) return driver.error;
  if (driver.RootDeviceStatus && driver.RootDeviceStatus !== 'OK') return `root device status is ${driver.RootDeviceStatus}`;
  if (!driver.Endpoint && !driver.endpoint) return 'virtual audio endpoint was not found';
  if (driver.DriverHealth && !['running', 'ready'].includes(String(driver.DriverHealth))) {
    return `driver health is ${driver.DriverHealth}`;
  }
  return null;
}

function wasapiLayerFailed(wasapi) {
  if (!wasapi) return null;
  if (wasapi.error && /WASAPI audio probe failed|tone|idle peak|InvalidSamples|invalid samples/i.test(wasapi.error)) {
    return wasapi.error;
  }
  if (wasapi.error) return wasapi.error;
  const toneFrames = asNumber(wasapi.ToneFrames ?? wasapi.toneFrames);
  const toneRms = asNumber(wasapi.ToneRms ?? wasapi.toneRms);
  const invalidSamples = asNumber(wasapi.InvalidSamples ?? wasapi.invalidSamples);
  if (toneFrames <= 0) return 'WASAPI tone probe captured no tone frames';
  if (toneRms <= 0) return 'WASAPI tone probe is silent';
  if (invalidSamples > 0) return `WASAPI probe found ${invalidSamples} invalid samples`;
  return null;
}

function wasapiInjectedPlaybackFailed(wasapi, playback, appLog) {
  const capturedBefore = asNumber(wasapi?.CapturedBytesBeforeTone ?? wasapi?.capturedBytesBeforeTone, NaN);
  const capturedAfter = asNumber(wasapi?.CapturedBytesAfterTone ?? wasapi?.capturedBytesAfterTone, NaN);
  const hasDriverToneCounters = Number.isFinite(capturedBefore) && Number.isFinite(capturedAfter);
  if (!hasDriverToneCounters && (!playback || !/sapi|media|speech/i.test(String(playback.playbackMode ?? '')))) return null;
  if (appLog.subtitleLines.length > 0) return null;
  if (!hasDriverToneCounters && appLog.routeLines.length === 0) return null;
  const idleRms = asNumber(wasapi?.IdleRms ?? wasapi?.idleRms, NaN);
  const toneRms = asNumber(wasapi?.ToneRms ?? wasapi?.toneRms, NaN);
  const postToneIdleRms = asNumber(wasapi?.PostToneIdleRms ?? wasapi?.postToneIdleRms, NaN);
  const toneFrequency = asNumber(wasapi?.ToneFrequencyHz ?? wasapi?.toneFrequencyHz, 0);
  const toneComponent = asNumber(wasapi?.ToneComponent ?? wasapi?.toneComponent, 0);
  const rmsStable =
    Number.isFinite(idleRms)
    && Number.isFinite(toneRms)
    && Number.isFinite(postToneIdleRms)
    && Math.abs(idleRms - toneRms) < 0.000001
    && Math.abs(toneRms - postToneIdleRms) < 0.000001;
  if (rmsStable && toneFrequency === 3000 && Math.abs(toneComponent) < 0.000001) {
    if (hasDriverToneCounters && capturedAfter <= capturedBefore) {
      const renderStreams = asNumber(wasapi?.RenderStreamsCreatedAfterTone ?? wasapi?.renderStreamsCreatedAfterTone, NaN);
      const renderRuns = asNumber(wasapi?.RenderRunTransitionsAfterTone ?? wasapi?.renderRunTransitionsAfterTone, NaN);
      const setWritePackets = asNumber(wasapi?.RenderSetWritePacketCallsAfterTone ?? wasapi?.renderSetWritePacketCallsAfterTone, NaN);
      const readBytes = asNumber(wasapi?.RenderReadBytesCallsAfterTone ?? wasapi?.renderReadBytesCallsAfterTone, NaN);
      if (Number.isFinite(renderStreams) && renderStreams === 0) {
        return 'WASAPI render tone was submitted, but the driver reported no system render stream creation and loopback stayed on the fixed 3 kHz baseline';
      }
      if (Number.isFinite(renderRuns) && renderRuns === 0) {
        return 'WASAPI render tone created a driver render stream, but it never transitioned to RUN and loopback stayed on the fixed 3 kHz baseline';
      }
      if (Number.isFinite(setWritePackets) && Number.isFinite(readBytes) && setWritePackets === 0 && readBytes === 0) {
        return 'WASAPI render tone reached a RUN render stream, but neither SetWritePacket nor render ReadBytes fired, so driver capturedBytes did not increase';
      }
      return 'WASAPI render tone was submitted to the virtual speaker, but driver capturedBytes did not increase and loopback stayed on the fixed 3 kHz baseline';
    }
    return 'injected playback reached the virtual speaker, but WASAPI capture stayed on the fixed 3 kHz baseline and produced no subtitle/VAD evidence';
  }
  return null;
}

function bridgeLayerFailed(bridge, bridgeLog) {
  const metrics = bridgeLog.metrics;
  if (bridge?.probePassed === false) {
    return bridge.error
      ? `bridge source frame probe failed: ${bridge.error}`
      : 'bridge source frame probe did not pass';
  }
  if (bridge?.error) return `bridge source probe failed: ${bridge.error}`;
  if (bridge?.lastErrorCode) return bridge.lastErrorCode;
  if (bridge?.driverHealth && bridge.driverHealth !== 'running') return `bridge driverHealth is ${bridge.driverHealth}`;
  if (bridge?.bridgeState && !['running', 'ready'].includes(bridge.bridgeState)) return `bridgeState is ${bridge.bridgeState}`;
  if (bridge?.sourceSubscriberActive === false) return 'bridge source subscriber is not active';
  if (
    asNumber(bridge?.sourceReadCalls) === 0
    && asNumber(bridge?.sourceFramePayloadBytes) === 0
    && metrics.releasedFrames === 0
    && metrics.driverBufferedBytes === 0
  ) {
    return `bridge did not read source frames from the virtual speaker; sourceReadCalls=${asNumber(bridge?.sourceReadCalls)} sourceFramePayloadBytes=${asNumber(bridge?.sourceFramePayloadBytes)} releasedFrames=${metrics.releasedFrames} driverBufferedBytes=${metrics.driverBufferedBytes}`;
  }
  if (metrics.queuedFrames > 10 || metrics.pendingBytes > 192000) {
    return `bridge source queue is accumulating; queuedFrames=${metrics.queuedFrames} pendingBytes=${metrics.pendingBytes}`;
  }
  if (metrics.droppedFrames > 0 || metrics.driverDroppedBytes > 0 || asNumber(bridge?.droppedFrameCount) > 0) {
    return `bridge or driver dropped audio frames; droppedFrames=${metrics.droppedFrames} driverDroppedBytes=${metrics.driverDroppedBytes} droppedFrameCount=${asNumber(bridge?.droppedFrameCount)}`;
  }
  const stalledWatchdog = bridgeLog.watchdogSummaries.find(watchdogIndicatesStall);
  if (stalledWatchdog) {
    return `bridge source watchdog reported a stall; workerPhase=${stalledWatchdog.workerPhase ?? '-'} lastProgressAgeMs=${stalledWatchdog.lastProgressAgeMs ?? '-'} captureFrames=${stalledWatchdog.captureFrames ?? '-'} releasedFrames=${stalledWatchdog.releasedFrames ?? '-'}`;
  }
  return null;
}

function subtitleTranslateConfigLayerFailed(appLog) {
  if (appLog.subtitleFallbackNativeLines.length > 0) {
    return null;
  }
  if (appLog.subtitleConfigErrorLines.length > 0) {
    return `subtitle translate provider/worker configuration failed: ${appLog.subtitleConfigErrorLines.at(-1)}`;
  }
  return null;
}

function secondaryPreconnectLayerFailed(appLog, translationRoute) {
  if (translationRoute !== 'secondary') return null;
  if (appLog.omniPreconnectStartedLines.length === 0) {
    return 'secondary route did not start Omni preconnect';
  }
  if (appLog.omniPreconnectReusedLines.length === 0) {
    return 'secondary route did not reuse the Omni preconnect';
  }
  return null;
}

function appLayerFailed(app, appLog, options = {}) {
  const configReason = subtitleTranslateConfigLayerFailed(appLog);
  if (configReason) return configReason;
  if (app?.routeState && !['capturing', 'running', 'active'].includes(app.routeState)) return `routeState is ${app.routeState}`;
  if (app?.overlayVisible === false && appLog.overlayLines.length === 0) return 'subtitle overlay did not become visible';
  if (app?.routeState == null && appLog.routeLines.length === 0) return 'no current watch route evidence was found';
  if (asNumber(app?.subtitleCueCount ?? app?.subtitleCues) === 0 && appLog.subtitleLines.length === 0) {
    return 'no subtitle cue evidence was found';
  }
  const subtitleQueue = app?.subtitleQueue;
  if (asNumber(subtitleQueue?.cueOrderInversions) > 0) {
    return `subtitle queue emitted final translations out of cue order; inversions=${subtitleQueue.cueOrderInversions}`;
  }
  if (asNumber(subtitleQueue?.duplicateFinalTranslations) > 0) {
    return `subtitle queue emitted duplicate final translations; duplicates=${subtitleQueue.duplicateFinalTranslations}`;
  }
  if (options.translationRoute === 'secondary') {
    const firstVisibleLatency = asNumber(subtitleQueue?.firstVisibleTranslationLatencySeconds, null);
    const firstFinalLatency = asNumber(subtitleQueue?.firstFinalTranslationLatencySeconds, null);
    if (firstVisibleLatency != null && firstVisibleLatency > 8) {
      return `first visible subtitle translation latency is too high; latencySeconds=${firstVisibleLatency}`;
    }
    if (firstFinalLatency != null && firstFinalLatency > 15) {
      return `first final subtitle translation latency is too high; latencySeconds=${firstFinalLatency}`;
    }
  }
  return null;
}

function providerLayerFailed(provider, appLog, physicalOutputContent, options = {}) {
  if (provider?.error) return provider.error;
  const physicalContentPassed = physicalOutputContent?.passed === true
    && physicalOutputContent?.recording?.passed !== false;
  const hardProviderError = appLog.providerErrorLines.some((line) => (
    /unauthori[sz]ed|forbidden|invalid api key|credential|\bauth(?:orization|entication)?\b|rate limit|quota|insufficient|billing|\b(?:401|403|429)\b/i
      .test(line)
  ));
  const hasRecoveredUserVisibleOutput = appLog.subtitleLines.length > 0
    && appLog.providerLines.some((line) => /provider\.translate_text.*"status"\s*:\s*"succeeded"|subtitle translate success|TRANS_WRITE/i.test(line));
  const latestProviderError = appLog.providerErrorLines.at(-1);
  if (hardProviderError) return `provider credential/rate-limit error evidence found in app.log: ${latestProviderError ?? 'no provider error line captured'}`;
  if (options.hardOnly) return null;
  if (provider?.failedCalls > 0 && !hasRecoveredUserVisibleOutput && !physicalContentPassed) {
    return `${provider.failedCalls} provider call(s) failed${latestProviderError ? `; latest=${latestProviderError}` : ''}`;
  }
  if (appLog.providerErrorLines.length > 0 && !hasRecoveredUserVisibleOutput && !physicalContentPassed) {
    return `provider/model error evidence found in app.log: ${latestProviderError}`;
  }
  const noVadReason = omniAudibleNoVadReason(appLog);
  if (noVadReason) return noVadReason;
  const realtimeDiagnostics = parseOmniRealtimeDiagnostics(appLog);
  if (realtimeDiagnostics.responseDoneBeforeAsrFinal) {
    return `Omni response.done arrived before non-empty ASR completed while secondary translation was active; realtimeAudioMode=${realtimeDiagnostics.realtimeAudioMode ?? '-'} readinessEvent=${realtimeDiagnostics.readinessEvent ?? '-'} firstResponseDoneAtMs=${realtimeDiagnostics.firstResponseDoneAtMs ?? '-'} firstNonEmptyAsrCompletedAtMs=${realtimeDiagnostics.firstNonEmptyAsrCompletedAtMs ?? '-'} emptyAsrCompletedCount=${realtimeDiagnostics.emptyAsrCompletedCount}`;
  }
  if (provider?.totalCalls === 0) return 'no provider call evidence was found';
  return null;
}

function physicalOutputLayerFailed(physicalOutput) {
  if (!physicalOutput) return 'physical output probe did not run';
  if (physicalOutput.error) return physicalOutput.error;
  if (physicalOutput.passed === false) return physicalOutput.detail ?? 'physical output probe failed';
  if (!physicalOutput.resolvedPhysicalPlaybackDeviceId && !physicalOutput.resolved_physical_playback_device_id) {
    return 'physical playback device was not resolved';
  }
  const framesBefore = asNumber(
    physicalOutput.playbackFramesWrittenBefore ?? physicalOutput.playback_frames_written_before,
    NaN,
  );
  const framesAfter = asNumber(
    physicalOutput.playbackFramesWrittenAfter ?? physicalOutput.playback_frames_written_after,
    NaN,
  );
  const capturedFrames = asNumber(physicalOutput.capturedFrames ?? physicalOutput.captured_frames, 0);
  const rms = asNumber(physicalOutput.rms, 0);
  const toneComponent = asNumber(physicalOutput.toneComponent ?? physicalOutput.tone_component, 0);
  const invalidSamples = asNumber(physicalOutput.invalidSamples ?? physicalOutput.invalid_samples, 0);
  if (Number.isFinite(framesBefore) && Number.isFinite(framesAfter) && framesAfter <= framesBefore) {
    return `bridge did not write frames to the physical playback device; playbackFramesWrittenBefore=${framesBefore} playbackFramesWrittenAfter=${framesAfter}`;
  }
  if (capturedFrames <= 0) return `physical playback loopback captured no frames; capturedFrames=${capturedFrames} rms=${rms} toneComponent=${toneComponent}`;
  if (rms <= 0) return `physical playback loopback is silent; capturedFrames=${capturedFrames} rms=${rms} toneComponent=${toneComponent}`;
  if (toneComponent <= 0) return `physical playback loopback did not capture the probe tone; capturedFrames=${capturedFrames} rms=${rms} toneComponent=${toneComponent}`;
  if (invalidSamples > 0) return `physical playback loopback captured ${invalidSamples} invalid sample(s)`;
  return null;
}

function normalizeMeaningText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function splitMeaningClauses(value) {
  return String(value ?? '')
    .split(/\r?\n|[。！？!?；;]+/u)
    .map((item) => item.trim())
    .filter((item) => normalizeMeaningText(item).length >= 2);
}

function characterOverlapScore(left, right) {
  const a = normalizeMeaningText(left);
  const b = normalizeMeaningText(right);
  if (!a || !b) return 0;
  const rightCounts = new Map();
  for (const char of b) rightCounts.set(char, (rightCounts.get(char) ?? 0) + 1);
  let overlap = 0;
  for (const char of a) {
    const count = rightCounts.get(char) ?? 0;
    if (count > 0) {
      overlap += 1;
      rightCounts.set(char, count - 1);
    }
  }
  return overlap / Math.max(1, Math.min([...a].length, [...b].length));
}

function uniqueEvidenceText(parts) {
  const seen = new Set();
  const lines = [];
  for (const part of parts) {
    for (const clause of splitMeaningClauses(part)) {
      const key = normalizeMeaningText(clause);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      lines.push(clause);
    }
  }
  return lines.join('\n');
}

function isStrictTestMediaEvidence(content, playback) {
  const mediaSha = String(content?.sourceReference?.mediaSha256 ?? '').toLowerCase();
  if (mediaSha === TEST_MEDIA_SHA256) return true;
  const paths = [
    content?.sourceReference?.mediaPath,
    playback?.mediaPath,
  ].filter(Boolean).map((item) => String(item).replace(/\\/g, '/').toLowerCase());
  return paths.some((item) => item.endsWith('/scripts/testing/fixtures/watch-mode-en-original.wav'));
}

export function evaluateStrictContent(input) {
  const content = input.physicalOutputContent;
  const playback = input.playback;
  const applicable = isStrictTestMediaEvidence(content, playback);
  const referenceText = String(input.strictReferenceText ?? readTextIfExists(DEFAULT_STRICT_REFERENCE_PATH)).trim();
  if (!applicable) {
    return {
      applicable: false,
      skipped: true,
      passed: true,
      reason: 'strict reference-media gate is not applicable to this run',
    };
  }
  if (!referenceText) {
    return {
      applicable: true,
      passed: false,
      reason: `strict reference translation fixture was not found: ${DEFAULT_STRICT_REFERENCE_PATH}`,
    };
  }

  const sourcePlaybackSeconds = asNumber(content?.sourceReference?.playbackSeconds, null);
  const fullMedia = content?.sourceReference?.fullMedia === true
    || sourcePlaybackSeconds == null
    || sourcePlaybackSeconds <= 0;
  const outputText = uniqueEvidenceText([
    content?.translation,
    content?.subtitleText,
    content?.segmentTranslationText,
  ]);
  const referenceClauses = splitMeaningClauses(referenceText);
  const outputClauses = splitMeaningClauses(outputText);
  const missingClauses = [];
  for (const clause of referenceClauses) {
    const best = outputClauses.reduce(
      (max, candidate) => Math.max(max, characterOverlapScore(clause, candidate)),
      0,
    );
    if (best < 0.45) missingClauses.push(clause);
  }
  const coverage = referenceClauses.length > 0
    ? (referenceClauses.length - missingClauses.length) / referenceClauses.length
    : 0;
  const normalizedOutput = normalizeMeaningText(outputText);
  const missingConcepts = STRICT_REQUIRED_CONCEPTS.filter(
    (concept) => !normalizedOutput.includes(normalizeMeaningText(concept)),
  );
  const forbiddenErrors = STRICT_FORBIDDEN_ERRORS.filter(
    (item) => normalizedOutput.includes(normalizeMeaningText(item.text)),
  );
  const referenceChars = normalizeMeaningText(referenceText).length;
  const outputChars = normalizedOutput.length;
  const lengthRatio = referenceChars > 0 ? outputChars / referenceChars : 0;
  const subtitleQueue = content?.subtitleQueue ?? {};
  const speechSegmentation = input.speechSegmentation ?? {};
  const finalWriteCount = asNumber(subtitleQueue.finalWriteCount);
  const queuedSegmentCount = Math.max(
    asNumber(subtitleQueue.queuedSegmentCount),
    asNumber(content?.translatedSpeech?.queuedSegments),
    asNumber(speechSegmentation.queuedSegments),
  );
  const playedSegmentCount = Math.max(
    asNumber(subtitleQueue.playedSegmentCount),
    asNumber(content?.translatedSpeech?.playedSegments),
    asNumber(speechSegmentation.playedSegments),
  );
  const combinedEvidence = content?.contentConsistency?.combinedEvidence;
  let coverageEvidence = coverage;
  let lengthRatioEvidence = lengthRatio;
  let referenceClauseCountEvidence = referenceClauses.length;
  let outputClauseCountEvidence = outputClauses.length;
  let missingClausesEvidence = missingClauses;
  let strictEvidenceSource = 'structured';
  if (combinedEvidence?.passed === true) {
    const combinedCoverage = asNumber(combinedEvidence.coverage, NaN);
    const combinedLengthRatio = asNumber(combinedEvidence.lengthRatio, NaN);
    const combinedReferenceClauseCount = asNumber(combinedEvidence.referenceClauseCount, NaN);
    const combinedOutputClauseCount = asNumber(combinedEvidence.outputClauseCount, NaN);
    if (Number.isFinite(combinedCoverage)) {
      coverageEvidence = combinedCoverage;
      strictEvidenceSource = 'combinedPhysical';
    }
    if (Number.isFinite(combinedLengthRatio)) {
      lengthRatioEvidence = combinedLengthRatio;
      strictEvidenceSource = 'combinedPhysical';
    }
    if (Number.isFinite(combinedReferenceClauseCount)) {
      referenceClauseCountEvidence = combinedReferenceClauseCount;
    }
    if (Number.isFinite(combinedOutputClauseCount)) {
      outputClauseCountEvidence = combinedOutputClauseCount;
    }
    if (Array.isArray(combinedEvidence.missingClauses)) {
      missingClausesEvidence = combinedEvidence.missingClauses;
    } else if (Number.isFinite(combinedCoverage) && combinedCoverage >= 0.83) {
      missingClausesEvidence = [];
    }
  }
  const failures = [];
  if (!fullMedia) failures.push(`strict reference-media gate requires full-media playback; playbackSeconds=${sourcePlaybackSeconds}`);
  if (coverageEvidence < 0.83 || missingClausesEvidence.length > 2) {
    failures.push(`reference translation coverage is too low; coverage=${coverageEvidence.toFixed(3)} missingClauses=${missingClausesEvidence.length}`);
  }
  if (missingConcepts.length > 0) failures.push(`missing required concepts: ${missingConcepts.join(', ')}`);
  if (forbiddenErrors.length > 0) failures.push(`forbidden translation errors: ${forbiddenErrors.map((item) => item.text).join(', ')}`);
  if (lengthRatioEvidence < 0.45 || lengthRatioEvidence > 2.4) failures.push(`strict output/reference length ratio is out of range; lengthRatio=${lengthRatioEvidence.toFixed(3)}`);
  if (finalWriteCount < 8) failures.push(`too few final subtitle translations; finalWriteCount=${finalWriteCount}`);
  if (queuedSegmentCount < 8) failures.push(`too few queued translated speech segments; queuedSegmentCount=${queuedSegmentCount}`);
  if (playedSegmentCount < 8) failures.push(`too few played translated speech segments; playedSegmentCount=${playedSegmentCount}`);
  if (content?.contentConsistency?.combinedEvidence?.passed === false) {
    failures.push('combined physical/structured translation evidence did not pass');
  }

  return {
    applicable: true,
    passed: failures.length === 0,
    reason: failures[0] ?? null,
    failures,
    coverage: Number(coverageEvidence.toFixed(3)),
    structuredCoverage: Number(coverage.toFixed(3)),
    lengthRatio: Number(lengthRatioEvidence.toFixed(3)),
    structuredLengthRatio: Number(lengthRatio.toFixed(3)),
    referenceClauseCount: referenceClauseCountEvidence,
    outputClauseCount: outputClauseCountEvidence,
    missingClauses: missingClausesEvidence,
    structuredMissingClauses: missingClauses,
    strictEvidenceSource,
    missingConcepts,
    forbiddenErrors,
    requiredConcepts: STRICT_REQUIRED_CONCEPTS,
    finalWriteCount,
    queuedSegmentCount,
    playedSegmentCount,
    fullMedia,
    referencePath: DEFAULT_STRICT_REFERENCE_PATH,
  };
}

function physicalOutputContentLayerFailed(content) {
  if (!content) return 'physical output content recording/STT did not run';
  if (content.skipped) return `physical output content STT was skipped: ${content.reason ?? 'no reason provided'}`;
  if (content.error) return content.error;
  const recording = content.recording ?? {};
  if (recording.passed === false) return recording.detail ?? recording.error ?? 'physical output recording failed';
  if (!recording.recordingPath) return 'physical output WAV recording artifact was not created';
  if (!recording.transcriptionPcmPath) return 'physical output transcription PCM artifact was not created';
  if (asNumber(recording.capturedFrames) <= 0) return 'physical output content recording captured no frames';
  if (asNumber(recording.rms) <= 0) return 'physical output content recording is silent';
  const audioQuality = content.audioQuality ?? recording.audioQuality;
  if (audioQuality?.passed === false) {
    return audioQuality.detail ?? audioQuality.error ?? 'physical output recording audio quality failed';
  }
  if (content.originalPassthrough || content.translatedSpeech || content.mixedOutput) {
    if (content.originalPassthrough?.passed === false) {
      const transcriptEvidencePassed = content.contentConsistency?.physicalTranscript?.passed === true
        || (content.contentConsistency?.passed === true && asNumber(content.originalPassthrough.transcriptChars) > 0);
      if (!transcriptEvidencePassed) {
        const similarity = content.originalPassthrough.sourceSimilarity;
        if (similarity?.detail) return similarity.detail;
        if (similarity?.error) return similarity.error;
        return 'physical output recording did not contain recognizable original passthrough audio';
      }
    }
    if (content.mixedOutput?.passed === false) {
      return content.mixedOutput.detail
        ?? content.mixedOutput.error
        ?? `physical output recording did not contain mixed audible output; rms=${asNumber(content.mixedOutput.rms)} peak=${asNumber(content.mixedOutput.peak)}`;
    }
    if (content.translatedSpeech?.passed === false) {
      return content.translatedSpeech.detail
        ?? content.translatedSpeech.error
        ?? `secondary translated speech was not written to physical output; queuedSegments=${asNumber(content.translatedSpeech.queuedSegments)} playedSegments=${asNumber(content.translatedSpeech.playedSegments)}`;
    }
    if (content.contentConsistency?.combinedEvidence?.passed === false) {
      return content.contentConsistency.combinedEvidence.detail
        ?? content.contentConsistency.combinedEvidence.error
        ?? 'combined physical/structured translation evidence did not pass';
    }
    if (content.contentConsistency?.passed === false) {
      const details = [];
      if (Number.isFinite(Number(content.contentConsistency.coverage))) {
        details.push(`coverage=${Number(content.contentConsistency.coverage).toFixed(3)}`);
      }
      if (Number.isFinite(Number(content.contentConsistency.lengthRatio))) {
        details.push(`lengthRatio=${Number(content.contentConsistency.lengthRatio).toFixed(3)}`);
      }
      const missing = Array.isArray(content.contentConsistency.missingClauses)
        ? content.contentConsistency.missingClauses.length
        : 0;
      const extra = Array.isArray(content.contentConsistency.extraClauses)
        ? content.contentConsistency.extraClauses.length
        : 0;
      if (missing > 0) details.push(`missingClauses=${missing}`);
      if (extra > 0) details.push(`extraClauses=${extra}`);
      return `physical output content diverged from source media reference${details.length ? `; ${details.join(' ')}` : ''}`;
    }
    return null;
  }
  if (content.passed === false) return content.detail ?? content.error ?? 'physical output content STT failed';
  const subtitleText = String(content.subtitleText ?? '');
  const transcriptText = [content.source, content.translation].filter(Boolean).join('\n');
  if (!normalizeMeaningText(subtitleText)) return 'no subtitle text was available for physical output content comparison';
  if (!normalizeMeaningText(transcriptText)) return 'physical output STT returned no usable transcript';
  const score = characterOverlapScore(transcriptText, subtitleText);
  const configuredScore = Number(content.similarityScore);
  const effectiveScore = Number.isFinite(configuredScore) ? Math.max(score, configuredScore) : score;
  if (effectiveScore < 0.18) {
    return `physical output STT did not match subtitle text; overlap=${effectiveScore.toFixed(3)}`;
  }
  return null;
}

function summarizePhysicalOutputContent(content) {
  if (!content) return null;
  return {
    passed: content.passed ?? null,
    error: content.error ?? null,
    detail: content.detail ?? null,
    recording: content.recording ? {
      passed: content.recording.passed ?? null,
      error: content.recording.error ?? null,
      detail: content.recording.detail ?? null,
      recordingPath: content.recording.recordingPath ?? null,
      transcriptionPcmPath: content.recording.transcriptionPcmPath ?? null,
      capturedFrames: content.recording.capturedFrames ?? null,
      rms: content.recording.rms ?? null,
    } : null,
    mixedOutput: content.mixedOutput ?? null,
    translatedSpeech: content.translatedSpeech ?? null,
    originalPassthrough: content.originalPassthrough ?? null,
    contentConsistency: content.contentConsistency ?? null,
  };
}

function summarizePhysicalOutput(physicalOutput) {
  if (!physicalOutput) return null;
  return {
    passed: physicalOutput.passed ?? null,
    error: physicalOutput.error ?? null,
    detail: physicalOutput.detail ?? null,
    physicalPlaybackDeviceId: physicalOutput.physicalPlaybackDeviceId ?? physicalOutput.physical_playback_device_id ?? null,
    resolvedPhysicalPlaybackDeviceId: physicalOutput.resolvedPhysicalPlaybackDeviceId ?? physicalOutput.resolved_physical_playback_device_id ?? null,
    resolvedPhysicalPlaybackDeviceName: physicalOutput.resolvedPhysicalPlaybackDeviceName ?? physicalOutput.resolved_physical_playback_device_name ?? null,
    playbackFramesWrittenBefore: physicalOutput.playbackFramesWrittenBefore ?? physicalOutput.playback_frames_written_before ?? null,
    playbackFramesWrittenAfter: physicalOutput.playbackFramesWrittenAfter ?? physicalOutput.playback_frames_written_after ?? null,
    capturedFrames: physicalOutput.capturedFrames ?? physicalOutput.captured_frames ?? null,
    rms: physicalOutput.rms ?? null,
    toneComponent: physicalOutput.toneComponent ?? physicalOutput.tone_component ?? null,
    invalidSamples: physicalOutput.invalidSamples ?? physicalOutput.invalid_samples ?? null,
  };
}

function createLayer(name, data, extra = {}) {
  return {
    status: 'passed',
    reason: null,
    reasons: [],
    data: data ?? null,
    ...extra,
  };
}

function addLayerFailure(layers, layer, reason, mode) {
  if (!reason) return;
  const entry = layers[layer];
  if (!entry) return;
  const status = mode === 'dry-run' && reason.includes('did not run') ? 'inconclusive' : 'failed';
  if (entry.status !== 'failed') {
    entry.status = status;
  }
  if (!entry.reason) {
    entry.reason = reason;
  }
  if (!entry.reasons.includes(reason)) {
    entry.reasons.push(reason);
  }
}

function buildReportDiagnostics(input, layers, checks, appLog, bridgeLog) {
  const steps = normalizeSteps(input.steps);
  const failedSteps = steps
    .filter((step) => !step.ok)
    .map((step) => ({
      name: step.name,
      error: step.error ?? 'step failed without an error message',
      details: summarizeStepDetails(step),
    }));
  const failedLayers = Object.entries(layers)
    .filter(([, layer]) => layer.status === 'failed' || layer.status === 'inconclusive')
    .map(([layer, details]) => ({
      layer,
      status: details.status,
      reason: details.reason,
      reasons: details.reasons ?? [],
    }));
  const checkFailures = checks
    .filter(([, reason]) => reason)
    .map(([layer, reason]) => ({ layer, reason }));

  return {
    runnerFailure: input.failure?.message ?? null,
    failedSteps,
    failedLayers,
    checkFailures,
    evidence: {
      appErrors: uniqueTail(appLog.errorLines, 12),
      appProviderErrors: uniqueTail(appLog.providerErrorLines, 8),
      providerErrors: uniqueTail(appLog.providerErrorLines, 8),
      appRouteConfig: uniqueTail(appLog.routeConfigLines, 8),
      appOmniPreconnect: uniqueTail([
        ...appLog.omniPreconnectStartedLines,
        ...appLog.omniPreconnectReusedLines,
        ...matchingLines(input.appLogText ?? '', /watch_mode\.omni_preconnect_discarded|watch_mode\.omni_session_ready|diagnostic_autostart_(?:omni_preconnect|route)_(?:failed|started)/i),
      ], 12),
      appReadiness: uniqueTail(matchingLines(input.appLogText ?? '', /readiness|session\.(?:created|updated)|ws\.recv\.session|watch_mode\.omni_session_ready/i), 12),
      realtimeSession: parseOmniRealtimeDiagnostics(appLog),
      bridgeErrors: uniqueTail(bridgeLog.errorLines, 12),
      bridgeSourceSummary: uniqueTail(bridgeLog.sourceSummaryLines, 5),
      bridgeWatchdog: uniqueTail(bridgeLog.watchdogLines, 5),
      bridgeMetrics: bridgeLog.metrics,
      physicalOutput: summarizePhysicalOutput(input.physicalOutput),
      physicalOutputContent: summarizePhysicalOutputContent(input.physicalOutputContent),
    },
  };
}

function speechSegmentationLayerFailed(segmentation, translationRoute) {
  if (translationRoute !== 'secondary') return null;
  if (!segmentation) return 'speech segmentation metrics were not collected';
  if (asNumber(segmentation.queuedSegments) <= 0) return 'secondary route did not queue any final segment TTS task';
  if (asNumber(segmentation.playedSegments) <= 0) return 'secondary route did not write any segment playback';
  if (asNumber(segmentation.maxSourceChars) > 140) {
    return `secondary source segment is too long: ${segmentation.maxSourceChars} chars`;
  }
  if (asNumber(segmentation.maxTranslatedChars) > 160) {
    return `secondary translated segment is too long: ${segmentation.maxTranslatedChars} chars`;
  }
  return null;
}

export const ECHO_CANCEL_SKIPPED_LAYERS = [
  'bridge',
  'physicalOutput',
  'physicalOutputContent',
  'speechSegmentation',
  'strictContent',
];

function normalizeFeedbackLoopPrevention(value) {
  return value === 'echo-cancel' ? 'echo-cancel' : 'virtual-driver';
}

export function classifyWatchModeRun(input) {
  const feedbackLoopPrevention = normalizeFeedbackLoopPrevention(
    input.feedbackLoopPrevention ?? input.snapshots?.feedbackLoopPrevention,
  );
  const echoCancelVariant = feedbackLoopPrevention === 'echo-cancel';
  const bridgeLog = parseBridgeLog(input.bridgeLogText ?? '');
  const appLog = parseAppLog(input.appLogText ?? '');
  const translationRoute = inferTranslationRoute(input, appLog);
  const speechSegmentation = input.speechSegmentation ?? parseSpeechSegmentation(appLog);
  const realtimeSession = parseOmniRealtimeDiagnostics(appLog);
  const strictContent = input.strictContent ?? evaluateStrictContent({
    ...input,
    speechSegmentation,
  });
  const layers = {
    driver: createLayer('driver', input.driver),
    wasapi: createLayer('wasapi', input.wasapi),
    bridge: createLayer('bridge', input.bridge, {
      parsedLog: bridgeLog,
    }),
    physicalOutput: createLayer('physicalOutput', input.physicalOutput),
    physicalOutputContent: createLayer('physicalOutputContent', input.physicalOutputContent),
    speechSegmentation: createLayer('speechSegmentation', speechSegmentation),
    strictContent: createLayer('strictContent', strictContent),
    app: createLayer('app', input.app, {
      parsedLog: appLog,
    }),
    provider: createLayer('provider', input.provider),
  };
  if (!echoCancelVariant && !strictContent.passed) {
    layers.strictContent.status = 'failed';
    layers.strictContent.reason = strictContent.reason ?? 'strict reference-media content evidence failed';
    layers.strictContent.reasons = Array.isArray(strictContent.failures) && strictContent.failures.length > 0
      ? strictContent.failures
      : [layers.strictContent.reason];
  }
  if (echoCancelVariant) {
    for (const layer of ECHO_CANCEL_SKIPPED_LAYERS) {
      layers[layer].status = 'skipped';
      layers[layer].reason = 'echo-cancel variant does not require this evidence layer';
      layers[layer].reasons = [];
    }
  }

  const runnerFailureReason = input.failure?.message ?? null;
  const hardProviderReason = providerLayerFailed(input.provider, appLog, input.physicalOutputContent, { hardOnly: true });
  const providerReason = providerLayerFailed(input.provider, appLog, input.physicalOutputContent);
  const providerBeforeAppReason = omniAudibleNoVadReason(appLog);
  const subtitleConfigReason = subtitleTranslateConfigLayerFailed(appLog);
  const secondaryPreconnectReason = secondaryPreconnectLayerFailed(appLog, translationRoute);
  const checks = runnerFailureReason
    ? [
        ['app', runnerFailureReason],
        ['driver', driverLayerFailed(input.driver)],
        ['wasapi', wasapiLayerFailed(input.wasapi) ?? wasapiInjectedPlaybackFailed(input.wasapi, input.playback, appLog)],
        ['bridge', bridgeLayerFailed(input.bridge, bridgeLog)],
        ['physicalOutput', physicalOutputLayerFailed(input.physicalOutput)],
        ...(subtitleConfigReason ? [['app', subtitleConfigReason]] : []),
        ...(hardProviderReason ? [['provider', hardProviderReason]] : []),
        ...(secondaryPreconnectReason ? [['app', secondaryPreconnectReason]] : []),
        ['physicalOutputContent', physicalOutputContentLayerFailed(input.physicalOutputContent)],
        ['provider', providerReason],
        ['speechSegmentation', speechSegmentationLayerFailed(speechSegmentation, translationRoute)],
        ['strictContent', layers.strictContent.reason],
      ]
    : [
        ['driver', driverLayerFailed(input.driver)],
        ['wasapi', wasapiLayerFailed(input.wasapi) ?? wasapiInjectedPlaybackFailed(input.wasapi, input.playback, appLog)],
        ['bridge', bridgeLayerFailed(input.bridge, bridgeLog)],
        ['physicalOutput', physicalOutputLayerFailed(input.physicalOutput)],
        ...(subtitleConfigReason ? [['app', subtitleConfigReason]] : []),
        ...(hardProviderReason ? [['provider', hardProviderReason]] : []),
        ...(providerBeforeAppReason ? [['provider', providerReason]] : []),
        ...(secondaryPreconnectReason ? [['app', secondaryPreconnectReason]] : []),
        ['app', appLayerFailed(input.app, appLog, { translationRoute })],
        ['physicalOutputContent', physicalOutputContentLayerFailed(input.physicalOutputContent)],
        ...(providerBeforeAppReason ? [] : [['provider', providerReason]]),
        ['speechSegmentation', speechSegmentationLayerFailed(speechSegmentation, translationRoute)],
        ['strictContent', layers.strictContent.reason],
      ];

  const activeChecks = echoCancelVariant
    ? checks.filter(([layer]) => !ECHO_CANCEL_SKIPPED_LAYERS.includes(layer))
    : checks;

  for (const [layer, reason] of activeChecks) {
    addLayerFailure(layers, layer, reason, input.mode ?? 'live');
  }

  const failed = activeChecks.find(([layer]) => layers[layer].status === 'failed');
  const inconclusive = activeChecks.find(([layer]) => layers[layer].status === 'inconclusive');
  const failureLayer = failed?.[0] ?? inconclusive?.[0] ?? null;
  const verdict = failed ? 'failed' : inconclusive ? 'inconclusive' : 'passed';
  const diagnostics = buildReportDiagnostics(input, layers, activeChecks, appLog, bridgeLog);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    // Provenance for the strict evidence gate: which source revision produced
    // this evidence (verify-watch-mode-evidence --strict rejects reports whose
    // commit is not an ancestor of HEAD or whose age exceeds the budget).
    commit: input.commit ?? currentGitCommit(),
    buildHash: input.buildHash ?? null,
    mode: input.mode ?? 'live',
    modelId: input.modelId ?? input.snapshots?.modelId ?? null,
    feedbackLoopPrevention,
    realtimeSession,
    translationRoute,
    verdict,
    failureLayer,
    failureReason: failureLayer ? layers[failureLayer].reason : null,
    suspectFiles: failureLayer ? DEFAULT_SUSPECT_FILES[failureLayer] : [],
    layers,
    diagnostics,
    artifacts: input.artifacts ?? {},
  };
}

export function renderMarkdownReport(report) {
  const lines = [
    '# Watch Mode Live Diagnostic Report',
    '',
    `- GeneratedAt: ${report.generatedAt}`,
    `- Mode: ${report.mode}`,
    `- FeedbackLoopPrevention: ${report.feedbackLoopPrevention ?? 'virtual-driver'}`,
    `- Verdict: ${report.verdict}`,
    `- FailureLayer: ${report.failureLayer ?? '-'}`,
    `- FailureReason: ${report.failureReason ?? '-'}`,
    '',
    '## Layer Summary',
    '',
  ];
  for (const [name, layer] of Object.entries(report.layers)) {
    lines.push(`- ${name}: ${layer.status}${layer.reason ? ` - ${layer.reason}` : ''}`);
    for (const reason of (layer.reasons ?? []).filter((reason) => reason !== layer.reason)) {
      lines.push(`  - additional: ${reason}`);
    }
  }
  lines.push('', '## Failure Details', '');
  if (report.diagnostics?.runnerFailure) {
    lines.push(`- RunnerFailure: ${report.diagnostics.runnerFailure}`);
  }
  if (report.diagnostics?.failedSteps?.length > 0) {
    lines.push('- FailedSteps:');
    for (const step of report.diagnostics.failedSteps) {
      lines.push(`  - ${step.name}: ${step.error}`);
      if (step.details && Object.keys(step.details).length > 0) {
        lines.push(`    details: ${JSON.stringify(step.details)}`);
      }
    }
  }
  if (report.diagnostics?.failedLayers?.length > 0) {
    lines.push('- FailedLayers:');
    for (const layer of report.diagnostics.failedLayers) {
      lines.push(`  - ${layer.layer}: ${layer.status} - ${layer.reason ?? '-'}`);
    }
  }
  lines.push('', '## Suspect Files', '');
  if (report.suspectFiles.length === 0) {
    lines.push('- None');
  } else {
    for (const file of report.suspectFiles) lines.push(`- ${file}`);
  }
  lines.push('', '## Artifacts', '');
  for (const [name, value] of Object.entries(report.artifacts)) {
    if (value) lines.push(`- ${name}: ${value}`);
  }
  lines.push('', '## Key Evidence', '');
  for (const line of report.layers.bridge.parsedLog.errorLines.slice(-10)) lines.push(`- bridge: ${line}`);
  for (const line of report.layers.app.parsedLog.errorLines.slice(-10)) lines.push(`- app: ${line}`);
  for (const line of report.diagnostics?.evidence?.providerErrors ?? []) lines.push(`- provider: ${line}`);
  for (const line of report.diagnostics?.evidence?.appOmniPreconnect ?? []) lines.push(`- omni-preconnect: ${line}`);
  for (const line of report.diagnostics?.evidence?.appReadiness ?? []) lines.push(`- readiness: ${line}`);
  for (const line of report.diagnostics?.evidence?.bridgeSourceSummary ?? []) lines.push(`- bridge-source-summary: ${line}`);
  for (const line of report.diagnostics?.evidence?.bridgeWatchdog ?? []) lines.push(`- bridge-watchdog: ${line}`);
  if (report.diagnostics?.evidence?.physicalOutput) {
    lines.push(`- physical-output: ${JSON.stringify(report.diagnostics.evidence.physicalOutput)}`);
  }
  if (report.diagnostics?.evidence?.physicalOutputContent) {
    lines.push(`- physical-output-content: ${JSON.stringify(report.diagnostics.evidence.physicalOutputContent)}`);
  }
  const strict = report.layers.strictContent?.data;
  if (strict?.applicable) {
    lines.push(`- strict-content: coverage=${strict.coverage ?? '-'} lengthRatio=${strict.lengthRatio ?? '-'} finalWriteCount=${strict.finalWriteCount ?? '-'} queuedSegmentCount=${strict.queuedSegmentCount ?? '-'} playedSegmentCount=${strict.playedSegmentCount ?? '-'}`);
    for (const failure of strict.failures ?? []) lines.push(`- strict-content-failure: ${failure}`);
    if (strict.missingConcepts?.length > 0) lines.push(`- strict-missing-concepts: ${strict.missingConcepts.join(', ')}`);
    for (const clause of (strict.missingClauses ?? []).slice(0, 5)) lines.push(`- strict-missing-clause: ${clause}`);
  }
  return `${lines.join('\n')}\n`;
}

function collectInputFromDirectory(inputDir, mode) {
  const appLogPath = path.join(inputDir, 'app.log');
  const bridgeLogPath = path.join(inputDir, 'bridge-service.log');
  const snapshotsPath = path.join(inputDir, 'snapshots.json');
  const failurePath = path.join(inputDir, 'failure.json');
  const stepsPath = path.join(inputDir, 'steps.json');
  const snapshots = readJsonIfExists(snapshotsPath) ?? {};
  const runMarker = snapshots.runMarker ?? null;
  const startedAtLocal = snapshots.startedAtLocal ?? null;
  const rawAppLogText = readTextIfExists(appLogPath);
  const rawBridgeLogText = readTextIfExists(bridgeLogPath);
  const appLogText = textAfterMarker(rawAppLogText, runMarker) || textAfterLocalTimestamp(rawAppLogText, startedAtLocal);
  const bridgeLogText = textAfterMarker(rawBridgeLogText, runMarker) || textAfterLocalTimestamp(rawBridgeLogText, startedAtLocal);
  return {
    mode,
    snapshots,
    feedbackLoopPrevention: snapshots.feedbackLoopPrevention ?? null,
    driver: snapshots.driver ?? readJsonIfExists(path.join(inputDir, 'driver.json')),
    wasapi: snapshots.wasapi ?? snapshots.driver,
    bridge: snapshots.bridge,
    physicalOutput: snapshots.physicalOutput ?? readJsonIfExists(path.join(inputDir, 'physical-output-probe.json')),
    physicalOutputContent: snapshots.physicalOutputContent ?? readJsonIfExists(path.join(inputDir, 'physical-output-content.json')),
    app: snapshots.app,
    provider: snapshots.provider,
    speechSegmentation: snapshots.speechSegmentation,
    playback: snapshots.playback,
    failure: readJsonIfExists(failurePath),
    steps: readJsonIfExists(stepsPath),
    appLogText,
    bridgeLogText,
    artifacts: {
      appLog: fs.existsSync(appLogPath) ? appLogPath : null,
      bridgeLog: fs.existsSync(bridgeLogPath) ? bridgeLogPath : null,
      snapshots: fs.existsSync(snapshotsPath) ? snapshotsPath : null,
      failure: fs.existsSync(failurePath) ? failurePath : null,
      steps: fs.existsSync(stepsPath) ? stepsPath : null,
      physicalOutputRecording: fs.existsSync(path.join(inputDir, 'physical-output-recording.wav'))
        ? path.join(inputDir, 'physical-output-recording.wav')
        : null,
      physicalOutputContent: fs.existsSync(path.join(inputDir, 'physical-output-content.json'))
        ? path.join(inputDir, 'physical-output-content.json')
        : null,
      diagnosticsBundle: snapshots.diagnosticsBundle ?? null,
    },
  };
}

export function writeReport({ inputDir, outputDir, mode = 'live' }) {
  fs.mkdirSync(outputDir, { recursive: true });
  const report = classifyWatchModeRun(collectInputFromDirectory(inputDir, mode));
  const reportJsonPath = path.join(outputDir, 'report.json');
  const reportMarkdownPath = path.join(outputDir, 'report.md');
  fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(reportMarkdownPath, renderMarkdownReport(report));
  return { report, reportJsonPath, reportMarkdownPath };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    args[arg.slice(2)] = argv[index + 1]?.startsWith('--') ? true : argv[++index] ?? true;
  }
  return args;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const inputDir = String(args.input ?? args.output ?? '.');
  const outputDir = String(args.output ?? inputDir);
  const mode = String(args.mode ?? 'live');
  const result = writeReport({ inputDir, outputDir, mode });
  console.log(JSON.stringify({
    reportJsonPath: result.reportJsonPath,
    reportMarkdownPath: result.reportMarkdownPath,
    verdict: result.report.verdict,
    failureLayer: result.report.failureLayer,
  }));
}
