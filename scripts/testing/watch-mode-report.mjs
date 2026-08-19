import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { currentGitProvenance } from './git-provenance.mjs';

/** HEAD commit of the checkout producing this evidence (null outside git). */
export function currentGitCommit() {
  return currentGitProvenance().headCommit;
}

const DEFAULT_SUSPECT_FILES = {
  environment: [
    'scripts/testing/run-watch-mode-live.ps1',
    'scripts/testing/watch-mode-report.mjs',
  ],
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
  aec: [
    'apps/desktop/src-tauri/src/audio/echo_cancel.rs',
    'apps/desktop/src-tauri/src/audio/engine/workers.rs',
    'apps/desktop/src-tauri/src/audio/omni/protocol.rs',
    'apps/desktop/src-tauri/src/audio/speech/output.rs',
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
const DEFAULT_SOURCE_TRANSCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'watch-mode-en-original.txt',
);
const TEST_MEDIA_SHA256 = 'cf4990ecdc23622d12de3e62adad442755c9e84c4612787798655ee00c85fb2f';
const STRICT_REQUIRED_CONCEPTS = [
  '十亿美元',
  '火星',
  '五亿美元',
  '人工生物圈',
  '濒危物种',
  '飞行汽车',
  '一美元的灯泡',
];
const STRICT_REQUIRED_CONCEPT_ALIASES = new Map([
  ['十亿美元', ['10亿美元']],
  ['五亿美元', ['5亿美元']],
  ['一美元的灯泡', ['一美元灯泡', '1美元灯泡', '1美元的灯泡']],
]);
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

function isBenignCredentialLifecycleLine(line) {
  const text = String(line ?? '');
  if (!/\[credential\]|CredReadW/i.test(text)) return false;
  if (/unauthori[sz]ed|forbidden|invalid api key|\b(?:failed|error|missing|invalid|denied)\b|\b(?:401|403|429)\b/i.test(text)) {
    return false;
  }
  return /\bstart action=|calling CredReadW|CredReadW succeeded|\boutcome=ok\b/i.test(text);
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
  for (const match of line.matchAll(/([A-Za-z][A-Za-z0-9_]*)=("[^"]*"|[^ ]+)/g)) {
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
  const providerErrorLines = matchingLines(
    nonMarkerText,
    /\b(?:status|httpStatus|code)=(?:401|403|429)\b|\bHTTP\s+(?:401|403|429)\b|"status"\s*:\s*"failed"|"error"\s*:\s*(?!"?null\b|null\b)[{\["0-9tfa-zA-Z_-]|unauthori[sz]ed|forbidden|invalid api key|(?:credential|\bauth(?:orization|entication)?\b).{0,80}(?:failed|error|missing|invalid|denied)|(?:failed|error|missing|invalid|denied).{0,80}(?:credential|\bauth(?:orization|entication)?\b)|rate limit|quota|insufficient|billing|\btimeout\b|timed out|ECONNRESET|ENOTFOUND|network error|websocket.*(?:failed|closed)|model_trace failed|provider.*failed/i,
  ).filter((line) => !isBenignCredentialLifecycleLine(line)).slice(-30);
  const errorLines = matchingLines(
    nonMarkerText,
    /error|failed|panic|\btimeout\b|timed out|unauthori[sz]ed|rate limit|credential/i,
  ).filter((line) => !isBenignCredentialLifecycleLine(line)).slice(-30);
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
    nativePlaybackRequestLines: matchingLines(nonMarkerText, /\[AUDIO\] playback request received:/i),
    nativeSpeakerPlaybackCompletedLines: matchingLines(nonMarkerText, /\[AUDIO\] speaker playback completed:/i),
    echoCancelBackendLines: matchingLines(nonMarkerText, /event=echo_cancel_backend/i),
    echoCancelSummaryLines: matchingLines(nonMarkerText, /event=echo_cancel_summary/i),
    // These diagnostic-only events intentionally include the run marker in
    // some builds. Parse them from the already run-scoped source text rather
    // than `nonMarkerText`, which drops marker-bearing lifecycle lines.
    aecLiveScenarioLines: matchingLines(text, /event=aec_live_scenario_stage/i),
    processExclusionRestartLines: matchingLines(text, /event=process_exclusion_restart_/i),
    omniResponseDoneContextLines: tailLines(nonMarkerText, /\[EVENT_CONTEXT\]\s+response\.done/i, 40),
    omniResponseDoneLines: matchingLines(nonMarkerText, /response\.done/i),
    omniAsrCompletedLines: matchingLines(nonMarkerText, /conversation\.item\.input_audio_transcription\.completed|transcription\.completed/i),
    providerLines: tailLines(nonMarkerText, PROVIDER_ERROR_PATTERNS[3], 30),
    providerErrorLines,
    errorLines,
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
    outputMode: config.outputMode ?? null,
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

function normalizedEnglishTokens(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
}

function tokenRecall(reference, candidate) {
  const referenceTokens = normalizedEnglishTokens(reference);
  if (referenceTokens.length === 0) return 0;
  const available = new Map();
  for (const token of normalizedEnglishTokens(candidate)) {
    available.set(token, (available.get(token) ?? 0) + 1);
  }
  let matched = 0;
  for (const token of referenceTokens) {
    const count = available.get(token) ?? 0;
    if (count <= 0) continue;
    matched += 1;
    available.set(token, count - 1);
  }
  return matched / referenceTokens.length;
}

function acceptedWatchSourceText(watchSessionReport) {
  const cues = Array.isArray(watchSessionReport?.cues) ? watchSessionReport.cues : [];
  const acceptedCues = cues.filter((cue) => (
    ['exact', 'formatting-only'].includes(cue.comparisonStatus)
    && Number.isFinite(Number(cue.llmFirstAtMs))
    && Number.isFinite(Number(cue.publishedFirstAtMs))
    && Number.isFinite(Number(cue.renderedFirstAtMs))
    && (cue.issues ?? []).every((issue) => (
      issue?.category === 'data'
      && issue?.code === 'cue-events-truncated'
      && String(issue?.severity ?? '').toLowerCase() === 'warning'
    ))
  ));
  return {
    acceptedCueCount: acceptedCues.length,
    acceptedCueIds: acceptedCues
      .map((cue) => String(cue.cueId ?? '').trim())
      .filter(Boolean),
    sourceText: acceptedCues.map((cue) => cue.sourceText ?? '').filter(Boolean).join('\n'),
  };
}

function parseAecExpectedSegmentEvidence(input) {
  const playbackSha256 = String(
    input.playback?.mediaSha256
      ?? input.physicalOutputContent?.sourceReference?.mediaSha256
      ?? '',
  ).toLowerCase();
  const referenceText = playbackSha256 === TEST_MEDIA_SHA256
    ? readTextIfExists(DEFAULT_SOURCE_TRANSCRIPT_PATH).trim()
    : '';
  const expectedSegments = referenceText
    ? referenceText.split(/\r?\n\s*\r?\n/).map((segment) => segment.trim()).filter(Boolean)
    : [];
  const accepted = acceptedWatchSourceText(input.watchSessionReport);
  const minimumTokenRecall = 0.65;
  const segmentResults = expectedSegments.map((segment, index) => {
    const recall = tokenRecall(segment, accepted.sourceText);
    return {
      ordinal: index + 1,
      expectedTokenCount: normalizedEnglishTokens(segment).length,
      tokenRecall: Number(recall.toFixed(4)),
      accepted: recall >= minimumTokenRecall,
    };
  });
  const acceptedSegmentCount = segmentResults.filter((segment) => segment.accepted).length;
  return {
    referenceSource: playbackSha256 === TEST_MEDIA_SHA256
      ? 'watch-mode-en-original-transcript'
      : null,
    acceptedSource: 'watch-session-report-cues',
    watchSessionId: input.watchSessionReport?.sessionId ?? null,
    referencePath: playbackSha256 === TEST_MEDIA_SHA256 ? DEFAULT_SOURCE_TRANSCRIPT_PATH : null,
    mediaSha256: playbackSha256 || null,
    minimumTokenRecall,
    expectedSegmentCount: segmentResults.length,
    acceptedSegmentCount,
    acceptanceRate: segmentResults.length > 0
      ? Number((acceptedSegmentCount / segmentResults.length).toFixed(4))
      : 0,
    acceptedCueCount: accepted.acceptedCueCount,
    acceptedCueIds: accepted.acceptedCueIds,
    segments: segmentResults,
  };
}

function parseAecLiveScenario(appLog, input) {
  const rawStages = appLog.aecLiveScenarioLines
    .map(parseKeyValueLine)
    .filter((stage) => Object.keys(stage).length > 0);
  const completedStages = rawStages.filter((stage) => stage.status === 'completed');
  const namedStage = (name) => completedStages.find((stage) => stage.stage === name) ?? null;
  const doubleTalk = namedStage('double-talk');
  const dynamicDelay = namedStage('dynamic-delay');
  const nonlinear = namedStage('nonlinear');
  const stageIsRuntimeRender = (stage) => (
    stage != null
    && String(stage.cueId ?? '') !== ''
    && asNumber(stage.referenceFrames) > 0
    && asNumber(stage.physicalFrames) > 0
    && asNumber(stage.completedAtMs, NaN) >= asNumber(stage.startedAtMs, NaN)
    && stage.started === 'true'
    && stage.completed === 'true'
    && stage.source === 'runtime-physical-render'
    && ['native-omni', 'subtitle-tts'].includes(stage.playbackSource)
  );
  const stageHasExpectedPhysicalPcm = (stage, delayMs, nonlinearExpected) => {
    if (!stageIsRuntimeRender(stage)) return false;
    const referenceFrames = asNumber(stage.referenceFrames, NaN);
    const physicalFrames = asNumber(stage.physicalFrames, NaN);
    const expectedPrefixFrames = Math.round(delayMs * 48_000 / 1_000);
    const changedSamples = asNumber(stage.changedSamples, NaN);
    const changedRatio = asNumber(stage.changedRatio, NaN);
    if (physicalFrames - referenceFrames !== expectedPrefixFrames) return false;
    if (nonlinearExpected) {
      return changedSamples > 0 && changedRatio > 0 && changedRatio <= 1;
    }
    return changedSamples === 0 && changedRatio === 0;
  };
  const playback = input.playback ?? {};
  const playbackStartedAtMs = asNumber(playback.startedAtMs, NaN);
  const playbackFinishedAtMs = asNumber(playback.finishedAtMs, NaN);
  const playbackProcessId = asNumber(playback.processId ?? playback.injectorProcessId, NaN);
  const playbackSha256 = String(playback.mediaSha256 ?? '').toLowerCase();
  const actualPlayback = (
    playbackSha256 === TEST_MEDIA_SHA256
    && Number.isInteger(playbackProcessId)
    && playbackProcessId > 0
    && Number.isFinite(playbackStartedAtMs)
    && Number.isFinite(playbackFinishedAtMs)
    && playbackFinishedAtMs > playbackStartedAtMs
  );
  const baselineDelayMs = asNumber(doubleTalk?.delayMs, NaN);
  const dynamicDelayMs = asNumber(dynamicDelay?.delayMs, NaN);
  const nonlinearDelayMs = asNumber(nonlinear?.delayMs, NaN);
  const nonlinearity = String(nonlinear?.nonlinearity ?? '').toLowerCase();
  const scenarioStartedAtMs = completedStages
    .map((stage) => asNumber(stage.startedAtMs, NaN))
    .filter(Number.isFinite);
  const scenarioCompletedAtMs = completedStages
    .map((stage) => asNumber(stage.completedAtMs, NaN))
    .filter(Number.isFinite);
  const timelineBoundToPlayback = (
    actualPlayback
    && scenarioStartedAtMs.length >= 3
    && scenarioCompletedAtMs.length >= 3
    && Math.min(...scenarioStartedAtMs) >= playbackStartedAtMs - 10_000
    && Math.max(...scenarioCompletedAtMs) <= playbackFinishedAtMs + 120_000
  );
  const completed = (
    stageHasExpectedPhysicalPcm(doubleTalk, 0, false)
    && stageHasExpectedPhysicalPcm(dynamicDelay, 80, false)
    && stageHasExpectedPhysicalPcm(nonlinear, 160, true)
    && baselineDelayMs === 0
    && dynamicDelayMs > baselineDelayMs
    && nonlinearDelayMs > dynamicDelayMs
    && !['', 'none', 'linear', 'false', 'off'].includes(nonlinearity)
    && timelineBoundToPlayback
  );
  return {
    requested: input.feedbackLoopPrevention === 'echo-cancel' && input.mode === 'live',
    evidenceMode: completed && actualPlayback && input.mode === 'live' ? 'live' : input.mode ?? 'unknown',
    fixtureOnly: !(completed && actualPlayback && input.mode === 'live'),
    completed,
    completedStageCount: completedStages.length,
    requiredStages: ['double-talk', 'dynamic-delay', 'nonlinear'],
    stages: { doubleTalk, dynamicDelay, nonlinear },
    baselineDelayMs: Number.isFinite(baselineDelayMs) ? baselineDelayMs : null,
    dynamicDelayMs: Number.isFinite(dynamicDelayMs) ? dynamicDelayMs : null,
    nonlinearDelayMs: Number.isFinite(nonlinearDelayMs) ? nonlinearDelayMs : null,
    nonlinearity: nonlinear?.nonlinearity ?? null,
    timelineBoundToPlayback,
    playback: {
      mediaSha256: playbackSha256 || null,
      processId: Number.isFinite(playbackProcessId) ? playbackProcessId : null,
      startedAtMs: Number.isFinite(playbackStartedAtMs) ? playbackStartedAtMs : null,
      finishedAtMs: Number.isFinite(playbackFinishedAtMs) ? playbackFinishedAtMs : null,
      actualPlayback,
    },
    expectedSubtitles: parseAecExpectedSegmentEvidence(input),
    evidenceLines: appLog.aecLiveScenarioLines.slice(-12),
  };
}

function parseAecDiagnostics(appLog, input) {
  const config = parseKeyValueLine(appLog.omniSessionConfigLines.at(-1) ?? '');
  const speakerPlayback = appLog.nativeSpeakerPlaybackCompletedLines.map(parseKeyValueLine);
  const backendGate = parseKeyValueLine(appLog.echoCancelBackendLines.at(-1) ?? '');
  const echoSummaries = appLog.echoCancelSummaryLines
    .map(parseKeyValueLine)
    .filter((summary) => Object.keys(summary).length > 0);
  const maxMetric = (key, fallback = 0) => echoSummaries.reduce(
    (maximum, summary) => Math.max(maximum, asNumber(summary[key], fallback)),
    fallback,
  );
  const metricValues = (key) => echoSummaries
    .map((summary) => Number(summary[key]))
    .filter(Number.isFinite);
  const optionalMetricRange = (key) => {
    const values = metricValues(key);
    return {
      count: values.length,
      minimum: values.length > 0 ? Math.min(...values) : null,
      maximum: values.length > 0 ? Math.max(...values) : null,
    };
  };
  const playbackFrames = speakerPlayback.reduce(
    (total, playback) => total + asNumber(playback.frames, 0),
    0,
  );
  const playbackSeconds = speakerPlayback.reduce((total, playback) => {
    const sampleRateHz = asNumber(playback.sample_rate_hz, 0);
    return total + (sampleRateHz > 0 ? asNumber(playback.frames, 0) / sampleRateHz : 0);
  }, 0);
  const erle = optionalMetricRange('erleDb');
  const residualEchoLikelihood = optionalMetricRange('residualEchoLikelihood');
  const reportedDelay = optionalMetricRange('reportedDelayMs');
  const doubleTalk = optionalMetricRange('doubleTalkFrames');
  const averageProcessing = optionalMetricRange('avgProcessingUs');
  const backends = [...new Set(echoSummaries.map((summary) => summary.backend).filter(Boolean))];
  // Historical reports used two deletion-counter names. Read them so old
  // evidence cannot disguise dropped ASR chunks, while new writers emit only
  // the explicit asrDeletedChunks invariant.
  const maxAsrDeletedChunks = echoSummaries.reduce(
    (maximum, summary) => Math.max(
      maximum,
      asNumber(
        summary.asrDeletedChunks
          ?? summary.effectiveSuppressedChunks
          ?? summary.aecSuppressedChunks,
        0,
      ),
    ),
    0,
  );
  const asrDeletedChunkMetricCount = echoSummaries.filter((summary) => Number.isFinite(Number(
    summary.asrDeletedChunks
      ?? summary.effectiveSuppressedChunks
      ?? summary.aecSuppressedChunks,
  ))).length;

  return {
    outputMode: config.outputMode ?? null,
    playbackRequestCount: appLog.nativePlaybackRequestLines.length,
    speakerPlaybackCompletedCount: speakerPlayback.length,
    speakerPlaybackFrames: playbackFrames,
    speakerPlaybackSeconds: Number(playbackSeconds.toFixed(3)),
    aecSummaryCount: echoSummaries.length,
    backendGateSummaryCount: appLog.echoCancelBackendLines.length,
    backendGateBackend: backendGate.backend ?? null,
    webRtcAec3Ready: backendGate.webRtcAec3Ready === 'true',
    msvcBuildVerified: backendGate.msvcBuildVerified === 'true',
    linkedBackendPresent: backendGate.linkedBackendPresent === 'true',
    fixtureVerified: backendGate.fixtureVerified === 'true',
    renderClock: backendGate.renderClock ?? null,
    endpointRenderPadding: backendGate.endpointRenderPadding ?? null,
    backend: echoSummaries.at(-1)?.backend ?? null,
    backends,
    nonWebRtcBackendCount: echoSummaries.filter(
      (summary) => summary.backend !== 'webrtc-aec3',
    ).length,
    processedFrameSummaryCount: echoSummaries.filter(
      (summary) => asNumber(
        summary.processedCapture10msFrames ?? summary.capture10msFrames,
        0,
      ) > 0,
    ).length,
    maxRender10msFrames: maxMetric('render10msFrames'),
    maxCapture10msFrames: maxMetric('capture10msFrames'),
    maxProcessedCapture10msFrames: Math.max(
      maxMetric('processedCapture10msFrames'),
      maxMetric('capture10msFrames'),
    ),
    maxRejectedFrames: maxMetric('rejectedFrames'),
    maxStatsReadFailures: maxMetric('statsReadFailures'),
    maxResetCount: maxMetric('resetCount'),
    maxRenderUnderruns: maxMetric('renderUnderruns'),
    maxCaptureUnderruns: maxMetric('captureUnderruns'),
    erleMetricCount: erle.count,
    minErleDb: erle.minimum,
    maxErleDb: erle.maximum,
    residualEchoLikelihoodMetricCount: residualEchoLikelihood.count,
    minResidualEchoLikelihood: residualEchoLikelihood.minimum,
    maxResidualEchoLikelihood: residualEchoLikelihood.maximum,
    reportedDelayMetricCount: reportedDelay.count,
    minReportedDelayMs: reportedDelay.minimum,
    maxReportedDelayMs: reportedDelay.maximum,
    reportedDelaySpanMs: reportedDelay.count > 0
      ? Number((reportedDelay.maximum - reportedDelay.minimum).toFixed(3))
      : null,
    processingMetricCount: averageProcessing.count,
    maxAverageProcessingUs: averageProcessing.maximum,
    maxProcessingUs: maxMetric('maxProcessingUs'),
    doubleTalkMetricAvailable: echoSummaries.some(
      (summary) => Number.isFinite(Number(summary.doubleTalkFrames)),
    ),
    maxDoubleTalkFrames: doubleTalk.maximum,
    maxCaptureChunks: maxMetric('captureChunks'),
    maxAsrForwardedChunks: maxMetric('asrForwardedChunks'),
    asrDeletedChunkMetricCount,
    maxAsrDeletedChunks,
    liveScenario: parseAecLiveScenario(appLog, input),
    summaryLines: appLog.echoCancelSummaryLines.slice(-12),
  };
}

function parseProcessExclusionRestart(appLog, input) {
  const events = appLog.processExclusionRestartLines
    .map(parseKeyValueLine)
    .filter((event) => Object.keys(event).length > 0);
  const summary = [...events].reverse().find((event) => (
    event.event === 'process_exclusion_restart_summary'
  )) ?? {};
  const oldBridgeProcessId = asNumber(summary.oldBridgeProcessId, NaN);
  const newBridgeProcessId = asNumber(summary.newBridgeProcessId, NaN);
  const oldSourceGeneration = String(summary.oldSourceGeneration ?? '');
  const newSourceGeneration = String(summary.newSourceGeneration ?? '');
  const oldLastFrameTimestampMs = asNumber(summary.oldLastFrameTimestampMs, NaN);
  const oldLastFrameReadTimestampMs = asNumber(summary.oldLastFrameReadTimestampMs, NaN);
  const newFirstFrameTimestampMs = asNumber(summary.newFirstFrameTimestampMs, NaN);
  const newFirstFrameReadTimestampMs = asNumber(summary.newFirstFrameReadTimestampMs, NaN);
  const startedAtMs = asNumber(summary.startedAtUnixMs ?? summary.startedAtMs, NaN);
  const restartTriggeredAtMs = asNumber(
    summary.restartTriggeredAtUnixMs ?? summary.restartTriggeredAtMs,
    NaN,
  );
  const recoveredAtMs = asNumber(summary.recoveredAtUnixMs ?? summary.recoveredAtMs, NaN);
  const sourceFramesBefore = asNumber(summary.sourceFramesBefore, NaN);
  const sourceFramesAfter = asNumber(summary.sourceFramesAfter, NaN);
  const oldFramesAfterRestart = asNumber(summary.oldFramesAfterRestart, NaN);
  const systemMetrics = input.systemMetrics ?? {};
  const samples = Array.isArray(systemMetrics.samples) ? systemMetrics.samples : [];
  const samplesWithOldPid = samples.filter((sample) => (
    Array.isArray(sample.bridgeProcessIds)
    && sample.bridgeProcessIds.map(Number).includes(oldBridgeProcessId)
  ));
  const samplesWithNewPid = samples.filter((sample) => (
    Array.isArray(sample.bridgeProcessIds)
    && sample.bridgeProcessIds.map(Number).includes(newBridgeProcessId)
  ));
  const firstNewSampleIndex = samples.findIndex((sample) => (
    Array.isArray(sample.bridgeProcessIds)
    && sample.bridgeProcessIds.map(Number).includes(newBridgeProcessId)
  ));
  const oldPidAbsentAfterNew = firstNewSampleIndex >= 0
    && samples.slice(firstNewSampleIndex).every((sample) => (
      !Array.isArray(sample.bridgeProcessIds)
      || !sample.bridgeProcessIds.map(Number).includes(oldBridgeProcessId)
    ));
  const firstElapsedMs = asNumber(samples.at(0)?.elapsedMs, NaN);
  const lastElapsedMs = asNumber(samples.at(-1)?.elapsedMs, NaN);
  const systemMetricsDurationMs = Number.isFinite(firstElapsedMs) && Number.isFinite(lastElapsedMs)
    ? Math.max(0, lastElapsedMs - firstElapsedMs)
    : 0;
  const systemMetricsValid = (
    systemMetrics.artifactKind === 'watch-mode-system-metrics'
    && systemMetrics.collector === 'scripts/testing/collect-watch-mode-system-metrics.ps1'
    && systemMetrics.scope === 'process-tree'
    && Array.isArray(systemMetrics.collectionErrors)
    && systemMetrics.collectionErrors.length === 0
    && asNumber(systemMetrics.sampleCount) === samples.length
    && samples.length > 0
  );
  const identityChanged = (
    Number.isInteger(oldBridgeProcessId)
    && Number.isInteger(newBridgeProcessId)
    && oldBridgeProcessId > 0
    && newBridgeProcessId > 0
    && oldBridgeProcessId !== newBridgeProcessId
    && String(summary.oldBridgeInstanceId ?? '') !== ''
    && String(summary.newBridgeInstanceId ?? '') !== ''
    && summary.oldBridgeInstanceId !== summary.newBridgeInstanceId
    && String(summary.oldSessionId ?? '') !== ''
    && String(summary.newSessionId ?? '') !== ''
    && summary.oldSessionId !== summary.newSessionId
    && oldSourceGeneration !== ''
    && newSourceGeneration !== ''
    && oldSourceGeneration !== newSourceGeneration
    && String(summary.oldSourceGenerationToken ?? '') !== ''
    && String(summary.newSourceGenerationToken ?? '') !== ''
    && summary.oldSourceGenerationToken !== summary.newSourceGenerationToken
  );
  const frameContinuity = (
    Number.isFinite(sourceFramesBefore)
    && Number.isFinite(sourceFramesAfter)
    && sourceFramesBefore > 0
    && sourceFramesAfter > 0
    && Number.isFinite(oldLastFrameTimestampMs)
    && Number.isFinite(oldLastFrameReadTimestampMs)
    && Number.isFinite(newFirstFrameTimestampMs)
    && Number.isFinite(newFirstFrameReadTimestampMs)
    && newFirstFrameTimestampMs > oldLastFrameTimestampMs
    && newFirstFrameReadTimestampMs > oldLastFrameReadTimestampMs
    && oldFramesAfterRestart === 0
  );
  const runtimeReady = (
    summary.status === 'passed'
    && summary.processLoopbackStatus === 'ready'
    && summary.captureBackend === 'wasapi-process-exclusion'
    && summary.sourceSubscriberActive === 'true'
    && asNumber(summary.excludedProcessId, NaN) === newBridgeProcessId
  );
  const timingValid = (
    Number.isFinite(startedAtMs)
    && Number.isFinite(restartTriggeredAtMs)
    && Number.isFinite(recoveredAtMs)
    // The restart controller records `startedAt` after its final pre-restart
    // frame poll.  That timestamp can therefore be a few milliseconds after
    // the last old-frame read; the ordering that matters is that both the
    // old-frame watermark and controller start precede the trigger.
    && startedAtMs <= restartTriggeredAtMs
    && oldLastFrameReadTimestampMs <= restartTriggeredAtMs
    && restartTriggeredAtMs <= newFirstFrameReadTimestampMs
    && newFirstFrameReadTimestampMs <= recoveredAtMs
    && recoveredAtMs >= restartTriggeredAtMs
    && asNumber(summary.downtimeMs, recoveredAtMs - restartTriggeredAtMs) <= 15_000
  );
  const metricsProveTransition = (
    systemMetricsValid
    && samplesWithOldPid.length > 0
    && samplesWithNewPid.length > 0
    && oldPidAbsentAfterNew
  );
  const completed = identityChanged
    && frameContinuity
    && runtimeReady
    && timingValid
    && metricsProveTransition;
  return {
    requested: input.feedbackLoopPrevention === 'process-exclusion' && input.mode === 'live',
    evidenceMode: completed && input.mode === 'live' ? 'live' : input.mode ?? 'unknown',
    fixtureOnly: !(completed && input.mode === 'live'),
    completed,
    identityChanged,
    frameContinuity,
    runtimeReady,
    timingValid,
    metricsProveTransition,
    oldBridgeProcessId: Number.isFinite(oldBridgeProcessId) ? oldBridgeProcessId : null,
    newBridgeProcessId: Number.isFinite(newBridgeProcessId) ? newBridgeProcessId : null,
    oldBridgeInstanceId: summary.oldBridgeInstanceId ?? null,
    newBridgeInstanceId: summary.newBridgeInstanceId ?? null,
    oldSessionId: summary.oldSessionId ?? null,
    newSessionId: summary.newSessionId ?? null,
    oldSourceGeneration: oldSourceGeneration || null,
    newSourceGeneration: newSourceGeneration || null,
    oldSourceGenerationToken: summary.oldSourceGenerationToken ?? null,
    newSourceGenerationToken: summary.newSourceGenerationToken ?? null,
    oldLastFrameTimestampMs: Number.isFinite(oldLastFrameTimestampMs) ? oldLastFrameTimestampMs : null,
    oldLastFrameReadTimestampMs: Number.isFinite(oldLastFrameReadTimestampMs)
      ? oldLastFrameReadTimestampMs
      : null,
    newFirstFrameTimestampMs: Number.isFinite(newFirstFrameTimestampMs) ? newFirstFrameTimestampMs : null,
    newFirstFrameReadTimestampMs: Number.isFinite(newFirstFrameReadTimestampMs)
      ? newFirstFrameReadTimestampMs
      : null,
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
    restartTriggeredAtMs: Number.isFinite(restartTriggeredAtMs) ? restartTriggeredAtMs : null,
    recoveredAtMs: Number.isFinite(recoveredAtMs) ? recoveredAtMs : null,
    downtimeMs: asNumber(summary.downtimeMs, null),
    sourceFramesBefore: Number.isFinite(sourceFramesBefore) ? sourceFramesBefore : null,
    sourceFramesAfter: Number.isFinite(sourceFramesAfter) ? sourceFramesAfter : null,
    oldFramesAfterRestart: Number.isFinite(oldFramesAfterRestart) ? oldFramesAfterRestart : null,
    oldFrameRejectedCount: asNumber(summary.oldFrameRejectedCount, null),
    excludedProcessId: asNumber(summary.excludedProcessId, null),
    processLoopbackStatus: summary.processLoopbackStatus ?? null,
    captureBackend: summary.captureBackend ?? null,
    sourceSubscriberActive: summary.sourceSubscriberActive === 'true',
    systemMetrics: {
      valid: systemMetricsValid,
      sampleCount: samples.length,
      durationMs: Number(systemMetricsDurationMs.toFixed(3)),
      samplesWithOldPid: samplesWithOldPid.length,
      samplesWithNewPid: samplesWithNewPid.length,
      oldPidAbsentAfterNew,
      startedAt: systemMetrics.startedAt ?? null,
      finishedAt: systemMetrics.finishedAt ?? null,
    },
    evidenceLines: appLog.processExclusionRestartLines.slice(-12),
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

function bridgeLogShowsActiveSource(bridgeLog) {
  return (bridgeLog?.watchdogSummaries ?? []).some((watchdog) => (
    watchdog.sourceSubscriberActive === 'true'
    && (
      asNumber(watchdog.readCalls, 0) > 0
      || asNumber(watchdog.bytesRead, 0) > 0
      || asNumber(watchdog.capturedBytes, 0) > 0
      || asNumber(watchdog.releasedFrames, 0) > 0
      || asNumber(watchdog.captureFrames, 0) > 0
    )
  ));
}

function bridgeLayerFailed(bridge, bridgeLog, feedbackLoopPrevention = 'virtual-driver') {
  const metrics = bridgeLog.metrics;
  const processExclusion = feedbackLoopPrevention === 'process-exclusion';
  if (bridge?.probePassed === false) {
    return bridge.error
      ? `bridge source frame probe failed: ${bridge.error}`
      : 'bridge source frame probe did not pass';
  }
  if (bridge?.error) return `bridge source probe failed: ${bridge.error}`;
  if (bridge?.lastErrorCode) return bridge.lastErrorCode;
  if (processExclusion) {
    if (bridge?.sourceCaptureMode !== 'process-exclusion') {
      return `bridge sourceCaptureMode is ${bridge?.sourceCaptureMode ?? 'missing'}`;
    }
    if (bridge?.captureBackend !== 'wasapi-process-exclusion') {
      return `bridge captureBackend is ${bridge?.captureBackend ?? 'missing'}`;
    }
    if (bridge?.processLoopbackSupported !== true) {
      return `bridge process loopback is unsupported on Windows build ${bridge?.windowsBuildNumber ?? 'unknown'}; minimum=${bridge?.processLoopbackMinimumWindowsBuild ?? 20348}`;
    }
    const minimumBuild = Math.max(
      20348,
      asNumber(bridge?.processLoopbackMinimumWindowsBuild, 20348),
    );
    const windowsBuild = asNumber(bridge?.windowsBuildNumber, NaN);
    if (!Number.isFinite(windowsBuild) || windowsBuild < minimumBuild) {
      return `bridge process loopback Windows build evidence is invalid; detected=${bridge?.windowsBuildNumber ?? 'missing'} minimum=${minimumBuild}`;
    }
    if (bridge?.processLoopbackStatus !== 'ready') {
      return bridge?.processLoopbackFailureDetail
        ?? `bridge processLoopbackStatus is ${bridge?.processLoopbackStatus ?? 'missing'}`;
    }
    if (asNumber(bridge?.excludedProcessId) <= 0) {
      return `bridge excludedProcessId is ${bridge?.excludedProcessId ?? 'missing'}`;
    }
  } else if (bridge?.driverHealth && bridge.driverHealth !== 'running') {
    return `bridge driverHealth is ${bridge.driverHealth}`;
  }
  if (bridge?.bridgeState && !['running', 'ready'].includes(bridge.bridgeState)) return `bridgeState is ${bridge.bridgeState}`;
  if (processExclusion) return null;
  // The pre-playback source probe intentionally runs before Desktop opens the
  // source pipe, so its snapshot can legitimately say waiting-subscriber even
  // when the later live Watch session subscribed and delivered frames. Prefer
  // run-scoped watchdog evidence over that stale preflight value; a genuinely
  // failed source still has no active watchdog with progress counters.
  if (
    bridge?.sourceSubscriberActive === false
    && !bridgeLogShowsActiveSource(bridgeLog)
    // A bridge.source.frame is emitted only after the source-pipe client has
    // subscribed. The snapshot is taken during preflight and can therefore
    // still read waiting-subscriber while this run subsequently delivered a
    // frame to the probe.
    && asNumber(bridge?.sourceFramePayloadBytes) === 0
  ) {
    return 'bridge source subscriber is not active';
  }
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

export function watchSessionReportFailure(report, { required = true } = {}) {
  if (!report) return required ? 'watch session report evidence is missing' : null;
  if (report.status !== 'completed') {
    return `watch session report is not completed; status=${report.status ?? 'unknown'}`;
  }
  const sessionIssue = (Array.isArray(report.issues) ? report.issues : []).find((issue) => {
    const code = String(issue?.code ?? 'unknown');
    const severity = String(issue?.severity ?? '').toLowerCase();
    return code === 'speaker-playback-failed' || severity === 'error';
  });
  if (sessionIssue) {
    return `watch session report contains a session-level error; category=${sessionIssue.category ?? '-'} code=${sessionIssue.code ?? '-'} severity=${sessionIssue.severity ?? '-'}`;
  }
  const cues = Array.isArray(report.cues) ? report.cues : [];
  const completeCues = cues.filter((cue) => (
    cue.comparisonStatus !== 'superseded'
    && Number.isFinite(Number(cue.llmFirstAtMs))
    && Number.isFinite(Number(cue.publishedFirstAtMs))
    && Number.isFinite(Number(cue.renderedFirstAtMs))
    && Number(cue.llmFirstToRenderMs) >= 0
    && Number(cue.publishToRenderMs) >= 0
  ));
  if (completeCues.length === 0) {
    return 'watch session report has no complete model → publish → visible-render cue';
  }
  const unrendered = Number(report.summary?.unrenderedCueCount ?? 0);
  if (unrendered > 0) {
    return `watch session report contains ${unrendered} published cue(s) without visible rendering`;
  }
  const invalidCue = cues.find((cue) => {
    // Revisions marked superseded are retained for forensic timelines, but
    // they are not the logical output selected for the session. A transient
    // provider retry on one of those revisions must not fail an otherwise
    // complete later revision; the selected revision is still checked below.
    if (cue?.comparisonStatus === 'superseded') return false;
    const issues = Array.isArray(cue.issues) ? cue.issues : [];
    const recoveredRetryOnly = ['exact', 'formatting-only'].includes(cue?.comparisonStatus)
      && Number.isFinite(Number(cue?.llmFirstAtMs))
      && Number.isFinite(Number(cue?.publishedFirstAtMs))
      && Number.isFinite(Number(cue?.renderedFirstAtMs))
      && issues.length > 0
      && issues.every((issue) => issue?.code === 'retry-exhausted');
    if (recoveredRetryOnly) return false;
    const blockingIssues = issues.filter((issue) => !(
      issue?.category === 'data'
      && issue?.code === 'cue-events-truncated'
      && String(issue?.severity ?? '').toLowerCase() === 'warning'
    ));
    const interruptedSourceTail = cue.comparisonStatus === 'not-published'
      && blockingIssues.length > 0
      && blockingIssues.every((issue) => (
        issue?.category === 'session'
        && issue?.code === 'session-ended-before-model-output'
        && issue?.severity === 'warning'
      ));
    if (interruptedSourceTail) return false;
    return ['different', 'not-published', 'not-rendered', 'model-error'].includes(cue.comparisonStatus)
      || blockingIssues.length > 0;
  });
  if (invalidCue) {
    const issueCodes = (invalidCue.issues ?? []).map((issue) => issue.code).join(',') || '-';
    return `watch session report contains an explicit cue issue; cue=${invalidCue.cueId ?? '-'} comparison=${invalidCue.comparisonStatus ?? '-'} issues=${issueCodes}`;
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
    !/\boutcome=ok\b|\bstatus[=:]succeeded\b|\bsuccess(?:ful(?:ly)?)?\b/i.test(line)
    && /unauthori[sz]ed|forbidden|invalid api key|(?:credential|\bauth(?:orization|entication)?\b).{0,80}(?:failed|error|missing|invalid|denied)|(?:failed|error|missing|invalid|denied).{0,80}(?:credential|\bauth(?:orization|entication)?\b)|rate limit|quota|insufficient|billing|\b(?:401|403|429)\b/i.test(line)
  ));
  const hasRecoveredUserVisibleOutput = appLog.subtitleLines.length > 0
    && appLog.providerLines.some((line) => /provider\.translate_text.*"status"\s*:\s*"succeeded"|subtitle translate success|TRANS_WRITE/i.test(line));
  const latestProviderError = appLog.providerErrorLines.at(-1);
  if (hardProviderError) return `provider credential/rate-limit error evidence found in app.log: ${latestProviderError ?? 'no provider error line captured'}`;
  if (options.hardOnly) return null;
  const failedCallCountIsCorroborated = appLog.providerErrorLines.length > 0
    || options.requireFailedCallLogEvidence !== true;
  if (provider?.failedCalls > 0 && failedCallCountIsCorroborated && !hasRecoveredUserVisibleOutput && !physicalContentPassed) {
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

function physicalOutputLayerFailed(physicalOutput, options = {}) {
  if (!physicalOutput) return 'physical output probe did not run';
  if (physicalOutput.error) return physicalOutput.error;
  if (physicalOutput.skipped === true) {
    return `physical output probe was skipped${physicalOutput.skipCode ? `; code=${physicalOutput.skipCode}` : ''}${physicalOutput.detail ? `; detail=${physicalOutput.detail}` : ''}`;
  }
  if (physicalOutput.passed === false) return physicalOutput.detail ?? 'physical output probe failed';
  const probeKind = physicalOutput.probeKind ?? physicalOutput.probe_kind;
  if (options.requireProcessFingerprint === true
    && probeKind !== 'process-exclusion-fingerprint') {
    return `process-exclusion requires a real process fingerprint probe; probeKind=${probeKind ?? '-'}`;
  }
  if (probeKind === 'process-exclusion-fingerprint') {
    const evidence = physicalOutput.processExclusionFingerprint
      ?? physicalOutput.process_exclusion_fingerprint;
    if (!evidence) return 'process-exclusion fingerprint evidence is missing';
    const bridgePid = asNumber(evidence.bridgeProcessId, 0);
    const excludedPid = asNumber(evidence.excludedProcessId, 0);
    const externalPid = asNumber(evidence.externalPlayerProcessId, 0);
    const childPid = asNumber(evidence.bridgeChildPlayerProcessId, 0);
    const childParentPid = asNumber(evidence.bridgeChildParentProcessId, 0);
    if (evidence.sourceCaptureMode !== 'process-exclusion'
      || evidence.captureBackend !== 'wasapi-process-exclusion'
      || evidence.processLoopbackStatus !== 'ready') {
      return `process-exclusion fingerprint used the wrong capture route; sourceCaptureMode=${evidence.sourceCaptureMode ?? '-'} captureBackend=${evidence.captureBackend ?? '-'} processLoopbackStatus=${evidence.processLoopbackStatus ?? '-'}`;
    }
    if (bridgePid <= 0 || excludedPid !== bridgePid) {
      return `process-exclusion fingerprint targeted the wrong PID; bridgeProcessId=${bridgePid} excludedProcessId=${excludedPid}`;
    }
    if (externalPid <= 0 || externalPid === bridgePid) {
      return `external preservation fingerprint did not originate outside Bridge; bridgeProcessId=${bridgePid} externalPlayerProcessId=${externalPid}`;
    }
    if (childPid <= 0 || childPid === bridgePid || childParentPid !== bridgePid) {
      return `Bridge-child exclusion fingerprint has invalid ancestry; bridgeProcessId=${bridgePid} childProcessId=${childPid} childParentProcessId=${childParentPid}`;
    }
    if (asNumber(evidence.bridgeChildExitCode, -1) !== 0) {
      return `Bridge-child exclusion fingerprint process failed; exitCode=${evidence.bridgeChildExitCode ?? '-'}`;
    }
    const minimumComponent = 0.01;
    const translationLimit = asNumber(evidence.translationComponentLimit, 0.003);
    const physicalRatioLimit = asNumber(evidence.sourceToPhysicalRatioLimit, 0.05);
    const externalRatioLimit = asNumber(evidence.sourceToExternalRatioLimit, 0.05);
    const physicalTranslation = asNumber(evidence.physicalTranslationComponent, 0);
    const physicalExternal = asNumber(evidence.physicalExternalComponent, 0);
    const physicalChild = asNumber(evidence.physicalBridgeChildComponent, 0);
    const sourceTranslation = asNumber(evidence.sourceTranslationComponent, Number.POSITIVE_INFINITY);
    const sourceExternal = asNumber(evidence.sourceExternalComponent, 0);
    const sourceChild = asNumber(evidence.sourceBridgeChildComponent, Number.POSITIVE_INFINITY);
    const translationRatio = asNumber(evidence.sourceToPhysicalTranslationRatio, Number.POSITIVE_INFINITY);
    const externalRatio = asNumber(evidence.sourceTranslationToExternalRatio, Number.POSITIVE_INFINITY);
    const childRatio = asNumber(evidence.sourceToPhysicalBridgeChildRatio, Number.POSITIVE_INFINITY);
    if (physicalTranslation < minimumComponent || physicalExternal < minimumComponent || physicalChild < minimumComponent) {
      return `process-exclusion physical fingerprint is incomplete; translation=${physicalTranslation} external=${physicalExternal} bridgeChild=${physicalChild}`;
    }
    if (sourceExternal < minimumComponent) {
      return `external-process fingerprint was not preserved in the Bridge source pipe; sourceExternalComponent=${sourceExternal}`;
    }
    if (sourceTranslation > translationLimit || translationRatio > physicalRatioLimit || externalRatio > externalRatioLimit) {
      return `Bridge translation fingerprint leaked into source; component=${sourceTranslation}/${translationLimit} physicalRatio=${translationRatio}/${physicalRatioLimit} externalRatio=${externalRatio}/${externalRatioLimit}`;
    }
    if (sourceChild > translationLimit || childRatio > physicalRatioLimit) {
      return `Bridge-child fingerprint leaked into source; component=${sourceChild}/${translationLimit} physicalRatio=${childRatio}/${physicalRatioLimit}`;
    }
    return null;
  }
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
  const missingConcepts = STRICT_REQUIRED_CONCEPTS.filter((concept) => {
    const acceptedPhrases = [concept, ...(STRICT_REQUIRED_CONCEPT_ALIASES.get(concept) ?? [])];
    return !acceptedPhrases.some((phrase) => normalizedOutput.includes(normalizeMeaningText(phrase)));
  });
  const forbiddenErrors = STRICT_FORBIDDEN_ERRORS.filter(
    (item) => normalizedOutput.includes(normalizeMeaningText(item.text)),
  );
  const referenceChars = normalizeMeaningText(referenceText).length;
  const outputChars = normalizedOutput.length;
  const lengthRatio = referenceChars > 0 ? outputChars / referenceChars : 0;
  const subtitleQueue = content?.subtitleQueue ?? {};
  const speechSegmentation = input.speechSegmentation ?? {};
  // Keep the historical strict-content helper default on the secondary
  // contract. A live native route is explicit at classification time, so it
  // alone selects native completion evidence below.
  const translationRoute = input.translationRoute === 'native' ? 'native' : 'secondary';
  const completedNativeCueIds = new Set(
    (Array.isArray(input.watchSessionReport?.cues) ? input.watchSessionReport.cues : [])
      .filter((cue) => (
        ['exact', 'formatting-only'].includes(cue?.comparisonStatus)
        && String(cue?.llmText ?? '').trim()
        && String(cue?.publishedText ?? '').trim()
        && String(cue?.renderedText ?? '').trim()
      ))
      .map((cue) => String(cue.cueId ?? '').trim())
      .filter(Boolean),
  );
  const nativeCompletedCueCount = completedNativeCueIds.size;
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
  if (translationRoute === 'secondary') {
    if (finalWriteCount < 8) failures.push(`too few final subtitle translations; finalWriteCount=${finalWriteCount}`);
    if (queuedSegmentCount < 8) failures.push(`too few queued translated speech segments; queuedSegmentCount=${queuedSegmentCount}`);
    if (playedSegmentCount < 8) failures.push(`too few played translated speech segments; playedSegmentCount=${playedSegmentCount}`);
  } else {
    // Native Omni may produce one complete response for a continuous source,
    // especially when the required process-exclusion restart crosses an
    // earlier provider turn. Cue count is not a segmentation contract. Require
    // at least one fully published/rendered cue plus matching physical-start
    // evidence; content coverage and the loopback STT independently prove that
    // this was the complete reference translation rather than a token fragment.
    if (nativeCompletedCueCount < 1) {
      failures.push(`too few completed native translation cues; nativeCompletedCueCount=${nativeCompletedCueCount}`);
    }
    if (playedSegmentCount < 1) {
      failures.push(`no native translated speech playback reached the physical sink; playedSegmentCount=${playedSegmentCount}`);
    }
  }
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
    translationRoute,
    nativeCompletedCueCount,
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
    skipped: physicalOutput.skipped ?? false,
    status: physicalOutput.status ?? null,
    probeKind: physicalOutput.probeKind ?? physicalOutput.probe_kind ?? null,
    skipCode: physicalOutput.skipCode ?? physicalOutput.skip_code ?? null,
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
    processExclusionFingerprint: physicalOutput.processExclusionFingerprint
      ?? physicalOutput.process_exclusion_fingerprint
      ?? null,
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
  const feedbackLoopPrevention = normalizeFeedbackLoopPrevention(
    input.feedbackLoopPrevention ?? input.snapshots?.feedbackLoopPrevention,
  );
  const echoCancelVariant = feedbackLoopPrevention === 'echo-cancel';
  const driverlessVariant = feedbackLoopPrevention !== 'virtual-driver';
  const failedSteps = steps
    .filter((step) => (
      !step.ok
      && !(
        driverlessVariant
        && /^(?:driver probe|driver probe after repair)$/i.test(step.name)
      )
    ))
    .map((step) => ({
      name: step.name,
      error: step.error ?? 'step failed without an error message',
      details: summarizeStepDetails(step),
    }));
  const failedLayers = Object.entries(layers)
    .filter(([, layer]) => ['failed', 'blocked', 'inconclusive'].includes(layer.status))
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
    runnerFailure: driverlessVariant && isVirtualDriverDiagnosticFailure(input.failure?.message)
      ? null
      : input.failure?.message ?? null,
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
        ...matchingLines(input.appLogText ?? '', /watch_mode\.omni_preconnect_discarded|watch_mode\.omni_session_ready|diagnostic_autostart_(?:omni_preconnect|route)_(?:failed|started)|diagnostic_autostart_infrastructure_failed/i),
      ], 12),
      appReadiness: uniqueTail(matchingLines(input.appLogText ?? '', /readiness|session\.(?:created|updated)|ws\.recv\.session|watch_mode\.omni_session_ready|diagnostic_autostart_(?:ipc_ready|infrastructure_failed)/i), 12),
      realtimeSession: parseOmniRealtimeDiagnostics(appLog),
      aec: layers.aec?.data ?? null,
      bridgeErrors: echoCancelVariant ? [] : uniqueTail(bridgeLog.errorLines, 12),
      bridgeSourceSummary: echoCancelVariant ? [] : uniqueTail(bridgeLog.sourceSummaryLines, 5),
      bridgeWatchdog: echoCancelVariant ? [] : uniqueTail(bridgeLog.watchdogLines, 5),
      bridgeMetrics: bridgeLog.metrics,
      processExclusionRestart: layers.bridge?.data?.processExclusionRestart ?? null,
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

function processExclusionRestartLayerFailed(evidence, { required = false } = {}) {
  if (!required) return null;
  if (!evidence || evidence.completed !== true) {
    return 'process-exclusion did not prove a controlled live Bridge restart with new process/session/generation identity, continuous source frames, and zero old frames';
  }
  if (evidence.evidenceMode !== 'live' || evidence.fixtureOnly !== false) {
    return 'process-exclusion Bridge restart evidence was not produced by a live runtime session';
  }
  return null;
}

function aecLayerFailed(aec, { requireLiveScenario = false } = {}) {
  if (aec.outputMode !== 'text-and-audio') {
    return `echo-cancel requires native text-and-audio output; outputMode=${aec.outputMode ?? 'missing'}`;
  }
  if (aec.speakerPlaybackCompletedCount <= 0 || aec.speakerPlaybackFrames <= 0) {
    return 'echo-cancel did not complete native speaker playback';
  }
  if (aec.aecSummaryCount <= 0) {
    return 'echo-cancel did not emit an AEC3 processing summary';
  }
  if (aec.nonWebRtcBackendCount > 0 || aec.backend !== 'webrtc-aec3') {
    return `echo-cancel was not processed by the linked WebRTC AEC3 backend; backends=${aec.backends.join(',') || 'missing'}`;
  }
  if (
    aec.backendGateSummaryCount <= 0
    || aec.backendGateBackend !== 'webrtc-aec3'
    || !aec.webRtcAec3Ready
    || !aec.msvcBuildVerified
    || !aec.linkedBackendPresent
    || !aec.fixtureVerified
  ) {
    return 'echo-cancel runtime did not prove the linked WebRTC AEC3 backend, its MSVC build, and native 15 dB pure-echo fixture gate';
  }
  if (
    aec.renderClock !== 'wasapi-submit-position'
    || aec.endpointRenderPadding !== 'same-client-get-current-padding'
  ) {
    return `echo-cancel did not prove same-client WASAPI render timing; renderClock=${aec.renderClock ?? 'missing'} endpointRenderPadding=${aec.endpointRenderPadding ?? 'missing'}`;
  }
  if (
    aec.processedFrameSummaryCount <= 0
    || aec.maxRender10msFrames <= 0
    || aec.maxProcessedCapture10msFrames <= 0
  ) {
    return 'echo-cancel did not process both render and capture 10 ms frames';
  }
  if (aec.maxRejectedFrames > 0) {
    return `echo-cancel rejected ${aec.maxRejectedFrames} fixed-size AEC3 frames`;
  }
  if (aec.maxStatsReadFailures > 0) {
    return `echo-cancel failed to read native AEC3 statistics ${aec.maxStatsReadFailures} times`;
  }
  if (aec.asrDeletedChunkMetricCount <= 0) {
    return 'echo-cancel did not report the explicit ASR deletion invariant';
  }
  if (aec.maxAsrDeletedChunks > 0) {
    return 'echo-cancel deleted capture chunks instead of forwarding AEC3 processed PCM';
  }
  if (aec.erleMetricCount <= 0) {
    return 'echo-cancel AEC3 ERLE telemetry is unavailable';
  }
  if (
    aec.residualEchoLikelihoodMetricCount <= 0
    || aec.minResidualEchoLikelihood < 0
    || aec.maxResidualEchoLikelihood > 1
  ) {
    return 'echo-cancel residual echo likelihood is unavailable or outside [0, 1]';
  }
  if (
    aec.reportedDelayMetricCount <= 0
    || aec.minReportedDelayMs < 0
    || aec.maxReportedDelayMs > 1000
  ) {
    return 'echo-cancel AEC3 delay is unavailable or outside the supported 0-1000 ms range';
  }
  if (!aec.doubleTalkMetricAvailable) {
    return 'echo-cancel AEC3 double-talk frame telemetry is unavailable';
  }
  if (requireLiveScenario && aec.maxDoubleTalkFrames <= 0) {
    return 'echo-cancel AEC3 double-talk frame telemetry is unavailable or did not produce any frames during live injection';
  }
  if (requireLiveScenario && (aec.reportedDelaySpanMs == null || aec.reportedDelaySpanMs < 10)) {
    return `echo-cancel live dynamic-delay injection did not change AEC3 delay telemetry; spanMs=${aec.reportedDelaySpanMs ?? 'missing'}`;
  }
  if (requireLiveScenario && aec.liveScenario?.completed !== true) {
    return 'echo-cancel did not complete the real double-talk, dynamic-delay, and nonlinear physical-render scenario';
  }
  if (
    requireLiveScenario
    && (aec.liveScenario?.evidenceMode !== 'live' || aec.liveScenario?.fixtureOnly !== false)
  ) {
    return 'echo-cancel scenario evidence was not produced by the live reference-media playback and physical render path';
  }
  if (
    requireLiveScenario
    && (
      aec.liveScenario?.expectedSubtitles?.expectedSegmentCount <= 0
      || aec.liveScenario?.expectedSubtitles?.acceptanceRate !== 1
    )
  ) {
    return `echo-cancel did not accept every expected reference-media subtitle segment; accepted=${aec.liveScenario?.expectedSubtitles?.acceptedSegmentCount ?? 0}/${aec.liveScenario?.expectedSubtitles?.expectedSegmentCount ?? 0}`;
  }
  if (aec.processingMetricCount <= 0 || aec.maxAverageProcessingUs <= 0) {
    return 'echo-cancel did not report AEC3 processing time';
  }
  return null;
}

export const ECHO_CANCEL_SKIPPED_LAYERS = [
  'driver',
  'wasapi',
  'bridge',
  'physicalOutput',
  'physicalOutputContent',
  'speechSegmentation',
  'strictContent',
];

export const PROCESS_EXCLUSION_SKIPPED_LAYERS = ['driver', 'wasapi', 'aec'];

function normalizeFeedbackLoopPrevention(value) {
  return value === 'echo-cancel' || value === 'process-exclusion'
    ? value
    : 'virtual-driver';
}

function isVirtualDriverDiagnosticFailure(message) {
  return /driver probe|virtual audio (?:driver|endpoint)|root device status|driver health|test-development-driver/i.test(
    String(message ?? ''),
  );
}

function environmentPrecheckFailed(input, feedbackLoopPrevention = 'virtual-driver') {
  const precheck = normalizeSteps(input.steps).find((step) => (
    !step.ok
    && !(
      feedbackLoopPrevention !== 'virtual-driver'
      && /^(?:driver probe|driver probe after repair)$/i.test(step.name)
    )
    && /^(?:build bridge service native|driver probe|driver probe after repair|bridge source frame probe|physical output loopback probe|start desktop shell|start physical output content recording)$/i.test(step.name)
  ));
  if (precheck) return `${precheck.name}: ${precheck.error ?? 'environment prerequisite failed'}`;
  const message = String(input.failure?.message ?? '');
  if (feedbackLoopPrevention !== 'virtual-driver' && isVirtualDriverDiagnosticFailure(message)) {
    return null;
  }
  if (/requires elevation|executable not found|api key is required|environment prerequisite|missing required/i.test(message)) {
    return message;
  }
  return null;
}

export function classifyWatchModeRun(input) {
  const feedbackLoopPrevention = normalizeFeedbackLoopPrevention(
    input.feedbackLoopPrevention ?? input.snapshots?.feedbackLoopPrevention,
  );
  const echoCancelVariant = feedbackLoopPrevention === 'echo-cancel';
  const processExclusionVariant = feedbackLoopPrevention === 'process-exclusion';
  const bridgeLog = parseBridgeLog(input.bridgeLogText ?? '');
  const appLog = parseAppLog(input.appLogText ?? '');
  const translationRoute = inferTranslationRoute(input, appLog);
  const speechSegmentation = input.speechSegmentation ?? parseSpeechSegmentation(appLog);
  const realtimeSession = parseOmniRealtimeDiagnostics(appLog);
  const aec = parseAecDiagnostics(appLog, input);
  const processExclusionRestart = parseProcessExclusionRestart(appLog, input);
  const strictContent = input.strictContent ?? evaluateStrictContent({
    ...input,
    translationRoute,
    speechSegmentation,
  });
  const physicalOutputContentSkipped = input.physicalOutputContent?.skipped === true;
  const layers = {
    environment: createLayer('environment', input.steps),
    driver: createLayer('driver', input.driver),
    wasapi: createLayer('wasapi', input.wasapi),
    bridge: createLayer('bridge', processExclusionVariant
      ? { ...input.bridge, processExclusionRestart }
      : input.bridge, {
      parsedLog: bridgeLog,
    }),
    physicalOutput: createLayer('physicalOutput', input.physicalOutput),
    physicalOutputContent: createLayer('physicalOutputContent', input.physicalOutputContent),
    aec: createLayer('aec', aec),
    speechSegmentation: createLayer('speechSegmentation', speechSegmentation),
    strictContent: createLayer('strictContent', strictContent),
    app: createLayer('app', {
      ...input.app,
      watchSessionReport: input.watchSessionReport
        ? {
            sessionId: input.watchSessionReport.sessionId ?? null,
            status: input.watchSessionReport.status ?? null,
            summary: input.watchSessionReport.summary ?? null,
          }
        : null,
    }, {
      parsedLog: appLog,
    }),
    provider: createLayer('provider', input.provider),
  };
  if (physicalOutputContentSkipped) {
    layers.physicalOutputContent.status = 'skipped';
    layers.physicalOutputContent.reason = input.physicalOutputContent.reason
      ?? 'physical output content STT was explicitly skipped';
    layers.physicalOutputContent.reasons = [];
    layers.strictContent.status = 'skipped';
    layers.strictContent.reason = 'strict reference-media content STT was explicitly skipped with physical output content';
    layers.strictContent.reasons = [];
  }
  if (!echoCancelVariant && !physicalOutputContentSkipped && !strictContent.passed) {
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
  } else if (processExclusionVariant) {
    for (const layer of PROCESS_EXCLUSION_SKIPPED_LAYERS) {
      layers[layer].status = 'skipped';
      layers[layer].reason = 'process-exclusion uses Bridge application loopback and does not require this layer';
      layers[layer].reasons = [];
    }
  } else {
    layers.aec.status = 'skipped';
    layers.aec.reason = 'virtual-driver variant does not exercise acoustic echo cancellation';
    layers.aec.reasons = [];
  }

  const rawRunnerFailureReason = input.failure?.message ?? null;
  const runnerFailureReason = feedbackLoopPrevention !== 'virtual-driver'
    && isVirtualDriverDiagnosticFailure(rawRunnerFailureReason)
    ? null
    : rawRunnerFailureReason;
  const environmentReason = environmentPrecheckFailed(input, feedbackLoopPrevention);
  const hardProviderReason = providerLayerFailed(input.provider, appLog, input.physicalOutputContent, { hardOnly: true });
  const providerReason = providerLayerFailed(input.provider, appLog, input.physicalOutputContent, {
    requireFailedCallLogEvidence: echoCancelVariant,
  });
  const providerBeforeAppReason = omniAudibleNoVadReason(appLog);
  const subtitleConfigReason = subtitleTranslateConfigLayerFailed(appLog);
  const secondaryPreconnectReason = secondaryPreconnectLayerFailed(appLog, translationRoute);
  const aecReason = echoCancelVariant
    ? aecLayerFailed(aec, { requireLiveScenario: (input.mode ?? 'live') === 'live' })
    : null;
  const processExclusionRestartReason = processExclusionVariant
    ? processExclusionRestartLayerFailed(processExclusionRestart, {
        required: (input.mode ?? 'live') === 'live',
      })
    : null;
  const watchReportReason = watchSessionReportFailure(input.watchSessionReport, {
    required: (input.mode ?? 'live') === 'live',
  });
  const checks = runnerFailureReason
    ? [
        ['driver', driverLayerFailed(input.driver)],
        ['wasapi', wasapiLayerFailed(input.wasapi) ?? wasapiInjectedPlaybackFailed(input.wasapi, input.playback, appLog)],
        ['bridge', bridgeLayerFailed(input.bridge, bridgeLog, feedbackLoopPrevention) ?? processExclusionRestartReason],
        ['environment', environmentReason],
        ...(aecReason ? [['aec', aecReason]] : []),
        ['app', environmentReason ? null : runnerFailureReason],
        ['physicalOutput', physicalOutputLayerFailed(input.physicalOutput, {
          requireProcessFingerprint: processExclusionVariant,
        })],
        ...(subtitleConfigReason ? [['app', subtitleConfigReason]] : []),
        ...(hardProviderReason ? [['provider', hardProviderReason]] : []),
        ...(secondaryPreconnectReason ? [['app', secondaryPreconnectReason]] : []),
        ['physicalOutputContent', physicalOutputContentSkipped
          ? null
          : physicalOutputContentLayerFailed(input.physicalOutputContent)],
        ['provider', providerReason],
        ['speechSegmentation', speechSegmentationLayerFailed(speechSegmentation, translationRoute)],
        ['app', watchReportReason],
        ['strictContent', physicalOutputContentSkipped ? null : layers.strictContent.reason],
      ]
    : [
        ['driver', driverLayerFailed(input.driver)],
        ['wasapi', wasapiLayerFailed(input.wasapi) ?? wasapiInjectedPlaybackFailed(input.wasapi, input.playback, appLog)],
        ['bridge', bridgeLayerFailed(input.bridge, bridgeLog, feedbackLoopPrevention) ?? processExclusionRestartReason],
        ['physicalOutput', physicalOutputLayerFailed(input.physicalOutput, {
          requireProcessFingerprint: processExclusionVariant,
        })],
        ...(aecReason ? [['aec', aecReason]] : []),
        ...(subtitleConfigReason ? [['app', subtitleConfigReason]] : []),
        ...(hardProviderReason ? [['provider', hardProviderReason]] : []),
        ...(providerBeforeAppReason ? [['provider', providerReason]] : []),
        ...(secondaryPreconnectReason ? [['app', secondaryPreconnectReason]] : []),
        ['app', appLayerFailed(input.app, appLog, {
          translationRoute,
          watchSessionReport: input.watchSessionReport,
          requireWatchReport: (input.mode ?? 'live') === 'live',
        })],
        ['physicalOutputContent', physicalOutputContentSkipped
          ? null
          : physicalOutputContentLayerFailed(input.physicalOutputContent)],
        ...(providerBeforeAppReason ? [] : [['provider', providerReason]]),
        ['speechSegmentation', speechSegmentationLayerFailed(speechSegmentation, translationRoute)],
        ['app', watchReportReason],
        ['strictContent', physicalOutputContentSkipped ? null : layers.strictContent.reason],
      ];

  const skippedLayers = echoCancelVariant
    ? ECHO_CANCEL_SKIPPED_LAYERS
    : processExclusionVariant
      ? PROCESS_EXCLUSION_SKIPPED_LAYERS
      : [];
  const activeChecks = checks.filter(([layer]) => !skippedLayers.includes(layer));

  for (const [layer, reason] of activeChecks) {
    addLayerFailure(layers, layer, reason, input.mode ?? 'live');
  }

  if (environmentReason && layers.environment.reason) {
    layers.environment.status = 'blocked';
    if (feedbackLoopPrevention === 'virtual-driver' && layers.driver.reason) layers.driver.status = 'blocked';
    if (feedbackLoopPrevention === 'virtual-driver' && layers.wasapi.reason) layers.wasapi.status = 'blocked';
  }

  const failed = activeChecks.find(([layer]) => layers[layer].status === 'failed');
  const inconclusive = activeChecks.find(([layer]) => layers[layer].status === 'inconclusive');
  const blocked = environmentReason
    ? (layers.driver.status === 'blocked' ? ['driver', layers.driver.reason] : ['environment', environmentReason])
    : null;
  const failureLayer = blocked?.[0] ?? failed?.[0] ?? inconclusive?.[0] ?? null;
  const verdict = blocked ? 'blocked' : failed ? 'failed' : inconclusive ? 'inconclusive' : 'passed';
  const diagnostics = buildReportDiagnostics(input, layers, activeChecks, appLog, bridgeLog);
  const provenance = input.provenance ?? currentGitProvenance();
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    // Keep the legacy top-level commit for report consumers, while strict
    // verification uses the explicit clean-worktree provenance object below.
    commit: input.commit ?? provenance.headCommit,
    provenance,
    buildHash: input.buildHash ?? null,
    mode: input.mode ?? 'live',
    modelId: input.modelId ?? input.snapshots?.modelId ?? null,
    feedbackLoopPrevention,
    deviceEvidence: input.deviceEvidence ?? input.snapshots?.deviceEvidence ?? null,
    realtimeSession,
    translationRoute,
    watchSessionReport: input.watchSessionReport ?? null,
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
    `- GitHead: ${report.provenance?.headCommit ?? report.commit ?? '-'}`,
    `- WorktreeClean: ${report.provenance?.worktreeClean === true}`,
    `- FeedbackLoopPrevention: ${report.feedbackLoopPrevention ?? 'virtual-driver'}`,
    `- Device: class=${report.deviceEvidence?.deviceClass ?? '-'} profile=${report.deviceEvidence?.profileId ?? '-'} id=${report.deviceEvidence?.resolvedDeviceId ?? '-'} name=${report.deviceEvidence?.resolvedDeviceName ?? '-'}`,
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
  for (const line of report.diagnostics?.evidence?.bridgeErrors ?? []) lines.push(`- bridge: ${line}`);
  for (const line of report.layers.app.parsedLog.errorLines.slice(-10)) lines.push(`- app: ${line}`);
  for (const line of report.diagnostics?.evidence?.providerErrors ?? []) lines.push(`- provider: ${line}`);
  for (const line of report.diagnostics?.evidence?.appOmniPreconnect ?? []) lines.push(`- omni-preconnect: ${line}`);
  for (const line of report.diagnostics?.evidence?.appReadiness ?? []) lines.push(`- readiness: ${line}`);
  for (const line of report.diagnostics?.evidence?.bridgeSourceSummary ?? []) lines.push(`- bridge-source-summary: ${line}`);
  for (const line of report.diagnostics?.evidence?.bridgeWatchdog ?? []) lines.push(`- bridge-watchdog: ${line}`);
  const aec = report.layers.aec?.data;
  if (report.layers.aec?.status !== 'skipped' && aec) {
    lines.push(`- aec: outputMode=${aec.outputMode ?? '-'} backend=${aec.backend ?? '-'} linkedReady=${aec.webRtcAec3Ready} fixtureVerified=${aec.fixtureVerified} speakerPlaybackCompleted=${aec.speakerPlaybackCompletedCount} speakerPlaybackSeconds=${aec.speakerPlaybackSeconds} render10msFrames=${aec.maxRender10msFrames} processedCapture10msFrames=${aec.maxProcessedCapture10msFrames} erleDb=${aec.maxErleDb ?? '-'} residualEchoLikelihood=${aec.maxResidualEchoLikelihood ?? '-'} reportedDelayMs=${aec.maxReportedDelayMs ?? '-'} resetCount=${aec.maxResetCount} renderUnderruns=${aec.maxRenderUnderruns} captureUnderruns=${aec.maxCaptureUnderruns} maxProcessingUs=${aec.maxProcessingUs} asrForwardedChunks=${aec.maxAsrForwardedChunks} asrDeletedChunks=${aec.maxAsrDeletedChunks}`);
    lines.push(`- aec-live-scenario: completed=${aec.liveScenario?.completed === true} evidenceMode=${aec.liveScenario?.evidenceMode ?? '-'} doubleTalkFrames=${aec.maxDoubleTalkFrames ?? '-'} delaySpanMs=${aec.reportedDelaySpanMs ?? '-'} nonlinearity=${aec.liveScenario?.nonlinearity ?? '-'} expectedSubtitles=${aec.liveScenario?.expectedSubtitles?.acceptedSegmentCount ?? 0}/${aec.liveScenario?.expectedSubtitles?.expectedSegmentCount ?? 0}`);
  }
  const restart = report.layers.bridge?.data?.processExclusionRestart;
  if (restart?.requested) {
    lines.push(`- process-exclusion-restart: completed=${restart.completed === true} evidenceMode=${restart.evidenceMode ?? '-'} pid=${restart.oldBridgeProcessId ?? '-'}->${restart.newBridgeProcessId ?? '-'} generation=${restart.oldSourceGeneration ?? '-'}->${restart.newSourceGeneration ?? '-'} frames=${restart.sourceFramesBefore ?? '-'}->${restart.sourceFramesAfter ?? '-'} oldFramesAfterRestart=${restart.oldFramesAfterRestart ?? '-'} metricsSamples=${restart.systemMetrics?.sampleCount ?? 0}`);
  }
  if (report.layers.physicalOutput?.status !== 'skipped' && report.diagnostics?.evidence?.physicalOutput) {
    lines.push(`- physical-output: ${JSON.stringify(report.diagnostics.evidence.physicalOutput)}`);
  }
  if (report.layers.physicalOutputContent?.status !== 'skipped' && report.diagnostics?.evidence?.physicalOutputContent) {
    lines.push(`- physical-output-content: ${JSON.stringify(report.diagnostics.evidence.physicalOutputContent)}`);
  }
  const strict = report.layers.strictContent?.data;
  if (report.layers.strictContent?.status !== 'skipped' && strict?.applicable) {
    lines.push(`- strict-content: coverage=${strict.coverage ?? '-'} lengthRatio=${strict.lengthRatio ?? '-'} finalWriteCount=${strict.finalWriteCount ?? '-'} queuedSegmentCount=${strict.queuedSegmentCount ?? '-'} playedSegmentCount=${strict.playedSegmentCount ?? '-'}`);
    for (const failure of strict.failures ?? []) lines.push(`- strict-content-failure: ${failure}`);
    if (strict.missingConcepts?.length > 0) lines.push(`- strict-missing-concepts: ${strict.missingConcepts.join(', ')}`);
    for (const clause of (strict.missingClauses ?? []).slice(0, 5)) lines.push(`- strict-missing-clause: ${clause}`);
  }
  return `${lines.join('\n')}\n`;
}

function bridgeSnapshotFromProbe(probe, feedbackLoopPrevention) {
  if (!probe || typeof probe !== 'object') return null;
  const state = probe.state;
  if (state && (probe.sourceFrame || feedbackLoopPrevention === 'process-exclusion')) {
    return {
      probePassed: probe.passed !== false,
      bridgeState: state.bridgeState,
      driverHealth: state.driverHealth,
      sourceCaptureMode: state.sourceCaptureMode,
      captureBackend: state.captureBackend,
      processLoopbackSupported: state.processLoopbackSupported,
      processLoopbackStatus: state.processLoopbackStatus,
      windowsBuildNumber: state.windowsBuildNumber,
      processLoopbackMinimumWindowsBuild: state.processLoopbackMinimumWindowsBuild,
      excludedProcessId: state.excludedProcessId,
      processLoopbackFailureDetail: state.processLoopbackFailureDetail,
      sourceSubscriberActive: state.sourceSubscriberActive,
      sourceReadCalls: state.sourceReadCalls,
      droppedFrameCount: state.droppedFrameCount,
      lastErrorCode: state.lastErrorCode,
      sourceFramePayloadBytes: probe.sourceFrame?.payloadBytes ?? 0,
      pipeName: probe.pipeName,
      sourcePipeName: probe.sourcePipeName,
    };
  }
  return {
    probePassed: false,
    error: probe.error,
    phase: probe.phase,
    stateQueryError: probe.stateQueryError,
    init: probe.init,
    state: probe.state,
    pipeName: probe.pipeName,
    sourcePipeName: probe.sourcePipeName,
    stdout: probe.stdout,
    stderr: probe.stderr,
  };
}

export function collectInputFromDirectory(inputDir, mode = 'live', options = {}) {
  const appLogPath = path.join(inputDir, 'app.log');
  const bridgeLogPath = path.join(inputDir, 'bridge-service.log');
  const snapshotsPath = path.join(inputDir, 'snapshots.json');
  const failurePath = path.join(inputDir, 'failure.json');
  const stepsPath = path.join(inputDir, 'steps.json');
  const snapshots = readJsonIfExists(snapshotsPath) ?? {};
  const feedbackLoopPrevention = snapshots.feedbackLoopPrevention ?? null;
  const bridgeProbe = readJsonIfExists(path.join(inputDir, 'bridge-source-probe.json'));
  const runMarker = snapshots.runMarker ?? null;
  const startedAtLocal = snapshots.startedAtLocal ?? null;
  const rawAppLogText = readTextIfExists(appLogPath);
  const rawBridgeLogText = readTextIfExists(bridgeLogPath);
  const appLogText = textAfterMarker(rawAppLogText, runMarker) || textAfterLocalTimestamp(rawAppLogText, startedAtLocal);
  const bridgeLogText = textAfterMarker(rawBridgeLogText, runMarker) || textAfterLocalTimestamp(rawBridgeLogText, startedAtLocal);
  return {
    mode,
    snapshots,
    provenance: options.provenance,
    feedbackLoopPrevention,
    driver: readJsonIfExists(path.join(inputDir, 'driver.json')) ?? snapshots.driver,
    wasapi: readJsonIfExists(path.join(inputDir, 'driver.json')) ?? snapshots.wasapi ?? snapshots.driver,
    bridge: bridgeSnapshotFromProbe(bridgeProbe, feedbackLoopPrevention) ?? snapshots.bridge,
    physicalOutput: readJsonIfExists(path.join(inputDir, 'physical-output-probe.json')) ?? snapshots.physicalOutput,
    physicalOutputContent: readJsonIfExists(path.join(inputDir, 'physical-output-content.json')) ?? snapshots.physicalOutputContent,
    app: snapshots.app,
    provider: snapshots.provider,
    speechSegmentation: snapshots.speechSegmentation,
    deviceEvidence: readJsonIfExists(path.join(inputDir, 'physical-playback-device.json'))
      ?? snapshots.deviceEvidence,
    watchSessionReport: readJsonIfExists(path.join(inputDir, 'watch-session-report.json'))
      ?? snapshots.watchSessionReport,
    playback: readJsonIfExists(path.join(inputDir, 'playback.json')) ?? snapshots.playback,
    systemMetrics: readJsonIfExists(path.join(inputDir, 'system-metrics.json')),
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
      watchSessionReport: fs.existsSync(path.join(inputDir, 'watch-session-report.json'))
        ? path.join(inputDir, 'watch-session-report.json')
        : null,
      systemMetrics: fs.existsSync(path.join(inputDir, 'system-metrics.json'))
        ? path.join(inputDir, 'system-metrics.json')
        : null,
    },
  };
}

export function rebuildReportFromDirectory(inputDir, { mode = 'live', provenance } = {}) {
  return classifyWatchModeRun(collectInputFromDirectory(inputDir, mode, { provenance }));
}

export function writeReport({ inputDir, outputDir, mode = 'live' }) {
  fs.mkdirSync(outputDir, { recursive: true });
  const report = rebuildReportFromDirectory(inputDir, { mode });
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
