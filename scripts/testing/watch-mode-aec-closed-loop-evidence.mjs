import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { verifyCaptureProcessingRecord } from './watch-mode-aec-capture-processing-evidence.mjs';
import { AEC_TAP_FILES } from './watch-mode-aec-tap-evidence.mjs';
import { validateMmcssAudioReceipt } from './local-aec-mmcss-receipt.mjs';

export const AEC_CLOSED_LOOP_PROFILE = 'aec-closed-loop-dual-reference/v1';
export const AEC_CLOSED_LOOP_THRESHOLDS = Object.freeze({ echoAttenuationDb: 20,
  sourceGainToleranceDb: 3, sourceCoverage: 0.95, windowMs: 100, minimumEchoWindows: 3,
  minimumReferenceRms: 0.0001, maximumReferenceCorrelation: 0.98, maximumUnexplainedEnergyRatio: 0.20 });
export const AEC_CLOSED_LOOP_REQUIRED_ARTIFACTS = Object.freeze([
  'aec-closed-loop-evidence.json', 'aec-closed-loop-terminal.json', 'aec-closed-loop-metadata.jsonl',
  'aec-physical-output-48k-stereo.f32le', 'aec-provider-input.s16le', 'aec-source-reference-48k-mono.f32le',
  'aec-source-playback-clock.jsonl', 'aec-threshold-freeze.json',
  'aec-terminal.json', ...Object.values(AEC_TAP_FILES),
]);
const MAX_BYTES = 48_000 * 2 * 4 * 300;
// Resource bound, NOT an acoustic/source-clock acceptance threshold. A 180s
// run at 10ms packet/clock and 20ms dequeue/input has 18k + 18k + 9k + 9k
// rows. Budget 1KiB per packet/clock, 1.5KiB per dequeue/input, plus the
// previous ~17MiB physical/lifecycle journal: ~78.5MiB. 128MiB retains bounded
// headroom for endpoint strings/packet spans; larger files fail closed, never
// silently drop records. PCM bounds and all quality/clock thresholds stay put.
export const AEC_CLOSED_LOOP_METADATA_MAX_BYTES = 128 * 1024 * 1024;
const MAX_METADATA = AEC_CLOSED_LOOP_METADATA_MAX_BYTES;
const RATE = 48_000;
const TICKS = 10_000_000;
const MAX_RENDER_CLOCK_DRIFT_FRAMES = 48; // frozen same-client QPC/padding bound: 1ms
const stagePlan = [['double-talk', 1, 0, 'none'], ['dynamic-delay', 2, 80, 'none'], ['nonlinear', 3, 160, 'soft-clip']];
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function requireEvidence(ok, detail) { if (!ok) throw new Error(`AEC closed-loop: ${detail}`); }
function bounded(root, name, limit = MAX_BYTES) {
  requireEvidence(typeof name === 'string' && name.length > 0 && !path.isAbsolute(name), 'invalid relative evidence path');
  const candidate = path.resolve(root, name);
  requireEvidence(candidate.startsWith(`${root}${path.sep}`), 'evidence escapes run directory');
  const relative = path.relative(root, candidate);
  let cursor = root;
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component);
    requireEvidence(!fs.lstatSync(cursor).isSymbolicLink(), 'evidence symlink/reparse redirect');
  }
  const stat = fs.lstatSync(candidate);
  requireEvidence(stat.isFile() && stat.size > 0 && stat.size <= limit, `invalid ${name} size/type`);
  const bytes = fs.readFileSync(candidate);
  requireEvidence(bytes.length === stat.size, `${name} changed during read`);
  return bytes;
}
function json(root, name) { return JSON.parse(bounded(root, name, MAX_METADATA).toString('utf8')); }
function records(bytes) {
  const text = bytes.toString('utf8');
  requireEvidence(text.endsWith('\n'), 'truncated metadata');
  return text.slice(0, -1).split('\n').map((line) => JSON.parse(line));
}
function floats(bytes, channels) {
  requireEvidence(bytes.length % (4 * channels) === 0, 'f32 PCM frame alignment');
  const output = new Float32Array(bytes.length / 4);
  for (let i = 0; i < output.length; i += 1) {
    output[i] = bytes.readFloatLE(i * 4);
    requireEvidence(Number.isFinite(output[i]) && Math.abs(output[i]) <= 1, 'invalid f32 PCM');
  }
  return output;
}
function mono(samples) {
  const output = new Float32Array(samples.length / 2);
  for (let i = 0; i < output.length; i += 1) output[i] = Math.fround(Math.fround(samples[i * 2] + samples[i * 2 + 1]) * 0.5);
  return output;
}
// Exact Rust f32 operation order from pcm_resample::resample_capture_to_mono_i16.
function providerPcm(post, rate) {
  requireEvidence(rate === 16_000 || rate === 24_000, 'unsupported provider input sample rate');
  const ratio = RATE / rate;
  requireEvidence(post.length % (2 * ratio) === 0, 'provider mapping cropped frame tail');
  const downmix = mono(post); const out = Buffer.alloc(downmix.length / ratio * 2);
  for (let i = 0; i < out.length / 2; i += 1) {
    let sum = 0;
    for (let j = 0; j < ratio; j += 1) sum = Math.fround(sum + downmix[i * ratio + j]);
    const value = Math.fround(Math.fround(sum / ratio) * 32767);
    out.writeInt16LE(Math.trunc(Math.max(-32767, Math.min(32767, value))), i * 2);
  }
  return out;
}
export const AEC_CAPTURE_QUEUE_WITNESS_POLICY = 'owner-range-time-segments-v2';
const CAPTURE_QUEUE_KINDS = new Set(['native-capture-queue-dequeue', 'native-capture-queue-clock',
  'native-capture-queue-reset', 'native-capture-queue-input']);
