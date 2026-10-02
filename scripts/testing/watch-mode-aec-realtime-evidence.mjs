import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

export const AEC_REALTIME_PROFILE = 'aec-physical-realtime/v2';
export const AEC_REALTIME_THRESHOLDS = Object.freeze({ firstAudibleInputToAcousticSeconds: 8,
  firstPlayableDeltaToAcousticSeconds: 1.5, startupBufferMs: 800, maximumStartupWaitMs: 1000,
  inputRmsFloor: 0.0001 });
const check = (condition, message) => { if (!condition) throw new Error(message); };
const timestamp = (value) => Number.isSafeInteger(value) && value > 0;
const normalize = (text) => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function firstAudibleAppend(journal, pcm, identity) {
  check(Buffer.isBuffer(pcm) && pcm.length > 0 && pcm.length % 2 === 0, 'actual Provider PCM missing or truncated');
  let offset = 0; let first = null;
  for (const row of journal) {
    for (const field of ['runMarker', 'cellId', 'leaseId']) check(row[field] === identity[field], `Provider append ${field} mismatch`);
    if (row.event !== 'append_attempt') continue;
    check(timestamp(row.occurredAtMs) && Number.isSafeInteger(row.attemptedSamples) && row.attemptedSamples > 0,
      'Provider append lacks raw time/sample count');
    const end = offset + row.attemptedSamples;
    check(end * 2 <= pcm.length, 'Provider append PCM range truncated');
    for (let start = offset; start < end && first === null; start += 160) {
      const to = Math.min(end, start + 160); let energy = 0;
      for (let i = start; i < to; i += 1) energy += (pcm.readInt16LE(i * 2) / 32768) ** 2;
      if (Math.sqrt(energy / (to - start)) >= AEC_REALTIME_THRESHOLDS.inputRmsFloor) first = row.occurredAtMs;
    }
    offset = end;
  }
  check(offset * 2 === pcm.length && first !== null, 'Provider input has missing mapping or no audible input');
  return first;
}
export function aecFeedbackCueViolations(watchReport) {
  const cues = (watchReport?.cues ?? []).filter(c => c.comparisonStatus !== 'superseded');
  const translated = cues.map(c => normalize(c.renderedText ?? c.publishedText ?? c.llmText)).filter(Boolean);
  const violations = []; const seen = new Map();
  for (const cue of cues) {
    const source = normalize(cue.sourceText);
    const chinese = source.match(/\p{Script=Han}/gu) ?? [];
    if (chinese.length >= 8 && translated.some(t => t.includes(source) || source.includes(t) && t.length >= 8)) {
      violations.push(`self-translation reappeared as source cue ${cue.cueId}`);
    }
    if (source.length >= 80) {
      const prior = seen.get(source);
      if (prior && prior !== cue.cueId) violations.push(`duplicate response chain for source cues ${prior}/${cue.cueId}`);
      seen.set(source, cue.cueId);
    }
  }
  return violations;
}

