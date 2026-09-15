import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const AEC_TAP_FILES = Object.freeze({
  render: 'aec-render-reference-48k-stereo.f32le',
  pre: 'aec-pre-capture-48k-stereo.f32le',
  post: 'aec-post-output-48k-stereo.f32le',
  metadata: 'aec-frame-metadata.jsonl',
});
const TERMINAL = 'aec-terminal.json';
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_PCM_BYTES = 48_000 * 2 * 4 * 300;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const requireEvidence = (condition, detail) => {
  if (!condition) throw new Error(`AEC tap evidence invalid: ${detail}`);
};

function evidencePath(root, name) {
  const candidate = path.join(root, name);
  const stat = fs.lstatSync(candidate);
  requireEvidence(stat.isFile() && !stat.isSymbolicLink()
    && fs.realpathSync.native(candidate) === candidate, `not a regular local file: ${name}`);
  return { candidate, stat };
}

function hashFile(file, expectedSize) {
  const digest = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  let bytes = 0;
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      bytes += read;
      requireEvidence(bytes <= expectedSize, 'file grew during verification');
      digest.update(buffer.subarray(0, read));
    }
  } finally { fs.closeSync(fd); }
  requireEvidence(bytes === expectedSize, 'file shrank during verification');
  return digest.digest('hex');
}

function readUtf8(file, limit) {
  requireEvidence(fs.statSync(file).size <= limit, 'text exceeds bounded evidence size');
  return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
}

/** Evidence completeness only. Invalid clocks, resets and poor audio remain
 * diagnostic findings; a complete capture never authorizes c03/release success. */