function validateQueueIdentity(e) {
  requireEvidence(e.diagnosticOnly === true && e.qualityAcceptance === false && e.aecQualityAcceptance === false
    && e.releaseEligible === false && e.formalCaptureClockAcceptance === false, 'queue diagnostic claimed formal authority');
  requireEvidence(typeof e.endpointId === 'string' && e.endpointId.length > 0
    && integer(e.captureOwnerId) && e.captureOwnerId > 0 && e.queueOwnerId === e.captureOwnerId,
  'queue endpoint/owner identity unavailable or mismatched');
  requireEvidence(integer(e.captureAecResetGeneration) && e.nativeResetGenerationDomain === 'native-capture-owner'
    && e.queueGenerationDomain === 'capture-queue-ledger' && e.resetGenerationDomain === 'aec-diagnostic-tap'
    && integer(e.resetGeneration), 'queue native/reset/generation domain mismatch');
  requireEvidence(['inbound', 'outbound', 'capture', 'render'].includes(e.direction)
    && (e.qpc100ns === null || integer(e.qpc100ns)), 'queue direction/observation schema');
  requireEvidence(Object.hasOwn(e, 'ledgerError') && e.ledgerError === null
    && integer(e.ledgerLastKnownHeadByte) && integer(e.ledgerLastKnownTailByte)
    && e.ledgerLastKnownHeadByte <= e.ledgerLastKnownTailByte, 'queue ledger failed or unavailable');
}
function validateByteRange(start, end, bytes, detail) {
  requireEvidence(integer(start) && integer(end) && integer(bytes) && bytes > 0
    && start % 8 === 0 && end % 8 === 0 && end > start && end - start === bytes, detail);
}
function validatePacketRanges(ranges, detail) {
  requireEvidence(Array.isArray(ranges) && ranges.length <= 2048, detail);
  for (const r of ranges) {
    requireEvidence(integer(r?.packetId) && r.packetId > 0 && integer(r.packetOffsetStartByte)
      && integer(r.packetOffsetEndByte) && r.packetOffsetEndByte > r.packetOffsetStartByte
      && r.packetOffsetStartByte % 8 === 0 && r.packetOffsetEndByte % 8 === 0, detail);
    validateByteRange(r.startByte, r.endByte, r.packetOffsetEndByte - r.packetOffsetStartByte, detail);
  }
}
function validateQueueRecord(e) {
  validateQueueIdentity(e);
  requireEvidence(integer(e.queueGeneration), 'queue generation unavailable');
  if (e.kind === 'native-capture-queue-dequeue') {
    requireEvidence(integer(e.dequeueId) && e.dequeueId > 0 && integer(e.queuedBytesBefore)
      && integer(e.queuedBytesAfter) && e.dequeuedBytes === e.queuedBytesBefore - e.queuedBytesAfter
      && integer(e.queueGenerationBefore) && e.queueGenerationAfter === e.queueGenerationBefore + 1,
    'queue dequeue accounting/generation');
    validateByteRange(e.dequeueStartByte, e.dequeueEndByte, e.dequeuedBytes, 'queue dequeue byte range');
    requireEvidence(integer(e.chunkCount) && e.chunkCount > 0
      && ((e.dequeueKind === 'full-chunk-batch' && integer(e.chunkByteLength) && e.chunkByteLength > 0
        && e.chunkByteLength % 8 === 0 && e.chunkCount * e.chunkByteLength === e.dequeuedBytes)
        || (['partial-tail', 'packet-boundary'].includes(e.dequeueKind) && e.chunkByteLength === null && e.chunkCount === 1)),
    'queue dequeue chunk schema');
    validatePacketRanges(e.packetRanges, 'queue dequeue packet ranges');
  } else if (e.kind === 'native-capture-queue-clock') {
    requireEvidence(integer(e.packetId) && e.packetId > 0 && integer(e.invalidPrefixBytes)
      && e.invalidPrefixBytes % 8 === 0 && integer(e.invalidPrefixStartByte) && integer(e.invalidPrefixEndByte)
      && e.invalidPrefixEndByte - e.invalidPrefixStartByte === e.invalidPrefixBytes
      && typeof e.packetClockValid === 'boolean' && typeof e.queueHeadClockValidForNextChunk === 'boolean'
      && e.queueHeadClockValidForNextChunk === (e.packetClockValid && e.invalidPrefixBytes === 0),
    'queue clock/prefix schema');
    validatePacketRanges(e.invalidPrefixPacketRanges, 'queue clock packet ranges');
  } else if (e.kind === 'native-capture-queue-reset') {
    requireEvidence(typeof e.reason === 'string' && e.reason.length > 0 && e.succeeded === true && e.error === null
      && integer(e.captureAecResetGenerationBefore) && integer(e.captureAecResetGenerationAfter)
      && e.captureAecResetGenerationAfter === e.captureAecResetGeneration
      && integer(e.queueGenerationBefore) && e.queueGenerationAfter === e.queueGenerationBefore
      && e.queueGeneration === e.queueGenerationAfter && integer(e.queuedBytes), 'queue reset receipt failed/schema');
    validatePacketRanges(e.retainedPacketRanges, 'queue reset retained packet ranges');
  } else {
    requireEvidence(e.captureIdentityAvailable === true && e.dequeueMappingAvailable === true
      && integer(e.dequeueId) && e.dequeueId > 0 && integer(e.chunkIndex)
      && integer(e.mainCaptureSequence) && integer(e.mainCaptureResetGeneration)
      && integer(e.mainCapturePostSampleOffset), 'queue input actual capture identity/range unavailable');
    validateByteRange(e.inputStartByte, e.inputEndByte, e.inputByteCount, 'queue input byte range');
    validatePacketRanges(e.packetRanges, 'queue input packet ranges');
    requireEvidence(typeof e.queueHeadClockValid === 'boolean' && typeof e.timestampError === 'boolean'
      && typeof e.dataDiscontinuity === 'boolean', 'queue input clock flag schema');
  }
}
// A versioned queue trace is replayed independently of source clocks/quality.
// Legacy packet-only diagnostic journals remain non-causal, never upgraded by
// latest flags. Once ledger fields/events exist, missing receipts are fatal.
function replayPacketClock(state, e, prefixBytes, queuedBytes) {
  const queuedFrames = BigInt(prefixBytes / 8);
  const ticks = queuedFrames * 10_000_000n;
  const backTicks = (ticks > 0xffff_ffff_ffff_ffffn ? 0xffff_ffff_ffff_ffffn : ticks) / 48_000n;
  const anchorValid = BigInt(e.rawPacketDeviceFrameIndex) >= queuedFrames && BigInt(e.rawPacketQpc100ns) >= backTicks;
  if (e.timestampError || !anchorValid) {
    state.expectedClock.remainingPrefix = queuedBytes;
    state.expectedClock.valid = false;
  } else {
    if (e.dataDiscontinuity) state.expectedClock.remainingPrefix = Math.max(state.expectedClock.remainingPrefix, prefixBytes);
    state.expectedClock.valid = true;
  }
}
function replayCaptureQueueLedger(events, mainEvents, requireTimeSegments = false) {
  const timeSegments = requireTimeSegments || events.some(e => e.kind === 'native-capture-packet'
    && Object.hasOwn(e, 'captureTimeSegmentId'));
  if (!events.some(e => CAPTURE_QUEUE_KINDS.has(e.kind)
    || (e.kind === 'native-capture-packet' && Object.hasOwn(e, 'queueGenerationDomain')))) return {
    schemaVersion: 1, diagnosticOnly: true, qualityAcceptance: false, formalCaptureClockAcceptance: false,
    resolved: false, reviewSatisfied: false, status: 'legacy-diagnostic-only' };
  const owners = new Map(); const usedCaptures = new Set(); const usedResets = new Set();
  const captureRows = mainEvents.filter(e => e.kind === 'capture');
  const captures = new Map(captureRows.map(e => [e.sequence, e]));
  const resets = new Map(mainEvents.filter(e => e.kind === 'reset').map(e => [e.resetGeneration, e]));
  const ranges = (spans, start, end) => spans.flatMap(p => {
    const left = Math.max(start, p.startByte), right = Math.min(end, p.endByte);
    return left < right ? [{ packetId: p.packetId, startByte: left, endByte: right,
      packetOffsetStartByte: p.packetOffsetStartByte + left - p.startByte,
      packetOffsetEndByte: p.packetOffsetStartByte + right - p.startByte }] : [];
  });
  let packetCount = 0, dequeueCount = 0, captureIndex = 0;
  for (const e of events) {
    if (e.kind !== 'native-capture-packet' && !CAPTURE_QUEUE_KINDS.has(e.kind)) continue;
    validateQueueIdentity(e);
    let state = owners.get(e.queueOwnerId);
    if (!state) {
      state = { endpoint: e.endpointId, direction: e.direction, generation: 0, nativeGeneration: 0,
        head: 0, tail: 0, packetId: 0, dequeueId: 0, spans: [], pending: new Map(), clock: null,
        expectedClock: { remainingPrefix: 0, valid: false }, timeSegment: 0, boundaryId: 0,
        previousPacket: null, preparing: null, resetRequired: false };
      owners.set(e.queueOwnerId, state);
    }
    requireEvidence(state.endpoint === e.endpointId && state.direction === e.direction,
      'queue endpoint/owner changed across receipts');
    if (e.kind === 'native-capture-queue-reset') {
      requireEvidence(e.captureAecResetGenerationBefore === state.nativeGeneration
        && e.queueGenerationBefore === state.generation
        && e.queuedBytes === state.tail - state.head, 'queue reset ownership/range mismatch');
      const next = e.reason === 'route-start' ? 0 : state.nativeGeneration + 1;
      requireEvidence((e.reason !== 'route-start' || (state.generation === 0 && state.nativeGeneration === 0))
        && e.captureAecResetGenerationAfter === next, 'queue native reset receipt increment mismatch');
      const reset = resets.get(e.resetGeneration);
      requireEvidence(reset?.reason === e.reason && !usedResets.has(e.resetGeneration),
        'queue reset receipt missing/reused actual sealed main reset');
      usedResets.add(e.resetGeneration);
      requireEvidence(isDeepStrictEqual(e.retainedPacketRanges, ranges(state.spans, state.head, state.tail)),
        'queue reset retained packet mapping mismatch');
      if (timeSegments && state.preparing) {
        requireEvidence(!state.preparing.reason || state.preparing.oldBytes === 0 || state.preparing.boundaryProcessed,
          'time-segment reset before actual old boundary input');
        if (state.preparing.reason && e.reason === 'capture-packet-time-boundary') state.preparing.resetObserved = true;
      }
      state.resetRequired = false;
      state.nativeGeneration = next;
    } else {
      requireEvidence(e.captureAecResetGeneration === state.nativeGeneration, 'queue native reset changed without receipt');
      if (e.kind === 'native-capture-packet') {
        requireEvidence(e.blockAlignBytes === 8 && integer(e.packetId) && e.packetId === state.packetId + 1
          && e.queueGenerationBefore === state.generation && e.queueGenerationAfter === state.generation + 1
          && e.queuedBytesBeforeRead === state.tail - state.head && e.appendStartByte === state.tail,
        'queue append packet/ownership/generation mismatch');
        validateByteRange(e.appendStartByte, e.appendEndByte, e.rawByteCount, 'queue append byte range');
        requireEvidence(e.queuedBytesAfterRead === e.appendEndByte - state.head && state.pending.size === 0,
          'queue append missing dequeue input receipts/accounting');
        if (timeSegments) {
          requireEvidence(!state.preparing && !state.resetRequired, 'time-segment append before clock/reset receipt');
          const prev = state.previousPacket;
          const previousEnd = prev ? prev.rawPacketDeviceFrameIndex + prev.rawFrameCount : null;
          requireEvidence(Number.isSafeInteger(e.rawPacketDeviceFrameIndex + e.rawFrameCount), 'time-segment packet endpoint exceeds safe integer');
          const reason = !prev ? null : e.timestampError ? 'timestamp-error'
            : prev.timestampError ? 'untrusted-predecessor' : e.dataDiscontinuity ? 'data-discontinuity'
            : e.rawPacketDeviceFrameIndex !== previousEnd ? 'device-frame-gap' : null;
          requireEvidence(e.captureTimePreviousEndDeviceFrameIndex === previousEnd
            && e.captureTimePreviousPacketTimestampError === (prev ? prev.timestampError : null)
            && e.captureTimeQueueGeneration === e.queueGenerationAfter, 'time-segment predecessor/queue generation mismatch');
          requireEvidence(e.captureTimeBoundaryReason === reason
            && e.captureTimeSegmentId === (state.timeSegment === 0 ? 1 : state.timeSegment + (reason ? 1 : 0))
            && e.captureTimeBoundaryId === (reason ? state.boundaryId + 1 : null), 'time-segment identity/boundary reason mismatch');
          state.preparing = { packet: e, oldHead: state.head, oldSpans: state.spans.map(p => ({ ...p })),
            oldSegment: state.timeSegment, oldBytes: e.queuedBytesBeforeRead, reason, boundaryProcessed: false, resetObserved: false };
          state.timeSegment = e.captureTimeSegmentId;
          if (reason) state.boundaryId = e.captureTimeBoundaryId;
          state.previousPacket = e;
        }
        state.spans.push({ packetId: e.packetId, startByte: e.appendStartByte, endByte: e.appendEndByte,
          packetOffsetStartByte: 0, packet: e });
        requireEvidence(state.spans.length <= 2048, 'queue packet retention bound exceeded');
        // Replay the existing Rust AecTapQueueClock::observe_packet exactly.
        // This only tests native anchor arithmetic; it does not invent/re-anchor
        // timestamps or change the formal capture/source-clock acceptance rule.
        if (!timeSegments) replayPacketClock(state, e, e.queuedBytesBeforeRead, e.queuedBytesAfterRead);
        state.tail = e.appendEndByte; state.packetId = e.packetId; state.generation += 1; packetCount += 1;
      } else if (e.kind === 'native-capture-queue-dequeue') {
        requireEvidence(e.dequeueId === state.dequeueId + 1 && e.queueGenerationBefore === state.generation
          && e.queueGenerationAfter === state.generation + 1 && e.queuedBytesBefore === state.tail - state.head
          && e.dequeueStartByte === state.head && e.dequeueEndByte <= state.tail
          && e.queuedBytesAfter === state.tail - e.dequeueEndByte && state.pending.size === 0,
        'queue dequeue missing append/ownership/range/generation receipt');
        if (timeSegments && state.preparing) {
          const prep = state.preparing;
          requireEvidence(prep.reason && prep.oldBytes > 0 && prep.oldBytes < 960 * 8
            && !prep.boundaryProcessed && e.dequeueKind === 'packet-boundary'
            && e.dequeueStartByte === prep.oldHead && e.dequeueEndByte === prep.packet.appendStartByte
            && e.dequeuedBytes === prep.oldBytes && state.clock, 'time-segment boundary dequeue must isolate actual old prefix');
        } else {
          requireEvidence(e.dequeueKind !== 'packet-boundary', 'time-segment boundary dequeue without pending packet');
          requireEvidence(state.clock?.packetId === state.packetId, 'queue dequeue missing actual packet clock receipt');
        }
        const expected = ranges(state.spans, e.dequeueStartByte, e.dequeueEndByte);
        requireEvidence(isDeepStrictEqual(e.packetRanges, expected), 'queue dequeue packet mapping mismatch');
        state.pending.set(e.dequeueId, { event: e, ranges: expected, inputs: new Set() });
        state.head = e.dequeueEndByte; state.dequeueId = e.dequeueId; state.generation += 1; dequeueCount += 1;
        state.spans = state.spans.filter(p => p.endByte > state.head);
        if (state.spans.length && state.spans[0].startByte < state.head) {
          const span = state.spans[0]; span.packetOffsetStartByte += state.head - span.startByte; span.startByte = state.head;
        }
      } else if (e.kind === 'native-capture-queue-clock') {
        if (timeSegments) {
          const prep = state.preparing;
          requireEvidence(prep && prep.packet.packetId === e.packetId && state.pending.size === 0
            && (!prep.reason || (prep.resetObserved && !state.resetRequired && (prep.oldBytes === 0 || prep.boundaryProcessed))),
          'time-segment queue-clock missing old-prefix processing/reset');
          const prefix = prep.reason ? 0 : prep.oldBytes;
          requireEvidence(e.captureClockPrefixBytesAtPrepare === prefix
            && state.tail - state.head === prefix + prep.packet.rawByteCount, 'time-segment prefixAtPrepare mismatch');
          replayPacketClock(state, prep.packet, prefix, state.tail - state.head);
          state.preparing = null;
        }
        requireEvidence(e.packetId === state.packetId && e.queueGeneration === state.generation
          && e.invalidPrefixStartByte === state.head && e.invalidPrefixEndByte <= state.tail
          && isDeepStrictEqual(e.invalidPrefixPacketRanges, ranges(state.spans, state.head, e.invalidPrefixEndByte)),
        'queue clock old-prefix packet mapping mismatch');
        requireEvidence(e.invalidPrefixBytes === state.expectedClock.remainingPrefix
          && e.packetClockValid === state.expectedClock.valid
          && e.queueHeadClockValidForNextChunk === (state.expectedClock.valid && state.expectedClock.remainingPrefix === 0),
        'queue clock differs from native packet replay');
        state.clock = { packetId: e.packetId, remainingPrefix: e.invalidPrefixBytes, valid: e.packetClockValid };
        if (timeSegments) {
          const packet = state.previousPacket;
          const prefixFrames = e.captureClockPrefixBytesAtPrepare / 8;
          Object.assign(state.clock, { headFrame: Math.max(0, packet.rawPacketDeviceFrameIndex - prefixFrames),
            headQpc: Math.max(0, packet.rawPacketQpc100ns - Math.floor(prefixFrames * 10000000 / 48000)),
            timestampError: packet.timestampError, dataDiscontinuity: packet.dataDiscontinuity,
            rawFrame: packet.rawPacketDeviceFrameIndex, rawQpc: packet.rawPacketQpc100ns });
        }
      } else {
        const pending = state.pending.get(e.dequeueId); const d = pending?.event;
        const size = ['partial-tail', 'packet-boundary'].includes(d?.dequeueKind) ? d.dequeuedBytes : d?.chunkByteLength;
        requireEvidence(d && e.queueGeneration === state.generation && e.queueGeneration === d.queueGenerationAfter
          && e.chunkIndex < d.chunkCount && !pending.inputs.has(e.chunkIndex)
          && e.inputByteCount === size && e.inputStartByte === d.dequeueStartByte + e.chunkIndex * size
          && e.inputEndByte <= d.dequeueEndByte, 'queue input missing/reused dequeue chunk binding');
        requireEvidence(e.chunkIndex === pending.inputs.size, 'queue input FIFO batch chunk consumption mismatch');
        requireEvidence(isDeepStrictEqual(e.packetRanges, ranges(pending.ranges, e.inputStartByte, e.inputEndByte)),
          'queue input packet mapping mismatch');
        requireEvidence(state.clock && (!e.queueHeadClockValid
          || (state.clock.valid && state.clock.remainingPrefix === 0)),
        'queue input rehabilitated recorded invalid prefix/clock');
        if (timeSegments) requireEvidence(!state.resetRequired
          && (!state.preparing || d?.dequeueKind === 'packet-boundary'), 'time-segment normal input before prepare/reset');
        const capture = captures.get(e.mainCaptureSequence);
        const nextCapture = captureRows[captureIndex];
        requireEvidence(nextCapture && e.mainCaptureSequence === nextCapture.sequence
          && e.mainCaptureResetGeneration === nextCapture.resetGeneration
          && e.mainCapturePostSampleOffset === nextCapture.postSampleOffset,
        'queue input FIFO sealed main capture consumption mismatch');
        requireEvidence(capture && !usedCaptures.has(e.mainCaptureSequence)
          && e.mainCaptureResetGeneration === capture.resetGeneration
          && e.mainCapturePostSampleOffset === capture.postSampleOffset
          && e.inputByteCount === capture.preSampleCount * 4 && e.inputByteCount === capture.postSampleCount * 4
          && e.queueHeadClockValid === capture.queueHeadClockValid && e.timestampError === capture.timestampError
          && e.dataDiscontinuity === capture.dataDiscontinuity,
        'queue input actual sealed main capture identity/range mismatch');
        if (timeSegments) {
          verifyCaptureProcessingRecord(capture, null, null, { strict: true });
          if (d.dequeueKind === 'packet-boundary') {
            const prep = state.preparing; const b = capture.aecProcessing.boundaryAdmission;
            const first = prep.oldSpans[0]; const last = prep.oldSpans.at(-1);
            const firstPacket = first?.packet; const lastPacket = last?.packet;
            const startFrame = firstPacket?.rawPacketDeviceFrameIndex + first?.packetOffsetStartByte / 8;
            // Receipt records the retained production clock, not the new packet or a clock repair.
            const startQpc = state.clock.headQpc;
            requireEvidence(capture.aecProcessing.schemaVersion === 2 && b
              && b.captureOwnerId === e.captureOwnerId && b.queueGeneration === prep.packet.queueGenerationAfter
              && b.boundaryId === prep.packet.captureTimeBoundaryId && b.closedSegmentId === prep.oldSegment
              && b.nextSegmentId === prep.packet.captureTimeSegmentId && b.boundaryReason === prep.reason
              && b.byteLen === e.inputByteCount && b.realFrames === e.inputByteCount / 8
              && b.oldSegmentStartDeviceFrameIndex === startFrame && b.oldSegmentStartQpc100ns === startQpc
              && b.oldSegmentStartDeviceFrameIndex === state.clock.headFrame
              && capture.queueHeadDeviceFrameIndex === state.clock.headFrame && capture.queueHeadQpc100ns === startQpc
              && capture.rawPacketDeviceFrameIndex === state.clock.rawFrame && capture.rawPacketQpc100ns === state.clock.rawQpc
              && capture.timestampError === state.clock.timestampError && capture.dataDiscontinuity === state.clock.dataDiscontinuity
              && b.oldSegmentEndDeviceFrameIndex === lastPacket?.rawPacketDeviceFrameIndex + lastPacket?.rawFrameCount
              && b.nextPacketDeviceFrameIndex === prep.packet.rawPacketDeviceFrameIndex
              && b.nextPacketQpc100ns === prep.packet.rawPacketQpc100ns
              && b.nextPacketDataDiscontinuity === prep.packet.dataDiscontinuity
              && b.nextPacketTimestampError === prep.packet.timestampError
              && b.previousPacketTimestampError === prep.packet.captureTimePreviousPacketTimestampError,
            'time-segment boundaryAdmission not bound to actual old prefix/pending packet');
            prep.boundaryProcessed = true; state.resetRequired = true;
          } else requireEvidence(capture.aecProcessing.schemaVersion === 1, 'time-segment schema2 without actual boundary dequeue');
        }
        if (timeSegments) {
          state.clock.headFrame += e.inputByteCount / 8;
          state.clock.headQpc += Math.floor(e.inputByteCount / 8 * 10000000 / 48000);
        }
        state.clock.remainingPrefix = Math.max(0, state.clock.remainingPrefix - e.inputByteCount);
        state.expectedClock.remainingPrefix = Math.max(0, state.expectedClock.remainingPrefix - e.inputByteCount);
        captureIndex += 1;
        usedCaptures.add(e.mainCaptureSequence); pending.inputs.add(e.chunkIndex);
        if (pending.inputs.size === d.chunkCount) state.pending.delete(e.dequeueId);
      }
    }
    requireEvidence(e.ledgerLastKnownHeadByte === state.head && e.ledgerLastKnownTailByte === state.tail,
      'queue last-known byte ledger mismatch');
    if (CAPTURE_QUEUE_KINDS.has(e.kind)) requireEvidence(e.queueGeneration === state.generation, 'queue current generation mismatch');
  }
  requireEvidence(packetCount > 0 && dequeueCount > 0 && usedCaptures.size === captures.size
    && [...owners.values()].every(s => s.head === s.tail && s.pending.size === 0 && (!timeSegments || (!s.preparing && !s.resetRequired))),
  'queue ledger incomplete: undrained bytes/dequeue inputs/main capture identity unavailable');
  return { schemaVersion: timeSegments ? 2 : 1, timeSegmentsValidated: timeSegments, diagnosticOnly: true, qualityAcceptance: false, formalCaptureClockAcceptance: false,
    resolved: true, reviewSatisfied: true, status: 'resolved', owners: owners.size, packets: packetCount, dequeues: dequeueCount, inputs: usedCaptures.size };
}
/** Throwing diagnostic-only ledger validator for independently sealed local
 * analysis. Caller must validate both journal seals, hashes and terminal counts
 * before supplying these exact snapshots; this function is not a custody check.
 * required:true rejects old packet-only/no-ledger reports, without changing PCM
 * or any acoustic/formal-clock predicate. requireTimeSegments:true additionally
 * rejects v1 and replays owner-local packet boundaries, actual old-prefix input,
 * retained clock and successful time-boundary reset before preparing new bytes.
 * V2 fields opt into this replay even in diagnostic calls; no partial downgrade.
 * Existing ledger is always fail-closed. Supplemental capture-pump rows are
 * type/uniqueness checked here, NOT authenticated: callers must first validate
 * their journal and verifyCapturePumpTimingSeals(root, events). This memory-only
 * projection never grants file custody or formal acceptance.
 */
