import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AEC_TAP_FILES, verifyAecTapEvidence } from './watch-mode-aec-tap-evidence.mjs';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function createTapEvidenceFixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aec-tap-test-'));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  // Render: 2 stereo frames (4 samples, 16 bytes)
  const renderPcm = Buffer.alloc(16);

  const preFrames1 = options.preFrames ?? 960;
  const preSamples1 = preFrames1 * 2;

  const preFrames2 = options.subsequentCapture ? (options.subsequentPreFrames ?? 960) : 0;
  const preSamples2 = preFrames2 * 2;

  const totalPreSamples = preSamples1 + preSamples2;
  const totalPreBytes = totalPreSamples * 4;

  const prePcm = Buffer.alloc(totalPreBytes);
  const postPcm = Buffer.alloc(totalPreBytes);

  if (options.nonZeroPre) {
    prePcm.writeFloatLE(0.25, 0);
  }

  fs.writeFileSync(path.join(dir, AEC_TAP_FILES.render), renderPcm);
  fs.writeFileSync(path.join(dir, AEC_TAP_FILES.pre), prePcm);
  fs.writeFileSync(path.join(dir, AEC_TAP_FILES.post), postPcm);

  const events = [];
  // Render event
  events.push({
    schemaVersion: 3,
    kind: 'render-reference',
    sequence: 0,
    resetGeneration: 0,
    continuityId: 1,
    qpc100ns: 1000,
    renderSessionId: 1,
    ownerGeneration: 1,
    physicalPrefixOffsetFrames: 0,
    referenceStartFrame: 0,
    referenceEndFrame: 2,
    playedFrames: 2,
    submittedFrames: 2,
    endpointPaddingFrames: 0,
    sampleRateHz: 48000,
    channelCount: 2,
    sampleOffset: 0,
    sampleCount: 4,
  });

  // First Capture event
  const captureEvent = {
    schemaVersion: 3,
    kind: 'capture',
    sequence: 1,
    resetGeneration: 0,
    continuityId: 1,
    packetDeviceFrameIndex: 0,
    packetQpc100ns: 1000,
    rawPacketDeviceFrameIndex: 0,
    rawPacketQpc100ns: 1000,
    queueHeadDeviceFrameIndex: 0,
    queueHeadQpc100ns: 1000,
    timestampError: false,
    dataDiscontinuity: false,
    queueHeadClockValid: true,
    observedQpc100ns: 1000,
    delaySamples: 0,
    sampleRateHz: 48000,
    channelCount: 2,
    preSampleOffset: 0,
    preSampleCount: preSamples1,
    postSampleOffset: 0,
    postSampleCount: preSamples1,
    aecProcessing: options.aecProcessing !== undefined ? options.aecProcessing : {
      schemaVersion: 1,
      inputFrames: preFrames1,
      native10msFrames: Math.ceil(preFrames1 / 480),
      mathPaddingFrames: Math.ceil(preFrames1 / 480) * 480 - preFrames1,
      allInputProcessed: true,
      resetBeforeResumeRequired: Math.ceil(preFrames1 / 480) * 480 - preFrames1 > 0,
      tailAdmission: options.tailAdmission !== undefined ? options.tailAdmission : (Math.ceil(preFrames1 / 480) * 480 - preFrames1 > 0 ? {
        schemaVersion: 1,
        queueGeneration: 1,
        captureOwnerId: 1,
        captureResetGeneration: 1,
        byteLen: preFrames1 * 8,
        lastEmptyQueryId: 1,
        emptyPolls: 25,
        quietObservationSpanMs: 2000.0,
        maximumEmptyPollGapMs: 90.0,
        lastNonemptyAgeAtLastQueryMs: 2000.0,
        allZero: true,
        zeroSamples: preSamples1,
        nonzeroSamples: 0,
        realFrames: preFrames1,
      } : null),
    },
  };
  events.push(captureEvent);

  if (options.subsequentReset) {
    events.push({
      schemaVersion: 3,
      kind: 'reset',
      sequence: 2,
      resetGeneration: 1,
      continuityId: 1,
      qpc100ns: 1050,
      reason: 'test-reset',
    });
  }

  if (options.subsequentCapture) {
    const seq = events.length;
    events.push({
      schemaVersion: 3,
      kind: 'capture',
      sequence: seq,
      resetGeneration: options.subsequentReset ? 1 : 0,
      continuityId: 1,
      packetDeviceFrameIndex: 10,
      packetQpc100ns: 2000,
      rawPacketDeviceFrameIndex: 10,
      rawPacketQpc100ns: 2000,
      queueHeadDeviceFrameIndex: 10,
      queueHeadQpc100ns: 2000,
      timestampError: false,
      dataDiscontinuity: false,
      queueHeadClockValid: true,
      observedQpc100ns: 2000,
      delaySamples: 0,
      sampleRateHz: 48000,
      channelCount: 2,
      preSampleOffset: preSamples1,
      preSampleCount: preSamples2,
      postSampleOffset: preSamples1,
      postSampleCount: preSamples2,
      aecProcessing: {
        schemaVersion: 1,
        inputFrames: preFrames2,
        native10msFrames: Math.ceil(preFrames2 / 480),
        mathPaddingFrames: Math.ceil(preFrames2 / 480) * 480 - preFrames2,
        allInputProcessed: true,
        resetBeforeResumeRequired: Math.ceil(preFrames2 / 480) * 480 - preFrames2 > 0,
        tailAdmission: null,
      },
    });
  }

  const metadataLines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, AEC_TAP_FILES.metadata), metadataLines, 'utf8');

  const metaStat = fs.statSync(path.join(dir, AEC_TAP_FILES.metadata));
  const renderStat = fs.statSync(path.join(dir, AEC_TAP_FILES.render));
  const preStat = fs.statSync(path.join(dir, AEC_TAP_FILES.pre));
  const postStat = fs.statSync(path.join(dir, AEC_TAP_FILES.post));

  const terminal = {
    schemaVersion: 2,
    kind: 'terminal',
    status: 'complete',
    complete: true,
    countsFinal: true,
    hashAlgorithm: 'sha256',
    terminalFile: 'aec-terminal.json',
    errors: [],
    droppedEvents: 0,
    writtenEvents: events.length,
    attemptedEvents: events.length,
    acceptedEvents: events.length,
    lastWrittenSequence: events.length - 1,
    lastAttemptedSequence: events.length - 1,
    resetGeneration: options.subsequentReset ? 1 : 0,
    eventCounts: {
      render: 1,
      capture: options.subsequentCapture ? 2 : 1,
      reset: options.subsequentReset ? 1 : 0,
    },
    sampleCounts: {
      render: 4,
      pre: totalPreSamples,
      post: totalPreSamples,
    },
    invalidClockEvents: 0,
    files: {
      metadata: {
        name: AEC_TAP_FILES.metadata,
        byteLength: metaStat.size,
        sha256: sha256(fs.readFileSync(path.join(dir, AEC_TAP_FILES.metadata))),
        flushed: true,
        synced: true,
        unwrittenBufferedBytes: 0,
      },
      render: {
        name: AEC_TAP_FILES.render,
        byteLength: renderStat.size,
        sha256: sha256(renderPcm),
        flushed: true,
        synced: true,
        unwrittenBufferedBytes: 0,
      },
      pre: {
        name: AEC_TAP_FILES.pre,
        byteLength: preStat.size,
        sha256: sha256(prePcm),
        flushed: true,
        synced: true,
        unwrittenBufferedBytes: 0,
      },
      post: {
        name: AEC_TAP_FILES.post,
        byteLength: postStat.size,
        sha256: sha256(postPcm),
        flushed: true,
        synced: true,
        unwrittenBufferedBytes: 0,
      },
    },
  };

  fs.writeFileSync(path.join(dir, 'aec-terminal.json'), JSON.stringify(terminal, null, 2), 'utf8');

  return { dir, terminal };
}

