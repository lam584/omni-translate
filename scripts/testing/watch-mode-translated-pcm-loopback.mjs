import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isMain, parseCliArgs } from '../lib/testing-common.mjs';
import { matchTranslatedLoopbackBatchWithRust } from './watch-mode-rust-audio-analysis.mjs';

export const TRANSLATED_PCM_AUTHORITY_KIND = 'watch-mode-translated-cue-pcm-authority';
export const TRANSLATED_PCM_LOOPBACK_KIND = 'watch-mode-translated-pcm-loopback-correlation';
export const TRANSLATED_PCM_SUMMARY_FILE = 'translated-cue-pcm-summary.json';
export const TRANSLATED_PCM_JOURNAL_FILE = 'translated-cue-pcm-authority.jsonl';
export const LOOPBACK_SAMPLE_RATE_HZ = 16_000;
export const MIN_COMPLETE_MATCHED_CUES = 2;

const BRIDGE_RENDERER_KIND = 'bridge-physical-playback';
const DESKTOP_RENDERER_KIND = 'desktop-speaker';
const BRIDGE_FEEDBACK_MODES = new Set(['virtual-driver', 'process-exclusion']);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);

function expectedRendererKind(feedbackLoopPrevention) {
  if (feedbackLoopPrevention === 'echo-cancel') return DESKTOP_RENDERER_KIND;
  if (BRIDGE_FEEDBACK_MODES.has(feedbackLoopPrevention)) return BRIDGE_RENDERER_KIND;
  throw new Error(`unsupported translated PCM feedbackLoopPrevention: ${feedbackLoopPrevention || 'missing'}`);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

const sha256File = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const rounded = (value, digits = 6) => Number(Number(value).toFixed(digits));

function pcmWindowRms(bytes, offsetSamples, sampleCount) {
  let squareSum = 0;
  for (let index = offsetSamples; index < offsetSamples + sampleCount; index += 1) {
    const sample = bytes.readInt16LE(index * 2) / 32768;
    squareSum += sample * sample;
  }
  return Math.sqrt(squareSum / Math.max(1, sampleCount));
}

function selectHighEnergyAnchors(cue) {
  const sampleRateHz = Number(cue.sampleRateHz);
  const channelCount = Number(cue.channelCount);
  const totalFrames = Number(cue.frameCount);
  const durationSeconds = totalFrames / sampleRateHz;
  const anchorCount = durationSeconds >= 1.2 ? 3 : durationSeconds >= 0.8 ? 2 : durationSeconds >= 0.4 ? 1 : 0;
  if (anchorCount === 0) {
    return { anchors: [], auditable: false, reason: 'cue is shorter than the minimum 400ms acoustic window' };
  }
  const minimumFrames = Math.ceil(sampleRateHz * 0.4);
  const anchors = [];
  const anchorNames = anchorCount === 3 ? ['early', 'middle', 'late']
    : anchorCount === 2 ? ['early', 'late'] : ['full'];
  for (let regionIndex = 0; regionIndex < anchorCount; regionIndex += 1) {
    const regionStart = Math.floor(totalFrames * regionIndex / anchorCount);
    const regionEnd = Math.floor(totalFrames * (regionIndex + 1) / anchorCount);
    const regionFrames = regionEnd - regionStart;
    const windowFrames = minimumFrames;
    if (regionFrames < minimumFrames || windowFrames > regionFrames) {
      return { anchors: [], auditable: false, reason: 'cue cannot provide the required independent 400ms acoustic windows' };
    }
    const strideFrames = Math.max(1, Math.floor(sampleRateHz * 0.05));
    const candidates = [];
    for (
      let frameOffset = regionStart;
      frameOffset + windowFrames <= regionEnd;
      frameOffset += strideFrames
    ) {
      const sampleOffset = frameOffset * channelCount;
      const sampleCount = windowFrames * channelCount;
      const rms = pcmWindowRms(cue.pcmBytes, sampleOffset, sampleCount);
      candidates.push({ frameOffset, sampleOffset, sampleCount, rms });
    }
    candidates.sort((left, right) => right.rms - left.rms || left.frameOffset - right.frameOffset);
    const maximumRms = candidates[0]?.rms ?? 0;
    const highEnergyCandidates = [];
    for (const candidate of candidates) {
      if (candidate.rms < maximumRms * 0.8) break;
      if (highEnergyCandidates.some((selected) => (
        candidate.frameOffset < selected.frameOffset + windowFrames
        && selected.frameOffset < candidate.frameOffset + windowFrames
      ))) continue;
      highEnergyCandidates.push(candidate);
      if (highEnergyCandidates.length === 3) break;
    }
    if (maximumRms < 0.003 || highEnergyCandidates.length === 0) {
      return { anchors: [], auditable: false, reason: `cue ${anchorNames[regionIndex]} acoustic window is silent` };
    }
    anchors.push({
      name: anchorNames[regionIndex],
      candidates: highEnergyCandidates.map((candidate) => ({
        frameOffset: candidate.frameOffset,
        rms: rounded(candidate.rms),
        reference: {
          referencePath: cue.pcmPath,
          referenceSampleRateHz: sampleRateHz,
          referenceChannels: channelCount,
          referenceOffsetSamples: candidate.sampleOffset,
          referenceSampleCount: candidate.sampleCount,
        },
      })),
    });
  }
  return { anchors, auditable: true, reason: null };
}

function expectedAnchorPlaybackAtMs(cue, anchor, startedAtMs) {
  const sampleRateHz = Number(cue.sampleRateHz);
  const channelCount = Number(cue.channelCount);
  const anchorSampleOffset = anchor.frameOffset * channelCount;
  let scheduledAtMs = startedAtMs;
  for (const chunk of cue.chunks) {
    const chunkSampleOffset = Number(chunk.sampleOffset);
    const chunkSampleCount = Number(chunk.sampleCount);
    const chunkDurationMs = chunkSampleCount * 1_000 / (sampleRateHz * channelCount);
    scheduledAtMs = Math.max(scheduledAtMs, Number(chunk.acceptedAtMs));
    if (
      anchorSampleOffset >= chunkSampleOffset
      && anchorSampleOffset < chunkSampleOffset + chunkSampleCount
    ) {
      return scheduledAtMs
        + (anchorSampleOffset - chunkSampleOffset) * 1_000 / (sampleRateHz * channelCount);
    }
    scheduledAtMs += chunkDurationMs;
  }
  throw new Error(`anchor ${anchor.name} is outside translated PCM chunk coverage`);
}

function readRegularFile(filePath, label) {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
    throw new Error(`${label} must be a non-empty regular non-symlink file: ${filePath}`);
  }
  return { stats, bytes: fs.readFileSync(filePath) };
}