export function validateCaptureQueueLedger(events, mainEvents, { required = false, requireTimeSegments = false } = {}) {
  requireEvidence(typeof requireTimeSegments === 'boolean', 'time-segment required option must be boolean');
  requireEvidence(typeof required === 'boolean', 'queue ledger required option must be boolean');
  requireEvidence(Array.isArray(events) && Array.isArray(mainEvents), 'queue journal snapshots missing');
  if (requireTimeSegments) requireEvidence(events.some(e => e.kind === 'native-capture-packet' && Object.hasOwn(e, 'captureTimeSegmentId')), 'complete capture queue time-segment v2 ledger required; v1 is diagnostic-only');
  events.forEach((e, i) => validateSidecarRecord(e, i));
  capturePumpDescriptors(events); // Type/uniqueness only; caller authenticates files.
  let generation = 0;
  mainEvents.forEach((e, i) => {
    if (e?.kind === 'reset') generation += 1;
    requireEvidence(e?.schemaVersion === 3 && e.sequence === i && e.resetGeneration === generation
      && ['capture', 'reset', 'render-reference'].includes(e.kind), 'queue main journal sequence/schema/reset mismatch');
  });
  const projection = { ...replayCaptureQueueLedger(events, mainEvents, requireTimeSegments), required };
  requireEvidence(!required || projection.reviewSatisfied === true,
    'complete capture queue owner/range/receipt ledger required; legacy evidence is diagnostic-only');
  return projection;
}
/** Diagnostic projection over the EXACT journal snapshots whose seals/hashes and
 * terminal counts the caller has already verified. This does not authenticate
 * raw rows, grant acoustic quality, or change formal source-clock acceptance.
 * Local zero-provider analysis can reuse it without enabling provider lineage.
 * A frozen policy must come from the caller's authenticated/hash-bound freeze.
 */
