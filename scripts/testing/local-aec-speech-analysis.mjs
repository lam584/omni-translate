import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { validateNativePumpDecisionReceipt } from './local-aec-pump-decision-receipt.mjs';
import { AEC_TAP_FILES } from './watch-mode-aec-tap-evidence.mjs';
import { verifyCaptureProcessingRecord } from './watch-mode-aec-capture-processing-evidence.mjs';
import { AEC_CLOSED_LOOP_PROFILE, AEC_CLOSED_LOOP_THRESHOLDS, AEC_CLOSED_LOOP_METADATA_MAX_BYTES,
  AEC_CAPTURE_QUEUE_WITNESS_POLICY, validateCaptureQueueLedger, verifyCapturePumpTimingSeals } from './watch-mode-aec-closed-loop-evidence.mjs';

export const LOCAL_AEC_SPEECH_SCOPE = 'local-aec-speech-simulation';
const RATE = 48_000;
const TICKS = 10_000_000;
const MAX_PCM = RATE * 2 * 4 * 300;
const MAX_TEXT = 64 * 1024 * 1024;
const CADENCE_CLOCK_BOUND_MICROS = 1000; // Fixed QPC/Instant consistency bound, not an acoustic threshold.
const CLOCK_BOUND_FRAMES = 48; // Existing same-client QPC/padding bound, not a new quality threshold.
const PLAN = [['double-talk', 1, 0, 'none'], ['dynamic-delay', 2, 80, 'none'], ['nonlinear', 3, 160, 'soft-clip']];
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const check = (ok, detail) => { if (!ok) throw new Error(detail); };
const domain = (e) => `${e.renderSessionId}:${e.ownerGeneration}:${e.resetGeneration}:${e.continuityId}`;