test('verifyAecTapEvidence accepts valid capture with aecProcessing receipt in strict and non-strict modes', (t) => {
  const { dir, terminal } = createTapEvidenceFixture(t);
  const resultDefault = verifyAecTapEvidence(dir, terminal);
  assert.equal(resultDefault.complete, true);
  assert.equal(resultDefault.processingVerified, true);
  assert.equal(resultDefault.hasPartialFrames, false);
  assert.equal(resultDefault.diagnosticOnly, true);
  assert.equal(resultDefault.strictValidated, false);

  const resultStrict = verifyAecTapEvidence(dir, terminal, { strict: true });
  assert.equal(resultStrict.complete, true);
  assert.equal(resultStrict.processingVerified, true);
  assert.equal(resultStrict.strictMode, true);
  assert.equal(resultStrict.strictValidated, true);
  assert.equal(resultStrict.diagnosticOnly, true);
});

test('verifyAecTapEvidence rejects non-boolean strict option', (t) => {
  const { dir, terminal } = createTapEvidenceFixture(t);
  assert.throws(
    () => verifyAecTapEvidence(dir, terminal, { strict: 'false' }),
    /options\.strict must be boolean/
  );
  assert.throws(
    () => verifyAecTapEvidence(dir, terminal, { strict: 1 }),
    /options\.strict must be boolean/
  );
});