export function verifyCaptureQueueLedgerEvidence(sidecarEvents, sealedMainEvents, {
  requireCaptureQueueLedger = false, captureQueueWitnessPolicy,
} = {}) {
  const result = { passed: false, diagnosticOnly: true, qualityAcceptance: false,
    formalCaptureClockAcceptance: false, releaseEligible: false, violations: [],
    captureQueueLedger: { schemaVersion: 1, diagnosticOnly: true, qualityAcceptance: false,
      formalCaptureClockAcceptance: false, resolved: false, reviewSatisfied: false, status: 'invalid' } };
  try {
    requireEvidence(typeof requireCaptureQueueLedger === 'boolean', 'requireCaptureQueueLedger must be boolean');
    requireEvidence(captureQueueWitnessPolicy === undefined
      || captureQueueWitnessPolicy === AEC_CAPTURE_QUEUE_WITNESS_POLICY || captureQueueWitnessPolicy === 'owner-range-receipt-v1', 'unknown capture queue witness policy');
    const required = requireCaptureQueueLedger || captureQueueWitnessPolicy !== undefined;
    result.captureQueueLedger = { ...validateCaptureQueueLedger(sidecarEvents, sealedMainEvents), required };
    if (captureQueueWitnessPolicy === AEC_CAPTURE_QUEUE_WITNESS_POLICY) {
      result.captureQueueLedger = { ...validateCaptureQueueLedger(sidecarEvents, sealedMainEvents,
        { requireTimeSegments: true }), required };
    }
    requireEvidence(!required || result.captureQueueLedger.reviewSatisfied === true,
      'complete capture queue owner/range/receipt ledger required; legacy evidence is diagnostic-only');
    result.passed = true;
  } catch (error) { result.violations.push(error.message); }
  return result;
}
const CAPTURE_PUMP_KIND = 'native-capture-pump-timing-seal';
const CAPTURE_PUMP_MAX_BYTES = 64 * 1024 * 1024;
function validateCapturePumpAuthority(value) {
  requireEvidence(value?.diagnosticOnly === true && value.qualityAcceptance === false
    && value.formalCaptureClockAcceptance === false && value.releaseEligible === false
    && (!Object.hasOwn(value, 'aecQualityAcceptance') || value.aecQualityAcceptance === false),
  'capture pump diagnostic claimed authority or omitted authority boundary');
}
// Optional on legacy diagnostic files; when present this is a typed final
// capture-owner receipt, not a scheduling/clock/acoustic acceptance shortcut.
function validateCapturePumpScheduling(value) {
  if (!Object.hasOwn(value, 'mmcssAudio')) return;
  const r = value.mmcssAudio;
  const u32 = n => Number.isInteger(n) && n >= 0 && n <= 0xFFFF_FFFF;
  requireEvidence(r !== null && typeof r === 'object' && !Array.isArray(r), 'capture pump MMCSS receipt object missing');
  requireEvidence(r.ownerThreadId === value.threadId, 'capture pump MMCSS owner differs from capture thread');
  requireEvidence(value.nativeStopSucceeded === true || value.diagnosticIncomplete === true,
    'capture pump failed Stop must remain incomplete');
  if (r.state === 'restored') {
    const verified = validateMmcssAudioReceipt(r, 'restored');
    requireEvidence(verified.valid, 'capture pump MMCSS restored receipt invalid: '+verified.failures.join('; '));
    return;
  }
  requireEvidence(r.state === 'restoreFailed' && value.diagnosticIncomplete === true,
    'capture pump MMCSS final state missing or failed cleanup claimed complete');
  requireEvidence(r.schemaVersion === 1 && r.taskName === 'Audio' && u32(r.ownerThreadId) && r.ownerThreadId > 0
    && r.registrationAttempted === true && r.registrationSucceeded === true && u32(r.taskIndex)
    && r.registrationErrorCode === null && r.cleanupAttempted === true && r.cleanupPath === 'explicit'
    && r.revertSucceeded === false && typeof r.revertAttempted === 'boolean',
    'capture pump MMCSS failed receipt registration/cleanup incoherent');
  if (r.restoreFailureKind === 'nativeError') {
    requireEvidence(r.revertThreadId === r.ownerThreadId && r.revertAttempted === true && u32(r.revertErrorCode),
      'capture pump MMCSS native-error receipt incoherent');
  } else if (r.restoreFailureKind === 'ownerThreadMismatch') {
    requireEvidence(u32(r.revertThreadId) && r.revertThreadId > 0 && r.revertThreadId !== r.ownerThreadId
      && r.revertAttempted === false && r.revertErrorCode === null,
      'capture pump MMCSS owner-mismatch receipt incoherent');
  } else if (r.restoreFailureKind === 'unwound') {
    requireEvidence(r.revertErrorCode === null && ((r.revertThreadId === null && r.revertAttempted === false)
      || (r.revertThreadId === r.ownerThreadId && r.revertAttempted === true)),
    'capture pump MMCSS unwound receipt incoherent');
  } else {
    requireEvidence(false, 'capture pump MMCSS unknown restoration failure kind');
  }
}
function validateCapturePumpDescriptor(e) {
  requireEvidence(e?.schemaVersion === 1 && e.kind === CAPTURE_PUMP_KIND,
    'capture pump descriptor schema/kind mismatch');
  validateCapturePumpAuthority(e);
  for (const key of ['captureOwnerId', 'threadId', 'processId']) {
    requireEvidence(integer(e[key]) && e[key] > 0, 'capture pump descriptor positive safe identity missing: '+key);
  }
  requireEvidence(typeof e.endpointId === 'string' && e.endpointId.trim().length > 0,
    'capture pump descriptor endpoint missing');
  requireEvidence(e.file === 'aec-capture-pump-owner-'+e.captureOwnerId+'.json',
    'capture pump descriptor file must be exact owner-relative basename');
  requireEvidence(integer(e.bytes) && e.bytes > 0 && e.bytes <= CAPTURE_PUMP_MAX_BYTES,
    'capture pump descriptor bytes out of bounds');
  requireEvidence(typeof e.sha256 === 'string' && /^[a-f0-9]{64}$/iu.test(e.sha256),
    'capture pump descriptor sha256 malformed');
  requireEvidence(e.flushed === true && e.synced === true,
    'capture pump descriptor not durably committed');
  requireEvidence(typeof e.captureStoppedBeforePersistence === 'boolean'
    && typeof e.diagnosticIncomplete === 'boolean', 'capture pump descriptor stop/completeness missing');
}
function capturePumpDescriptors(events) {
  requireEvidence(Array.isArray(events), 'capture pump journal missing');
  const owners = new Set(); const files = new Set(); const descriptors = [];
  for (const e of events) if (e?.kind === CAPTURE_PUMP_KIND) {
    validateCapturePumpDescriptor(e);
    requireEvidence(!owners.has(e.captureOwnerId) && !files.has(e.file),
      'duplicate capture pump descriptor owner/file');
    owners.add(e.captureOwnerId); files.add(e.file); descriptors.push(e);
  }
  return descriptors;
}
/** Authenticate supplemental diagnostic files against an already sealed journal.
 * No acoustic/clock/drain acceptance follows from these file seals. All root-
 * bearing readers must call this before using the memory-only queue projection.
 */
export function verifyCapturePumpTimingSeals(root, events) {
  const descriptors = capturePumpDescriptors(events);
  for (const e of descriptors) {
    const bytes = bounded(path.resolve(root), e.file, CAPTURE_PUMP_MAX_BYTES);
    requireEvidence(bytes.length === e.bytes && sha(bytes) === e.sha256.toLowerCase(),
      'capture pump diagnostic file bytes/hash mismatch');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error('AEC closed-loop: capture pump diagnostic file invalid UTF-8/JSON'); }
    requireEvidence(value?.schemaVersion === 1 && value.artifactKind === 'capture-pump-timing-diagnostic',
      'capture pump diagnostic file schema/artifact kind mismatch');
    validateCapturePumpAuthority(value);
    for (const key of ['captureOwnerId', 'threadId', 'processId', 'endpointId', 'diagnosticIncomplete']) {
      requireEvidence(value[key] === e[key], 'capture pump diagnostic file identity/completeness mismatch: '+key);
    }
    requireEvidence(typeof value.nativeStopSucceeded === 'boolean'
      && value.nativeStopSucceeded === e.captureStoppedBeforePersistence,
    'capture pump diagnostic file native stop mismatch');
    validateCapturePumpScheduling(value);
  }
  return { descriptorCount: descriptors.length, fileSealsVerified: true, diagnosticOnly: true,
    qualityAcceptance: false, formalCaptureClockAcceptance: false, releaseEligible: false };
}

