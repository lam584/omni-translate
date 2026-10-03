import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeLocalAecSpeech, inspectLocalCaptureQueueEvidence, LOCAL_AEC_SPEECH_SCOPE } from './local-aec-speech-analysis.mjs';
import { AEC_TAP_FILES } from './watch-mode-aec-tap-evidence.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executable = path.join(workspace, 'target/release/omni-benchmark.exe');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const analyzer = { workspaceRoot: workspace, releaseExecutablePath: executable,
  releaseExecutableSha256: sha(fs.readFileSync(executable)), noBuild: true };
const RATE = 48_000; const ORIGIN = 1_000_000_000; const ENDPOINT = '{0.0.0.00000000}.local-real-endpoint';
const clock = (frame) => ORIGIN + frame * 10_000_000 / RATE;
const f32 = (samples) => { const bytes = Buffer.alloc(samples.length * 4); samples.forEach((n, i) => bytes.writeFloatLE(n, i * 4)); return bytes; };
const soft = (n) => { const d = Math.fround(n * 2.4); return Math.fround(Math.max(-0.92, Math.min(0.92, Math.fround(Math.fround(d / Math.fround(1 + Math.abs(d))) * 1.35)))); };
const jsonl = (rows) => Buffer.from(rows.map((e) => JSON.stringify(e)).join('\n') + '\n');