test('verifyAecTapEvidence preserves backward compatibility: legacy capture without receipt passes non-strict but fails strict', (t) => {
  const { dir, terminal } = createTapEvidenceFixture(t, { aecProcessing: null });
  const result = verifyAecTapEvidence(dir, terminal);
  assert.equal(result.complete, true);
  assert.equal(result.missingReceiptCount, 1);
  assert.equal(result.processingVerified, false);
  assert.equal(result.strictValidated, false);
  assert.equal(result.diagnosticOnly, true);

  assert.throws(
    () => verifyAecTapEvidence(dir, terminal, { strict: true }),
    /missing aecProcessing receipt in strict mode/
  );
});

test('verifyAecTapEvidence strict mode rejects anonymous computational padding (mathPadding > 0 without tailAdmission)', (t) => {
  const preFrames = 240;
  const { dir, terminal } = createTapEvidenceFixture(t, {
    preFrames,
    tailAdmission: null, // Anonymous computational padding
  });

  assert.throws(
    () => verifyAecTapEvidence(dir, terminal, { strict: true }),
    /strict mode rejects mathPaddingFrames > 0 without an authorized tailAdmission/
  );
});

test('verifyAecTapEvidence strict mode rejects resume without reset after partial computational frame', (t) => {
  // Partial frame (240 frames -> padding 240, requires reset before resume)
  const preFrames = 240;
  const { dir, terminal } = createTapEvidenceFixture(t, {
    preFrames,
    subsequentCapture: true,
    subsequentPreFrames: 960,
    subsequentReset: false, // RESUME WITHOUT RESET!
  });

  assert.throws(
    () => verifyAecTapEvidence(dir, terminal, { strict: true }),
    /capture resumed after partial computational frame without an explicit reset event/
  );
});

test('verifyAecTapEvidence strict mode accepts resume WITH reset after partial computational frame', (t) => {
  const preFrames = 240;
  const { dir, terminal } = createTapEvidenceFixture(t, {
    preFrames,
    subsequentCapture: true,
    subsequentPreFrames: 960,
    subsequentReset: true, // EXPLICIT RESET BEFORE RESUME
  });

  const res = verifyAecTapEvidence(dir, terminal, { strict: true });
  assert.equal(res.complete, true);
  assert.equal(res.hasPartialFrames, true);
  assert.equal(res.processingVerified, true);
  assert.equal(res.strictValidated, true);
  assert.equal(res.diagnosticOnly, true);
});

test('verifyAecTapEvidence rejects fake padding frames', (t) => {
  const { dir, terminal } = createTapEvidenceFixture(t, {
    aecProcessing: {
      schemaVersion: 1,
      inputFrames: 960,
      native10msFrames: 2,
      mathPaddingFrames: 10, // FAKE padding! Should be 0
      allInputProcessed: true,
      resetBeforeResumeRequired: true,
      tailAdmission: null,
    },
  });

  assert.throws(
    () => verifyAecTapEvidence(dir, terminal, { strict: true }),
    /mathPaddingFrames mismatch/
  );
});

test('verifyAecTapEvidence rejects malformed tailAdmission and query gap', (t) => {
  const preFrames = 480;
  const { dir, terminal } = createTapEvidenceFixture(t, {
    preFrames,
    tailAdmission: {
      schemaVersion: 1,
      queueGeneration: 1,
      captureOwnerId: 10,
      captureResetGeneration: 1,
      byteLen: preFrames * 8,
      lastEmptyQueryId: 5,
      emptyPolls: 10,
      quietObservationSpanMs: 2100.0,
      maximumEmptyPollGapMs: 150.0, // GAP > 100ms!
      lastNonemptyAgeAtLastQueryMs: 2200.0,
      allZero: true,
      zeroSamples: preFrames * 2,
      nonzeroSamples: 0,
      realFrames: preFrames,
    },
  });

  assert.throws(
    () => verifyAecTapEvidence(dir, terminal, { strict: true }),
    /maximumEmptyPollGapMs must be in \(0, 100\] ms/
  );
});

test('verifyAecTapEvidence rejects tail when actual disk PCM has non-zero samples but receipt claims allZero', (t) => {
  const preFrames = 480;
  const { dir, terminal } = createTapEvidenceFixture(t, {
    preFrames,
    nonZeroPre: true, // disk has non-zero samples
    tailAdmission: {
      schemaVersion: 1,
      queueGeneration: 1,
      captureOwnerId: 10,
      captureResetGeneration: 1,
      byteLen: preFrames * 8,
      lastEmptyQueryId: 5,
      emptyPolls: 30,
      quietObservationSpanMs: 2100.0,
      maximumEmptyPollGapMs: 80.0,
      lastNonemptyAgeAtLastQueryMs: 2200.0,
      allZero: true, // RECEIPT CLAIMS ALL ZERO!
      zeroSamples: preFrames * 2,
      nonzeroSamples: 0,
      realFrames: preFrames,
    },
  });

  assert.throws(
    () => verifyAecTapEvidence(dir, terminal, { strict: true }),
    /tail zeroSamples mismatch with actual disk PCM/
  );
});