function noRedirect(candidate) {
  const absolute = path.resolve(candidate);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    check(!fs.lstatSync(cursor).isSymbolicLink(), `symlink/reparse redirect: ${cursor}`);
  }
  check(path.resolve(fs.realpathSync.native(absolute)).toLowerCase() === absolute.toLowerCase(), 'canonical path redirect');
}
function raw(root, file, limit = MAX_PCM) {
  check(typeof file === 'string' && file.length > 0, 'missing evidence file path');
  const candidate = path.resolve(root, file);
  const relative = path.relative(root, candidate);
  check(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'evidence path escapes run');
  noRedirect(candidate);
  const stat = fs.statSync(candidate);
  check(stat.isFile() && stat.size > 0 && stat.size <= limit, `invalid evidence size/type: ${relative}`);
  const bytes = fs.readFileSync(candidate);
  check(bytes.length === stat.size, `evidence changed during read: ${relative}`);
  return bytes;
}
function parse(bytes) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '')); }
function records(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  check(text.endsWith('\n'), 'truncated JSONL metadata');
  return text.slice(0, -1).split('\n').map((line) => JSON.parse(line));
}
function sealed(root, entry, text = false) {
  check(entry?.flushed === true && entry.synced === true && /^[a-f0-9]{64}$/u.test(entry.sha256 ?? ''), 'unsealed native file');
  const bytes = raw(root, entry.path, text ? MAX_TEXT : MAX_PCM);
  check(sha(bytes) === entry.sha256, 'native raw SHA256 mismatch');
  if (!text) check(entry.bytes === bytes.length && entry.sampleRateHz === RATE && entry.channelCount === 2
    && entry.format === 'f32le' && entry.sampleCount * 4 === bytes.length && entry.frameCount * 2 === entry.sampleCount,
  'native PCM size/format/count mismatch');
  return bytes;
}
function floats(bytes, channels) {
  check(bytes.length % (4 * channels) === 0, 'f32 PCM frame alignment');
  const samples = new Float32Array(bytes.length / 4);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = bytes.readFloatLE(i * 4);
    check(Number.isFinite(samples[i]) && Math.abs(samples[i]) <= 1, 'invalid f32 PCM');
  }
  return samples;
}
function mono(stereo) {
  const out = new Float32Array(stereo.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Math.fround(Math.fround(stereo[i * 2] + stereo[i * 2 + 1]) * 0.5);
  return out;
}
function floatBytes(samples) {
  const bytes = Buffer.alloc(samples.length * 4);
  samples.forEach((sample, i) => bytes.writeFloatLE(sample, i * 4));
  return bytes;
}
function transform(sample) {
  const driven = Math.fround(sample * 2.4);
  const soft = Math.fround(Math.fround(driven / Math.fround(1 + Math.abs(driven))) * 1.35);
  return Math.fround(Math.max(-0.92, Math.min(0.92, soft)));
}
function rms(samples) { let energy = 0; for (const n of samples) energy += n * n; return Math.sqrt(energy / samples.length); }
function pinAnalyzer(analyzer) {
  check(analyzer?.noBuild === true && path.isAbsolute(analyzer.workspaceRoot ?? '')
    && path.isAbsolute(analyzer.releaseExecutablePath ?? '') && /^[a-f0-9]{64}$/u.test(analyzer.releaseExecutableSha256 ?? ''), 'pinned noBuild release analyzer required');
  const expected = path.join(analyzer.workspaceRoot, 'target', 'release', 'omni-benchmark.exe');
  check(path.resolve(expected).toLowerCase() === path.resolve(analyzer.releaseExecutablePath).toLowerCase(), 'analyzer is not workspace target/release/omni-benchmark.exe');
  noRedirect(expected);
  const stat = fs.statSync(expected);
  check(stat.isFile() && stat.size > 0 && stat.size <= 512 * 1024 * 1024
    && sha(fs.readFileSync(expected)) === analyzer.releaseExecutableSha256, 'release analyzer SHA256 mismatch');
  return expected;
}

// Schema2 intentionally inserts recorded physical prefix blocks between linear
// reference spans on one continuous client. The old diagnostic completeness
// helper assumes no such gaps, so validate this local inventory independently;
// reconstruct() later proves each omitted span is exactly a recorded zero prefix.
// This never promotes the old diagnostic/retainedPCM evidence into release data.
function nativeTapSeal(root, terminal) {
  const terminalBytes = raw(root, 'aec-terminal.json', MAX_TEXT);
  check(isDeepStrictEqual(parse(terminalBytes), terminal), 'tap terminal differs from native receipt');
  check(!fs.existsSync(path.join(root, 'aec-terminal.json.partial')) && terminal?.schemaVersion === 2
    && terminal.kind === 'terminal' && terminal.status === 'complete' && terminal.complete === true
    && terminal.countsFinal === true && terminal.hashAlgorithm === 'sha256' && terminal.terminalFile === 'aec-terminal.json'
    && Array.isArray(terminal.errors) && terminal.errors.length === 0 && terminal.droppedEvents === 0,
  'tap terminal incomplete/partial/errors');
  check(Object.keys(terminal.files ?? {}).sort().join(',') === 'metadata,post,pre,render', 'tap file inventory mismatch');
  const data = {};
  for (const [lane, name] of Object.entries(AEC_TAP_FILES)) {
    const entry = terminal.files[lane];
    const bytes = raw(root, name, lane === 'metadata' ? MAX_TEXT : MAX_PCM);
    check(entry?.name === name && entry.byteLength === bytes.length && entry.sha256 === sha(bytes)
      && entry.flushed === true && entry.synced === true && entry.unwrittenBufferedBytes === 0, `${lane} bytes/hash mismatch`);
    data[lane] = bytes;
  }
  const rows = records(data.metadata);
  const counts = { render: 0, capture: 0, reset: 0 };
  const samples = { render: 0, pre: 0, post: 0 };
  let generation = 0;
  let resetBeforeResumeRequired = false;
  const processingContext = { ownerResetGenerations: new Map() };
  const realPre = floats(data.pre, 2);
  const realPost = floats(data.post, 2);
  for (const [i, e] of rows.entries()) {
    if (e.kind === 'reset') { generation += 1; resetBeforeResumeRequired = false; }
    check(e.schemaVersion === 3 && e.sequence === i && e.resetGeneration === generation && integer(e.continuityId), 'tap schema/sequence/reset generation invalid');
    if (e.kind === 'reset') {
      check(typeof e.reason === 'string' && e.reason.length > 0 && integer(e.qpc100ns), 'tap reset metadata invalid'); counts.reset += 1;
    } else if (e.kind === 'render-reference') {
      check(e.sampleRateHz === RATE && e.channelCount === 2 && e.sampleOffset === samples.render
        && integer(e.sampleCount) && e.sampleCount > 0 && e.sampleCount % 2 === 0
        && ['qpc100ns', 'renderSessionId', 'ownerGeneration', 'physicalPrefixOffsetFrames', 'referenceStartFrame',
          'referenceEndFrame', 'playedFrames', 'submittedFrames', 'endpointPaddingFrames'].every((key) => integer(e[key]))
        && e.referenceEndFrame - e.referenceStartFrame === e.sampleCount / 2
        && e.referenceEndFrame === e.submittedFrames && e.endpointPaddingFrames <= e.submittedFrames
        && e.playedFrames === e.submittedFrames - e.endpointPaddingFrames, 'tap render frame/submit/owner metadata invalid');
      samples.render += e.sampleCount; counts.render += 1;
    } else if (e.kind === 'capture') {
      check(e.sampleRateHz === RATE && e.channelCount === 2 && e.preSampleOffset === samples.pre
        && e.postSampleOffset === samples.post && integer(e.preSampleCount) && e.preSampleCount > 0
        && e.preSampleCount % 2 === 0 && e.preSampleCount === e.postSampleCount
        && integer(e.delaySamples) && (e.observedQpc100ns === null || integer(e.observedQpc100ns))
        && e.timestampError === false && e.dataDiscontinuity === false && e.queueHeadClockValid === true
        && integer(e.queueHeadDeviceFrameIndex) && integer(e.queueHeadQpc100ns)
        && integer(e.packetDeviceFrameIndex) && e.packetDeviceFrameIndex === e.rawPacketDeviceFrameIndex
        && integer(e.packetQpc100ns) && e.packetQpc100ns === e.rawPacketQpc100ns, 'tap capture frame/clock metadata invalid');
      check(!resetBeforeResumeRequired, 'capture resumed after partial calculation without a successful native reset');
      verifyCaptureProcessingRecord(e,
        realPre.subarray(e.preSampleOffset, e.preSampleOffset + e.preSampleCount),
        realPost.subarray(e.postSampleOffset, e.postSampleOffset + e.postSampleCount),
        { strict: true }, processingContext);
      resetBeforeResumeRequired = e.aecProcessing.resetBeforeResumeRequired;
      samples.pre += e.preSampleCount; samples.post += e.postSampleCount; counts.capture += 1;
    } else { throw new Error('unknown diagnostic tap event kind'); }
  }
  check(counts.render > 0 && counts.capture > 0 && integer(terminal.writtenEvents) && rows.length === terminal.writtenEvents
    && terminal.attemptedEvents === rows.length && terminal.acceptedEvents === rows.length
    && terminal.lastWrittenSequence === rows.length - 1 && terminal.lastAttemptedSequence === rows.length - 1
    && terminal.resetGeneration === generation && terminal.invalidClockEvents === 0
    && isDeepStrictEqual(terminal.eventCounts, counts) && isDeepStrictEqual(terminal.sampleCounts, samples), 'tap sealed accounting mismatch');
  for (const lane of ['render', 'pre', 'post']) check(data[lane].length === samples[lane] * 4, 'tap PCM missing/unreferenced frames');
  return { ...data, rows, terminalSha256: sha(terminalBytes), captureProcessingVersion: rows.some(e => e.aecProcessing?.schemaVersion === 2) ? 2 : 1,
    processingVerified: counts.capture > 0, verifiedProcessingCount: counts.capture };
}
/** Independent sealed-journal custody. Invalid formal capture clocks remain
 * visible here without being promoted to acoustic or source-clock acceptance. */
export function inspectLocalCaptureQueueEvidence(root, nativeReceipt) {
  const freezeBytes = raw(root, 'run-freeze.json', MAX_TEXT); const freeze = parse(freezeBytes);
  check(freeze.executionId === nativeReceipt.executionId
    && freeze.captureQueueWitnessPolicy === AEC_CAPTURE_QUEUE_WITNESS_POLICY, 'new frozen capture queue witness policy required');
  const mainBytes = raw(root, 'aec-terminal.json', MAX_TEXT); const main = parse(mainBytes);
  check(isDeepStrictEqual(main, nativeReceipt.tap) && main.complete === true && main.countsFinal === true
    && main.errors?.length === 0 && main.droppedEvents === 0, 'main queue journal seal incomplete');
  const mainMetadata = raw(root, 'aec-frame-metadata.jsonl', MAX_TEXT);
  const mainEntry = main.files?.metadata;
  check(mainEntry?.name === 'aec-frame-metadata.jsonl' && mainEntry.sha256 === sha(mainMetadata)
    && mainEntry.byteLength === mainMetadata.length && mainEntry.flushed === true && mainEntry.synced === true
    && mainEntry.unwrittenBufferedBytes === 0, 'main queue journal hash/seal mismatch');
  const mainRows = records(mainMetadata);
  check(mainRows.length === main.writtenEvents && main.writtenEvents === main.acceptedEvents
    && main.writtenEvents === main.attemptedEvents, 'main queue journal accounting mismatch');
  const sealBytes = raw(root, 'aec-closed-loop-terminal.json', MAX_TEXT); const seal = parse(sealBytes);
  check(isDeepStrictEqual(main.closedLoop, seal) && seal.schemaVersion === 1 && seal.kind === 'aec-closed-loop-terminal'
    && seal.complete === true && seal.countsFinal === true && seal.errors?.length === 0 && seal.droppedEvents === 0
    && !fs.existsSync(path.join(root, 'aec-closed-loop-terminal.json.partial')), 'queue sidecar seal incomplete/mismatched');
  check(Object.keys(seal.files ?? {}).sort().join(',') === 'metadata,physical,provider', 'queue sidecar file inventory mismatch');
  let sidecarBytes; const sidecarLengths = {};
  const filenames = { metadata: 'aec-closed-loop-metadata.jsonl', physical: 'aec-physical-output-48k-stereo.f32le', provider: 'aec-provider-input.s16le' };
  for (const [lane,name] of Object.entries(filenames)) {
    const file = path.join(root,name); noRedirect(file); const stat = fs.statSync(file);
    const limit = lane === 'metadata' ? AEC_CLOSED_LOOP_METADATA_MAX_BYTES : MAX_PCM;
    check(stat.isFile() && stat.size <= limit, 'queue sidecar file unbounded/nonregular');
    const bytes = fs.readFileSync(file); const entry = seal.files[lane];
    check(entry?.name === name && entry.byteLength === bytes.length && entry.sha256 === sha(bytes)
      && entry.flushed === true && entry.synced === true && entry.unwrittenBufferedBytes === 0,
    'queue sidecar bytes/hash/seal mismatch');
    sidecarLengths[lane] = bytes.length;
    if(lane === 'metadata') sidecarBytes = bytes;
  }
  const sidecarRows = records(sidecarBytes);
  verifyCapturePumpTimingSeals(root, sidecarRows);
  check(sidecarRows.length === seal.writtenEvents && seal.writtenEvents === seal.acceptedEvents
    && seal.writtenEvents === seal.attemptedEvents, 'queue sidecar event accounting mismatch');
  const counts = { physicalEvents:0,providerEvents:0,lifecycleEvents:0,physicalSamples:0,providerSamples:0 };
  for(const row of sidecarRows) {
    if(row.kind === 'physical-output' || row.kind === 'provider-input') {
      const physical = row.kind === 'physical-output';
      const sampleKey = physical ? 'physicalSamples' : 'providerSamples';
      const eventKey = physical ? 'physicalEvents' : 'providerEvents';
      check(integer(row.sampleCount) && row.sampleCount > 0 && row.sampleOffset === counts[sampleKey],
        'queue sidecar PCM offset/sample accounting mismatch');
      counts[eventKey] += 1; counts[sampleKey] += row.sampleCount;
    } else counts.lifecycleEvents += 1;
  }
  check(Object.entries(counts).every(([key,value]) => seal[key] === value)
    && counts.physicalSamples * 4 === sidecarLengths.physical
    && counts.providerSamples * 2 === sidecarLengths.provider, 'queue sidecar classification/sample accounting mismatch');
  check(counts.providerEvents === 0 && counts.providerSamples === 0 && sidecarLengths.provider === 0,
    'local zero-provider sidecar contains actual provider input');
  const physical = nativeReceipt.streamEvidence?.physical;
  check(counts.physicalEvents > 0 && counts.physicalSamples === physical?.sampleCount
    && sidecarLengths.physical === physical.bytes && seal.files.physical.sha256 === physical.sha256,
    'queue sidecar physical PCM differs from owned local stream recording');
  const projection = validateCaptureQueueLedger(sidecarRows, mainRows, { required: true, requireTimeSegments: true });
  return { ...projection, terminalSha256: sha(sealBytes), metadataSha256: sha(sidecarBytes),
    mainTerminalSha256: sha(mainBytes), mainMetadataSha256: sha(mainMetadata), freezeSha256: sha(freezeBytes) };
}

function inputFile(file, expectedHash, limit) {
  check(typeof file === 'string' && path.isAbsolute(file) && /^[a-f0-9]{64}$/u.test(expectedHash ?? ''), 'input file path/hash authority missing');
  noRedirect(file); const stat = fs.statSync(file);
  check(stat.isFile() && stat.size > 0 && stat.size <= limit, 'input file unbounded/empty');
  const bytes = fs.readFileSync(file);
  check(bytes.length === stat.size && sha(bytes) === expectedHash, 'original input raw hash mismatch');
  return bytes;
}

// Verify original API fixture and every admitted delta against the actual native
// interpolation sequence. This is waveform custody only, not a new AEC metric.
function stimulusCustody(root, receipt, events, linearBytes) {
  const requestBytes = raw(root, 'request.json', MAX_TEXT); const request = parse(requestBytes);
  check(request.schemaVersion === 2 && request.executionId === receipt.executionId
    && path.resolve(request.outputDirectory) === root && request.physicalDeviceId === receipt.render.deviceId
    && request.renderPcmSha256 === receipt.sourcePcmSha256, 'request/native stimulus identity/hash mismatch');
  const sim = request.speechSimulation;
  check(sim?.chunkFrames === 2400 && sim.chunkIntervalMs === 100 && integer(sim.stageDurationMs)
    && sim.stageDurationMs > 0 && integer(sim.deadlineMs) && sim.deadlineMs <= 180000
    && receipt.speechSimulation?.chunkFrames === sim.chunkFrames && receipt.speechSimulation.chunkIntervalMs === sim.chunkIntervalMs
    && receipt.speechSimulation.stageDurationMs === sim.stageDurationMs && receipt.speechSimulation.deadlineMs === sim.deadlineMs
    && receipt.speechSimulation.originalPcmSha256 === request.renderPcmSha256,
  'simulation cadence/phase/deadline request authority missing');
  const cadence = receipt.speechSimulation.deltaCadence;
  check(cadence?.schemaVersion === 1 && cadence.policy === 'absolute-sample-clock/v1'
    && cadence.intervalMs === 100 && integer(cadence.originQpc100ns) && cadence.originQpc100ns > 0
    && cadence.maximumLatenessMicros === 100000 && cadence.singleAdmissionPerPump === true,
  'absolute sample clock v1 delta cadence contract missing/invalid');
  const original = inputFile(request.renderPcmPath, request.renderPcmSha256, 24000 * 2 * 180);
  check(original.length % (2400 * 2) === 0 && receipt.sourcePcmFrames === original.length / 2
    && receipt.render.sourcePcmFrames === original.length / 2, 'original PCM frames cropped or repeated');
  const complete = receipt.sourceMediaComplete;
  check(complete.receipt?.mediaPath === sim.sourceWavPath && complete.sourceWavSha256 === sim.sourceWavSha256 && complete.injectorExecutableSha256 === sim.injectorExecutableSha256,
    'source input/executable not bound to request');
  const wav = inputFile(sim.sourceWavPath, sim.sourceWavSha256, 64 * 1024 * 1024);
  const exe = inputFile(sim.injectorExecutable, sim.injectorExecutableSha256, 256 * 1024 * 1024);
  check(wav.subarray(0, 4).toString('ascii') === 'RIFF' && exe.subarray(0, 2).toString('ascii') === 'MZ', 'source original input format mismatch');
  const completeEvent = events.find((e) => e.kind === 'source-media-complete');
  const deltas = events.filter((e) => e.kind === 'simulated-audio.delta');
  check(deltas.length > 0 && receipt.simulationDeltaCount === deltas.length, 'simulated delta journal/count missing');
  const reference = floats(linearBytes, 2);
  let sourceFrame = 0; let referenceFrame = 0; let waitingFrames = 0; let previous;
  const emit = (sample) => {
    check(referenceFrame * 2 + 1 < reference.length && reference[referenceFrame * 2] === sample
      && reference[referenceFrame * 2 + 1] === sample, 'actual linear reference not generated from admitted original PCM deltas');
    referenceFrame += 1;
  };
  let previousAdmissionMicros = 0; let previousAdmissionQpc = cadence.originQpc100ns;
  for (const [i, e] of deltas.entries()) {
    // Due times are tied to source samples, never to the previous pump's actual
    // admission. A late admission may legitimately be followed by a <100ms gap.
    check(e.cadenceVersion === 1 && integer(e.scheduledOffsetMicros) && e.scheduledOffsetMicros === i * 100000
      && integer(e.admissionOffsetMicros) && integer(e.latenessMicros)
      && e.latenessMicros === e.admissionOffsetMicros - e.scheduledOffsetMicros
      && e.latenessMicros < cadence.maximumLatenessMicros
      && (i === 0 || e.admissionOffsetMicros > previousAdmissionMicros),
    'delta absolute sample clock cadence offset/lateness invalid');
    check(integer(e.admissionQpc100ns) && e.admissionQpc100ns > 0
      && e.admissionQpc100ns >= cadence.originQpc100ns
      && (i === 0 || e.admissionQpc100ns > previousAdmissionQpc)
      && Math.abs((e.admissionQpc100ns - cadence.originQpc100ns) / 10 - e.admissionOffsetMicros) <= CADENCE_CLOCK_BOUND_MICROS,
    'delta cadence QPC origin/Instant clock mismatch or regression');
    check(integer(e.intervalMs) && e.intervalMs === Math.floor((e.admissionOffsetMicros - previousAdmissionMicros) / 1000),
      'delta cadence intervalMs inconsistent with actual admission offsets');
    previousAdmissionMicros = e.admissionOffsetMicros; previousAdmissionQpc = e.admissionQpc100ns;
    const waiting = e.explicitWaitingSilence;
    check(e.chunkIndex === i && e.frames === 2400 && e.sourceStartFrame === sourceFrame
      && typeof waiting === 'boolean' && e.sourceEndFrame === sourceFrame + (waiting ? 0 : 2400)
      && e.afterMediaComplete === (e.sequence > completeEvent.sequence), 'delta order/cadence/source-completion ownership mismatch');
    if (waiting) {
      check(integer(sim.tailStartFrame) && sourceFrame >= sim.tailStartFrame && e.sequence < completeEvent.sequence, 'unjustified waiting silence');
      waitingFrames += 2400;
    } else check(e.sourceEndFrame <= original.length / 2, 'delta source frames missing/repeated');
    const chunk = waiting ? Buffer.alloc(4800) : original.subarray(sourceFrame * 2, e.sourceEndFrame * 2);
    check(sha(chunk) === e.pcmSha256, 'original simulated delta raw hash mismatch');
    for (let j = 0; j < 2400; j += 1) {
      const next = Math.fround(chunk.readInt16LE(j * 2) / 32767);
      if (previous === undefined) emit(next);
      else { emit(Math.fround(previous + Math.fround(Math.fround(next - previous) * 0.5))); emit(next); }
      previous = next;
    }
    if (!waiting) sourceFrame += 2400;
  }
  emit(previous);
  check(sourceFrame * 2 === original.length && referenceFrame * 2 === reference.length
    && receipt.render.acceptedSimulationPcmFrames === sourceFrame + waitingFrames
    && receipt.render.waitingSilenceSourceFrames === waitingFrames && referenceFrame === (sourceFrame + waitingFrames) * 2,
  'exhaustive original/delta/linear native frame coverage incomplete');
  const completed = events.filter((e) => e.kind === 'stage-lifecycle' && e.status === 'completed');
  check(completed.length === 3 && completed.slice(0, 2).every((e) => e.referenceFrames === sim.stageDurationMs * 48)
    && completed[2].referenceFrames === referenceFrame - sim.stageDurationMs * 96, 'request phase duration does not match physical stages');
  const freezeBytes = raw(root, 'run-freeze.json', MAX_TEXT); const freeze = parse(freezeBytes);
  check(freeze.executionId === receipt.executionId && freeze.scope === LOCAL_AEC_SPEECH_SCOPE && freeze.releaseEligible === false
    && freeze.providerCalls === 0 && freeze.translationProviderCalls === 0 && freeze.requestSha256 === sha(requestBytes)
    && freeze.injectorSha256 === sim.injectorExecutableSha256 && freeze.inputWatchdogMs === 180000
    && freeze.thresholds?.echoAttenuationDb === AEC_CLOSED_LOOP_THRESHOLDS.echoAttenuationDb
    && freeze.thresholds.sourceGainToleranceDb === AEC_CLOSED_LOOP_THRESHOLDS.sourceGainToleranceDb
    && freeze.thresholds.sourceCoverage === AEC_CLOSED_LOOP_THRESHOLDS.sourceCoverage,
  'local frozen request/threshold/provider/watchdog metadata mismatch');
  return { requestSha256: sha(requestBytes), freezeSha256: sha(freezeBytes), originalPcmSha256: sha(original),
    deltaCount: deltas.length, waitingFrames, originalFrames: sourceFrame,
    inputFiles: [[request.renderPcmPath, sha(original), 24000 * 2 * 180], [sim.sourceWavPath, sha(wav), 64 * 1024 * 1024],
      [sim.injectorExecutable, sha(exe), 256 * 1024 * 1024]] };
}
function nativeStartReadiness(root, receipt, endpoint) {
  const bytes = raw(root, 'local-aec-ready.json', MAX_TEXT); const ready = parse(bytes);
  check(ready.schemaVersion === 2 && ready.artifactKind === 'watch-mode-local-aec-ready'
    && ready.scope === LOCAL_AEC_SPEECH_SCOPE && ready.executionId === receipt.executionId
    && ready.physicalDeviceId === endpoint && ready.providerCalls === 0 && ready.releaseEligible === false
    && ready.readinessPhase === 'native-stream-started' && ready.nativeStartAcknowledged === true,
  'current native Start-success acknowledgement missing');
  const capture = ready.capture;
  check(capture?.countsFinal === false && capture.effectiveDeviceId === endpoint && capture.requestedDeviceId === endpoint
    && integer(capture.framesCaptured) && capture.lastError == null && capture.lastErrorCode == null,
  'native Start readiness capture endpoint/state mismatch');
  const start = receipt.sourceMediaStarted ?? receipt.sourceMediaStart;
  check(integer(ready.readyAtMs) && integer(start?.startedAtMs) && start.startedAtMs >= ready.readyAtMs,
  'source started before native capture Start acknowledged');
  return { sha256: sha(bytes), readyAtMs: ready.readyAtMs, framesAtArm: capture.framesCaptured,
    phase: ready.readinessPhase, nativeStartAcknowledged: true, qualityAcceptance: false };
}
function sourceTimeline(root, receipt, events, endpoint) {
  const complete = receipt.sourceMediaComplete;
  const start = receipt.sourceMediaStarted ?? receipt.sourceMediaStart
    ?? events.find((e) => e.kind === 'source-media-started')?.boundStart;
  check(complete?.spawnedByNative === true && complete.exitCode === 0 && complete.providerCalls === 0
    && start?.executionId === receipt.executionId && start.physicalDeviceId === endpoint && integer(start.processId) && start.processId > 0,
  'same-run native-owned source injector receipt missing');
  const starts = events.filter((e) => e.kind === 'source-media-started');
  check(starts.length === 1 && isDeepStrictEqual(starts[0].boundStart, start)
    && (receipt.sourceMediaStart === undefined || isDeepStrictEqual(receipt.sourceMediaStart, start)), 'source start not bound to owned native journal');
  const rawReceipt = raw(root, 'local-aec-source-media-receipt.json', MAX_TEXT);
  check(sha(rawReceipt) === complete.sha256, 'source receipt raw hash mismatch');
  const injector = parse(rawReceipt);
  check(isDeepStrictEqual(injector, complete.receipt) && injector.endpointId === endpoint && injector.processId === start.processId
    && injector.renderSampleRateHz === RATE && injector.zeroPaddingUnderrunCount === 0 && injector.detail === null,
  'source endpoint/process/raw receipt mismatch');
  const pcmBytes = raw(root, injector.sourcePcm48kMonoPath);
  check(pcmBytes.length === complete.sourcePcmBytes && sha(pcmBytes) === complete.sourcePcmSha256, 'source PCM raw hash/size mismatch');
  check(complete.sourcePcmFormat === 'f32le' && complete.sourcePcmSampleRateHz === RATE && complete.sourcePcmChannelCount === 1
    && complete.sourcePcmFrames * 4 === pcmBytes.length, 'source native PCM format/frame metadata missing');
  const pcm = floats(pcmBytes, 1); // Injector actually writes mono f32le, regardless of historical filename suffix.
  check(integer(injector.renderedFrames) && injector.renderedFrames > 0 && integer(injector.postrollSilenceFrames)
    && pcm.length === injector.renderedFrames + injector.postrollSilenceFrames, 'source complete PCM frame coverage missing');
  for (let i = injector.renderedFrames; i < pcm.length; i += 1) check(pcm[i] === 0, 'source declared postroll is not silent');
  const clockBytes = raw(root, injector.sourceClockMetadataPath, MAX_TEXT);
  check(sha(clockBytes) === (injector.sourceClockMetadataSha256 ?? complete.sourceClockSha256), 'source clock raw hash authority missing/mismatched');
  const clock = records(clockBytes);
  check(clock.length >= 2 && integer(injector.sourcePlaybackStartQpc100ns) && injector.sourcePlaybackStartQpc100ns > 0
    && Number.isFinite(injector.sourceClockFrequency) && injector.sourceClockFrequency > 0, 'source IAudioClock origin/frequency missing');
  let position = -1; let qpc = -1; let submitted = -1;
  const origins = [];
  for (const [i, e] of clock.entries()) {
    check(e.schemaVersion === 1 && e.artifactKind === 'aec-source-playback-clock' && e.sequence === i
      && e.endpointId === endpoint && e.processId === start.processId && e.sampleRateHz === RATE
      && e.clockFrequency === injector.sourceClockFrequency && integer(e.clockPosition) && integer(e.qpc100ns)
      && integer(e.submittedFrames) && e.submittedFrames <= pcm.length && integer(e.paddingFrames) && e.paddingFrames <= e.submittedFrames
      && e.playbackStartQpc100ns === injector.sourcePlaybackStartQpc100ns && e.clockPosition >= position
      && e.qpc100ns >= qpc && e.submittedFrames >= submitted, 'source IAudioClock identity/order/coverage invalid');
    position = e.clockPosition; qpc = e.qpc100ns; submitted = e.submittedFrames;
    if (position > 0 && qpc > 0) origins.push(qpc - position / e.clockFrequency * TICKS);
  }
  check(origins.length >= 2 && origins.every((n) => Math.abs(n - origins[0]) * RATE / TICKS <= CLOCK_BOUND_FRAMES
    && Math.abs(n - injector.sourcePlaybackStartQpc100ns) * RATE / TICKS <= CLOCK_BOUND_FRAMES), 'source IAudioClock drift/false onset');
  const origin = origins[0];
  const end = origin + pcm.length * TICKS / RATE;
  const last = clock.at(-1);
  check(last.submittedFrames === pcm.length && last.paddingFrames === 0
    && last.clockPosition / last.clockFrequency * RATE >= pcm.length && last.qpc100ns >= end,
  'source natural end not actually crossed/drained; unknown source frames cannot become zero');
  const sourceEvent = events.filter((e) => e.kind === 'source-media-complete');
  check(sourceEvent.length === 1 && isDeepStrictEqual(sourceEvent[0].boundReceipt, complete), 'source completion not bound to native event journal');
  return { pcm, origin, end, confirmedEndQpc100ns: last.qpc100ns,
    pcmSha256: sha(pcmBytes), clockSha256: sha(clockBytes), receiptSha256: sha(rawReceipt), processId: start.processId };
}

function reconstruct(root, receipt, endpoint, data) {
  const { events, physicalBytes, linearBytes, diagnostic, preBytes, postBytes, renderBytes, source } = data;
  const physicalStereo = floats(physicalBytes, 2); const linearStereo = floats(linearBytes, 2);
  const pre = mono(floats(preBytes, 2)); const post = mono(floats(postBytes, 2));
  const renders = diagnostic.filter((e) => e.kind === 'render-reference');
  const captures = diagnostic.filter((e) => e.kind === 'capture');
  const stream = receipt.streamEvidence;
  const physicalEvents = events.filter((e) => e.kind === 'physical-render');
  check(physicalEvents.length > 0, 'no actual physical-render events');
  const stages = [];
  let physicalEnd = 0; let referenceEnd = 0; let origin;
  let diagnosticRenderIndex = 0; let voicedTailFrames = 0;
  const first = physicalEvents[0];
  check(integer(first.renderSessionId) && integer(first.ownerGeneration) && typeof first.rendererInstanceId === 'string'
    && first.rendererInstanceId.length > 0 && receipt.render.rendererInstanceId === first.rendererInstanceId
    && receipt.render.ownerGeneration === first.ownerGeneration && stream.renderSessionId === first.renderSessionId,
  'physical session/renderer/owner receipt mismatch');
  for (const e of physicalEvents) {
    for (const field of ['physicalStartFrame', 'physicalEndFrame', 'referenceStartFrame', 'referenceEndFrame', 'submittedFrames', 'endpointPaddingFrames', 'qpc100ns', 'physicalPrefixOffsetFrames']) {
      check(integer(e[field]), `physical ${field} missing/invalid`);
    }
    check(e.endpointId === endpoint && e.renderSessionId === first.renderSessionId && e.ownerGeneration === first.ownerGeneration
      && e.rendererInstanceId === first.rendererInstanceId && e.sampleRateHz === RATE && e.channelCount === 2
      && e.physicalStartFrame === physicalEnd && e.physicalEndFrame > physicalEnd
      && e.referenceStartFrame === referenceEnd && e.referenceEndFrame >= referenceEnd
      && e.submittedFrames === e.physicalEndFrame && e.endpointPaddingFrames <= e.submittedFrames,
    'physical ownership/submit/frame gap or overlap');
    const nextOrigin = e.qpc100ns - (e.submittedFrames - e.endpointPaddingFrames) * TICKS / RATE;
    if (origin === undefined) origin = nextOrigin;
    check(Math.abs(nextOrigin - origin) * RATE / TICKS <= CLOCK_BOUND_FRAMES, 'render QPC clock drift/false timing');
    const plan = PLAN.find(([name]) => name === e.stage);
    check(plan && e.stageOrdinal === plan[1] && e.delayMs === plan[2] && e.nonlinearity === plan[3]
      && e.physicalPrefixOffsetFrames === plan[2] * 48, 'typed physical stage profile mismatch');
    let stage = stages.at(-1);
    if (!stage || stage.stage !== e.stage) {
      check(stages.length === plan[1] - 1, 'physical stage order/reentry mismatch');
      stage = { stage: plan[0], ordinal: plan[1], delayMs: plan[2], nonlinearity: plan[3],
        physicalStartFrame: physicalEnd, physicalEndFrame: physicalEnd, referenceStartFrame: referenceEnd,
        referenceEndFrame: referenceEnd, changedSamples: 0, events: [] };
      stages.push(stage);
    }
    const frames = e.physicalEndFrame - physicalEnd;
    const refFrames = e.referenceEndFrame - referenceEnd;
    check(refFrames === 0 || refFrames === frames, 'partial physical/linear chunk frame coverage');
    check(e.physicalEndFrame * 8 <= physicalBytes.length && e.referenceEndFrame * 8 <= linearBytes.length, 'physical/linear PCM missing frames');
    const pBytes = physicalBytes.subarray(physicalEnd * 8, e.physicalEndFrame * 8);
    const rBytes = linearBytes.subarray(referenceEnd * 8, e.referenceEndFrame * 8);
    check(sha(pBytes) === e.physicalPcmSha256 && sha(rBytes) === e.linearReferencePcmSha256, 'per-chunk raw PCM hash mismatch');
    if (refFrames === 0) {
      check(physicalEnd - stage.physicalStartFrame < stage.delayMs * 48
        && e.physicalEndFrame - stage.physicalStartFrame <= stage.delayMs * 48 && pBytes.every((n) => n === 0), 'unknown/misplaced physical silence prefix');
    } else {
      check(physicalEnd - stage.physicalStartFrame >= stage.delayMs * 48, 'delay prefix missing');
      const r = renders[diagnosticRenderIndex++];
      check(r && r.renderSessionId === e.renderSessionId && r.ownerGeneration === e.ownerGeneration
        && r.referenceStartFrame === e.physicalStartFrame && r.referenceEndFrame === e.physicalEndFrame
        && r.submittedFrames === e.submittedFrames && r.endpointPaddingFrames === e.endpointPaddingFrames
        && r.qpc100ns === e.qpc100ns && r.physicalPrefixOffsetFrames === e.physicalPrefixOffsetFrames
        && renderBytes.subarray(r.sampleOffset * 4, (r.sampleOffset + r.sampleCount) * 4).equals(rBytes),
      'diagnostic render differs from actual linear native reference');
      if (!stage.domain) stage.domain = domain(r);
      check(stage.domain === domain(r), 'phase crosses render reset/continuity ownership');
      for (let i = 0; i < frames * 2; i += 1) {
        const original = linearStereo[referenceEnd * 2 + i];
        const actual = physicalStereo[physicalEnd * 2 + i];
        const expected = stage.nonlinearity === 'soft-clip' ? transform(original) : original;
        check(Math.abs(expected - actual) <= 0.0000002, 'physical nonlinear transform/reference mismatch');
        if (!Object.is(actual, original)) stage.changedSamples += 1;
      }
    }
    const voiced = refFrames > 0 && rms(physicalStereo.subarray(physicalEnd * 2, e.physicalEndFrame * 2)) > 0.001;
    check(e.voiced === voiced && Number.isFinite(e.physicalRms)
      && Math.abs(e.physicalRms - rms(physicalStereo.subarray(physicalEnd * 2, e.physicalEndFrame * 2))) <= 1e-9
      && typeof e.afterValidatedMediaComplete === 'boolean'
      && e.afterValidatedMediaComplete === (e.sequence > events.find((row) => row.kind === 'source-media-complete').sequence), 'physical voice/tail classification mismatch');
    if (e.afterValidatedMediaComplete && voiced && origin + physicalEnd * TICKS / RATE >= source.confirmedEndQpc100ns) voicedTailFrames += frames;
    physicalEnd = e.physicalEndFrame; referenceEnd = e.referenceEndFrame;
    stage.physicalEndFrame = physicalEnd; stage.referenceEndFrame = referenceEnd; stage.events.push(e);
  }
  check(stages.length === 3 && diagnosticRenderIndex === renders.length && physicalEnd * 8 === physicalBytes.length
    && referenceEnd * 8 === linearBytes.length && receipt.render.renderedFrames === referenceEnd,
  'three stages/exhaustive render PCM coverage incomplete');
  const life = events.filter((e) => e.kind === 'stage-lifecycle');
  check(life.length === 6 && isDeepStrictEqual(stream.stages, life.filter((e) => e.status === 'completed').map(({ sequence: _sequence, observedAtMs: _time, scope: _scope, ...rest }) => rest)), 'stage lifecycle receipt/journal mismatch');
  for (const [i, s] of stages.entries()) {
    const started = life[i * 2]; const ended = life[i * 2 + 1];
    check(started.status === 'started' && ended.status === 'completed' && started.stage === s.stage && ended.stage === s.stage
      && started.ordinal === s.ordinal && ended.ordinal === s.ordinal && started.delayMs === s.delayMs && started.nonlinearity === s.nonlinearity
      && started.referenceFrames === 0 && started.physicalFrames === 0 && started.changedSamples === 0
      && ended.delayMs === s.delayMs && ended.nonlinearity === s.nonlinearity
      && started.sequence < s.events[0].sequence && ended.sequence > s.events.at(-1).sequence
      && ended.physicalFrames === s.physicalEndFrame - s.physicalStartFrame
      && ended.referenceFrames === s.referenceEndFrame - s.referenceStartFrame
      && ended.changedSamples === s.changedSamples && (i < 2 ? s.changedSamples === 0 : s.changedSamples > 0), 'typed completed physical stage accounting mismatch');
    s.startQpc100ns = origin + s.physicalStartFrame * TICKS / RATE;
    s.endQpc100ns = origin + s.physicalEndFrame * TICKS / RATE;
  }
  check(voicedTailFrames >= RATE && stream.mediaEndVoicedPhysicalFrames >= voicedTailFrames,
    'less than one second actual voiced output after confirmed natural English end');
  check(stream.streamStartCount === 1 && stream.streamDrained === true && stream.aborted === false
    && events.filter((e) => e.kind === 'stream-activity' && e.activity === 'Completed').length === 1
    && !events.some((e) => e.kind === 'stream-activity' && e.activity === 'Aborted'), 'continuous native stream not completely drained');

  let captureOrigin; let captureEnd; let previousQpc = -1;
  for (const c of captures) {
    check(c.timestampError === false && c.dataDiscontinuity === false && c.queueHeadClockValid === true
      && integer(c.queueHeadDeviceFrameIndex) && integer(c.queueHeadQpc100ns)
      && integer(c.packetDeviceFrameIndex) && c.packetDeviceFrameIndex === c.rawPacketDeviceFrameIndex
      && integer(c.packetQpc100ns) && c.packetQpc100ns === c.rawPacketQpc100ns, 'capture clock invalid/discontinuous');
    if (captureEnd !== undefined) check(c.queueHeadDeviceFrameIndex === captureEnd, 'capture device frame gap/overlap');
    const next = c.queueHeadQpc100ns - c.queueHeadDeviceFrameIndex * TICKS / RATE;
    if (captureOrigin === undefined) captureOrigin = next;
    check(Math.abs(next - captureOrigin) * RATE / TICKS <= CLOCK_BOUND_FRAMES && c.queueHeadQpc100ns > previousQpc, 'capture QPC/device clock drift/overlap');
    previousQpc = c.queueHeadQpc100ns; captureEnd = c.queueHeadDeviceFrameIndex + c.preSampleCount / 2;
  }
  check(captures.length > 0 && receipt.capture.framesCaptured === captureEnd, 'final native capture count not covered by taps');
  const drain = receipt.captureDrain;
  check(drain?.captureRemainedOpen === true && drain.deadlineIsFailureOnly === true
    && drain.continuousQuietMs >= 2000 && drain.minimumQuietCaptureFrames >= 96_000
    && integer(drain.quietStartFrame) && integer(drain.quietEndFrame)
    && drain.quietEndFrame - drain.quietStartFrame >= 96_000 && drain.quietEndFrame <= captureEnd,
  'two seconds real open capture drain missing');
  const outputEnd = origin + physicalEnd * TICKS / RATE;
  check(captureOrigin + drain.quietStartFrame * TICKS / RATE >= Math.max(outputEnd, source.confirmedEndQpc100ns), 'quiet capture drain precedes actual source/render end');
  const quiet = new Uint8Array(drain.quietEndFrame - drain.quietStartFrame);
  let quietEnergy = 0;
  for (const c of captures) {
    const from = Math.max(drain.quietStartFrame, c.queueHeadDeviceFrameIndex);
    const to = Math.min(drain.quietEndFrame, c.queueHeadDeviceFrameIndex + c.postSampleCount / 2);
    for (let frame = from; frame < to; frame += 1) {
      const index = frame - drain.quietStartFrame;
      check(!quiet[index], 'quiet capture overlapping frames'); quiet[index] = 1;
      quietEnergy += post[c.postSampleOffset / 2 + frame - c.queueHeadDeviceFrameIndex] ** 2;
    }
  }
  check(quiet.every((n) => n === 1) && drain.quietEnergyCeilingDb === -60 && Math.sqrt(quietEnergy / quiet.length) <= 0.001, 'quiet drain raw PCM coverage/energy invalid');

  const physical = mono(physicalStereo);
  function align(s, from, to) {
    const length = to - from;
    const aligned = { pre: new Float32Array(length), post: new Float32Array(length), source: new Float32Array(length), physical: physical.slice(from, to) };
    const covered = new Uint8Array(length);
    const startQpc = origin + from * TICKS / RATE;
    for (const c of captures) {
      const offset = Math.round((c.queueHeadQpc100ns - startQpc) * RATE / TICKS);
      const lo = Math.max(0, offset); const hi = Math.min(length, offset + c.preSampleCount / 2);
      if (hi <= lo) continue;
      check(`${first.renderSessionId}:${first.ownerGeneration}:${c.resetGeneration}:${c.continuityId}` === s.domain, 'capture phase reset/continuity mismatch');
      for (let i = lo; i < hi; i += 1) {
        check(!covered[i], 'capture physical-time frame overlap'); covered[i] = 1;
        aligned.pre[i] = pre[c.preSampleOffset / 2 + i - offset];
        aligned.post[i] = post[c.postSampleOffset / 2 + i - offset];
      }
    }
    check(covered.every((n) => n === 1), 'capture physical-time missing frames/tail; unknown cannot be zero-filled');
    const sourceOffset = Math.round((startQpc - source.origin) * RATE / TICKS);
    check(sourceOffset >= 0, 'phase precedes confirmed source onset');
    for (let i = 0; i < length; i += 1) {
      const index = sourceOffset + i;
      if (index < source.pcm.length) aligned.source[i] = source.pcm[index];
      else check(startQpc + i * TICKS / RATE >= source.end, 'unknown source frame cannot be zero-filled');
    }
    return { stage: s.stage, ordinal: s.ordinal, startQpc100ns: startQpc, endQpc100ns: startQpc + length * TICKS / RATE,
      physicalStartFrame: from, physicalEndFrame: to, ...aligned };
  }
  const aligned = stages.map((s) => align(s, s.physicalStartFrame, s.physicalEndFrame));
  const final = stages.at(-1);
  const tailStart = Math.max(final.physicalStartFrame, Math.ceil((source.confirmedEndQpc100ns - origin) * RATE / TICKS));
  check(tailStart < physicalEnd, 'no actual source-ended output tail');
  const tail = align(final, tailStart, physicalEnd); tail.stage = 'source-ended-voiced-tail';
  check(tail.source.every((n) => n === 0), 'source-ended tail still contains source frames');
  aligned.push(tail);
  return { aligned, clocks: { renderOriginQpc100ns: origin, captureOriginQpc100ns: captureOrigin,
    sourceOriginQpc100ns: source.origin, sourceEndQpc100ns: source.end, sourceEndConfirmedQpc100ns: source.confirmedEndQpc100ns },
  voicedTailFrames, drain, sourceHashes: { pcm: source.pcmSha256, clock: source.clockSha256, receipt: source.receiptSha256 } };
}

/** Strict local-only acoustic evidence. No Provider calls, builds, release eligibility or model-input claim. */
export function analyzeLocalAecSpeech(runDirectory, options = {}) {
  const result = { schemaVersion: 1, scope: LOCAL_AEC_SPEECH_SCOPE, profile: AEC_CLOSED_LOOP_PROFILE,
    passed: false, status: 'indeterminate', releaseEligible: false, providerCalls: 0,
    modelInputLeakageVerified: false, semanticLeakageChainVerified: false,
    thresholds: AEC_CLOSED_LOOP_THRESHOLDS, indeterminate: [], violations: [], stages: [] };
  let scratch;
  const attempt = (area, action) => { try { return action(); } catch (e) { result.indeterminate.push({ area, detail: e.message }); return undefined; } };
  const root = attempt('run-directory', () => { noRedirect(runDirectory); return fs.realpathSync.native(runDirectory); });
  const executable = attempt('release-analyzer', () => pinAnalyzer(options.analyzer));
  const receipt = options.nativeReceipt;
  attempt('native-receipt', () => {
    check(receipt?.schemaVersion === 2 && receipt.artifactKind === 'watch-mode-local-aec-probe' && receipt.scope === LOCAL_AEC_SPEECH_SCOPE
      && receipt.releaseEligible === false && receipt.providerCalls === 0 && receipt.recognitionSenderAttached === false
      && typeof options.expectedExecutionId === 'string' && options.expectedExecutionId.length > 0
      && receipt.executionId === options.expectedExecutionId && path.basename(root ?? '') === receipt.executionId
      && typeof options.expectedPhysicalDeviceId === 'string' && options.expectedPhysicalDeviceId.length > 0,
    'schema2 local-only scope/execution/zero-provider receipt authority missing');
    check(!Object.keys(receipt).some((key) => /paidProvider|firstPaidProvider|providerSessionIds/iu.test(key)), 'paid-provider authority forbidden for local simulation');
    check(receipt.failure === null && receipt.cleanupError === null && receipt.tapError === null
      && receipt.sourceInjectorCleanupError === null && receipt.capture?.lastError === null
      && receipt.capture?.lastErrorCode === null && receipt.capture.countsFinal === true
      && receipt.capture.sampleRateHz === RATE && receipt.capture.channelCount === 2,
    'native failure/cleanup/capture-final metadata missing');
    const endpoint = options.expectedPhysicalDeviceId;
    check(receipt.capture.requestedDeviceId === endpoint && receipt.capture.effectiveDeviceId === endpoint
      && ['requestedDeviceId', 'effectiveDeviceId', 'deviceId'].every((key) => receipt.render?.[key] === endpoint)
      && receipt.render.sampleRateHz === RATE && receipt.render.channelCount === 2, 'capture/render endpoint ownership mismatch');
  });
  if (!root || !receipt) return result;
  const pump = attempt('render-pump-full-run', () => {
    check(receipt.render?.renderSessionId === receipt.streamEvidence?.renderSessionId, 'render/stream session identity mismatch');
    const value = validateNativePumpDecisionReceipt(receipt.nativePumpDecisions, {
      renderSessionId: receipt.streamEvidence?.renderSessionId, ownerGeneration: receipt.render?.ownerGeneration,
      endpointId: options.expectedPhysicalDeviceId, rendererInstanceId: receipt.render?.rendererInstanceId,
    });
    check(value.valid, 'full-run render pump decision evidence: ' + (value.failures?.join('; ') ?? 'invalid'));
    check(value.knownUnderrunDecisionCount === 0, 'recorded full-run render underrun');
    check(value.otherStageDecisionCount === 0, 'full-run render decision outside known stages');
    return value;
  });
  if (pump) result.renderPumpDecisionDiagnostic = pump;
  attempt('workspace-ownership', () => check(root.startsWith(path.resolve(options.analyzer?.workspaceRoot ?? '') + path.sep), 'run directory outside analyzer workspace'));
  const readiness = root && attempt('native-start-readiness', () => nativeStartReadiness(root, receipt, options.expectedPhysicalDeviceId));
  if (readiness) result.nativeStartReadiness = readiness;
  const queueEvidence = attempt('capture-queue-ledger', () => inspectLocalCaptureQueueEvidence(root, receipt));
  if(queueEvidence) result.captureQueueLedger = queueEvidence;
  const tap = attempt('tap-seal', () => nativeTapSeal(root, receipt.tap));
  if (tap) result.tapEvidence = { complete: true, terminalSha256: tap.terminalSha256,
    captureProcessingVersion: tap.captureProcessingVersion, processingVerified: tap.processingVerified,
    verifiedProcessingCount: tap.verifiedProcessingCount };
  const physicalBytes = attempt('physical-seal', () => sealed(root, receipt.streamEvidence?.physical));
  const linearBytes = attempt('linear-reference-seal', () => sealed(root, receipt.streamEvidence?.linearReference));
  const events = attempt('stream-event-seal', () => {
    const rows = records(sealed(root, receipt.streamEvidence?.events, true));
    check(rows.length === receipt.streamEvidence.events.eventCount && rows.every((e, i) => e.sequence === i && e.scope === LOCAL_AEC_SPEECH_SCOPE), 'native stream event sequence/scope mismatch');
    return rows;
  });
  const source = events && attempt('source-clock-seal', () => sourceTimeline(root, receipt, events, options.expectedPhysicalDeviceId));
  const stimulus = events && linearBytes && attempt('original-stimulus-custody', () => stimulusCustody(root, receipt, events, linearBytes));
  if (!readiness || !queueEvidence || !tap || !physicalBytes || !linearBytes || !events || !source || !stimulus || !executable || result.indeterminate.length) return result;
  const built = attempt('native-clock-reconstruction', () => reconstruct(root, receipt, options.expectedPhysicalDeviceId, {
    events, physicalBytes, linearBytes, source, diagnostic: tap.rows,
    preBytes: tap.pre, postBytes: tap.post, renderBytes: tap.render,
  }));
  if (!built) return result;
  result.clocks = built.clocks; result.sourceHashes = built.sourceHashes; result.voicedTailFrames = built.voicedTailFrames;
  const { inputFiles: _inputFiles, ...stimulusProof } = stimulus; result.stimulusCustody = stimulusProof;
  result.openCaptureDrain = built.drain; result.analyzerExecutableSha256 = options.analyzer.releaseExecutableSha256;
  try {
    // Only scratch files below the explicitly authorized run tree. Never rebuild the binary.
    scratch = fs.mkdtempSync(path.join(root, 'local-analysis-'));
    for (const [i, range] of built.aligned.entries()) {
      const request = { sampleRateHz: RATE };
      for (const key of ['pre', 'post', 'source', 'physical']) {
        request[key] = path.join(scratch, `${i}-${key}.f32le`);
        fs.writeFileSync(request[key], floatBytes(range[key]), { flag: 'wx' });
      }
      const requestPath = path.join(scratch, `${i}-request.json`);
      fs.writeFileSync(requestPath, JSON.stringify(request), { flag: 'wx' });
      pinAnalyzer(options.analyzer);
      const run = spawnSync(executable, ['audio', 'aec-closed-loop', '--request', requestPath], {
        cwd: options.analyzer.workspaceRoot, windowsHide: true, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
      });
      pinAnalyzer(options.analyzer);
      check(run.status === 0 && !run.error, `release analyzer failed: ${run.error?.message ?? run.stderr}`);
      const metrics = JSON.parse(run.stdout);
      check(metrics.profile === AEC_CLOSED_LOOP_PROFILE && isDeepStrictEqual(metrics.thresholds, AEC_CLOSED_LOOP_THRESHOLDS)
        && metrics.sampleRateHz === RATE && metrics.sampleCount === range.pre.length
        && typeof metrics.passed === 'boolean' && Array.isArray(metrics.violations) && Array.isArray(metrics.windows)
        && metrics.windows.length > 0, 'release analyzer output profile/threshold/range incomplete');
      let covered = 0;
      for (const w of metrics.windows) {
        check(w.startSample === covered && integer(w.sampleCount) && w.sampleCount > 0
          && typeof w.valid === 'boolean' && typeof w.passed === 'boolean', 'analyzer window coverage invalid');
        covered += w.sampleCount;
      }
      check(covered === range.pre.length, 'analyzer cropped tail');
      if (i < 3 && !(metrics.sourceSampleCount > 0 && typeof metrics.sourceCoverage === 'number')) {
        result.indeterminate.push({ area: range.stage, detail: 'phase has no identifiable active English preservation windows' });
      }
      if (metrics.windows.some((w) => !w.valid) || metrics.violations.some((v) => /insufficient valid echo windows|unidentifiable/u.test(v))) {
        result.indeterminate.push({ area: range.stage, detail: 'unidentifiable or insufficient valid acoustic windows; not an attenuation success' });
      }
      if (i === 3) check(metrics.sourceSampleCount === 0 && metrics.sourceCoverage === null, 'tail incorrectly credited with English preservation');
      const { pre: _pre, post: _post, source: _source, physical: _physical, ...identity } = range;
      result.stages.push({ ...identity, ...metrics });
      if (!metrics.passed || metrics.violations.length || metrics.windows.some((w) => !w.valid || !w.passed)) {
        result.violations.push(...metrics.violations.map((v) => `${range.stage}: ${v}`));
        if (!metrics.violations.length) result.violations.push(`${range.stage}: incomplete/failed window metrics`);
      }
    }
    // Recheck all raw custody after metric execution; changed evidence cannot certify an older snapshot.
    check(nativeStartReadiness(root, receipt, options.expectedPhysicalDeviceId).sha256 === readiness.sha256, 'native Start readiness changed during analysis');
    const finalQueueEvidence = inspectLocalCaptureQueueEvidence(root, receipt);
    check(isDeepStrictEqual(finalQueueEvidence, queueEvidence), 'capture queue evidence changed during analysis');
    const finalTap = nativeTapSeal(root, receipt.tap);
    check(finalTap.terminalSha256 === tap.terminalSha256, 'tap terminal changed during analysis');
    sealed(root, receipt.streamEvidence.physical); sealed(root, receipt.streamEvidence.linearReference); sealed(root, receipt.streamEvidence.events, true);
    const finalSource = sourceTimeline(root, receipt, events, options.expectedPhysicalDeviceId);
    check(finalSource.pcmSha256 === source.pcmSha256 && finalSource.clockSha256 === source.clockSha256 && finalSource.receiptSha256 === source.receiptSha256, 'source changed during analysis');
    check(sha(raw(root, 'request.json', MAX_TEXT)) === stimulus.requestSha256 && sha(raw(root, 'run-freeze.json', MAX_TEXT)) === stimulus.freezeSha256, 'local request/freeze changed during analysis');
    for (const [file, digest, limit] of stimulus.inputFiles) inputFile(file, digest, limit);
    result.passed = result.stages.length === 4 && !result.violations.length && !result.indeterminate.length;
    result.status = result.indeterminate.length ? 'indeterminate' : result.passed ? 'passed' : 'failed';
  } catch (e) { result.indeterminate.push({ area: 'release-analyzer', detail: e.message }); result.passed = false; result.status = 'indeterminate'; }
  finally {
    if (scratch) {
      // Fixed absolute descendant, verified immediately before native recursive removal.
      check(path.dirname(scratch) === root && path.basename(scratch).startsWith('local-analysis-'), 'unsafe scratch cleanup target');
      noRedirect(scratch); fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2); const values = {};
    for (let i = 0; i < args.length; i += 2) {
      check(args[i]?.startsWith('--') && args[i + 1] && !Object.hasOwn(values, args[i]), 'invalid CLI option/value');
      values[args[i]] = args[i + 1];
    }
    const allowed = ['--run-directory', '--receipt', '--execution-id', '--endpoint-id', '--analyzer', '--analyzer-sha256', '--workspace-root', '--report'];
    check(allowed.every((key) => values[key]) && Object.keys(values).every((key) => allowed.includes(key)), 'missing/unknown CLI arguments');
    const report = analyzeLocalAecSpeech(values['--run-directory'], {
      nativeReceipt: parse(fs.readFileSync(values['--receipt'])), expectedExecutionId: values['--execution-id'], expectedPhysicalDeviceId: values['--endpoint-id'],
      analyzer: { workspaceRoot: values['--workspace-root'], releaseExecutablePath: values['--analyzer'], releaseExecutableSha256: values['--analyzer-sha256'], noBuild: true },
    });
    const reportPath = path.resolve(values['--report']); const workspace = path.resolve(values['--workspace-root']);
    check(reportPath.startsWith(`${workspace}${path.sep}`), 'report outside authorized workspace');
    noRedirect(path.dirname(reportPath)); fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' });
    console.log(JSON.stringify(report)); process.exitCode = report.passed ? 0 : 1;
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