function fixture(t, variant = 'good') {
  const base = path.join(workspace, 'artifacts/testing/aec-iteration/capture-pump-consumer-local-tests');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'local-aec-test-'));
  t.after(() => { assert.equal(path.dirname(root), base); fs.rmSync(root, { recursive: true, force: true }); });
  const executionId = path.basename(root);
  const write = (name, bytes) => { fs.writeFileSync(path.join(root, name), bytes); return path.join(root, name); };
  let seed = 173;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.fround((seed / 2 ** 32 - 0.5) * 0.22); };
  const source = new Float32Array(RATE * 3);
  for (let i = 0; i < source.length; i += 1) source[i] = random();
  const originalPcm = Buffer.alloc(RATE * 2 * 2);
  const interpolated = [];
  let previous;
  for (let i = 0; i < originalPcm.length / 2; i += 1) {
    const value = random();
    const limitedEcho = variant === 'insufficient-echo' && i < 48000 && i % 24000 >= 2400;
    const n = limitedEcho ? 0 : Math.trunc(value * 32767); originalPcm.writeInt16LE(n, i * 2);
    const next = Math.fround(n / 32767);
    if (previous === undefined) interpolated.push(next);
    else interpolated.push(Math.fround(previous + Math.fround(Math.fround(next - previous) * 0.5)), next);
    previous = next;
  }
  interpolated.push(previous);
  const physical = []; const linear = []; const pre = []; const post = []; const events = []; const diagnostic = []; const stageReceipts = [];
  const add = (e) => { events.push({ ...e, sequence: events.length, observedAtMs: 99_999 + events.length, scope: LOCAL_AEC_SPEECH_SCOPE }); };
  const owner = { renderSessionId: 1, ownerGeneration: 2, rendererInstanceId: 'native-renderer' };
  const plans = [['double-talk', 0, 'none', RATE], ['dynamic-delay', 80, 'none', RATE], ['nonlinear', 160, 'soft-clip', RATE * 2]];
  let physicalFrame = 0; let referenceFrame = 0; let renderSampleOffset = 0; let voicedTail = 0;
  for (const [index, [stage, delayMs, nonlinearity, referenceFrames]] of plans.entries()) {
    const delay = delayMs * 48; let changed = 0;
    add({ kind: 'stage-lifecycle', status: 'started', stage, ordinal: index + 1, delayMs, nonlinearity,
      referenceFrames: 0, physicalFrames: 0, changedSamples: 0, changedRatio: 0, startedAtMs: 999, completedAtMs: 0 });
    for (let local = 0; local < referenceFrames + delay; local += 480) {
      const ref = []; const phys = [];
      for (let n = 0; n < 480; n += 1) {
        const original = local >= delay ? interpolated[referenceFrame + n] : 0;
        const echo = nonlinearity === 'soft-clip' ? soft(original) : original;
        if (local >= delay) { ref.push(original, original); linear.push(original, original); if (echo !== original) changed += 2; }
        phys.push(echo, echo); physical.push(echo, echo);
        const s = source[physicalFrame + n] ?? 0;
        const p = Math.fround(s + Math.fround(echo * 0.5));
        let q = Math.fround(s + Math.fround(echo * 0.001));
        if (variant === 'zero-post') q = 0;
        if (variant === 'passthrough') q = p;
        if (variant === 'all-attenuated') q = Math.fround(p * 0.01);
        if (variant === 'scattered-source-delete' && (physicalFrame + n) % 10 === 0) q = 0;
        pre.push(p, p); post.push(q, q);
      }
      const hasRef = ref.length > 0;
      if (hasRef && referenceFrame % 4800 === 0) {
        const start = referenceFrame / 2;
        add({ kind: 'simulated-audio.delta', chunkIndex: start / 2400, sourceStartFrame: start,
          sourceEndFrame: start + 2400, frames: 2400, explicitWaitingSilence: false,
          cadenceVersion: 1, scheduledOffsetMicros: start / 2400 * 100000,
          admissionOffsetMicros: start / 2400 * 100000, admissionQpc100ns: ORIGIN + start / 2400 * 1000000,
          latenessMicros: 0, afterMediaComplete: physicalFrame >= source.length, intervalMs: start === 0 ? 0 : 100,
          pcmSha256: sha(originalPcm.subarray(start * 2, (start + 2400) * 2)) });
      }
      const voiced = hasRef && Math.sqrt(phys.reduce((sum, n) => sum + n * n, 0) / phys.length) > 0.001;
      const afterSource = physicalFrame >= source.length;
      if (afterSource && voiced) voicedTail += 480;
      add({ kind: 'physical-render', ...owner, endpointId: ENDPOINT, referenceStartFrame: referenceFrame,
        referenceEndFrame: referenceFrame + ref.length / 2, physicalStartFrame: physicalFrame, physicalEndFrame: physicalFrame + 480,
        stage, stageOrdinal: index + 1, delayMs, nonlinearity, submittedFrames: physicalFrame + 480,
        endpointPaddingFrames: 480, physicalPrefixOffsetFrames: delay, qpc100ns: clock(physicalFrame),
        sampleRateHz: RATE, channelCount: 2, afterValidatedMediaComplete: afterSource, voiced,
        physicalRms: Math.sqrt(phys.reduce((sum, n) => sum + n * n, 0) / phys.length),
        physicalPcmSha256: sha(f32(phys)), linearReferencePcmSha256: sha(f32(ref)) });
      if (hasRef) {
        diagnostic.push({ schemaVersion: 3, kind: 'render-reference', sequence: diagnostic.length,
          renderSessionId: 1, ownerGeneration: 2, resetGeneration: 0, continuityId: 0,
          sampleRateHz: RATE, channelCount: 2, sampleOffset: renderSampleOffset, sampleCount: ref.length,
          qpc100ns: clock(physicalFrame), referenceStartFrame: physicalFrame, referenceEndFrame: physicalFrame + 480,
          submittedFrames: physicalFrame + 480, playedFrames: physicalFrame, endpointPaddingFrames: 480,
          physicalPrefixOffsetFrames: delay });
        renderSampleOffset += ref.length;
      }
      physicalFrame += 480; referenceFrame += ref.length / 2;
    }
    const completed = { kind: 'stage-lifecycle', status: 'completed', stage, ordinal: index + 1, delayMs, nonlinearity,
      referenceFrames, physicalFrames: referenceFrames + delay, changedSamples: changed,
      changedRatio: changed / (referenceFrames * 2), startedAtMs: 999, completedAtMs: 1000 };
    stageReceipts.push(completed); add(completed);
  }
  add({ kind: 'stream-activity', activity: 'Completed' });
  const physicalTotal = physicalFrame;
  for (let n = 0; n < RATE * 2; n += 1) { pre.push(0, 0); post.push(0, 0); }
  for (let n = 0; n < physicalTotal + RATE * 2; n += 480) {
    diagnostic.push({ schemaVersion: 3, kind: 'capture', sequence: diagnostic.length, resetGeneration: 0, continuityId: 0,
      sampleRateHz: RATE, channelCount: 2, preSampleOffset: n * 2, postSampleOffset: n * 2,
      aecProcessing: {schemaVersion:1,inputFrames:480,native10msFrames:1,mathPaddingFrames:0,
        allInputProcessed:true,resetBeforeResumeRequired:false,tailAdmission:null},
      preSampleCount: 960, postSampleCount: 960, timestampError: false, dataDiscontinuity: false, queueHeadClockValid: true,
      rawPacketDeviceFrameIndex: n, rawPacketQpc100ns: clock(n), packetDeviceFrameIndex: n, packetQpc100ns: clock(n),
      queueHeadDeviceFrameIndex: n, queueHeadQpc100ns: clock(n), observedQpc100ns: clock(n), delaySamples: 0 });
  }
  const physicalEntry = { path: write('local-aec-physical-48k-stereo.f32le', f32(physical)), sha256: sha(f32(physical)),
    sampleCount: physical.length, frameCount: physical.length / 2, bytes: physical.length * 4, sampleRateHz: RATE, channelCount: 2,
    format: 'f32le', flushed: true, synced: true };
  const linearEntry = { ...physicalEntry, path: write('local-aec-linear-reference-48k-stereo.f32le', f32(linear)),
    sha256: sha(f32(linear)), sampleCount: linear.length, frameCount: linear.length / 2, bytes: linear.length * 4 };
  const sourcePcmPath = write('local-aec-source-media-48k-mono.f32le', f32(source));
  const sourceClocks = [RATE, RATE * 2, RATE * 3].map((n, i) => ({ schemaVersion: 1,
    artifactKind: 'aec-source-playback-clock', sequence: i, processId: 171, endpointId: ENDPOINT,
    sampleRateHz: RATE, clockFrequency: RATE, clockPosition: n, qpc100ns: clock(n), submittedFrames: n,
    paddingFrames: 0, playbackStartQpc100ns: ORIGIN }));
  const sourceClockPath = write('aec-source-playback-clock.jsonl', jsonl(sourceClocks));
  const sourceReceipt = { endpointId: ENDPOINT, processId: 171, passed: true, renderedFrames: source.length,
    postrollSilenceFrames: 0, renderSampleRateHz: RATE, sourcePcm48kMonoPath: sourcePcmPath,
    sourceClockMetadataPath: sourceClockPath, sourceClockFrequency: RATE, sourcePlaybackStartQpc100ns: ORIGIN,
    zeroPaddingUnderrunCount: 0, detail: null, startedAtMs: 100, finishedAtMs: 3100 };
  const sourceReceiptBytes = Buffer.from(JSON.stringify(sourceReceipt) + '\n'); write('local-aec-source-media-receipt.json', sourceReceiptBytes);
  const complete = { sha256: sha(sourceReceiptBytes), receipt: sourceReceipt, sourcePcmSha256: sha(f32(source)),
    sourcePcmBytes: source.length * 4, sourceClockSha256: sha(jsonl(sourceClocks)), exitCode: 0, spawnedByNative: true,
    providerCalls: 0, validatedAtMs: 999999 };
  add({ kind: 'source-media-complete', boundReceipt: complete });
  const completeRow = events.pop();
  const completeIndex = events.findIndex((e) => e.afterValidatedMediaComplete === true || e.afterMediaComplete === true);
  events.splice(completeIndex, 0, completeRow);
  events.forEach((e, i) => { e.sequence = i; });
  const receipt = { schemaVersion: 2, artifactKind: 'watch-mode-local-aec-probe', scope: LOCAL_AEC_SPEECH_SCOPE,
    executionId, status: 'not-trusted-for-quality', releaseEligible: false, providerCalls: 0, recognitionSenderAttached: false,
    failure: null, cleanupError: null, tapError: null, sourceInjectorCleanupError: null,
    render: { requestedDeviceId: ENDPOINT, effectiveDeviceId: ENDPOINT, deviceId: ENDPOINT, sampleRateHz: RATE,
      channelCount: 2, rendererInstanceId: 'native-renderer', ownerGeneration: 2, renderedFrames: referenceFrame },
    capture: { requestedDeviceId: ENDPOINT, effectiveDeviceId: ENDPOINT, lastError: null, lastErrorCode: null,
      countsFinal: true, sampleRateHz: RATE, channelCount: 2, framesCaptured: physicalTotal + RATE * 2 },
    sourceMediaStarted: { executionId, physicalDeviceId: ENDPOINT, processId: 171, spawnedByNative: true, startedAtMs: 100 },
    sourceMediaComplete: complete,
    streamEvidence: { physical: physicalEntry, linearReference: linearEntry, events: null, stages: stageReceipts,
      renderSessionId: 1, streamStartCount: 1, streamDrained: true, aborted: false, mediaEndVoicedPhysicalFrames: voicedTail },
    captureDrain: { continuousQuietMs: 2000, minimumQuietCaptureFrames: 96000, quietStartFrame: physicalTotal,
      quietEndFrame: physicalTotal + RATE * 2, captureRemainedOpen: true, deadlineIsFailureOnly: true, quietEnergyCeilingDb: -60 },
  };
  const laneBytes = { pre: f32(pre), post: f32(post), render: f32(linear) };
  const reseal = () => {
    const all = { ...laneBytes, metadata: jsonl(diagnostic) };
    const files = {};
    for (const [key, bytes] of Object.entries(all)) {
      write(AEC_TAP_FILES[key], bytes); files[key] = { name: AEC_TAP_FILES[key], byteLength: bytes.length,
        sha256: sha(bytes), flushed: true, synced: true, unwrittenBufferedBytes: 0 };
    }
    const eventCounts = { render: diagnostic.filter((e) => e.kind === 'render-reference').length,
      capture: diagnostic.filter((e) => e.kind === 'capture').length, reset: diagnostic.filter((e) => e.kind === 'reset').length };
    const sampleCounts = { render: laneBytes.render.length / 4, pre: laneBytes.pre.length / 4, post: laneBytes.post.length / 4 };
    receipt.tap = { schemaVersion: 2, kind: 'terminal', status: 'complete', complete: true, countsFinal: true, terminalFile: 'aec-terminal.json',
      hashAlgorithm: 'sha256', files, errors: [], droppedEvents: 0, attemptedEvents: diagnostic.length,
      acceptedEvents: diagnostic.length, writtenEvents: diagnostic.length, lastWrittenSequence: diagnostic.length - 1,
      lastAttemptedSequence: diagnostic.length - 1, resetGeneration: 0, eventCounts, sampleCounts, invalidClockEvents: 0 };
    const queueRows = []; let generation = 0; let packetId = 0; let byteOffset = 0;
    const addQueue = value => queueRows.push({ ...value, sequence: queueRows.length });
    for(const capture of diagnostic.filter(e => e.kind === 'capture')) {
      const bytes = capture.preSampleCount * 4; const end = byteOffset + bytes; packetId += 1;
      const common = { schemaVersion:1,diagnosticOnly:true,qualityAcceptance:false,aecQualityAcceptance:false,
        releaseEligible:false,formalCaptureClockAcceptance:false,direction:'inbound',endpointId:ENDPOINT,
        captureOwnerId:1,captureAecResetGeneration:0,nativeResetGenerationDomain:'native-capture-owner',
        queueOwnerId:1,queueGenerationDomain:'capture-queue-ledger',resetGeneration:capture.resetGeneration,
        resetGenerationDomain:'aec-diagnostic-tap',ledgerError:null,qpc100ns:capture.observedQpc100ns };
      addQueue({...common,kind:'native-capture-packet',requestedEndpointId:ENDPOINT,packetId,
        rawFrameCount:capture.preSampleCount/2,rawByteCount:bytes,blockAlignBytes:8,
        captureTimeSegmentId:1,captureTimeBoundaryId:null,captureTimeBoundaryReason:null,
        captureTimePreviousEndDeviceFrameIndex:packetId === 1 ? null : capture.rawPacketDeviceFrameIndex,
        captureTimePreviousPacketTimestampError:packetId === 1 ? null : false,captureTimeQueueGeneration:generation+1,
        rawPacketDeviceFrameIndex:capture.rawPacketDeviceFrameIndex,rawPacketQpc100ns:capture.rawPacketQpc100ns,
        observedQpc100ns:capture.observedQpc100ns,timestampError:capture.timestampError,
        dataDiscontinuity:capture.dataDiscontinuity,silent:false,queuedBytesBeforeRead:0,queuedBytesAfterRead:bytes,
        appendStartByte:byteOffset,appendEndByte:end,queueGenerationBefore:generation,queueGenerationAfter:++generation,
        ledgerLastKnownHeadByte:byteOffset,ledgerLastKnownTailByte:end});
      addQueue({...common,kind:'native-capture-queue-clock',packetId,queueGeneration:generation,captureClockPrefixBytesAtPrepare:0,
        invalidPrefixBytes:0,packetClockValid:true,queueHeadClockValidForNextChunk:true,
        invalidPrefixStartByte:byteOffset,invalidPrefixEndByte:byteOffset,invalidPrefixPacketRanges:[],
        ledgerLastKnownHeadByte:byteOffset,ledgerLastKnownTailByte:end});
      const packetRanges=[{packetId,startByte:byteOffset,endByte:end,packetOffsetStartByte:0,packetOffsetEndByte:bytes}];
      addQueue({...common,kind:'native-capture-queue-dequeue',dequeueKind:'full-chunk-batch',dequeueId:packetId,
        dequeueStartByte:byteOffset,dequeueEndByte:end,dequeuedBytes:bytes,queuedBytesBefore:bytes,queuedBytesAfter:0,
        chunkByteLength:bytes,chunkCount:1,queueGenerationBefore:generation,queueGenerationAfter:++generation,
        queueGeneration:generation,packetRanges,ledgerLastKnownHeadByte:end,ledgerLastKnownTailByte:end});
      addQueue({...common,kind:'native-capture-queue-input',dequeueId:packetId,chunkIndex:0,
        inputStartByte:byteOffset,inputEndByte:end,inputByteCount:bytes,packetRanges,queueGeneration:generation,
        dequeueMappingAvailable:true,captureIdentityAvailable:true,queueHeadClockValid:capture.queueHeadClockValid,
        timestampError:capture.timestampError,dataDiscontinuity:capture.dataDiscontinuity,
        mainCaptureSequence:capture.sequence,mainCaptureResetGeneration:capture.resetGeneration,
        mainCapturePostSampleOffset:capture.postSampleOffset,ledgerLastKnownHeadByte:end,ledgerLastKnownTailByte:end});
      byteOffset = end;
    }
    const physicalQueueRows = events.filter(e => e.kind === 'physical-render');
    for(const row of physicalQueueRows) addQueue({...row,kind:'physical-output',schemaVersion:1,resetGeneration:0,
      sampleRateHz:RATE,channelCount:2,sampleOffset:row.physicalStartFrame*2,
      sampleCount:(row.physicalEndFrame-row.physicalStartFrame)*2});
    const closedFiles = {};
    for(const [lane,name,bytes] of [['metadata','aec-closed-loop-metadata.jsonl',jsonl(queueRows)],
      ['physical','aec-physical-output-48k-stereo.f32le',fs.readFileSync(receipt.streamEvidence.physical.path)],['provider','aec-provider-input.s16le',Buffer.alloc(0)]]) {
      write(name,bytes);closedFiles[lane]={name,byteLength:bytes.length,sha256:sha(bytes),flushed:true,synced:true,unwrittenBufferedBytes:0};
    }
    receipt.tap.closedLoop={schemaVersion:1,kind:'aec-closed-loop-terminal',complete:true,countsFinal:true,errors:[],
      droppedEvents:0,attemptedEvents:queueRows.length,acceptedEvents:queueRows.length,writtenEvents:queueRows.length,
      physicalEvents:physicalQueueRows.length,providerEvents:0,lifecycleEvents:queueRows.length-physicalQueueRows.length,
      physicalSamples:physical.length,providerSamples:0,files:closedFiles};
    write('aec-closed-loop-terminal.json',Buffer.from(JSON.stringify(receipt.tap.closedLoop)+'\n'));
    write('aec-terminal.json', Buffer.from(JSON.stringify(receipt.tap) + '\n'));
    const eventBytes = jsonl(events);
    receipt.streamEvidence.events = { path: write('local-aec-stream-events.jsonl', eventBytes), sha256: sha(eventBytes),
      eventCount: events.length, flushed: true, synced: true, error: null };
  };
  reseal();
  const stimulusPath = write('api-chinese-original.s16le', originalPcm);
  const sourceWavPath = write('original-english.wav', Buffer.from('RIFFfixture-test-wave-input'));
  const injectorPath = write('source-injector.exe', Buffer.from('MZfixture-test-executable'));
  const simulation = { injectorExecutable: injectorPath, injectorExecutableSha256: sha(fs.readFileSync(injectorPath)),
    sourceWavPath, sourceWavSha256: sha(fs.readFileSync(sourceWavPath)), chunkFrames: 2400, chunkIntervalMs: 100,
    stageDurationMs: 1000, deadlineMs: 180000 };
  const request = { schemaVersion: 2, executionId, outputDirectory: root, physicalDeviceId: ENDPOINT,
    renderPcmPath: stimulusPath, renderPcmSha256: sha(originalPcm), speechSimulation: simulation };
  receipt.sourcePcmSha256 = sha(originalPcm); receipt.sourcePcmFrames = originalPcm.length / 2;
  receipt.speechSimulation = { ...simulation, originalPcmSha256: sha(originalPcm),
    deltaCadence: { schemaVersion: 1, policy: 'absolute-sample-clock/v1', intervalMs: 100,
      originQpc100ns: ORIGIN, maximumLatenessMicros: 100000, singleAdmissionPerPump: true } };
  Object.assign(receipt.render, { sourcePcmFrames: originalPcm.length / 2,
    acceptedSimulationPcmFrames: originalPcm.length / 2, waitingSilenceSourceFrames: 0 });
  receipt.simulationDeltaCount = originalPcm.length / 4800;
  complete.receipt.mediaPath = sourceWavPath;
  const finalSourceReceiptBytes = Buffer.from(JSON.stringify(complete.receipt) + '\n');
  write('local-aec-source-media-receipt.json', finalSourceReceiptBytes); complete.sha256 = sha(finalSourceReceiptBytes);
  Object.assign(complete, { sourcePcmFormat: 'f32le', sourcePcmSampleRateHz: RATE, sourcePcmChannelCount: 1, sourcePcmFrames: source.length });
  complete.sourceWavSha256 = simulation.sourceWavSha256; complete.injectorExecutableSha256 = simulation.injectorExecutableSha256;
  write('request.json', Buffer.from(JSON.stringify(request) + '\n'));
  const freeze = { schemaVersion: 1, executionId, scope: LOCAL_AEC_SPEECH_SCOPE, releaseEligible: false,
    providerCalls: 0, translationProviderCalls: 0, requestSha256: sha(fs.readFileSync(path.join(root, 'request.json'))),
    injectorSha256: simulation.injectorExecutableSha256, inputWatchdogMs: 180000, captureQueueWitnessPolicy:'owner-range-time-segments-v2',
    thresholds: { echoAttenuationDb: 20, sourceGainToleranceDb: 3, sourceCoverage: 0.95 } };
  write('run-freeze.json', Buffer.from(JSON.stringify(freeze) + '\n'));
  write('local-aec-ready.json', Buffer.from(JSON.stringify({schemaVersion:2,artifactKind:'watch-mode-local-aec-ready',
    scope:LOCAL_AEC_SPEECH_SCOPE,executionId,physicalDeviceId:ENDPOINT,providerCalls:0,releaseEligible:false,
    readinessPhase:'native-stream-started',nativeStartAcknowledged:true,readyAtMs:90,
    capture:{...receipt.capture,countsFinal:false,framesCaptured:0,lastError:null,lastErrorCode:null}})+'\n'));
  const started = receipt.sourceMediaStarted;
  events.unshift({ kind: 'source-media-started', boundStart: started, scope: LOCAL_AEC_SPEECH_SCOPE, observedAtMs: 99999 });
  events.forEach((e, i) => { e.sequence = i; });
  reseal();
  const options = { nativeReceipt: receipt, expectedExecutionId: executionId, expectedPhysicalDeviceId: ENDPOINT, analyzer };
  const analyze = () => analyzeLocalAecSpeech(root, options);
  return { root, receipt, options, analyze, diagnostic, events, reseal, laneBytes, sourceClocks, write, request, freeze };
}
function rejected(report, pattern) {
  assert.equal(report.passed, false);
  assert.equal(report.releaseEligible, false);
  assert.match(JSON.stringify([...report.indeterminate, ...report.violations]), pattern);
}