/** Caller supplies only raw custody inputs and an independently rebuilt acoustic matcher. */
export function evaluateAecRealtimeEvidence({ identity, media, loopback, timelines, providerJournal, providerPcm, watchReport }) {
  const result = { profile: AEC_REALTIME_PROFILE, passed: false, thresholds: AEC_REALTIME_THRESHOLDS, violations: [], cues: [] };
  try {
    check(identity && ['runMarker', 'cellId', 'leaseId'].every(k => typeof identity[k] === 'string' && identity[k]), 'missing signed AEC identity');
    check(media?.schemaVersion === 2 && media.artifactKind === 'watch-mode-media-complete', 'old/missing media completion authority');
    for (const k of ['runMarker', 'cellId', 'leaseId']) check(media[k] === identity[k] && loopback?.[k] === identity[k], `media/acoustic ${k} mismatch`);
    check(loopback.passed === true && timestamp(loopback.recordingStartedAtEpochMs), 'physical recording did not prove translated speech');
    check((loopback.unauditableCues ?? []).length === 0, 'complete AEC cues cannot be skipped as unauditable');
    const required = loopback.requiredCompleteCueIds;
    check(Array.isArray(required) && required.length > 0 && new Set(required).size === required.length, 'complete translated cue inventory missing/duplicate');
    const firstInput = firstAudibleAppend(providerJournal, providerPcm, identity);
    check(timestamp(media.mediaPlaybackStartedAtUnixMs) && timestamp(media.mediaPlaybackCompletedAtUnixMs), 'media timestamps missing');
    const committed = new Map();
    for (const row of timelines) {
      check(row.schemaVersion === 1 && row.artifactKind === 'aec-desktop-playback-timeline', 'typed playback timeline version mismatch');
      for (const k of ['runMarker', 'cellId', 'leaseId']) check(row[k] === identity[k], `playback timeline ${k} mismatch`);
      if (row.milestone === 'renderer-ack') {
        const t = row.timeline; check(t && !committed.has(t.cueId), 'duplicate/missing playback receipt'); committed.set(t.cueId, t);
      }
    }
    check(committed.size === required.length, 'typed playback receipts do not cover every complete cue');
    let firstAcoustic = Infinity;
    for (const cueId of required) {
      const timeline = committed.get(cueId);
      const match = loopback.matches?.find(m => m.cueId === cueId);
      check(timeline && match?.passed === true, `cue ${cueId} is not physically complete`);
      check(timeline.aborted === false && timeline.streamStartCount === 1 && timeline.continuousStreamId
        && timeline.rendererAckReceiptId === match.renderAttemptId && timeline.responseId === match.responseId
        && timeline.rendererInstanceId === match.rendererInstanceId
        && timeline.rendererOwnerGeneration === match.rendererOwnerGeneration
        && timeline.physicalPlaybackDeviceId === match.physicalPlaybackDeviceId,
      `cue ${cueId} render identity/continuous stream/receipt mismatch`);
      check(timestamp(timeline.firstAudioDeltaAtMs) && timestamp(timeline.audioDoneAtMs)
        && timestamp(timeline.renderCompleteAtMs) && timestamp(timeline.rendererAckAtMs)
        && timeline.rendererAckAtMs >= timeline.renderCompleteAtMs, `cue ${cueId} missing raw output/ACK timestamps`);
      const head = match.anchorMatches?.find(a => a.anchor === 'head');
      const tail = match.anchorMatches?.find(a => a.anchor === 'tail');
      check(head?.passed === true && tail?.passed === true && head.captureAuthorityPassed !== false
        && tail.captureAuthorityPassed !== false && Number.isSafeInteger(head.matchedStartSample) && head.matchedStartSample >= 0
        && Number.isSafeInteger(tail.matchedEndSample) && tail.matchedEndSample > head.matchedStartSample,
      `cue ${cueId} lacks acoustic head/tail completeness`);
      const acoustic = loopback.recordingStartedAtEpochMs + head.matchedStartSample / 16;
      const completedAcoustic = loopback.recordingStartedAtEpochMs + tail.matchedEndSample / 16;
      check(acoustic >= timeline.firstAudioDeltaAtMs, `cue ${cueId} acoustic output precedes model delta`);
      check(timeline.sourceSampleRateHz > 0 && timeline.acceptedSourceFrames > 0, `cue ${cueId} source duration missing`);
      const longResponse = timeline.acceptedSourceFrames / timeline.sourceSampleRateHz >= 0.8;
      check(!longResponse || acoustic < timeline.audioDoneAtMs, `cue ${cueId} long response waited for audio.done`);
      check(tail.matchedEndSample <= loopback.recording.samples, `cue ${cueId} final translated tail was not recorded`);
      // Check every complete cue against its independently matched acoustic head,
      // not enqueue/render-start claims or just the earliest cue in the run.
      const firstPlayableDeltaToAcousticSeconds = (acoustic - timeline.firstAudioDeltaAtMs) / 1000;
      check(Number.isFinite(firstPlayableDeltaToAcousticSeconds) && firstPlayableDeltaToAcousticSeconds >= 0
        && firstPlayableDeltaToAcousticSeconds <= AEC_REALTIME_THRESHOLDS.firstPlayableDeltaToAcousticSeconds,
        `cue ${cueId} first playable model delta to physical Chinese output exceeded 1.5 seconds`);
      result.cues.push({cueId, firstAcousticAtUnixMs: acoustic, lastAcousticAtUnixMs: completedAcoustic,
        firstPlayableDeltaAtUnixMs: timeline.firstAudioDeltaAtMs, firstPlayableDeltaToAcousticSeconds,
        audioDoneAtUnixMs: timeline.audioDoneAtMs, longResponse});
      firstAcoustic = Math.min(firstAcoustic, acoustic);
    }
    const firstCue = result.cues.find(c => c.firstAcousticAtUnixMs === firstAcoustic);
    check(firstAcoustic >= media.mediaPlaybackStartedAtUnixMs && firstAcoustic < media.mediaPlaybackCompletedAtUnixMs,
      'first actual Chinese acoustic output did not occur during English playback');
    result.firstAudibleInputAtUnixMs = firstInput; result.firstAcousticOutputAtUnixMs = firstAcoustic;
    result.firstAudibleInputToAcousticSeconds = (firstAcoustic - firstInput) / 1000;
    result.firstPlayableDeltaToAcousticSeconds = (firstAcoustic - firstCue.firstPlayableDeltaAtUnixMs) / 1000;
    check(result.firstAudibleInputToAcousticSeconds >= 0 && result.firstAudibleInputToAcousticSeconds <= 8,
      'first audible input to physical Chinese output exceeded 8 seconds');
    check(result.firstPlayableDeltaToAcousticSeconds <= 1.5,
      'first playable model delta to physical Chinese output exceeded 1.5 seconds');
    result.violations.push(...aecFeedbackCueViolations(watchReport));
    result.passed = result.violations.length === 0;
  } catch (error) { result.violations.push(error.message); }
  return result;
}
function readRegular(directory, name) {
  const file = path.join(directory, name); const stat = fs.lstatSync(file);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, `missing/nonregular raw ${name}`);
  return fs.readFileSync(file);
}
export function verifyAecRealtimeEvidence(runDirectory, { loopback, identity } = {}) {
  try {
    const json = name => JSON.parse(readRegular(runDirectory, name).toString('utf8').replace(/^\uFEFF/u, ''));
    const rows = name => { const text = readRegular(runDirectory, name).toString('utf8'); check(text.endsWith('\n'), `truncated ${name}`); return text.trim().split('\n').map(l => JSON.parse(l)); };
    const timelineBytes = readRegular(runDirectory, 'aec-desktop-playback-timeline.jsonl');
    const seal = json('aec-desktop-playback-timeline-terminal.json');
    const timelineRows = rows('aec-desktop-playback-timeline.jsonl');
    check(seal.schemaVersion === 1 && seal.artifactKind === 'aec-desktop-playback-timeline-terminal'
      && seal.complete === true && seal.countsFinal === true && seal.error == null, 'typed playback timeline not successfully sealed');
    for (const field of ['runMarker','cellId','leaseId']) check(seal[field] === identity[field], 'timeline seal identity mismatch');
    check(seal.timeline?.file === 'aec-desktop-playback-timeline.jsonl' && seal.timeline.bytes === timelineBytes.length
      && seal.timeline.rows === timelineRows.length && seal.timeline.sha256 === crypto.createHash('sha256').update(timelineBytes).digest('hex')
      && timelineRows.every((r,i) => r.sequence === i+1), 'typed playback timeline count/hash/sequence mismatch');
    return evaluateAecRealtimeEvidence({identity, loopback, media: json('media-complete.json'),
      timelines: timelineRows, providerJournal: rows('provider-input-budget-ledger.json.journal.jsonl'),
      providerPcm: readRegular(runDirectory,'provider-input-16k-mono.pcm'), watchReport: json('watch-session-report.json')});
  } catch (error) { return {profile:AEC_REALTIME_PROFILE,passed:false,thresholds:AEC_REALTIME_THRESHOLDS,violations:[error.message],cues:[]}; }
}
