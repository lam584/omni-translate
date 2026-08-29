import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isMain, parseCliArgs } from '../lib/testing-common.mjs';
import { matchTranslatedLoopbackWithRust } from './watch-mode-rust-audio-analysis.mjs';

export const TRANSLATED_PCM_AUTHORITY_KIND = 'watch-mode-translated-cue-pcm-authority';
export const TRANSLATED_PCM_LOOPBACK_KIND = 'watch-mode-translated-pcm-loopback-correlation';
export const TRANSLATED_PCM_SUMMARY_FILE = 'translated-cue-pcm-summary.json';
export const TRANSLATED_PCM_JOURNAL_FILE = 'translated-cue-pcm-authority.jsonl';
export const LOOPBACK_SAMPLE_RATE_HZ = 16_000;
export const MIN_COMPLETE_MATCHED_CUES = 2;

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
    const windowFrames = Math.min(
      Math.floor(sampleRateHz * 0.75),
      Math.max(minimumFrames, Math.floor(regionFrames * 0.8)),
    );
    if (regionFrames < minimumFrames || windowFrames > regionFrames) {
      return { anchors: [], auditable: false, reason: 'cue cannot provide the required independent 400ms acoustic windows' };
    }
    const strideFrames = Math.max(1, Math.floor(sampleRateHz * 0.05));
    let best = null;
    for (
      let frameOffset = regionStart;
      frameOffset + windowFrames <= regionEnd;
      frameOffset += strideFrames
    ) {
      const sampleOffset = frameOffset * channelCount;
      const sampleCount = windowFrames * channelCount;
      const rms = pcmWindowRms(cue.pcmBytes, sampleOffset, sampleCount);
      if (!best || rms > best.rms) best = { frameOffset, sampleOffset, sampleCount, rms };
    }
    if (!best || best.rms < 0.003) {
      return { anchors: [], auditable: false, reason: `cue ${anchorNames[regionIndex]} acoustic window is silent` };
    }
    anchors.push({
      name: anchorNames[regionIndex],
      frameOffset: best.frameOffset,
      rms: rounded(best.rms),
      reference: {
        referencePath: cue.pcmPath,
        referenceSampleRateHz: sampleRateHz,
        referenceChannels: channelCount,
        referenceOffsetSamples: best.sampleOffset,
        referenceSampleCount: best.sampleCount,
      },
    });
  }
  return { anchors, auditable: true, reason: null };
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