test('real release analyzer positive, exact three phases/nonlinear/source-ended voiced tail; never release/semantic proof', (t) => {
  const f = fixture(t); const report = f.analyze();
  assert.equal(report.passed, true, JSON.stringify(report.indeterminate) + JSON.stringify(report.violations));
  assert.equal(report.status, 'passed'); assert.equal(report.stages.length, 4);
  assert.equal(report.tapEvidence.complete, true); assert.match(report.tapEvidence.terminalSha256, /^[a-f0-9]{64}$/u);
  assert.equal(report.stages[2].stage, 'nonlinear'); assert.ok(report.voicedTailFrames >= RATE);
  assert.equal(report.stages[3].sourceCoverage, null); assert.equal(report.stages[3].sourceSampleCount, 0);
  assert.equal(report.releaseEligible, false); assert.equal(report.modelInputLeakageVerified, false);
  assert.equal(report.semanticLeakageChainVerified, false); assert.equal(report.providerCalls, 0);
  assert.equal(report.analyzerExecutableSha256, analyzer.releaseExecutableSha256);
});
for (const variant of ['zero-post', 'passthrough', 'all-attenuated', 'scattered-source-delete']) {
  test(`independent acoustic negative: ${variant} rejected despite native completed`, (t) => {
    const f = fixture(t, variant); f.receipt.status = 'passed';
    const report = f.analyze(); rejected(report, /attenuation|preservation|source coverage/u);
    assert.equal(report.status, 'failed'); assert.equal(report.stages.length, 4);
  });
}
test('post PCM tampering rejected before metric execution', (t) => {
  const f = fixture(t); const bytes = Buffer.from(f.laneBytes.post); bytes[800] ^= 1; f.write(AEC_TAP_FILES.post, bytes);
  const report = f.analyze(); rejected(report, /bytes\/hash mismatch/u); assert.equal(report.stages.length, 0);
  assert.equal(report.tapEvidence, undefined);
});
test('physical PCM tampering rejected before metric execution', (t) => {
  const f = fixture(t); const bytes = fs.readFileSync(f.receipt.streamEvidence.physical.path); bytes[20] ^= 1;
  fs.writeFileSync(f.receipt.streamEvidence.physical.path, bytes); rejected(f.analyze(), /raw SHA256/u);
});
test('resealed nonlinear reference replacement rejected by actual transform verification', (t) => {
  const f = fixture(t); const entry = f.receipt.streamEvidence.physical; const bytes = fs.readFileSync(entry.path);
  const e = f.events.find((row) => row.kind === 'physical-render' && row.nonlinearity === 'soft-clip' && row.referenceEndFrame > row.referenceStartFrame);
  const linearBytes = fs.readFileSync(f.receipt.streamEvidence.linearReference.path);
  const chunk = linearBytes.subarray(e.referenceStartFrame * 8, e.referenceEndFrame * 8);
  chunk.copy(bytes, e.physicalStartFrame * 8); fs.writeFileSync(entry.path, bytes); entry.sha256 = sha(bytes);
  e.physicalPcmSha256 = sha(chunk); f.reseal(); rejected(f.analyze(), /nonlinear transform/u);
});
test('wrong actual source reference with valid new hashes fails independent audio identification', (t) => {
  const f = fixture(t); const complete = f.receipt.sourceMediaComplete;
  const bytes = fs.readFileSync(complete.receipt.sourcePcm48kMonoPath);
  const swapped = Buffer.concat([bytes.subarray(3840), bytes.subarray(0, 3840)]);
  fs.writeFileSync(complete.receipt.sourcePcm48kMonoPath, swapped); complete.sourcePcmSha256 = sha(swapped); f.reseal();
  const report = f.analyze(); rejected(report, /unidentifiable|preservation|source coverage/u); assert.equal(report.status, 'indeterminate');
});
test('wrong source IAudioClock origin even with resealed raw hash cannot pass', (t) => {
  const f = fixture(t); f.sourceClocks[1].qpc100ns += 100_000;
  f.receipt.sourceMediaComplete.sourceClockSha256 = sha(jsonl(f.sourceClocks));
  f.write('aec-source-playback-clock.jsonl', jsonl(f.sourceClocks)); f.reseal(); rejected(f.analyze(), /drift\/false onset/u);
});
test('source clock unknown final frame cannot be replaced by natural ended zeros', (t) => {
  const f = fixture(t); f.sourceClocks.at(-1).clockPosition -= 1;
  f.receipt.sourceMediaComplete.sourceClockSha256 = sha(jsonl(f.sourceClocks));
  f.write('aec-source-playback-clock.jsonl', jsonl(f.sourceClocks)); f.reseal(); rejected(f.analyze(), /not actually crossed/u);
});
test('missing capture tail frames cannot become zero (fully resealed files)', (t) => {
  const f = fixture(t); const tail = f.diagnostic.find((e) => e.kind === 'capture' && e.queueHeadDeviceFrameIndex === 3 * RATE);
  tail.queueHeadDeviceFrameIndex += 1; tail.queueHeadQpc100ns += 209; f.reseal(); rejected(f.analyze(), /frame gap\/overlap/u);
});
test('wrong render QPC with resealed metadata is not replaced by cue timestamps', (t) => {
  const f = fixture(t); const e = f.events.find((row) => row.kind === 'physical-render' && row.stage === 'dynamic-delay');
  e.qpc100ns += 200_000; f.reseal(); rejected(f.analyze(), /render QPC clock drift/u);
});
test('missing source clock metadata rejected, no onset inference from cue/wall timestamp', (t) => {
  const f = fixture(t); delete f.receipt.sourceMediaComplete.receipt.sourceClockMetadataPath;
  const raw = Buffer.from(JSON.stringify(f.receipt.sourceMediaComplete.receipt) + '\n');
  f.receipt.sourceMediaComplete.sha256 = sha(raw); f.write('local-aec-source-media-receipt.json', raw); f.reseal();
  rejected(f.analyze(), /missing evidence file path/u);
});
test('source raw clock tampering rejected before reconstruction', (t) => {
  const f = fixture(t); f.sourceClocks[1].qpc100ns += 1; f.write('aec-source-playback-clock.jsonl', jsonl(f.sourceClocks));
  rejected(f.analyze(), /clock raw hash/u);
});
test('unsealed native receipt lists individual missing lanes, cannot native.status=passed bypass', (t) => {
  const f = fixture(t); f.receipt.status = 'passed'; delete f.receipt.streamEvidence.physical; delete f.receipt.streamEvidence.linearReference;
  const report = f.analyze(); rejected(report, /unsealed native file/u);
  assert.ok(report.indeterminate.some((e) => e.area === 'physical-seal'));
  assert.ok(report.indeterminate.some((e) => e.area === 'linear-reference-seal'));
});
for (const [name, mutate, pattern] of [
  ['endpoint', (f) => { f.receipt.render.effectiveDeviceId = 'wrong'; }, /endpoint ownership/u],
  ['execution', (f) => { f.options.expectedExecutionId = 'other-run'; }, /execution/u],
  ['render session', (f) => { f.events.find((e) => e.kind === 'physical-render').renderSessionId = 77; f.reseal(); }, /session\/renderer\/owner/u],
  ['render owner', (f) => { f.events.find((e) => e.kind === 'physical-render').ownerGeneration = 77; f.reseal(); }, /session\/renderer\/owner/u],
  ['source process', (f) => { f.receipt.sourceMediaStarted.processId = 99; }, /endpoint\/process|owned native journal/u],
  ['closed capture', (f) => { f.receipt.captureDrain.captureRemainedOpen = false; }, /open capture drain/u],
  ['frozen capture', (f) => { f.receipt.captureDrain.quietEndFrame = f.receipt.captureDrain.quietStartFrame; }, /open capture drain/u],
  ['missing final capture metadata', (f) => { delete f.receipt.capture.countsFinal; }, /capture-final/u],
  ['release eligibility', (f) => { f.receipt.releaseEligible = true; }, /local-only/u],
  ['paid metadata', (f) => { f.receipt.paidProvider = { called: false }; }, /paid-provider/u],
  ['analyzer hash', (f) => { f.options.analyzer = { ...analyzer, releaseExecutableSha256: '0'.repeat(64) }; }, /analyzer SHA256/u],
]) {
  test(`strict custody negative: ${name}`, (t) => { const f = fixture(t); mutate(f); rejected(f.analyze(), pattern); });
}
test('native voiced-tail counters alone cannot award actual tail', (t) => {
  const f = fixture(t); const complete = f.receipt.sourceMediaComplete;
  // Keep all raw data but remove tail voice from the physical waveform: metadata alone cannot award one second.
  for (const e of f.events) if (e.kind === 'physical-render') e.afterValidatedMediaComplete = false;
  f.receipt.streamEvidence.mediaEndVoicedPhysicalFrames = 999999; f.reseal();
  rejected(f.analyze(), /tail classification mismatch|less than one second/u); assert.ok(complete.sourcePcmBytes > 0);
});
test('JSONL truncation is indeterminate, not quality success', (t) => {
  const f = fixture(t); const entry = f.receipt.streamEvidence.events;
  const bytes = jsonl(f.events).subarray(0, -1); fs.writeFileSync(entry.path, bytes); entry.sha256 = sha(bytes);
  rejected(f.analyze(), /truncated JSONL/u);
});