function validateSidecarRecord(e, i) {
  if (e?.kind === CAPTURE_PUMP_KIND) {
    requireEvidence(e.sequence === i, 'capture pump descriptor sequence mismatch');
    validateCapturePumpDescriptor(e); return;
  }
  requireEvidence(e?.schemaVersion === 1 && e.sequence === i && typeof e.kind === 'string', 'sidecar metadata sequence/schema mismatch');
  if (CAPTURE_QUEUE_KINDS.has(e.kind)) { validateQueueRecord(e); return; }
  if (e.kind === 'native-capture-packet') {
    requireEvidence(e.diagnosticOnly === true
      && e.qualityAcceptance === false
      && e.aecQualityAcceptance === false
      && e.releaseEligible === false
      && e.formalCaptureClockAcceptance === false,
    'native capture packet claimed formal quality or clock authority');
    requireEvidence(integer(e.rawFrameCount) && e.rawFrameCount > 0, 'invalid raw frame count');
    requireEvidence(integer(e.blockAlignBytes) && e.blockAlignBytes > 0, 'invalid block align');
    requireEvidence(integer(e.queuedBytesBeforeRead) && integer(e.queuedBytesAfterRead), 'invalid queued byte accounting');
    requireEvidence(e.queuedBytesBeforeRead % e.blockAlignBytes === 0
      && e.queuedBytesAfterRead % e.blockAlignBytes === 0,
    'queued bytes not aligned to frame block align');
    requireEvidence(integer(e.rawByteCount)
      && e.rawByteCount === e.queuedBytesAfterRead - e.queuedBytesBeforeRead
      && e.rawByteCount === e.rawFrameCount * e.blockAlignBytes,
    'native capture packet frame/byte/queue inconsistency');
    requireEvidence(integer(e.rawPacketDeviceFrameIndex) && integer(e.rawPacketQpc100ns), 'invalid packet frame index or QPC');
    requireEvidence(typeof e.dataDiscontinuity === 'boolean' && typeof e.silent === 'boolean' && typeof e.timestampError === 'boolean', 'invalid packet flags');
    requireEvidence(['inbound', 'outbound', 'capture', 'render'].includes(e.direction), 'invalid capture direction');
    requireEvidence(typeof e.requestedEndpointId === 'string' && e.requestedEndpointId.length > 0, 'invalid requested endpoint ID');
    requireEvidence(Object.hasOwn(e, 'endpointId') && (e.endpointId === null || (typeof e.endpointId === 'string' && e.endpointId.length > 0)), 'invalid endpoint ID');
    requireEvidence(Object.hasOwn(e, 'captureOwnerId') && (e.captureOwnerId === null || integer(e.captureOwnerId)), 'invalid capture owner ID');
    requireEvidence(Object.hasOwn(e, 'captureAecResetGeneration') && (e.captureAecResetGeneration === null || integer(e.captureAecResetGeneration)), 'invalid capture AEC reset generation');
    requireEvidence(Object.hasOwn(e, 'qpc100ns') && (e.qpc100ns === null || integer(e.qpc100ns)), 'invalid observed QPC');
    requireEvidence(Object.hasOwn(e, 'observedQpc100ns') && e.observedQpc100ns === e.qpc100ns, 'observed QPC mismatch');
    requireEvidence(Object.hasOwn(e, 'resetGeneration') && integer(e.resetGeneration), 'invalid reset generation');
    requireEvidence(e.resetGenerationDomain === 'aec-diagnostic-tap', 'invalid reset generation domain');
    return;
  }
  const allowed = ['physical-output', 'provider-input', 'render-lifecycle', 'stage-lifecycle', 'provider-lifecycle'];
  requireEvidence(allowed.includes(e.kind), 'sidecar metadata sequence/schema mismatch');
}
function validateSeal(root, terminal) {
  requireEvidence(terminal.schemaVersion === 1 && terminal.kind === 'aec-closed-loop-terminal'
    && terminal.complete === true && terminal.countsFinal === true && terminal.errors?.length === 0
    && terminal.droppedEvents === 0 && integer(terminal.writtenEvents) && terminal.writtenEvents > 0
    && terminal.attemptedEvents === terminal.writtenEvents && terminal.acceptedEvents === terminal.writtenEvents,
  'unsealed/dropped sidecar');
  const names = { physical: 'aec-physical-output-48k-stereo.f32le', provider: 'aec-provider-input.s16le', metadata: 'aec-closed-loop-metadata.jsonl' };
  requireEvidence(Object.keys(terminal.files ?? {}).sort().join(',') === 'metadata,physical,provider', 'sidecar file inventory');
  const data = {};
  for (const [lane, name] of Object.entries(names)) {
    const entry = terminal.files[lane]; const bytes = bounded(root, name, lane === 'metadata' ? MAX_METADATA : MAX_BYTES);
    requireEvidence(entry?.name === name && entry.byteLength === bytes.length && entry.sha256 === sha(bytes)
      && entry.flushed === true && entry.synced === true && entry.unwrittenBufferedBytes === 0, `${lane} hash/commit mismatch`);
    data[lane] = bytes;
  }
  return data;
}
// Reuse the existing tap's sealed files/schema; production c03 has known
// physical silence prefixes, so reference gaps are verified against physical
// frames below rather than blanket-rejected as in the diagnostic-only reader.
function validateDiagnosticSeal(root) {
  const terminal = json(root, 'aec-terminal.json');
  requireEvidence(!fs.existsSync(path.join(root, 'aec-terminal.json.partial'))
    && terminal.schemaVersion === 2 && terminal.kind === 'terminal' && terminal.status === 'complete'
    && terminal.complete === true && terminal.countsFinal === true && terminal.errors?.length === 0
    && terminal.hashAlgorithm === 'sha256' && terminal.terminalFile === 'aec-terminal.json'
    && terminal.droppedEvents === 0 && terminal.invalidClockEvents === 0
    && integer(terminal.writtenEvents) && terminal.writtenEvents > 0
    && terminal.attemptedEvents === terminal.writtenEvents && terminal.acceptedEvents === terminal.writtenEvents
    && Object.keys(terminal.files ?? {}).sort().join(',') === 'metadata,post,pre,render', 'diagnostic PCM not sealed/clock-valid');
  const data = {};
  for (const [lane, name] of Object.entries(AEC_TAP_FILES)) {
    const entry = terminal.files[lane]; const bytes = bounded(root, name, lane === 'metadata' ? MAX_METADATA : MAX_BYTES);
    requireEvidence(entry?.name === name && entry.byteLength === bytes.length && entry.sha256 === sha(bytes)
      && entry.flushed === true && entry.synced === true && entry.unwrittenBufferedBytes === 0, lane + ' diagnostic hash/commit mismatch');
    data[lane] = bytes;
  }
  let generation = 0; const count = { render: 0, capture: 0, reset: 0 }; const samples = { render: 0, pre: 0, post: 0 };
  const events = records(data.metadata);
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i]; if (e.kind === 'reset') generation += 1;
    requireEvidence(e.schemaVersion === 3 && e.sequence === i && e.resetGeneration === generation && integer(e.continuityId), 'diagnostic sequence/reset ownership mismatch');
    if (e.kind === 'render-reference') {
      requireEvidence(e.sampleRateHz === RATE && e.channelCount === 2 && e.sampleOffset === samples.render
        && integer(e.sampleCount) && e.sampleCount > 0 && e.sampleCount % 2 === 0
        && integer(e.qpc100ns) && integer(e.renderSessionId) && integer(e.ownerGeneration)
        && integer(e.referenceStartFrame) && integer(e.referenceEndFrame) && integer(e.playedFrames)
        && integer(e.submittedFrames) && integer(e.endpointPaddingFrames)
        && e.referenceEndFrame === e.submittedFrames && e.playedFrames === e.submittedFrames - e.endpointPaddingFrames
        && e.referenceEndFrame - e.referenceStartFrame === e.sampleCount / 2, 'diagnostic render provenance');
      samples.render += e.sampleCount; count.render += 1;
    } else if (e.kind === 'capture') {
      requireEvidence(e.sampleRateHz === RATE && e.channelCount === 2 && e.preSampleOffset === samples.pre && e.postSampleOffset === samples.post
        && integer(e.preSampleCount) && e.preSampleCount > 0 && e.preSampleCount % 2 === 0 && e.preSampleCount === e.postSampleCount
        && e.timestampError === false && e.dataDiscontinuity === false && e.queueHeadClockValid === true
        && integer(e.queueHeadQpc100ns) && integer(e.queueHeadDeviceFrameIndex)
        && integer(e.packetQpc100ns) && e.packetQpc100ns === e.rawPacketQpc100ns
        && integer(e.packetDeviceFrameIndex) && e.packetDeviceFrameIndex === e.rawPacketDeviceFrameIndex, 'diagnostic capture provenance/clock');
      samples.pre += e.preSampleCount; samples.post += e.postSampleCount; count.capture += 1;
    } else if (e.kind === 'reset') { requireEvidence(typeof e.reason === 'string' && e.reason.length > 0 && integer(e.qpc100ns), 'diagnostic reset provenance'); count.reset += 1; }
    else { throw new Error('AEC closed-loop: unknown diagnostic record kind'); }
  }
  requireEvidence(events.length === terminal.writtenEvents && terminal.lastWrittenSequence === events.length - 1
    && terminal.lastAttemptedSequence === events.length - 1 && terminal.resetGeneration === generation
    && isDeepStrictEqual(samples, terminal.sampleCounts) && isDeepStrictEqual(count, terminal.eventCounts)
    && count.capture > 0 && count.render > 0, 'diagnostic terminal accounting mismatch');
  for (const lane of ['render', 'pre', 'post']) requireEvidence(samples[lane] * 4 === data[lane].length, lane + ' diagnostic cropped PCM');
  return events;
}
function domain(e) { return `${e.renderSessionId}:${e.ownerGeneration}:${e.resetGeneration}:${e.continuityId}`; }
function physicalTimeline(events, samples, stereo) {
  const domains = new Map(); let offset = 0;
  for (const e of events) {
    for (const field of ['qpc100ns', 'renderSessionId', 'ownerGeneration', 'continuityId', 'resetGeneration',
      'referenceStartFrame', 'referenceEndFrame', 'playedFrames', 'submittedFrames', 'endpointPaddingFrames', 'physicalPrefixOffsetFrames']) {
      requireEvidence(integer(e[field]), `physical ${field} missing/invalid`);
    }
    requireEvidence(e.sampleRateHz === RATE && e.channelCount === 2 && e.sampleOffset === offset
      && integer(e.sampleCount) && e.sampleCount > 0 && e.sampleCount % 2 === 0, 'physical sample coverage');
    requireEvidence(e.referenceEndFrame - e.referenceStartFrame === e.sampleCount / 2
      && e.referenceEndFrame === e.submittedFrames && e.playedFrames === e.submittedFrames - e.endpointPaddingFrames,
    'physical played/submitted/padding/span mismatch');
    const key = domain(e); let d = domains.get(key);
    const origin = e.qpc100ns - e.playedFrames * TICKS / RATE;
    if (!d) { d = { ...e, origin, startFrame: e.referenceStartFrame, endFrame: e.referenceStartFrame, chunks: [], events: [] }; domains.set(key, d); }
    requireEvidence(e.referenceStartFrame === d.endFrame && Math.abs(origin - d.origin) * RATE / TICKS <= MAX_RENDER_CLOCK_DRIFT_FRAMES,
      'physical clock drift/gap/overlap/uncertain timing');
    d.events.push(e);
    d.chunks.push(samples.subarray(e.sampleOffset / 2, (e.sampleOffset + e.sampleCount) / 2));
    d.endFrame = e.referenceEndFrame; offset += e.sampleCount;
  }
  requireEvidence(offset === samples.length * 2, 'physical PCM cropped/unreferenced tail');
  for (const d of domains.values()) {
    d.pcm = new Float32Array(d.endFrame - d.startFrame); d.stereo = new Float32Array(d.pcm.length * 2); let pos = 0;
    for (const e of d.events) d.stereo.set(stereo.subarray(e.sampleOffset, e.sampleOffset + e.sampleCount), (e.referenceStartFrame - d.startFrame) * 2);
    for (const chunk of d.chunks) { d.pcm.set(chunk, pos); pos += chunk.length; }
    d.startQpc100ns = d.origin + d.startFrame * TICKS / RATE;
    d.endQpc100ns = d.origin + d.endFrame * TICKS / RATE;
    const first = d.pcm.findIndex((x) => Math.abs(x) >= 0.0001);
    let last = d.pcm.length - 1; while (last >= 0 && Math.abs(d.pcm[last]) < 0.0001) last -= 1;
    d.firstNonSilentQpc100ns = first < 0 ? null : d.startQpc100ns + first * TICKS / RATE;
    d.lastNonSilentQpc100ns = last < 0 ? null : d.startQpc100ns + (last + 1) * TICKS / RATE;
  }
  return domains;
}

/** Production manifest/authority contract (no caller-supplied quality scores):
 * schemaVersion:1, profile, identity:{runMarker,cellId,leaseId}, thresholds,
 * thresholdsFrozenQpc100ns, source:{file,sha256,byteLength,sampleRateHz:48000,
 * channelCount:1,playbackStartQpc100ns}, stages:[{stage,ordinal,delayMs,
 * nonlinearity,startQpc100ns,endQpc100ns,renderSessionId,ownerGeneration,
 * resetGeneration,continuityId,physicalStartFrame,physicalEndFrame}]. runtimeAuthority.aecClosedLoop must contain
 * the exact identity/source/stages/thresholdsFrozenQpc100ns plus
 * firstPaidProviderCallQpc100ns and providerSessionIds, independently
 * sealed before analysis; cell is {cellId,leaseId,runMarker} or identity is
 * checked against runtimeAuthority.identity. Every range is end-exclusive.
 * QPC units are 100ns; source's origin is its first actually played PCM frame.
 * Physical PCM contains the actual transform/prefix/tail: do NOT delay it again.
 * build only validates/provides aligned PCM; it never grants release success.
 */
