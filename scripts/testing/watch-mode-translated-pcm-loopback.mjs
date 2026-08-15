import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isMain, parseCliArgs } from '../lib/testing-common.mjs';

export const TRANSLATED_PCM_AUTHORITY_KIND = 'watch-mode-translated-cue-pcm-authority';
export const TRANSLATED_PCM_LOOPBACK_KIND = 'watch-mode-translated-pcm-loopback-correlation';
export const TRANSLATED_PCM_SUMMARY_FILE = 'translated-cue-pcm-summary.json';
export const TRANSLATED_PCM_JOURNAL_FILE = 'translated-cue-pcm-authority.jsonl';
export const LOOPBACK_SAMPLE_RATE_HZ = 16_000;
export const MIN_COMPLETE_MATCHED_CUES = 2;

const sha256File = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const median = (values) => {
  const ordered = [...values].sort((left, right) => left - right);
  if (ordered.length === 0) return 0;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};
const rounded = (value, digits = 6) => Number(Number(value).toFixed(digits));

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

function pcm16FromBuffer(bytes) {
  if (bytes.length % 2 !== 0) throw new Error('s16le PCM byte length must be even');
  const output = new Float32Array(bytes.length / 2);
  for (let index = 0; index < output.length; index += 1) output[index] = bytes.readInt16LE(index * 2) / 32768;
  return output;
}

function monoFrames(interleaved, channelCount) {
  if (!Number.isInteger(channelCount) || channelCount <= 0 || interleaved.length % channelCount !== 0) {
    throw new Error('translated PCM channelCount/sampleCount is invalid');
  }
  if (channelCount === 1) return interleaved;
  const output = new Float32Array(interleaved.length / channelCount);
  for (let frame = 0; frame < output.length; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channelCount; channel += 1) sum += interleaved[frame * channelCount + channel];
    output[frame] = sum / channelCount;
  }
  return output;
}

export function resampleMonoLinear(samples, sourceRateHz, targetRateHz = LOOPBACK_SAMPLE_RATE_HZ) {
  if (!Number.isInteger(sourceRateHz) || sourceRateHz <= 0 || !Number.isInteger(targetRateHz) || targetRateHz <= 0) {
    throw new Error('PCM sample rates must be positive integers');
  }
  if (sourceRateHz === targetRateHz) return samples;
  const outputLength = Math.max(1, Math.floor(samples.length * targetRateHz / sourceRateHz));
  const output = new Float32Array(outputLength);
  const ratio = sourceRateHz / targetRateHz;
  for (let index = 0; index < output.length; index += 1) {
    const source = index * ratio;
    const left = Math.min(samples.length - 1, Math.floor(source));
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = source - left;
    output[index] = samples[left] + (samples[right] - samples[left]) * fraction;
  }
  return output;
}

// Mirror Bridge `normalize_track` (nearest-neighbour to 48 kHz) followed by
// omni-physical-output-probe's linear 48 kHz -> 16 kHz recorder conversion.
export function renderBridgeReferenceToLoopback(samples, sourceRateHz) {
  if (!Number.isInteger(sourceRateHz) || sourceRateHz <= 0) throw new Error('PCM source rate must be positive');
  const bridgeRateHz = 48_000;
  const bridgeLength = Math.max(1, Math.floor(samples.length * bridgeRateHz / sourceRateHz));
  const bridge = new Float32Array(bridgeLength);
  for (let index = 0; index < bridge.length; index += 1) {
    const sourceIndex = Math.min(samples.length - 1, Math.floor(index * sourceRateHz / bridgeRateHz));
    bridge[index] = samples[sourceIndex];
  }
  return resampleMonoLinear(bridge, bridgeRateHz, LOOPBACK_SAMPLE_RATE_HZ);
}

function pearsonAt(reference, recording, recordingStart, referenceStart, length, stride, difference) {
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;
  let count = 0;
  const begin = difference ? Math.max(1, stride) : 0;
  for (let offset = begin; offset < length; offset += stride) {
    const referenceIndex = referenceStart + offset;
    const recordingIndex = recordingStart + offset;
    if (referenceIndex >= reference.length || recordingIndex >= recording.length || recordingIndex < 0) break;
    const x = difference
      ? reference[referenceIndex] - reference[referenceIndex - 1]
      : reference[referenceIndex];
    const y = difference
      ? recording[recordingIndex] - recording[recordingIndex - 1]
      : recording[recordingIndex];
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumYY += y * y;
    sumXY += x * y;
    count += 1;
  }
  if (count < 80) return 0;
  const covariance = sumXY - sumX * sumY / count;
  const varianceX = sumXX - sumX * sumX / count;
  const varianceY = sumYY - sumY * sumY / count;
  if (varianceX <= 1e-10 || varianceY <= 1e-10) return 0;
  return covariance / Math.sqrt(varianceX * varianceY);
}