test('unchanged release minimum echo windows: insufficient valid windows is indeterminate', (t) => {
  const f = fixture(t, 'insufficient-echo'); const report = f.analyze();
  rejected(report, /insufficient valid/u); assert.equal(report.status, 'indeterminate');
  assert.equal(report.stages.length, 4);
});
test('tampered original API PCM input hash rejected before analyzer metrics', (t) => {
  const f = fixture(t); const bytes = fs.readFileSync(f.request.renderPcmPath); bytes[22] ^= 1;
  fs.writeFileSync(f.request.renderPcmPath, bytes); rejected(f.analyze(), /original input raw hash/u);
});
test('resealed simulated delta hash mismatch cannot be bypassed with native status passed', (t) => {
  const f = fixture(t); f.events.find((e) => e.kind === 'simulated-audio.delta').pcmSha256 = '0'.repeat(64);
  f.reseal(); rejected(f.analyze(), /delta raw hash/u);
});
test('duplicate simulated source frames are not valid original PCM custody', (t) => {
  const f = fixture(t); const e = f.events.filter((row) => row.kind === 'simulated-audio.delta')[1];
  e.sourceStartFrame = 0; e.sourceEndFrame = 2400; f.reseal(); rejected(f.analyze(), /delta order/u);
});
test('burst injection cadence cannot masquerade as the 100ms audio.delta simulation', (t) => {
  const f = fixture(t); f.events.filter((e) => e.kind === 'simulated-audio.delta')[1].intervalMs = 0;
  f.reseal(); rejected(f.analyze(), /cadence/u);
});
test('frozen threshold tampering fails without changing release algorithm', (t) => {
  const f = fixture(t); f.freeze.thresholds.echoAttenuationDb = 10;
  f.write('run-freeze.json', Buffer.from(JSON.stringify(f.freeze) + '\n')); rejected(f.analyze(), /threshold/u);
});
test('missing local request is indeterminate, never original fixture guessed from audio', (t) => {
  const f = fixture(t); fs.unlinkSync(path.join(f.root, 'request.json')); rejected(f.analyze(), /ENOENT/u);
});
test('source endpoint/hash verified against original request and native process', (t) => {
  const f = fixture(t); f.receipt.sourceMediaComplete.injectorExecutableSha256 = '0'.repeat(64); f.reseal();
  rejected(f.analyze(), /not bound to request/u);
});
test('source phase preservation with no English is indeterminate rather than 100 percent', (t) => {
  const f = fixture(t); const complete = f.receipt.sourceMediaComplete;
  const bytes = fs.readFileSync(complete.receipt.sourcePcm48kMonoPath); bytes.fill(0, 0, RATE * 4);
  fs.writeFileSync(complete.receipt.sourcePcm48kMonoPath, bytes); complete.sourcePcmSha256 = sha(bytes); f.reseal();
  const report = f.analyze(); rejected(report, /no identifiable active English|unidentifiable/u);
  assert.equal(report.status, 'indeterminate');
});
test('sourceMediaStart alias keeps the same native journal authority, no invented clock', (t) => {
  const f = fixture(t); f.receipt.sourceMediaStart = f.receipt.sourceMediaStarted; delete f.receipt.sourceMediaStarted;
  const report = f.analyze(); assert.equal(report.passed, true, JSON.stringify(report.indeterminate));
});
test('source PCM encoding metadata absent is indeterminate even with matching file hash', (t) => {
  const f = fixture(t); delete f.receipt.sourceMediaComplete.sourcePcmFormat; f.reseal();
  rejected(f.analyze(), /format\/frame metadata/u);
});
test('old zero-frame optimistic readiness without native Start ack is not accepted', (t) => {
  const f = fixture(t); const ready = JSON.parse(fs.readFileSync(path.join(f.root,'local-aec-ready.json'),'utf8'));
  ready.nativeStartAcknowledged = false; f.write('local-aec-ready.json',Buffer.from(JSON.stringify(ready)));
  rejected(f.analyze(),/Start-success acknowledgement/u);
});
test('source preceding real native Start readiness cannot pass acoustic analysis', (t) => {
  const f = fixture(t); const ready = JSON.parse(fs.readFileSync(path.join(f.root,'local-aec-ready.json'),'utf8'));
  ready.readyAtMs=101; f.write('local-aec-ready.json',Buffer.from(JSON.stringify(ready)));
  rejected(f.analyze(),/source started before/u);
});