function readJson(filePath, label) {
  const { bytes } = readRegularFile(filePath, label);
  try {
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`${label} is not JSON: ${error.message}`);
  }
}

function resolveChild(parentDirectory, relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) throw new Error(`${label} path is missing`);
  const normalized = relativePath.replaceAll('\\', '/');
  if (path.posix.isAbsolute(normalized) || normalized.split('/').some((part) => part === '..')) {
    throw new Error(`${label} path must be relative and may not contain '..'`);
  }
  const parent = path.resolve(parentDirectory);
  const resolved = path.resolve(parent, ...normalized.split('/'));
  const relative = path.relative(parent, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} path escapes its authority directory`);
  }
  return resolved;
}


function parseLogTimestamp(line) {
  const explicit = line.match(/\btimestampMs=(\d+)\b/);
  if (explicit) {
    const timestampMs = Number(explicit[1]);
    if (Number.isSafeInteger(timestampMs) && timestampMs > 0) return timestampMs;
  }
  const match = line.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
  if (!match) return null;
  return new Date(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]), Number(match[7]),
  ).getTime();
}

function completeReportCueIds(report) {
  const ids = [];
  const seen = new Set();
  for (const cue of Array.isArray(report?.cues) ? report.cues : []) {
    if (
      !['exact', 'formatting-only'].includes(cue?.comparisonStatus)
      || !String(cue?.llmText ?? '').trim()
      || !String(cue?.publishedText ?? '').trim()
      || !String(cue?.renderedText ?? '').trim()
      || seen.has(cue?.cueId)
    ) continue;
    seen.add(cue.cueId);
    ids.push(cue.cueId);
  }
  return ids;
}

function playbackLifecycle(scopedLog, requiredCueIds) {
  const events = [];
  for (const [index, line] of scopedLog.split(/\r?\n/).entries()) {
    if (!/event=translation_playback_status/.test(line)) continue;
    const cueId = line.match(/\bcueId=([A-Za-z0-9._:-]+)/)?.[1];
    const status = line.match(/\bstatus=(queued|started|completed)\b/)?.[1];
    if (!cueId || !status) continue;
    events.push({ cueId, status, index, occurredAtMs: parseLogTimestamp(line) });
  }
  const byCue = new Map();
  const violations = [];
  for (const cueId of requiredCueIds) {
    const cueEvents = events.filter((entry) => entry.cueId === cueId);
    const queued = cueEvents.filter((entry) => entry.status === 'queued');
    const started = cueEvents.filter((entry) => entry.status === 'started');
    const completed = cueEvents.filter((entry) => entry.status === 'completed');
    if (
      queued.length !== 1 || started.length !== 1 || completed.length !== 1
      || !(queued[0].index < started[0].index && started[0].index < completed[0].index)
      || ![queued[0], started[0], completed[0]].every((entry) => Number.isFinite(entry.occurredAtMs))
      || !(queued[0].occurredAtMs <= started[0].occurredAtMs
        && started[0].occurredAtMs <= completed[0].occurredAtMs)
    ) {
      violations.push(`cue ${cueId} does not have exactly one ordered timestamped queued/started/completed lifecycle`);
      continue;
    }
    byCue.set(cueId, { queued: queued[0], started: started[0], completed: completed[0] });
  }
  return { byCue, violations };
}

function processExclusionRestartPlayback(scopedLog) {
  const summaryLine = scopedLog
    .split(/\r?\n/)
    .findLast((line) => /\bevent=process_exclusion_restart_summary\b/.test(line));
  if (!summaryLine) return null;
  const value = (key) => summaryLine.match(new RegExp(`\\b${key}=([^\\s]+)`))?.[1] ?? '';
  const number = (key) => Number(value(key));
  return {
    status: value('status'),
    recoveredAtMs: number('recoveredAtUnixMs') || number('recoveredAtMs'),
    oldPlaybackOwnerGeneration: number('oldPlaybackOwnerGeneration'),
    newPlaybackOwnerGeneration: number('newPlaybackOwnerGeneration'),
    oldPhysicalPlaybackDeviceId: value('oldPhysicalPlaybackDeviceId'),
    newPhysicalPlaybackDeviceId: value('newPhysicalPlaybackDeviceId'),
    physicalPlaybackStatus: value('physicalPlaybackStatus'),
  };
}

function validateTranslatedAuthority({
  authorityDirectory,
  expectedIdentity,
  feedbackLoopPrevention,
}) {
  const summaryPath = path.join(authorityDirectory, TRANSLATED_PCM_SUMMARY_FILE);
  const journalPath = path.join(authorityDirectory, TRANSLATED_PCM_JOURNAL_FILE);
  const summary = readJson(summaryPath, 'translated PCM summary');
  const violations = [];
  const identity = {
    schemaVersion: 2,
    artifactKind: TRANSLATED_PCM_AUTHORITY_KIND,
    direction: 'inbound',
    ...expectedIdentity,
  };
  for (const [key, expected] of Object.entries(identity)) {
    if (expected !== undefined && summary?.[key] !== expected) violations.push(`translated PCM summary ${key} mismatch`);
  }
  if (summary.pcmFormat !== 's16le') violations.push('translated PCM summary format is not s16le');
  if (summary.finalized !== true || summary.terminalReason !== 'worker-completed') violations.push('translated PCM summary is not worker-completed');
  if (Number(summary.activeStreamCount) !== 0 || Number(summary.abortedStreamCount) !== 0) violations.push('translated PCM summary contains active or aborted streams');
  const cues = Array.isArray(summary.acceptedCues) ? summary.acceptedCues : [];
  if (Number(summary.cueCount) !== cues.length || cues.length === 0) violations.push('translated PCM summary cueCount is empty or inconsistent');
  const cueIds = new Set();
  const expectedKind = expectedRendererKind(feedbackLoopPrevention);
  const bridgeOnlyFields = [
    'sessionId',
    'bridgeInstanceId',
    'sourceGeneration',
    'sourceGenerationToken',
    'playbackOwnerGeneration',
  ];
  const desktopOnlyFields = [
    'rendererInstanceId',
    'rendererOwnerGeneration',
    'renderAttemptId',
    'playedFrames',
    'playedSampleRateHz',
    'playedChannelCount',
  ];
  let totalSamples = 0;
  let totalBytes = 0;
  const validatedCues = [];
  for (const [index, cue] of cues.entries()) {
    if (Number(cue.sequence) !== index + 1) violations.push(`translated PCM cue ${index} sequence mismatch`);
    if (!cue.cueId || cueIds.has(cue.cueId)) violations.push(`translated PCM cue ${index} has a missing/duplicate cueId`);
    cueIds.add(cue.cueId);
    const sampleRateHz = Number(cue.sampleRateHz);
    const channelCount = Number(cue.channelCount);
    const sampleCount = Number(cue.sampleCount);
    const frameCount = Number(cue.frameCount);
    const bytes = Number(cue.bytes);
    if (!nonEmptyString(cue.responseId)) violations.push(`translated PCM cue ${cue.cueId} response identity is missing`);
    if (cue.rendererKind !== expectedKind) {
      violations.push(`translated PCM cue ${cue.cueId} renderer kind ${cue.rendererKind ?? 'missing'} is incompatible with ${feedbackLoopPrevention}`);
    }
    if (!String(cue.physicalPlaybackDeviceId ?? '').trim()) violations.push(`translated PCM cue ${cue.cueId} physical endpoint is missing`);
    if (!Number.isInteger(sampleRateHz) || sampleRateHz < 8_000 || sampleRateHz > 48_000) violations.push(`translated PCM cue ${cue.cueId} sample rate is invalid`);
    if (!Number.isInteger(channelCount) || channelCount <= 0 || channelCount > 2) violations.push(`translated PCM cue ${cue.cueId} channel count is invalid`);
    if (!Number.isInteger(sampleCount) || sampleCount <= 0 || bytes !== sampleCount * 2) violations.push(`translated PCM cue ${cue.cueId} sample/byte count mismatch`);
    if (frameCount !== sampleCount / channelCount) violations.push(`translated PCM cue ${cue.cueId} frame count mismatch`);
    if (cue.rendererKind === BRIDGE_RENDERER_KIND) {
      if (!nonEmptyString(cue.sessionId)
        || !nonEmptyString(cue.bridgeInstanceId)
        || !Number.isSafeInteger(Number(cue.sourceGeneration))
        || Number(cue.sourceGeneration) <= 0
        || !nonEmptyString(cue.sourceGenerationToken)
        || cue.sourceGenerationToken !== `${cue.bridgeInstanceId}:${cue.sessionId}:${cue.sourceGeneration}`
        || !Number.isSafeInteger(Number(cue.playbackOwnerGeneration))
        || Number(cue.playbackOwnerGeneration) <= 0
        || Number(cue.acceptedFrames) !== frameCount) {
        violations.push(`translated PCM cue ${cue.cueId} Bridge renderer authority is incomplete or inconsistent`);
      }
      if (desktopOnlyFields.some((field) => hasOwn(cue, field))) {
        violations.push(`translated PCM cue ${cue.cueId} Bridge renderer contains forbidden Desktop fields`);
      }
    } else if (cue.rendererKind === DESKTOP_RENDERER_KIND) {
      const playedFrames = Number(cue.playedFrames);
      const playedSampleRateHz = Number(cue.playedSampleRateHz);
      const playedChannelCount = Number(cue.playedChannelCount);
      if (!nonEmptyString(cue.rendererInstanceId)
        || !Number.isSafeInteger(Number(cue.rendererOwnerGeneration))
        || Number(cue.rendererOwnerGeneration) <= 0
        || !nonEmptyString(cue.renderAttemptId)
        || !Number.isSafeInteger(playedFrames)
        || playedFrames <= 0
        || !Number.isInteger(playedSampleRateHz)
        || playedSampleRateHz <= 0
        || !Number.isInteger(playedChannelCount)
        || playedChannelCount <= 0
        || playedFrames * sampleRateHz !== frameCount * playedSampleRateHz) {
        violations.push(`translated PCM cue ${cue.cueId} Desktop speaker played authority is incomplete or duration-mismatched`);
      }
      if (bridgeOnlyFields.some((field) => hasOwn(cue, field))) {
        violations.push(`translated PCM cue ${cue.cueId} Desktop renderer contains forbidden Bridge fields`);
      }
    }
    const chunks = Array.isArray(cue.chunks) ? cue.chunks : [];
    if (chunks.length !== Number(cue.chunkCount) || chunks.length === 0) {
      violations.push(`translated PCM cue ${cue.cueId} chunk metadata is missing or inconsistent`);
    }
    let nextSampleOffset = 0;
    let priorAcceptedAtMs = 0;
    for (const [chunkPosition, chunk] of chunks.entries()) {
      const chunkSampleCount = Number(chunk.sampleCount);
      if (
        Number(chunk.chunkIndex) !== chunkPosition
        || Number(chunk.sampleOffset) !== nextSampleOffset
        || !Number.isInteger(chunkSampleCount)
        || chunkSampleCount <= 0
        || !String(chunk.requestId ?? '').trim()
        || chunk.requestId !== cue.requestIds?.[chunkPosition]
        || !Number.isSafeInteger(Number(chunk.acceptedAtMs))
        || Number(chunk.acceptedAtMs) <= 0
        || Number(chunk.acceptedAtMs) < priorAcceptedAtMs
      ) violations.push(`translated PCM cue ${cue.cueId} chunk ${chunkPosition} metadata is invalid`);
      priorAcceptedAtMs = Number(chunk.acceptedAtMs);
      nextSampleOffset += Number.isInteger(chunkSampleCount) && chunkSampleCount > 0 ? chunkSampleCount : 0;
    }
    if (nextSampleOffset !== sampleCount) violations.push(`translated PCM cue ${cue.cueId} chunk sample coverage mismatch`);
    let pcmPath;
    try {
      pcmPath = resolveChild(authorityDirectory, cue.relativePath, `translated PCM cue ${cue.cueId}`);
      const { stats, bytes: pcmBytes } = readRegularFile(pcmPath, `translated PCM cue ${cue.cueId}`);
      if (stats.size !== bytes || sha256File(pcmPath) !== cue.sha256) violations.push(`translated PCM cue ${cue.cueId} file hash/length mismatch`);
      validatedCues.push({ ...cue, pcmPath, pcmBytes });
    } catch (error) {
      violations.push(error.message);
    }
    totalSamples += sampleCount;
    totalBytes += bytes;
  }
  if (Number(summary.totalSamples) !== totalSamples || Number(summary.totalBytes) !== totalBytes) violations.push('translated PCM summary totals mismatch');

  const journalLines = readRegularFile(journalPath, 'translated PCM journal').bytes.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const journal = journalLines.map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`translated PCM journal line ${index + 1} is invalid: ${error.message}`); }
  });
  let priorJournalOccurredAtMs = 0;
  for (const [index, event] of journal.entries()) {
    if (Number(event.sequence) !== index + 1) violations.push(`translated PCM journal sequence mismatch at ${index + 1}`);
    const occurredAtMs = Number(event.occurredAtMs);
    if (!Number.isSafeInteger(occurredAtMs)
      || occurredAtMs <= 0
      || (index > 0 && occurredAtMs < priorJournalOccurredAtMs)) {
      violations.push(`translated PCM journal timestamp is invalid or non-monotonic at ${index + 1}`);
    }
    priorJournalOccurredAtMs = occurredAtMs;
    for (const [key, expected] of Object.entries(identity)) {
      if (expected !== undefined && event?.[key] !== expected) violations.push(`translated PCM journal ${key} mismatch at ${index + 1}`);
    }
  }
  if (journal[0]?.event !== 'initialized' || journal.at(-1)?.event !== 'finalized') violations.push('translated PCM journal must run initialized to finalized');
  if (journal.some((event) => event.event === 'stream_aborted')) violations.push('translated PCM journal contains stream_aborted');
  const cueEvents = journal.filter((event) => (
    event.event === 'bridge_write_accepted' || event.event === 'desktop_speaker_played'
  ));
  if (cueEvents.length !== cues.length) {
    violations.push('translated PCM journal renderer completion count mismatch');
  }
  for (const [index, cue] of cues.entries()) {
    const event = cueEvents[index];
    const expectedEvent = cue.rendererKind === BRIDGE_RENDERER_KIND
      ? 'bridge_write_accepted'
      : 'desktop_speaker_played';
    if (!event
      || event.event !== expectedEvent
      || event.detail?.cueId !== cue.cueId
      || event.detail?.responseId !== cue.responseId
      || event.detail?.rendererKind !== cue.rendererKind
      || event.detail?.sha256 !== cue.sha256) {
      violations.push(`translated PCM cue ${cue.cueId} journal event does not bind its renderer completion`);
    }
  }
  return {
    summary,
    cues: validatedCues,
    violations,
    artifacts: {
      summary: { path: TRANSLATED_PCM_SUMMARY_FILE, bytes: fs.statSync(summaryPath).size, sha256: sha256File(summaryPath) },
      journal: { path: TRANSLATED_PCM_JOURNAL_FILE, bytes: fs.statSync(journalPath).size, sha256: sha256File(journalPath), eventCount: journal.length },
    },
  };
}

export function buildTranslatedPcmLoopbackAuthority({
  runDirectory,
  appLogPath = path.join(runDirectory, 'app.log'),
  runMarker,
  recordingStartedAtEpochMs,
  cellId,
  leaseId,
  modelId,
  protocol,
  feedbackLoopPrevention,
}) {
  const violations = [];
  const resolvedRunDirectory = path.resolve(runDirectory);
  const authorityDirectory = path.join(resolvedRunDirectory, 'translated-cue-pcm');
  let translated;
  try {
    translated = validateTranslatedAuthority({
      authorityDirectory,
      expectedIdentity: { cellId, leaseId, runMarker, model: modelId, protocol },
      feedbackLoopPrevention,
    });
    violations.push(...translated.violations);
  } catch (error) {
    violations.push(error.message);
    translated = { summary: null, cues: [], artifacts: null, violations: [] };
  }
  const report = readJson(path.join(resolvedRunDirectory, 'watch-session-report.json'), 'Watch session report');
  const requiredCueIds = completeReportCueIds(report);
  if (requiredCueIds.length < MIN_COMPLETE_MATCHED_CUES) {
    violations.push(`translated PCM loopback requires at least ${MIN_COMPLETE_MATCHED_CUES} complete rendered cues; found ${requiredCueIds.length}`);
  }
  let lifecycle = new Map();
  let scopedLog = '';
  try {
    const log = readRegularFile(appLogPath, 'run app.log').bytes.toString('utf8');
    // The run marker is intentionally repeated by later diagnostic events.
    // Scope from its first occurrence in this per-run app.log so playback
    // lifecycle events are not discarded when the report-save event repeats it.
    const markerIndex = log.indexOf(runMarker);
    if (markerIndex < 0) throw new Error('run marker is absent from app.log');
    scopedLog = log.slice(markerIndex);
    const parsedLifecycle = playbackLifecycle(scopedLog, requiredCueIds);
    lifecycle = parsedLifecycle.byCue;
    violations.push(...parsedLifecycle.violations);
  } catch (error) {
    violations.push(error.message);
  }
  const recordingPath = path.join(resolvedRunDirectory, 'physical-output-recording-16k-mono.pcm');
  let recordingSamples = 0;
  try {
    const recordingBytes = readRegularFile(recordingPath, 'physical loopback PCM').bytes;
    if (recordingBytes.length % 2 !== 0) throw new Error('physical loopback PCM byte length must be even');
    recordingSamples = recordingBytes.length / 2;
  } catch (error) {
    violations.push(error.message);
  }
  const recordingStart = Number(recordingStartedAtEpochMs);
  if (!Number.isFinite(recordingStart) || recordingStart <= 0) violations.push('physical loopback recording start epoch is invalid');

  const cueById = new Map(translated.cues.map((cue) => [cue.cueId, cue]));
  const references = new Map();
  for (const cueId of requiredCueIds) {
    const cue = cueById.get(cueId);
    if (!cue) {
      violations.push(`complete rendered cue ${cueId} is absent from translated PCM authority`);
      continue;
    }
    try {
      references.set(cueId, selectHighEnergyAnchors(cue));
    } catch (error) {
      violations.push(`cue ${cueId}: ${error.message}`);
    }
  }

  const matches = [];
  const unauditableCues = [];
  const cueContexts = [];
  const diagonalRequests = [];
  let requestSequence = 0;
  for (const cueId of requiredCueIds) {
    const referenceSet = references.get(cueId);
    const startedAtMs = lifecycle.get(cueId)?.started?.occurredAtMs;
    if (!referenceSet || !Number.isFinite(startedAtMs) || recordingSamples === 0 || !Number.isFinite(recordingStart)) continue;
    if (!referenceSet.auditable) {
      unauditableCues.push({ cueId, reason: referenceSet.reason });
      continue;
    }
    const cue = cueById.get(cueId);
    const anchorTasks = referenceSet.anchors.map((anchor, anchorIndex) => (
      anchor.candidates.map((candidate) => {
        const expectedAnchorAtMs = expectedAnchorPlaybackAtMs(cue, candidate, startedAtMs);
        const expectedStart = Math.round(
          (expectedAnchorAtMs - recordingStart) * LOOPBACK_SAMPLE_RATE_HZ / 1_000,
        );
        const requestId = `diagonal-${requestSequence += 1}`;
        diagonalRequests.push({ requestId, ...candidate.reference, expectedStartSamples: expectedStart });
        return { requestId, anchor, anchorIndex, candidate, expectedStart, wrongRequestIds: [] };
      })
    ));
    cueContexts.push({ cueId, cue, referenceSet, anchorTasks });
  }

  let diagonalMetrics = new Map();
  if (diagonalRequests.length > 0) {
    try {
      diagonalMetrics = matchTranslatedLoopbackBatchWithRust({ recordingPath, requests: diagonalRequests });
    } catch (error) {
      violations.push(error.message);
    }
  }
  const wrongRequests = [];
  for (const context of cueContexts) {
    for (const tasks of context.anchorTasks) {
      for (const task of tasks) {
        const diagonal = diagonalMetrics.get(task.requestId);
        if (!diagonal) continue;
        for (const [otherCueId, otherSet] of references.entries()) {
          if (otherCueId === context.cueId || !otherSet.auditable || otherSet.anchors.length === 0) continue;
          const relativeIndex = context.referenceSet.anchors.length === 1
            ? 0
            : task.anchorIndex / (context.referenceSet.anchors.length - 1);
          const wrongAnchor = otherSet.anchors[Math.round(relativeIndex * (otherSet.anchors.length - 1))];
          for (const wrongCandidate of wrongAnchor.candidates) {
            const requestId = `wrong-${requestSequence += 1}`;
            task.wrongRequestIds.push(requestId);
            wrongRequests.push({
              requestId,
              ...wrongCandidate.reference,
              // The diagonal search has already located the physical window.
              // Wrong cues are compared at that exact window rather than
              // independently searching for unrelated audio nearby.
              expectedStartSamples: diagonal.matchedStartSample,
              searchRadiusSamples: 0,
            });
          }
        }
      }
    }
  }
  let wrongMetrics = new Map();
  if (wrongRequests.length > 0) {
    try {
      wrongMetrics = matchTranslatedLoopbackBatchWithRust({ recordingPath, requests: wrongRequests });
    } catch (error) {
      violations.push(error.message);
    }
  }
  const failedMetrics = (reason) => ({ passed: false, score: 0, segmentMatches: [], reason });
  const withThresholdResult = (metrics) => ({
    ...metrics,
    passed: (
      metrics.waveformMedian >= 0.32
      && metrics.waveformMinimum >= 0.20
      && metrics.derivativeMedian >= 0.24
      && metrics.derivativeMinimum >= 0.14
      && Math.abs(metrics.timingErrorSeconds) <= 0.65
    ),
  });
  for (const { cueId, cue, referenceSet, anchorTasks } of cueContexts) {
    const anchorMatches = anchorTasks.map((tasks) => {
      const candidateMatches = tasks.map((task) => {
        const rawDiagonal = diagonalMetrics.get(task.requestId);
        const diagonal = rawDiagonal
          ? withThresholdResult(rawDiagonal)
          : failedMetrics('translated loopback diagonal batch result is missing');
        const strongestWrongAnchorScore = Math.max(
          0,
          ...task.wrongRequestIds.map((requestId) => wrongMetrics.get(requestId)?.score ?? 0),
        );
        const identityMargin = diagonal.score - strongestWrongAnchorScore;
        return {
          anchor: task.anchor.name,
          candidateCount: task.anchor.candidates.length,
          referenceFrameOffset: task.candidate.frameOffset,
          referenceRms: task.candidate.rms,
          expectedPlaybackStartSeconds: rounded(task.expectedStart / LOOPBACK_SAMPLE_RATE_HZ),
          strongestWrongAnchorScore: rounded(strongestWrongAnchorScore),
          identityMargin: rounded(identityMargin),
          ...diagonal,
          passed: diagonal.passed && identityMargin >= 0.08,
        };
      });
      return candidateMatches.sort((left, right) => (
        Number(right.passed) - Number(left.passed)
        || right.score - left.score
        || right.identityMargin - left.identityMargin
        || left.referenceFrameOffset - right.referenceFrameOffset
      ))[0];
    });
    const passingAnchors = anchorMatches.filter((entry) => entry.passed);
    const anchorsOrdered = anchorMatches.every((entry, index) => (
      index === 0 || entry.matchedStartSample >= anchorMatches[index - 1].matchedEndSample
    ));
    const requiredAnchorMatches = referenceSet.anchors.length;
    const passed = passingAnchors.length === requiredAnchorMatches && anchorsOrdered;
    matches.push({
      cueId,
      responseId: cue.responseId ?? null,
      rendererKind: cue.rendererKind ?? null,
      sessionId: cue.sessionId ?? null,
      bridgeInstanceId: cue.bridgeInstanceId ?? null,
      sourceGeneration: Number.isSafeInteger(Number(cue.sourceGeneration))
        ? Number(cue.sourceGeneration) : null,
      sourceGenerationToken: cue.sourceGenerationToken ?? null,
      playbackOwnerGeneration: Number.isSafeInteger(Number(cue.playbackOwnerGeneration))
        ? Number(cue.playbackOwnerGeneration) : null,
      rendererInstanceId: cue.rendererInstanceId ?? null,
      rendererOwnerGeneration: Number.isSafeInteger(Number(cue.rendererOwnerGeneration))
        ? Number(cue.rendererOwnerGeneration) : null,
      renderAttemptId: cue.renderAttemptId ?? null,
      playedFrames: Number.isSafeInteger(Number(cue.playedFrames)) ? Number(cue.playedFrames) : null,
      playedSampleRateHz: Number.isInteger(Number(cue.playedSampleRateHz))
        ? Number(cue.playedSampleRateHz) : null,
      playedChannelCount: Number.isInteger(Number(cue.playedChannelCount))
        ? Number(cue.playedChannelCount) : null,
      physicalPlaybackDeviceId: cue.physicalPlaybackDeviceId ?? null,
      queuedAtMs: lifecycle.get(cueId)?.queued?.occurredAtMs ?? null,
      startedAtMs: lifecycle.get(cueId)?.started?.occurredAtMs ?? null,
      completedAtMs: lifecycle.get(cueId)?.completed?.occurredAtMs ?? null,
      requiredAnchorMatches,
      matchedAnchorCount: passingAnchors.length,
      anchorMatches,
      score: Math.min(...anchorMatches.map((entry) => entry.score)),
      identityMargin: Math.min(...anchorMatches.map((entry) => entry.identityMargin)),
      matchedStartSample: anchorMatches[0]?.matchedStartSample ?? null,
      matchedEndSample: anchorMatches.at(-1)?.matchedEndSample ?? null,
      passed,
    });
    if (!passed) {
      const anchorRequirement = requiredAnchorMatches === 3
        ? 'three ordered high-energy physical anchors'
        : `${requiredAnchorMatches} ordered high-energy physical anchor(s)`;
      violations.push(`translated cue ${cueId} did not correlate ${anchorRequirement}`);
    }
  }
  if (matches.length < MIN_COMPLETE_MATCHED_CUES) {
    violations.push(`translated PCM loopback requires at least ${MIN_COMPLETE_MATCHED_CUES} acoustically auditable complete cues; found ${matches.length}`);
  }
  if (matches.length + unauditableCues.length !== requiredCueIds.length) {
    violations.push('not every complete rendered cue produced a loopback match or explicit unauditable classification');
  }
  const finalRequiredCueId = requiredCueIds.at(-1) ?? null;
  const finalRequiredCueMatch = matches.find((entry) => entry.cueId === finalRequiredCueId);
  if (finalRequiredCueId && !finalRequiredCueMatch?.passed) {
    violations.push(`final complete rendered cue ${finalRequiredCueId} must itself be acoustically auditable and passed`);
  }
  const lifecycleStarts = requiredCueIds.map((cueId) => lifecycle.get(cueId)?.started?.index);
  if (lifecycleStarts.some((value, index) => index > 0 && value <= lifecycleStarts[index - 1])) {
    violations.push('translated PCM playback lifecycles are not in complete-cue order');
  }
  for (let index = 1; index < matches.length; index += 1) {
    const prior = matches[index - 1];
    const current = matches[index];
    if (
      !Number.isFinite(prior.matchedEndSample)
      || !Number.isFinite(current.matchedStartSample)
      || current.matchedStartSample < prior.matchedEndSample
    ) {
      violations.push('translated PCM physical matches overlap or are not one-to-one in complete-cue order');
      break;
    }
  }
  let restartPlaybackEvidence = null;
  if (feedbackLoopPrevention === 'process-exclusion') {
    const restart = processExclusionRestartPlayback(scopedLog);
    const newOwnerGeneration = restart?.newPlaybackOwnerGeneration;
    const endpointId = String(restart?.newPhysicalPlaybackDeviceId ?? '');
    const postRestartMatches = matches.filter((entry) => (
      entry.passed
      && entry.playbackOwnerGeneration === newOwnerGeneration
      && entry.physicalPlaybackDeviceId === endpointId
      && Number.isFinite(restart?.recoveredAtMs)
      && entry.queuedAtMs >= restart.recoveredAtMs
      && entry.startedAtMs >= restart.recoveredAtMs
      && entry.completedAtMs >= restart.recoveredAtMs
    ));
    restartPlaybackEvidence = {
      recoveredAtMs: Number.isFinite(restart?.recoveredAtMs) ? restart.recoveredAtMs : null,
      playbackOwnerGeneration: Number.isSafeInteger(newOwnerGeneration) ? newOwnerGeneration : null,
      physicalPlaybackDeviceId: endpointId || null,
      matchedCueIds: postRestartMatches.map((entry) => entry.cueId),
      passed: (
        restart?.status === 'passed'
        && restart?.physicalPlaybackStatus === 'ready'
        && Number.isSafeInteger(restart?.oldPlaybackOwnerGeneration)
        && Number.isSafeInteger(newOwnerGeneration)
        && newOwnerGeneration > restart.oldPlaybackOwnerGeneration
        && restart.oldPhysicalPlaybackDeviceId !== ''
        && endpointId === restart.oldPhysicalPlaybackDeviceId
        && Number.isFinite(restart.recoveredAtMs)
        && postRestartMatches.length > 0
      ),
    };
    if (!restartPlaybackEvidence.passed) {
      violations.push('process-exclusion loopback lacks a complete post-restart cue on the new playback owner and unchanged physical endpoint');
    }
  }
  return {
    schemaVersion: 2,
    artifactKind: TRANSLATED_PCM_LOOPBACK_KIND,
    authorityMode: 'translated-pcm-loopback-multi-anchor-v2',
    passed: violations.length === 0,
    remoteProviderCalls: 0,
    externalAudioSeconds: 0,
    runMarker,
    cellId,
    leaseId,
    modelId,
    protocol,
    feedbackLoopPrevention,
    sampleRateHz: LOOPBACK_SAMPLE_RATE_HZ,
    recordingStartedAtEpochMs: recordingStart,
    recording: {
      path: 'physical-output-recording-16k-mono.pcm',
      samples: recordingSamples,
      bytes: recordingSamples * 2,
      sha256: recordingSamples > 0 ? sha256File(recordingPath) : null,
    },
    translatedPcmAuthority: translated.artifacts,
    acceptedCueCount: translated.cues.length,
    requiredCompleteCueIds: requiredCueIds,
    requiredCompleteCueCount: requiredCueIds.length,
    finalRequiredCueId,
    matchedCueCount: matches.filter((entry) => entry.passed).length,
    matches,
    unauditableCues,
    restartPlaybackEvidence,
    thresholds: {
      minimumCompleteCueCount: MIN_COMPLETE_MATCHED_CUES,
      waveformMedianCorrelation: 0.32,
      waveformMinimumCorrelation: 0.20,
      derivativeMedianCorrelation: 0.24,
      derivativeMinimumCorrelation: 0.14,
      minimumWrongCueMargin: 0.08,
      maximumAbsoluteTimingErrorSeconds: 0.65,
      searchRadiusSeconds: 1.5,
    },
    violations,
  };
}

if (isMain(import.meta.url)) {
  try {
    const options = parseCliArgs(process.argv.slice(2), {
      defaults: {
        runDirectory: '',
        appLog: '',
        runMarker: '',
        recordingStartedAtMs: '',
        cellId: '',
        leaseId: '',
        modelId: '',
        protocol: '',
        feedbackLoopPrevention: '',
      },
    });
    const authority = buildTranslatedPcmLoopbackAuthority({
      runDirectory: options.runDirectory,
      appLogPath: options.appLog,
      runMarker: options.runMarker,
      recordingStartedAtEpochMs: Number(options.recordingStartedAtMs),
      cellId: options.cellId,
      leaseId: options.leaseId,
      modelId: options.modelId,
      protocol: options.protocol,
      feedbackLoopPrevention: options.feedbackLoopPrevention,
    });
    process.stdout.write(`${JSON.stringify(authority)}\n`);
    if (!authority.passed) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