export function buildAecClosedLoopEvidence(runDirectory, {
  runtimeAuthority, cell, freezePublicKey, requireCaptureQueueLedger = false,
} = {}) {
  const result = { profile: AEC_CLOSED_LOOP_PROFILE, passed: false, releaseEligible: false,
    violations: [], thresholds: AEC_CLOSED_LOOP_THRESHOLDS, stages: [], physicalRenders: [] };
  try {
    const root = fs.realpathSync(runDirectory);
    requireEvidence(!fs.lstatSync(runDirectory).isSymbolicLink(), 'run directory redirect');
    const manifest = json(root, 'aec-closed-loop-evidence.json');
    const authority = runtimeAuthority?.aecClosedLoop;
    requireEvidence(authority && manifest.schemaVersion === 1 && manifest.profile === AEC_CLOSED_LOOP_PROFILE,
      'runtime closed-loop authority/profile missing');
    for (const field of ['identity', 'source', 'stages', 'thresholdsFrozenQpc100ns', 'freeze']) requireEvidence(isDeepStrictEqual(manifest[field], authority[field]), `${field} differs from runtime authority`);
    const expected = cell?.identity ?? (cell?.runMarker ? { runMarker: cell.runMarker, cellId: cell.cellId ?? cell.id, leaseId: cell.leaseId } : runtimeAuthority.identity);
    requireEvidence(expected && isDeepStrictEqual(manifest.identity, expected)
      && ['runMarker', 'cellId', 'leaseId'].every((k) => typeof expected[k] === 'string' && expected[k].length > 0), 'run/cell/lease identity mismatch');
    requireEvidence(isDeepStrictEqual(manifest.thresholds, AEC_CLOSED_LOOP_THRESHOLDS)
      && integer(manifest.thresholdsFrozenQpc100ns), 'thresholds not frozen to strict profile before paid calls');
    const diagnosticEvents = validateDiagnosticSeal(root);
    const seal = json(root, 'aec-closed-loop-terminal.json');
    requireEvidence(isDeepStrictEqual(seal.identity, expected), 'tap startup identity mismatch');
    const freezeBytes = bounded(root, authority.freeze.file, 64 * 1024);
    requireEvidence(integer(seal.startupQpc100ns) && seal.startupQpc100ns === manifest.thresholdsFrozenQpc100ns
      && authority.freeze?.sha256 === seal.thresholdFreezeSha256
      && sha(freezeBytes) === authority.freeze.sha256,
    'signed freeze/tap startup hash identity mismatch');
    if (freezePublicKey) requireEvidence(isDeepStrictEqual(signedFreeze(root, authority.freeze.file, expected, freezePublicKey), authority.freeze), 'freeze signature authority mismatch');
    const sourceClock = sourceClockAuthority(root, expected, authority.playbackReceiptFile ?? 'playback.json');
    requireEvidence(isDeepStrictEqual(sourceClock.source, manifest.source) && sourceClock.sourceClockSha256 === authority.sourceClockSha256
      && sourceClock.sourcePlaybackReceiptSha256 === authority.sourcePlaybackReceiptSha256, 'source clock/hash authority mismatch');
    if (authority.closedLoopTerminalSha256) requireEvidence(sha(bounded(root, 'aec-closed-loop-terminal.json', MAX_METADATA)) === authority.closedLoopTerminalSha256, 'closed-loop terminal identity changed');
    const data = validateSeal(root, seal);
    const metadata = records(data.metadata);
    requireEvidence(metadata.length === seal.writtenEvents, 'sidecar metadata sequence/schema mismatch');
    metadata.forEach((e, i) => validateSidecarRecord(e, i));
    verifyCapturePumpTimingSeals(root, metadata);
    const queueReview = verifyCaptureQueueLedgerEvidence(metadata, diagnosticEvents, {
      requireCaptureQueueLedger,
      captureQueueWitnessPolicy: JSON.parse(freezeBytes.toString('utf8')).payload?.captureQueueWitnessPolicy,
    });
    result.captureQueueLedger = queueReview.captureQueueLedger;
    requireEvidence(queueReview.passed, queueReview.violations.join('; '));
    const physicalEvents = metadata.filter((e) => e.kind === 'physical-output');
    const modelEvents = metadata.filter((e) => e.kind === 'provider-input');
    requireEvidence(physicalEvents.length === seal.physicalEvents && modelEvents.length === seal.providerEvents
      && metadata.length - physicalEvents.length - modelEvents.length === (seal.lifecycleEvents ?? 0)
      && seal.physicalSamples * 4 === data.physical.length && seal.providerSamples * 2 === data.provider.length,
    'sidecar final count mismatch');
    const physicalStereo = floats(data.physical, 2); const physical = mono(physicalStereo);
    const renderStereo = floats(bounded(root, AEC_TAP_FILES.render), 2);
    const pre = mono(floats(bounded(root, AEC_TAP_FILES.pre), 2));
    const postStereo = floats(bounded(root, AEC_TAP_FILES.post), 2); const post = mono(postStereo);
    requireEvidence(pre.length === post.length, 'pre/post length mismatch');
    const baseEvents = diagnosticEvents;
    const captures = baseEvents.filter((e) => e.kind === 'capture');
    const renders = baseEvents.filter((e) => e.kind === 'render-reference');
    requireEvidence(captures.every((e) => !e.timestampError && !e.dataDiscontinuity && e.queueHeadClockValid
      && integer(e.queueHeadQpc100ns)), 'invalid capture clock/discontinuity');
    requireEvidence(integer(authority.firstPaidProviderCallQpc100ns)
      && manifest.thresholdsFrozenQpc100ns < authority.firstPaidProviderCallQpc100ns,
    'strict thresholds were not frozen before first paid provider call');
    requireEvidence(Array.isArray(authority.providerSessionIds) && authority.providerSessionIds.length > 0
      && authority.providerSessionIds.every((id) => typeof id === 'string' && id.length > 0), 'provider session authority missing');
    const sourceEntry = manifest.source;
    requireEvidence(sourceEntry?.file === 'aec-source-reference-48k-mono.f32le'
      && sourceEntry.sampleRateHz === RATE && sourceEntry.channelCount === 1 && integer(sourceEntry.playbackStartQpc100ns), 'source timeline/rate authority');
    const sourceBytes = bounded(root, sourceEntry.file);
    requireEvidence(sourceBytes.length === sourceEntry.byteLength && sha(sourceBytes) === sourceEntry.sha256, 'source hash/identity mismatch');
    const source = floats(sourceBytes, 1);
    const domains = physicalTimeline(physicalEvents, physical, physicalStereo);
    result.physicalRenders = [...domains.values()].map((d) => ({ renderSessionId: d.renderSessionId,
      ownerGeneration: d.ownerGeneration, continuityId: d.continuityId, resetGeneration: d.resetGeneration,
      startQpc100ns: d.startQpc100ns, endQpc100ns: d.endQpc100ns, submittedFrames: d.endFrame,
      firstNonSilentQpc100ns: d.firstNonSilentQpc100ns, lastNonSilentQpc100ns: d.lastNonSilentQpc100ns,
      timingAuthority: 'same-client-qpc-padding', acousticOnsetAuthority: false }));
    // Validate *all* actual provider sends, not merely the selected good stages.
    let providerOffset = 0; let previousPostEnd = 0;
    const mapped = new Uint8Array(postStereo.length);
    for (const e of modelEvents) {
      requireEvidence(typeof e.providerSessionId === 'string' && authority.providerSessionIds.includes(e.providerSessionId)
        && integer(e.qpc100ns) && integer(e.sentQpc100ns) && e.sentQpc100ns >= e.qpc100ns && e.sentQpc100ns > manifest.thresholdsFrozenQpc100ns
        && integer(e.postSampleOffset) && integer(e.postSampleCount) && e.postSampleCount > 0
        && e.postSampleOffset % 2 === 0 && e.postSampleCount % 2 === 0 && e.postSampleOffset >= previousPostEnd
        && e.mappingProfile === 'capture-downmix-box-decimate/v1', 'provider/post mapping provenance or pre-paid freeze');
      const end = e.postSampleOffset + e.postSampleCount;
      requireEvidence(end <= postStereo.length && e.sampleOffset === providerOffset, 'provider/post span overlap/gap/crop');
      const c = captures.find((c) => e.postSampleOffset >= c.postSampleOffset && e.postSampleOffset < c.postSampleOffset + c.postSampleCount);
      const spanCaptures = captures.filter((c) => c.postSampleOffset < end && c.postSampleOffset + c.postSampleCount > e.postSampleOffset);
      requireEvidence(spanCaptures.length > 0 && spanCaptures.every((c, i) => c.resetGeneration === e.resetGeneration && c.continuityId === e.continuityId
        && (i === 0 || Math.abs(c.queueHeadQpc100ns - (spanCaptures[i - 1].queueHeadQpc100ns + spanCaptures[i - 1].postSampleCount / 2 * TICKS / RATE)) * RATE / TICKS <= 1)), 'provider mapping crossed capture gap/reset');
      requireEvidence(c && e.resetGeneration === c.resetGeneration && e.continuityId === c.continuityId
        && Math.abs(e.qpc100ns - (c.queueHeadQpc100ns + (e.postSampleOffset - c.postSampleOffset) / 2 * TICKS / RATE)) * RATE / TICKS <= 1,
      'provider/post capture clock/reset ownership mismatch');
      const bytes = data.provider.subarray(e.sampleOffset * 2, (e.sampleOffset + e.sampleCount) * 2);
      const expectedPcm = providerPcm(postStereo.subarray(e.postSampleOffset, end), e.sampleRateHz);
      requireEvidence(bytes.length === e.sampleCount * 2 && sha(bytes) === e.sha256 && bytes.equals(expectedPcm), 'actual provider PCM is not mapped post-AEC PCM');
      mapped.fill(1, e.postSampleOffset, end); providerOffset += e.sampleCount; previousPostEnd = end;
    }
    requireEvidence(modelEvents.length > 0 && providerOffset * 2 === data.provider.length, 'provider missing/unmapped trailing bytes');
    requireEvidence(Array.isArray(manifest.stages) && manifest.stages.length >= stagePlan.length
      && stagePlan.every(([name]) => manifest.stages.some((s) => s.stage === name)), 'three-stage coverage missing');
    let previousEndQpc = -1; const stageRanges = new Map();
    for (let i = 0; i < manifest.stages.length; i += 1) {
      const stage = manifest.stages[i]; const plan = stagePlan.find(([name]) => name === stage.stage)
        ?? (stage.stage === 'ordinary-render' ? ['ordinary-render', 0, 0, 'none'] : null);
      requireEvidence(plan, 'unknown physical stage'); const [name, ordinal, delayMs, nonlinearity] = plan;
      requireEvidence(stage.stage === name && stage.ordinal === ordinal && stage.delayMs === delayMs && stage.nonlinearity === nonlinearity,
        'stage profile must be double-talk/80ms/160ms-soft-clip');
      requireEvidence(integer(stage.startQpc100ns) && integer(stage.endQpc100ns) && stage.startQpc100ns >= previousEndQpc
        && stage.endQpc100ns > stage.startQpc100ns, 'stage clock/order');
      previousEndQpc = stage.endQpc100ns;
      const d = domains.get(domain(stage)); requireEvidence(d, 'stage physical session/owner/reset/continuity missing');
      requireEvidence(integer(stage.physicalStartFrame) && integer(stage.physicalEndFrame)
        && stage.physicalStartFrame >= d.startFrame && stage.physicalEndFrame <= d.endFrame
        && stage.physicalEndFrame > stage.physicalStartFrame, 'stage physical frame range missing/invalid');
      const ranges = stageRanges.get(domain(stage)) ?? []; ranges.push(stage); stageRanges.set(domain(stage), ranges);
      const startFrame = stage.physicalStartFrame; const endFrame = stage.physicalEndFrame;
      requireEvidence(Math.abs(stage.startQpc100ns - (d.origin + startFrame * TICKS / RATE)) * RATE / TICKS <= 1
        && Math.abs(stage.endQpc100ns - (d.origin + endFrame * TICKS / RATE)) * RATE / TICKS <= 1, 'stage physical-time/frame mismatch');
      const length = endFrame - startFrame;
      const delayFrames = delayMs * RATE / 1000;
      const expectedRender = new Float32Array(length * 2); const referenceCovered = new Uint8Array(length);
      for (const r of renders.filter((r) => domain(r) === domain(stage))) {
        requireEvidence(integer(r.qpc100ns) && Math.abs(r.qpc100ns - r.playedFrames * TICKS / RATE - d.origin) * RATE / TICKS <= MAX_RENDER_CLOCK_DRIFT_FRAMES,
          'render/physical session clock mismatch');
        const from = Math.max(startFrame + delayFrames, r.referenceStartFrame); const to = Math.min(endFrame, r.referenceEndFrame);
        for (let n = from; n < to; n += 1) {
          requireEvidence(!referenceCovered[n - startFrame], 'render reference overlap'); referenceCovered[n - startFrame] = 1;
          for (let ch = 0; ch < 2; ch += 1) expectedRender[(n - startFrame) * 2 + ch] = renderStereo[r.sampleOffset + (n - r.referenceStartFrame) * 2 + ch];
        }
      }
      for (let n = 0; n < length; n += 1) {
        requireEvidence(n < delayFrames || referenceCovered[n], 'physical tail not backed by complete linear render reference');
        for (let ch = 0; ch < 2; ch += 1) {
          const original = expectedRender[n * 2 + ch];
          const driven = Math.fround(original * 2.4);
          const soft = Math.fround(Math.fround(driven / Math.fround(1 + Math.abs(driven))) * 1.35);
          const expected = nonlinearity === 'soft-clip' ? Math.fround(Math.max(-0.92, Math.min(0.92, soft))) : original;
          const physicalSample = d.stereo[(startFrame - d.startFrame + n) * 2 + ch];
          requireEvidence(Math.abs(expected - physicalSample) <= 0.0000002, 'wrong physical reference/delay/nonlinear transform');
        }
      }
      const stagePhysical = d.pcm.slice(startFrame - d.startFrame, endFrame - d.startFrame);
      const alignedPre = new Float32Array(length); const alignedPost = new Float32Array(length);
      const covered = new Uint8Array(length);
      for (const c of captures) {
        const start = Math.round((c.queueHeadQpc100ns - stage.startQpc100ns) * RATE / TICKS);
        const frames = c.postSampleCount / 2;
        const from = Math.max(0, start); const to = Math.min(length, start + frames);
        if (to <= from) continue;
        requireEvidence(c.resetGeneration === stage.resetGeneration && c.continuityId === stage.continuityId, 'reset/continuity crossed stage');
        for (let n = from; n < to; n += 1) {
          requireEvidence(covered[n] === 0, 'capture physical-time overlap');
          const p = c.postSampleOffset / 2 + n - start;
          requireEvidence(p < post.length && mapped[p * 2] && mapped[p * 2 + 1], 'stage post samples not actually submitted to provider');
          covered[n] = 1; alignedPre[n] = pre[p]; alignedPost[n] = post[p];
        }
      }
      requireEvidence(covered.every((n) => n === 1), 'capture physical-time gap/cropped tail');
      const sourceOffset = Math.round((stage.startQpc100ns - sourceEntry.playbackStartQpc100ns) * RATE / TICKS);
      requireEvidence(stage.startQpc100ns >= sourceEntry.playbackStartQpc100ns && sourceOffset >= 0,
        'source timeline before confirmed playback start');
      const recordedSourceSamples = Math.max(0, Math.min(length, source.length - sourceOffset));
      const sourceEndedSampleCount = length - recordedSourceSamples;
      if (sourceEndedSampleCount > 0) requireEvidence(sourceClock.endConfirmed,
        'source end not physically confirmed; unknown source time cannot be padded');
      // All physical/capture/provider samples above stay in range. Only source
      // time beyond a complete, hash-bound, physically drained English playback
      // is naturally zero; never infer this from Chinese output or crop a tail.
      const alignedSource = new Float32Array(length);
      alignedSource.set(source.subarray(sourceOffset, sourceOffset + recordedSourceSamples));
      result.stages.push({ ...stage, alignedPre, alignedPost, alignedSource, alignedPhysical: stagePhysical,
        sourceEndedSampleCount, sourceReferenceState: recordedSourceSamples === 0 ? 'ended-only'
          : sourceEndedSampleCount > 0 ? 'recording-then-ended' : 'recording',
        sourcePlaybackEndQpc100ns: sourceClock.playbackEndQpc100ns,
        sourceCompletionObservedQpc100ns: sourceClock.completionObservedQpc100ns });
    }
    requireEvidence(stageRanges.size === domains.size, 'actual render session omitted from quality coverage');
    for (const [key, ranges] of stageRanges) {
      const d = domains.get(key);
      requireEvidence(ranges[0].physicalStartFrame === d.startFrame && ranges.at(-1).physicalEndFrame === d.endFrame
        && ranges.every((r, i) => i === 0 || r.physicalStartFrame === ranges[i - 1].physicalEndFrame), 'cropped physical prefix/tail or stage gap');
    }
    result.passed = true;
    result.evidenceHashes = { terminal: sha(bounded(root, 'aec-terminal.json', MAX_METADATA)),
      closedLoopTerminal: sha(bounded(root, 'aec-closed-loop-terminal.json', MAX_METADATA)), source: sha(sourceBytes) };
  } catch (error) { result.violations.push(error.message); }
  return result;
}
function f32Buffer(samples) { const bytes = Buffer.alloc(samples.length * 4); for (let i = 0; i < samples.length; i += 1) bytes.writeFloatLE(samples[i], i * 4); return bytes; }