for (const outerFailure of [true, false]) {
  test(`physically complete failed source-clock collection cannot enter formal reconstruction (outer failure ${outerFailure})`, (t) => {
    const f = fixture(t), complete = f.receipt.sourceMediaComplete;
    const error = 'source IAudioClock drift/false onset';
    // Complete PCM, quiet drain and terminal seals are left intact. Neither
    // physical completion nor a forged healthy outer status overrides exit1
    // and the original failed source-clock receipt. No metric executable runs:
    // sourceTimeline rejects before reconstruction and metric execution.
    f.receipt.status = outerFailure ? 'failed' : 'completed';
    f.receipt.failure = outerFailure ? error : null;
    Object.assign(complete, { passed: false, exitCode: 1, mediaPlaybackComplete: true,
      sourceEvidenceValidationPassed: false, sourceEvidenceValidationError: error });
    Object.assign(complete.receipt, { passed: false, mediaPlaybackComplete: true,
      naturalRenderDrained: true, diagnosticOnly: false, sourceClockValidationPassed: false,
      sourceClockValidationError: error, detail: error });
    const rawReceipt = Buffer.from(JSON.stringify(complete.receipt) + '\n');
    f.write('local-aec-source-media-receipt.json', rawReceipt); complete.sha256 = sha(rawReceipt);
    f.reseal();
    const report = f.analyze();
    assert.equal(f.receipt.tap.complete, true);
    assert.equal(f.receipt.capture.countsFinal, true);
    assert.equal(f.receipt.captureDrain.captureRemainedOpen, true);
    assert.equal(complete.receipt.mediaPlaybackComplete, true);
    assert.equal(complete.receipt.naturalRenderDrained, true);
    rejected(report, /same-run native-owned source injector receipt missing/u);
    assert.equal(report.status, 'indeterminate');
    assert.equal(report.clocks, undefined); assert.deepEqual(report.stages, []);
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'local-aec-source-media-receipt.json')), rawReceipt);
    assert.equal(complete.exitCode, 1); assert.equal(complete.receipt.sourceClockValidationPassed, false);
  });
}