export function verifyAecTapEvidence(outputDirectory, embeddedTerminal) {
  const root = fs.realpathSync.native(outputDirectory);
  const terminalPath = evidencePath(root, TERMINAL).candidate;
  requireEvidence(!fs.existsSync(path.join(root, `${TERMINAL}.partial`)), 'uncommitted terminal exists');
  const terminal = JSON.parse(readUtf8(terminalPath, 512 * 1024));
  requireEvidence(isDeepStrictEqual(terminal, embeddedTerminal), 'terminal differs from probe receipt');
  requireEvidence(terminal.schemaVersion === 2 && terminal.kind === 'terminal'
    && terminal.status === 'complete' && terminal.complete === true && terminal.countsFinal === true
    && terminal.hashAlgorithm === 'sha256' && terminal.terminalFile === TERMINAL,
  'terminal is not a sealed schema-v2 completion');
  requireEvidence(Array.isArray(terminal.errors) && terminal.errors.length === 0
    && terminal.droppedEvents === 0, 'writer errors or dropped events');
  requireEvidence(integer(terminal.writtenEvents) && terminal.writtenEvents > 0
    && terminal.attemptedEvents === terminal.writtenEvents
    && terminal.acceptedEvents === terminal.writtenEvents, 'event accounting');
  requireEvidence(terminal.files && Object.keys(terminal.files).sort().join(',') === 'metadata,post,pre,render', 'file inventory');
  for (const [lane, name] of Object.entries(AEC_TAP_FILES)) {
    const entry = terminal.files[lane];
    requireEvidence(entry?.name === name && integer(entry.byteLength) && entry.byteLength > 0
      && entry.byteLength <= (lane === 'metadata' ? MAX_METADATA_BYTES : MAX_PCM_BYTES)
      && /^[a-f0-9]{64}$/u.test(entry.sha256) && entry.flushed === true && entry.synced === true
      && entry.unwrittenBufferedBytes === 0, `${lane} file commit metadata`);
    const { candidate, stat } = evidencePath(root, name);
    requireEvidence(stat.size === entry.byteLength && hashFile(candidate, stat.size) === entry.sha256,
      `${lane} bytes/hash mismatch`);
  }
  const text = readUtf8(path.join(root, AEC_TAP_FILES.metadata), MAX_METADATA_BYTES);
  requireEvidence(text.endsWith('\n'), 'truncated metadata record');
  const counts = { render: 0, capture: 0, reset: 0 };
  const samples = { render: 0, pre: 0, post: 0 };
  let sequence = 0;
  let resetGeneration = 0;
  let invalidClockEvents = 0;
  const renderDomains = new Map();
  for (const line of text.slice(0, -1).split('\n')) {
    const event = JSON.parse(line);
    requireEvidence(event.schemaVersion === 3 && event.sequence === sequence
      && integer(event.resetGeneration) && integer(event.continuityId), `sequence/schema at ${sequence}`);
    if (event.kind === 'reset') resetGeneration += 1;
    requireEvidence(event.resetGeneration === resetGeneration, `reset ownership at ${sequence}`);
    sequence += 1;
    if (event.kind === 'render-reference') {
      requireEvidence(event.sampleRateHz === 48_000 && event.channelCount === 2
        && event.sampleOffset === samples.render && integer(event.sampleCount)
        && event.sampleCount > 0 && event.sampleCount % 2 === 0, 'render sample span');
      requireEvidence(event.qpc100ns === null || integer(event.qpc100ns), 'render clock');
      const frameCount = event.sampleCount / event.channelCount;
      requireEvidence(integer(event.renderSessionId) && integer(event.ownerGeneration)
        && integer(event.physicalPrefixOffsetFrames) && integer(event.referenceStartFrame)
        && integer(event.referenceEndFrame) && integer(event.playedFrames)
        && integer(event.submittedFrames) && integer(event.endpointPaddingFrames),
      'render ownership/clock metadata');
      requireEvidence(event.endpointPaddingFrames <= event.submittedFrames
        && event.playedFrames === event.submittedFrames - event.endpointPaddingFrames,
      'render played/submitted/padding relation');
      requireEvidence(event.referenceEndFrame === event.submittedFrames
        && event.referenceEndFrame >= event.referenceStartFrame
        && event.referenceEndFrame - event.referenceStartFrame === frameCount
        && event.referenceStartFrame >= event.physicalPrefixOffsetFrames,
      'render physical reference span');
      const domain = `${event.renderSessionId}:${event.ownerGeneration}`;
      const previousEnd = renderDomains.get(domain);
      requireEvidence(previousEnd === undefined || event.referenceStartFrame === previousEnd,
        'render reference gap/overlap');
      renderDomains.set(domain, event.referenceEndFrame);
      samples.render += event.sampleCount;
      counts.render += 1;
    } else if (event.kind === 'capture') {
      requireEvidence(event.sampleRateHz === 48_000 && event.channelCount === 2
        && event.preSampleOffset === samples.pre && event.postSampleOffset === samples.post
        && integer(event.preSampleCount) && event.preSampleCount > 0 && event.preSampleCount % 2 === 0
        && event.preSampleCount === event.postSampleCount, 'capture sample span');
      requireEvidence(typeof event.timestampError === 'boolean' && typeof event.dataDiscontinuity === 'boolean'
        && typeof event.queueHeadClockValid === 'boolean' && integer(event.rawPacketDeviceFrameIndex)
        && integer(event.rawPacketQpc100ns) && integer(event.delaySamples)
        && (event.observedQpc100ns === null || integer(event.observedQpc100ns)), 'capture raw clock metadata');
      requireEvidence(event.timestampError
        ? event.packetDeviceFrameIndex === null && event.packetQpc100ns === null
        : event.packetDeviceFrameIndex === event.rawPacketDeviceFrameIndex
          && event.packetQpc100ns === event.rawPacketQpc100ns, 'packet clock authority');
      requireEvidence(event.queueHeadClockValid
        ? integer(event.queueHeadDeviceFrameIndex) && integer(event.queueHeadQpc100ns)
        : event.queueHeadDeviceFrameIndex === null && event.queueHeadQpc100ns === null, 'queue-head clock authority');
      if (event.timestampError || !event.queueHeadClockValid) invalidClockEvents += 1;
      samples.pre += event.preSampleCount;
      samples.post += event.postSampleCount;
      counts.capture += 1;
    } else if (event.kind === 'reset') {
      requireEvidence(typeof event.reason === 'string' && event.reason.length > 0
        && (event.qpc100ns === null || integer(event.qpc100ns)), 'reset metadata');
      counts.reset += 1;
    } else { throw new Error(`AEC tap evidence invalid: unknown event kind ${event.kind}`); }
  }
  requireEvidence(counts.render > 0 && counts.capture > 0, 'no paired production-path capture');
  requireEvidence(sequence === terminal.writtenEvents && terminal.lastWrittenSequence === sequence - 1
    && terminal.lastAttemptedSequence === sequence - 1 && terminal.resetGeneration === resetGeneration
    && isDeepStrictEqual(counts, terminal.eventCounts) && isDeepStrictEqual(samples, terminal.sampleCounts)
    && invalidClockEvents === terminal.invalidClockEvents, 'metadata/final count mismatch');
  for (const lane of ['render', 'pre', 'post']) {
    requireEvidence(samples[lane] * 4 === terminal.files[lane].byteLength, `${lane} PCM coverage`);
  }
  return { schemaVersion: 1, complete: true, releaseEligible: false, audioHealth: 'not-evaluated',
    eventCounts: counts, sampleCounts: samples, invalidClockEvents,
    terminalSha256: hashFile(terminalPath, fs.statSync(terminalPath).size) };
}