function correlationAt(reference, recording, recordingStart, referenceStart, length) {
  const stride = Math.max(1, Math.floor(length / 12_000));
  return {
    waveform: pearsonAt(reference, recording, recordingStart, referenceStart, length, stride, false),
    derivative: pearsonAt(reference, recording, recordingStart, referenceStart, length, stride, true),
  };
}

function segmentStarts(sampleCount, segmentLength) {
  const maximum = Math.max(0, sampleCount - segmentLength);
  return [...new Set([0.08, 0.5, 0.9].map((fraction) => Math.round(maximum * fraction)))];
}

function matchReferenceAtExpectedStart(reference, recording, expectedStart) {
  const segmentLength = Math.min(reference.length, Math.round(0.7 * LOOPBACK_SAMPLE_RATE_HZ));
  if (segmentLength < Math.floor(0.4 * LOOPBACK_SAMPLE_RATE_HZ)) {
    return { passed: false, score: 0, segmentMatches: [], reason: 'translated cue is shorter than 400 ms' };
  }
  const starts = segmentStarts(reference.length, segmentLength);
  const evaluateLag = (lagSamples) => {
    const raw = [];
    for (const referenceStart of starts) {
      const recordingStart = expectedStart + lagSamples + referenceStart;
      if (recordingStart < 0 || recordingStart + segmentLength > recording.length) return null;
      raw.push({
        referenceStart,
        recordingStart,
        ...correlationAt(reference, recording, recordingStart, referenceStart, segmentLength),
      });
    }
    // One polarity is selected for the whole cue. Per-segment or per-feature
    // absolute values would let a shared tone mask a missing hashed waveform.
    const signedStrength = median(raw.map((entry) => entry.waveform))
      + median(raw.map((entry) => entry.derivative));
    const polarity = signedStrength < 0 ? -1 : 1;
    const segments = raw.map((entry) => ({
      ...entry,
      waveform: entry.waveform * polarity,
      derivative: entry.derivative * polarity,
    }));
    const waveformMedian = median(segments.map((entry) => entry.waveform));
    const derivativeMedian = median(segments.map((entry) => entry.derivative));
    return {
      lagSamples,
      polarity,
      waveformMedian,
      derivativeMedian,
      waveformMinimum: Math.min(...segments.map((entry) => entry.waveform)),
      derivativeMinimum: Math.min(...segments.map((entry) => entry.derivative)),
      score: Math.min(waveformMedian, derivativeMedian),
      segments,
    };
  };
  let best = null;
  const consider = (lagSamples) => {
    const candidate = evaluateLag(lagSamples);
    if (candidate && (!best || candidate.score > best.score)) best = candidate;
  };
  const radius = Math.round(1.5 * LOOPBACK_SAMPLE_RATE_HZ);
  const coarseStep = Math.round(0.01 * LOOPBACK_SAMPLE_RATE_HZ);
  for (let lag = -radius; lag <= radius; lag += coarseStep) consider(lag);
  if (!best) return { passed: false, score: 0, segmentMatches: [], reason: 'no complete physical search window' };
  const coarseLag = best.lagSamples;
  const fineRadius = Math.round(0.012 * LOOPBACK_SAMPLE_RATE_HZ);
  const fineStep = Math.max(1, Math.round(0.001 * LOOPBACK_SAMPLE_RATE_HZ));
  for (let lag = coarseLag - fineRadius; lag <= coarseLag + fineRadius; lag += fineStep) consider(lag);
  const timingErrorSeconds = best.lagSamples / LOOPBACK_SAMPLE_RATE_HZ;
  const matches = best.segments.map((entry) => ({
    referenceOffsetSeconds: rounded(entry.referenceStart / LOOPBACK_SAMPLE_RATE_HZ),
    recordingOffsetSeconds: rounded(entry.recordingStart / LOOPBACK_SAMPLE_RATE_HZ),
    timingErrorSeconds: rounded(timingErrorSeconds),
    waveformCorrelation: rounded(entry.waveform),
    derivativeCorrelation: rounded(entry.derivative),
  }));
  const passed = (
    best.waveformMedian >= 0.32
    && best.waveformMinimum >= 0.20
    && best.derivativeMedian >= 0.24
    && best.derivativeMinimum >= 0.14
    && Math.abs(timingErrorSeconds) <= 0.65
  );
  return {
    passed,
    score: rounded(best.score),
    waveformMedian: rounded(best.waveformMedian),
    waveformMinimum: rounded(best.waveformMinimum),
    derivativeMedian: rounded(best.derivativeMedian),
    derivativeMinimum: rounded(best.derivativeMinimum),
    polarity: best.polarity,
    globalLagSamples: best.lagSamples,
    timingErrorSeconds: rounded(timingErrorSeconds),
    matchedStartSample: expectedStart + best.lagSamples,
    matchedEndSample: expectedStart + best.lagSamples + reference.length,
    segmentMatches: matches,
  };
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
    if (!Number.isInteger(sampleRateHz) || sampleRateHz < 8_000 || sampleRateHz > 48_000) violations.push(`translated PCM cue ${cue.cueId} sample rate is invalid`);
    if (!Number.isInteger(channelCount) || channelCount <= 0 || channelCount > 2) violations.push(`translated PCM cue ${cue.cueId} channel count is invalid`);
    if (!Number.isInteger(sampleCount) || sampleCount <= 0 || bytes !== sampleCount * 2) violations.push(`translated PCM cue ${cue.cueId} sample/byte count mismatch`);
    if (frameCount !== sampleCount / channelCount || Number(cue.acceptedFrames) !== frameCount) violations.push(`translated PCM cue ${cue.cueId} frame/ACK count mismatch`);
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
  let recording = new Float32Array();
  try {
    recording = pcm16FromBuffer(readRegularFile(recordingPath, 'physical loopback PCM').bytes);
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
      const mono = monoFrames(pcm16FromBuffer(cue.pcmBytes), Number(cue.channelCount));
      references.set(cueId, renderBridgeReferenceToLoopback(mono, Number(cue.sampleRateHz)));
    } catch (error) {
      violations.push(`cue ${cueId}: ${error.message}`);
    }
  }

  const matches = [];
  for (const cueId of requiredCueIds) {
    const reference = references.get(cueId);
    const startedAtMs = lifecycle.get(cueId)?.started?.occurredAtMs;
    if (!reference || !Number.isFinite(startedAtMs) || recording.length === 0 || !Number.isFinite(recordingStart)) continue;
    const expectedStart = Math.round((startedAtMs - recordingStart) * LOOPBACK_SAMPLE_RATE_HZ / 1000);
    const diagonal = matchReferenceAtExpectedStart(reference, recording, expectedStart);
    let strongestWrongCueScore = 0;
    for (const [otherCueId, otherReference] of references.entries()) {
      if (otherCueId === cueId) continue;
      strongestWrongCueScore = Math.max(
        strongestWrongCueScore,
        matchReferenceAtExpectedStart(otherReference, recording, expectedStart).score,
      );
    }
    const identityMargin = diagonal.score - strongestWrongCueScore;
    const passed = diagonal.passed && identityMargin >= 0.08;
    matches.push({
      cueId,
      expectedPlaybackStartSeconds: rounded(expectedStart / LOOPBACK_SAMPLE_RATE_HZ),
      score: diagonal.score,
      waveformMedian: diagonal.waveformMedian,
      waveformMinimum: diagonal.waveformMinimum,
      derivativeMedian: diagonal.derivativeMedian,
      derivativeMinimum: diagonal.derivativeMinimum,
      polarity: diagonal.polarity,
      globalLagSamples: diagonal.globalLagSamples,
      timingErrorSeconds: diagonal.timingErrorSeconds,
      matchedStartSample: diagonal.matchedStartSample,
      matchedEndSample: diagonal.matchedEndSample,
      strongestWrongCueScore: rounded(strongestWrongCueScore),
      identityMargin: rounded(identityMargin),
      segmentMatches: diagonal.segmentMatches,
      passed,
    });
    if (!passed) violations.push(`translated cue ${cueId} did not uniquely correlate with its physical loopback window`);
  }
  if (matches.length !== requiredCueIds.length) violations.push('not every complete rendered cue produced a loopback match result');
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
  return {
    schemaVersion: 1,
    artifactKind: TRANSLATED_PCM_LOOPBACK_KIND,
    authorityMode: 'translated-pcm-loopback-correlation-v1',
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
      samples: recording.length,
      bytes: recording.length * 2,
      sha256: recording.length > 0 ? sha256File(recordingPath) : null,
    },
    translatedPcmAuthority: translated.artifacts,
    acceptedCueCount: translated.cues.length,
    requiredCompleteCueIds: requiredCueIds,
    requiredCompleteCueCount: requiredCueIds.length,
    matchedCueCount: matches.filter((entry) => entry.passed).length,
    matches,
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