// Change timing only: waveform hashes, phases, source clocks and quality gates
// remain the same passing fixture, so these exercise consumer cadence evidence.
function retimeDeltas(f, latenessAt, qpcErrorMicros = 0) {
  let previous = 0;
  for (const [i, e] of f.events.filter((row) => row.kind === 'simulated-audio.delta').entries()) {
    const offset = i * 100000 + latenessAt(i);
    Object.assign(e, { scheduledOffsetMicros: i * 100000, admissionOffsetMicros: offset,
      admissionQpc100ns: f.receipt.speechSimulation.deltaCadence.originQpc100ns + (offset + qpcErrorMicros) * 10,
      latenessMicros: offset - i * 100000, intervalMs: Math.floor((offset - previous) / 1000) });
    previous = offset;
  }
  f.reseal();
}

for (const [name, latenessAt] of [
  ['persistent 2ms jitter stays on absolute sample clock, not accumulated', () => 2000],
  ['2ms late delta recovers with a legitimate 98ms interval, not burst', (i) => i === 1 ? 2000 : 0],
  ['sub-ms offset uses floor of actual gap, not difference of rounded timestamps', (i) => i === 1 ? 1999 : 1],
  ['last admissible lateness is strictly below 100ms', () => 99999],
]) {
  test(name, (t) => {
    const f = fixture(t); retimeDeltas(f, latenessAt);
    const report = f.analyze(); assert.equal(report.passed, true, JSON.stringify(report));
    assert.equal(report.stages.length, 4);
    assert.deepEqual(report.thresholds, { echoAttenuationDb: 20, sourceGainToleranceDb: 3, sourceCoverage: 0.95,
      windowMs: 100, minimumEchoWindows: 3, minimumReferenceRms: 0.0001,
      maximumReferenceCorrelation: 0.98, maximumUnexplainedEnergyRatio: 0.2 });
  });
}
for (const errorMicros of [-1000, 1000]) {
  test('fixed QPC/Instant 1000us bound includes signed boundary ' + errorMicros, (t) => {
    const f = fixture(t); retimeDeltas(f, () => 2000, errorMicros);
    assert.equal(f.analyze().passed, true);
  });
}