/** Strict synchronous frozen-runtime gate. Never builds or replaces binaries.
 * Requires a coordinator-signed freeze containing runtimeBinaryHashes, the
 * trusted public key, and the exact pinned release analyzer with noBuild:true.
 * Mechanical rebuild is a pre-freeze/offline responsibility, not an acceptance
 * side effect. noBuild does not relax quality or force diagnostic-only status.
 */
export function verifyAecClosedLoopEvidence(runDirectory, options = {}) {
  const built = buildAecClosedLoopEvidence(runDirectory, options);
  const result = { ...built, stages: [], releaseEligible: false };
  if (!built.passed) return result;
  result.passed = false;
  let scratch;
  try {
    const analyzer = options.analyzer ?? options;
    requireEvidence(analyzer.noBuild === true && typeof analyzer.workspaceRoot === 'string'
      && typeof analyzer.releaseExecutablePath === 'string' && path.isAbsolute(analyzer.releaseExecutablePath)
      && /^[a-f0-9]{64}$/u.test(analyzer.releaseExecutableSha256 ?? ''), 'frozen signed release analyzer authority missing');
    requireEvidence(options.freezePublicKey, 'trusted frozen analyzer signature key missing');
    const authority = options.runtimeAuthority.aecClosedLoop;
    signedFreeze(fs.realpathSync(runDirectory), authority.freeze.file, authority.identity, options.freezePublicKey);
    const freeze = json(fs.realpathSync(runDirectory), authority.freeze.file);
    const inventory = freeze.payload.runtimeBinaryHashes;
    const binary = Array.isArray(inventory) ? inventory.find((entry) => entry.path === 'target/release/omni-benchmark.exe') : null;
    requireEvidence(binary?.sha256 === analyzer.releaseExecutableSha256, 'analyzer hash is not bound to signed freeze runtime inventory');
    const repo = fs.realpathSync(analyzer.workspaceRoot);
    requireEvidence(!fs.lstatSync(analyzer.workspaceRoot).isSymbolicLink(), 'analyzer workspace redirect');
    const executable = path.join(repo, 'target', 'release', 'omni-benchmark.exe');
    const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    requireEvidence(samePath(path.resolve(analyzer.releaseExecutablePath), executable), 'frozen analyzer is not workspace target/release/omni-benchmark.exe');
    const checkBinary = () => {
      let cursor = repo;
      for (const component of ['target', 'release', 'omni-benchmark.exe']) {
        cursor = path.join(cursor, component);
        requireEvidence(!fs.lstatSync(cursor).isSymbolicLink(), 'frozen analyzer symlink/reparse redirect');
      }
      const stat = fs.statSync(executable);
      requireEvidence(stat.isFile() && stat.size > 0 && stat.size <= 512 * 1024 * 1024
        && sha(fs.readFileSync(executable)) === binary.sha256, 'frozen analyzer SHA256 changed');
    };
    checkBinary();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-aec-closed-loop-'));
    for (let i = 0; i < built.stages.length; i += 1) {
      const { alignedPre, alignedPost, alignedSource, alignedPhysical, ...stage } = built.stages[i];
      const request = { sampleRateHz: RATE };
      for (const [key, pcm] of Object.entries({ pre: alignedPre, post: alignedPost, source: alignedSource, physical: alignedPhysical })) {
        request[key] = path.join(scratch, `${i}-${key}.f32le`); fs.writeFileSync(request[key], f32Buffer(pcm), { flag: 'wx' });
      }
      const requestPath = path.join(scratch, `${i}-request.json`); fs.writeFileSync(requestPath, JSON.stringify(request), { flag: 'wx' });
      checkBinary();
      const analysis = spawnSync(executable, ['audio', 'aec-closed-loop', '--request', requestPath], { cwd: repo, windowsHide: true, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
      requireEvidence(analysis.status === 0 && !analysis.error, `independent Rust analyzer failed: ${analysis.error?.message ?? analysis.stderr}`);
      checkBinary();
      const metrics = JSON.parse(analysis.stdout);
      requireEvidence(metrics.profile === AEC_CLOSED_LOOP_PROFILE && isDeepStrictEqual(metrics.thresholds, AEC_CLOSED_LOOP_THRESHOLDS)
        && metrics.sampleRateHz === RATE && metrics.sampleCount === alignedPre.length
        && Array.isArray(metrics.windows) && metrics.windows.length > 0 && Array.isArray(metrics.violations), 'Rust profile/threshold/range mismatch');
      result.stages.push({ ...stage, ...metrics });
      if (!metrics.passed) result.violations.push(...metrics.violations.map((v) => `${stage.stage}: ${v}`));
    }
    result.passed = result.stages.length === built.stages.length && result.violations.length === 0 && result.stages.every((s) => s.passed);
    result.releaseEligible = result.passed;
    result.analyzerExecutableSha256 = sha(fs.readFileSync(executable));
    result.mechanicalRebuild = false;
    result.frozenRuntimeAuthority = true;
  } catch (error) { result.violations.push(error.message); result.passed = false; }
  finally { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); }
  return result;
}

/** Canonical UTF-8 bytes signed by the coordinator (recursive object-key sort).
 * This freezes policy before paid work; it is not a runtime quality assertion.
 */
export function canonicalAecFreezePayload(value) {
  const encode = (v) => {
    if (Array.isArray(v)) return `[${v.map(encode).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${encode(v[k])}`).join(',')}}`;
    requireEvidence(v !== undefined && (typeof v !== 'number' || Number.isFinite(v)), 'invalid canonical freeze value');
    return JSON.stringify(v);
  };
  return Buffer.from(encode(value), 'utf8');
}
function signedFreeze(root, name, identity, publicKey) {
  requireEvidence(publicKey, 'trusted coordinator freeze public key missing');
  const bytes = bounded(root, name, 64 * 1024); const freeze = JSON.parse(bytes.toString('utf8'));
  const payload = freeze.payload;
  requireEvidence(payload?.schemaVersion === 1 && payload.kind === 'aec-threshold-freeze'
    && payload.profile === AEC_CLOSED_LOOP_PROFILE && isDeepStrictEqual(payload.identity, identity)
    && isDeepStrictEqual(payload.thresholds, AEC_CLOSED_LOOP_THRESHOLDS), 'signed freeze policy/identity mismatch');
  requireEvidence(typeof freeze.signatureBase64 === 'string' && /^[A-Za-z0-9+/]+={0,2}$/u.test(freeze.signatureBase64), 'invalid freeze signature encoding');
  const signature = Buffer.from(freeze.signatureBase64, 'base64');
  requireEvidence(signature.length === 64 && signature.toString('base64') === freeze.signatureBase64
    && crypto.verify(null, canonicalAecFreezePayload(payload), publicKey, signature), 'signed threshold freeze signature rejected');
  return { file: name, sha256: sha(bytes), payloadSha256: sha(canonicalAecFreezePayload(payload)) };
}
function runRelative(root, filename, expected) {
  requireEvidence(typeof filename === 'string' && filename.length > 0, 'source playback output path missing');
  const resolved = path.resolve(root, filename);
  requireEvidence(resolved === path.join(root, expected), 'source playback path is not the expected run-local artifact');
  return expected;
}
function sourceClockAuthority(root, identity, playbackReceiptFile = 'playback.json') {
  const receiptBytes = bounded(root, playbackReceiptFile, MAX_METADATA);
  // Windows PowerShell UTF8 receipts include a BOM. Decode JSON without it,
  // but retain receiptBytes unchanged for the custody SHA256 below.
  const receipt = JSON.parse(receiptBytes.toString('utf8').replace(/^\uFEFF/u, '')); const injector = receipt.injectorResult;
  requireEvidence(injector && integer(injector.sourcePlaybackStartQpc100ns)
    && Number.isFinite(injector.sourceClockFrequency) && injector.sourceClockFrequency > 0, 'actual injector source clock receipt missing');
  const pcmFile = runRelative(root, injector.sourcePcm48kMonoPath, 'aec-source-reference-48k-mono.f32le');
  const clockFile = runRelative(root, injector.sourceClockMetadataPath, 'aec-source-playback-clock.jsonl');
  const bytes = bounded(root, pcmFile); const pcm = floats(bytes, 1);
  const clockBytes = bounded(root, clockFile, MAX_METADATA); const clockEvents = records(clockBytes);
  requireEvidence(clockEvents.length >= 2, 'insufficient actual source clocks');
  const first = clockEvents[0]; let previousPosition = -1; let previousQpc = -1; let previousSubmitted = -1;
  let nonzero = 0; const origins = [];
  for (let i = 0; i < clockEvents.length; i += 1) {
    const e = clockEvents[i];
    requireEvidence(e.schemaVersion === 1 && e.artifactKind === 'aec-source-playback-clock' && e.sequence === i
      && integer(e.processId) && e.processId > 0 && e.processId === first.processId
      && typeof e.endpointId === 'string' && e.endpointId.length > 0 && e.endpointId === first.endpointId
      && e.sampleRateHz === RATE && Number.isFinite(e.clockFrequency) && e.clockFrequency > 0
      && e.clockFrequency === injector.sourceClockFrequency && integer(e.clockPosition) && integer(e.qpc100ns)
      && integer(e.submittedFrames) && e.submittedFrames <= pcm.length && integer(e.paddingFrames)
      && e.paddingFrames <= e.submittedFrames && e.playbackStartQpc100ns === injector.sourcePlaybackStartQpc100ns
      && e.clockPosition >= previousPosition && e.qpc100ns >= previousQpc && e.submittedFrames >= previousSubmitted,
    'invalid source clock identity/order/frame coverage');
    previousPosition = e.clockPosition; previousQpc = e.qpc100ns; previousSubmitted = e.submittedFrames;
    if (e.clockPosition > 0 && e.qpc100ns > 0) { nonzero += 1; origins.push(e.qpc100ns - e.clockPosition / e.clockFrequency * TICKS); }
  }
  requireEvidence(nonzero >= 2 && Math.max(...origins) - Math.min(...origins) <= TICKS / 1000
    && origins.every((origin) => Math.abs(origin - injector.sourcePlaybackStartQpc100ns) <= TICKS / 1000), 'source clock origin drift/uncertain onset');
  const last = clockEvents.at(-1);
  requireEvidence(last.submittedFrames === pcm.length && last.paddingFrames === 0
    && last.clockPosition / last.clockFrequency * RATE >= pcm.length - MAX_RENDER_CLOCK_DRIFT_FRAMES, 'source complete tail was not actually played/drained');
  return { source: { file: pcmFile, sha256: sha(bytes), byteLength: bytes.length, sampleRateHz: RATE,
    channelCount: 1, playbackStartQpc100ns: injector.sourcePlaybackStartQpc100ns },
    sourceClockSha256: sha(clockBytes), sourcePlaybackReceiptSha256: sha(receiptBytes),
    sourceClockProcessId: first.processId, sourceClockEndpointId: first.endpointId, identity,
    playbackEndQpc100ns: injector.sourcePlaybackStartQpc100ns + pcm.length * TICKS / RATE,
    completionObservedQpc100ns: last.qpc100ns,
    // The existing 1ms clock bound is sufficient to align recorded source, but
    // not to claim unheard tail samples are silence. Zero extension requires
    // the final physical clock to cross the complete PCM endpoint after drain.
    endConfirmed: last.clockPosition / last.clockFrequency * RATE >= pcm.length
      && last.qpc100ns >= injector.sourcePlaybackStartQpc100ns + pcm.length * TICKS / RATE };
}

/** Produce, do not fabricate, the strict runtime authority. Must run after
 * producer drain/seal. Rebuild stages from sealed physical PCM + typed native
 * lifecycle; source onset from injector IAudioClock journal; freeze signature
 * from trusted coordinator key and the hash captured at desktop tap startup.
 * No caller scores, booleans, stage windows, source clocks or provider IDs.
 * Returns a fail-closed result, writing the exclusive manifest only on success.
 */
export function createAecClosedLoopManifest(runDirectory, {
  cell, signedFreezeFile = 'aec-threshold-freeze.json', freezePublicKey,
  playbackReceiptFile = 'playback.json', requireCaptureQueueLedger = false,
} = {}) {
  const result = { passed: false, violations: [], runtimeAuthority: null, manifestPath: null };
  try {
    const root = fs.realpathSync(runDirectory);
    const identity = cell?.identity ?? { runMarker: cell?.runMarker, cellId: cell?.cellId ?? cell?.id, leaseId: cell?.leaseId };
    requireEvidence(['runMarker', 'cellId', 'leaseId'].every((k) => typeof identity[k] === 'string' && identity[k].length > 0), 'manifest run/cell/lease identity missing');
    const freeze = signedFreeze(root, signedFreezeFile, identity, freezePublicKey);
    const frozenQueueBytes = bounded(root, signedFreezeFile, 64 * 1024);
    requireEvidence(sha(frozenQueueBytes) === freeze.sha256, 'signed queue freeze changed before policy read');
    const diagnosticEvents = validateDiagnosticSeal(root);
    const seal = json(root, 'aec-closed-loop-terminal.json'); const data = validateSeal(root, seal);
    requireEvidence(isDeepStrictEqual(seal.identity, identity) && seal.thresholdFreezeSha256 === freeze.sha256
      && integer(seal.startupQpc100ns), 'tap did not bind signed policy before paid startup');
    const events = records(data.metadata);
    requireEvidence(events.length === seal.writtenEvents, 'manifest sidecar sequence mismatch');
    events.forEach((e, i) => validateSidecarRecord(e, i));
    verifyCapturePumpTimingSeals(root, events);
    const queueReview = verifyCaptureQueueLedgerEvidence(events, diagnosticEvents, {
      requireCaptureQueueLedger,
      captureQueueWitnessPolicy: JSON.parse(frozenQueueBytes.toString('utf8')).payload?.captureQueueWitnessPolicy,
    });
    result.captureQueueLedger = queueReview.captureQueueLedger;
    requireEvidence(queueReview.passed, queueReview.violations.join('; '));
    const physicalEvents = events.filter((e) => e.kind === 'physical-output');
    const stereo = floats(data.physical, 2); const domains = physicalTimeline(physicalEvents, mono(stereo), stereo);
    const completed = events.filter((e) => e.kind === 'stage-lifecycle' && e.status === 'completed');
    const stageCandidates = [...completed];
    // Each successful streaming write already carries a typed actual phase.
    // Reconstruct whole contiguous phase runs for *every* response, then
    // require the same native session to have normally drained. No log scores
    // or caller-selected start/end windows are used as completion substitutes.
    for (const [key, d] of domains) {
      if (completed.some((e) => domain(e) === key)) continue;
      let run = null;
      for (const e of d.events) {
        const stage = e.stage ?? 'ordinary-render'; const ordinal = e.stageOrdinal ?? 0;
        const delayMs = e.delayMs ?? 0; const nonlinearity = e.nonlinearity ?? 'none';
        const role = stage + ':' + ordinal + ':' + delayMs + ':' + nonlinearity;
        if (!run || run.role !== role) {
          run = {role,stage,ordinal,delayMs,nonlinearity,renderSessionId:d.renderSessionId,
            ownerGeneration:d.ownerGeneration,continuityId:d.continuityId,resetGeneration:d.resetGeneration,
            physicalStartFrame:e.referenceStartFrame,physicalEndFrame:e.referenceEndFrame,
            physicalFrames:e.referenceEndFrame-e.referenceStartFrame,sequence:e.sequence};
          stageCandidates.push(run);
        } else {
          run.physicalEndFrame=e.referenceEndFrame;run.physicalFrames=run.physicalEndFrame-run.physicalStartFrame;run.sequence=e.sequence;
        }
      }
    }
    const stages = [];
    for (const e of stageCandidates) {
      const plan = stagePlan.find(([name]) => name === e.stage)
        ?? (e.stage === 'ordinary-render' ? ['ordinary-render', 0, 0, 'none'] : null);
      requireEvidence(plan, 'unknown completed stage identity');
      const [stage, ordinal, delayMs, nonlinearity] = plan; const d = domains.get(domain(e));
      requireEvidence(e.stage === stage && e.ordinal === ordinal && e.delayMs === delayMs && e.nonlinearity === nonlinearity
        && d && integer(e.physicalStartFrame) && integer(e.physicalEndFrame)
        && e.physicalEndFrame - e.physicalStartFrame === e.physicalFrames, 'typed stage identity/physical frame mismatch');
      const life = events.filter((l) => l.kind === 'render-lifecycle' && l.renderSessionId === e.renderSessionId && l.ownerGeneration === e.ownerGeneration);
      const started = life.filter((l) => l.status === 'session-started'); const streamed = life.filter((l) => l.status === 'stream-started'); const ended = life.filter((l) => l.status === 'session-ended');
      requireEvidence(started.length === 1 && streamed.length === 1 && ended.length === 1
        && life.every((l) => l.valid === true && integer(l.qpc100ns))
        && started[0].sequence < streamed[0].sequence && streamed[0].sequence < ended[0].sequence
        && ended[0].normallyDrained === true && ended[0].streamStarted === true
        && ended[0].sequence > e.sequence, 'physical native lifecycle not fully drained/owned');
      stages.push({ stage, ordinal, delayMs, nonlinearity, renderSessionId: e.renderSessionId,
        ownerGeneration: e.ownerGeneration, resetGeneration: e.resetGeneration, continuityId: e.continuityId,
        physicalStartFrame: e.physicalStartFrame, physicalEndFrame: e.physicalEndFrame,
        startQpc100ns: Math.round(d.origin + e.physicalStartFrame * TICKS / RATE),
        endQpc100ns: Math.round(d.origin + e.physicalEndFrame * TICKS / RATE) });
    }
    stages.sort((a, b) => a.startQpc100ns - b.startQpc100ns);
    requireEvidence(stagePlan.every(([name]) => stages.some((s) => s.stage === name)), 'completed production phase missing');
    const paid = events.filter((e) => e.kind === 'provider-lifecycle' && e.status === 'paid-call-start');
    requireEvidence(paid.length > 0 && paid.every((e) => integer(e.qpc100ns) && e.qpc100ns > seal.startupQpc100ns
      && typeof e.providerSessionId === 'string' && e.providerSessionId.length > 0), 'pre-paid startup freeze/provider lifecycle unavailable');
    const firstPaidProviderCallQpc100ns = Math.min(...paid.map((e) => e.qpc100ns));
    const providerSessionIds = [...new Set(paid.map((e) => e.providerSessionId))];
    const source = sourceClockAuthority(root, identity, playbackReceiptFile);
    const authority = { identity, source: source.source, stages, thresholdsFrozenQpc100ns: seal.startupQpc100ns,
      firstPaidProviderCallQpc100ns, providerSessionIds, freeze,
      sourceClockSha256: source.sourceClockSha256, sourcePlaybackReceiptSha256: source.sourcePlaybackReceiptSha256,
      sourceClockProcessId: source.sourceClockProcessId, sourceClockEndpointId: source.sourceClockEndpointId,
      playbackReceiptFile, closedLoopTerminalSha256: sha(bounded(root, 'aec-closed-loop-terminal.json', MAX_METADATA)) };
    const manifest = { schemaVersion: 1, profile: AEC_CLOSED_LOOP_PROFILE, identity, source: authority.source,
      stages, thresholds: AEC_CLOSED_LOOP_THRESHOLDS, thresholdsFrozenQpc100ns: seal.startupQpc100ns, freeze };
    const manifestPath = path.join(root, 'aec-closed-loop-evidence.json');
    if (fs.existsSync(manifestPath)) requireEvidence(isDeepStrictEqual(json(root, 'aec-closed-loop-evidence.json'), manifest), 'existing manifest differs from mechanical reconstruction');
    else fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { flag: 'wx' });
    const rebuilt = buildAecClosedLoopEvidence(root, { runtimeAuthority: { aecClosedLoop: authority }, cell: identity, freezePublicKey, requireCaptureQueueLedger });
    requireEvidence(rebuilt.passed, rebuilt.violations.join('; '));
    result.runtimeAuthority = { aecClosedLoop: authority }; result.manifestPath = manifestPath;
    result.passed = true;
  } catch (error) { result.violations.push(error.message); }
  return result;
}