function validateTranslatedAuthority({ authorityDirectory, expectedIdentity }) {
  const summaryPath = path.join(authorityDirectory, TRANSLATED_PCM_SUMMARY_FILE);
  const journalPath = path.join(authorityDirectory, TRANSLATED_PCM_JOURNAL_FILE);
  const summary = readJson(summaryPath, 'translated PCM summary');
  const violations = [];
  const identity = {
    schemaVersion: 1,
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
    if (!String(cue.bridgeInstanceId ?? '').trim()) violations.push(`translated PCM cue ${cue.cueId} bridge instance is missing`);
    if (!Number.isSafeInteger(Number(cue.playbackOwnerGeneration)) || Number(cue.playbackOwnerGeneration) <= 0) {
      violations.push(`translated PCM cue ${cue.cueId} playback owner generation is invalid`);
    }
    if (!String(cue.physicalPlaybackDeviceId ?? '').trim()) violations.push(`translated PCM cue ${cue.cueId} physical endpoint is missing`);
    if (!Number.isInteger(sampleRateHz) || sampleRateHz < 8_000 || sampleRateHz > 48_000) violations.push(`translated PCM cue ${cue.cueId} sample rate is invalid`);
    if (!Number.isInteger(channelCount) || channelCount <= 0 || channelCount > 2) violations.push(`translated PCM cue ${cue.cueId} channel count is invalid`);
    if (!Number.isInteger(sampleCount) || sampleCount <= 0 || bytes !== sampleCount * 2) violations.push(`translated PCM cue ${cue.cueId} sample/byte count mismatch`);
    if (frameCount !== sampleCount / channelCount || Number(cue.acceptedFrames) !== frameCount) violations.push(`translated PCM cue ${cue.cueId} frame/ACK count mismatch`);
    const chunks = Array.isArray(cue.chunks) ? cue.chunks : [];
    if (chunks.length !== Number(cue.chunkCount) || chunks.length === 0) {
      violations.push(`translated PCM cue ${cue.cueId} chunk metadata is missing or inconsistent`);
    }
    let nextSampleOffset = 0;
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
      ) violations.push(`translated PCM cue ${cue.cueId} chunk ${chunkPosition} metadata is invalid`);
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
  for (const [index, event] of journal.entries()) {
    if (Number(event.sequence) !== index + 1) violations.push(`translated PCM journal sequence mismatch at ${index + 1}`);
    for (const [key, expected] of Object.entries(identity)) {
      if (expected !== undefined && event?.[key] !== expected) violations.push(`translated PCM journal ${key} mismatch at ${index + 1}`);
    }
  }
  if (journal[0]?.event !== 'initialized' || journal.at(-1)?.event !== 'finalized') violations.push('translated PCM journal must run initialized to finalized');
  if (journal.some((event) => event.event === 'stream_aborted')) violations.push('translated PCM journal contains stream_aborted');
  if (journal.filter((event) => event.event === 'bridge_write_accepted').length !== cues.length) violations.push('translated PCM journal accepted count mismatch');
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
}) {
  const violations = [];
  const resolvedRunDirectory = path.resolve(runDirectory);
  const authorityDirectory = path.join(resolvedRunDirectory, 'translated-cue-pcm');
  let translated;
  try {
    translated = validateTranslatedAuthority({
      authorityDirectory,
      expectedIdentity: { cellId, leaseId, runMarker, model: modelId, protocol },
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
  try {
    const log = readRegularFile(appLogPath, 'run app.log').bytes.toString('utf8');
    // The run marker is intentionally repeated by later diagnostic events.
    // Scope from its first occurrence in this per-run app.log so playback
    // lifecycle events are not discarded when the report-save event repeats it.
    const markerIndex = log.indexOf(runMarker);
    if (markerIndex < 0) throw new Error('run marker is absent from app.log');
    const parsedLifecycle = playbackLifecycle(log.slice(markerIndex), requiredCueIds);
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

  const matchReference = (reference, expectedStartSamples) => {
    try {
      const metrics = matchTranslatedLoopbackWithRust({
        ...reference,
        recordingPath,
        expectedStartSamples,
      });
      return {
        ...metrics,
        passed: (
          metrics.waveformMedian >= 0.32
          && metrics.waveformMinimum >= 0.20
          && metrics.derivativeMedian >= 0.24
          && metrics.derivativeMinimum >= 0.14
          && Math.abs(metrics.timingErrorSeconds) <= 0.65
        ),
      };
    } catch (error) {
      return { passed: false, score: 0, segmentMatches: [], reason: error.message };
    }
  };

  const matches = [];
  const unauditableCues = [];
  for (const cueId of requiredCueIds) {
    const referenceSet = references.get(cueId);
    const startedAtMs = lifecycle.get(cueId)?.started?.occurredAtMs;
    if (!referenceSet || !Number.isFinite(startedAtMs) || recordingSamples === 0 || !Number.isFinite(recordingStart)) continue;
    if (!referenceSet.auditable) {
      unauditableCues.push({ cueId, reason: referenceSet.reason });
      continue;
    }
    const cue = cueById.get(cueId);
    const anchorMatches = referenceSet.anchors.map((anchor, anchorIndex) => {
      const expectedStart = Math.round(
        (startedAtMs - recordingStart) * LOOPBACK_SAMPLE_RATE_HZ / 1000
        + anchor.frameOffset * LOOPBACK_SAMPLE_RATE_HZ / Number(cue.sampleRateHz),
      );
      const diagonal = matchReference(anchor.reference, expectedStart);
      let strongestWrongAnchorScore = 0;
      for (const [otherCueId, otherSet] of references.entries()) {
        if (otherCueId === cueId || !otherSet.auditable || otherSet.anchors.length === 0) continue;
        const relativeIndex = referenceSet.anchors.length === 1
          ? 0
          : anchorIndex / (referenceSet.anchors.length - 1);
        const wrongAnchor = otherSet.anchors[Math.round(relativeIndex * (otherSet.anchors.length - 1))];
        strongestWrongAnchorScore = Math.max(
          strongestWrongAnchorScore,
          matchReference(wrongAnchor.reference, expectedStart).score,
        );
      }
      const identityMargin = diagonal.score - strongestWrongAnchorScore;
      return {
        anchor: anchor.name,
        referenceFrameOffset: anchor.frameOffset,
        referenceRms: anchor.rms,
        expectedPlaybackStartSeconds: rounded(expectedStart / LOOPBACK_SAMPLE_RATE_HZ),
        strongestWrongAnchorScore: rounded(strongestWrongAnchorScore),
        identityMargin: rounded(identityMargin),
        ...diagonal,
        passed: diagonal.passed && identityMargin >= 0.08,
      };
    });
    const passingAnchors = anchorMatches.filter((entry) => entry.passed);
    const anchorsOrdered = anchorMatches.every((entry, index) => (
      index === 0 || entry.matchedStartSample >= anchorMatches[index - 1].matchedEndSample
    ));
    const requiredAnchorMatches = referenceSet.anchors.length;
    const passed = passingAnchors.length === requiredAnchorMatches && anchorsOrdered;
    matches.push({
      cueId,
      bridgeInstanceId: cue.bridgeInstanceId ?? null,
      playbackOwnerGeneration: Number(cue.playbackOwnerGeneration),
      physicalPlaybackDeviceId: cue.physicalPlaybackDeviceId ?? null,
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
  if (String(cellId).includes('process-exclusion')) {
    const generations = matches
      .map((entry) => entry.playbackOwnerGeneration)
      .filter(Number.isSafeInteger);
    const newOwnerGeneration = Math.max(...generations);
    const endpointIds = [...new Set(matches.map((entry) => entry.physicalPlaybackDeviceId).filter(Boolean))];
    const endpointId = String(endpointIds[0] ?? '');
    const postRestartMatches = matches.filter((entry) => (
      entry.passed
      && entry.playbackOwnerGeneration === newOwnerGeneration
      && entry.physicalPlaybackDeviceId === endpointId
    ));
    restartPlaybackEvidence = {
      recoveredAtMs: null,
      playbackOwnerGeneration: Number.isFinite(newOwnerGeneration) ? newOwnerGeneration : null,
      physicalPlaybackDeviceId: endpointId || null,
      matchedCueIds: postRestartMatches.map((entry) => entry.cueId),
      passed: (
        new Set(generations).size >= 2
        && newOwnerGeneration > Math.min(...generations)
        && endpointIds.length === 1
        && postRestartMatches.length > 0
      ),
    };
    if (!restartPlaybackEvidence.passed) {
      violations.push('process-exclusion loopback lacks a complete post-restart cue on the new playback owner and unchanged physical endpoint');
    }
  }
  return {
    schemaVersion: 1,
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
    });
    process.stdout.write(`${JSON.stringify(authority)}\n`);
    if (!authority.passed) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