const invalidCadences = [
  ['legacy report without cadence contract', (f) => { delete f.receipt.speechSimulation.deltaCadence; }],
  ['unsupported contract schema', (f, c) => { c.schemaVersion = 2; }],
  ['relative schedule policy', (f, c) => { c.policy = 'relative-now'; }],
  ['wrong contract interval', (f, c) => { c.intervalMs = 99; }],
  ['relaxed lateness budget', (f, c) => { c.maximumLatenessMicros = 100001; }],
  ['burst-capable contract', (f, c) => { c.singleAdmissionPerPump = false; }],
  ['absent QPC origin', (f, c) => { delete c.originQpc100ns; }],
  ['zero QPC origin', (f, c) => { c.originQpc100ns = 0; }],
  ['unsafe QPC origin', (f, c) => { c.originQpc100ns = Number.MAX_SAFE_INTEGER + 1; }],
  ['forged QPC origin beyond fixed bound', (f, c) => { c.originQpc100ns -= 10001; }],
  ['old delta without v1 evidence', (f, c, d) => { delete d[1].cadenceVersion; }],
  ['wrong delta version', (f, c, d) => { d[1].cadenceVersion = 2; }],
  ['forged scheduled offset', (f, c, d) => { d[1].scheduledOffsetMicros++; }],
  ['relative offsets with internally consistent lateness', (f, c, d) => {
    d[1].scheduledOffsetMicros += 2000; d[1].admissionOffsetMicros += 2000;
    d[1].admissionQpc100ns += 20000; d[1].intervalMs = 102;
  }],
  ['early admission', (f) => { retimeDeltas(f, (i) => i === 1 ? -1 : 0); }],
  ['100ms lateness fails at boundary', (f) => { retimeDeltas(f, () => 100000); }],
  ['over 100ms lateness', (f) => { retimeDeltas(f, () => 100001); }],
  ['missing actual admission offset', (f, c, d) => { delete d[1].admissionOffsetMicros; }],
  ['fractional actual admission offset', (f, c, d) => { d[1].admissionOffsetMicros += 0.5; }],
  ['forged lateness', (f, c, d) => { d[1].latenessMicros = 1; }],
  ['QPC offset over positive consistency bound', (f) => { retimeDeltas(f, () => 2000, 1001); }],
  ['QPC offset over negative consistency bound', (f) => { retimeDeltas(f, () => 2000, -1001); }],
  ['QPC regression', (f, c, d) => { d[1].admissionQpc100ns = d[0].admissionQpc100ns - 1; }],
  ['first QPC precedes origin', (f, c, d) => { d[0].admissionQpc100ns = c.originQpc100ns - 1; }],
  ['zero admission QPC', (f, c, d) => { d[0].admissionQpc100ns = 0; }],
  ['missing admission QPC', (f, c, d) => { delete d[1].admissionQpc100ns; }],
  ['duplicate chunk despite distinct clock', (f, c, d) => { d[1].chunkIndex = d[0].chunkIndex; }],
  ['duplicate actual admission', (f, c, d) => { d[1].admissionOffsetMicros = d[0].admissionOffsetMicros; }],
  ['forged adjacent interval', (f, c, d) => { d[1].intervalMs = 101; }],
  ['forged first interval', (f, c, d) => { d[0].intervalMs = 1; }],
  ['missing chunk fails exhaustive coverage', (f, c, d) => {
    f.events.splice(f.events.indexOf(d[1]), 1); f.events.forEach((e, i) => { e.sequence = i; });
  }],
];
for (const [name, mutate] of invalidCadences) {
  test('v1 cadence rejects ' + name, (t) => {
    const f = fixture(t), deltas = f.events.filter((e) => e.kind === 'simulated-audio.delta');
    mutate(f, f.receipt.speechSimulation.deltaCadence, deltas); f.reseal();
    rejected(f.analyze(), /cadence|clock|delta/u);
  });
}

test('legacy capture receipt cannot satisfy new local acoustic acceptance',t=>{
 const f=fixture(t); for(const event of f.diagnostic) if(event.kind==='capture')delete event.aecProcessing;
 f.reseal();const report=f.analyze();rejected(report,/missing aecProcessing receipt/u);assert.equal(report.stages.length,0);
});
test('padded capture without actual tail admission cannot reach acoustic analyzer',t=>{
 const f=fixture(t);const event=f.diagnostic.find(e=>e.kind==='capture');event.aecProcessing.mathPaddingFrames=288;
 f.reseal();const report=f.analyze();rejected(report,/mathPaddingFrames mismatch/u);assert.equal(report.stages.length,0);
});

test('sealed owner/range ledger is required independently of acoustic/source-clock acceptance',t=>{
 const f=fixture(t);
 const nativeReceipt=JSON.parse(fs.readFileSync(path.join(f.root,'aec-terminal.json'),'utf8'));
 // This projection is diagnostic-only; acoustic acceptance remains separate.
 const view=inspectLocalCaptureQueueEvidence(f.root,f.receipt);
 assert.equal(view.reviewSatisfied,true);assert.equal(view.qualityAcceptance,false);
 assert.equal(view.inputs,nativeReceipt.eventCounts.capture);
 const meta=path.join(f.root,'aec-closed-loop-metadata.jsonl');fs.appendFileSync(meta,'{}\n');
 assert.throws(()=>inspectLocalCaptureQueueEvidence(f.root,f.receipt),/hash.*seal/u);
});
test('old local frozen reports cannot satisfy new owner/range witness policy',t=>{
 const f=fixture(t);const file=path.join(f.root,'run-freeze.json');const freeze=JSON.parse(fs.readFileSync(file,'utf8'));
 delete freeze.captureQueueWitnessPolicy;fs.writeFileSync(file,JSON.stringify(freeze));
 const result=f.analyze();assert.equal(result.passed,false);
 assert.ok(result.indeterminate.some(e=>/capture queue witness policy/u.test(e.detail)));
});

test('local sealed ledger rejects missing or forged classification/sample counters despite correct hashes',async t=>{
 for(const key of ['physicalEvents','providerEvents','lifecycleEvents','physicalSamples','providerSamples']) {
  for(const missing of [true,false]) await t.test(key+(missing?' missing':' forged'),t=>{
   const f=fixture(t);const seal=f.receipt.tap.closedLoop;
   if(missing)delete seal[key];else seal[key]+=1;
   fs.writeFileSync(path.join(f.root,'aec-closed-loop-terminal.json'),JSON.stringify(seal)+'\n');
   fs.writeFileSync(path.join(f.root,'aec-terminal.json'),JSON.stringify(f.receipt.tap)+'\n');
   assert.throws(()=>inspectLocalCaptureQueueEvidence(f.root,f.receipt),/sidecar.*accounting|zero.provider/u);
  });
 }
});

test('local ledger forbids provider rows even when all counters and file hashes agree',t=>{
 const f=fixture(t);const seal=f.receipt.tap.closedLoop;const meta=path.join(f.root,'aec-closed-loop-metadata.jsonl');
 const rows=fs.readFileSync(meta,'utf8').trim().split('\n').map(JSON.parse);
 rows.push({schemaVersion:1,sequence:rows.length,kind:'provider-input',sampleOffset:0,sampleCount:1});
 const metadata=jsonl(rows);fs.writeFileSync(meta,metadata);
 seal.files.metadata.byteLength=metadata.length;seal.files.metadata.sha256=sha(metadata);
 const provider=Buffer.from([0,0]);fs.writeFileSync(path.join(f.root,'aec-provider-input.s16le'),provider);
 seal.files.provider.byteLength=provider.length;seal.files.provider.sha256=sha(provider);
 seal.providerEvents=1;seal.providerSamples=1;seal.attemptedEvents+=1;seal.acceptedEvents+=1;seal.writtenEvents+=1;
 fs.writeFileSync(path.join(f.root,'aec-closed-loop-terminal.json'),JSON.stringify(seal)+'\n');
 fs.writeFileSync(path.join(f.root,'aec-terminal.json'),JSON.stringify(f.receipt.tap)+'\n');
 assert.throws(()=>inspectLocalCaptureQueueEvidence(f.root,f.receipt),/zero.provider/u);
});
test('queue physical PCM must match owned stream recording identity',t=>{
 const f=fixture(t);f.receipt.streamEvidence.physical.sha256='0'.repeat(64);
 assert.throws(()=>inspectLocalCaptureQueueEvidence(f.root,f.receipt),/physical PCM differs/u);
});

test('new local freeze cannot rehabilitate fully sealed v1 ledger bytes',t=>{
 const f=fixture(t);const meta=path.join(f.root,'aec-closed-loop-metadata.jsonl');
 const rows=fs.readFileSync(meta,'utf8').trim().split('\n').map(JSON.parse);
 for(const e of rows)for(const key of Object.keys(e))if(key.startsWith('captureTime')||key==='captureClockPrefixBytesAtPrepare')delete e[key];
 const bytes=jsonl(rows);fs.writeFileSync(meta,bytes);const seal=f.receipt.tap.closedLoop;
 seal.files.metadata.byteLength=bytes.length;seal.files.metadata.sha256=sha(bytes);
 fs.writeFileSync(path.join(f.root,'aec-closed-loop-terminal.json'),JSON.stringify(seal)+'\n');
 fs.writeFileSync(path.join(f.root,'aec-terminal.json'),JSON.stringify(f.receipt.tap)+'\n');
 assert.throws(()=>inspectLocalCaptureQueueEvidence(f.root,f.receipt),/time.segment.*v2.*required/u);
 rejected(f.analyze(),/time.segment/u);
});


function installLocalCapturePump(f, mutate = () => {}) {
  const value={schemaVersion:1,artifactKind:'capture-pump-timing-diagnostic',captureOwnerId:1,
    threadId:171,processId:42,endpointId:ENDPOINT,nativeStopSucceeded:true,diagnosticIncomplete:false,
    diagnosticOnly:true,qualityAcceptance:false,formalCaptureClockAcceptance:false,releaseEligible:false};
  const descriptor={schemaVersion:1,kind:'native-capture-pump-timing-seal',captureOwnerId:1,
    threadId:171,processId:42,endpointId:ENDPOINT,captureStoppedBeforePersistence:true,diagnosticIncomplete:false,
    file:'aec-capture-pump-owner-1.json',flushed:true,synced:true,
    diagnosticOnly:true,qualityAcceptance:false,formalCaptureClockAcceptance:false,releaseEligible:false};
  mutate(value,descriptor);
  const file=path.join(f.root,'aec-capture-pump-owner-1.json');
  const bytes=Buffer.from(JSON.stringify(value)+'\n');fs.writeFileSync(file,bytes);
  descriptor.bytes??=bytes.length;descriptor.sha256??=sha(bytes);
  const metadataFile=path.join(f.root,'aec-closed-loop-metadata.jsonl');
  const rows=fs.readFileSync(metadataFile,'utf8').trim().split('\n').map(JSON.parse);
  descriptor.sequence=rows.length;rows.push(descriptor);
  const metadata=jsonl(rows);fs.writeFileSync(metadataFile,metadata);
  const seal=f.receipt.tap.closedLoop;
  seal.files.metadata.byteLength=metadata.length;seal.files.metadata.sha256=sha(metadata);
  seal.lifecycleEvents+=1;
  for(const key of ['attemptedEvents','acceptedEvents','writtenEvents'])seal[key]+=1;
  fs.writeFileSync(path.join(f.root,'aec-closed-loop-terminal.json'),JSON.stringify(seal)+'\n');
  fs.writeFileSync(path.join(f.root,'aec-terminal.json'),JSON.stringify(f.receipt.tap)+'\n');
  return {file,descriptor,value};
}

test('capture pump consumer local inspection roundtrip and source failure remains failed',t=>{
  const f=fixture(t);installLocalCapturePump(f);
  const view=inspectLocalCaptureQueueEvidence(f.root,f.receipt);
  assert.equal(view.reviewSatisfied,true);assert.equal(view.qualityAcceptance,false);
  const good=f.analyze();assert.equal(good.passed,true,JSON.stringify(good));
  const complete=f.receipt.sourceMediaComplete;
  complete.exitCode=1;complete.passed=false;complete.sourceEvidenceValidationPassed=false;
  complete.sourceEvidenceValidationError='source render clock origin drift exceeds frozen 1ms bound';
  const failed=f.analyze();assert.equal(failed.passed,false);assert.equal(failed.releaseEligible,false);
  assert.equal(failed.status,'indeterminate');assert.deepEqual(failed.stages,[]);
  assert.equal(failed.captureQueueLedger.reviewSatisfied,true);
});

test('capture pump consumer local inspection rejects forgery missing files duplicates and redirects',async t=>{
  for(const [name,mutate] of [
    ['render timing',v=>{v.artifactKind='local-aec-pump-timing-diagnostic';}],
    ['thread identity',v=>{v.threadId=99;}],
    ['process identity',v=>{v.processId=99;}],
    ['endpoint identity',v=>{v.endpointId='other';}],
    ['stop identity',v=>{v.nativeStopSucceeded=false;}],
    ['file authority',v=>{v.releaseEligible=true;}],
    ['descriptor authority',(v,e)=>{e.qualityAcceptance=true;}],
    ['redirect',(v,e)=>{e.file='../outside.json';}],
  ]) await t.test(name,t=>{
    const f=fixture(t);installLocalCapturePump(f,mutate);
    assert.throws(()=>inspectLocalCaptureQueueEvidence(f.root,f.receipt),/capture pump/);
    rejected(f.analyze(),/capture pump/);
  });
  for(const mode of ['missing','tampered','duplicate'])await t.test(mode,t=>{
    const f=fixture(t);const p=installLocalCapturePump(f);
    if(mode==='missing')fs.unlinkSync(p.file);
    else if(mode==='tampered')fs.appendFileSync(p.file,' ');
    else installLocalCapturePump(f);
    assert.throws(()=>inspectLocalCaptureQueueEvidence(f.root,f.receipt),/capture pump|ENOENT/);
    rejected(f.analyze(),/capture pump|ENOENT/);
  });
});
